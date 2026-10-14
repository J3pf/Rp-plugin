// Spawns and tracks agents created from the phone; picks the backend (herdr > tmux/wt > console).
import fs from "node:fs";
import path from "node:path";
import { newId } from "../shared/protocol.ts";
import { configDir } from "../shared/platform.ts";
import type { BackendName, HostConfig } from "./config.ts";
import type { Backend, HerdrTarget, SpawnRecord } from "./backends/types.ts";
import { HerdrBackend } from "./backends/herdr.ts";
import { TmuxBackend } from "./backends/tmux.ts";
import { ConsoleBackend, WindowsTerminalBackend } from "./backends/windows.ts";
import { run as realRun, type Runner } from "./runner.ts";
import { HostError, resolveLauncher, resolveWithinRoots, sanitizeLabel, validateSessionId, validateSpawnId } from "./validate.ts";

export interface BackendReport {
  herdr: string | null;
  tmux: string | null;
  wt: boolean;
  console: boolean;
}

export interface SpawnParams {
  cwd: string;
  name?: string;
  launcher?: string;
  backend?: BackendName;
  herdrTarget?: HerdrTarget;
  sessionId?: string;
}

export class HostManager {
  private backends: Record<BackendName, Backend>;
  private records = new Map<string, SpawnRecord>();
  private report: BackendReport | null = null;
  private storeFile: string;

  constructor(
    private cfg: HostConfig,
    opts: { run?: Runner; platform?: NodeJS.Platform; storeFile?: string } = {},
  ) {
    const run = opts.run ?? realRun;
    const platform = opts.platform ?? process.platform;
    const deps = { run, platform, herdrSession: cfg.herdrSession };
    this.platform = platform;
    this.backends = {
      herdr: new HerdrBackend(deps),
      tmux: new TmuxBackend(deps),
      wt: new WindowsTerminalBackend(deps),
      console: new ConsoleBackend(deps),
    };
    this.storeFile = opts.storeFile ?? path.join(configDir(), "host-spawns.json");
    this.load();
  }
  private platform: NodeJS.Platform;

  private trimRecords(): void {
    while (this.records.size > 200) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
  private load(): void {
    try {
      const arr: SpawnRecord[] = JSON.parse(fs.readFileSync(this.storeFile, "utf8"));
      for (const r of arr) if (r?.spawnId) this.records.set(r.spawnId, r);
      this.trimRecords();
    } catch {
      /* first run */
    }
  }
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      fs.writeFileSync(this.storeFile, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  async detect(force = false): Promise<BackendReport> {
    if (this.report && !force) return this.report;
    const [herdr, tmux, wt, con] = await Promise.all([
      this.backends.herdr.detect(),
      this.backends.tmux.detect(),
      this.backends.wt.detect(),
      this.backends.console.detect(),
    ]);
    this.report = { herdr: herdr ? String(herdr) : null, tmux: tmux ? String(tmux) : null, wt: !!wt, console: !!con };
    return this.report;
  }

  /** `auto`: herdr if present; else tmux on Linux/macOS, Windows Terminal then console on Windows. */
  async resolveBackend(requested?: BackendName): Promise<BackendName> {
    const rep = await this.detect();
    const avail = (b: BackendName) => (b === "herdr" ? !!rep.herdr : b === "tmux" ? !!rep.tmux : b === "wt" ? rep.wt : rep.console);
    const want = requested ?? (this.cfg.backend === "auto" ? undefined : this.cfg.backend);
    if (want) {
      if (!avail(want)) throw new HostError("bad_request", `backend "${want}" is not available on this machine`);
      return want;
    }
    const order: BackendName[] = this.platform === "win32" ? ["herdr", "wt", "console"] : ["herdr", "tmux"];
    const found = order.find(avail);
    if (!found) throw new HostError("internal", "no backend available (install herdr or tmux ≥ 3.2)");
    return found;
  }

  async defaultBackend(): Promise<BackendName | null> {
    try {
      return await this.resolveBackend();
    } catch {
      return null;
    }
  }

  async spawn(p: SpawnParams): Promise<SpawnRecord> {
    const cwd = resolveWithinRoots(this.cfg, p.cwd);
    const launcher = resolveLauncher(this.cfg, p.launcher);
    const name = sanitizeLabel(p.name, path.basename(cwd) || "agent");
    const backendName = await this.resolveBackend(p.backend);
    if (p.herdrTarget && backendName !== "herdr") throw new HostError("bad_request", "herdrTarget requires the herdr backend");
    const spawnId = newId();
    const sessionId = p.sessionId ? validateSessionId(p.sessionId) : undefined;
    const launcherCommand = sessionId ? `${launcher.command} --session ${sessionId}` : launcher.command;
    const rec = await this.backends[backendName].spawn({ cwd, name, launcherCommand, spawnId, herdrTarget: p.herdrTarget, sessionId });
    this.records.set(spawnId, rec);
    this.trimRecords();
    this.save();
    return rec;
  }

  async kill(spawnId: unknown): Promise<void> {
    const id = validateSpawnId(spawnId);
    const rec = this.records.get(id);
    if (!rec) throw new HostError("not_found", "unknown spawnId (only agents created by rp-host can be killed)");
    await this.backends[rec.backend].kill(rec);
    this.records.delete(id);
    this.save();
  }

  async herdrLayout() {
    const rep = await this.detect();
    if (!rep.herdr) throw new HostError("bad_request", "herdr is not available");
    await (this.backends.herdr as HerdrBackend).ensureServer();
    return (this.backends.herdr as HerdrBackend).layout();
  }

  list(): SpawnRecord[] {
    return [...this.records.values()];
  }
}
