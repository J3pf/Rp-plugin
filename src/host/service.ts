// Service installation: systemd --user (Linux), Task Scheduler ONLOGON (Windows, no admin), launchd (macOS).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeUser } from "../shared/util.ts";
import { run as realRun, type Runner } from "./runner.ts";

export interface ServiceSpec {
  nodePath: string;
  scriptPath: string;
  platform: NodeJS.Platform;
  home?: string;
  envPath?: string;
}

export interface ServiceInspection {
  platform: NodeJS.Platform;
  installed: boolean;
  enabled?: boolean;
  running: boolean;
  nodePath?: string;
  nodePathValid: boolean;
  scriptPath?: string;
  scriptPathValid: boolean;
  stale: boolean;
  staleReason?: string;
  details?: Record<string, unknown>;
}

function isVersionedNodePath(nodePath: string): boolean {
  const normalized = nodePath.replace(/\\/g, "/");
  return normalized.includes("/Cellar/node/") ||
    /(?:^|\/)(?:versions\/)?node\/v?\d+\.\d+\.\d+(?:[-+][^/]*)?\/(?:bin\/)?node(?:\.exe)?$/i.test(normalized) ||
    /(?:^|\/)node-v\d+\.\d+\.\d+[^/]*\/(?:bin\/)?node(?:\.exe)?$/i.test(normalized);
}

function isNodeBinaryName(nodePath: string): boolean {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(nodePath.trim());
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
  const targetExecPath = execPath ?? process.execPath;
  const targetIsNode = Boolean(targetExecPath && isNodeBinaryName(targetExecPath));
  let realExecPath: string | undefined;
  if (targetIsNode) {
    try {
      realExecPath = fs.realpathSync(targetExecPath);
    } catch {
      // A missing exec path cannot match a PATH candidate; still try available nodes.
    }
  }

  for (const rawDir of directories) {
    const dir = rawDir.trim();
    if (!dir) continue;
    const candidate = pathApi.join(dir, nodeName);
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

  if (targetIsNode && !isVersionedNodePath(targetExecPath) && fs.existsSync(targetExecPath)) {
    return targetExecPath;
  }

  return candidates.find((candidate) => !isVersionedNodePath(candidate)) ?? candidates[0] ?? (targetIsNode ? targetExecPath : nodeName);
}

export function isStaleNodePath(installedNodePath: string): boolean {
  if (!isNodeBinaryName(installedNodePath) || !fs.existsSync(installedNodePath) || installedNodePath.includes("/Cellar/node/")) return true;
  try {
    fs.realpathSync(installedNodePath);
    return false;
  } catch {
    return true;
  }
}

function stripControlChars(s: string): string {
  return s.replace(/[\0\r\n]/g, "");
}

function escapeXml(value: string): string {
  return stripControlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function systemdUnit(spec: ServiceSpec): string {
  const envPath = stripControlChars(spec.envPath ?? process.env.PATH ?? "");
  const escapedEnvPath = envPath.replace(/%/g, "%%").replace(/(["\\])/g, "\\$1");
  const pathEnvironment = escapedEnvPath ? `Environment="PATH=${escapedEnvPath}"\n` : "";
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
  const clean = stripControlChars(s).replace(/%/g, "%%");
  return /[\s"\\]/.test(clean) ? `"${clean.replace(/(["\\])/g, "\\$1")}"` : clean;
}

export function systemdUnitPath(home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", "rp-host.service");
}

export function schtasksXml(spec: ServiceSpec): string {
  const safeNode = escapeXml(spec.nodePath.replace(/"/g, ""));
  const safeScript = escapeXml(spec.scriptPath.replace(/"/g, ""));
  return `<?xml version="1.0" encoding="UTF-16"?>
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
      <Command>conhost.exe</Command>
      <Arguments>--headless "${safeNode}" "${safeScript}" run</Arguments>
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
  const safeNode = stripControlChars(spec.nodePath).replace(/"/g, "");
  const safeScript = stripControlChars(spec.scriptPath).replace(/"/g, "");
  const tr = `conhost.exe --headless "${safeNode}" "${safeScript}" run`;
  return ["/Create", "/SC", "ONLOGON", "/TN", "rp-host", "/TR", tr, "/F"];
}

export const LAUNCHD_LABEL = "dev.j3pf.rp-host";

export function launchdPlist(spec: ServiceSpec): string {
  const home = spec.home ?? os.homedir();
  const logPath = path.join(home, "Library", "Logs", "rp-host.log");
  const envPath = spec.envPath ?? process.env.PATH ?? "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(spec.nodePath)}</string><string>${escapeXml(spec.scriptPath)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
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
  return user ?? process.env.USER ?? safeUser();
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

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function normalizeXmlString(xml: string): string {
  return xml.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

function xmlValue(xml: string, key: string): string | undefined {
  const cleanXml = normalizeXmlString(xml);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cleanXml.match(new RegExp(`<${escapedKey}>([\\s\\S]*?)</${escapedKey}>`, "i"));
  return match ? xmlUnescape(match[1]!.trim()) : undefined;
}

function xmlArray(xml: string, key: string): string[] {
  const cleanXml = normalizeXmlString(xml);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cleanXml.match(new RegExp(`<key>${escapedKey}</key>\\s*<array>([\\s\\S]*?)</array>`, "i"));
  return match ? [...match[1]!.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map((entry) => xmlUnescape(entry[1]!.trim())) : [];
}

function parseExecStart(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char.charCodeAt(0) === 92) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char.trim() === "" && !quoted) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += String.fromCharCode(92);
  if (current) args.push(current);
  return args.map((a) => a.replace(/%%/g, "%"));
}

function validInstalledNode(nodePath: string | undefined): boolean {
  return Boolean(nodePath && fs.existsSync(nodePath) && !isStaleNodePath(nodePath));
}

function validInstalledScript(scriptPath: string | undefined): boolean {
  return Boolean(scriptPath && fs.existsSync(scriptPath));
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function isLaunchdJobRunning(status: { code: number; stdout: string }): boolean {
  if (status.code !== 0) return false;
  const out = status.stdout.trim();
  if (!out) return true;
  const pidMatch = out.match(/"PID"\s*=\s*(\d+)\s*;/i);
  if (pidMatch) return Number(pidMatch[1]) > 0;
  if (out.startsWith("{") || /"Label"\s*=/i.test(out)) return false;
  if (/^-\s+-?\d+\s+/m.test(out)) return false;
  if (/^\d+\s+-?\d+\s+/m.test(out)) return true;
  return true;
}

export async function inspectService(spec: ServiceSpec, run: Runner = realRun): Promise<ServiceInspection> {
  const home = spec.home ?? os.homedir();
  const inspection: ServiceInspection = {
    platform: spec.platform,
    installed: false,
    running: false,
    nodePathValid: false,
    scriptPathValid: false,
    stale: false,
  };

  if (spec.platform === "linux") {
    const unitPath = systemdUnitPath(home);
    const enabled = await run("systemctl", ["--user", "is-enabled", "rp-host"]);
    const active = await run("systemctl", ["--user", "is-active", "rp-host"]);
    const linger = await checkLinger(undefined, run);
    inspection.details = { linger: linger.lingering, ...(linger.error ? { lingerError: linger.error } : {}) };
    inspection.enabled = enabled.code === 0;
    if (!fs.existsSync(unitPath)) return inspection;

    inspection.installed = true;
    const reasons: string[] = [];
    let unit = "";
    try {
      unit = fs.readFileSync(unitPath, "utf8");
    } catch (error) {
      reasons.push(`could not read systemd unit: ${error instanceof Error ? error.message : String(error)}`);
    }
    const execStart = unit.match(/^ExecStart=(.*)$/m)?.[1];
    const args = execStart ? parseExecStart(execStart) : [];
    inspection.nodePath = args[0];
    inspection.scriptPath = args[1];
    inspection.nodePathValid = validInstalledNode(inspection.nodePath);
    inspection.scriptPathValid = validInstalledScript(inspection.scriptPath);
    if (!inspection.nodePathValid) reasons.push("installed node path is missing or stale");
    if (!inspection.scriptPathValid) reasons.push("installed host script path is missing");
    if (inspection.enabled === false) reasons.push("systemd user service is disabled");
    if (!unit.split("\n").some((line) => /^StartLimitIntervalSec\s*=\s*0\s*$/.test(line))) reasons.push("systemd unit is missing StartLimitIntervalSec=0");
    if (!unit.split("\n").some((line) => line.startsWith('Environment="PATH='))) reasons.push('systemd unit is missing Environment="PATH=..."');
    inspection.running = active.code === 0 || active.stdout === "active\n";
    inspection.stale = reasons.length > 0;
    if (inspection.stale) inspection.staleReason = uniqueReasons(reasons).join("; ");
    return inspection;
  }

  if (spec.platform === "darwin") {
    const plistPath = launchdPath(home);
    if (!fs.existsSync(plistPath)) return inspection;
    inspection.installed = true;
    let plist = "";
    const reasons: string[] = [];
    try {
      plist = fs.readFileSync(plistPath, "utf8");
    } catch (error) {
      reasons.push(`could not read launchd plist: ${error instanceof Error ? error.message : String(error)}`);
    }
    const args = xmlArray(plist, "ProgramArguments");
    inspection.nodePath = args[0];
    inspection.scriptPath = args[1];
    inspection.nodePathValid = validInstalledNode(inspection.nodePath);
    inspection.scriptPathValid = validInstalledScript(inspection.scriptPath);
    if (!inspection.nodePathValid) reasons.push("installed node path is missing or stale");
    if (!inspection.scriptPathValid) reasons.push("installed host script path is missing");
    const hasEnvironment = plist.includes("<key>EnvironmentVariables</key>");
    inspection.details = { environmentVariables: hasEnvironment };
    if (!hasEnvironment) reasons.push("launchd plist is missing EnvironmentVariables");
    const status = await run("launchctl", ["list", LAUNCHD_LABEL]);
    inspection.running = isLaunchdJobRunning(status);
    inspection.stale = reasons.length > 0;
    if (inspection.stale) inspection.staleReason = uniqueReasons(reasons).join("; ");
    return inspection;
  }

  if (spec.platform === "win32") {
    const query = await run("schtasks", ["/Query", "/TN", "rp-host", "/XML"]);
    if (query.code !== 0) return inspection;
    inspection.installed = true;
    const rawXml = query.stdout;
    const xml = normalizeXmlString(rawXml);
    const command = xmlValue(xml, "Command") ?? "";
    const argumentsValue = xmlValue(xml, "Arguments") ?? "";
    const isConhost = /(?:^|[\\/])conhost(?:\.exe)?$/i.test(command);
    if (isConhost) {
      const match = argumentsValue.match(/--headless\s+(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))/i);
      if (match) {
        inspection.nodePath = match[1] ?? match[2];
        inspection.scriptPath = match[3] ?? match[4];
      }
    } else {
      const trimmedArguments = argumentsValue.trim();
      const firstQuote = trimmedArguments.startsWith('"') ? trimmedArguments.indexOf('"', 1) : -1;
      inspection.nodePath = command;
      inspection.scriptPath = firstQuote > 1 ? trimmedArguments.slice(1, firstQuote) : trimmedArguments.split(/\s/, 1)[0];
    }
    inspection.nodePathValid = validInstalledNode(inspection.nodePath);
    inspection.scriptPathValid = validInstalledScript(inspection.scriptPath);

    let taskState: string | undefined;
    const ps = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-ScheduledTask -TaskName 'rp-host').State",
    ]);
    if (ps.code === 0 && ps.stdout.trim()) {
      taskState = ps.stdout.trim();
      inspection.running = /^running$/i.test(taskState);
      if (/^disabled$/i.test(taskState)) inspection.enabled = false;
      else if (/^(?:running|ready)$/i.test(taskState)) inspection.enabled = true;
    } else {
      const status = await run("schtasks", ["/Query", "/TN", "rp-host", "/V", "/FO", "LIST"]);
      const lines = status.stdout.split("\n").map((line) => line.trim().replace(/\r$/, ""));
      const isRunning = lines.some((line) =>
        /^(?:status|estado|statut)\s*:\s*(?:running|en ejecución|en cours d'exécution|wird ausgeführt)$/i.test(line)
      );
      const isStopped = lines.some((line) =>
        /^(?:status|estado|statut)\s*:\s*(?:ready|listo|prêt|bereit|disabled|deshabilitado|désactivé)$/i.test(line)
      );
      if (isRunning) {
        taskState = "Running";
        inspection.running = true;
      } else if (isStopped) {
        taskState = "Ready";
        inspection.running = false;
      } else {
        taskState = "Unknown";
        inspection.running = true;
      }
    }

    const executionTimeLimit = xmlValue(xml, "ExecutionTimeLimit");
    const disallowStartIfOnBatteries = xmlValue(xml, "DisallowStartIfOnBatteries");
    const stopIfGoingOnBatteries = xmlValue(xml, "StopIfGoingOnBatteries");
    const startWhenAvailable = xmlValue(xml, "StartWhenAvailable");
    const settings = xml.match(/<Settings>([\s\S]*?)<\/Settings>/i)?.[1] ?? "";
    const enabled = xmlValue(settings, "Enabled");
    const multipleInstancesPolicy = xmlValue(xml, "MultipleInstancesPolicy");
    const restartInterval = xmlValue(xml, "Interval");
    const restartCount = xmlValue(xml, "Count");
    inspection.details = {
      command,
      arguments: argumentsValue,
      taskState,
      executionTimeLimit,
      disallowStartIfOnBatteries: disallowStartIfOnBatteries === undefined ? undefined : disallowStartIfOnBatteries.toLowerCase() === "true",
      stopIfGoingOnBatteries: stopIfGoingOnBatteries === undefined ? undefined : stopIfGoingOnBatteries.toLowerCase() === "true",
      startWhenAvailable: startWhenAvailable === undefined ? undefined : startWhenAvailable.toLowerCase() === "true",
      enabled: enabled === undefined ? inspection.enabled : enabled.toLowerCase() === "true",
      multipleInstancesPolicy,
      restartOnFailure: restartInterval !== undefined && restartCount !== undefined ? { interval: restartInterval, count: Number(restartCount) } : undefined,
    };
    if (enabled !== undefined) inspection.enabled = enabled.toLowerCase() === "true";
    const reasons: string[] = [];
    if (!isConhost) reasons.push("task does not use windowless conhost launcher (visible console window)");
    else if (!/--headless/i.test(argumentsValue)) reasons.push("task arguments missing --headless flag");
    if (!inspection.nodePathValid) reasons.push("installed node path is missing or stale");
    if (!inspection.scriptPathValid) reasons.push("installed host script path is missing");
    if (inspection.enabled === false) reasons.push("task is disabled");
    if (executionTimeLimit !== "PT0S") reasons.push("task is missing ExecutionTimeLimit=PT0S");
    if (disallowStartIfOnBatteries?.toLowerCase() !== "false") reasons.push("task does not allow starting on battery power");
    if (stopIfGoingOnBatteries?.toLowerCase() !== "false") reasons.push("task may stop when switching to battery power");
    if (startWhenAvailable?.toLowerCase() !== "true") reasons.push("task is missing StartWhenAvailable=true");
    if (multipleInstancesPolicy !== "IgnoreNew") reasons.push("task is missing MultipleInstancesPolicy=IgnoreNew");
    if (restartInterval !== "PT1M" || restartCount !== "999") reasons.push("task is missing its restart-on-failure policy");
    inspection.stale = reasons.length > 0;
    if (inspection.stale) inspection.staleReason = uniqueReasons(reasons).join("; ");
    return inspection;
  }

  throw new Error(`unsupported platform ${spec.platform}`);
}

export async function ensureHostService(spec: ServiceSpec, run: Runner = realRun): Promise<{ action: "none" | "installed" | "reinstalled" | "started"; inspection: ServiceInspection; warning?: string }> {
  const inspection = await inspectService(spec, run);
  if (!inspection.installed) {
    const warning = await installService(spec, run);
    return { action: "installed", inspection, warning };
  }
  if (inspection.stale) {
    if (spec.platform === "win32" && inspection.running) {
      await run("schtasks", ["/End", "/TN", "rp-host"]);
    }
    const warning = await installService(spec, run);
    return { action: "reinstalled", inspection, warning };
  }
  if (!inspection.running) {
    let command: string;
    let args: string[];
    if (spec.platform === "linux") {
      command = "systemctl";
      args = ["--user", "start", "rp-host"];
    } else if (spec.platform === "darwin") {
      command = "launchctl";
      args = ["kickstart", "-k", `${launchdDomain()}/${LAUNCHD_LABEL}`];
    } else if (spec.platform === "win32") {
      command = "schtasks";
      args = ["/Run", "/TN", "rp-host"];
    } else {
      throw new Error(`unsupported platform ${spec.platform}`);
    }
    const started = await run(command, args);
    if (started.code !== 0) throw new Error(`${command} start failed: ${started.stderr.trim() || started.stdout.trim() || `exit code ${started.code}`}`);
    return { action: "started", inspection };
  }
  return { action: "none", inspection };
}

export async function installService(spec: ServiceSpec, run: Runner = realRun): Promise<string> {
  const home = spec.home ?? os.homedir();
  const searchEnv = spec.envPath !== undefined
    ? { ...process.env, PATH: spec.envPath, Path: spec.envPath }
    : process.env;
  if (spec.platform === "linux") {
    const installedSpec = {
      ...spec,
      nodePath: resolveStableNodePath(searchEnv, spec.platform, spec.nodePath),
      envPath: spec.envPath ?? process.env.PATH,
    };
    const f = systemdUnitPath(home);
    const hadUnit = fs.existsSync(f);
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
    if (hadUnit) {
      await run("systemctl", ["--user", "restart", "rp-host"]);
    }
    return `systemd user service installed (${f})${warning}`;
  }
  if (spec.platform === "win32") {
    const installedSpec = {
      ...spec,
      nodePath: resolveStableNodePath(searchEnv, spec.platform, spec.nodePath),
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-host-task-"));
    const xmlPath = path.join(tempDir, "task.xml");
    try {
      const xml = schtasksXml(installedSpec);
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(xml, "utf16le");
      fs.writeFileSync(xmlPath, Buffer.concat([bom, body]));
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
      nodePath: resolveStableNodePath(searchEnv, spec.platform, spec.nodePath),
      envPath: spec.envPath ?? process.env.PATH,
    };
    const f = launchdPath(home);
    const hadPlist = fs.existsSync(f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.mkdirSync(path.join(home, "Library", "Logs"), { recursive: true });
    fs.writeFileSync(f, launchdPlist(installedSpec));
    const domain = launchdDomain();
    if (hadPlist) {
      const bootout = await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      if (bootout.code !== 0) await run("launchctl", ["unload", "-w", f]);
    }
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
