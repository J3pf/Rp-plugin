// herdr backend (COMPATIBILIDAD H4): workspace / tab / split → `herdr pane run <pane> <launcher>`. Never steals focus.
import { HostError } from "../validate.ts";
import type { Backend, BackendDeps, SpawnRecord, SpawnRequest } from "./types.ts";

/** First string found at any of the dotted paths. */
export function pick(obj: any, paths: string[]): string | null {
  for (const p of paths) {
    let cur = obj;
    for (const k of p.split(".")) cur = cur?.[k];
    if (typeof cur === "string" && cur) return cur;
    if (typeof cur === "number") return String(cur);
  }
  return null;
}

export function parseJson(text: string): any {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const PANE_PATHS = ["result.root_pane.pane_id", "result.pane.pane_id", "result.pane_id", "result.new_pane.pane_id", "result.root_pane.id", "result.pane.id", "pane_id"];
export const WORKSPACE_PATHS = ["result.workspace.workspace_id", "result.workspace_id", "result.workspace.id", "workspace_id"];
export const TAB_PATHS = ["result.tab.tab_id", "result.tab_id", "result.tab.id", "tab_id"];

export class HerdrBackend implements Backend {
  readonly name = "herdr" as const;
  private serverStarted = false;
  private serverStarting: Promise<void> | null = null;
  constructor(private d: BackendDeps) {}

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...(this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {}), ...extra };
  }

  private herdr(args: string[]) {
    return this.d.run("herdr", args, { env: this.env() });
  }

  async detect(): Promise<string | null> {
    const r = await this.herdr(["--version"]);
    if (r.code !== 0) return null;
    return /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? (r.stdout.trim() || "unknown");
  }

  /** If the herdr server is not running, start it headless so panes can be created (PLAN §10). */
  async ensureServer(): Promise<void> {
    const st = await this.herdr(["status", "server"]);
    if (st.code === 0) return;
    if (this.serverStarting) return this.serverStarting;
    if (this.serverStarted) throw new HostError("internal", "herdr server is not running");
    const p = (async () => {
      // supervised background process: detached so it outlives a single request
      const { spawn } = await import("node:child_process");
      const child = spawn("herdr", ["server"], { stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, ...this.env() } });
      child.on("error", () => {
        this.serverStarted = false;
      });
      child.on("exit", () => {
        this.serverStarted = false;
      });
      child.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if ((await this.herdr(["status", "server"])).code === 0) {
          this.serverStarted = true;
          return;
        }
      }
      this.serverStarted = false;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      throw new HostError("internal", "herdr server did not start");
    })();
    this.serverStarting = p;
    try {
      await p;
    } finally {
      this.serverStarting = null;
    }
  }

  async spawn(req: SpawnRequest): Promise<SpawnRecord> {
    await this.ensureServer();
    const target = req.herdrTarget ?? { type: "workspace" as const };
    const envArg = `RP_SPAWN_ID=${req.spawnId}`;
    let args: string[];
    if (target.type === "workspace") {
      args = ["workspace", "create", "--cwd", req.cwd, "--label", req.name, "--env", envArg, "--no-focus"];
    } else if (target.type === "tab") {
      args = ["tab", "create", "--workspace", target.workspaceId, "--cwd", req.cwd, "--label", req.name, "--env", envArg, "--no-focus"];
    } else {
      if (target.direction !== "right" && target.direction !== "down") throw new HostError("bad_request", "invalid split direction");
      args = ["pane", "split", target.paneId, "--direction", target.direction, "--cwd", req.cwd, "--env", envArg, "--no-focus"];
    }
    const r = await this.herdr(args);
    if (r.code !== 0) throw new HostError("internal", `herdr ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    const json = parseJson(r.stdout);
    const paneId = pick(json, PANE_PATHS);
    if (!paneId) throw new HostError("internal", "herdr did not return a pane id");
    const workspaceId = pick(json, WORKSPACE_PATHS) ?? (target.type === "tab" ? target.workspaceId : null);
    const tabId = pick(json, TAB_PATHS);
    const ownsWorkspace = target.type === "workspace" && !!workspaceId;
    const cleanupArgs = ownsWorkspace ? ["workspace", "close", workspaceId!] : ["pane", "close", paneId];
    let run: Awaited<ReturnType<typeof this.herdr>>;
    try {
      run = await this.herdr(["pane", "run", paneId, req.launcherCommand]);
    } catch (e) {
      await this.herdr(cleanupArgs).catch(() => {});
      throw e;
    }
    if (run.code !== 0) {
      await this.herdr(cleanupArgs).catch(() => {});
      throw new HostError("internal", `herdr pane run failed: ${run.stderr.trim() || run.stdout.trim()}`);
    }
    return {
      spawnId: req.spawnId,
      backend: "herdr",
      herdr: { workspaceId, tabId, paneId, ownsWorkspace },
      tmuxSession: null,
      createdAt: Date.now(),
      name: req.name,
    };
  }

  async kill(rec: SpawnRecord): Promise<void> {
    if (!rec.herdr) return;
    // a workspace created for one agent is closed whole; tabs/splits close just their pane
    const ownsWorkspace = (rec.herdr.ownsWorkspace ?? (!!rec.herdr.workspaceId && !rec.herdr.tabId)) && !!rec.herdr.workspaceId;
    const args = ownsWorkspace ? ["workspace", "close", rec.herdr.workspaceId!] : ["pane", "close", rec.herdr.paneId];
    const r = await this.herdr(args);
    if (r.code !== 0) throw new HostError("internal", `herdr ${args[0]} close failed: ${(r.stderr || r.stdout).trim()}`);
  }

  /** workspace list + tab list for the app's "where to create the agent" picker. */
  async layout(): Promise<{ workspaces: Array<{ id: string; label: string; cwd: string | null; tabs: Array<{ id: string; label: string; panes: Array<{ id: string; agent?: string }> }> }> }> {
    const ws = parseJson((await this.herdr(["workspace", "list"])).stdout);
    const tabs = parseJson((await this.herdr(["tab", "list"])).stdout);
    const wsList: any[] = firstArray(ws, ["result.workspaces", "workspaces", "result"]);
    const tabList: any[] = firstArray(tabs, ["result.tabs", "tabs", "result"]);
    return {
      workspaces: wsList.map((w) => {
        const id = pick(w, ["workspace_id", "id"]) ?? "";
        return {
          id,
          label: pick(w, ["label", "name"]) ?? id,
          cwd: pick(w, ["cwd", "root_cwd"]),
          tabs: tabList
            .filter((t) => (pick(t, ["workspace_id", "workspace"]) ?? "") === id)
            .map((t) => {
              const tid = pick(t, ["tab_id", "id"]) ?? "";
              const panes: any[] = Array.isArray(t?.panes) ? t.panes : [];
              return {
                id: tid,
                label: pick(t, ["label", "name"]) ?? tid,
                panes: panes.map((p) => ({ id: pick(p, ["pane_id", "id"]) ?? "", ...(pick(p, ["agent", "agent_name"]) ? { agent: pick(p, ["agent", "agent_name"])! } : {}) })),
              };
            }),
        };
      }),
    };
  }
}

function firstArray(obj: any, paths: string[]): any[] {
  for (const p of paths) {
    let cur = obj;
    for (const k of p.split(".")) cur = cur?.[k];
    if (Array.isArray(cur)) return cur;
  }
  return [];
}
