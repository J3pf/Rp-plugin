import path from "node:path";
/** Everything detectable from the process environment alone (no Pi API needed). */
export function detectStaticEnv(env = process.env, platform = process.platform) {
    const agentDir = env.PI_CODING_AGENT_DIR ?? "";
    const normalized = agentDir.replace(/\\/g, "/");
    const viaGentleShell = !!env.GENTLE_SHELL_USER_PI_HOME || /(^|\/)\.gentle-shell\/agent\/?$/.test(normalized) || path.basename(path.dirname(normalized)) === ".gentle-shell";
    const inHerdr = env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
    return {
        isGentleChild: env.GENTLE_PI_AGENTS_CHILD === "1",
        launcher: viaGentleShell ? "gentle-shell" : "pi",
        herdr: inHerdr
            ? {
                paneId: env.HERDR_PANE_ID,
                tabId: env.HERDR_TAB_ID ?? null,
                workspaceId: env.HERDR_WORKSPACE_ID ?? null,
                session: env.HERDR_SESSION ?? null,
            }
            : null,
        spawnId: env.RP_SPAWN_ID || null,
        platform,
    };
}
/** Parse the footer status gentle-pi publishes: "Permissions: AUTO|NORMAL|YOLO" (COMPATIBILIDAD P5). */
export function parseGentleMode(text) {
    if (!text)
        return "unknown";
    const m = /permissions:\s*(auto|normal|yolo)/i.exec(text);
    return m ? m[1].toLowerCase() : "unknown";
}
export const GENTLE_ASK_TOOLS = ["ask_user_choice", "ask_user_question"];
export function isAskLikeTool(name) {
    return /^ask_user/i.test(name) || /^question/i.test(name);
}
