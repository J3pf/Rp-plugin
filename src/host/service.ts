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
  envPath?: string;
}

function isVersionedNodePath(nodePath: string): boolean {
  const normalized = nodePath.replace(/\\/g, "/");
  return normalized.includes("/Cellar/node/") ||
    /(?:^|\/)(?:versions\/)?node\/v?\d+\.\d+\.\d+(?:[-+][^/]*)?\/(?:bin\/)?node(?:\.exe)?$/i.test(normalized) ||
    /(?:^|\/)node-v\d+\.\d+\.\d+[^/]*\/(?:bin\/)?node(?:\.exe)?$/i.test(normalized);
}

export function resolveStableNodePath(env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, execPath?: string): string {
  const searchEnv = env ?? process.env;
  const searchPath = platform === "win32"
    ? searchEnv.PATH ?? searchEnv.Path ?? ""
    : searchEnv.PATH ?? "";
  const pathApi = platform === "win32" ? path.win32 : path;
  const nodeName = platform === "win32" ? "node.exe" : "node";
  const directories = searchPath.split(platform === "win32" ? ";" : path.delimiter);
  const candidates: string[] = [];
  let realExecPath: string | undefined;
  try {
    realExecPath = fs.realpathSync(execPath ?? process.execPath);
  } catch {
    // A missing exec path cannot match a PATH candidate; still try available nodes.
  }

  for (const dir of directories) {
    const candidate = pathApi.join(dir || ".", nodeName);
    if (!fs.existsSync(candidate)) continue;
    candidates.push(candidate);
    if (realExecPath) {
      try {
        if (fs.realpathSync(candidate) === realExecPath && !isVersionedNodePath(candidate)) return candidate;
      } catch {
        // Ignore broken symlinks and continue searching PATH.
      }
    }
  }

  return candidates.find((candidate) => !isVersionedNodePath(candidate)) ?? candidates[0] ?? execPath ?? process.execPath;
}

export function isStaleNodePath(installedNodePath: string): boolean {
  if (!fs.existsSync(installedNodePath) || installedNodePath.includes("/Cellar/node/")) return true;
  try {
    fs.realpathSync(installedNodePath);
    return false;
  } catch {
    return true;
  }
}

export function systemdUnit(spec: ServiceSpec): string {
  const envPath = spec.envPath ?? process.env.PATH ?? "";
  const pathEnvironment = envPath ? `Environment="PATH=${envPath.replace(/(["\\])/g, "\\$1")}"\n` : "";
  return `[Unit]
Description=RP host (create Pi agents from the phone)
StartLimitIntervalSec=0
After=network-online.target

[Service]
Type=simple
${pathEnvironment}ExecStart=${quoteSystemd(spec.nodePath)} ${quoteSystemd(spec.scriptPath)} run
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

export function schtasksXml(spec: ServiceSpec): string {
  const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RP host (create Pi agents from the phone)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(spec.nodePath)}</Command>
      <Arguments>${esc(`"${spec.scriptPath}" run`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function schtasksCreateXmlArgs(xmlPath: string): string[] {
  return ["/Create", "/XML", xmlPath, "/TN", "rp-host", "/F"];
}

export function schtasksCreateArgs(spec: ServiceSpec, xmlPath?: string): string[] {
  if (xmlPath !== undefined) return schtasksCreateXmlArgs(xmlPath);
  const tr = `"${spec.nodePath}" "${spec.scriptPath}" run`;
  return ["/Create", "/SC", "ONLOGON", "/TN", "rp-host", "/TR", tr, "/F"];
}

export const LAUNCHD_LABEL = "dev.j3pf.rp-host";

export function launchdPlist(spec: ServiceSpec): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const home = spec.home ?? os.homedir();
  const logPath = path.join(home, "Library", "Logs", "rp-host.log");
  const envPath = spec.envPath ?? process.env.PATH ?? "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(spec.nodePath)}</string><string>${esc(spec.scriptPath)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(envPath)}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${esc(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(logPath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function launchdPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function lingerUser(user?: string): string {
  return user ?? process.env.USER ?? os.userInfo().username;
}

export async function checkLinger(user?: string, run: Runner = realRun): Promise<{ lingering: boolean; error?: string }> {
  const target = lingerUser(user);
  try {
    const result = await run("loginctl", ["show-user", target, "-p", "Linger"]);
    if (result.code !== 0) return { lingering: false, error: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}` };
    return { lingering: result.stdout.includes("Linger=yes") };
  } catch (error) {
    return { lingering: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function enableLinger(user?: string, run: Runner = realRun): Promise<{ ok: boolean; message: string }> {
  const target = lingerUser(user);
  try {
    const result = await run("loginctl", ["enable-linger", target]);
    if (result.code === 0) return { ok: true, message: `Linger enabled for ${target}` };
    const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    return { ok: false, message: `Could not enable linger for ${target}: ${reason}; this may require privileges` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not enable linger for ${target}: ${reason}; this may require privileges` };
  }
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return `gui/${uid}`;
}

export async function installService(spec: ServiceSpec, run: Runner = realRun): Promise<string> {
  const home = spec.home ?? os.homedir();
  if (spec.platform === "linux") {
    const installedSpec = {
      ...spec,
      nodePath: resolveStableNodePath(process.env, spec.platform, spec.nodePath),
      envPath: spec.envPath ?? process.env.PATH,
    };
    const f = systemdUnitPath(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, systemdUnit(installedSpec));
    let warning = "";
    const linger = await checkLinger(undefined, run);
    if (!linger.lingering) {
      const enabled = await enableLinger(undefined, run);
      if (!enabled.ok) warning = `; warning: ${enabled.message}`;
    }
    await run("systemctl", ["--user", "daemon-reload"]);
    const r = await run("systemctl", ["--user", "enable", "--now", "rp-host"]);
    if (r.code !== 0) throw new Error(`systemctl enable failed: ${r.stderr.trim()}`);
    return `systemd user service installed (${f})${warning}`;
  }
  if (spec.platform === "win32") {
    const installedSpec = {
      ...spec,
      nodePath: resolveStableNodePath(process.env, spec.platform, spec.nodePath),
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-host-task-"));
    const xmlPath = path.join(tempDir, "task.xml");
    try {
      fs.writeFileSync(xmlPath, schtasksXml(installedSpec));
      const r = await run("schtasks", schtasksCreateArgs(installedSpec, xmlPath));
      if (r.code !== 0) throw new Error(`schtasks failed: ${r.stderr.trim() || r.stdout.trim()}`);
      await run("schtasks", ["/Run", "/TN", "rp-host"]);
      return "scheduled task rp-host created (runs at logon)";
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (spec.platform === "darwin") {
    const installedSpec = {
      ...spec,
      nodePath: resolveStableNodePath(process.env, spec.platform, spec.nodePath),
      envPath: spec.envPath ?? process.env.PATH,
    };
    const f = launchdPath(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.mkdirSync(path.join(home, "Library", "Logs"), { recursive: true });
    fs.writeFileSync(f, launchdPlist(installedSpec));
    const domain = launchdDomain();
    const bootstrap = await run("launchctl", ["bootstrap", domain, f]);
    if (bootstrap.code !== 0) {
      const fallback = await run("launchctl", ["load", "-w", f]);
      if (fallback.code !== 0) {
        throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}; load fallback failed: ${fallback.stderr.trim()}`);
      }
    }
    const kickstart = await run("launchctl", ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
    if (kickstart.code !== 0) throw new Error(`launchctl kickstart failed: ${kickstart.stderr.trim()}`);
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
    const domain = launchdDomain();
    const bootout = await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    if (bootout.code !== 0) await run("launchctl", ["unload", "-w", f]);
    fs.rmSync(f, { force: true });
    return "launchd agent removed";
  }
  throw new Error(`unsupported platform ${platform}`);
}
