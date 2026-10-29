// Validation of everything that comes from the phone: it can choose a directory under `roots` and a launcher key, nothing else.
import fs from "node:fs";
import path from "node:path";
import { splitCommand } from "../shared/util.js";
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
/** Canonicalize with realpath and require the result to live under one of the roots. */
export function resolveWithinRoots(cfg, requested, platform = process.platform) {
    if (typeof requested !== "string" || !requested || requested.includes("\0"))
        throw new HostError("bad_request", "invalid path");
    let real;
    try {
        real = fs.realpathSync(requested);
    }
    catch {
        throw new HostError("not_found", "directory does not exist");
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
    const roots = cfg.roots.map((r) => {
        try {
            return fs.realpathSync(r);
        }
        catch {
            return r;
        }
    });
    if (!roots.some((r) => isInside(r, real, platform)))
        throw new HostError("bad_request", "path is outside the allowed roots");
    return real;
}
export function listDirs(cfg, requested) {
    if (!requested || requested === "/" || requested === "") {
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
/** The phone sends a launcher *key*, never a command. */
export function resolveLauncher(cfg, key) {
    const k = key ?? cfg.defaultLauncher;
    if (!Object.prototype.hasOwnProperty.call(cfg.launchers, k))
        throw new HostError("bad_request", `unknown launcher "${k}"`);
    return { key: k, command: cfg.launchers[k] };
}
/** Labels end up in CLI args and terminal titles: strip control chars and `;` (wt command separator). */
export function sanitizeLabel(name, fallback) {
    const cleaned = (name ?? "")
        .replace(/[\u0000-\u001f\u007f;"`$\\&|^%<>()]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
    return cleaned || fallback;
}
export function validateSpawnId(id) {
    if (typeof id !== "string" || !/^[0-9A-Za-z]{10,40}$/.test(id))
        throw new HostError("bad_request", "invalid spawnId");
    return id;
}
export function validateSessionId(id) {
    if (typeof id !== "string" || !/^[0-9A-Za-z_][0-9A-Za-z_-]{0,127}$/.test(id)) {
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
