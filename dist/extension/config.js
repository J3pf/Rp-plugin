import fs from "node:fs";
import path from "node:path";
import { configPath, defaultInboxDir } from "../shared/platform.js";
export const DEFAULT_CONFIG = {
    relayUrl: null,
    machineId: null,
    machineToken: null,
    machine: {},
    enabled: true,
    hostAutostart: true,
    redactContent: false,
    gate: {
        mode: "auto-detect",
        dangerousPatterns: [
            "\\brm\\b\\s+(-[a-zA-Z0-9]+\\s+)*(-[a-zA-Z0-9]*r|--recursive\\b)",
            "\\bsudo\\b",
            "\\bgit\\s+push\\b.*(\\s--force|\\s-f\\b)",
            "\\bchmod\\b.*777",
            "\\bdd\\b",
            "\\bmkfs",
        ],
        alwaysAllowTools: ["read", "grep", "find", "ls"],
        useAnnotations: true,
        approverWaitMs: 5000,
    },
    mirrorDialogs: true,
    delivery: { method: "auto", interactive: true },
    subagents: "skip",
    inboxDir: null,
};
const GATE_MODES = ["auto-detect", "off", "dangerous", "writes", "all"];
const DELIVERY = ["auto", "api", "interactive", "herdr"];
function bool(v, d) {
    return typeof v === "boolean" ? v : d;
}
function strArr(v, d) {
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : d;
}
/** Merge arbitrary JSON into a fully-populated, validated config (unknown/invalid fields fall back to defaults). */
export function normalizeConfig(raw) {
    const d = DEFAULT_CONFIG;
    const r = raw && typeof raw === "object" ? raw : {};
    const g = r.gate && typeof r.gate === "object" ? r.gate : {};
    const dl = r.delivery && typeof r.delivery === "object" ? r.delivery : {};
    return {
        relayUrl: typeof r.relayUrl === "string" && r.relayUrl ? r.relayUrl : null,
        machineId: typeof r.machineId === "string" ? r.machineId : null,
        machineToken: typeof r.machineToken === "string" ? r.machineToken : null,
        machine: r.machine && typeof r.machine === "object" ? { ...r.machine } : {},
        enabled: bool(r.enabled, d.enabled),
        hostAutostart: bool(r.hostAutostart ?? r.autoHost, d.hostAutostart),
        redactContent: bool(r.redactContent, d.redactContent),
        gate: {
            mode: GATE_MODES.includes(g.mode) ? g.mode : d.gate.mode,
            dangerousPatterns: strArr(g.dangerousPatterns, d.gate.dangerousPatterns),
            alwaysAllowTools: strArr(g.alwaysAllowTools, d.gate.alwaysAllowTools),
            useAnnotations: bool(g.useAnnotations, d.gate.useAnnotations),
            approverWaitMs: typeof g.approverWaitMs === "number" && g.approverWaitMs >= 0 && g.approverWaitMs <= 60_000 ? g.approverWaitMs : d.gate.approverWaitMs,
        },
        mirrorDialogs: bool(r.mirrorDialogs, d.mirrorDialogs),
        delivery: {
            method: DELIVERY.includes(dl.method) ? dl.method : d.delivery.method,
            interactive: bool(dl.interactive, d.delivery.interactive),
        },
        subagents: r.subagents === "connect" ? "connect" : "skip",
        inboxDir: typeof r.inboxDir === "string" && r.inboxDir ? r.inboxDir : null,
    };
}
/** Sync, read-only load (the extension factory must not do I/O beyond this). Applies env overrides. */
export function loadConfig(env = process.env, platform = process.platform) {
    const p = configPath(env, platform);
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        raw = {};
    }
    const cfg = normalizeConfig(raw);
    if (env.RP_RELAY_URL)
        cfg.relayUrl = env.RP_RELAY_URL;
    if (env.RP_DISABLED === "1" || env.RP_DISABLED === "true")
        cfg.enabled = false;
    return { cfg, path: p };
}
/** Atomic write with 0600 permissions. Persisted file never contains env overrides applied at load. */
export function saveConfig(p, cfg) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    }
    catch {
        /* Windows: ACLs inherit from %APPDATA% */
    }
    fs.renameSync(tmp, p);
}
/** Read the on-disk config without env overrides, apply a mutation, and write it back. */
export function updateConfigFile(p, mutate) {
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        raw = {};
    }
    const cfg = normalizeConfig(raw);
    mutate(cfg);
    saveConfig(p, cfg);
    return cfg;
}
export function resolveInboxDir(cfg, env = process.env, platform = process.platform) {
    return cfg.inboxDir || defaultInboxDir(env, platform);
}
