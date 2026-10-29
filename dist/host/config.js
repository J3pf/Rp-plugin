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
export function loadHostConfig(env = process.env) {
    const p = hostConfigPath(env);
    try {
        return { cfg: normalizeHostConfig(JSON.parse(fs.readFileSync(p, "utf8"))), path: p, exists: true };
    }
    catch {
        return { cfg: normalizeHostConfig({}), path: p, exists: false };
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
