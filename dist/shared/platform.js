import os from "node:os";
import path from "node:path";
/** Directory holding RP state shared by every Pi home on this PC (decision D12). */
export function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
    if (platform === "win32") {
        const base = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
        return path.win32.join(base, "rp");
    }
    const base = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
    return path.posix.join(base, "rp");
}
export function configPath(env = process.env, platform = process.platform, home = os.homedir()) {
    if (env.RP_CONFIG)
        return env.RP_CONFIG;
    const p = platform === "win32" ? path.win32 : path.posix;
    return p.join(configDir(env, platform, home), "config.json");
}
export function hostConfigPath(env = process.env, platform = process.platform, home = os.homedir()) {
    const p = platform === "win32" ? path.win32 : path.posix;
    return p.join(configDir(env, platform, home), "host.json");
}
export function defaultInboxDir(env = process.env, platform = process.platform, home = os.homedir()) {
    if (platform === "win32") {
        const base = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
        return path.win32.join(base, "rp", "inbox");
    }
    return path.posix.join(configDir(env, platform, home), "inbox");
}
export function expandHome(p, home = os.homedir()) {
    if (p === "~")
        return home;
    if (p.startsWith("~/") || p.startsWith("~\\"))
        return path.join(home, p.slice(2));
    return p;
}
/** The two Pi homes that must declare the plugin: Pi's own and gentle-shell's isolated one (COMPATIBILIDAD G1). */
export function piHomes(env = process.env, home = os.homedir()) {
    return {
        pi: env.GENTLE_SHELL_USER_PI_HOME || path.join(home, ".pi", "agent"),
        gentleShell: path.join(home, ".gentle-shell", "agent"),
    };
}
