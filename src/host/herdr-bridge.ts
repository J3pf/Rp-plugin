// Herdr + Antigravity CLI (agy) bridge for rp-host.
// Discovers non-Pi agents running in Herdr, bridges their transcripts/panes to Rp-relay,
// delivers prompts/aborts via Herdr CLI, and serves PreToolUse permission gating for agy.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Connection } from "../extension/connection.ts";
import { resolveInboxDir, type RpConfig } from "../extension/config.ts";
import { relayBlobFetcher, resolveAttachments } from "../extension/attachments.ts";
import { routeInbound, pendingAnswers } from "../extension/inbound.ts";
import { Broker } from "../extension/prompts/broker.ts";
import { Classifier, promptContext } from "../extension/prompts/classify.ts";
import { ALLOW, ALLOW_SESSION, DENY, DENY_REASON, allowKey, compilePatterns, decide } from "../extension/prompts/gate.ts";
import { pluginVersion } from "../extension/version.ts";
import { parseJson, pick } from "./backends/herdr.ts";
import { run as realRun, type Runner } from "./runner.ts";
import { AgyTranscriptReader, resolveAgyTranscriptPath, type ContextUsageInfo } from "./agy-transcript.ts";
import { readGitHeadAndDirty } from "./git.ts";
import {
  parseTerminalContextUsage,
  readExternalAgentContextUsage,
  readExternalAgentModel,
  readExternalAgentModelWithState,
} from "./bridge/external-metadata.ts";
import {
  AGY_GATE_SOCKET_TIMEOUT_MS,
  GATE_MAX_LINE_BYTES,
  gateSocketPath,
  installAgyHooks,
  probeUnixSocketAlive,
  runAgyHook,
  sanitizeIdPart,
  signGatePayload,
  verifyGateSignature,
} from "./bridge/agy-hooks.ts";
import { configDir } from "../shared/platform.ts";
import {
  encodeHerdrTabId,
  newId,
  type AgentClosedReason,
  type AgentHelloBody,
  type AgentStatus,
  type DeliveryError,
  type Envelope,
  type UserMessageBody,
  type WelcomeBody,
} from "../shared/protocol.ts";
import { LruSet, SAFE_CONV_ID_RE, errMsg, safeUser, stripAnsi, truncateBytes } from "../shared/util.ts";

export {
  gateSocketPath,
  installAgyHooks,
  parseTerminalContextUsage,
  readExternalAgentContextUsage,
  readExternalAgentModel,
  runAgyHook,
};

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

const CONV_RE = /--conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const OPTIMISTIC_WORKING_MS = 8_000;

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

interface BridgedSessionDeps {
  relayUrl: string;
  machineId: string;
  token: string;
  cfg: RpConfig;
  herdrSession: string | null;
  runner: Runner;
  onLog?: (msg: string) => void;
  connectionFactory?: (o: ConstructorParameters<typeof Connection>[0]) => Connection;
  startDelayMs?: number;
  retireOnly?: boolean;
  onSessionClosedByCommand?: (sessionKey: string, paneId: string) => void;
}

export class BridgedAgentSession {
  readonly instance = newId();
  readonly epoch = newId();
  readonly sessionKey: string;
  readonly agentId: string;
  readonly allowed = new LruSet(1000);
  readonly broker: Broker;
  readonly conn: Connection;

  private seq = 0;
  private disposed = false;
  private git: { branch: string | null; dirty: boolean } | null = null;
  private gitInFlight: Promise<void> | null = null;
  private transcriptReader: AgyTranscriptReader | null = null;
  private lastTerminalSnapshot = "";
  private lastTerminalSnapshotTs = 0;
  private initialFallbackDone = false;
  private initialSnapshotSent = false;
  private lastStateSeq = -1;
  private startTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private lastSentName = "";
  private lastSentTabId: string | null = null;
  private lastSentContextSpec = "";
  private lastSentModelId = "";
  private externalContextUsage: ContextUsageInfo | null = null;
  private currentStatus: AgentStatus;
  private lastEmittedStatus: AgentStatus;
  private optimisticWorkingUntilMs = 0;
  private optimisticTimer: NodeJS.Timeout | null = null;
  private fallbackTurnTs = 0;
  private commandTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private reconnectDebounce: NodeJS.Timeout | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private seenClientMsgIds = new LruSet(500);
  private lastActiveTask: string | null = null;

  constructor(
    private info: HerdrDiscoveredAgent,
    private d: BridgedSessionDeps,
  ) {
    const rawKey = info.sessionId || `pane-${info.paneId}`;
    this.sessionKey = sanitizeIdPart(rawKey);
    this.agentId = `${d.machineId}:herdr:${this.sessionKey}`;
    this.currentStatus = info.status;
    this.lastEmittedStatus = info.status;

    if (!d.retireOnly && info.agent === "agy" && info.sessionId) {
      try {
        const canonical = resolveAgyTranscriptPath(info.sessionId);
        this.transcriptReader = new AgyTranscriptReader(canonical, () => this.d.cfg.redactContent);
      } catch {
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
        if (!this.disposed) this.conn.start();
      }, d.startDelayMs);
      this.startTimer.unref?.();
    } else {
      this.conn.start();
    }
  }

  get conversationId(): string | null {
    return this.info.sessionId;
  }

  get paneId(): string {
    return this.info.paneId;
  }

  get discoveredInfo(): HerdrDiscoveredAgent {
    return { ...this.info };
  }

  hasOpenGatePrompts(): boolean {
    return this.broker.openCount > 0;
  }

  getContextUsage(): ContextUsageInfo | null {
    return this.transcriptReader?.getContextUsage() ?? this.externalContextUsage;
  }

  private encodedTabId(): string | null {
    return encodeHerdrTabId({
      tabId: this.info.tabId,
      orderIndex: this.info.orderIndex,
      isDone: this.effectiveStatus() === "done",
      context: this.getContextUsage(),
    });
  }

  private syncContextIfChanged(direct = false): void {
    const ctx = this.getContextUsage();
    if (!ctx || ctx.tokens <= 0 || ctx.contextWindow <= 0) return;
    const spec = `${ctx.tokens}/${ctx.contextWindow}`;
    const nextTab = this.encodedTabId();
    if (spec !== this.lastSentContextSpec) {
      this.lastSentContextSpec = spec;
      if (direct) {
        this.conn.sendDirect("agent.statuses", { items: { "rp:context": spec } });
      } else {
        this.conn.send("agent.statuses", { items: { "rp:context": spec } });
      }
    }
    if (this.conn.connected && this.initialSnapshotSent && nextTab !== this.lastSentTabId) {
      this.conn.sendDirect("agent.hello", this.makeHello());
    }
  }

  private sessionDisplayName(): string {
    if (this.d.cfg.redactContent) return "[redacted]";
    const base = path.basename(this.info.cwd || "") || this.info.paneId;
    const topic = this.transcriptReader?.getSessionTopic();
    if (topic) return `${base} · ${topic}`;
    return `${base} (${this.info.agent})`;
  }

  private syncSessionNameIfChanged(): void {
    const nextName = this.sessionDisplayName();
    if (nextName && nextName !== this.lastSentName) {
      this.lastSentName = nextName;
      this.sendEvent({ type: "session_info_changed", name: nextName });
    }
  }

  private syncModelIfChanged(): void {
    if (!this.conn.connected || !this.initialSnapshotSent) return;
    const { model: nextModel, uncertain } = readExternalAgentModelWithState(
      this.info.agent,
      this.info.cwd,
      this.info.sessionId,
    );
    if (uncertain || !nextModel.id || nextModel.id === this.lastSentModelId) return;
    this.lastSentModelId = nextModel.id;
    this.conn.sendDirect("agent.hello", this.makeHello());
    this.sendEvent({ type: "model_select", model: nextModel });
  }

  private effectiveStatus(): AgentStatus {
    if (this.broker.openCount > 0) return "waiting_input";
    if ((this.currentStatus === "idle" || this.currentStatus === "done") && Date.now() < this.optimisticWorkingUntilMs) {
      return "working";
    }
    return this.currentStatus;
  }

  private clearOptimisticWorking(): void {
    this.optimisticWorkingUntilMs = 0;
    if (this.optimisticTimer) {
      clearTimeout(this.optimisticTimer);
      this.optimisticTimer = null;
    }
  }

  private armOptimisticWorking(): void {
    this.optimisticWorkingUntilMs = Date.now() + OPTIMISTIC_WORKING_MS;
    if (this.optimisticTimer) clearTimeout(this.optimisticTimer);
    this.optimisticTimer = setTimeout(() => {
      this.optimisticTimer = null;
      this.reconcileStatus();
    }, OPTIMISTIC_WORKING_MS + 50);
    this.optimisticTimer.unref?.();
  }

  private syncStatus(): void {
    if (this.disposed) return;
    const status = this.effectiveStatus();
    const detail = status === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
    this.lastActiveTask = detail;
    this.lastEmittedStatus = status;
    this.conn.send("agent.status", { status, ...(detail ? { detail } : {}) });
    this.scheduleNextPoll();
  }

  private reconcileStatus(): void {
    if (this.disposed) return;
    const prev = this.lastEmittedStatus;
    const next = this.effectiveStatus();
    const nextTask = next === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
    if (next === prev && nextTask === this.lastActiveTask) return;
    this.syncStatus();
    if (next === "working" && prev !== "working") {
      this.sendEvent({ type: "agent_start" });
    } else if (prev === "working" && (next === "idle" || next === "done")) {
      void this.pollTranscriptNow();
      void this.refreshGit();
      this.sendEvent({ type: "agent_settled", aborted: false });
    }
  }

  updateFromHerdr(next: HerdrDiscoveredAgent): void {
    const prevCwd = this.info.cwd;
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
      } catch {
        /* ignore invalid sessionId */
      }
    }

    if (next.status !== "idle" && next.status !== "done") {
      this.clearOptimisticWorking();
    }

    const prevTab = this.encodedTabId();
    const prevEmitted = this.lastEmittedStatus;
    this.info = { ...this.info, ...next };
    this.currentStatus = next.status;
    const nextTab = this.encodedTabId();

    if (this.conn.connected && prevTab !== nextTab && this.initialSnapshotSent) {
      this.conn.sendDirect("agent.hello", this.makeHello());
    }

    if (
      this.conn.connected &&
      (this.info.workspaceId !== prevWorkspace || this.info.paneId !== prevPane)
    ) {
      if (this.reconnectDebounce) clearTimeout(this.reconnectDebounce);
      this.reconnectDebounce = setTimeout(() => {
        this.reconnectDebounce = null;
        if (!this.disposed) this.conn.reconnectNow();
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

  makeHello(): AgentHelloBody {
    const subagents = this.transcriptReader?.getSubagents() ?? [];
    const name = this.sessionDisplayName();
    this.lastSentName = name;
    const encodedTab = this.encodedTabId();
    this.lastSentTabId = encodedTab;
    const rawBranch = this.git?.branch ?? null;
    const gitDirty = this.git?.dirty ?? false;
    const formattedBranch =
      rawBranch && gitDirty && !rawBranch.endsWith(" *") ? `${rawBranch} *` : rawBranch;
    const model = readExternalAgentModel(this.info.agent, this.info.cwd, this.info.sessionId);
    this.lastSentModelId = model.id;
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

  private onWelcome(w: WelcomeBody): void {
    const canSkipSnapshot =
      this.initialSnapshotSent &&
      !this.conn.needsSnapshot &&
      typeof w.lastSeq === "number" &&
      w.lastSeq >= 0;
    if (!canSkipSnapshot) {
      this.sendSnapshot(true);
    }
    const status = this.effectiveStatus();
    const detail = status === "working" ? (this.transcriptReader?.getActiveTask() ?? null) : null;
    this.lastActiveTask = detail;
    this.lastEmittedStatus = status;
    this.conn.sendDirect("agent.status", { status, ...(detail ? { detail } : {}) });
    this.syncContextIfChanged(true);
    this.conn.needsSnapshot = false;
    for (const p of pendingAnswers(w)) this.broker.handleAnswer(p.promptId, p.answer);
  }

  private sendSnapshot(direct: boolean): void {
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
        this.conn.dropQueuedEventsUpTo(this.seq);
        this.conn.sendDirect("agent.snapshot", { ...body, seq: this.seq });
        for (const ev of events) {
          if (ev.type === "subagent_update") this.sendEvent(ev);
        }
      } else {
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
      entries:
        !this.d.cfg.redactContent && this.lastTerminalSnapshot && entryAt
          ? [
              {
                eid: "pane:latest",
                kind: "assistant" as const,
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
      this.conn.dropQueuedEventsUpTo(this.seq);
      this.conn.sendDirect("agent.snapshot", { ...body, seq: this.seq });
    } else {
      this.conn.send("agent.snapshot", body);
    }
  }

  private sendEvent(e: Record<string, unknown>): void {
    if (this.disposed) return;
    this.seq += 1;
    this.conn.send("agent.event", { epoch: this.epoch, seq: this.seq, e });
  }

  private setupFileWatcher(): void {
    if (this.watcher || !this.transcriptReader) return;
    const dir = path.dirname(this.transcriptReader.transcriptPath);
    if (!fs.existsSync(dir)) return;
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (this.disposed) return;
        if (filename && filename !== "transcript.jsonl") return;
        if (this.watchDebounce) return;
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = null;
          void this.pollTranscriptNow();
        }, 150);
        this.watchDebounce.unref?.();
      });
      this.watcher.on("error", () => {
        try {
          this.watcher?.close();
        } catch {
          /* ignore */
        }
        this.watcher = null;
      });
    } catch {
      /* fallback to timer */
    }
  }

  private scheduleNextPoll(): void {
    if (this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const isWorking = this.effectiveStatus() === "working";
    const delayMs = isWorking ? 900 : this.watcher ? 15_000 : 4_500;
    this.pollTimer = setTimeout(() => {
      void this.pollTranscriptNow().finally(() => this.scheduleNextPoll());
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private startTranscriptPolling(): void {
    this.setupFileWatcher();
    this.scheduleNextPoll();
  }

  pollTranscriptNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pollInFlight) return this.pollInFlight;
    const p = (async () => {
      try {
        if (this.transcriptReader) {
          if (!this.watcher) this.setupFileWatcher();
          const prevOffset = this.transcriptReader.byteOffset;
          const events = this.transcriptReader.pollNewEvents();
          const offsetAdvanced = this.transcriptReader.byteOffset !== prevOffset;
          let shouldRefreshGit = false;
          for (const ev of events) {
            this.sendEvent(ev);
            if (
              ev.type === "tool_execution_end" &&
              (ev.toolName === "edit" || ev.toolName === "write" || ev.toolName === "bash")
            ) {
              shouldRefreshGit = true;
            }
          }
          if (offsetAdvanced || events.length > 0) {
            this.syncSessionNameIfChanged();
            this.syncContextIfChanged();
            this.syncModelIfChanged();
          }
          if (events.length > 0) {
            if (this.effectiveStatus() === "working") {
              const nextTask = this.transcriptReader.getActiveTask();
              if (nextTask !== this.lastActiveTask) {
                this.syncStatus();
              }
            }
            if (shouldRefreshGit) {
              void this.refreshGit();
            }
          }
          return;
        }
        const extUsage = readExternalAgentContextUsage(
          this.info.agent,
          this.info.cwd,
          this.info.sessionId,
          this.lastTerminalSnapshot,
        );
        if (extUsage) {
          this.externalContextUsage = extUsage;
          this.syncContextIfChanged();
        }
        await this.pollPaneFallback();
      } catch (e) {
        this.d.onLog?.(`poll transcript error: ${errMsg(e)}`);
      }
    })().finally(() => {
      if (this.pollInFlight === p) this.pollInFlight = null;
    });
    this.pollInFlight = p;
    return p;
  }

  private async pollPaneFallback(commandText?: string): Promise<void> {
    if (this.disposed || !this.info.paneId || this.d.cfg.redactContent) return;
    if (this.initialFallbackDone && !commandText && this.effectiveStatus() !== "working") return;
    try {
      const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
        timeoutMs: 3_000,
        env: this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {},
      });
      if (res.code !== 0) return;
      const parsed = parseJson(res.stdout);
      const rawText = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
      const text = stripAnsi(rawText).trim();
      if (!text) return;
      const snippet = extractRecentCommandOutput(text, commandText);
      const termUsage = readExternalAgentContextUsage(this.info.agent, this.info.cwd, this.info.sessionId, text);
      if (termUsage) {
        this.externalContextUsage = termUsage;
        this.syncContextIfChanged();
      }
      this.syncModelIfChanged();
      if (snippet === this.lastTerminalSnapshot) return;
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
    } catch {
      /* ignore */
    }
  }

  private async handleTermCommand(rawCommand: string, env: Record<string, string>): Promise<void> {
    if (this.disposed || !this.info.paneId || this.d.cfg.redactContent) return;
    const arg = rawCommand.slice(5).trim().toLowerCase();
    try {
      if (arg) {
        if (arg === "enter") {
          await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 3_000, env });
        } else if (arg === "esc" || arg === "escape") {
          await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Escape"], { timeoutMs: 3_000, env });
        } else if (arg === "ctrl+c" || arg === "c-c") {
          await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "C-c"], { timeoutMs: 3_000, env });
        } else if (arg === "tab") {
          await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Tab"], { timeoutMs: 3_000, env });
        } else if (arg === "y" || arg === "n") {
          await this.d.runner("herdr", ["pane", "send-text", this.info.paneId, arg], { timeoutMs: 3_000, env });
          await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 3_000, env });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
        timeoutMs: 3_000,
        env,
      });
      if (this.disposed) return;
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
        const rawText: string = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
        const cleaned = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
        const lines = cleaned
          .split(/\r?\n/)
          .map((l) => l.trimEnd())
          .filter((l, idx, arr) => l.length > 0 || (idx > 0 && arr[idx - 1]!.length > 0));
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
    } catch {
      /* ignore */
    }
  }

  private onRelayMessage(env: Envelope): void {
    routeInbound(env, {
      userMessage: (b) => void this.handleUserMessage(b),
      abort: () => void this.handleAbort(),
      promptAnswer: (id, answer) => void this.broker.handleAnswer(id, answer),
      promptCancel: (id) => this.broker.handleCancel(id),
      resync: () => this.sendSnapshot(false),
      error: (code, message) => this.d.onLog?.(`[${this.agentId}] relay error ${code}: ${message}`),
    });
  }

  private handleUserMessage(b: UserMessageBody): Promise<void> {
    const run = this.deliveryTail.then(
      () => this.deliverUserMessage(b),
      () => this.deliverUserMessage(b),
    );
    this.deliveryTail = run.catch(() => {});
    return run;
  }

  private async deliverUserMessage(b: UserMessageBody): Promise<void> {
    if (this.disposed) return;
    const sendAck = (
      disposition: "typed" | "command" | "rejected",
      method: "herdr",
      error: DeliveryError = null,
    ) =>
      this.conn.send("user.message.ack", {
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
      if (att.lines.length) text = (text ? text + "\n\n" : "") + att.lines.join("\n");
    }
    text = text.trim();
    if (!text) return sendAck("rejected", "herdr", "herdr_unavailable");

    const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
    if (b.asCommand && (text === "/quit" || text === "/exit")) {
      if (b.clientMsgId) this.seenClientMsgIds.add(b.clientMsgId);
      sendAck("command", "herdr", null);
      if (this.info.paneId) {
        try {
          await this.d.runner("herdr", ["pane", "close", this.info.paneId], { timeoutMs: 5_000, env });
        } catch {
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
      if (b.clientMsgId) this.seenClientMsgIds.add(b.clientMsgId);
      sendAck("command", "herdr", null);
      await this.handleTermCommand(text, env as Record<string, string>);
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
      } else {
        const sendRes = await this.d.runner("herdr", ["pane", "send-text", this.info.paneId, ...textArgs], { timeoutMs: 5_000, env });
        if (sendRes.code !== 0) return sendAck("rejected", "herdr", "herdr_unavailable");
        await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 5_000, env });
      }
      if (b.clientMsgId) this.seenClientMsgIds.add(b.clientMsgId);
      this.fallbackTurnTs = 0;
      this.lastTerminalSnapshot = "";
      this.lastTerminalSnapshotTs = Date.now();
      this.initialFallbackDone = true;
      this.armOptimisticWorking();
      this.reconcileStatus();
      void this.pollTranscriptNow();
      sendAck(b.asCommand ? "command" : "typed", "herdr", null);

      if (this.commandTimer) clearTimeout(this.commandTimer);
      this.commandTimer = setTimeout(async () => {
        this.commandTimer = null;
        if (this.disposed) return;
        if (this.transcriptReader) {
          const prevOffset = this.transcriptReader.byteOffset;
          const events = this.transcriptReader.pollNewEvents();
          const offsetAdvanced = this.transcriptReader.byteOffset !== prevOffset;
          if (events.length > 0) {
            for (const ev of events) this.sendEvent(ev);
          }
          if (offsetAdvanced || events.length > 0) {
            this.syncSessionNameIfChanged();
            this.syncContextIfChanged();
            this.syncModelIfChanged();
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
      }, 800);
      this.commandTimer.unref?.();
      return;
    } catch {
      return sendAck("rejected", "herdr", "herdr_unavailable");
    }
  }

  private async handleAbort(): Promise<void> {
    if (!this.info.paneId) return;
    const env = this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {};
    try {
      await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Escape"], { timeoutMs: 3_000, env });
      await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "C-c"], { timeoutMs: 3_000, env });
    } catch {
      /* ignore */
    }
  }

  /** Ask the mobile phone to approve/deny a PreToolUse tool execution in agy. */
  async requestGateApproval(req: {
    toolName: string;
    command: string;
    danger: "low" | "medium" | "high";
    key: string;
    signal: AbortSignal;
  }): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }> {
    if (this.disposed) return { decision: "ask", reason: "RP: sesión cerrada; confirmar en terminal" };
    if (this.allowed.has(req.key)) return { decision: "allow" };
    if (!this.conn.connected && !(await this.conn.whenConnected(this.d.cfg.gate.approverWaitMs))) {
      return { decision: "ask", reason: "RP: sin conexión al relay; confirmar en terminal" };
    }

    const displayCmd = this.d.cfg.redactContent ? "[redacted]" : req.command;
    const summary = displayCmd.length > 120 ? displayCmd.slice(0, 119) + "…" : displayCmd;
    const title = `⚠ ${req.toolName}: ${summary}`;
    try {
      const choice = await promptContext.run(
        {
          category: "permission",
          danger: req.danger,
          tool: { name: req.toolName, args: this.d.cfg.redactContent ? { redacted: true } : { command: req.command } },
          message: displayCmd,
          source: { extension: "rp", tool: "agy-gate" },
        },
        () =>
          this.broker.race<string | undefined>(
            {
              kind: "select",
              title,
              options: [ALLOW, ALLOW_SESSION, DENY, DENY_REASON],
              opts: { timeout: 270_000, signal: req.signal },
            },
            null,
          ),
      );

      if (choice === ALLOW) return { decision: "allow" };
      if (choice === ALLOW_SESSION) {
        this.allowed.add(req.key);
        return { decision: "allow" };
      }
      if (choice === DENY_REASON) {
        const reason = await promptContext.run(
          { category: "question", danger: "low", source: { extension: "rp", tool: "agy-gate" } },
          () =>
            this.broker.race<string | undefined>(
              {
                kind: "input",
                title: "Motivo de la denegación",
                placeholder: "Explica por qué se deniega",
                opts: { timeout: 60_000, signal: req.signal },
              },
              null,
            ),
        );
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
    } catch (e) {
      return { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` };
    }
  }

  private refreshGit(): Promise<void> {
    const cwd = this.info.cwd;
    if (!cwd) return Promise.resolve();
    if (this.gitInFlight) return this.gitInFlight;
    const prevBranch = this.git?.branch ?? null;
    const prevDirty = this.git?.dirty ?? false;
    const p = (async () => {
      const next = (await readGitHeadAndDirty(cwd, false)) ?? { branch: null, dirty: false };
      if (this.disposed) return;
      this.git = next;
      if (this.conn.connected && (next.branch !== prevBranch || next.dirty !== prevDirty)) {
        this.conn.sendDirect("agent.hello", this.makeHello());
      }
    })().finally(() => {
      if (this.gitInFlight === p) this.gitInFlight = null;
    });
    this.gitInFlight = p;
    return p;
  }

  closeFromHerdr(reason: AgentClosedReason = "pane_closed", graceMs = 250): void {
    if (this.disposed || this.closeTimer) return;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.conn.start();
    }
    const finishClose = () => {
      if (this.disposed || this.closeTimer) return;
      this.conn.sendDirect("agent.closed", { reason });
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        this.stop();
      }, graceMs);
      this.closeTimer.unref?.();
    };
    if (this.conn.connected) {
      finishClose();
    } else {
      void this.conn.whenConnected(3_000).then((ok) => {
        if (ok) finishClose();
        else this.stop();
      });
    }
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearOptimisticWorking();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.reconnectDebounce) clearTimeout(this.reconnectDebounce);
    this.reconnectDebounce = null;
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = null;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    this.broker.shutdown();
    this.conn.stop();
  }
}

export interface HerdrBridgeOptions {
  relayUrl: string;
  machineId: string;
  token: string;
  cfg: RpConfig;
  herdrSession: string | null;
  runner?: Runner;
  pollIntervalMs?: number;
  socketPath?: string;
  stateFile?: string | null;
  panelSortMode?: HerdrPanelSortMode;
  onLog?: (msg: string) => void;
  connectionFactory?: (o: ConstructorParameters<typeof Connection>[0]) => Connection;
}

export class HerdrAgentBridge {
  private sessionsByKey = new Map<string, BridgedAgentSession>();
  private missingPolls = new Map<string, number>();
  private gateCreatedAt = new Map<string, number>();
  private closedPanesUntil = new Map<string, number>();
  private persistedSessions = new Map<string, HerdrDiscoveredAgent>();
  private retiringOrphans = new Set<BridgedAgentSession>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollPromise: Promise<void> | null = null;
  private stopped = false;
  private gateServer: net.Server | null = null;
  private clientSockets = new Set<net.Socket>();
  private runner: Runner;
  private sockPath: string;
  private stateFile: string | null;
  private lastSavedSessionsJson = "";

  constructor(private o: HerdrBridgeOptions) {
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

  private loadPersistedSessions(): void {
    if (!this.stateFile) return;
    try {
      const arr = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (!item || typeof item !== "object" || typeof item.paneId !== "string" || typeof item.agent !== "string") continue;
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
    } catch {
      /* first run or missing state file */
    }
  }

  private savePersistedSessions(): void {
    if (!this.stateFile) return;
    try {
      const items = [...this.persistedSessions.values()];
      const serialized = JSON.stringify(items, null, 2);
      if (serialized === this.lastSavedSessionsJson) return;
      const dir = path.dirname(this.stateFile);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, serialized, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
      this.lastSavedSessionsJson = serialized;
    } catch {
      /* best effort */
    }
  }

  /** Immediately close and suppress any bridged session running in `paneId` when closed via rp-host. */
  notifyPaneClosed(paneId: string): void {
    if (!paneId) return;
    this.closedPanesUntil.set(paneId, Date.now() + 10_000);
    let changed = false;
    for (const [key, session] of this.sessionsByKey.entries()) {
      if (session.paneId === paneId) {
        session.closeFromHerdr("pane_closed");
        this.sessionsByKey.delete(key);
        this.missingPolls.delete(key);
        this.gateCreatedAt.delete(key);
        if (this.persistedSessions.delete(key)) changed = true;
      }
    }
    if (changed) this.savePersistedSessions();
  }

  private scheduleNextBridgePoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const hasActiveSession = [...this.sessionsByKey.values()].some(
      (s) => s.discoveredInfo.status === "working" || s.discoveredInfo.status === "waiting_input",
    );
    const interval = this.o.pollIntervalMs ?? (hasActiveSession ? 2_500 : 5_000);
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.scheduleNextBridgePoll());
    }, interval);
    this.pollTimer.unref?.();
  }

  start(): void {
    this.startGateServer();
    void this.poll().finally(() => this.scheduleNextBridgePoll());
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.gateServer) {
      try {
        this.gateServer.close();
      } catch {
        /* ignore */
      }
      this.gateServer = null;
    }
    for (const socket of this.clientSockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clientSockets.clear();
    if (process.platform !== "win32" && fs.existsSync(this.sockPath)) {
      try {
        fs.unlinkSync(this.sockPath);
      } catch {
        /* ignore */
      }
    }
    for (const s of this.sessionsByKey.values()) s.stop();
    this.sessionsByKey.clear();
    for (const s of this.retiringOrphans) s.stop();
    this.retiringOrphans.clear();
    this.missingPolls.clear();
    this.gateCreatedAt.clear();
    this.closedPanesUntil.clear();
  }

  getActiveSessions(): BridgedAgentSession[] {
    return [...this.sessionsByKey.values()];
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.runPoll().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  private retireOrphanSession(info: HerdrDiscoveredAgent): void {
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

  private async runPoll(): Promise<void> {
    try {
      const env = this.o.herdrSession ? { HERDR_SESSION: this.o.herdrSession } : {};
      const res = await this.runner("herdr", ["agent", "list"], { timeoutMs: 5_000, env });
      if (this.stopped || res.code !== 0) return;

      const now = Date.now();
      for (const [paneId, until] of this.closedPanesUntil.entries()) {
        if (now >= until) this.closedPanesUntil.delete(paneId);
      }

      const sortMode = this.o.panelSortMode ?? readHerdrPanelSortMode();
      const discovered = sortHerdrAgentsForDisplay(
        parseHerdrAgentList(res.stdout).filter((item) => {
          const until = this.closedPanesUntil.get(item.paneId);
          return !until || now >= until;
        }),
        sortMode,
      );

      const discoveredKeys = new Set(
        discovered.map((item) => sanitizeIdPart(item.sessionId || `pane-${item.paneId}`)),
      );
      const seenKeys = new Set<string>();
      let newCount = 0;

      for (let idx = 0; idx < discovered.length; idx++) {
        const item: HerdrDiscoveredAgent = { ...discovered[idx]!, orderIndex: idx + 1 };
        const key = sanitizeIdPart(item.sessionId || `pane-${item.paneId}`);
        seenKeys.add(key);
        this.missingPolls.delete(key);

        const existing = this.sessionsByKey.get(key);
        if (existing) {
          existing.updateFromHerdr(item);
        } else {
          // If an on-demand fallback or previous session occupied this pane and was superseded,
          // wait while it has open gate prompts so an active approval cannot be severed mid-flight.
          let deferredByOpenGate = false;
          const inheritedAllowed: string[] = [];
          for (const [prevKey, prevSession] of this.sessionsByKey.entries()) {
            if (prevKey !== key && prevSession.paneId === item.paneId && !discoveredKeys.has(prevKey)) {
              if (prevSession.hasOpenGatePrompts()) {
                deferredByOpenGate = true;
                seenKeys.add(prevKey);
                break;
              }
              for (const k of prevSession.allowed.keys()) inheritedAllowed.push(k);
              prevSession.closeFromHerdr("pane_closed");
              this.sessionsByKey.delete(prevKey);
              this.missingPolls.delete(prevKey);
              this.gateCreatedAt.delete(prevKey);
              this.persistedSessions.delete(prevKey);
            }
          }
          if (deferredByOpenGate) continue;
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
          for (const k of inheritedAllowed) session.allowed.add(k);
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
        if (session.broker.openCount > 0 || gateAge < 30_000) continue;
        const misses = (this.missingPolls.get(key) ?? 0) + 1;
        if (misses >= 2) {
          session.closeFromHerdr("pane_closed");
          this.sessionsByKey.delete(key);
          this.missingPolls.delete(key);
          this.gateCreatedAt.delete(key);
          this.persistedSessions.delete(key);
        } else {
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
    } catch (e) {
      this.o.onLog?.(`herdr bridge poll error: ${errMsg(e)}`);
    }
  }

  private bindGateServer(): void {
    if (this.stopped) return;
    const server = net.createServer((socket) => {
      this.clientSockets.add(socket);
      socket.setEncoding("utf8");
      const ac = new AbortController();
      socket.setTimeout(AGY_GATE_SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.on("close", () => {
        this.clientSockets.delete(socket);
        ac.abort();
      });
      socket.on("error", () => {
        this.clientSockets.delete(socket);
        ac.abort();
      });

      let buf = "";
      socket.on("data", (chunk: string) => {
        if (buf.length + chunk.length > GATE_MAX_LINE_BYTES) {
          socket.destroy();
          return;
        }
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
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
        } catch {
          /* ignore */
        }
      }
    });
    server.unref?.();
    this.gateServer = server;
  }

  private startGateServer(): void {
    try {
      if (process.platform !== "win32") {
        const sockDir = path.dirname(this.sockPath);
        fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
        try {
          fs.chmodSync(sockDir, 0o700);
        } catch {
          /* ignore */
        }
        if (fs.existsSync(this.sockPath)) {
          void probeUnixSocketAlive(this.sockPath).then((alive) => {
            if (this.stopped) return;
            if (alive) {
              this.o.onLog?.(`gate socket already held by another live process: ${this.sockPath}`);
              return;
            }
            try {
              fs.rmSync(this.sockPath, { force: true });
            } catch {
              /* ignore */
            }
            this.bindGateServer();
          });
          return;
        }
      }
      this.bindGateServer();
    } catch (e) {
      this.o.onLog?.(`failed to start gate socket: ${errMsg(e)}`);
    }
  }

  private signGateResponse(
    resp: { decision: "allow" | "deny" | "ask"; reason?: string },
    nonce: string,
  ): { decision: "allow" | "deny" | "ask"; reason?: string; sig?: string } {
    const sig = signGatePayload(this.o.token, ["res", resp.decision, resp.reason ?? "", nonce]);
    return sig ? { ...resp, sig } : resp;
  }

  private async handleGateSocketRequest(
    rawLine: string,
    signal: AbortSignal,
  ): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string; sig?: string }> {
    let req: any;
    try {
      req = JSON.parse(rawLine);
    } catch {
      return { decision: "ask", reason: "RP: solicitud de autorización inválida (JSON malformado)" };
    }
    const nonce = typeof req?.nonce === "string" ? req.nonce : "";
    const conversationId = typeof req?.conversationId === "string" ? req.conversationId : "";
    const command = typeof req?.command === "string" ? req.command : "";
    const paneId = typeof req?.paneId === "string" ? req.paneId : "";
    if (!verifyGateSignature(this.o.token, ["req", conversationId, paneId, command, nonce], req?.sig)) {
      return this.signGateResponse(
        { decision: "ask", reason: "RP: solicitud de gate no autenticada; confirmar en terminal" },
        nonce,
      );
    }
    if (!conversationId || !SAFE_CONV_ID_RE.test(conversationId) || !command) {
      return this.signGateResponse({ decision: "ask", reason: "RP: solicitud de autorización incompleta" }, nonce);
    }

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
      const cwd = Array.isArray(req.workspacePaths) && typeof req.workspacePaths[0] === "string" ? req.workspacePaths[0] : process.cwd();
      session = new BridgedAgentSession(
        {
          agent: "agy",
          sessionId: conversationId,
          status: "working",
          cwd,
          paneId,
          tabId: null,
          workspaceId: null,
          title: null,
          stateChangeSeq: 0,
        },
        {
          relayUrl: this.o.relayUrl,
          machineId: this.o.machineId,
          token: this.o.token,
          cfg: this.o.cfg,
          herdrSession: this.o.herdrSession,
          runner: this.runner,
          onLog: this.o.onLog,
          connectionFactory: this.o.connectionFactory,
        },
      );
      this.sessionsByKey.set(key, session);
      this.gateCreatedAt.set(key, Date.now());
    }

    const mode = this.o.cfg.gate.mode === "auto-detect" || this.o.cfg.gate.mode === "off" ? "dangerous" : this.o.cfg.gate.mode;
    const dec = decide(mode, this.o.cfg.gate, compilePatterns(this.o.cfg.gate.dangerousPatterns), "bash", { command });
    const serverDanger = dec.danger === "high" || req.danger === "high" ? "high" : req.danger === "medium" || dec.danger === "medium" ? "medium" : "high";
    const serverKey = serverDanger === "high" ? `bash:${command.trim()}` : allowKey("bash", { command });

    try {
      const decision = await session.requestGateApproval({
        toolName: "bash",
        command,
        danger: serverDanger,
        key: serverKey,
        signal,
      });
      return this.signGateResponse(decision, nonce);
    } catch (e) {
      return this.signGateResponse(
        { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` },
        nonce,
      );
    }
  }
}
