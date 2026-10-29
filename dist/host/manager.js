// Spawns and tracks agents created from the phone; picks the backend (herdr > tmux/wt > console).
import fs from "node:fs";
import path from "node:path";
import { newId } from "../shared/protocol.js";
import { configDir } from "../shared/platform.js";
import { HerdrBackend } from "./backends/herdr.js";
import { TmuxBackend } from "./backends/tmux.js";
import { ConsoleBackend, WindowsTerminalBackend } from "./backends/windows.js";
import { run as realRun } from "./runner.js";
import { HostError, resolveLauncher, resolveWithinRoots, sanitizeLabel, validatePaneId, validateSessionId, validateSpawnId } from "./validate.js";
import { QuotaCollector } from "./quota.js";
export class HostManager {
    cfg;
    backends;
    records = new Map();
    report = null;
    storeFile;
    quotaCollector;
    constructor(cfg, opts = {}) {
        this.cfg = cfg;
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
        this.quotaCollector = opts.quotaCollector ?? new QuotaCollector({
            runner: run,
            command: cfg.quotaCommand,
            onLog: opts.onLog,
        });
        this.load();
    }
    platform;
    trimRecords() {
        while (this.records.size > 200) {
            const oldest = this.records.keys().next().value;
            if (oldest === undefined)
                break;
            this.records.delete(oldest);
        }
    }
    load() {
        try {
            const arr = JSON.parse(fs.readFileSync(this.storeFile, "utf8"));
            if (!Array.isArray(arr))
                return;
            for (const r of arr) {
                if (!r || typeof r !== "object" || !r.spawnId)
                    continue;
                try {
                    const validId = validateSpawnId(r.spawnId);
                    this.records.set(validId, { ...r, spawnId: validId });
                }
                catch {
                    /* skip invalid persisted record */
                }
            }
            this.trimRecords();
        }
        catch {
            /* first run */
        }
    }
    save() {
        try {
            const dir = path.dirname(this.storeFile);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmpFile = `${this.storeFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
            fs.renameSync(tmpFile, this.storeFile);
        }
        catch {
            /* best effort */
        }
    }
    async detect(force = false) {
        if (this.report && !force)
            return this.report;
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
    async resolveBackend(requested) {
        const rep = await this.detect();
        const avail = (b) => (b === "herdr" ? !!rep.herdr : b === "tmux" ? !!rep.tmux : b === "wt" ? rep.wt : rep.console);
        const want = requested ?? (this.cfg.backend === "auto" ? undefined : this.cfg.backend);
        if (want) {
            if (!avail(want))
                throw new HostError("bad_request", `backend "${want}" is not available on this machine`);
            return want;
        }
        const order = this.platform === "win32" ? ["herdr", "wt", "console"] : ["herdr", "tmux"];
        const found = order.find(avail);
        if (!found)
            throw new HostError("internal", "no backend available (install herdr or tmux ≥ 3.2)");
        return found;
    }
    async defaultBackend() {
        try {
            return await this.resolveBackend();
        }
        catch {
            return null;
        }
    }
    async spawn(p) {
        const cwd = resolveWithinRoots(this.cfg, p.cwd);
        const launcher = resolveLauncher(this.cfg, p.launcher);
        const name = sanitizeLabel(p.name, path.basename(cwd) || "agent");
        const backendName = await this.resolveBackend(p.backend);
        if (p.herdrTarget && backendName !== "herdr")
            throw new HostError("bad_request", "herdrTarget requires the herdr backend");
        const spawnId = newId();
        const sessionId = p.sessionId ? validateSessionId(p.sessionId) : undefined;
        const launcherCommand = sessionId ? `${launcher.command} --session ${sessionId}` : launcher.command;
        const rec = await this.backends[backendName].spawn({ cwd, name, launcherCommand, spawnId, herdrTarget: p.herdrTarget, sessionId });
        this.records.set(spawnId, rec);
        this.trimRecords();
        this.save();
        return rec;
    }
    async kill(spawnId) {
        const id = validateSpawnId(spawnId);
        const rec = this.records.get(id);
        if (!rec)
            throw new HostError("not_found", "unknown spawnId (only agents created by rp-host can be killed)");
        await this.backends[rec.backend].kill(rec);
        this.records.delete(id);
        this.save();
    }
    async herdrLayout() {
        const rep = await this.detect();
        if (!rep.herdr)
            throw new HostError("bad_request", "herdr is not available");
        await this.backends.herdr.ensureServer();
        return this.backends.herdr.layout();
    }
    async herdrClose(paneId) {
        const id = validatePaneId(paneId);
        const rep = await this.detect();
        if (!rep.herdr)
            return { paneId: id, ok: false, error: "herdr_unavailable" };
        const result = await this.backends.herdr.closePane(id);
        return { paneId: id, ...result };
    }
    list() {
        return [...this.records.values()];
    }
    async collectQuotas() {
        if (!this.cfg.quotaEnabled)
            return null;
        return this.quotaCollector.collect();
    }
}
