import fs from "node:fs";
import path from "node:path";
import { expandHome, hostConfigPath } from "../shared/platform.js";
export const DEFAULT_HOST_CONFIG = {
    roots: ["~/proyectos"],
    backend: "auto",
    launchers: { "gentle-shell": "gentle-shell", pi: "pi", agy: "agy", claude: "claude", codex: "codex" },
    defaultLauncher: "gentle-shell",
    herdrSession: null,
    quotaEnabled: true,
    quotaCommand: "piquota --json",
    quotaIntervalSec: 300,
};
const BACKENDS = ["auto", "herdr", "tmux", "wt", "console"];
export function normalizeHostConfig(raw, home) {
    const r = raw && typeof raw === "object" ? raw : {};
    const d = DEFAULT_HOST_CONFIG;
    const launchersIn = r.launchers && typeof r.launchers === "object" ? r.launchers : d.launchers;
    const launchers = {};
    for (const [k, v] of Object.entries(launchersIn))
        if (typeof v === "string" && v.trim())
            launchers[k] = v.trim();
    if (!Object.keys(launchers).length)
        Object.assign(launchers, d.launchers);
    const defaultLauncher = typeof r.defaultLauncher === "string" && launchers[r.defaultLauncher] ? r.defaultLauncher : (launchers[d.defaultLauncher] ? d.defaultLauncher : Object.keys(launchers)[0]);
    const rootsIn = Array.isArray(r.roots) && r.roots.every((x) => typeof x === "string") && r.roots.length ? r.roots : d.roots;
    const quotaEnabled = typeof r.quotaEnabled === "boolean" ? r.quotaEnabled : d.quotaEnabled;
    const quotaCommand = typeof r.quotaCommand === "string" && r.quotaCommand.trim() ? r.quotaCommand.trim() : d.quotaCommand;
    const quotaIntervalSec = typeof r.quotaIntervalSec === "number" && Number.isFinite(r.quotaIntervalSec) ? Math.max(0, Math.floor(r.quotaIntervalSec)) : d.quotaIntervalSec;
    return {
        roots: rootsIn.map((p) => path.resolve(expandHome(p, home))),
        backend: BACKENDS.includes(r.backend) ? r.backend : d.backend,
        launchers,
        defaultLauncher,
        herdrSession: typeof r.herdrSession === "string" && r.herdrSession ? r.herdrSession : null,
        quotaEnabled,
        quotaCommand,
        quotaIntervalSec,
    };
}
/** Usual project folders, most specific first; the default `~/proyectos` is only a guess. */
const COMMON_ROOTS = ["~/proyectos", "~/Projects", "~/projects", "~/dev", "~/code", "~/src", "~/workspace", "~/repos", "~/Developer"];
/**
 * When the roots are still the shipped default and that folder does not exist, use every usual
 * project folder that does (deduplicated by real path, so `~/Projects` and `~/projects` on a
 * case-insensitive disk count once). Roots the user chose explicitly are never replaced.
 */
export function withDetectedRoots(cfg, home) {
    const isDefault = cfg.roots.length === DEFAULT_HOST_CONFIG.roots.length && cfg.roots.every((r, i) => r === path.resolve(expandHome(DEFAULT_HOST_CONFIG.roots[i], home)));
    if (!isDefault || cfg.roots.some((r) => fs.existsSync(r)))
        return cfg;
    const found = new Map();
    for (const c of COMMON_ROOTS) {
        const dir = path.resolve(expandHome(c, home));
        try {
            if (fs.statSync(dir).isDirectory()) {
                const real = fs.realpathSync.native(dir); // native: also folds case on case-insensitive disks
                if (!found.has(real))
                    found.set(real, dir);
            }
        }
        catch { }
    }
    return found.size ? { ...cfg, roots: [...found.values()] } : cfg;
}
/** Human hint when no configured root exists on disk (the phone's folder picker would be empty). */
export const NO_ROOTS_HINT = "no project folder found: run `rp-host roots add <path>` on the PC";
export function missingRoots(cfg) {
    return !cfg.roots.some((r) => fs.existsSync(r));
}
function readRawHostConfig(p) {
    try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }
    catch {
        return {};
    }
}
function writeRawHostConfig(p, raw) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(p, 0o600);
}
/** Roots written in the file, minus the untouched default when it is missing on disk (it is only a guess). */
function explicitRoots(raw, home) {
    const roots = Array.isArray(raw.roots) && raw.roots.every((x) => typeof x === "string") ? raw.roots : [];
    const dflt = DEFAULT_HOST_CONFIG.roots.map((r) => path.resolve(expandHome(r, home)));
    const isDefault = roots.length === dflt.length && roots.every((r, i) => path.resolve(expandHome(r, home)) === dflt[i]);
    return isDefault && !dflt.some((d) => fs.existsSync(d)) ? [] : roots;
}
/** Adds an existing directory to `roots` in host.json, keeping every other setting. Returns the resulting roots. */
export function addRoot(p, dir, home) {
    const abs = path.resolve(expandHome(dir, home));
    let st;
    try {
        st = fs.statSync(abs);
    }
    catch {
        throw new Error(`not found: ${abs}`);
    }
    if (!st.isDirectory())
        throw new Error(`not a directory: ${abs}`);
    if (abs === path.parse(abs).root)
        throw new Error("refusing to use the filesystem root as a project folder");
    const raw = readRawHostConfig(p);
    const real = fs.realpathSync.native(abs);
    const roots = explicitRoots(raw, home);
    if (!roots.some((r) => { try {
        return fs.realpathSync.native(path.resolve(expandHome(r, home))) === real;
    }
    catch {
        return false;
    } }))
        roots.push(abs);
    writeRawHostConfig(p, { ...raw, roots });
    return roots.map((r) => path.resolve(expandHome(r, home)));
}
/** Removes a root from host.json. Returns the resulting roots (empty means "back to autodetect/default"). */
export function removeRoot(p, dir, home) {
    const abs = path.resolve(expandHome(dir, home));
    const raw = readRawHostConfig(p);
    const roots = explicitRoots(raw, home).filter((r) => path.resolve(expandHome(r, home)) !== abs);
    const { roots: _old, ...rest } = raw;
    writeRawHostConfig(p, roots.length ? { ...rest, roots } : { roots: DEFAULT_HOST_CONFIG.roots, ...rest });
    return roots.map((r) => path.resolve(expandHome(r, home)));
}
export function loadHostConfig(env = process.env) {
    const p = hostConfigPath(env);
    try {
        return { cfg: withDetectedRoots(normalizeHostConfig(JSON.parse(fs.readFileSync(p, "utf8")))), path: p, exists: true };
    }
    catch {
        return { cfg: withDetectedRoots(normalizeHostConfig({})), path: p, exists: false };
    }
}
export function writeDefaultHostConfig(p) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const body = {
        roots: DEFAULT_HOST_CONFIG.roots,
        backend: "auto",
        launchers: DEFAULT_HOST_CONFIG.launchers,
        defaultLauncher: DEFAULT_HOST_CONFIG.defaultLauncher,
        herdrSession: null,
        quotaEnabled: DEFAULT_HOST_CONFIG.quotaEnabled,
        quotaCommand: DEFAULT_HOST_CONFIG.quotaCommand,
        quotaIntervalSec: DEFAULT_HOST_CONFIG.quotaIntervalSec,
    };
    fs.writeFileSync(p, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}
