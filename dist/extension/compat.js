// Every access to non-public Pi internals or to the shape of gentle-pi goes through this module (risk R1/R5/R6).
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { GENTLE_ASK_TOOLS } from "./environment.js";
/** Tested range of gentle-pi (PLAN §8.5). */
export const GENTLE_RANGE = { min: [4, 0, 0], maxExclusive: [5, 0, 0] };
export function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
    for (let i = 0; i < 3; i++)
        if (a[i] !== b[i])
            return a[i] < b[i] ? -1 : 1;
    return 0;
}
export function gentleVersionSupported(version) {
    if (!version)
        return false;
    const v = parseVersion(version);
    if (!v)
        return false;
    return cmp(v, GENTLE_RANGE.min) >= 0 && cmp(v, GENTLE_RANGE.maxExclusive) < 0;
}
const warned = new Set();
export function warnOnce(ctx, key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    try {
        ctx?.ui?.notify?.(message, "warning");
    }
    catch {
        /* ignore */
    }
}
export function resetWarnings() {
    warned.clear();
}
export function toolNames(pi) {
    try {
        return pi.getAllTools().map((t) => t.name);
    }
    catch {
        return [];
    }
}
export function hasGentleAskTools(pi) {
    const names = toolNames(pi);
    return GENTLE_ASK_TOOLS.some((n) => names.includes(n));
}
const pkgCache = new Map();
function setPkgCache(key, val) {
    pkgCache.delete(key);
    pkgCache.set(key, val);
    if (pkgCache.size > 200) {
        const first = pkgCache.keys().next();
        if (!first.done)
            pkgCache.delete(first.value);
    }
}
/** Walk upwards from a path to find the owning package.json (used to read the gentle-pi version). */
export function findPackageJson(startPath, name) {
    const cacheKey = `${startPath}\0${name ?? ""}`;
    if (pkgCache.has(cacheKey))
        return pkgCache.get(cacheKey);
    let dir = startPath;
    try {
        if (fs.existsSync(dir) && fs.statSync(dir).isFile())
            dir = path.dirname(dir);
    }
    catch {
        /* ignore */
    }
    for (let i = 0; i < 8; i++) {
        const f = path.join(dir, "package.json");
        try {
            const json = JSON.parse(fs.readFileSync(f, "utf8"));
            if (!name || json.name === name) {
                const res = { dir, json };
                setPkgCache(cacheKey, res);
                return res;
            }
        }
        catch {
            /* keep walking */
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    setPkgCache(cacheKey, null);
    return null;
}
/** gentle-pi version, read from the package that registers `ask_user_*` (ToolInfo.sourceInfo). */
export function detectGentleVersion(pi) {
    try {
        const tool = pi.getAllTools().find((t) => GENTLE_ASK_TOOLS.includes(t.name));
        const si = tool?.sourceInfo;
        const start = si?.baseDir || si?.path;
        if (!start || !path.isAbsolute(start))
            return null;
        // the npm package is "gentle-pi" (same code as the gentle-shell repo); never trust an unrelated package.json
        const pkg = findPackageJson(start, "gentle-pi");
        return typeof pkg?.json?.version === "string" ? pkg.json.version : null;
    }
    catch {
        return null;
    }
}
let cachedPiVersion = null;
export function detectPiVersion() {
    if (cachedPiVersion)
        return cachedPiVersion;
    try {
        const req = createRequire(import.meta.url);
        const main = req.resolve("@earendil-works/pi-coding-agent");
        const pkg = findPackageJson(main, "@earendil-works/pi-coding-agent");
        if (typeof pkg?.json?.version === "string") {
            const v = pkg.json.version;
            cachedPiVersion = v;
            return v;
        }
    }
    catch {
        /* fall through */
    }
    return process.env.PI_VERSION || "unknown";
}
/** The UI object is shared by all extensions (runner.ts:572-591); patching it in place is not public API (R1). */
export function getSharedUi(ctx) {
    return ctx.ui;
}
/** Verify the wrapper really took effect on the shared object. */
export function mirrorTookEffect(ctx, wrapper) {
    return ctx.ui?.select === wrapper;
}
/** Process stdin used by the TUI of the same process (pi-tui/src/terminal.ts). */
export function terminalStdin() {
    return process.stdin && typeof process.stdin.emit === "function" ? process.stdin : null;
}
export function readEditorText(ctx) {
    try {
        return ctx.ui.getEditorText();
    }
    catch {
        return "";
    }
}
export function writeEditorText(ctx, text) {
    try {
        ctx.ui.setEditorText(text);
    }
    catch {
        /* ignore */
    }
}
/** Resolve the active theme name from argv, environment, or settings.json (Pi / gentle-shell). */
export function detectActiveTheme(opts = {}) {
    const argv = opts.argv ?? process.argv;
    const env = opts.env ?? process.env;
    const home = opts.home ?? os.homedir();
    // 1. Explicit CLI argument --use-theme <name>
    if (Array.isArray(argv)) {
        const idx = argv.indexOf("--use-theme");
        if (idx >= 0 && idx + 1 < argv.length && typeof argv[idx + 1] === "string") {
            const val = argv[idx + 1].trim();
            if (val)
                return val;
        }
    }
    // 2. Explicit environment variable PI_THEME
    if (typeof env.PI_THEME === "string" && env.PI_THEME.trim()) {
        return env.PI_THEME.trim();
    }
    // 3. Settings files in candidate directories
    const candidates = [
        env.PI_CODING_AGENT_DIR && path.join(env.PI_CODING_AGENT_DIR, "settings.json"),
        env.GENTLE_SHELL_USER_PI_HOME && path.join(env.GENTLE_SHELL_USER_PI_HOME, "settings.json"),
        path.join(home, ".pi", "agent", "settings.json"),
        path.join(home, ".gentle-shell", "agent", "settings.json"),
        path.join(home, ".config", "pi", "settings.json"),
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) {
                const raw = fs.readFileSync(c, "utf8");
                const json = JSON.parse(raw);
                if (typeof json?.theme === "string" && json.theme.trim()) {
                    return json.theme.trim();
                }
            }
        }
        catch {
            /* ignore invalid JSON / ENOENT */
        }
    }
    return null;
}
