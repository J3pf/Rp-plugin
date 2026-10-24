// Herdr + Antigravity CLI (agy) bridge for rp-host.
// Discovers non-Pi agents running in Herdr, bridges their transcripts/panes to Rp-relay,
// delivers prompts/aborts via Herdr CLI, and serves PreToolUse permission gating for agy.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
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
import { AgyTranscriptReader, parseAgyArgs, resolveAgyTranscriptPath } from "./agy-transcript.ts";
import { configDir } from "../shared/platform.ts";
import {
  newId,
  type AgentHelloBody,
  type AgentStatus,
  type Envelope,
  type UserMessageBody,
  type WelcomeBody,
} from "../shared/protocol.ts";
import { LruSet, errMsg, safeUser, truncateBytes } from "../shared/util.ts";

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
}

const CONV_RE = /--conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function mapHerdrAgentStatus(rawStatus: string | null | undefined): AgentStatus {
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

function sanitizeIdPart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}

export function gateSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const user = sanitizeIdPart(safeUser());
    return `\\\\.\\pipe\\rp-agy-gate-${user}`;
  }
  return path.join(configDir(env, platform), "agy-gate.sock");
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
  private transcriptReader: AgyTranscriptReader | null = null;
  private lastTerminalSnapshot = "";
  private lastTerminalSnapshotTs = 0;
  private initialFallbackDone = false;
  private lastStateSeq = -1;
  private startTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private lastSentName = "";
  private currentStatus: AgentStatus;
  private optimisticWorkingUntilMs = 0;
  private fallbackTurnTs = 0;
  private commandTimer: NodeJS.Timeout | null = null;

  constructor(
    private info: HerdrDiscoveredAgent,
    private d: BridgedSessionDeps,
    transcriptOverride?: string,
  ) {
    const rawKey = info.sessionId || `pane-${info.paneId}`;
    this.sessionKey = sanitizeIdPart(rawKey);
    this.agentId = `${d.machineId}:herdr:${this.sessionKey}`;
    this.currentStatus = info.status;

    if (info.agent === "agy" && info.sessionId) {
      try {
        const canonical = resolveAgyTranscriptPath(info.sessionId);
        const tPath = transcriptOverride && path.resolve(transcriptOverride) === canonical ? canonical : canonical;
        this.transcriptReader = new AgyTranscriptReader(tPath, () => this.d.cfg.redactContent);
      } catch {
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
        if (!this.disposed) this.conn.start();
      }, d.startDelayMs);
      this.startTimer.unref?.();
    } else {
      this.conn.start();
    }
    this.startTranscriptPolling();
  }

  get conversationId(): string | null {
    return this.info.sessionId;
  }

  get paneId(): string {
    return this.info.paneId;
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

  private effectiveStatus(): AgentStatus {
    if (this.broker.openCount > 0) return "waiting_input";
    if (this.currentStatus === "idle" && Date.now() < this.optimisticWorkingUntilMs) {
      return "working";
    }
    return this.currentStatus;
  }

  private syncStatus(): void {
    if (this.disposed) return;
    this.conn.send("agent.status", { status: this.effectiveStatus() });
    this.scheduleNextPoll();
  }

  updateFromHerdr(next: HerdrDiscoveredAgent): void {
    const prevCwd = this.info.cwd;
    const prevStatus = this.effectiveStatus();
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

    if (next.status !== "idle") {
      this.optimisticWorkingUntilMs = 0;
    }

    this.info = { ...this.info, ...next };
    this.currentStatus = next.status;

    if (prevCwd !== next.cwd) {
      void this.refreshGit();
    }
    if (this.effectiveStatus() !== prevStatus) {
      this.syncStatus();
      if (this.effectiveStatus() === "working") {
        this.sendEvent({ type: "agent_start" });
      } else if (prevStatus === "working" && this.effectiveStatus() === "idle") {
        void this.pollTranscriptNow();
        this.sendEvent({ type: "agent_settled", aborted: false });
      }
    } else if (seqChanged) {
      void this.pollTranscriptNow();
    }
  }

  makeHello(): AgentHelloBody {
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
        tabId: this.info.tabId,
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

  private onWelcome(w: WelcomeBody): void {
    this.sendSnapshot(true);
    this.conn.sendDirect("agent.status", { status: this.effectiveStatus() });
    this.conn.needsSnapshot = false;
    for (const p of pendingAnswers(w)) this.broker.handleAnswer(p.promptId, p.answer);
  }

  private sendSnapshot(direct: boolean): void {
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
        this.conn.sendDirect("agent.snapshot", body);
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
    if (direct) this.conn.sendDirect("agent.snapshot", body);
    else this.conn.send("agent.snapshot", body);
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
    const delayMs = this.effectiveStatus() === "working" ? 900 : 4_500;
    this.pollTimer = setTimeout(() => {
      void this.pollTranscriptNow();
      this.scheduleNextPoll();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private startTranscriptPolling(): void {
    this.setupFileWatcher();
    this.scheduleNextPoll();
  }

  async pollTranscriptNow(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.transcriptReader) {
        if (!this.watcher) this.setupFileWatcher();
        const events = this.transcriptReader.pollNewEvents();
        for (const ev of events) {
          this.sendEvent(ev);
        }
        if (events.length > 0) this.syncSessionNameIfChanged();
        return;
      }
      await this.pollPaneFallback();
    } catch (e) {
      this.d.onLog?.(`poll transcript error: ${errMsg(e)}`);
    }
  }

  private async pollPaneFallback(commandText?: string): Promise<void> {
    if (this.disposed || !this.info.paneId || this.d.cfg.redactContent) return;
    try {
      const res = await this.d.runner("herdr", ["pane", "read", "--source", "recent", "--lines", "60", this.info.paneId], {
        timeoutMs: 3_000,
        env: this.d.herdrSession ? { HERDR_SESSION: this.d.herdrSession } : {},
      });
      if (res.code !== 0) return;
      const parsed = parseJson(res.stdout);
      const rawText = (typeof parsed?.result?.text === "string" ? parsed.result.text : res.stdout).trim();
      const text = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
      if (!text) return;
      const snippet = extractRecentCommandOutput(text, commandText);
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

  private async handleUserMessage(b: UserMessageBody): Promise<void> {
    const ack = (status: "delivered" | "rejected", error: "agent_blocked" | "herdr_unavailable" | null = null) =>
      this.conn.send("user.message.ack", {
        clientMsgId: b.clientMsgId,
        disposition: status === "delivered" ? (b.asCommand ? "command" : "typed") : "rejected",
        ...(status === "delivered" ? { method: "herdr" as const } : {}),
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
      if (att.lines.length) text = (text ? text + "\n\n" : "") + att.lines.join("\n");
    }
    text = text.trim();
    if (!text) return ack("rejected", "herdr_unavailable");

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
      if (sendRes.code !== 0) return ack("rejected", "herdr_unavailable");
      await this.d.runner("herdr", ["pane", "send-keys", this.info.paneId, "Enter"], { timeoutMs: 5_000, env });
      markWorkingOnDelivery();
      ack("delivered");

      if (b.asCommand) {
        // Local TUI commands (e.g. /usage, /statusline, /help) execute directly in the CLI terminal
        // without creating entries in transcript.jsonl. If no transcript events arrive within 800ms,
        // read the output directly from the pane and settle so the mobile chat displays the result.
        if (this.commandTimer) clearTimeout(this.commandTimer);
        this.commandTimer = setTimeout(async () => {
          this.commandTimer = null;
          if (this.disposed) return;
          if (this.transcriptReader) {
            const events = this.transcriptReader.pollNewEvents();
            if (events.length > 0) {
              for (const ev of events) this.sendEvent(ev);
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
    } catch {
      return ack("rejected", "herdr_unavailable");
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
    return new Promise((resolve) => {
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2_000 }, (err, stdout) => {
        if (this.disposed) return resolve();
        if (err) {
          this.git = { branch: null, dirty: false };
          return resolve();
        }
        const branch = stdout.trim() || null;
        execFile("git", ["status", "--porcelain", "-uno"], { cwd, timeout: 2_000 }, (err2, stdout2) => {
          if (!this.disposed) this.git = { branch, dirty: !err2 && stdout2.trim().length > 0 };
          resolve();
        });
      });
    });
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
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
  onLog?: (msg: string) => void;
  connectionFactory?: (o: ConstructorParameters<typeof Connection>[0]) => Connection;
}

export class HerdrAgentBridge {
  private sessionsByKey = new Map<string, BridgedAgentSession>();
  private missingPolls = new Map<string, number>();
  private gateCreatedAt = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollPromise: Promise<void> | null = null;
  private stopped = false;
  private gateServer: net.Server | null = null;
  private clientSockets = new Set<net.Socket>();
  private runner: Runner;
  private sockPath: string;

  constructor(private o: HerdrBridgeOptions) {
    this.runner = o.runner ?? realRun;
    this.sockPath = o.socketPath ?? gateSocketPath();
  }

  start(): void {
    this.startGateServer();
    void this.poll();
    const interval = this.o.pollIntervalMs ?? 3_000;
    this.pollTimer = setInterval(() => void this.poll(), interval);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
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
    this.missingPolls.clear();
    this.gateCreatedAt.clear();
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

  private async runPoll(): Promise<void> {
    try {
      const env = this.o.herdrSession ? { HERDR_SESSION: this.o.herdrSession } : {};
      const res = await this.runner("herdr", ["agent", "list"], { timeoutMs: 5_000, env });
      if (this.stopped || res.code !== 0) return;

      const discovered = parseHerdrAgentList(res.stdout);
      const activityOf = (item: HerdrDiscoveredAgent): number => {
        if (item.agent === "agy" && item.sessionId) {
          try {
            return fs.statSync(resolveAgyTranscriptPath(item.sessionId)).mtimeMs || 0;
          } catch {
            return 0;
          }
        }
        return 0;
      };
      // Sort oldest-first so that on initial startup, the most recently active session connects last and gets the highest lastSeenAt
      discovered.sort((a, b) => activityOf(a) - activityOf(b));

      const seenKeys = new Set<string>();
      let newCount = 0;

      for (const item of discovered) {
        const key = sanitizeIdPart(item.sessionId || `pane-${item.paneId}`);
        seenKeys.add(key);
        this.missingPolls.delete(key);

        const existing = this.sessionsByKey.get(key);
        if (existing) {
          existing.updateFromHerdr(item);
        } else {
          // If an on-demand session was created by paneId first and now got a sessionId, migrate it
          const paneFallbackKey = sanitizeIdPart(`pane-${item.paneId}`);
          const paneFallback = key !== paneFallbackKey ? this.sessionsByKey.get(paneFallbackKey) : undefined;
          if (paneFallback) {
            paneFallback.stop();
            this.sessionsByKey.delete(paneFallbackKey);
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
          });
          if (paneFallback) {
            for (const k of paneFallback.allowed.keys()) session.allowed.add(k);
          }
          this.sessionsByKey.set(key, session);
        }
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
          session.stop();
          this.sessionsByKey.delete(key);
          this.missingPolls.delete(key);
          this.gateCreatedAt.delete(key);
        } else {
          this.missingPolls.set(key, misses);
        }
      }
    } catch (e) {
      this.o.onLog?.(`herdr bridge poll error: ${errMsg(e)}`);
    }
  }

  private startGateServer(): void {
    try {
      if (process.platform !== "win32") {
        fs.mkdirSync(path.dirname(this.sockPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
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
    } catch (e) {
      this.o.onLog?.(`failed to start gate socket: ${errMsg(e)}`);
    }
  }

  private async handleGateSocketRequest(
    rawLine: string,
    signal: AbortSignal,
  ): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }> {
    let req: any;
    try {
      req = JSON.parse(rawLine);
    } catch {
      return { decision: "ask", reason: "RP: solicitud de autorización inválida (JSON malformado)" };
    }
    const conversationId = typeof req?.conversationId === "string" ? req.conversationId : "";
    const command = typeof req?.command === "string" ? req.command : "";
    if (!conversationId || !/^[0-9a-zA-Z_][0-9a-zA-Z_-]{0,127}$/.test(conversationId) || !command) {
      return { decision: "ask", reason: "RP: solicitud de autorización incompleta" };
    }

    const key = sanitizeIdPart(conversationId);
    let session = this.sessionsByKey.get(key);
    if (!session) {
      const cwd = Array.isArray(req.workspacePaths) && typeof req.workspacePaths[0] === "string" ? req.workspacePaths[0] : process.cwd();
      session = new BridgedAgentSession(
        {
          agent: "agy",
          sessionId: conversationId,
          status: "working",
          cwd,
          paneId: typeof req.paneId === "string" ? req.paneId : "",
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
        typeof req.transcriptPath === "string" ? req.transcriptPath : undefined,
      );
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
    } catch (e) {
      return { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` };
    }
  }
}

/**
 * Executed by Antigravity CLI on `PreToolUse` (`rp-host agy-hook PreToolUse`).
 * MUST write exactly one JSON object to stdout and exit 0.
 */
export async function runAgyHook(
  cfg: RpConfig,
  stdinText: string,
  sockPath = gateSocketPath(),
): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }> {
  if (!cfg.enabled) return { decision: "ask" };
  let payload: any;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return { decision: "ask", reason: "RP: entrada de hook inválida (JSON malformado)" };
  }
  const rawToolName = String(payload?.toolCall?.name ?? "");
  if (rawToolName !== "run_command") return { decision: "allow" };

  const args = parseAgyArgs(payload?.toolCall?.args ?? payload?.toolCall?.arguments);
  const command = String(args.CommandLine ?? args.command ?? args.commandLine ?? args.cmd ?? "").trim();
  if (!command) return { decision: "ask", reason: "RP: comando no identificado; confirmar en terminal" };

  const mode = cfg.gate.mode === "auto-detect" ? "dangerous" : cfg.gate.mode;
  if (mode === "off") return { decision: "ask" };

  const patterns = compilePatterns(cfg.gate.dangerousPatterns);
  const dec = decide(mode, cfg.gate, patterns, "bash", { command });
  if (!dec.ask) return { decision: "allow" };

  const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : "";
  if (!conversationId) return { decision: "ask", reason: "RP: comando peligroso detectado" };

  return new Promise((resolve) => {
    const client = net.createConnection(sockPath);
    let settled = false;
    const finish = (res: { decision: "allow" | "deny" | "ask"; reason?: string }) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
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
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buf.slice(0, nl).trim());
        if (parsed?.decision === "allow" || parsed?.decision === "deny" || parsed?.decision === "ask") {
          finish(parsed);
          return;
        }
      } catch {
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
export function installAgyHooks(
  nodePath: string,
  scriptPath: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const hooksFile = path.join(home, ".gemini", "config", "hooks.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  } catch {
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
