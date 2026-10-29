import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHostService, resolveStableNodePath } from "../host/service.js";
import { run as realRun } from "../host/runner.js";
export const AUTOSTART_COOLDOWN_MS = 10 * 60 * 1000;
let lastAutostartCheckAt;
function logError(...args) {
    try {
        console.error(...args);
    }
    catch {
        // Logging must never affect the Pi session.
    }
}
export function shouldCheckHostAutostart(cfg, pi, now = Date.now(), env = process.env) {
    if (cfg.enabled === false)
        return false;
    if (cfg.hostAutostart === false)
        return false;
    if (pi.getFlag("rp-no-auto-host") || pi.getFlag("rp-off"))
        return false;
    if (!Boolean(cfg.machineToken && cfg.relayUrl))
        return false;
    if (env.RP_NO_AUTO_HOST === "1" || env.RP_DISABLED === "1")
        return false;
    if (lastAutostartCheckAt !== undefined && now - lastAutostartCheckAt < AUTOSTART_COOLDOWN_MS)
        return false;
    // Reserve the cooldown before starting asynchronous work so concurrent sessions cannot race.
    lastAutostartCheckAt = now;
    return true;
}
/** Check and repair the paired host service without allowing any failure to escape into Pi. */
export async function ensureHostAutostart(options) {
    try {
        const { cfg, pi } = options;
        const env = options.env ?? process.env;
        const platform = options.platform ?? process.platform;
        if (!shouldCheckHostAutostart(cfg, pi, Date.now(), env))
            return;
        const spec = {
            nodePath: options.nodePath ?? resolveStableNodePath(env, platform),
            scriptPath: options.scriptPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "rp-host.mjs"),
            platform,
            ...(options.home ? { home: options.home } : {}),
            envPath: env.PATH ?? env.Path ?? "",
        };
        const result = await ensureHostService(spec, options.runner ?? realRun);
        if (result.action !== "none" || result.warning) {
            const details = [
                `installed=${result.inspection.installed}`,
                `running=${result.inspection.running}`,
                ...(result.inspection.stale ? [`stale=${result.inspection.staleReason ?? "yes"}`] : []),
                ...(result.warning ? [result.warning] : []),
            ].join(", ");
            logError(`[rp] Host self-heal: ${result.action} (${details})`);
        }
    }
    catch (error) {
        logError("[rp] Host self-heal check failed:", error instanceof Error ? error.message : String(error));
    }
}
export function resetAutostartCooldownForTests() {
    lastAutostartCheckAt = undefined;
}
