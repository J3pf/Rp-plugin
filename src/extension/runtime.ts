// Per-session state: created in session_start, destroyed in session_shutdown (PLAN §5).
import os from "node:os";
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newId, type AgentHelloBody, type AgentStatus, type Envelope, type WelcomeBody } from "../shared/protocol.ts";
import { errMsg, preview } from "../shared/util.ts";
import type { RpConfig } from "./config.ts";
import { resolveInboxDir } from "./config.ts";
import type { StaticEnv, HerdrLocation } from "./environment.ts";
import { detectPiVersion, detectGentleVersion, detectActiveTheme, gentleVersionSupported, hasGentleAskTools, terminalStdin, toolNames, warnOnce } from "./compat.ts";
import { Connection, type ConnState, type TransportName } from "./connection.ts";
import { Forwarder, type ForwardedEvent } from "./forwarder.ts";
import { buildSnapshotEntries } from "./snapshot.ts";
import { StatusTracker } from "./status.ts";
import { HerdrBlocker, herdrHello } from "./herdr.ts";
import { Broker } from "./prompts/broker.ts";
import { Classifier } from "./prompts/classify.ts";
import { installMirror, type MirrorResult } from "./prompts/mirror.ts";
import { AdapterRegistry } from "./prompts/adapters/index.ts";
import { Gate, allowedFromBranch, effectiveMode, type EffectiveGateMode } from "./prompts/gate.ts";
import { askUserToolDefinition, shouldRegisterAskUser } from "./prompts/askUser.ts";
import { Deliverer } from "./delivery/index.ts";
import { normalizeText, type InteractiveDeps } from "./delivery/interactive.ts";
import { relayBlobFetcher } from "./attachments.ts";
import { routeInbound, pendingAnswers } from "./inbound.ts";
import { pluginVersion } from "./version.ts";

interface Waiter<T> {
  resolve: (v: T) => void;
}

export interface RuntimeDescription {
  agentId: string;
  instance: string;
  epoch: string;
  connected: boolean;
  state: ConnState;
  transport: TransportName;
  queued: number;
  openPrompts: number;
  launcher: string;
  herdr: HerdrLocation | null;
  gentle: { version: string | null; mode: string } | null;
  features: string[];
  gateMode: EffectiveGateMode;
  fatal: { code: number; reason: string } | null;
  preview: string;
}

export interface RuntimeOptions {
  /** Test seam: replace the connection. */
  connectionFactory?: (o: ConstructorParameters<typeof Connection>[0]) => Connection;
  detectTheme?: () => string | null;
}

export class Runtime {
  readonly instance = newId();
  readonly epoch = newId();
  readonly agentId: string;
  readonly sessionId: string;
  readonly conn: Connection;
  readonly broker: Broker;
  readonly statuses: StatusTracker;
  readonly classifier = new Classifier();
  readonly adapters: AdapterRegistry;
  readonly deliverer: Deliverer;
  readonly forwarder: Forwarder;
  readonly allowed: Set<string>;

  mirror: MirrorResult = { uninstall: () => {}, installed: false, dialogs: false };
  askUserRegistered = false;
  fatal: { code: number; reason: string } | null = null;

  private seq = 0;
  private disposed = false;
  private git: { branch: string | null; dirty: boolean } | null = null;
  private model: { provider: string; id: string } | null = null;
  private thinking: string | null = null;
  private dialogDepth = 0;
  private terminalWaits = 0;
  private dialogWaiters: Array<Waiter<boolean>> = [];
  private settledWaiters: Array<Waiter<void>> = [];
  private inputWaiters: Array<{ text: string; resolve: (v: boolean) => void; timer: NodeJS.Timeout }> = [];
  private gate: Gate;
  private herdrBlocker: HerdrBlocker;
  private everConnected = false;
  private lastCtx: ExtensionContext;
  private detectTheme: () => string | null;
  /** Static facts copied from ctx: reading a stale ctx (after reload/dispose) throws in Pi. */
  private info: { mode: string; cwd: string; hasUI: boolean; sessionFile: string | null; sessionName: string | null };

  constructor(
    readonly pi: ExtensionAPI,
    ctx: ExtensionContext,
    readonly cfg: RpConfig,
    readonly env: StaticEnv,
    readonly reason: string,
    opts: RuntimeOptions = {},
  ) {
    this.lastCtx = ctx;
    this.info = { mode: "print", cwd: process.cwd(), hasUI: false, sessionFile: null, sessionName: null };
    this.readInfo(ctx);
    this.sessionId = ctx.sessionManager.getSessionId();
    this.agentId = `${cfg.machineId}:${this.sessionId}`;
    this.allowed = allowedFromBranch(this.safeBranch());
    this.herdrBlocker = new HerdrBlocker(pi.events as any, !!env.herdr);
    this.detectTheme = opts.detectTheme ?? (() => detectActiveTheme());

    this.statuses = new StatusTracker(
      (status, detail) => this.conn.send("agent.status", { status, ...(detail ? { detail } : {}) }),
      (items) => this.conn.send("agent.statuses", { items }),
    );

    this.broker = new Broker({
      agentId: this.agentId,
      send: (t, d) => this.conn.send(t, d),
      hasUI: ctx.hasUI,
      classifier: this.classifier,
      herdr: this.herdrBlocker,
      onChange: () => this.updateWaiting(),
    });
    this.adapters = new AdapterRegistry(this.broker);

    this.forwarder = new Forwarder({
      redact: cfg.redactContent,
      send: (e) => this.emitEvent(e),
      onAgentStart: () => this.statuses.working(),
      onAgentSettled: () => {
        this.statuses.idle();
        void this.refreshGit();
        const w = this.settledWaiters.splice(0);
        for (const x of w) x.resolve();
      },
      onToolStart: (name, args) => this.statuses.working(`${name}${toolDetail(name, args)}`),
    });

    this.gate = new Gate({
      mode: () => this.gateMode(),
      cfg: () => this.cfg.gate,
      hasApprover: () => this.info.hasUI || this.conn.connected || this.conn.whenConnected(this.cfg.gate.approverWaitMs),
      askSelect: (title, options) => this.askSelect(title, options),
      askInput: (title, placeholder) => this.askInput(title, placeholder),
      toolInfo: (name) => this.toolInfo(name),
      persistAllow: (key) => {
        try {
          this.pi.appendEntry("rp.allow", { key });
        } catch {
          /* ignore */
        }
      },
      allowed: this.allowed,
    });

    this.deliverer = new Deliverer({
      pi,
      ctx: () => this.lastCtx,
      cfg: () => this.cfg,
      herdr: env.herdr,
      gentleMode: () => this.statuses.gentleMode,
      gentlePresent: () => !!this.gentleInfo(),
      fetchBlob: cfg.relayUrl && cfg.machineToken ? relayBlobFetcher(cfg.relayUrl, cfg.machineToken) : null,
      inboxDir: () => resolveInboxDir(cfg),
      sessionId: () => this.sessionId,
      interactive: () => this.interactiveDeps(),
      sendAck: (ack) => this.conn.send("user.message.ack", ack),
      notify: (m, l) => this.notify(m, l),
    });

    const connOpts: ConstructorParameters<typeof Connection>[0] = {
      relayUrl: cfg.relayUrl!,
      token: cfg.machineToken!,
      agentId: this.agentId,
      instance: this.instance,
      makeHello: () => this.makeHello(),
      onWelcome: (w) => this.onWelcome(w),
      onMessage: (env) => this.onRelayMessage(env),
      onState: (s, t, d) => this.onConnState(s, t, d),
      onFatal: (code, reason) => this.onFatal(code, reason),
    };
    this.conn = opts.connectionFactory ? opts.connectionFactory(connOpts) : new Connection(connOpts);
  }

  // ---------- lifecycle ----------

  start(): void {
    const ctx = this.lastCtx;
    this.adapters.enabled = this.adaptersAllowed();
    // always installed (setStatus is observed for agent.statuses); dialogs are patched only when mirrorDialogs is on
    this.mirror = installMirror(ctx, this.broker, this.adapters, this.statuses, { dialogs: this.cfg.mirrorDialogs });
    this.maybeRegisterAskUser();
    this.model = ctx.model ? { provider: (ctx.model as any).provider, id: (ctx.model as any).id } : null;
    this.thinking = ctx.thinkingLevel ?? null;
    const theme = this.detectTheme();
    if (theme) this.statuses.observe("pi:theme", theme);
    void this.refreshGit();
    this.conn.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.broker.shutdown();
      this.herdrBlocker.releaseAll();
      this.forwarder.dispose();
      this.statuses.dispose();
      this.mirror.uninstall();
      for (const w of this.inputWaiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(false);
      }
      for (const w of this.dialogWaiters.splice(0)) w.resolve(false);
      for (const w of this.settledWaiters.splice(0)) w.resolve();
      try {
        this.lastCtx.ui.setStatus("rp", undefined);
      } catch {
        /* ctx may be stale */
      }
    } finally {
      // give the socket a tick to flush prompt.resolved before closing
      await new Promise((r) => setTimeout(r, 50));
      this.conn.stop();
    }
  }

  touch(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    this.readInfo(ctx);
  }

  private readInfo(ctx: ExtensionContext): void {
    try {
      this.info = {
        mode: ctx.mode,
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        sessionName: ctx.sessionManager.getSessionName() ?? null,
      };
    } catch {
      /* stale ctx: keep the last known values */
    }
  }

  // ---------- Pi → relay ----------

  forward(name: ForwardedEvent, ev: any, ctx: ExtensionContext): void {
    if (this.disposed) return;
    this.touch(ctx);
    if (name === "model_select" && ev?.model) this.model = { provider: ev.model.provider, id: ev.model.id };
    if (name === "thinking_level_select") this.thinking = ev?.level ?? null;
    if (name === "session_compact") this.statuses.setCompacting(false);
    try {
      this.forwarder.handle(name, ev);
    } catch {
      /* forwarding must never break Pi */
    }
  }

  onCompactStart(): void {
    this.statuses.setCompacting(true);
  }

  private emitEvent(e: Record<string, unknown>): void {
    this.seq++;
    this.conn.send("agent.event", { epoch: this.epoch, seq: this.seq, e });
  }

  async onToolCall(ev: any, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    if (this.disposed) return undefined;
    this.touch(ctx);
    try {
      return await this.gate.onToolCall(ev);
    } catch (e) {
      return { block: true, reason: `RP gate error: ${errMsg(e)}` };
    }
  }

  onInput(ev: any, ctx: ExtensionContext): void {
    this.touch(ctx);
    if (ev?.source !== "interactive") return;
    const text = normalizeText(String(ev.text ?? ""));
    const i = this.inputWaiters.findIndex((w) => w.text === text);
    if (i >= 0) {
      const [w] = this.inputWaiters.splice(i, 1);
      clearTimeout(w!.timer);
      w!.resolve(true);
    }
  }

  /** ui_prompt_start / ui_prompt_end: any blocking dialog (also ones we do not mirror). */
  terminalWait(ev: any, active: boolean): void {
    if (this.disposed) return;
    if (active) this.dialogDepth++;
    else this.dialogDepth = Math.max(0, this.dialogDepth - 1);
    if (this.dialogDepth === 0) for (const w of this.dialogWaiters.splice(0)) w.resolve(true);
    const kind = ev?.kind;
    if ((kind === "custom" || kind === "editor") && !this.broker.hasAdapterPrompt()) {
      this.terminalWaits = Math.max(0, this.terminalWaits + (active ? 1 : -1));
      this.updateWaiting();
      this.emitEvent({ type: "terminal_wait", kind, title: ev?.title ?? null, active });
    }
  }

  private updateWaiting(): void {
    this.statuses.setWaiting(this.broker.openCount + this.terminalWaits);
  }

  // ---------- relay → Pi ----------

  private onRelayMessage(env: Envelope): void {
    routeInbound(env, {
      userMessage: (b) => void this.deliverer.handle(b),
      abort: () => {
        try {
          this.lastCtx.abort();
        } catch {
          /* ignore */
        }
      },
      promptAnswer: (id, answer) => void this.broker.handleAnswer(id, answer),
      promptCancel: (id) => this.broker.handleCancel(id),
      resync: () => this.sendSnapshot(false),
      error: (code, message) => this.log(`relay error ${code}: ${message}`),
    });
  }

  private onWelcome(w: WelcomeBody): void {
    this.sendSnapshot(true);
    this.conn.sendDirect("agent.status", { status: this.statuses.current });
    const items = this.statuses.snapshot();
    if (Object.keys(items).length) this.conn.sendDirect("agent.statuses", { items });
    this.conn.needsSnapshot = false;
    for (const p of pendingAnswers(w)) this.broker.handleAnswer(p.promptId, p.answer);
  }

  private sendSnapshot(direct: boolean): void {
    const { entries, truncated } = buildSnapshotEntries(this.safeBranch(), this.cfg.redactContent);
    const body = { epoch: this.epoch, seq: this.seq, entries, truncated };
    if (direct) this.conn.sendDirect("agent.snapshot", body);
    else this.conn.send("agent.snapshot", body);
  }

  private safeBranch(): any[] {
    try {
      return this.lastCtx.sessionManager.getBranch() as any[];
    } catch {
      return [];
    }
  }

  // ---------- hello ----------

  gentleInfo(): { version: string | null; mode: string } | null {
    const present = hasGentleAskTools(this.pi) || this.statuses.sawGentleStatus;
    if (!present) return null;
    return { version: detectGentleVersion(this.pi), mode: this.statuses.gentleMode ?? "unknown" };
  }

  features(): string[] {
    const f = ["attachments", "statuses"];
    if (this.mirror.dialogs) f.push("mirror_ui");
    if (this.adapters.enabled && this.gentleInfo()) f.push("adapters:gentle-ask");
    if (this.gateMode() !== "off") f.push("gate");
    if (this.askUserRegistered) f.push("rp_ask_user");
    if (this.info.mode === "tui" && this.cfg.delivery.interactive) f.push("deliver_terminal");
    if (this.env.herdr) f.push("deliver_herdr");
    return f;
  }

  makeHello(): AgentHelloBody {
    const { mode, cwd, sessionFile, sessionName } = this.info;
    const gentle = this.gentleInfo();
    return {
      agentId: this.agentId,
      kind: "pi",
      instance: this.instance,
      epoch: this.epoch,
      pi: { version: detectPiVersion(), mode },
      plugin: { version: pluginVersion(), features: this.features() },
      session: { id: this.sessionId, file: sessionFile, name: sessionName },
      host: { hostname: os.hostname(), user: safeUser(), pid: process.pid, os: process.platform },
      launcher: this.env.launcher,
      herdr: herdrHello(this.env.herdr),
      gentle: gentle ? { version: gentle.version, mode: gentle.mode } : null,
      transport: this.conn?.transportName ?? "ws",
      redacted: this.cfg.redactContent,
      cwd,
      spawnId: this.env.spawnId ?? spawnIdFlag(this.pi),
      git: this.git ?? { branch: null, dirty: false },
      model: this.model,
      thinking: this.thinking,
      status: this.statuses.current as AgentStatus,
      openPrompts: this.broker.openPrompts(),
    };
  }

  private refreshGit(): Promise<void> {
    const cwd = this.info.cwd;
    const run = (args: string[]) =>
      new Promise<string | null>((resolve) =>
        execFile("git", args, { cwd, timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim())),
      );
    return (async () => {
      const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === null) {
        this.git = null;
        return;
      }
      const status = await run(["status", "--porcelain"]);
      this.git = { branch, dirty: !!status };
    })();
  }

  // ---------- dialogs helpers used by gate / rp_ask_user ----------

  private askSelect(title: string, options: string[]): Promise<string | undefined> {
    const ctx = this.lastCtx;
    if (this.info.hasUI && this.mirror.dialogs) return ctx.ui.select(title, options);
    if (this.info.hasUI) return this.broker.race({ kind: "select", title, options }, (signal) => ctx.ui.select(title, options, { signal }));
    return this.broker.race<string | undefined>({ kind: "select", title, options }, null);
  }

  private askInput(title: string, placeholder?: string): Promise<string | undefined> {
    const ctx = this.lastCtx;
    if (this.info.hasUI && this.mirror.dialogs) return ctx.ui.input(title, placeholder);
    if (this.info.hasUI) return this.broker.race({ kind: "input", title, placeholder }, (signal) => ctx.ui.input(title, placeholder, { signal }));
    return this.broker.race<string | undefined>({ kind: "input", title, placeholder }, null);
  }

  private maybeRegisterAskUser(): void {
    try {
      if (!shouldRegisterAskUser(toolNames(this.pi))) return;
      this.pi.registerTool(
        askUserToolDefinition(() => (this.disposed ? null : { askSelect: (t, o) => this.askSelect(t, o), askInput: (t, p) => this.askInput(t, p) })) as any,
      );
      this.askUserRegistered = true;
    } catch (e) {
      this.log(`rp_ask_user not registered: ${errMsg(e)}`);
    }
  }

  private gateMode(): EffectiveGateMode {
    const gentle = hasGentleAskTools(this.pi) || this.statuses.sawGentleStatus;
    return effectiveMode(this.cfg.gate.mode, gentle);
  }

  private safeIdle(): boolean {
    try {
      return this.lastCtx.isIdle();
    } catch {
      return true;
    }
  }

  private toolInfo(name: string) {
    try {
      return this.pi.getAllTools().find((t) => t.name === name) as any;
    } catch {
      return undefined;
    }
  }

  private adaptersAllowed(): boolean {
    const v = detectGentleVersion(this.pi);
    if (v === null) return true; // shape guards in each adapter protect us
    if (!gentleVersionSupported(v)) {
      warnOnce(this.lastCtx, "gentle-range", `RP: gentle-pi ${v} fuera del rango probado (>=4.0 <5); las preguntas de ask_user_* se notificarán como "esperando en la terminal".`);
      return false;
    }
    return true;
  }

  // ---------- interactive delivery wiring ----------

  private interactiveDeps(): InteractiveDeps {
    return {
      ctx: () => this.lastCtx,
      stdin: () => terminalStdin(),
      dialogOpen: () => this.dialogDepth > 0,
      waitNoDialog: (maxMs) =>
        new Promise<boolean>((resolve) => {
          if (this.dialogDepth === 0) return resolve(true);
          const t = setTimeout(() => {
            const i = this.dialogWaiters.indexOf(w);
            if (i >= 0) this.dialogWaiters.splice(i, 1);
            resolve(false);
          }, maxMs);
          t.unref?.();
          const w: Waiter<boolean> = {
            resolve: (v) => {
              clearTimeout(t);
              resolve(v);
            },
          };
          this.dialogWaiters.push(w);
        }),
      waitSettled: () => new Promise<void>((resolve) => (this.safeIdle() ? resolve() : this.settledWaiters.push({ resolve }))),
      expectInput: (text, ms) =>
        new Promise<boolean>((resolve) => {
          const norm = normalizeText(text);
          const timer = setTimeout(() => {
            const i = this.inputWaiters.findIndex((w) => w.timer === timer);
            if (i >= 0) this.inputWaiters.splice(i, 1);
            resolve(false);
          }, ms);
          timer.unref?.();
          this.inputWaiters.push({ text: norm, resolve, timer });
        }),
      statuses: () => this.statuses.snapshot(),
      enabled: () => this.cfg.delivery.interactive,
    };
  }

  // ---------- connection state ----------

  private onConnState(state: ConnState, transport: TransportName, detail?: string): void {
    try {
      const ui = this.lastCtx.ui;
      if (state === "connected") {
        this.everConnected = true;
        ui.setStatus("rp", transport === "longpoll" ? "📱~" : "📱");
      } else if (state === "connecting") {
        if (this.everConnected) ui.setStatus("rp", "RP …");
      } else if (state === "stopped" && this.fatal) {
        ui.setStatus("rp", "RP ✗");
      }
    } catch {
      /* stale ctx */
    }
    if (detail) this.log(`${state}: ${detail}`);
  }

  private onFatal(code: number, reason: string): void {
    this.fatal = { code, reason };
    const why =
      code === 4001 ? "credenciales inválidas o revocadas; vuelve a emparejar con /rp pair" : code === 4002 ? "versión de protocolo incompatible; actualiza @j3pf/pi-rp o el relay" : "otra instancia abrió la misma sesión";
    this.notify(`RP desconectado (${code}): ${why}`, "warning");
    try {
      this.lastCtx.ui.setStatus("rp", "RP ✗");
    } catch {
      /* ignore */
    }
  }

  notify(msg: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      this.lastCtx.ui.notify(msg, level);
    } catch {
      /* ignore */
    }
  }

  private log(m: string): void {
    if (process.env.RP_DEBUG) process.stderr.write(`[rp] ${m}\n`);
  }

  // ---------- introspection for /rp status ----------

  describe(): RuntimeDescription {
    return {
      agentId: this.agentId,
      instance: this.instance,
      epoch: this.epoch,
      connected: this.conn.connected,
      state: this.conn.state,
      transport: this.conn.transportName,
      queued: this.conn.queued,
      openPrompts: this.broker.openCount,
      launcher: this.env.launcher,
      herdr: this.env.herdr,
      gentle: this.gentleInfo(),
      features: this.features(),
      gateMode: this.gateMode(),
      fatal: this.fatal,
      preview: preview(this.sessionId),
    };
  }
}

function toolDetail(_name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const v = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "";
  return v ? `: ${preview(v, 60)}` : "";
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}

function spawnIdFlag(pi: ExtensionAPI): string | null {
  try {
    const v = pi.getFlag("rp-spawn-id");
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
