import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../shared/platform.js";
import { ensureHostService, resolveStableNodePath } from "../host/service.js";
import { run as realRun } from "../host/runner.js";
export const AUTOSTART_COOLDOWN_MS = 10 * 60 * 1000;
const AUTOSTART_STAMP_FILENAME = "host-check.stamp";
let lastAutostartCheckAt;
const writtenStampPaths = new Set();
function logError(...args) {
    try {
        console.error(...args);
    }
    catch {
        // Logging must never affect the Pi session.
    }
}
function readStampTimestamp(stampPath) {
    try {
        const raw = fs.readFileSync(stampPath, "utf8").trim();
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    catch {
        /* fall through */
    }
    try {
        const st = fs.statSync(stampPath);
        return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
    }
    catch {
        return null;
    }
}
function writeStampTimestamp(stampPath, now) {
    try {
        fs.mkdirSync(path.dirname(stampPath), { recursive: true });
        fs.writeFileSync(stampPath, String(Math.floor(now)), { mode: 0o600 });
        writtenStampPaths.add(stampPath);
    }
    catch {
        /* best effort — never affect Pi session */
    }
}
export function shouldCheckHostAutostart(cfg, pi, now = Date.now(), env = process.env, stampPath) {
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
    if (lastAutostartCheckAt !== undefined && now >= lastAutostartCheckAt && now - lastAutostartCheckAt < AUTOSTART_COOLDOWN_MS) {
        return false;
    }
    const resolvedStamp = stampPath ?? path.join(configDir(env), AUTOSTART_STAMP_FILENAME);
    const stampTs = readStampTimestamp(resolvedStamp);
    if (stampTs !== null && stampTs <= now && now - stampTs < AUTOSTART_COOLDOWN_MS) {
        lastAutostartCheckAt = stampTs;
        return false;
    }
    // Reserve the cooldown before starting asynchronous work so concurrent sessions/processes cannot race.
    lastAutostartCheckAt = now;
    writeStampTimestamp(resolvedStamp, now);
    return true;
}
/** Check and repair the paired host service without allowing any failure to escape into Pi. */
export async function ensureHostAutostart(options) {
    try {
        const { cfg, pi } = options;
        const env = options.env ?? process.env;
        const platform = options.platform ?? process.platform;
        const stampPath = options.stampPath ??
            (options.home
                ? path.join(options.home, ".config", "rp", AUTOSTART_STAMP_FILENAME)
                : path.join(configDir(env, platform), AUTOSTART_STAMP_FILENAME));
        if (!shouldCheckHostAutostart(cfg, pi, Date.now(), env, stampPath))
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
    for (const p of writtenStampPaths) {
        try {
            fs.rmSync(p, { force: true });
        }
        catch {
            /* ignore */
        }
    }
    writtenStampPaths.clear();
}
