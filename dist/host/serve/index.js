import os from "node:os";
import path from "node:path";
import { configDir } from "../../shared/platform.js";
import { buildRelayConfig, pickFreePort, resolveRelayCommand, startRelayProcess, waitForHealth, writeRelayConfig, } from "./relay.js";
import { startTunnel } from "./tunnel.js";
export const TUNNEL_PROVIDERS = ["cloudflared", "tailscale", "none"];
const PROVIDER_HINT = TUNNEL_PROVIDERS.join(", ");
/**
 * Resolves the embedded stack settings: explicit environment overrides win over `host.json`,
 * and the relay data lives under the RP config directory so it survives upgrades.
 */
export function resolveServeSettings(host, env = process.env, platform = process.platform) {
    const cfg = host.serve ?? {};
    const tunnelRaw = env.RP_SERVE_TUNNEL ?? cfg.tunnel ?? "cloudflared";
    const tunnel = String(tunnelRaw).trim().toLowerCase();
    if (!TUNNEL_PROVIDERS.includes(tunnel)) {
        throw new Error(`unknown serve.tunnel "${String(tunnelRaw)}" (expected ${PROVIDER_HINT})`);
    }
    const dataDir = env.RP_SERVE_DATA_DIR ?? cfg.dataDir ?? path.join(configDir(env, platform, os.homedir()), "direct");
    return {
        tunnel,
        relayCommand: env.RP_SERVE_RELAY_COMMAND ?? cfg.relayCommand ?? null,
        relayPath: cfg.relayPath ?? null,
        dataDir: path.resolve(dataDir),
    };
}
/**
 * Boots the "direct mode" stack: tunnel first (so its URL can be baked into the relay config),
 * then the relay as a supervised child. A failure anywhere tears the whole stack down.
 */
export async function startServe(o) {
    const port = await pickFreePort(o.host ?? "127.0.0.1");
    const tunnel = await startTunnel({
        provider: o.tunnel,
        localPort: port,
        onLog: o.onLog,
        command: o.tunnelCommand,
        run: o.tunnelRun,
        timeoutMs: o.tunnelTimeoutMs,
    });
    const relayConfigPath = path.join(o.dataDir, "relay.json");
    let relay;
    try {
        writeRelayConfig(relayConfigPath, buildRelayConfig({
            publicUrl: tunnel.publicUrl,
            port,
            dataDir: path.join(o.dataDir, "relay-data"),
            host: o.host,
            logLevel: o.logLevel,
        }));
        relay = await startRelayProcess({
            command: resolveRelayCommand({ relayCommand: o.relayCommand, relayPath: o.relayPath }),
            configPath: relayConfigPath,
            healthUrl: `http://127.0.0.1:${port}/healthz`,
            onLog: o.onLog,
            timeoutMs: o.healthTimeoutMs,
            env: { ...process.env, RP_SERVE_CHILD: "1" },
        });
    }
    catch (err) {
        await tunnel.stop();
        throw err;
    }
    let stopped = false;
    return {
        publicUrl: tunnel.publicUrl,
        port,
        dataDir: o.dataDir,
        relayConfigPath,
        provider: o.tunnel,
        stopped: () => stopped,
        stop: async () => {
            if (stopped)
                return;
            stopped = true;
            await relay.stop();
            await tunnel.stop();
        },
    };
}
/** Polls the embedded relay until healthy; exported for `rp-host serve --check`. */
export { waitForHealth };
/** Friendly one-liner for the TUI and for logs. */
export function describeServe(h) {
    return `direct mode ready: ${h.publicUrl} (relay on 127.0.0.1:${h.port}, tunnel ${h.provider}, data ${h.dataDir})`;
}
