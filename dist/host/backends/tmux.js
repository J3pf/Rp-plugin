// tmux backend (Linux/macOS, tmux ≥ 3.2 for `new-session -e`).
import { HostError, splitCommand } from "../validate.js";
export function parseTmuxVersion(out) {
    const m = /tmux\s+(?:next-)?(\d+(?:\.\d+)?[a-z]?)/i.exec(out);
    return m ? m[1] : null;
}
export function tmuxSupportsEnv(version) {
    if (!version)
        return false;
    const m = /^(\d+)(?:\.(\d+))?/.exec(version);
    if (!m)
        return false;
    const major = Number(m[1]);
    const minor = Number(m[2] ?? 0);
    return major > 3 || (major === 3 && minor >= 2);
}
export function tmuxSessionName(spawnId) {
    return `rp-${spawnId.slice(-8).toLowerCase()}`;
}
export class TmuxBackend {
    d;
    name = "tmux";
    constructor(d) {
        this.d = d;
    }
    async detect() {
        if (this.d.platform === "win32")
            return null;
        const r = await this.d.run("tmux", ["-V"]);
        if (r.code !== 0)
            return null;
        const v = parseTmuxVersion(r.stdout);
        return tmuxSupportsEnv(v) ? v : null;
    }
    async spawn(req) {
        const session = tmuxSessionName(req.spawnId);
        // tmux runs the command string through the user's shell: the launcher comes from host.json (trusted), never from the phone
        const cmd = splitCommand(req.launcherCommand).length ? req.launcherCommand : "pi";
        const r = await this.d.run("tmux", ["new-session", "-d", "-s", session, "-c", req.cwd, "-e", `RP_SPAWN_ID=${req.spawnId}`, cmd]);
        if (r.code !== 0)
            throw new HostError("internal", `tmux failed: ${r.stderr.trim()}`);
        return { spawnId: req.spawnId, backend: "tmux", herdr: null, tmuxSession: session, createdAt: Date.now(), name: req.name };
    }
    async kill(rec) {
        if (!rec.tmuxSession)
            return;
        await this.d.run("tmux", ["kill-session", "-t", rec.tmuxSession]);
    }
}
