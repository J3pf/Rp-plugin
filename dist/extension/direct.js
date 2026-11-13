import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b64url } from "../shared/e2e/identity.js";
import { machineKeyPath } from "../shared/platform.js";
import { loadOrCreateMachineIdentity } from "../shared/e2e/identity.js";
import { resolveRelayCommand, splitCommand } from "../host/serve/relay.js";
import { startServe } from "../host/serve/index.js";
import { pairMachine as defaultPairMachine } from "./commands.js";
/**
 * `rp://pair?u=&c=&k=&f=&n=` — v2 adds the endpoint kind and the fingerprint.
 * A relay pairing keeps the v1 shape so old readers stay compatible.
 */
export function buildPairUri(f) {
    const url = f.publicUrl.replace(/\/+$/, "");
    const params = [`u=${encodeURIComponent(url)}`, `c=${f.code}`];
    if (f.endpointKind === "direct") {
        if (!f.fingerprint)
            throw new Error("a direct pairing QR needs the machine fingerprint (f)");
        params.push("k=direct", `f=${f.fingerprint}`);
    }
    if (f.name)
        params.push(`n=${encodeURIComponent(f.name)}`);
    return `rp://pair?${params.join("&")}`;
}
const MACHINE_FILE = "machine.json";
function relayCliDefault(configPath, relayCommand, relayPath) {
    const prefix = resolveRelayCommand({ relayCommand, relayPath });
    return (args) => new Promise((resolve) => {
        execFile(prefix[0], [...prefix.slice(1), ...args, "--config", configPath], { timeout: 60_000, env: { ...process.env, NO_COLOR: "1" }, windowsHide: true }, (err, stdout, stderr) => {
            const code = err && typeof err.code === "number" ? Number(err.code) : err ? 1 : 0;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}
function readStoredMachine(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed && typeof parsed.machineId === "string" && typeof parsed.machineToken === "string" ? parsed : null;
    }
    catch {
        return null;
    }
}
function writeStoredMachine(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    }
    catch {
        /* Windows: ACLs inherit from the user profile */
    }
    fs.renameSync(tmp, file);
}
/**
 * Direct mode bring-up: tunnel + embedded relay, this PC paired against it, and a v2 pairing
 * QR for the phone. Every failure after the stack is up tears the stack down.
 */
export async function startDirectMode(req) {
    const deps = req.deps ?? {};
    const configPath = path.join(req.dataDir, "relay.json");
    const identity = loadOrCreateMachineIdentity(req.keyPath ?? machineKeyPath()).identity;
    const runServe = deps.startServe ?? startServe;
    const cli = deps.relayCli ?? ((args, cfg) => relayCliDefault(cfg, req.relayCommand, req.relayPath)(args));
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
            if (issued.code !== 0)
                throw new Error(`could not create the machine pairing code: ${(issued.stderr || issued.stdout).trim() || `exit ${issued.code}`}`);
            const code = parseJson(issued.stdout)?.code;
            if (!code)
                throw new Error(`the relay CLI did not return a pairing code: ${issued.stdout.trim()}`);
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
        if (device.code !== 0)
            throw new Error(`could not create the device pairing code: ${(device.stderr || device.stdout).trim() || `exit ${device.code}`}`);
        const deviceCode = parseJson(device.stdout)?.code;
        if (!deviceCode)
            throw new Error(`the relay CLI did not return a device code: ${device.stdout.trim()}`);
        const uri = buildPairUri({
            publicUrl: serve.publicUrl,
            code: deviceCode,
            endpointKind: "direct",
            fingerprint: identity.keyId,
            name: req.name ?? hostname,
        });
        const painted = await cli(["qr", uri], configPath);
        if (painted.code !== 0)
            throw new Error(`could not render the pairing QR: ${(painted.stderr || painted.stdout).trim() || `exit ${painted.code}`}`);
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
    }
    catch (err) {
        await serve.stop();
        throw err;
    }
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
export { b64url, splitCommand };
/** The live direct-mode stack of this session, so `/rp off` and `/rp unpair` can tear it down. */
let activeDirect = null;
export function setActiveDirect(run) {
    activeDirect = run;
}
export function getActiveDirect() {
    return activeDirect;
}
export async function stopActiveDirect() {
    const run = activeDirect;
    activeDirect = null;
    await run?.stop();
}
