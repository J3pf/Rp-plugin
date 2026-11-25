// Herdr pane discovery, status mapping, panel sorting, and terminal output extraction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LruMap, SAFE_CONV_ID_RE } from "../../shared/util.js";
import { parseJson, pick } from "../backends/herdr.js";
const CONV_RE = /--conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function mapHerdrAgentStatus(rawStatus) {
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
export function herdrPriorityStatusRank(item) {
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
const panelSortModeCache = new LruMap(32);
export function readHerdrPanelSortMode(env = process.env) {
    const cfgPath = env.HERDR_CONFIG_PATH || path.join(os.homedir(), ".config", "herdr", "config.toml");
    try {
        const st = fs.statSync(cfgPath, { throwIfNoEntry: false });
        if (!st || !st.isFile()) {
            panelSortModeCache.delete(cfgPath);
            return "priority";
        }
        const cached = panelSortModeCache.get(cfgPath);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            return cached.mode;
        }
        const text = fs.readFileSync(cfgPath, "utf8");
        const m = /^\s*agent_panel_sort\s*=\s*["']?(priority|spaces|workspaces)["']?/m.exec(text);
        const mode = m?.[1] === "spaces" || m?.[1] === "workspaces" ? "spaces" : "priority";
        panelSortModeCache.set(cfgPath, { mtimeMs: st.mtimeMs, size: st.size, mode });
        return mode;
    }
    catch {
        /* ignore missing config */
    }
    return "priority";
}
export function sortHerdrAgentsForDisplay(agents, mode) {
    if (mode === "spaces")
        return [...agents];
    return agents
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
        const rankDiff = herdrPriorityStatusRank(b.item) - herdrPriorityStatusRank(a.item);
        if (rankDiff !== 0)
            return rankDiff;
        const seqDiff = (b.item.stateChangeSeq ?? 0) - (a.item.stateChangeSeq ?? 0);
        if (seqDiff !== 0)
            return seqDiff;
        return a.index - b.index;
    })
        .map((entry) => entry.item);
}
export function extractRecentCommandOutput(terminalText, commandText) {
    if (!commandText)
        return terminalText;
    const cmd = commandText.trim();
    const idx = terminalText.lastIndexOf(cmd);
    if (idx >= 0) {
        const lineStart = terminalText.lastIndexOf("\n", idx);
        const sliceStart = lineStart >= 0 ? lineStart + 1 : idx;
        const snippet = terminalText.slice(sliceStart).trim();
        if (snippet)
            return snippet;
    }
    return terminalText;
}
export function parseHerdrAgentList(stdout) {
    const json = parseJson(stdout);
    const list = Array.isArray(json?.result?.agents)
        ? json.result.agents
        : Array.isArray(json?.agents)
            ? json.agents
            : [];
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== "object")
            continue;
        const agent = pick(item, ["agent", "kind"]);
        // Pi and gentle-shell sessions already connect via their native in-process Rp-plugin extension
        if (!agent || agent === "pi" || agent === "gentle-shell")
            continue;
        const paneId = pick(item, ["pane_id", "paneId"]);
        if (!paneId || paneId.startsWith("-"))
            continue;
        const title = pick(item, ["terminal_title_stripped", "terminal_title", "title"]);
        let sessionId = pick(item, ["agent_session.value", "session_id"]);
        if (!sessionId && title) {
            const m = CONV_RE.exec(title);
            if (m)
                sessionId = m[1];
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
