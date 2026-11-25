// Validation of everything that comes from the phone: it can choose a directory under `roots` and a launcher key, nothing else.
import fs from "node:fs";
import path from "node:path";
import { NO_ROOTS_HINT, missingRoots } from "./config.js";
import { SAFE_CONV_ID_RE, splitCommand } from "../shared/util.js";
export { splitCommand };
export class HostError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function isInside(root, target, platform = process.platform) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const r = platform === "win32" ? root.toLowerCase() : root;
    const t = platform === "win32" ? target.toLowerCase() : target;
    const rel = p.relative(r, t);
    return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}
/** Canonicalize with realpath and require the result to live under one of the roots without leaking outside existence/type. */
export function resolveWithinRoots(cfg, requested, platform = process.platform) {
    if (typeof requested !== "string" || !requested || requested.includes("\0"))
        throw new HostError("bad_request", "invalid path");
    const p = platform === "win32" ? path.win32 : path.posix;
    const resolvePath = platform === process.platform ? path.resolve : p.resolve;
    const lexicalRoots = [];
    const canonicalRoots = [];
    for (const r of cfg.roots) {
        const absRoot = resolvePath(r);
        lexicalRoots.push(absRoot);
        try {
            const realRoot = fs.realpathSync(absRoot);
            canonicalRoots.push(realRoot);
            if (realRoot !== absRoot)
                lexicalRoots.push(realRoot);
        }
        catch {
            canonicalRoots.push(absRoot);
        }
    }
    const resolvedRequested = resolvePath(requested);
    if (!lexicalRoots.some((r) => isInside(r, resolvedRequested, platform))) {
        throw new HostError("bad_request", "path is outside the allowed roots");
    }
    let real;
    try {
        real = fs.realpathSync(resolvedRequested);
    }
    catch {
        throw new HostError("not_found", "directory does not exist");
    }
    if (!canonicalRoots.some((r) => isInside(r, real, platform))) {
        throw new HostError("bad_request", "path is outside the allowed roots");
    }
    let st;
    try {
        st = fs.statSync(real);
    }
    catch {
        throw new HostError("not_found", "directory does not exist");
    }
    if (!st.isDirectory())
        throw new HostError("bad_request", "not a directory");
    return real;
}
export function listDirs(cfg, requested) {
    if (!requested || requested === "/") {
        if (missingRoots(cfg))
            throw new HostError("not_found", NO_ROOTS_HINT);
        return { path: "", dirs: cfg.roots.filter((r) => fs.existsSync(r)) };
    }
    const real = resolveWithinRoots(cfg, requested);
    const dirs = fs
        .readdirSync(real, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500);
    return { path: real, dirs };
}
/** Returns true when a parsed launcher command targets an external CLI (Claude Code, Codex, or Agy) rather than Pi. */
export function isExternalCliLauncher(parts) {
    const bin = path.basename(parts[0] ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
    return bin === "claude" || bin === "codex" || bin === "agy";
}
/** The phone sends a launcher *key*, never a command. */
export function resolveLauncher(cfg, key) {
    const k = key ?? cfg.defaultLauncher;
    if (!Object.prototype.hasOwnProperty.call(cfg.launchers, k))
        throw new HostError("bad_request", `unknown launcher "${k}"`);
    return { key: k, command: cfg.launchers[k] };
}
function cleanLabelValue(value) {
    return (value ?? "")
        .replace(/[\u0000-\u001f\u007f;"`$\\&|^%<>()]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[-\s]+/, "")
        .slice(0, 60)
        .trim();
}
/** Labels end up in CLI args and terminal titles: strip control chars, metacharacters, and leading dashes. */
export function sanitizeLabel(name, fallback) {
    return cleanLabelValue(name) || cleanLabelValue(fallback) || "agent";
}
export function validateSpawnId(id) {
    if (typeof id !== "string" || !/^[0-9A-Za-z]{10,40}$/.test(id))
        throw new HostError("bad_request", "invalid spawnId");
    return id;
}
export function validateSessionId(id) {
    if (typeof id !== "string" || !SAFE_CONV_ID_RE.test(id)) {
        throw new HostError("bad_request", "invalid sessionId");
    }
    return id;
}
export function validatePaneId(id) {
    if (typeof id !== "string" || !/^[0-9A-Za-z][0-9A-Za-z_.:-]{0,63}$/.test(id)) {
        throw new HostError("bad_request", "invalid paneId");
    }
    return id;
}
