// Windows backends: Windows Terminal (`wt.exe`) and direct detached console spawn.
// Neither passes environment variables, so the id travels as the `--rp-spawn-id` flag registered by the plugin for Pi launchers.
import { spawn } from "node:child_process";
import { HostError, isExternalCliLauncher, splitCommand, validateSessionId, validateSpawnId } from "../validate.js";
const CMD_META_RE = /[&|<>^%\r\n\0"!]/;
function defaultSpawnDetached(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, opts);
        let settled = false;
        child.once("error", (err) => {
            if (settled)
                return;
            settled = true;
            reject(new HostError("internal", `console spawn failed: ${err.message}`));
        });
        child.once("spawn", () => {
            if (settled)
                return;
            settled = true;
            child.unref();
            resolve();
        });
    });
}
export function wtArgs(req) {
    const spawnId = validateSpawnId(req.spawnId);
    if (req.sessionId !== undefined)
        validateSessionId(req.sessionId);
    if (req.cwd.includes(";") || /[\r\n\0]/.test(req.cwd)) {
        throw new HostError("bad_request", "cwd with ';' or control chars is not supported by Windows Terminal");
    }
    const cleanName = req.name.replace(/[\r\n\0;]/g, " ");
    const parts = splitCommand(req.launcherCommand);
    const spawnFlag = isExternalCliLauncher(parts) ? [] : ["--rp-spawn-id", spawnId];
    return ["-w", "rp", "new-tab", "-d", req.cwd, "--title", cleanName, ...parts, ...spawnFlag];
}
function consoleSpawnSpec(req) {
    const spawnId = validateSpawnId(req.spawnId);
    if (req.sessionId !== undefined)
        validateSessionId(req.sessionId);
    const parts = splitCommand(req.launcherCommand);
    if (parts.length === 0) {
        throw new HostError("bad_request", "empty launcher command");
    }
    if (CMD_META_RE.test(req.cwd) || parts.some((p) => CMD_META_RE.test(p))) {
        throw new HostError("bad_request", "unsafe characters for Windows console backend");
    }
    const spawnFlag = isExternalCliLauncher(parts) ? [] : ["--rp-spawn-id", spawnId];
    return { cmd: parts[0], args: [...parts.slice(1), ...spawnFlag] };
}
/** Safe legacy `cmd.exe /c start` arg builder: uses constant empty title `""` and never interpolates `req.name`. */
export function consoleArgs(req) {
    const { cmd, args } = consoleSpawnSpec(req);
    return ["/c", "start", "", "/D", req.cwd, cmd, ...args];
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
    spawnDetached;
    constructor(d, spawnDetached = defaultSpawnDetached) {
        this.d = d;
        this.spawnDetached = spawnDetached;
    }
    async detect() {
        return this.d.platform === "win32" ? true : null;
    }
    async spawn(req) {
        const { cmd, args } = consoleSpawnSpec(req);
        await this.spawnDetached(cmd, args, {
            cwd: req.cwd,
            detached: true,
            stdio: "ignore",
            windowsHide: false,
        });
        return { spawnId: req.spawnId, backend: "console", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
    }
    async kill(rec) {
        await killByFlag(this.d, rec.spawnId);
    }
}
