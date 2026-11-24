// herdr backend (COMPATIBILIDAD H4): workspace / tab / split → `herdr pane run <pane> <launcher>`. Never steals focus.
import { spawn as nodeSpawn } from "node:child_process";
import { HostError } from "../validate.js";
/** First string found at any of the dotted paths. */
export function pick(obj, paths) {
    for (const p of paths) {
        let cur = obj;
        for (const k of p.split("."))
            cur = cur?.[k];
        if (typeof cur === "string" && cur)
            return cur;
        if (typeof cur === "number")
            return String(cur);
    }
    return null;
}
export function parseJson(text) {
    const t = text.trim();
    if (!t)
        return null;
    try {
        return JSON.parse(t);
    }
    catch {
        const i = t.indexOf("{");
        const j = t.lastIndexOf("}");
        if (i >= 0 && j > i) {
            try {
                return JSON.parse(t.slice(i, j + 1));
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
export const PANE_PATHS = ["result.root_pane.pane_id", "result.pane.pane_id", "result.pane_id", "result.new_pane.pane_id", "result.root_pane.id", "result.pane.id", "pane_id"];
export const WORKSPACE_PATHS = ["result.workspace.workspace_id", "result.workspace_id", "result.workspace.id", "workspace_id"];
export const TAB_PATHS = ["result.tab.tab_id", "result.tab_id", "result.tab.id", "tab_id"];
const HERDR_SERVER_COOLDOWN_MS = 10_000;
export class HerdrBackend {
    d;
    opts;
    name = "herdr";
    lastServerStartAt = 0;
    serverStarting = null;
    constructor(d, opts = {}) {
        this.d = d;
        this.opts = opts;
    }
    env(extra = {}) {
        return { ...(this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {}), ...extra };
    }
    herdr(args) {
        return this.d.run("herdr", args, { env: this.env() });
    }
    async detect() {
        const r = await this.herdr(["--version"]);
        if (r.code !== 0)
            return null;
        return /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? (r.stdout.trim() || "unknown");
    }
    /** If the herdr server is not running, start it headless so panes can be created (PLAN §10). */
    async ensureServer() {
        const st = await this.herdr(["status", "server"]);
        if (st.code === 0) {
            this.lastServerStartAt = 0;
            return;
        }
        if (this.serverStarting)
            return this.serverStarting;
        const cooldownMs = this.opts.cooldownMs ?? HERDR_SERVER_COOLDOWN_MS;
        if (this.lastServerStartAt > 0 && Date.now() - this.lastServerStartAt < cooldownMs) {
            throw new HostError("internal", "herdr server is not running");
        }
        this.lastServerStartAt = Date.now();
        const p = (async () => {
            const spawnServer = this.opts.spawnServer ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
            const pollIntervalMs = this.opts.pollIntervalMs ?? 250;
            const pollAttempts = this.opts.pollAttempts ?? 20;
            const sigkillGraceMs = this.opts.sigkillGraceMs ?? 1_000;
            // supervised background process: detached so it outlives a single request
            const child = spawnServer("herdr", ["server"], {
                stdio: "ignore",
                detached: true,
                windowsHide: true,
                env: { ...process.env, ...this.env() },
            });
            let childDead = false;
            let wakeOnDead = null;
            let killTimer = null;
            const markDead = () => {
                childDead = true;
                if (killTimer) {
                    clearTimeout(killTimer);
                    killTimer = null;
                }
                wakeOnDead?.();
            };
            child.on("error", markDead);
            child.on("exit", markDead);
            child.unref();
            let checkedAfterDead = false;
            for (let i = 0; i < pollAttempts; i++) {
                if (childDead)
                    break;
                await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        wakeOnDead = null;
                        resolve();
                    }, pollIntervalMs);
                    wakeOnDead = () => {
                        clearTimeout(timer);
                        wakeOnDead = null;
                        resolve();
                    };
                });
                const wasDead = childDead;
                if ((await this.herdr(["status", "server"])).code === 0) {
                    this.lastServerStartAt = 0;
                    return;
                }
                if (wasDead || childDead) {
                    checkedAfterDead = wasDead;
                    break;
                }
            }
            if (childDead) {
                if (!checkedAfterDead && (await this.herdr(["status", "server"])).code === 0) {
                    this.lastServerStartAt = 0;
                    return;
                }
                throw new HostError("internal", "herdr server did not start");
            }
            try {
                child.kill("SIGTERM");
            }
            catch {
                /* ignore */
            }
            killTimer = setTimeout(() => {
                killTimer = null;
                if (!childDead) {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch {
                        /* ignore */
                    }
                }
            }, sigkillGraceMs);
            killTimer.unref?.();
            throw new HostError("internal", "herdr server did not start");
        })();
        this.serverStarting = p;
        try {
            await p;
        }
        finally {
            this.serverStarting = null;
        }
    }
    async spawn(req) {
        await this.ensureServer();
        const target = req.herdrTarget ?? { type: "workspace" };
        const envArg = `RP_SPAWN_ID=${req.spawnId}`;
        let args;
        if (target.type === "workspace") {
            args = ["workspace", "create", "--cwd", req.cwd, "--label", req.name, "--env", envArg, "--no-focus"];
        }
        else if (target.type === "tab") {
            args = ["tab", "create", "--workspace", target.workspaceId, "--cwd", req.cwd, "--label", req.name, "--env", envArg, "--no-focus"];
        }
        else {
            if (target.direction !== "right" && target.direction !== "down")
                throw new HostError("bad_request", "invalid split direction");
            args = ["pane", "split", target.paneId, "--direction", target.direction, "--cwd", req.cwd, "--env", envArg, "--no-focus"];
        }
        const r = await this.herdr(args);
        if (r.code !== 0)
            throw new HostError("internal", `herdr ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
        const json = parseJson(r.stdout);
        const paneId = pick(json, PANE_PATHS);
        if (!paneId)
            throw new HostError("internal", "herdr did not return a pane id");
        const workspaceId = pick(json, WORKSPACE_PATHS) ?? (target.type === "tab" ? target.workspaceId : null);
        const tabId = pick(json, TAB_PATHS);
        const ownsWorkspace = target.type === "workspace" && !!workspaceId;
        const cleanupArgs = ownsWorkspace ? ["workspace", "close", workspaceId] : ["pane", "close", paneId];
        let run;
        try {
            run = await this.herdr(["pane", "run", paneId, req.launcherCommand]);
        }
        catch (e) {
            await this.herdr(cleanupArgs).catch(() => { });
            throw e;
        }
        if (run.code !== 0) {
            await this.herdr(cleanupArgs).catch(() => { });
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
    async kill(rec) {
        if (!rec.herdr)
            return;
        // a workspace created for one agent is closed whole; tabs/splits close just their pane
        const ownsWorkspace = (rec.herdr.ownsWorkspace ?? (!!rec.herdr.workspaceId && !rec.herdr.tabId)) && !!rec.herdr.workspaceId;
        const args = ownsWorkspace ? ["workspace", "close", rec.herdr.workspaceId] : ["pane", "close", rec.herdr.paneId];
        const r = await this.herdr(args);
        if (r.code !== 0)
            throw new HostError("internal", `herdr ${args[0]} close failed: ${(r.stderr || r.stdout).trim()}`);
    }
    async closePane(paneId) {
        try {
            const r = await this.herdr(["pane", "close", paneId]);
            const json = parseJson(r.stderr) ?? parseJson(r.stdout);
            const hasError = json?.error !== null && typeof json?.error === "object";
            if (r.code === 0 && !hasError)
                return { ok: true, error: null };
            const error = (pick(json, ["error.code"]) ??
                pick(json, ["error.message"]) ??
                (json === null ? r.stderr.trim() || r.stdout.trim() : "")) || "herdr_close_failed";
            return { ok: false, error };
        }
        catch {
            return { ok: false, error: "herdr_close_failed" };
        }
    }
    /** workspace list + tab list for the app's "where to create the agent" picker. */
    async layout() {
        const [wsRes, tabsRes] = await Promise.all([this.herdr(["workspace", "list"]), this.herdr(["tab", "list"])]);
        const ws = parseJson(wsRes.stdout);
        const tabs = parseJson(tabsRes.stdout);
        const wsList = firstArray(ws, ["result.workspaces", "workspaces", "result"]);
        const tabList = firstArray(tabs, ["result.tabs", "tabs", "result"]);
        const tabsByWs = new Map();
        for (const t of tabList) {
            const wid = pick(t, ["workspace_id", "workspace"]) ?? "";
            let group = tabsByWs.get(wid);
            if (!group) {
                group = [];
                tabsByWs.set(wid, group);
            }
            group.push(t);
        }
        return {
            workspaces: wsList.map((w) => {
                const id = pick(w, ["workspace_id", "id"]) ?? "";
                const wTabs = tabsByWs.get(id) ?? [];
                return {
                    id,
                    label: pick(w, ["label", "name"]) ?? id,
                    cwd: pick(w, ["cwd", "root_cwd"]),
                    tabs: wTabs.map((t) => {
                        const tid = pick(t, ["tab_id", "id"]) ?? "";
                        const panes = Array.isArray(t?.panes) ? t.panes : [];
                        return {
                            id: tid,
                            label: pick(t, ["label", "name"]) ?? tid,
                            panes: panes.map((p) => {
                                const agent = pick(p, ["agent", "agent_name"]);
                                return { id: pick(p, ["pane_id", "id"]) ?? "", ...(agent ? { agent } : {}) };
                            }),
                        };
                    }),
                };
            }),
        };
    }
}
function firstArray(obj, paths) {
    for (const p of paths) {
        let cur = obj;
        for (const k of p.split("."))
            cur = cur?.[k];
        if (Array.isArray(cur))
            return cur;
    }
    return [];
}
