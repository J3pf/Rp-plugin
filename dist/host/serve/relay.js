import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ChildSupervisor } from "./supervisor.js";
const INSTALL_HINT = "install it with `npm i -g @j3pf/rp-relay`, or point serve.relayCommand / serve.relayPath at a checkout";
export function buildRelayConfig(o) {
    return {
        profile: "single-host",
        listen: { host: o.host ?? "127.0.0.1", port: o.port },
        publicUrl: o.publicUrl,
        dataDir: o.dataDir,
        backup: { enabled: false, intervalMinutes: 1440, keepDays: 1 },
        ...(o.logLevel ? { logLevel: o.logLevel } : {}),
    };
}
/** Splits a command line without invoking a shell, honouring single and double quotes. */
export function splitCommand(line) {
    const out = [];
    let current = "";
    let quote = null;
    let started = false;
    for (const ch of line.trim()) {
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started) {
                out.push(current);
                current = "";
                started = false;
            }
            continue;
        }
        current += ch;
        started = true;
    }
    if (started)
        out.push(current);
    return out;
}
/** Relay argv prefix: explicit path > explicit command > `rp-relay` on PATH. */
export function resolveRelayCommand(cfg, nodePath = process.execPath) {
    if (cfg.relayPath)
        return [nodePath, cfg.relayPath];
    if (cfg.relayCommand && cfg.relayCommand.trim())
        return splitCommand(cfg.relayCommand);
    return ["rp-relay"];
}
/** Asks the OS for an unused loopback port, so the tunnel can be pointed at it before the relay starts. */
export function pickFreePort(host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, host, () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => (port > 0 ? resolve(port) : reject(new Error("could not allocate a free port"))));
        });
    });
}
export async function waitForHealth(o) {
    const timeoutMs = o.timeoutMs ?? 30_000;
    const intervalMs = o.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            const res = await fetch(o.url, { signal: AbortSignal.timeout(Math.min(2_000, intervalMs * 8)) });
            if (res.ok)
                return;
            lastError = `HTTP ${res.status}`;
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`relay did not become healthy at ${o.url} within ${timeoutMs}ms${lastError ? ` (${lastError})` : ""}`);
}
/**
 * Runs the relay as a child process: its native dependency (better-sqlite3) must not enter a Pi
 * extension's dependency tree, so it stays outside the plugin process entirely.
 */
export async function startRelayProcess(o) {
    const recent = [];
    const note = (line) => {
        recent.push(line);
        if (recent.length > 20)
            recent.shift();
    };
    let fatalReason = null;
    let rejectFatal;
    const fatal = new Promise((_, reject) => {
        rejectFatal = reject;
    });
    fatal.catch(() => { });
    const supervisor = new ChildSupervisor({
        name: "relay",
        command: o.command[0],
        args: [...o.command.slice(1), "serve", "--config", o.configPath],
        env: o.env,
        onLog: (line) => {
            note(line);
            o.onLog(line);
        },
        onFatal: (reason) => {
            fatalReason = reason;
            rejectFatal(new Error(reason));
        },
        restart: { enabled: true, initialDelayMs: 500, maxDelayMs: 15_000, maxAttempts: 4, resetAfterMs: 60_000 },
    });
    await supervisor.start();
    try {
        await Promise.race([waitForHealth({ url: o.healthUrl, timeoutMs: o.timeoutMs ?? 30_000 }), fatal]);
    }
    catch (err) {
        await supervisor.stop();
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.includes("could not be started"))
            throw new Error(`${reason} — ${INSTALL_HINT}`);
        if (fatalReason)
            throw new Error(fatalReason);
        const tail = recent.filter((l) => !l.startsWith("relay: restarting")).slice(-5);
        throw new Error(`${reason}${tail.length ? `\nlast relay output:\n${tail.join("\n")}` : ""}`);
    }
    return {
        port: Number(new URL(o.healthUrl).port),
        stopped: () => !supervisor.isRunning(),
        stop: () => supervisor.stop(),
    };
}
/** Writes the embedded relay config next to the plugin's own config, mode 0600. */
export function writeRelayConfig(configPath, cfg) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    }
    catch {
        /* Windows: ACLs inherit from the user profile */
    }
    fs.renameSync(tmp, configPath);
}
