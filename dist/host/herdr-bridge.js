// Herdr + Antigravity CLI (agy) bridge for rp-host.
// Discovers non-Pi agents running in Herdr, bridges their transcripts/panes to Rp-relay,
// delivers prompts/aborts via Herdr CLI, and serves PreToolUse permission gating for agy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection } from "../extension/connection.js";
import { resolveInboxDir } from "../extension/config.js";
import { relayBlobFetcher, resolveAttachments } from "../extension/attachments.js";
import { routeInbound, pendingAnswers } from "../extension/inbound.js";
import { Broker } from "../extension/prompts/broker.js";
import { Classifier, promptContext } from "../extension/prompts/classify.js";
import { ALLOW, ALLOW_SESSION, DENY, DENY_REASON, allowKey, compilePatterns, decide } from "../extension/prompts/gate.js";
import { pluginVersion } from "../extension/version.js";
import { parseJson } from "./backends/herdr.js";
import { run as realRun } from "./runner.js";
import { AgyTranscriptReader, resolveAgyTranscriptPath } from "./agy-transcript.js";
import { readGitHeadAndDirty } from "./git.js";
import { parseTerminalContextUsage, readExternalAgentContextUsage, readExternalAgentMetadata, readExternalAgentModel, readExternalAgentModelWithState, } from "./bridge/external-metadata.js";
import { AGY_GATE_PROMPT_TIMEOUT_MS, gateSocketPath, installAgyHooks, runAgyHook, sanitizeIdPart, } from "./bridge/agy-hooks.js";
import { AgyGateServer } from "./bridge/gate-server.js";
import { MAX_AGY_QUESTIONNAIRE_BATCH, buildAskQuestionKeystrokePlan, buildAskQuestionPromptSpec, deliverAskQuestionPlan, } from "./bridge/agy-ask-question.js";
import { extractRecentCommandOutput, herdrPriorityStatusRank, mapHerdrAgentStatus, parseHerdrAgentList, readHerdrPanelSortMode, sortHerdrAgentsForDisplay, } from "./bridge/herdr-discovery.js";
import { configDir } from "../shared/platform.js";
import { encodeHerdrTabId, newId, } from "../shared/protocol.js";
import { LruSet, atomicWriteFileSync, errMsg, safeUser, stripAnsi, truncateBytes } from "../shared/util.js";
export { extractRecentCommandOutput, gateSocketPath, herdrPriorityStatusRank, installAgyHooks, mapHerdrAgentStatus, parseHerdrAgentList, parseTerminalContextUsage, readExternalAgentContextUsage, readExternalAgentMetadata, readExternalAgentModel, readHerdrPanelSortMode, runAgyHook, sortHerdrAgentsForDisplay, };
const OPTIMISTIC_WORKING_MS = 8_000;
const HERDR_FAIL_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
const HERDR_ZERO_SESSIONS_POLL_MS = 15_000;
const ORDER_HELLO_DEBOUNCE_MS = 1_500;
const GIT_REFRESH_DEBOUNCE_MS = 3_000;
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
    gitInFlight = null;
    transcriptReader = null;
    lastTerminalSnapshot = "";
    lastTerminalSnapshotTs = 0;
    initialFallbackDone = false;
    initialSnapshotSent = false;
    lastStateSeq = -1;
    startTimer = null;
    pollTimer = null;
    pollInFlight = null;
    watcher = null;
    watchDebounce = null;
    lastSentName = "";
    lastSentTabId = null;
    lastSentOrderIndex = undefined;
    lastSentContextSpec = "";
    lastSentModelId = "";
    lastSentModel = null;
    orderHelloTimer = null;
    gitRefreshTimer = null;
    externalContextUsage = null;
    currentStatus;
    lastEmittedStatus;
    optimisticWorkingUntilMs = 0;
    optimisticTimer = null;
    fallbackTurnTs = 0;
    commandTimer = null;
    closeTimer = null;
    reconnectDebounce = null;
    deliveryTail = Promise.resolve();
    seenClientMsgIds = new LruSet(500);
    lastActiveTask = null;
    activeAskQuestion = null;
    deliveringAskQuestionKey = null;
    handledAskQuestionKeys = new LruSet(100);
    askQuestionPollTimer = null;
    constructor(info, d) {
        this.info = info;
        this.d = d;
        const rawKey = info.sessionId || `pane-${info.paneId}`;
        this.sessionKey = sanitizeIdPart(rawKey);
        this.agentId = `${d.machineId}:herdr:${this.sessionKey}`;
        this.currentStatus = info.status;
        this.lastEmittedStatus = info.status;
        if (!d.retireOnly && info.agent === "agy" && info.sessionId) {
            try {
                const canonical = resolveAgyTranscriptPath(info.sessionId);
                this.transcriptReader = new AgyTranscriptReader(canonical, () => this.d.cfg.redactContent, () => this.activeAgyModelId());
            }
            catch {
                this.transcriptReader = null;
            }
        }
        this.broker = new Broker({
            agentId: this.agentId,
            send: (t, body) => this.conn.send(t, body),
            hasUI: false,
            redact: () => this.d.cfg.redactContent,
            classifier: new Classifier(),
            herdr: null,
            onChange: () => this.reconcileStatus(),
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
        if (!d.retireOnly) {
            void this.refreshGit();
            this.startTranscriptPolling();
        }
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
    hasOpenGatePrompts() {
        return this.broker.openCount > 0;
    }
    getContextUsage() {
        return this.transcriptReader?.getContextUsage() ?? this.externalContextUsage;
    }
    encodedTabId() {
        return encodeHerdrTabId({
            tabId: this.info.tabId,
            orderIndex: this.info.orderIndex,
            isDone: this.effectiveStatus() === "done",
            context: this.getContextUsage(),
        });
    }
    activeAgyModelId() {
        const fromTranscript = this.transcriptReader?.getLastModel();
        if (fromTranscript)
            return fromTranscript;
        if (this.lastSentModelId)
            return this.lastSentModelId;
        const { model } = readExternalAgentModelWithState(this.info.agent, this.info.cwd, this.info.sessionId, undefined, this.transcriptReader ? { knownTranscriptModel: null } : undefined);
        return model.id || null;
    }
    syncContextIfChanged(direct = false) {
        const ctx = this.getContextUsage();
        if (!ctx || ctx.tokens <= 0 || ctx.contextWindow <= 0)
            return;
        const spec = `${ctx.tokens}/${ctx.contextWindow}`;
        if (spec !== this.lastSentContextSpec) {
            this.lastSentContextSpec = spec;
            if (direct) {
                this.conn.sendDirect("agent.statuses", { items: { "rp:context": spec } });
            }
            else {
                this.conn.send("agent.statuses", { items: { "rp:context": spec } });
            }
        }
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
    applyExternalModel(nextModel, uncertain) {
        if (!this.conn.connected || !this.initialSnapshotSent)
            return;
        if (uncertain || !nextModel.id || nextModel.id === this.lastSentModelId)
            return;
        this.lastSentModel = nextModel;
        this.lastSentModelId = nextModel.id;
        this.syncContextIfChanged(false);
        this.conn.sendDirect("agent.hello", this.makeHello());
        this.sendEvent({ type: "model_select", model: nextModel });
    }
    syncModelIfChanged() {
        if (!this.conn.connected || !this.initialSnapshotSent)
            return;
        const { model: nextModel, uncertain } = readExternalAgentModelWithState(this.info.agent, this.info.cwd, this.info.sessionId, undefined, this.transcriptReader ? { knownTranscriptModel: this.transcriptReader.getLastModel() } : undefined);
        this.applyExternalModel(nextModel, uncertain);
    }
    clearOrderHelloTimer() {
        if (this.orderHelloTimer) {
            clearTimeout(this.orderHelloTimer);
            this.orderHelloTimer = null;
        }
    }
    scheduleOrderHello() {
        if (this.disposed || !this.conn.connected || !this.initialSnapshotSent)
            return;
        this.clearOrderHelloTimer();
        this.orderHelloTimer = setTimeout(() => {
            this.orderHelloTimer = null;
            if (this.disposed || !this.conn.connected || !this.initialSnapshotSent)
                return;
            if (this.info.orderIndex !== this.lastSentOrderIndex) {
                this.conn.sendDirect("agent.hello", this.makeHello());
            }
        }, ORDER_HELLO_DEBOUNCE_MS);
        this.orderHelloTimer.unref?.();
    }
    effectiveStatus() {
        if (this.broker.openCount > 0)
            return "waiting_input";
        if ((this.currentStatus === "idle" || this.currentStatus === "done") &&
            (Date.now() < this.optimisticWorkingUntilMs ||
                (this.transcriptReader?.hasRunningBackgroundTasks() ?? false))) {
            return "working";
        }
        return this.currentStatus;
    }
    hasRunningTranscriptWork() {
        return this.transcriptReader?.hasRunningWork() ?? false;
    }
    clearOptimisticWorking() {
        this.optimisticWorkingUntilMs = 0;
        if (this.optimisticTimer) {
            clearTimeout(this.optimisticTimer);
            this.optimisticTimer = null;
        }
    }
    armOptimisticWorking() {
        this.optimisticWorkingUntilMs = Date.now() + OPTIMISTIC_WORKING_MS;
        if (this.optimisticTimer)
            clearTimeout(this.optimisticTimer);
        this.optimisticTimer = setTimeout(() => {
            this.optimisticTimer = null;
            this.reconcileStatus();
        }, OPTIMISTIC_WORKING_MS + 50);
        this.optimisticTimer.unref?.();
    }
    syncStatus() {
        if (this.disposed)
            return;
        const status = this.effectiveStatus();
        const detail = status === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
        this.lastActiveTask = detail;
        this.lastEmittedStatus = status;
        this.conn.send("agent.status", { status, ...(detail ? { detail } : {}) });
        this.scheduleNextPoll();
    }
    reconcileStatus() {
        if (this.disposed)
            return;
        const prev = this.lastEmittedStatus;
        const next = this.effectiveStatus();
        const nextTask = next === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
        if (next === prev && nextTask === this.lastActiveTask)
            return;
        this.syncStatus();
        if (next === "working" && prev !== "working") {
            this.sendEvent({ type: "agent_start" });
        }
        else if (prev === "working" && (next === "idle" || next === "done")) {
            void this.pollTranscriptNow();
            void this.refreshGit();
            this.sendEvent({ type: "agent_settled", aborted: false });
        }
    }
    updateFromHerdr(next) {
        const prevCwd = this.info.cwd;
        const prevWorkspace = this.info.workspaceId;
        const prevPane = this.info.paneId;
        const seqChanged = next.stateChangeSeq !== this.lastStateSeq;
        this.lastStateSeq = next.stateChangeSeq;
        if (!this.info.sessionId && next.sessionId && next.agent === "agy") {
            try {
                const tPath = resolveAgyTranscriptPath(next.sessionId);
                this.info.sessionId = next.sessionId;
                this.transcriptReader = new AgyTranscriptReader(tPath, () => this.d.cfg.redactContent, () => this.activeAgyModelId());
                this.setupFileWatcher();
            }
            catch {
                /* ignore invalid sessionId */
            }
        }
        if (next.status !== "idle" && next.status !== "done") {
            this.clearOptimisticWorking();
        }
        else {
            this.transcriptReader?.pruneStaleBackgroundTasks?.();
        }
        const prevTabId = this.info.tabId;
        const prevOrderIndex = this.info.orderIndex;
        const prevIsDone = this.effectiveStatus() === "done";
        const prevEmitted = this.lastEmittedStatus;
        this.info = { ...this.info, ...next };
        this.currentStatus = next.status;
        const nextIsDone = this.effectiveStatus() === "done";
        if (this.conn.connected && this.initialSnapshotSent) {
            if (prevTabId !== this.info.tabId || prevIsDone !== nextIsDone) {
                this.clearOrderHelloTimer();
                this.conn.sendDirect("agent.hello", this.makeHello());
            }
            else if (prevOrderIndex !== this.info.orderIndex) {
                this.scheduleOrderHello();
            }
        }
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
        this.reconcileStatus();
        if (this.lastEmittedStatus === prevEmitted && seqChanged) {
            void this.pollTranscriptNow();
        }
    }
    makeHello() {
        this.clearOrderHelloTimer();
        const subagents = this.transcriptReader?.getSubagents() ?? [];
        const name = this.sessionDisplayName();
        this.lastSentName = name;
        const encodedTab = this.encodedTabId();
        this.lastSentTabId = encodedTab;
        this.lastSentOrderIndex = this.info.orderIndex;
        const rawBranch = this.git?.branch ?? null;
        const gitDirty = this.git?.dirty ?? false;
        const formattedBranch = rawBranch && gitDirty && !rawBranch.endsWith(" *") ? `${rawBranch} *` : rawBranch;
        let model = this.lastSentModel;
        if (!model) {
            model = readExternalAgentModel(this.info.agent, this.info.cwd, this.info.sessionId, undefined, this.transcriptReader ? { knownTranscriptModel: this.transcriptReader.getLastModel() } : undefined);
            this.lastSentModel = model;
            this.lastSentModelId = model.id;
        }
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
                tabId: encodedTab,
                workspaceId: this.info.workspaceId,
                session: this.d.herdrSession,
            },
            gentle: null,
            transport: this.conn?.transportName ?? "ws",
            redacted: this.d.cfg.redactContent,
            cwd: this.info.cwd,
            spawnId: null,
            git: { branch: formattedBranch, dirty: gitDirty },
            model,
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
            w.lastSeq >= this.seq;
        if (canSkipSnapshot) {
            this.conn.dropQueuedEventsUpTo(w.lastSeq);
        }
        else {
            this.sendSnapshot(true);
        }
        const status = this.effectiveStatus();
        const detail = status === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
        this.lastActiveTask = detail;
        this.lastEmittedStatus = status;
        this.conn.sendDirect("agent.status", { status, ...(detail ? { detail } : {}) });
        this.syncContextIfChanged(true);
        this.conn.needsSnapshot = false;
        for (const p of pendingAnswers(w))
            this.broker.handleAnswer(p.promptId, p.answer);
    }
    sendSnapshotBody(direct, body) {
        if (direct) {
            this.conn.dropQueuedEventsUpTo(this.seq);
            this.conn.sendDirect("agent.snapshot", { ...body, seq: this.seq });
        }
        else {
            this.conn.send("agent.snapshot", body);
        }
    }
    emitSnapshotFollowupEvents(direct, events, entries) {
        if (!this.transcriptReader)
            return;
        const snapshotToolIds = collectSnapshotToolCallIds(entries);
        const emittedUpdateToolIds = new Set();
        if (direct) {
            for (const sub of this.dedupeSubagentUpdates(events, this.transcriptReader.getSubagents(), snapshotToolIds)) {
                this.sendEvent(sub);
            }
        }
        else {
            const emittedSubIds = new Set();
            for (const ev of events) {
                if (ev.type === "subagent_update" && typeof ev.taskId === "string") {
                    if (ev.status !== "running" && !snapshotToolIds.has(ev.taskId))
                        continue;
                    emittedSubIds.add(ev.taskId);
                }
                else if (ev.type === "tool_execution_update" && typeof ev.toolCallId === "string") {
                    emittedUpdateToolIds.add(ev.toolCallId);
                }
                this.sendEvent(ev);
            }
            for (const sub of this.transcriptReader.getSubagents()) {
                if (emittedSubIds.has(sub.taskId))
                    continue;
                if (sub.status === "running" || snapshotToolIds.has(sub.taskId)) {
                    this.sendEvent(sub);
                }
            }
        }
        for (const upd of this.transcriptReader.getRunningBackgroundUpdates(snapshotToolIds)) {
            const toolId = upd.toolCallId;
            if (typeof toolId === "string" && emittedUpdateToolIds.has(toolId))
                continue;
            this.sendEvent(upd);
        }
    }
    sendSnapshot(direct) {
        this.initialSnapshotSent = true;
        if (this.transcriptReader) {
            let hadRunning = false;
            let snap;
            let lastActivityAt = null;
            try {
                hadRunning = this.hasRunningTranscriptWork();
                snap = this.transcriptReader.readSnapshot();
                lastActivityAt = this.transcriptReader.getLastActivityAt();
            }
            catch (e) {
                this.d.onLog?.(`sendSnapshot transcript read error: ${errMsg(e)}`);
                this.sendSnapshotBody(direct, { epoch: this.epoch, seq: this.seq, entries: [], truncated: false });
                return;
            }
            const { entries, truncated, events } = snap;
            this.sendSnapshotBody(direct, {
                epoch: this.epoch,
                seq: this.seq,
                entries,
                truncated,
                ...(lastActivityAt ? { lastActivityAt } : {}),
            });
            this.emitSnapshotFollowupEvents(direct, events, entries);
            this.reconcileAskQuestion();
            if (!hadRunning && this.hasRunningTranscriptWork()) {
                this.scheduleNextPoll();
            }
            this.syncSessionNameIfChanged();
            return;
        }
        const entryAt = this.lastTerminalSnapshotTs || null;
        this.sendSnapshotBody(direct, {
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
        });
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
    dedupeSubagentUpdates(events, subagents, snapshotToolIds) {
        const byId = new Map();
        for (const sub of subagents) {
            if (sub.status === "running" || snapshotToolIds.has(sub.taskId)) {
                byId.set(sub.taskId, sub);
            }
        }
        for (const ev of events) {
            if (ev.type === "subagent_update" && typeof ev.taskId === "string") {
                if (ev.status === "running" || snapshotToolIds.has(ev.taskId)) {
                    byId.set(ev.taskId, ev);
                }
                else {
                    byId.delete(ev.taskId);
                }
            }
        }
        return [...byId.values()];
    }
    scheduleNextPoll() {
        if (this.disposed)
            return;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        const status = this.effectiveStatus();
        const isActive = status === "working" || status === "waiting_input" || this.hasRunningTranscriptWork();
        const delayMs = isActive
            ? (this.d.activePollIntervalMs ?? (this.transcriptReader ? 900 : 2_000))
            : (this.d.idlePollIntervalMs ?? (this.watcher ? 15_000 : 20_000));
        this.pollTimer = setTimeout(() => {
            void this.pollTranscriptNow().finally(() => this.scheduleNextPoll());
        }, delayMs);
        this.pollTimer.unref?.();
    }
    startTranscriptPolling() {
        this.setupFileWatcher();
        this.scheduleNextPoll();
    }
    syncExternalMetadata(terminalText) {
        const meta = readExternalAgentMetadata(this.info.agent, this.info.cwd, this.info.sessionId, terminalText);
        if (meta.usage) {
            this.externalContextUsage = meta.usage;
            this.syncContextIfChanged();
        }
        this.applyExternalModel(meta.model, meta.uncertain);
    }
    willPollPaneFallback(commandText) {
        if (this.disposed || !this.info.paneId || this.d.cfg.redactContent)
            return false;
        if (this.initialFallbackDone && !commandText && this.effectiveStatus() !== "working")
            return false;
        return true;
    }
    drainTranscriptEvents(reconcileAsk = true) {
        if (this.disposed || !this.transcriptReader)
            return;
        if (!this.watcher)
            this.setupFileWatcher();
        const hadRunning = this.hasRunningTranscriptWork();
        const prevIsDone = this.effectiveStatus() === "done";
        const prevOffset = this.transcriptReader.byteOffset;
        const events = this.transcriptReader.pollNewEvents();
        const prunedBg = this.currentStatus === "idle" || this.currentStatus === "done"
            ? (this.transcriptReader.pruneStaleBackgroundTasks?.() ?? 0)
            : 0;
        const offsetAdvanced = this.transcriptReader.byteOffset !== prevOffset;
        let shouldRefreshGit = false;
        for (const ev of events) {
            this.sendEvent(ev);
            if (ev.type === "tool_execution_end" &&
                (ev.toolName === "edit" || ev.toolName === "write" || ev.toolName === "bash")) {
                shouldRefreshGit = true;
            }
        }
        if (!hadRunning && this.hasRunningTranscriptWork()) {
            this.scheduleNextPoll();
        }
        if (reconcileAsk) {
            this.reconcileAskQuestion();
        }
        if (offsetAdvanced || events.length > 0) {
            this.syncSessionNameIfChanged();
            this.syncContextIfChanged();
            this.syncModelIfChanged();
        }
        if (events.length > 0 || prunedBg > 0) {
            this.reconcileStatus();
            const nextIsDone = this.effectiveStatus() === "done";
            if (this.conn.connected && this.initialSnapshotSent && nextIsDone !== prevIsDone) {
                this.conn.sendDirect("agent.hello", this.makeHello());
            }
            if (shouldRefreshGit) {
                this.scheduleGitRefresh();
            }
        }
    }
    pollTranscriptNow() {
        if (this.disposed)
            return Promise.resolve();
        if (this.pollInFlight)
            return this.pollInFlight;
        const p = (async () => {
            try {
                if (this.transcriptReader) {
                    this.drainTranscriptEvents(true);
                    return;
                }
                if (this.willPollPaneFallback()) {
                    const polled = await this.pollPaneFallback();
                    if (!polled) {
                        this.syncExternalMetadata(this.lastTerminalSnapshot);
                    }
                }
                else {
                    this.syncExternalMetadata(this.lastTerminalSnapshot);
                }
            }
            catch (e) {
                this.d.onLog?.(`poll transcript error: ${errMsg(e)}`);
            }
        })().finally(() => {
            if (this.pollInFlight === p)
                this.pollInFlight = null;
        });
        this.pollInFlight = p;
        return p;
    }
    async pollPaneFallback(commandText) {
        if (!this.willPollPaneFallback(commandText))
            return false;
        try {
            const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
                timeoutMs: 3_000,
                env: this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {},
            });
            if (res.code !== 0)
                return false;
            const parsed = parseJson(res.stdout);
            const rawText = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
            const text = stripAnsi(rawText).trim();
            if (!text)
                return false;
            const snippet = extractRecentCommandOutput(text, commandText);
            this.syncExternalMetadata(text);
            if (snippet === this.lastTerminalSnapshot)
                return true;
            this.lastTerminalSnapshot = truncateBytes(snippet, 16 * 1024).text;
            if (!this.initialFallbackDone) {
                this.initialFallbackDone = true;
                return true;
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
            return true;
        }
        catch {
            return false;
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
                const cleaned = stripAnsi(rawText).trim();
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
    handleUserMessage(b) {
        const run = this.deliveryTail.then(() => this.deliverUserMessage(b), () => this.deliverUserMessage(b));
        this.deliveryTail = run.catch(() => { });
        return run;
    }
    async deliverUserMessage(b) {
        if (this.disposed)
            return;
        const sendAck = (disposition, method, error = null) => this.conn.send("user.message.ack", {
            clientMsgId: b.clientMsgId,
            disposition,
            method,
            error,
        });
        if (b.clientMsgId && this.seenClientMsgIds.has(b.clientMsgId)) {
            sendAck(b.asCommand ? "command" : "typed", "herdr", null);
            return;
        }
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
            return sendAck("rejected", "herdr", "herdr_unavailable");
        const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
        if (b.asCommand && (text === "/quit" || text === "/exit")) {
            if (b.clientMsgId)
                this.seenClientMsgIds.add(b.clientMsgId);
            sendAck("command", "herdr", null);
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
                return sendAck("rejected", "herdr", "herdr_unavailable");
            }
            if (b.clientMsgId)
                this.seenClientMsgIds.add(b.clientMsgId);
            sendAck("command", "herdr", null);
            await this.handleTermCommand(text, env);
            return;
        }
        const textArgs = text.startsWith("-") ? ["--", text] : [text];
        try {
            if (!b.asCommand) {
                const res = await this.d.runner("herdr", ["agent", "prompt", this.info.paneId, ...textArgs], { timeoutMs: 10_000, env });
                if (res.code !== 0) {
                    const out = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
                    if (/agent_blocked/i.test(out)) {
                        return sendAck("rejected", "herdr", "agent_blocked");
                    }
                    return sendAck("rejected", "herdr", "herdr_unavailable");
                }
            }
            else {
                const sendRes = await this.d.runner("herdr", ["pane", "send-text", this.info.paneId, ...textArgs], { timeoutMs: 5_000, env });
                if (sendRes.code !== 0)
                    return sendAck("rejected", "herdr", "herdr_unavailable");
                await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 5_000, env });
            }
            if (b.clientMsgId)
                this.seenClientMsgIds.add(b.clientMsgId);
            this.fallbackTurnTs = 0;
            this.lastTerminalSnapshot = "";
            this.lastTerminalSnapshotTs = Date.now();
            this.initialFallbackDone = true;
            this.armOptimisticWorking();
            this.reconcileStatus();
            void this.pollTranscriptNow();
            sendAck(b.asCommand ? "command" : "typed", "herdr", null);
            if (this.commandTimer)
                clearTimeout(this.commandTimer);
            this.commandTimer = setTimeout(async () => {
                this.commandTimer = null;
                if (this.disposed)
                    return;
                try {
                    if (this.transcriptReader) {
                        const prevOffset = this.transcriptReader.byteOffset;
                        const prevSeq = this.seq;
                        await this.pollTranscriptNow();
                        if (this.disposed)
                            return;
                        if (this.transcriptReader.byteOffset !== prevOffset || this.seq !== prevSeq) {
                            return;
                        }
                    }
                    if (b.asCommand) {
                        await this.pollPaneFallback(text);
                        if (this.currentStatus === "idle" || this.currentStatus === "done") {
                            this.clearOptimisticWorking();
                            this.reconcileStatus();
                        }
                    }
                }
                catch (e) {
                    this.d.onLog?.(`commandTimer error: ${errMsg(e)}`);
                }
            }, 800);
            this.commandTimer.unref?.();
            return;
        }
        catch {
            return sendAck("rejected", "herdr", "herdr_unavailable");
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
                opts: { timeout: AGY_GATE_PROMPT_TIMEOUT_MS, signal: req.signal },
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
    clearAskQuestionPollTimer() {
        if (this.askQuestionPollTimer) {
            clearTimeout(this.askQuestionPollTimer);
            this.askQuestionPollTimer = null;
        }
    }
    scheduleAskQuestionFollowupPoll() {
        if (this.disposed)
            return;
        this.clearAskQuestionPollTimer();
        this.askQuestionPollTimer = setTimeout(() => {
            this.askQuestionPollTimer = null;
            if (!this.disposed)
                void this.pollTranscriptNow();
        }, 300);
        this.askQuestionPollTimer.unref?.();
    }
    /**
     * Mirror pending agy `ask_question` tool calls to the mobile PromptSheet and dismiss them
     * immediately when resolved locally in the terminal.
     */
    reconcileAskQuestion() {
        if (this.disposed || !this.transcriptReader)
            return;
        const pending = this.transcriptReader.getPendingAskQuestion();
        if (this.activeAskQuestion && (!pending || pending.key !== this.activeAskQuestion.key)) {
            const prev = this.activeAskQuestion;
            this.activeAskQuestion = null;
            if (!prev.prompt.closed) {
                if (prev.prompt.answered && !prev.prompt.cancelledBySystem) {
                    this.broker.ack(prev.prompt.id, false);
                }
                this.broker.close(prev.prompt);
                this.broker.resolved(prev.prompt, "local", null);
            }
        }
        if (pending &&
            this.info.paneId &&
            !this.activeAskQuestion &&
            this.deliveringAskQuestionKey !== pending.key &&
            !this.handledAskQuestionKeys.has(pending.key)) {
            this.openAskQuestionBatch(pending.key, pending.spec, 0);
        }
    }
    openAskQuestionBatch(key, spec, questionOffset) {
        if (this.disposed)
            return;
        const promptSpec = buildAskQuestionPromptSpec(spec, questionOffset);
        const prompt = this.broker.openSpec(promptSpec, true);
        this.activeAskQuestion = { key, spec, questionOffset, prompt };
        void prompt.remoteAnswer.then((answer) => {
            this.handleAskQuestionRemoteAnswer(key, spec, questionOffset, prompt, answer);
        });
    }
    isAskQuestionStillPendingOnDisk(key) {
        if (this.disposed || !this.transcriptReader)
            return false;
        try {
            this.drainTranscriptEvents(false);
        }
        catch (e) {
            this.d.onLog?.(`ask_question disk sync error: ${errMsg(e)}`);
        }
        return this.transcriptReader.getPendingAskQuestion()?.key === key;
    }
    handleAskQuestionRemoteAnswer(key, spec, questionOffset, prompt, answer) {
        if (this.disposed || prompt.cancelledBySystem || prompt.closed)
            return;
        if (this.activeAskQuestion?.prompt.id !== prompt.id)
            return;
        if (!this.isAskQuestionStillPendingOnDisk(key)) {
            this.activeAskQuestion = null;
            this.broker.ack(prompt.id, false);
            this.broker.close(prompt);
            this.broker.resolved(prompt, "local", null);
            this.reconcileAskQuestion();
            return;
        }
        const plan = buildAskQuestionKeystrokePlan(spec, answer, questionOffset);
        if (!plan || !this.info.paneId) {
            this.d.onLog?.(`[${this.agentId}] rejected malformed or undeliverable ask_question answer`);
            this.broker.ack(prompt.id, false);
            this.broker.close(prompt);
            return;
        }
        const cancelled = answer.cancelled === true;
        const nextOffset = questionOffset + MAX_AGY_QUESTIONNAIRE_BATCH;
        const hasMoreBatches = !cancelled && nextOffset < spec.questions.length;
        if (!hasMoreBatches) {
            this.handledAskQuestionKeys.add(key);
        }
        this.activeAskQuestion = null;
        this.deliveringAskQuestionKey = key;
        this.broker.ack(prompt.id, true);
        this.broker.close(prompt);
        this.broker.resolved(prompt, "remote", answer);
        const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
        const run = this.deliveryTail.then(() => this.deliverAskQuestionBatch(key, spec, nextOffset, hasMoreBatches, plan, env), () => this.deliverAskQuestionBatch(key, spec, nextOffset, hasMoreBatches, plan, env));
        this.deliveryTail = run.catch(() => { });
    }
    async deliverAskQuestionBatch(key, spec, nextOffset, hasMoreBatches, plan, env) {
        try {
            if (this.disposed)
                return;
            if (!this.isAskQuestionStillPendingOnDisk(key))
                return;
            const ok = await deliverAskQuestionPlan(this.d.runner, this.info.paneId, env, plan, {
                stepDelayMs: this.d.askQuestionStepDelayMs,
                shouldAbort: () => this.disposed || !this.isAskQuestionStillPendingOnDisk(key),
            });
            if (!ok) {
                this.handledAskQuestionKeys.add(key);
                this.d.onLog?.(`[${this.agentId}] failed to deliver ask_question answer to pane ${this.info.paneId}`);
                return;
            }
            if (this.disposed)
                return;
            if (hasMoreBatches) {
                if (this.isAskQuestionStillPendingOnDisk(key)) {
                    this.openAskQuestionBatch(key, spec, nextOffset);
                }
                return;
            }
            this.armOptimisticWorking();
            this.reconcileStatus();
            this.scheduleAskQuestionFollowupPoll();
        }
        finally {
            if (this.deliveringAskQuestionKey === key) {
                this.deliveringAskQuestionKey = null;
            }
            if (!this.disposed && !this.activeAskQuestion) {
                this.reconcileAskQuestion();
            }
        }
    }
    clearGitRefreshTimer() {
        if (this.gitRefreshTimer) {
            clearTimeout(this.gitRefreshTimer);
            this.gitRefreshTimer = null;
        }
    }
    scheduleGitRefresh() {
        if (this.disposed)
            return;
        if (this.git?.dirty === true && this.effectiveStatus() === "working")
            return;
        this.clearGitRefreshTimer();
        this.gitRefreshTimer = setTimeout(() => {
            this.gitRefreshTimer = null;
            if (!this.disposed)
                void this.refreshGit();
        }, GIT_REFRESH_DEBOUNCE_MS);
        this.gitRefreshTimer.unref?.();
    }
    refreshGit() {
        this.clearGitRefreshTimer();
        const cwd = this.info.cwd;
        if (!cwd)
            return Promise.resolve();
        if (this.gitInFlight)
            return this.gitInFlight;
        const prevBranch = this.git?.branch ?? null;
        const prevDirty = this.git?.dirty ?? false;
        const p = (async () => {
            const next = (await readGitHeadAndDirty(cwd, false)) ?? { branch: null, dirty: false };
            if (this.disposed)
                return;
            this.git = next;
            if (this.conn.connected && (next.branch !== prevBranch || next.dirty !== prevDirty)) {
                this.conn.sendDirect("agent.hello", this.makeHello());
            }
        })().finally(() => {
            if (this.gitInFlight === p)
                this.gitInFlight = null;
        });
        this.gitInFlight = p;
        return p;
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
        this.clearOptimisticWorking();
        this.clearOrderHelloTimer();
        this.clearGitRefreshTimer();
        this.clearAskQuestionPollTimer();
        this.activeAskQuestion = null;
        this.deliveringAskQuestionKey = null;
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
    herdrListFailing = false;
    consecutiveListFailures = 0;
    gate;
    runner;
    stateFile;
    lastSavedSessionsJson = "";
    constructor(o) {
        this.o = o;
        this.runner = o.runner ?? realRun;
        const sockPath = o.socketPath ?? gateSocketPath();
        this.gate = new AgyGateServer({
            sockPath,
            token: o.token,
            onRequest: (req, signal) => this.handleGateApprovalRequest(req, signal),
            onLog: o.onLog,
        });
        this.stateFile =
            o.stateFile !== undefined
                ? o.stateFile
                : o.connectionFactory
                    ? null
                    : path.join(configDir(), "herdr-active-sessions.json");
        this.loadPersistedSessions();
    }
    get gateServer() {
        return this.gate.server;
    }
    get ownsGateSocket() {
        return this.gate.ownsSocket;
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
            const items = [...this.persistedSessions.values()].map((item) => ({
                agent: item.agent,
                sessionId: item.sessionId,
                paneId: item.paneId,
                cwd: item.cwd,
                tabId: item.tabId,
                workspaceId: item.workspaceId,
                title: item.title,
            }));
            const serialized = JSON.stringify(items, null, 2);
            if (serialized === this.lastSavedSessionsJson)
                return;
            atomicWriteFileSync(this.stateFile, serialized, 0o600);
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
    scheduleNextBridgePoll() {
        if (this.stopped)
            return;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        let interval;
        if (this.o.pollIntervalMs !== undefined) {
            interval = this.o.pollIntervalMs;
        }
        else if (this.consecutiveListFailures > 0) {
            const idx = Math.min(this.consecutiveListFailures - 1, HERDR_FAIL_BACKOFF_MS.length - 1);
            interval = HERDR_FAIL_BACKOFF_MS[idx];
        }
        else if (this.sessionsByKey.size === 0) {
            interval = HERDR_ZERO_SESSIONS_POLL_MS;
        }
        else {
            const hasActiveSession = [...this.sessionsByKey.values()].some((s) => s.discoveredInfo.status === "working" || s.discoveredInfo.status === "waiting_input");
            interval = hasActiveSession ? 2_500 : 5_000;
        }
        this.pollTimer = setTimeout(() => {
            void this.poll().finally(() => this.scheduleNextBridgePoll());
        }, interval);
        this.pollTimer.unref?.();
    }
    /** Wake the bridge poll loop immediately (e.g. after spawning a new Herdr session) and reschedule. */
    triggerPoll() {
        if (this.stopped)
            return Promise.resolve();
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        return this.poll().finally(() => this.scheduleNextBridgePoll());
    }
    start() {
        this.gate.start();
        void this.poll().finally(() => this.scheduleNextBridgePoll());
    }
    stop() {
        this.stopped = true;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.gate.stop();
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
            retireOnly: true,
        });
        this.retiringOrphans.add(orphan);
        orphan.closeFromHerdr("pane_closed");
        const t = setTimeout(() => {
            orphan.stop();
            this.retiringOrphans.delete(orphan);
        }, 5_000);
        t.unref?.();
    }
    async runPoll() {
        try {
            const env = this.o.herdrSession ? { HERDR_SESSION: this.o.herdrSession } : {};
            const res = await this.runner("herdr", ["agent", "list"], { timeoutMs: 5_000, env });
            if (this.stopped)
                return;
            if (res.code !== 0) {
                this.consecutiveListFailures += 1;
                if (!this.herdrListFailing) {
                    this.herdrListFailing = true;
                    const detail = (res.stderr || res.stdout || "").trim().slice(0, 200);
                    this.o.onLog?.(`herdr agent list failed (code=${res.code})${detail ? `: ${detail}` : ""}`);
                }
                return;
            }
            this.consecutiveListFailures = 0;
            if (this.herdrListFailing) {
                this.herdrListFailing = false;
                this.o.onLog?.("herdr agent list recovered");
            }
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
                    // If an on-demand fallback or previous session occupied this pane and was superseded,
                    // wait while it has open gate prompts so an active approval cannot be severed mid-flight.
                    let deferredByOpenGate = false;
                    const inheritedAllowed = [];
                    for (const [prevKey, prevSession] of this.sessionsByKey.entries()) {
                        if (prevKey !== key && prevSession.paneId === item.paneId && !discoveredKeys.has(prevKey)) {
                            if (prevSession.hasOpenGatePrompts()) {
                                deferredByOpenGate = true;
                                seenKeys.add(prevKey);
                                break;
                            }
                            for (const k of prevSession.allowed.keys())
                                inheritedAllowed.push(k);
                            prevSession.closeFromHerdr("pane_closed");
                            this.sessionsByKey.delete(prevKey);
                            this.missingPolls.delete(prevKey);
                            this.gateCreatedAt.delete(prevKey);
                            this.persistedSessions.delete(prevKey);
                        }
                    }
                    if (deferredByOpenGate)
                        continue;
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
            this.consecutiveListFailures += 1;
            this.o.onLog?.(`herdr bridge poll error: ${errMsg(e)}`);
        }
    }
    async handleGateApprovalRequest(req, signal) {
        const { conversationId, paneId, command } = req;
        const key = sanitizeIdPart(conversationId);
        let session = this.sessionsByKey.get(key);
        if (!session && paneId) {
            for (const existing of this.sessionsByKey.values()) {
                if (existing.paneId === paneId) {
                    session = existing;
                    break;
                }
            }
        }
        if (!session) {
            const cwd = Array.isArray(req.workspacePaths) && typeof req.workspacePaths[0] === "string"
                ? req.workspacePaths[0]
                : process.cwd();
            session = new BridgedAgentSession({
                agent: "agy",
                sessionId: conversationId,
                status: "working",
                cwd,
                paneId,
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
                onSessionClosedByCommand: (closedKey, closedPaneId) => {
                    if (closedPaneId) {
                        this.notifyPaneClosed(closedPaneId);
                    }
                    if (this.sessionsByKey.has(closedKey)) {
                        this.sessionsByKey.delete(closedKey);
                        this.missingPolls.delete(closedKey);
                        this.gateCreatedAt.delete(closedKey);
                        if (this.persistedSessions.delete(closedKey))
                            this.savePersistedSessions();
                    }
                },
            });
            this.sessionsByKey.set(key, session);
            this.gateCreatedAt.set(key, Date.now());
        }
        const mode = this.o.cfg.gate.mode === "auto-detect" || this.o.cfg.gate.mode === "off" ? "dangerous" : this.o.cfg.gate.mode;
        const dec = decide(mode, this.o.cfg.gate, compilePatterns(this.o.cfg.gate.dangerousPatterns), "bash", { command });
        const serverDanger = dec.danger === "high" || req.danger === "high" ? "high" : req.danger === "medium" || dec.danger === "medium" ? "medium" : "high";
        const serverKey = serverDanger === "high" ? `bash:${command.trim()}` : allowKey("bash", { command });
        return session.requestGateApproval({
            toolName: "bash",
            command,
            danger: serverDanger,
            key: serverKey,
            signal,
        });
    }
}
function collectSnapshotToolCallIds(entries) {
    const ids = new Set();
    for (const entry of entries) {
        if (entry.kind !== "assistant")
            continue;
        const content = entry.msg && typeof entry.msg === "object" ? entry.msg.content : null;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string") {
                ids.add(block.id);
            }
        }
    }
    return ids;
}
