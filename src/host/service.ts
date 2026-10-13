// Service installation: systemd --user (Linux), Task Scheduler ONLOGON (Windows, no admin), launchd (macOS).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as realRun, type Runner } from "./runner.ts";

export interface ServiceSpec {
  nodePath: string;
  scriptPath: string;
  platform: NodeJS.Platform;
  home?: string;
}

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=RP host (create Pi agents from the phone)
After=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(spec.nodePath)} ${quoteSystemd(spec.scriptPath)} run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function quoteSystemd(s: string): string {
  return /[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s;
}

export function systemdUnitPath(home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", "rp-host.service");
}

export function schtasksCreateArgs(spec: ServiceSpec): string[] {
  const tr = `"${spec.nodePath}" "${spec.scriptPath}" run`;
  return ["/Create", "/SC", "ONLOGON", "/TN", "rp-host", "/TR", tr, "/F"];
}

export const LAUNCHD_LABEL = "dev.j3pf.rp-host";

export function launchdPlist(spec: ServiceSpec): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(spec.nodePath)}</string><string>${esc(spec.scriptPath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function launchdPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export async function installService(spec: ServiceSpec, run: Runner = realRun): Promise<string> {
  const home = spec.home ?? os.homedir();
  if (spec.platform === "linux") {
    const f = systemdUnitPath(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, systemdUnit(spec));
    await run("systemctl", ["--user", "daemon-reload"]);
    const r = await run("systemctl", ["--user", "enable", "--now", "rp-host"]);
    if (r.code !== 0) throw new Error(`systemctl enable failed: ${r.stderr.trim()}`);
    return `systemd user service installed (${f})`;
  }
  if (spec.platform === "win32") {
    const r = await run("schtasks", schtasksCreateArgs(spec));
    if (r.code !== 0) throw new Error(`schtasks failed: ${r.stderr.trim() || r.stdout.trim()}`);
    await run("schtasks", ["/Run", "/TN", "rp-host"]);
    return "scheduled task rp-host created (runs at logon)";
  }
  if (spec.platform === "darwin") {
    const f = launchdPath(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, launchdPlist(spec));
    const r = await run("launchctl", ["load", "-w", f]);
    if (r.code !== 0) throw new Error(`launchctl failed: ${r.stderr.trim()}`);
    return `launchd agent installed (${f})`;
  }
  throw new Error(`unsupported platform ${spec.platform}`);
}

export async function uninstallService(platform: NodeJS.Platform, run: Runner = realRun, home = os.homedir()): Promise<string> {
  if (platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", "rp-host"]);
    fs.rmSync(systemdUnitPath(home), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
    return "systemd user service removed";
  }
  if (platform === "win32") {
    await run("schtasks", ["/End", "/TN", "rp-host"]);
    await run("schtasks", ["/Delete", "/TN", "rp-host", "/F"]);
    return "scheduled task rp-host removed";
  }
  if (platform === "darwin") {
    const f = launchdPath(home);
    await run("launchctl", ["unload", "-w", f]);
    fs.rmSync(f, { force: true });
    return "launchd agent removed";
  }
  throw new Error(`unsupported platform ${platform}`);
}
