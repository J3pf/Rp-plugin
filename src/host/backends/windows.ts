// Windows backends: Windows Terminal (`wt.exe`) and plain console (`cmd /c start`).
// Neither passes environment variables, so the id travels as the `--rp-spawn-id` flag registered by the plugin.
import { HostError, splitCommand } from "../validate.ts";
import type { Backend, BackendDeps, SpawnRecord, SpawnRequest } from "./types.ts";

export function wtArgs(req: SpawnRequest): string[] {
  if (req.cwd.includes(";")) throw new HostError("bad_request", "cwd with ';' is not supported by Windows Terminal");
  return ["-w", "rp", "new-tab", "-d", req.cwd, "--title", req.name, ...splitCommand(req.launcherCommand), "--rp-spawn-id", req.spawnId];
}

export function consoleArgs(req: SpawnRequest): string[] {
  return ["/c", "start", req.name, "/D", req.cwd, ...splitCommand(req.launcherCommand), "--rp-spawn-id", req.spawnId];
}

/** PowerShell that stops the processes whose command line carries the spawn id (ids are alphanumeric → injection-safe). */
export function killScript(spawnId: string): string {
  return `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--rp-spawn-id ${spawnId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
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
  constructor(private d: BackendDeps) {}
  async detect(): Promise<boolean | null> {
    return this.d.platform === "win32" ? true : null;
  }
  async spawn(req: SpawnRequest): Promise<SpawnRecord> {
    const r = await this.d.run("cmd.exe", consoleArgs(req), { cwd: req.cwd });
    if (r.code !== 0) throw new HostError("internal", `cmd start failed: ${r.stderr.trim()}`);
    return { spawnId: req.spawnId, backend: "console", herdr: null, tmuxSession: null, createdAt: Date.now(), name: req.name };
  }
  async kill(rec: SpawnRecord): Promise<void> {
    await killByFlag(this.d, rec.spawnId);
  }
}
