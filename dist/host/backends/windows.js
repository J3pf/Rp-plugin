// Windows backends: Windows Terminal (`wt.exe`) and plain console (`cmd /c start`).
// Neither passes environment variables, so the id travels as the `--rp-spawn-id` flag registered by the plugin.
import { HostError, splitCommand, validateSessionId, validateSpawnId } from "../validate.js";
const CMD_META_RE = /[&|<>^%\r\n\0"!]/;
export function wtArgs(req) {
    const spawnId = validateSpawnId(req.spawnId);
    if (req.sessionId !== undefined)
        validateSessionId(req.sessionId);
    if (req.cwd.includes(";") || /[\r\n\0]/.test(req.cwd)) {
        throw new HostError("bad_request", "cwd with ';' or control chars is not supported by Windows Terminal");
    }
    const cleanName = req.name.replace(/[\r\n\0;]/g, " ");
    return ["-w", "rp", "new-tab", "-d", req.cwd, "--title", cleanName, ...splitCommand(req.launcherCommand), "--rp-spawn-id", spawnId];
}
export function consoleArgs(req) {
    const spawnId = validateSpawnId(req.spawnId);
    if (req.sessionId !== undefined)
        validateSessionId(req.sessionId);
    const parts = splitCommand(req.launcherCommand);
    if (CMD_META_RE.test(req.cwd) || parts.some((p) => CMD_META_RE.test(p))) {
        throw new HostError("bad_request", "unsafe characters for Windows console backend");
    }
    const title = `"${req.name.replace(/["&|<>^%\r\n\0!]/g, "")}"`;
    return ["/c", "start", title, "/D", req.cwd, ...parts, "--rp-spawn-id", spawnId];
}
/** PowerShell that stops the processes whose command line carries the spawn id (ids are validated alphanumeric → injection-safe). */
export function killScript(spawnId) {
    const safeId = validateSpawnId(spawnId);
    return `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*--rp-spawn-id ${safeId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
}
async function killByFlag(d, spawnId) {
    await d.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", killScript(spawnId)]);
}
export class WindowsTerminalBackend {
    d;
    name = "wt";
    constructor(d) {
        this.d = d;
    }
    async detect() {
        if (this.d.platform !== "win32")
            return null;
        const r = await this.d.run("where", ["wt.exe"]);
        return r.code === 0 ? true : null;
    }
    async spawn(req) {
        const r = await this.d.run("wt.exe", wtArgs(req));
        if (r.code !== 0)
            throw new HostError("internal", `wt.exe failed: ${r.stderr.trim()}`);
        return { spawnId: req.spawnId, backend: "wt", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
    }
    async kill(rec) {
        await killByFlag(this.d, rec.spawnId);
    }
}
export class ConsoleBackend {
    d;
    name = "console";
    constructor(d) {
        this.d = d;
    }
    async detect() {
        return this.d.platform === "win32" ? true : null;
    }
    async spawn(req) {
        const r = await this.d.run("cmd.exe", consoleArgs(req), { cwd: req.cwd });
        if (r.code !== 0)
            throw new HostError("internal", `cmd start failed: ${r.stderr.trim()}`);
        return { spawnId: req.spawnId, backend: "console", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
    }
    async kill(rec) {
        await killByFlag(this.d, rec.spawnId);
    }
}
