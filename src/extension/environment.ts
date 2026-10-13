import path from "node:path";

export type Launcher = "pi" | "gentle-shell";

export interface HerdrLocation {
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  session: string | null;
}

export interface StaticEnv {
  isGentleChild: boolean;
  launcher: Launcher;
  herdr: HerdrLocation | null;
  spawnId: string | null;
  platform: NodeJS.Platform;
}

/** Everything detectable from the process environment alone (no Pi API needed). */
export function detectStaticEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): StaticEnv {
  const agentDir = env.PI_CODING_AGENT_DIR ?? "";
  const normalized = agentDir.replace(/\\/g, "/");
  const viaGentleShell =
    !!env.GENTLE_SHELL_USER_PI_HOME || /(^|\/)\.gentle-shell\/agent\/?$/.test(normalized) || path.basename(path.dirname(normalized)) === ".gentle-shell";
  const inHerdr = env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
  return {
    isGentleChild: env.GENTLE_PI_AGENTS_CHILD === "1",
    launcher: viaGentleShell ? "gentle-shell" : "pi",
    herdr: inHerdr
      ? {
          paneId: env.HERDR_PANE_ID!,
          tabId: env.HERDR_TAB_ID ?? null,
          workspaceId: env.HERDR_WORKSPACE_ID ?? null,
          session: env.HERDR_SESSION ?? null,
        }
      : null,
    spawnId: env.RP_SPAWN_ID || null,
    platform,
  };
}

export type GentleModeName = "normal" | "auto" | "yolo" | "unknown";

/** Parse the footer status gentle-pi publishes: "Permissions: AUTO|NORMAL|YOLO" (COMPATIBILIDAD P5). */
export function parseGentleMode(text: string | undefined): GentleModeName {
  if (!text) return "unknown";
  const m = /permissions:\s*(auto|normal|yolo)/i.exec(text);
  return m ? (m[1]!.toLowerCase() as GentleModeName) : "unknown";
}

export const GENTLE_ASK_TOOLS = ["ask_user_choice", "ask_user_question"] as const;

export function isAskLikeTool(name: string): boolean {
  return /^ask_user/i.test(name) || /^question/i.test(name);
}
