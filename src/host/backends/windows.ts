// Windows backends: Windows Terminal (`wt.exe`) and direct detached console spawn.
// Neither passes environment variables, so the id travels as the `--rp-spawn-id` flag registered by the plugin for Pi launchers.
import { spawn } from "node:child_process";
import path from "node:path";
import { HostError, splitCommand, validateSessionId, validateSpawnId } from "../validate.ts";
import type { Backend, BackendDeps, SpawnRecord, SpawnRequest } from "./types.ts";

const CMD_META_RE = /[&|<>^%\r\n\0"!]/;

export interface ConsoleSpawnOptions {
  cwd: string;
  detached: true;
  stdio: "ignore";
  windowsHide: false;
}

export type ConsoleSpawner = (cmd: string, args: string[], opts: ConsoleSpawnOptions) => Promise<void> | void;

function defaultSpawnDetached(cmd: string, args: string[], opts: ConsoleSpawnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new HostError("internal", `console spawn failed: ${err.message}`));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function isExternalCliLauncher(parts: string[]): boolean {
  const bin = path.basename(parts[0] ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  return bin === "claude" || bin === "codex" || bin === "agy";
}

export function wtArgs(req: SpawnRequest): string[] {
  const spawnId = validateSpawnId(req.spawnId);
  if (req.sessionId !== undefined) validateSessionId(req.sessionId);
  if (req.cwd.includes(";") || /[\r\n\0]/.test(req.cwd)) {
    throw new HostError("bad_request", "cwd with ';' or control chars is not supported by Windows Terminal");
  }
  const cleanName = req.name.replace(/[\r\n\0;]/g, " ");
  const parts = splitCommand(req.launcherCommand);
  const spawnFlag = isExternalCliLauncher(parts) ? [] : ["--rp-spawn-id", spawnId];
  return ["-w", "rp", "new-tab", "-d", req.cwd, "--title", cleanName, ...parts, ...spawnFlag];
}

function consoleSpawnSpec(req: SpawnRequest): { cmd: string; args: string[] } {
  const spawnId = validateSpawnId(req.spawnId);
  if (req.sessionId !== undefined) validateSessionId(req.sessionId);
  const parts = splitCommand(req.launcherCommand);
  if (parts.length === 0) {
    throw new HostError("bad_request", "empty launcher command");
  }
  if (CMD_META_RE.test(req.cwd) || parts.some((p) => CMD_META_RE.test(p))) {
    throw new HostError("bad_request", "unsafe characters for Windows console backend");
  }
  const spawnFlag = isExternalCliLauncher(parts) ? [] : ["--rp-spawn-id", spawnId];
  return { cmd: parts[0]!, args: [...parts.slice(1), ...spawnFlag] };
}

/** Safe legacy `cmd.exe /c start` arg builder: uses constant empty title `""` and never interpolates `req.name`. */
export function consoleArgs(req: SpawnRequest): string[] {
  const { cmd, args } = consoleSpawnSpec(req);
  return ["/c", "start", "", "/D", req.cwd, cmd, ...args];
}

/** PowerShell that stops the processes whose command line carries the spawn id (ids are validated alphanumeric → injection-safe). */
export function killScript(spawnId: string): string {
  const safeId = validateSpawnId(spawnId);
  return `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*--rp-spawn-id ${safeId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
}

async function killByFlag(d: BackendDeps, spawnId: string): Promise<void> {
  await d.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", killScript(spawnId)]);
}

export class WindowsTerminalBackend implements Backend {
  readonly name = "wt" as const;
  constructor(private d: BackendDeps) {}
  async detect(): Promise<boolean | null> {
    if (this.d.platform !== "win32") return null;
    const r = await this.d.run("where", ["wt.exe"]);
    return r.code === 0 ? true : null;
  }
  async spawn(req: SpawnRequest): Promise<SpawnRecord> {
    const r = await this.d.run("wt.exe", wtArgs(req));
    if (r.code !== 0) throw new HostError("internal", `wt.exe failed: ${r.stderr.trim()}`);
    return { spawnId: req.spawnId, backend: "wt", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
  }
  async kill(rec: SpawnRecord): Promise<void> {
    await killByFlag(this.d, rec.spawnId);
  }
}

export class ConsoleBackend implements Backend {
  readonly name = "console" as const;
  private spawnDetached: ConsoleSpawner;
  constructor(private d: BackendDeps, spawnDetached: ConsoleSpawner = defaultSpawnDetached) {
    this.spawnDetached = spawnDetached;
  }
  async detect(): Promise<boolean | null> {
    return this.d.platform === "win32" ? true : null;
  }
  async spawn(req: SpawnRequest): Promise<SpawnRecord> {
    const { cmd, args } = consoleSpawnSpec(req);
    await this.spawnDetached(cmd, args, {
      cwd: req.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    return { spawnId: req.spawnId, backend: "console", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
  }
  async kill(rec: SpawnRecord): Promise<void> {
    await killByFlag(this.d, rec.spawnId);
  }
}
