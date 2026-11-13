import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b64url } from "../shared/e2e/identity.ts";
import { machineKeyPath } from "../shared/platform.ts";
import { loadOrCreateMachineIdentity } from "../shared/e2e/identity.ts";
import { resolveRelayCommand, splitCommand } from "../host/serve/relay.ts";
import { type ServeHandle, type ServeOptions, startServe } from "../host/serve/index.ts";
import type { TunnelProviderName } from "../host/serve/tunnel.ts";
import { pairMachine as defaultPairMachine } from "./commands.ts";

export type EndpointKind = "relay" | "direct";

export interface PairUriFields {
  publicUrl: string;
  code: string;
  endpointKind: EndpointKind;
  /** Required for `direct`: the machine fingerprint the app pins before sending anything. */
  fingerprint?: string;
  name?: string;
}

/**
 * `rp://pair?u=&c=&k=&f=&n=` — v2 adds the endpoint kind and the fingerprint.
 * A relay pairing keeps the v1 shape so old readers stay compatible.
 */
export function buildPairUri(f: PairUriFields): string {
  const url = f.publicUrl.replace(/\/+$/, "");
  const params = [`u=${encodeURIComponent(url)}`, `c=${f.code}`];
  if (f.endpointKind === "direct") {
    if (!f.fingerprint) throw new Error("a direct pairing QR needs the machine fingerprint (f)");
    params.push("k=direct", `f=${f.fingerprint}`);
  }
  if (f.name) params.push(`n=${encodeURIComponent(f.name)}`);
  return `rp://pair?${params.join("&")}`;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DirectDeps {
  startServe?: (o: ServeOptions) => Promise<ServeHandle>;
  relayCli?: (args: string[], configPath: string) => Promise<CliResult>;
  pairMachine?: (url: string, code: string, body: Record<string, unknown>) => Promise<{ machineId: string; machineToken: string }>;
  hostname?: string;
}

export interface DirectRequest {
  dataDir: string;
  /** Canonical machine key; defaults to the shared RP config dir (see `machineKeyPath`). */
  keyPath?: string;
  tunnel: TunnelProviderName;
  relayCommand?: string | null;
  relayPath?: string | null;
  name?: string;
  context?: string;
  onLog: (line: string) => void;
  deps?: DirectDeps;
}

export interface DirectRun {
  publicUrl: string;
  /** Loopback URL: this PC talks to its own relay without going through the tunnel. */
  localUrl: string;
  port: number;
  dataDir: string;
  tunnel: TunnelProviderName;
  pubkey: string;
  keyId: string;
  machineId: string;
  machineToken: string;
  /** False when the machine pairing already existed on disk. */
  machinePaired: boolean;
  /** QR text as rendered by the relay CLI. */
  qr: string;
  uri: string;
  deviceCode: string;
  stop: () => Promise<void>;
}

interface StoredMachine {
  v: 1;
  machineId: string;
  machineToken: string;
  keyId: string;
  publicUrl: string;
  pairedAt: string;
}

const MACHINE_FILE = "machine.json";

function relayCliDefault(configPath: string, relayCommand?: string | null, relayPath?: string | null) {
  const prefix = resolveRelayCommand({ relayCommand, relayPath });
  return (args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(
        prefix[0]!,
        [...prefix.slice(1), ...args, "--config", configPath],
        { timeout: 60_000, env: { ...process.env, NO_COLOR: "1" }, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code?: number }).code) : err ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

function readStoredMachine(file: string): StoredMachine | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredMachine;
    return parsed && typeof parsed.machineId === "string" && typeof parsed.machineToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredMachine(file: string, value: StoredMachine): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows: ACLs inherit from the user profile */
  }
  fs.renameSync(tmp, file);
}

/**
 * Direct mode bring-up: tunnel + embedded relay, this PC paired against it, and a v2 pairing
 * QR for the phone. Every failure after the stack is up tears the stack down.
 */
export async function startDirectMode(req: DirectRequest): Promise<DirectRun> {
  const deps = req.deps ?? {};
  const configPath = path.join(req.dataDir, "relay.json");
  const identity = loadOrCreateMachineIdentity(req.keyPath ?? machineKeyPath()).identity;
  const runServe = deps.startServe ?? startServe;
  const cli = deps.relayCli ?? ((args: string[], cfg: string) => relayCliDefault(cfg, req.relayCommand, req.relayPath)(args));
  const pair = deps.pairMachine ?? defaultPairMachine;
  const hostname = deps.hostname ?? os.hostname();

  const serve = await runServe({
    tunnel: req.tunnel,
    relayCommand: req.relayCommand ?? null,
    relayPath: req.relayPath ?? null,
    dataDir: req.dataDir,
    onLog: req.onLog,
  });
  const localUrl = `http://127.0.0.1:${serve.port}`;

  try {
    let stored = readStoredMachine(path.join(req.dataDir, MACHINE_FILE));
    const machinePaired = stored === null;
    if (!stored) {
      const issued = await cli(["pair", "machine", "--json", "--name", req.name ?? hostname, "--context", req.context ?? "personal"], configPath);
      if (issued.code !== 0) throw new Error(`could not create the machine pairing code: ${(issued.stderr || issued.stdout).trim() || `exit ${issued.code}`}`);
      const code = parseJson<{ code?: string }>(issued.stdout)?.code;
      if (!code) throw new Error(`the relay CLI did not return a pairing code: ${issued.stdout.trim()}`);

      const result = await pair(localUrl, code, {
        hostname,
        name: req.name,
        context: req.context,
        pubkey: identity.pubkey,
      });
      stored = {
        v: 1,
        machineId: result.machineId,
        machineToken: result.machineToken,
        keyId: identity.keyId,
        publicUrl: serve.publicUrl,
        pairedAt: new Date().toISOString(),
      };
      writeStoredMachine(path.join(req.dataDir, MACHINE_FILE), stored);
    }

    const device = await cli(["pair", "device", "--json"], configPath);
    if (device.code !== 0) throw new Error(`could not create the device pairing code: ${(device.stderr || device.stdout).trim() || `exit ${device.code}`}`);
    const deviceCode = parseJson<{ code?: string }>(device.stdout)?.code;
    if (!deviceCode) throw new Error(`the relay CLI did not return a device code: ${device.stdout.trim()}`);

    const uri = buildPairUri({
      publicUrl: serve.publicUrl,
      code: deviceCode,
      endpointKind: "direct",
      fingerprint: identity.keyId,
      name: req.name ?? hostname,
    });

    const painted = await cli(["qr", uri], configPath);
    if (painted.code !== 0) throw new Error(`could not render the pairing QR: ${(painted.stderr || painted.stdout).trim() || `exit ${painted.code}`}`);

    return {
      publicUrl: serve.publicUrl,
      localUrl,
      port: serve.port,
      dataDir: req.dataDir,
      tunnel: req.tunnel,
      pubkey: identity.pubkey,
      keyId: identity.keyId,
      machineId: stored.machineId,
      machineToken: stored.machineToken,
      machinePaired,
      qr: painted.stdout.trimEnd(),
      uri,
      deviceCode,
      stop: serve.stop,
    };
  } catch (err) {
    await serve.stop();
    throw err;
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export { b64url, splitCommand };

/** The live direct-mode stack of this session, so `/rp off` and `/rp unpair` can tear it down. */
let activeDirect: { publicUrl: string; stop: () => Promise<void> } | null = null;

export function setActiveDirect(run: { publicUrl: string; stop: () => Promise<void> } | null): void {
  activeDirect = run;
}

export function getActiveDirect(): { publicUrl: string; stop: () => Promise<void> } | null {
  return activeDirect;
}

export async function stopActiveDirect(): Promise<void> {
  const run = activeDirect;
  activeDirect = null;
  await run?.stop();
}
