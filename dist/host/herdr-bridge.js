// Herdr + Antigravity CLI (agy) bridge for rp-host.
// Discovers non-Pi agents running in Herdr, bridges their transcripts/panes to Rp-relay,
// delivers prompts/aborts via Herdr CLI, and serves PreToolUse permission gating for agy.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Connection } from "../extension/connection.js";
import { resolveInboxDir } from "../extension/config.js";
import { relayBlobFetcher, resolveAttachments } from "../extension/attachments.js";
import { routeInbound, pendingAnswers } from "../extension/inbound.js";
import { Broker } from "../extension/prompts/broker.js";
import { Classifier, promptContext } from "../extension/prompts/classify.js";
import { ALLOW, ALLOW_SESSION, DENY, DENY_REASON, allowKey, compilePatterns, decide } from "../extension/prompts/gate.js";
import { pluginVersion } from "../extension/version.js";
import { parseJson, pick } from "./backends/herdr.js";
import { run as realRun } from "./runner.js";
import { AgyTranscriptReader, parseAgyArgs, resolveAgyTranscriptPath } from "./agy-transcript.js";
import { configDir } from "../shared/platform.js";
import { newId, } from "../shared/protocol.js";
import { LruSet, errMsg, safeUser, truncateBytes } from "../shared/util.js";
const CONV_RE = /--conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function mapHerdrAgentStatus(rawStatus) {
    switch (rawStatus) {
        case "working":
            return "working";
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
            return 2;
        default:
            return 1;
    }
}
export function readHerdrPanelSortMode(env = process.env) {
    const cfgPath = env.HERDR_CONFIG_PATH || path.join(os.homedir(), ".config", "herdr", "config.toml");
    try {
        const text = fs.readFileSync(cfgPath, "utf8");
        const m = /^\s*agent_panel_sort\s*=\s*["']?(priority|spaces|workspaces)["']?/m.exec(text);
        if (m?.[1] === "spaces" || m?.[1] === "workspaces")
            return "spaces";
        if (m?.[1] === "priority")
            return "priority";
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
        if (sessionId && !/^[0-9a-zA-Z_][0-9a-zA-Z_-]{0,127}$/.test(sessionId)) {
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
function sanitizeIdPart(raw) {
    return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}
export function gateSocketPath(env = process.env, platform = process.platform) {
    if (platform === "win32") {
        const user = sanitizeIdPart(safeUser());
        return `\\\\.\\pipe\\rp-agy-gate-${user}`;
    }
    return path.join(configDir(env, platform), "agy-gate.sock");
}
export class BridgedAgentSession {
    info;
    d;
    instance = newId();
    epoch = newId();
    sessionKey;
    agentId;
    allowed = new LruSet(1000);
    broker;
    conn;
    seq = 0;
    disposed = false;
    git = null;
    transcriptReader = null;
    lastTerminalSnapshot = "";
    lastTerminalSnapshotTs = 0;
    initialFallbackDone = false;
    initialSnapshotSent = false;
    lastStateSeq = -1;
    startTimer = null;
    pollTimer = null;
    watcher = null;
    watchDebounce = null;
    lastSentName = "";
    currentStatus;
    optimisticWorkingUntilMs = 0;
    fallbackTurnTs = 0;
    commandTimer = null;
    closeTimer = null;
    reconnectDebounce = null;
    constructor(info, d, transcriptOverride) {
        this.info = info;
        this.d = d;
        const rawKey = info.sessionId || `pane-${info.paneId}`;
        this.sessionKey = sanitizeIdPart(rawKey);
        this.agentId = `${d.machineId}:herdr:${this.sessionKey}`;
        this.currentStatus = info.status;
        if (info.agent === "agy" && info.sessionId) {
            try {
                const canonical = resolveAgyTranscriptPath(info.sessionId);
                const tPath = transcriptOverride && path.resolve(transcriptOverride) === canonical ? canonical : canonical;
                this.transcriptReader = new AgyTranscriptReader(tPath, () => this.d.cfg.redactContent);
            }
            catch {
                this.transcriptReader = null;
            }
        }
        this.broker = new Broker({
            agentId: this.agentId,
            send: (t, body) => this.conn.send(t, body),
            hasUI: false,
            classifier: new Classifier(),
            herdr: null,
            onChange: () => this.syncStatus(),
        });
        const makeConn = d.connectionFactory ?? ((o) => new Connection(o));
        this.conn = makeConn({
            relayUrl: d.relayUrl,
            token: d.token,
            agentId: this.agentId,
            instance: this.instance,
            makeHello: () => this.makeHello(),
            onWelcome: (w) => this.onWelcome(w),
            onMessage: (env) => this.onRelayMessage(env),
            onLog: (m) => d.onLog?.(`[${this.info.agent}:${this.info.paneId}] ${m}`),
        });
        void this.refreshGit();
        if (d.startDelayMs && d.startDelayMs > 0) {
            this.startTimer = setTimeout(() => {
                this.startTimer = null;
                if (!this.disposed)
                    this.conn.start();
            }, d.startDelayMs);
            this.startTimer.unref?.();
        }
        else {
            this.conn.start();
        }
        this.startTranscriptPolling();
    }
    get conversationId() {
        return this.info.sessionId;
    }
    get paneId() {
        return this.info.paneId;
    }
    get discoveredInfo() {
        return { ...this.info };
    }
    encodedTabId() {
        const idx = this.info.orderIndex;
        if (typeof idx === "number" && Number.isFinite(idx) && idx > 0) {
            return `#${String(Math.floor(idx)).padStart(4, "0")}|${this.info.tabId ?? ""}`;
        }
        return this.info.tabId;
    }
    sessionDisplayName() {
        if (this.d.cfg.redactContent)
            return "[redacted]";
        const base = path.basename(this.info.cwd || "") || this.info.paneId;
        const topic = this.transcriptReader?.getSessionTopic();
        if (topic)
            return `${base} · ${topic}`;
        return `${base} (${this.info.agent})`;
    }
    syncSessionNameIfChanged() {
        const nextName = this.sessionDisplayName();
        if (nextName && nextName !== this.lastSentName) {
            this.lastSentName = nextName;
            this.sendEvent({ type: "session_info_changed", name: nextName });
        }
    }
    effectiveStatus() {
        if (this.broker.openCount > 0)
            return "waiting_input";
        if (this.currentStatus === "idle" && Date.now() < this.optimisticWorkingUntilMs) {
            return "working";
        }
        return this.currentStatus;
    }
    syncStatus() {
        if (this.disposed)
            return;
        this.conn.send("agent.status", { status: this.effectiveStatus() });
        this.scheduleNextPoll();
    }
    updateFromHerdr(next) {
        const prevCwd = this.info.cwd;
        const prevStatus = this.effectiveStatus();
        const prevWorkspace = this.info.workspaceId;
        const prevPane = this.info.paneId;
        const seqChanged = next.stateChangeSeq !== this.lastStateSeq;
        this.lastStateSeq = next.stateChangeSeq;
        if (!this.info.sessionId && next.sessionId && next.agent === "agy") {
            try {
                const tPath = resolveAgyTranscriptPath(next.sessionId);
                this.info.sessionId = next.sessionId;
                this.transcriptReader = new AgyTranscriptReader(tPath, () => this.d.cfg.redactContent);
                this.setupFileWatcher();
            }
            catch {
                /* ignore invalid sessionId */
            }
        }
        if (next.status !== "idle") {
            this.optimisticWorkingUntilMs = 0;
        }
        this.info = { ...this.info, ...next };
        this.currentStatus = next.status;
        if (this.conn.connected &&
            (this.info.workspaceId !== prevWorkspace || this.info.paneId !== prevPane)) {
            if (this.reconnectDebounce)
                clearTimeout(this.reconnectDebounce);
            this.reconnectDebounce = setTimeout(() => {
                this.reconnectDebounce = null;
                if (!this.disposed)
                    this.conn.reconnectNow();
            }, 250);
            this.reconnectDebounce.unref?.();
        }
        if (prevCwd !== next.cwd) {
            void this.refreshGit();
        }
        if (this.effectiveStatus() !== prevStatus) {
            this.syncStatus();
            if (this.effectiveStatus() === "working") {
                this.sendEvent({ type: "agent_start" });
            }
            else if (prevStatus === "working" && this.effectiveStatus() === "idle") {
                void this.pollTranscriptNow();
                this.sendEvent({ type: "agent_settled", aborted: false });
            }
        }
        else if (seqChanged) {
            void this.pollTranscriptNow();
        }
    }
    makeHello() {
        const subagents = this.transcriptReader?.getSubagents() ?? [];
        const name = this.sessionDisplayName();
        this.lastSentName = name;
        return {
            agentId: this.agentId,
            kind: this.info.agent,
            instance: this.instance,
            epoch: this.epoch,
            pi: { version: this.info.agent, mode: "tui" },
            plugin: { version: pluginVersion(), features: ["attachments", "statuses", "deliver_herdr", "gate"] },
            session: {
                id: this.sessionKey,
                file: this.transcriptReader?.transcriptPath ?? null,
                name,
            },
            host: { hostname: os.hostname(), user: safeUser(), pid: process.pid, os: process.platform },
            launcher: this.info.agent,
            herdr: {
                paneId: this.info.paneId,
                tabId: this.encodedTabId(),
                workspaceId: this.info.workspaceId,
                session: this.d.herdrSession,
            },
            gentle: null,
            transport: this.conn?.transportName ?? "ws",
            redacted: this.d.cfg.redactContent,
            cwd: this.info.cwd,
            spawnId: null,
            git: this.git ?? { branch: null, dirty: false },
            model: this.info.agent === "agy" ? { provider: "google", id: "antigravity" } : { provider: this.info.agent, id: "default" },
            thinking: null,
            status: this.effectiveStatus(),
            openPrompts: this.broker.openPrompts(),
            todos: null,
            ...(subagents.length > 0 ? { subagents } : {}),
        };
    }
    onWelcome(w) {
        const canSkipSnapshot = this.initialSnapshotSent &&
            !this.conn.needsSnapshot &&
            typeof w.lastSeq === "number" &&
            w.lastSeq >= 0;
        if (!canSkipSnapshot) {
            this.sendSnapshot(true);
        }
        this.conn.sendDirect("agent.status", { status: this.effectiveStatus() });
        this.conn.needsSnapshot = false;
        for (const p of pendingAnswers(w))
            this.broker.handleAnswer(p.promptId, p.answer);
    }
    sendSnapshot(direct) {
        this.initialSnapshotSent = true;
        if (this.transcriptReader) {
            const { entries, truncated, events } = this.transcriptReader.readSnapshot();
            const lastActivityAt = this.transcriptReader.getLastActivityAt();
            const body = {
                epoch: this.epoch,
                seq: this.seq,
                entries,
                truncated,
                ...(lastActivityAt ? { lastActivityAt } : {}),
            };
            if (direct) {
                if (this.conn.needsSnapshot) {
                    this.conn.dropQueuedEventsUpTo(this.seq);
                }
                const minQueued = this.conn.minQueuedEventSeq();
                const snapSeq = minQueued !== null ? Math.max(0, minQueued - 1) : this.seq;
                this.conn.sendDirect("agent.snapshot", { ...body, seq: snapSeq });
                for (const ev of events) {
                    if (ev.type === "subagent_update")
                        this.sendEvent(ev);
                }
            }
            else {
                this.conn.send("agent.snapshot", body);
                for (const ev of events) {
                    this.sendEvent(ev);
                }
            }
            this.syncSessionNameIfChanged();
            return;
        }
        const entryAt = this.lastTerminalSnapshotTs || null;
        const body = {
            epoch: this.epoch,
            seq: this.seq,
            entries: !this.d.cfg.redactContent && this.lastTerminalSnapshot && entryAt
                ? [
                    {
                        eid: "pane:latest",
                        kind: "assistant",
                        at: entryAt,
                        msg: {
                            role: "assistant",
                            timestamp: entryAt,
                            content: [{ type: "text", text: "```text\n" + this.lastTerminalSnapshot + "\n```" }],
                        },
                    },
                ]
                : [],
            truncated: false,
            ...(entryAt ? { lastActivityAt: entryAt } : {}),
        };
        if (direct) {
            if (this.conn.needsSnapshot) {
                this.conn.dropQueuedEventsUpTo(this.seq);
            }
            const minQueued = this.conn.minQueuedEventSeq();
            const snapSeq = minQueued !== null ? Math.max(0, minQueued - 1) : this.seq;
            this.conn.sendDirect("agent.snapshot", { ...body, seq: snapSeq });
        }
        else {
            this.conn.send("agent.snapshot", body);
        }
    }
    sendEvent(e) {
        if (this.disposed)
            return;
        this.seq += 1;
        this.conn.send("agent.event", { epoch: this.epoch, seq: this.seq, e });
    }
    setupFileWatcher() {
        if (this.watcher || !this.transcriptReader)
            return;
        const dir = path.dirname(this.transcriptReader.transcriptPath);
        if (!fs.existsSync(dir))
            return;
        try {
            this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (this.disposed)
                    return;
                if (filename && filename !== "transcript.jsonl")
                    return;
                if (this.watchDebounce)
                    return;
                this.watchDebounce = setTimeout(() => {
                    this.watchDebounce = null;
                    void this.pollTranscriptNow();
                }, 150);
                this.watchDebounce.unref?.();
            });
            this.watcher.on("error", () => {
                try {
                    this.watcher?.close();
                }
                catch {
                    /* ignore */
                }
                this.watcher = null;
            });
        }
        catch {
            /* fallback to timer */
        }
    }
    scheduleNextPoll() {
        if (this.disposed)
            return;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        const isWorking = this.effectiveStatus() === "working";
        const delayMs = isWorking ? 900 : this.watcher ? 15_000 : 4_500;
        this.pollTimer = setTimeout(() => {
            void this.pollTranscriptNow();
            this.scheduleNextPoll();
        }, delayMs);
        this.pollTimer.unref?.();
    }
    startTranscriptPolling() {
        this.setupFileWatcher();
        this.scheduleNextPoll();
    }
    async pollTranscriptNow() {
        if (this.disposed)
            return;
        try {
            if (this.transcriptReader) {
                if (!this.watcher)
                    this.setupFileWatcher();
                const events = this.transcriptReader.pollNewEvents();
                for (const ev of events) {
                    this.sendEvent(ev);
                }
                if (events.length > 0)
                    this.syncSessionNameIfChanged();
                return;
            }
            await this.pollPaneFallback();
        }
        catch (e) {
            this.d.onLog?.(`poll transcript error: ${errMsg(e)}`);
        }
    }
    async pollPaneFallback(commandText) {
        if (this.disposed || !this.info.paneId || this.d.cfg.redactContent)
            return;
        if (this.initialFallbackDone && !commandText && this.effectiveStatus() !== "working")
            return;
        try {
            const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
                timeoutMs: 3_000,
                env: this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {},
            });
            if (res.code !== 0)
                return;
            const parsed = parseJson(res.stdout);
            const rawText = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
            const text = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
            if (!text)
                return;
            const snippet = extractRecentCommandOutput(text, commandText);
            if (snippet === this.lastTerminalSnapshot)
                return;
            this.lastTerminalSnapshot = truncateBytes(snippet, 16 * 1024).text;
            if (!this.initialFallbackDone) {
                this.initialFallbackDone = true;
                return;
            }
            this.lastTerminalSnapshotTs = Date.now();
            if (!this.fallbackTurnTs) {
                this.fallbackTurnTs = this.lastTerminalSnapshotTs;
            }
            if (commandText) {
                this.sendEvent({
                    type: "message_end",
                    message: {
                        role: "user",
                        timestamp: this.fallbackTurnTs,
                        content: [{ type: "text", text: commandText }],
                    },
                });
            }
            this.sendEvent({
                type: "message_end",
                message: {
                    role: "assistant",
                    timestamp: this.fallbackTurnTs,
                    content: [{ type: "text", text: "```text\n" + this.lastTerminalSnapshot + "\n```" }],
                },
            });
        }
        catch {
            /* ignore */
        }
    }
    async handleTermCommand(rawCommand, env) {
        if (this.disposed || !this.info.paneId || this.d.cfg.redactContent)
            return;
        const arg = rawCommand.slice(5).trim().toLowerCase();
        try {
            if (arg) {
                if (arg === "enter") {
                    await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 3_000, env });
                }
                else if (arg === "esc" || arg === "escape") {
                    await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Escape"], { timeoutMs: 3_000, env });
                }
                else if (arg === "ctrl+c" || arg === "c-c") {
                    await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "C-c"], { timeoutMs: 3_000, env });
                }
                else if (arg === "tab") {
                    await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Tab"], { timeoutMs: 3_000, env });
                }
                else if (arg === "y" || arg === "n") {
                    await this.d.runner("herdr", ["pane", "send-text", this.info.paneId, arg], { timeoutMs: 3_000, env });
                    await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 3_000, env });
                }
                await new Promise((r) => setTimeout(r, 250));
            }
            const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
                timeoutMs: 3_000,
                env,
            });
            if (this.disposed)
                return;
            const now = Date.now();
            this.sendEvent({
                type: "message_end",
                message: {
                    role: "user",
                    timestamp: now,
                    content: [{ type: "text", text: rawCommand }],
                },
            });
            if (res.code === 0) {
                const parsed = parseJson(res.stdout);
                const rawText = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
                const cleaned = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
                const lines = cleaned
                    .split(/\r?\n/)
                    .map((l) => l.trimEnd())
                    .filter((l, idx, arr) => l.length > 0 || (idx > 0 && arr[idx - 1].length > 0));
                const snippet = truncateBytes(lines.slice(-45).join("\n") || "(terminal vacía)", 16 * 1024).text;
                this.sendEvent({
                    type: "message_end",
                    message: {
                        role: "assistant",
                        timestamp: now,
                        content: [{ type: "text", text: "```text\n" + snippet + "\n```" }],
                    },
                });
            }
            if (this.currentStatus === "idle") {
                this.optimisticWorkingUntilMs = 0;
                this.syncStatus();
                this.sendEvent({ type: "agent_settled", aborted: false });
            }
        }
        catch {
            /* ignore */
        }
    }
    onRelayMessage(env) {
        routeInbound(env, {
            userMessage: (b) => void this.handleUserMessage(b),
            abort: () => void this.handleAbort(),
            promptAnswer: (id, answer) => void this.broker.handleAnswer(id, answer),
            promptCancel: (id) => this.broker.handleCancel(id),
            resync: () => this.sendSnapshot(false),
            error: (code, message) => this.d.onLog?.(`[${this.agentId}] relay error ${code}: ${message}`),
        });
    }
    async handleUserMessage(b) {
        const ack = (status, error = null) => this.conn.send("user.message.ack", {
            clientMsgId: b.clientMsgId,
            disposition: status === "delivered" ? (b.asCommand ? "command" : "typed") : "rejected",
            ...(status === "delivered" ? { method: "herdr" } : {}),
            ...(error ? { error } : {}),
        });
        let text = b.text ?? "";
        if (b.attachments?.length) {
            const att = await resolveAttachments(b.attachments, {
                inboxDir: resolveInboxDir(this.d.cfg),
                fetchBlob: relayBlobFetcher(this.d.relayUrl, this.d.token),
                sessionId: this.sessionKey,
                inlineImages: false,
            });
            if (att.lines.length)
                text = (text ? text + "\n\n" : "") + att.lines.join("\n");
        }
        text = text.trim();
        if (!text)
            return ack("rejected", "herdr_unavailable");
        this.fallbackTurnTs = 0;
        this.lastTerminalSnapshot = "";
        this.lastTerminalSnapshotTs = Date.now();
        this.initialFallbackDone = true;
        const markWorkingOnDelivery = () => {
            this.optimisticWorkingUntilMs = Date.now() + 8_000;
            this.syncStatus();
            this.sendEvent({ type: "agent_start" });
            void this.pollTranscriptNow();
        };
        const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
        if (b.asCommand && (text === "/quit" || text === "/exit")) {
            ack("delivered");
            if (this.info.paneId) {
                try {
                    await this.d.runner("herdr", ["pane", "close", this.info.paneId], { timeoutMs: 5_000, env });
                }
                catch {
                    /* ignore */
                }
            }
            this.closeFromHerdr("pane_closed");
            this.d.onSessionClosedByCommand?.(this.sessionKey, this.info.paneId);
            return;
        }
        if (b.asCommand && (text.toLowerCase() === "/term" || text.toLowerCase().startsWith("/term "))) {
            if (!this.info.paneId || this.d.cfg.redactContent) {
                return ack("rejected", "herdr_unavailable");
            }
            ack("delivered");
            await this.handleTermCommand(text, env);
            return;
        }
        const textArgs = text.startsWith("-") ? ["--", text] : [text];
        try {
            if (!b.asCommand) {
                const res = await this.d.runner("herdr", ["agent", "prompt", this.info.paneId, ...textArgs], { timeoutMs: 10_000, env });
                if (res.code === 0) {
                    markWorkingOnDelivery();
                    return ack("delivered");
                }
                if (/agent_blocked|blocked/i.test(`${res.stderr} ${res.stdout}`) || this.currentStatus === "waiting_input") {
                    return ack("rejected", "agent_blocked");
                }
            }
            // Fallback (or slash command): send literal text + Enter directly to the Herdr pane
            const sendRes = await this.d.runner("herdr", ["pane", "send-text", this.info.paneId, ...textArgs], { timeoutMs: 5_000, env });
            if (sendRes.code !== 0)
                return ack("rejected", "herdr_unavailable");
            await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 5_000, env });
            markWorkingOnDelivery();
            ack("delivered");
            if (b.asCommand) {
                // Local TUI commands (e.g. /usage, /statusline, /help) execute directly in the CLI terminal
                // without creating entries in transcript.jsonl. If no transcript events arrive within 800ms,
                // read the output directly from the pane and settle so the mobile chat displays the result.
                if (this.commandTimer)
                    clearTimeout(this.commandTimer);
                this.commandTimer = setTimeout(async () => {
                    this.commandTimer = null;
                    if (this.disposed)
                        return;
                    if (this.transcriptReader) {
                        const events = this.transcriptReader.pollNewEvents();
                        if (events.length > 0) {
                            for (const ev of events)
                                this.sendEvent(ev);
                            this.syncSessionNameIfChanged();
                            return;
                        }
                    }
                    await this.pollPaneFallback(text);
                    if (this.currentStatus === "idle") {
                        this.optimisticWorkingUntilMs = 0;
                        this.syncStatus();
                        this.sendEvent({ type: "agent_settled", aborted: false });
                    }
                }, 800);
                this.commandTimer.unref?.();
            }
            return;
        }
        catch {
            return ack("rejected", "herdr_unavailable");
        }
    }
    async handleAbort() {
        if (!this.info.paneId)
            return;
        const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
        try {
            await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Escape"], { timeoutMs: 3_000, env });
            await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "C-c"], { timeoutMs: 3_000, env });
        }
        catch {
            /* ignore */
        }
    }
    /** Ask the mobile phone to approve/deny a PreToolUse tool execution in agy. */
    async requestGateApproval(req) {
        if (this.disposed)
            return { decision: "ask", reason: "RP: sesión cerrada; confirmar en terminal" };
        if (this.allowed.has(req.key))
            return { decision: "allow" };
        if (!this.conn.connected && !(await this.conn.whenConnected(this.d.cfg.gate.approverWaitMs))) {
            return { decision: "ask", reason: "RP: sin conexión al relay; confirmar en terminal" };
        }
        const displayCmd = this.d.cfg.redactContent ? "[redacted]" : req.command;
        const summary = displayCmd.length > 120 ? displayCmd.slice(0, 119) + "…" : displayCmd;
        const title = `⚠ ${req.toolName}: ${summary}`;
        try {
            const choice = await promptContext.run({
                category: "permission",
                danger: req.danger,
                tool: { name: req.toolName, args: this.d.cfg.redactContent ? { redacted: true } : { command: req.command } },
                message: displayCmd,
                source: { extension: "rp", tool: "agy-gate" },
            }, () => this.broker.race({
                kind: "select",
                title,
                options: [ALLOW, ALLOW_SESSION, DENY, DENY_REASON],
                opts: { timeout: 270_000, signal: req.signal },
            }, null));
            if (choice === ALLOW)
                return { decision: "allow" };
            if (choice === ALLOW_SESSION) {
                this.allowed.add(req.key);
                return { decision: "allow" };
            }
            if (choice === DENY_REASON) {
                const reason = await promptContext.run({ category: "question", danger: "low", source: { extension: "rp", tool: "agy-gate" } }, () => this.broker.race({
                    kind: "input",
                    title: "Motivo de la denegación",
                    placeholder: "Explica por qué se deniega",
                    opts: { timeout: 60_000, signal: req.signal },
                }, null));
                return {
                    decision: "deny",
                    reason: reason?.trim() ? `Denegado desde RP móvil: ${reason.trim()}` : "Denegado desde RP móvil",
                };
            }
            if (choice === DENY) {
                return { decision: "deny", reason: "Denegado desde RP móvil" };
            }
            // Timeout or cancelled: let agy ask in terminal
            return { decision: "ask", reason: "RP: sin respuesta en móvil; confirmar en terminal" };
        }
        catch (e) {
            return { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` };
        }
    }
    refreshGit() {
        const cwd = this.info.cwd;
        if (!cwd)
            return Promise.resolve();
        return new Promise((resolve) => {
            execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2_000 }, (err, stdout) => {
                if (this.disposed)
                    return resolve();
                if (err) {
                    this.git = { branch: null, dirty: false };
                    return resolve();
                }
                const branch = stdout.trim() || null;
                execFile("git", ["status", "--porcelain", "-uno"], { cwd, timeout: 2_000 }, (err2, stdout2) => {
                    if (!this.disposed)
                        this.git = { branch, dirty: !err2 && stdout2.trim().length > 0 };
                    resolve();
                });
            });
        });
    }
    closeFromHerdr(reason = "pane_closed", graceMs = 250) {
        if (this.disposed || this.closeTimer)
            return;
        if (this.startTimer) {
            clearTimeout(this.startTimer);
            this.startTimer = null;
            this.conn.start();
        }
        const finishClose = () => {
            if (this.disposed || this.closeTimer)
                return;
            this.conn.sendDirect("agent.closed", { reason });
            this.closeTimer = setTimeout(() => {
                this.closeTimer = null;
                this.stop();
            }, graceMs);
            this.closeTimer.unref?.();
        };
        if (this.conn.connected) {
            finishClose();
        }
        else {
            void this.conn.whenConnected(3_000).then((ok) => {
                if (ok)
                    finishClose();
                else
                    this.stop();
            });
        }
    }
    stop() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.closeTimer)
            clearTimeout(this.closeTimer);
        this.closeTimer = null;
        if (this.reconnectDebounce)
            clearTimeout(this.reconnectDebounce);
        this.reconnectDebounce = null;
        if (this.commandTimer)
            clearTimeout(this.commandTimer);
        this.commandTimer = null;
        if (this.startTimer)
            clearTimeout(this.startTimer);
        this.startTimer = null;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = null;
        if (this.watchDebounce)
            clearTimeout(this.watchDebounce);
        this.watchDebounce = null;
        if (this.watcher) {
            try {
                this.watcher.close();
            }
            catch {
                /* ignore */
            }
            this.watcher = null;
        }
        this.broker.shutdown();
        this.conn.stop();
    }
}
export class HerdrAgentBridge {
    o;
    sessionsByKey = new Map();
    missingPolls = new Map();
    gateCreatedAt = new Map();
    closedPanesUntil = new Map();
    persistedSessions = new Map();
    retiringOrphans = new Set();
    pollTimer = null;
    pollPromise = null;
    stopped = false;
    gateServer = null;
    clientSockets = new Set();
    runner;
    sockPath;
    stateFile;
    lastSavedSessionsJson = "";
    constructor(o) {
        this.o = o;
        this.runner = o.runner ?? realRun;
        this.sockPath = o.socketPath ?? gateSocketPath();
        this.stateFile =
            o.stateFile !== undefined
                ? o.stateFile
                : o.connectionFactory
                    ? null
                    : path.join(configDir(), "herdr-active-sessions.json");
        this.loadPersistedSessions();
    }
    loadPersistedSessions() {
        if (!this.stateFile)
            return;
        try {
            const arr = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            if (!Array.isArray(arr))
                return;
            for (const item of arr) {
                if (!item || typeof item !== "object" || typeof item.paneId !== "string" || typeof item.agent !== "string")
                    continue;
                const key = sanitizeIdPart((typeof item.sessionId === "string" && item.sessionId) || `pane-${item.paneId}`);
                this.persistedSessions.set(key, {
                    agent: item.agent,
                    sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
                    status: "idle",
                    cwd: typeof item.cwd === "string" ? item.cwd : process.cwd(),
                    paneId: item.paneId,
                    tabId: typeof item.tabId === "string" ? item.tabId : null,
                    workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : null,
                    title: typeof item.title === "string" ? item.title : null,
                    stateChangeSeq: 0,
                });
            }
        }
        catch {
            /* first run or missing state file */
        }
    }
    savePersistedSessions() {
        if (!this.stateFile)
            return;
        try {
            const items = [...this.persistedSessions.values()];
            const serialized = JSON.stringify(items, null, 2);
            if (serialized === this.lastSavedSessionsJson)
                return;
            const dir = path.dirname(this.stateFile);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${this.stateFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, serialized, { mode: 0o600 });
            fs.renameSync(tmp, this.stateFile);
            this.lastSavedSessionsJson = serialized;
        }
        catch {
            /* best effort */
        }
    }
    /** Immediately close and suppress any bridged session running in `paneId` when closed via rp-host. */
    notifyPaneClosed(paneId) {
        if (!paneId)
            return;
        this.closedPanesUntil.set(paneId, Date.now() + 10_000);
        let changed = false;
        for (const [key, session] of this.sessionsByKey.entries()) {
            if (session.paneId === paneId) {
                session.closeFromHerdr("pane_closed");
                this.sessionsByKey.delete(key);
                this.missingPolls.delete(key);
                this.gateCreatedAt.delete(key);
                if (this.persistedSessions.delete(key))
                    changed = true;
            }
        }
        if (changed)
            this.savePersistedSessions();
    }
    start() {
        this.startGateServer();
        void this.poll();
        const interval = this.o.pollIntervalMs ?? 3_000;
        this.pollTimer = setInterval(() => void this.poll(), interval);
        this.pollTimer.unref?.();
    }
    stop() {
        this.stopped = true;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (this.gateServer) {
            try {
                this.gateServer.close();
            }
            catch {
                /* ignore */
            }
            this.gateServer = null;
        }
        for (const socket of this.clientSockets) {
            try {
                socket.destroy();
            }
            catch {
                /* ignore */
            }
        }
        this.clientSockets.clear();
        if (process.platform !== "win32" && fs.existsSync(this.sockPath)) {
            try {
                fs.unlinkSync(this.sockPath);
            }
            catch {
                /* ignore */
            }
        }
        for (const s of this.sessionsByKey.values())
            s.stop();
        this.sessionsByKey.clear();
        for (const s of this.retiringOrphans)
            s.stop();
        this.retiringOrphans.clear();
        this.missingPolls.clear();
        this.gateCreatedAt.clear();
        this.closedPanesUntil.clear();
    }
    getActiveSessions() {
        return [...this.sessionsByKey.values()];
    }
    async poll() {
        if (this.stopped)
            return;
        if (this.pollPromise)
            return this.pollPromise;
        this.pollPromise = this.runPoll().finally(() => {
            this.pollPromise = null;
        });
        return this.pollPromise;
    }
    retireOrphanSession(info) {
        const orphan = new BridgedAgentSession(info, {
            relayUrl: this.o.relayUrl,
            machineId: this.o.machineId,
            token: this.o.token,
            cfg: this.o.cfg,
            herdrSession: this.o.herdrSession,
            runner: this.runner,
            onLog: this.o.onLog,
            connectionFactory: this.o.connectionFactory,
        });
        this.retiringOrphans.add(orphan);
        orphan.closeFromHerdr("pane_closed");
        const t = setTimeout(() => this.retiringOrphans.delete(orphan), 5_000);
        t.unref?.();
    }
    async runPoll() {
        try {
            const env = this.o.herdrSession ? { HERDR_SESSION: this.o.herdrSession } : {};
            const res = await this.runner("herdr", ["agent", "list"], { timeoutMs: 5_000, env });
            if (this.stopped || res.code !== 0)
                return;
            const now = Date.now();
            for (const [paneId, until] of this.closedPanesUntil.entries()) {
                if (now >= until)
                    this.closedPanesUntil.delete(paneId);
            }
            const sortMode = this.o.panelSortMode ?? readHerdrPanelSortMode();
            const discovered = sortHerdrAgentsForDisplay(parseHerdrAgentList(res.stdout).filter((item) => {
                const until = this.closedPanesUntil.get(item.paneId);
                return !until || now >= until;
            }), sortMode);
            const discoveredKeys = new Set(discovered.map((item) => sanitizeIdPart(item.sessionId || `pane-${item.paneId}`)));
            const seenKeys = new Set();
            let newCount = 0;
            for (let idx = 0; idx < discovered.length; idx++) {
                const item = { ...discovered[idx], orderIndex: idx + 1 };
                const key = sanitizeIdPart(item.sessionId || `pane-${item.paneId}`);
                seenKeys.add(key);
                this.missingPolls.delete(key);
                const existing = this.sessionsByKey.get(key);
                if (existing) {
                    existing.updateFromHerdr(item);
                }
                else {
                    // If an on-demand fallback or previous session occupied this pane and was superseded, close and archive it
                    const inheritedAllowed = [];
                    for (const [prevKey, prevSession] of this.sessionsByKey.entries()) {
                        if (prevKey !== key && prevSession.paneId === item.paneId && !discoveredKeys.has(prevKey)) {
                            for (const k of prevSession.allowed.keys())
                                inheritedAllowed.push(k);
                            prevSession.closeFromHerdr("pane_closed");
                            this.sessionsByKey.delete(prevKey);
                            this.missingPolls.delete(prevKey);
                            this.gateCreatedAt.delete(prevKey);
                            this.persistedSessions.delete(prevKey);
                        }
                    }
                    const startDelayMs = !this.o.connectionFactory ? newCount * 35 : 0;
                    newCount++;
                    const session = new BridgedAgentSession(item, {
                        relayUrl: this.o.relayUrl,
                        machineId: this.o.machineId,
                        token: this.o.token,
                        cfg: this.o.cfg,
                        herdrSession: this.o.herdrSession,
                        runner: this.runner,
                        onLog: this.o.onLog,
                        connectionFactory: this.o.connectionFactory,
                        startDelayMs,
                        onSessionClosedByCommand: (_closedKey, closedPaneId) => {
                            this.notifyPaneClosed(closedPaneId);
                        },
                    });
                    for (const k of inheritedAllowed)
                        session.allowed.add(k);
                    this.sessionsByKey.set(key, session);
                }
                this.persistedSessions.set(key, item);
            }
            for (const [key, session] of this.sessionsByKey.entries()) {
                if (seenKeys.has(key)) {
                    this.gateCreatedAt.delete(key);
                    continue;
                }
                const gateAge = Date.now() - (this.gateCreatedAt.get(key) ?? 0);
                if (session.broker.openCount > 0 || gateAge < 30_000)
                    continue;
                const misses = (this.missingPolls.get(key) ?? 0) + 1;
                if (misses >= 2) {
                    session.closeFromHerdr("pane_closed");
                    this.sessionsByKey.delete(key);
                    this.missingPolls.delete(key);
                    this.gateCreatedAt.delete(key);
                    this.persistedSessions.delete(key);
                }
                else {
                    this.missingPolls.set(key, misses);
                }
            }
            // Retire any session persisted from a previous rp-host run that is no longer in Herdr
            for (const [key, persisted] of this.persistedSessions.entries()) {
                if (!seenKeys.has(key) && !this.sessionsByKey.has(key)) {
                    this.persistedSessions.delete(key);
                    this.retireOrphanSession(persisted);
                }
            }
            this.savePersistedSessions();
        }
        catch (e) {
            this.o.onLog?.(`herdr bridge poll error: ${errMsg(e)}`);
        }
    }
    startGateServer() {
        try {
            if (process.platform !== "win32") {
                fs.mkdirSync(path.dirname(this.sockPath), { recursive: true, mode: 0o700 });
                if (fs.existsSync(this.sockPath))
                    fs.unlinkSync(this.sockPath);
            }
            const server = net.createServer((socket) => {
                this.clientSockets.add(socket);
                const ac = new AbortController();
                socket.setTimeout(300_000, () => socket.destroy());
                socket.on("close", () => {
                    this.clientSockets.delete(socket);
                    ac.abort();
                });
                socket.on("error", () => {
                    this.clientSockets.delete(socket);
                    ac.abort();
                });
                let buf = "";
                socket.on("data", (chunk) => {
                    if (buf.length + chunk.length > 256 * 1024) {
                        socket.destroy();
                        return;
                    }
                    buf += chunk.toString("utf8");
                    const nl = buf.indexOf("\n");
                    if (nl < 0)
                        return;
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    void this.handleGateSocketRequest(line, ac.signal).then((resp) => {
                        if (!socket.destroyed) {
                            socket.end(JSON.stringify(resp) + "\n");
                        }
                    });
                });
            });
            server.on("error", (e) => this.o.onLog?.(`gate socket error: ${errMsg(e)}`));
            server.listen(this.sockPath, () => {
                if (process.platform !== "win32") {
                    try {
                        fs.chmodSync(this.sockPath, 0o600);
                    }
                    catch {
                        /* ignore */
                    }
                }
            });
            server.unref?.();
            this.gateServer = server;
        }
        catch (e) {
            this.o.onLog?.(`failed to start gate socket: ${errMsg(e)}`);
        }
    }
    async handleGateSocketRequest(rawLine, signal) {
        let req;
        try {
            req = JSON.parse(rawLine);
        }
        catch {
            return { decision: "ask", reason: "RP: solicitud de autorización inválida (JSON malformado)" };
        }
        const conversationId = typeof req?.conversationId === "string" ? req.conversationId : "";
        const command = typeof req?.command === "string" ? req.command : "";
        if (!conversationId || !/^[0-9a-zA-Z_][0-9a-zA-Z_-]{0,127}$/.test(conversationId) || !command) {
            return { decision: "ask", reason: "RP: solicitud de autorización incompleta" };
        }
        const key = sanitizeIdPart(conversationId);
        let session = this.sessionsByKey.get(key);
        if (!session && typeof req.paneId === "string" && req.paneId) {
            for (const existing of this.sessionsByKey.values()) {
                if (existing.paneId === req.paneId) {
                    session = existing;
                    break;
                }
            }
        }
        if (!session) {
            const cwd = Array.isArray(req.workspacePaths) && typeof req.workspacePaths[0] === "string" ? req.workspacePaths[0] : process.cwd();
            session = new BridgedAgentSession({
                agent: "agy",
                sessionId: conversationId,
                status: "working",
                cwd,
                paneId: typeof req.paneId === "string" ? req.paneId : "",
                tabId: null,
                workspaceId: null,
                title: null,
                stateChangeSeq: 0,
            }, {
                relayUrl: this.o.relayUrl,
                machineId: this.o.machineId,
                token: this.o.token,
                cfg: this.o.cfg,
                herdrSession: this.o.herdrSession,
                runner: this.runner,
                onLog: this.o.onLog,
                connectionFactory: this.o.connectionFactory,
            }, typeof req.transcriptPath === "string" ? req.transcriptPath : undefined);
            this.sessionsByKey.set(key, session);
            this.gateCreatedAt.set(key, Date.now());
        }
        const mode = this.o.cfg.gate.mode === "auto-detect" || this.o.cfg.gate.mode === "off" ? "dangerous" : this.o.cfg.gate.mode;
        const dec = decide(mode, this.o.cfg.gate, compilePatterns(this.o.cfg.gate.dangerousPatterns), "bash", { command });
        const serverDanger = dec.danger === "high" || req.danger === "high" ? "high" : req.danger === "medium" || dec.danger === "medium" ? "medium" : "high";
        const serverKey = serverDanger === "high" ? `bash:${command.trim()}` : allowKey("bash", { command });
        try {
            return await session.requestGateApproval({
                toolName: "bash",
                command,
                danger: serverDanger,
                key: serverKey,
                signal,
            });
        }
        catch (e) {
            return { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` };
        }
    }
}
/**
 * Executed by Antigravity CLI on `PreToolUse` (`rp-host agy-hook PreToolUse`).
 * MUST write exactly one JSON object to stdout and exit 0.
 */
export async function runAgyHook(cfg, stdinText, sockPath = gateSocketPath()) {
    if (!cfg.enabled)
        return { decision: "ask" };
    let payload;
    try {
        payload = JSON.parse(stdinText);
    }
    catch {
        return { decision: "ask", reason: "RP: entrada de hook inválida (JSON malformado)" };
    }
    const rawToolName = String(payload?.toolCall?.name ?? "");
    if (rawToolName !== "run_command")
        return { decision: "allow" };
    const args = parseAgyArgs(payload?.toolCall?.args ?? payload?.toolCall?.arguments);
    const command = String(args.CommandLine ?? args.command ?? args.commandLine ?? args.cmd ?? "").trim();
    if (!command)
        return { decision: "ask", reason: "RP: comando no identificado; confirmar en terminal" };
    const mode = cfg.gate.mode === "auto-detect" ? "dangerous" : cfg.gate.mode;
    if (mode === "off")
        return { decision: "ask" };
    const patterns = compilePatterns(cfg.gate.dangerousPatterns);
    const dec = decide(mode, cfg.gate, patterns, "bash", { command });
    if (!dec.ask)
        return { decision: "allow" };
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : "";
    if (!conversationId)
        return { decision: "ask", reason: "RP: comando peligroso detectado" };
    return new Promise((resolve) => {
        const client = net.createConnection(sockPath);
        let settled = false;
        const finish = (res) => {
            if (settled)
                return;
            settled = true;
            try {
                client.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(res);
        };
        const timer = setTimeout(() => finish({ decision: "ask", reason: "RP: tiempo de espera agotado; confirmar en terminal" }), 280_000);
        timer.unref?.();
        client.on("error", () => {
            clearTimeout(timer);
            finish({ decision: "ask", reason: "RP: comando peligroso detectado (rp-host inactivo)" });
        });
        client.on("connect", () => {
            const req = {
                conversationId,
                workspacePaths: payload?.workspacePaths,
                transcriptPath: payload?.transcriptPath,
                paneId: process.env.HERDR_PANE_ID ?? "",
                command,
                danger: dec.danger,
                allowKey: dec.key,
            };
            client.write(JSON.stringify(req) + "\n");
        });
        let buf = "";
        client.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0)
                return;
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(buf.slice(0, nl).trim());
                if (parsed?.decision === "allow" || parsed?.decision === "deny" || parsed?.decision === "ask") {
                    finish(parsed);
                    return;
                }
            }
            catch {
                /* fallthrough */
            }
            finish({ decision: "ask", reason: "RP: comando peligroso detectado" });
        });
        client.on("close", () => {
            clearTimeout(timer);
            finish({ decision: "ask", reason: "RP: comando peligroso detectado" });
        });
    });
}
/** Install or update the rp-gate PreToolUse hook inside ~/.gemini/config/hooks.json without touching other hooks. */
export function installAgyHooks(nodePath, scriptPath, home = os.homedir(), platform = process.platform) {
    const hooksFile = path.join(home, ".gemini", "config", "hooks.json");
    let current = {};
    try {
        current = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
        if (!current || typeof current !== "object" || Array.isArray(current))
            current = {};
    }
    catch {
        current = {};
    }
    const hookCommand = platform === "win32"
        ? `"${nodePath.replace(/"/g, '""')}" "${scriptPath.replace(/"/g, '""')}" agy-hook PreToolUse`
        : `'${nodePath.replace(/'/g, "'\\''")}' '${scriptPath.replace(/'/g, "'\\''")}' agy-hook PreToolUse`;
    current["rp-gate"] = {
        enabled: true,
        PreToolUse: [
            {
                matcher: "run_command",
                hooks: [
                    {
                        type: "command",
                        command: hookCommand,
                        timeout: 300,
                    },
                ],
            },
        ],
    };
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(hooksFile, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    return hooksFile;
}
