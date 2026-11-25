// Herdr pane discovery, status mapping, panel sorting, and terminal output extraction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentStatus } from "../../shared/protocol.ts";
import { SAFE_CONV_ID_RE } from "../../shared/util.ts";
import { parseJson, pick } from "../backends/herdr.ts";

export type HerdrPanelSortMode = "priority" | "spaces";

export interface HerdrDiscoveredAgent {
  agent: string;
  sessionId: string | null;
  status: AgentStatus;
  cwd: string;
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  title: string | null;
  stateChangeSeq: number;
  orderIndex?: number;
}

export type HerdrAgentItem = HerdrDiscoveredAgent;

const CONV_RE = /--conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function mapHerdrAgentStatus(rawStatus: string | null | undefined): AgentStatus {
  switch (rawStatus) {
    case "working":
      return "working";
    case "done":
      return "done";
    case "blocked":
      return "waiting_input";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export function herdrPriorityStatusRank(item: Pick<HerdrDiscoveredAgent, "status">): number {
  switch (item.status) {
    case "waiting_input":
      return 4;
    case "working":
      return 3;
    case "idle":
    case "done":
      return 2;
    default:
      return 1;
  }
}

export function readHerdrPanelSortMode(env: NodeJS.ProcessEnv = process.env): HerdrPanelSortMode {
  const cfgPath = env.HERDR_CONFIG_PATH || path.join(os.homedir(), ".config", "herdr", "config.toml");
  try {
    const text = fs.readFileSync(cfgPath, "utf8");
    const m = /^\s*agent_panel_sort\s*=\s*["']?(priority|spaces|workspaces)["']?/m.exec(text);
    if (m?.[1] === "spaces" || m?.[1] === "workspaces") return "spaces";
    if (m?.[1] === "priority") return "priority";
  } catch {
    /* ignore missing config */
  }
  return "priority";
}

export function sortHerdrAgentsForDisplay(
  agents: readonly HerdrDiscoveredAgent[],
  mode: HerdrPanelSortMode,
): HerdrDiscoveredAgent[] {
  if (mode === "spaces") return [...agents];
  return agents
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDiff = herdrPriorityStatusRank(b.item) - herdrPriorityStatusRank(a.item);
      if (rankDiff !== 0) return rankDiff;
      const seqDiff = (b.item.stateChangeSeq ?? 0) - (a.item.stateChangeSeq ?? 0);
      if (seqDiff !== 0) return seqDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function extractRecentCommandOutput(terminalText: string, commandText?: string): string {
  if (!commandText) return terminalText;
  const cmd = commandText.trim();
  const idx = terminalText.lastIndexOf(cmd);
  if (idx >= 0) {
    const lineStart = terminalText.lastIndexOf("\n", idx);
    const sliceStart = lineStart >= 0 ? lineStart + 1 : idx;
    const snippet = terminalText.slice(sliceStart).trim();
    if (snippet) return snippet;
  }
  return terminalText;
}

export function parseHerdrAgentList(stdout: string): HerdrDiscoveredAgent[] {
  const json = parseJson(stdout);
  const list: any[] = Array.isArray(json?.result?.agents)
    ? json.result.agents
    : Array.isArray(json?.agents)
      ? json.agents
      : [];
  const out: HerdrDiscoveredAgent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const agent = pick(item, ["agent", "kind"]);
    // Pi and gentle-shell sessions already connect via their native in-process Rp-plugin extension
    if (!agent || agent === "pi" || agent === "gentle-shell") continue;
    const paneId = pick(item, ["pane_id", "paneId"]);
    if (!paneId || paneId.startsWith("-")) continue;
    const title = pick(item, ["terminal_title_stripped", "terminal_title", "title"]);
    let sessionId = pick(item, ["agent_session.value", "session_id"]);
    if (!sessionId && title) {
      const m = CONV_RE.exec(title);
      if (m) sessionId = m[1]!;
    }
    if (sessionId && !SAFE_CONV_ID_RE.test(sessionId)) {
      sessionId = null;
    }
    const cwd = pick(item, ["foreground_cwd", "cwd"]) ?? process.cwd();
    const rawStatus = pick(item, ["agent_status", "status"]);
    out.push({
      agent,
      sessionId,
      status: mapHerdrAgentStatus(rawStatus),
      cwd,
      paneId,
      tabId: pick(item, ["tab_id", "tabId"]),
      workspaceId: pick(item, ["workspace_id", "workspaceId"]),
      title,
      stateChangeSeq: typeof item.state_change_seq === "number" ? item.state_change_seq : 0,
    });
  }
  return out;
}
