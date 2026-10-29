// Per-session state: created in session_start, destroyed in session_shutdown (PLAN §5).
import os from "node:os";
import { execFile } from "node:child_process";
import { newId } from "../shared/protocol.js";
import { parseTodoTasks, redactTodoTasks, replayTodoBranch } from "./todos.js";
import { errMsg, preview, safeUser } from "../shared/util.js";
import { resolveInboxDir } from "./config.js";
import { detectPiVersion, detectGentleVersion, detectActiveTheme, gentleVersionSupported, hasGentleAskTools, terminalStdin, toolNames, warnOnce } from "./compat.js";
import { Connection } from "./connection.js";
import { Forwarder } from "./forwarder.js";
import { buildSnapshotEntries } from "./snapshot.js";
import { StatusTracker } from "./status.js";
import { HerdrBlocker, herdrHello } from "./herdr.js";
import { Broker } from "./prompts/broker.js";
import { Classifier } from "./prompts/classify.js";
import { installMirror } from "./prompts/mirror.js";
import { AdapterRegistry } from "./prompts/adapters/index.js";
import { Gate, allowedFromBranch, effectiveMode } from "./prompts/gate.js";
import { askUserToolDefinition, shouldRegisterAskUser } from "./prompts/askUser.js";
import { Deliverer } from "./delivery/index.js";
import { normalizeText } from "./delivery/interactive.js";
import { relayBlobFetcher } from "./attachments.js";
import { routeInbound, pendingAnswers } from "./inbound.js";
import { pluginVersion } from "./version.js";
import { SubagentTracker } from "./subagents.js";
import { CommTracker } from "./comm.js";
export class Runtime {
    pi;
    cfg;
    env;
    reason;
    instance = newId();
    epoch = newId();
    agentId;
    sessionId;
    conn;
    broker;
    statuses;
    classifier = new Classifier();
    adapters;
    deliverer;
    forwarder;
    subagents;
    comm;
    allowed;
    mirror = { uninstall: () => { }, installed: false, dialogs: false };
    askUserRegistered = false;
    fatal = null;
    currentTodos = [];
    seq = 0;
    disposed = false;
    git = null;
    model = null;
    thinking = null;
    dialogDepth = 0;
    terminalWaits = 0;
    dialogWaiters = [];
    settledWaiters = [];
    inputWaiters = [];
    gate;
    herdrBlocker;
    everConnected = false;
    lastCtx;
    detectTheme;
    /** Static facts copied from ctx: reading a stale ctx (after reload/dispose) throws in Pi. */
    info;
    constructor(pi, ctx, cfg, env, reason, opts = {}) {
        this.pi = pi;
        this.cfg = cfg;
        this.env = env;
        this.reason = reason;
        this.lastCtx = ctx;
        this.info = { mode: "print", cwd: process.cwd(), hasUI: false, sessionFile: null, sessionName: null };
        this.readInfo(ctx);
        this.sessionId = ctx.sessionManager.getSessionId();
        this.agentId = `${cfg.machineId}:${this.sessionId}`;
        this.allowed = allowedFromBranch(this.safeBranch());
        this.currentTodos = replayTodoBranch(this.safeBranch());
        this.herdrBlocker = new HerdrBlocker(pi.events, !!env.herdr);
        this.detectTheme = opts.detectTheme ?? (() => detectActiveTheme());
        this.statuses = new StatusTracker((status, detail) => this.conn.send("agent.status", { status, ...(detail ? { detail } : {}) }), (items) => {
            const filtered = this.filterStatuses(items);
            if (Object.keys(filtered).length || !this.cfg.redactContent) {
                this.conn.send("agent.statuses", { items: filtered });
            }
        });
        this.broker = new Broker({
            agentId: this.agentId,
            send: (t, d) => this.conn.send(t, d),
            hasUI: ctx.hasUI,
            classifier: this.classifier,
            herdr: this.herdrBlocker,
            redact: () => this.cfg.redactContent,
            onChange: () => this.updateWaiting(),
        });
        this.adapters = new AdapterRegistry(this.broker);
        this.subagents = new SubagentTracker({
            emit: (event) => this.emitEvent(event),
            isRedacted: () => this.cfg.redactContent,
        });
        this.comm = new CommTracker({
            emit: (event) => this.emitEvent(event),
            isRedacted: () => this.cfg.redactContent,
        });
        this.forwarder = new Forwarder({
            redact: cfg.redactContent,
            send: (e) => this.emitEvent(e),
            onAgentStart: () => this.statuses.working(),
            onAgentSettled: (aborted) => {
                this.comm.onAgentSettled(aborted);
                this.statuses.idle();
                void this.refreshGit();
                const w = this.settledWaiters.splice(0);
                for (const x of w)
                    x.resolve();
            },
            onToolStart: (name, args, toolCallId, parentToolCallId) => {
                this.statuses.working(`${name}${this.cfg.redactContent ? "" : toolDetail(name, args)}`);
                this.comm.onToolStart(name, args, toolCallId);
                this.subagents.onToolStart(name, args, toolCallId, parentToolCallId);
            },
            onToolEnd: (name, result, isError, toolCallId, durationMs, parentToolCallId) => {
                this.comm.onToolEnd(name, result, isError, toolCallId);
                if (name === "todo" && !isError) {
                    const tasks = parseTodoTasks(result?.details ?? result);
                    if (tasks) {
                        this.currentTodos = tasks;
                        this.emitEvent({
                            type: "todo_update",
                            tasks: this.cfg.redactContent ? redactTodoTasks(tasks) : tasks,
                        });
                    }
                }
                this.subagents.onToolEnd(name, result, isError, toolCallId, durationMs, parentToolCallId);
            },
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
                }
                catch {
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
            askSelect: (title, options) => this.askSelect(title, options),
            onThinkingSelected: (level) => {
                if (this.thinking !== level) {
                    const previousLevel = this.thinking ?? undefined;
                    this.thinking = level;
                    this.forwarder.handle("thinking_level_select", { level, previousLevel });
                }
            },
        });
        const connOpts = {
            relayUrl: cfg.relayUrl,
            token: cfg.machineToken,
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
    start() {
        const ctx = this.lastCtx;
        this.comm.reset();
        this.comm.seedSeen(this.safeBranch());
        this.adapters.enabled = this.adaptersAllowed();
        // always installed (setStatus is observed for agent.statuses); dialogs are patched only when mirrorDialogs is on
        this.mirror = installMirror(ctx, this.broker, this.adapters, this.statuses, { dialogs: this.cfg.mirrorDialogs });
        this.maybeRegisterAskUser();
        this.model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
        this.thinking = ctx.thinkingLevel ?? null;
        const theme = this.detectTheme();
        if (theme)
            this.statuses.observe("pi:theme", theme);
        void this.refreshGit();
        this.conn.start();
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const hadOpenPrompts = this.broker.openCount > 0;
        this.comm.reset();
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
            for (const w of this.dialogWaiters.splice(0))
                w.resolve(false);
            for (const w of this.settledWaiters.splice(0))
                w.resolve();
            try {
                this.lastCtx.ui.setStatus("rp", undefined);
            }
            catch {
                /* ctx may be stale */
            }
        }
        finally {
            if (hadOpenPrompts) {
                // give the socket a tick to flush prompt.resolved before closing
                await new Promise((r) => {
                    const t = setTimeout(r, 50);
                    t.unref?.();
                });
            }
            this.conn.stop();
        }
    }
    touch(ctx) {
        this.lastCtx = ctx;
        this.readInfo(ctx);
    }
    readInfo(ctx) {
        try {
            this.info = {
                mode: ctx.mode,
                cwd: ctx.cwd,
                hasUI: ctx.hasUI,
                sessionFile: ctx.sessionManager.getSessionFile() ?? null,
                sessionName: ctx.sessionManager.getSessionName() ?? null,
            };
        }
        catch {
            /* stale ctx: keep the last known values */
        }
    }
    // ---------- Pi → relay ----------
    forward(name, ev, ctx) {
        if (this.disposed)
            return;
        if ((name === "message_update" || name === "tool_execution_update") && this.info) {
            this.lastCtx = ctx;
        }
        else {
            this.touch(ctx);
        }
        if (name === "model_select" && ev?.model)
            this.model = { provider: ev.model.provider, id: ev.model.id };
        if (name === "thinking_level_select")
            this.thinking = ev?.level ?? null;
        if (name === "session_compact")
            this.statuses.setCompacting(false);
        try {
            if (name === "message_end")
                this.comm.onMessage(ev?.message);
        }
        catch {
            /* message observation must never break Pi */
        }
        try {
            this.forwarder.handle(name, ev);
        }
        catch {
            /* forwarding must never break Pi */
        }
    }
    onCompactStart() {
        this.statuses.setCompacting(true);
    }
    emitEvent(e) {
        this.seq++;
        this.conn.send("agent.event", { epoch: this.epoch, seq: this.seq, e });
    }
    async onToolCall(ev, ctx) {
        if (this.disposed)
            return undefined;
        this.touch(ctx);
        try {
            return await this.gate.onToolCall(ev);
        }
        catch (e) {
            return { block: true, reason: `RP gate error: ${errMsg(e)}` };
        }
    }
    onInput(ev, ctx) {
        this.touch(ctx);
        if (ev?.source !== "interactive")
            return;
        const text = normalizeText(String(ev.text ?? ""));
        let i = this.inputWaiters.findIndex((w) => w.text === text);
        if (i < 0 && text.length > 0 && this.inputWaiters.length === 1)
            i = 0;
        if (i >= 0) {
            const [w] = this.inputWaiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(true);
        }
    }
    /** ui_prompt_start / ui_prompt_end: any blocking dialog (also ones we do not mirror). */
    terminalWait(ev, active) {
        if (this.disposed)
            return;
        if (active)
            this.dialogDepth++;
        else
            this.dialogDepth = Math.max(0, this.dialogDepth - 1);
        if (this.dialogDepth === 0)
            for (const w of this.dialogWaiters.splice(0))
                w.resolve(true);
        const kind = ev?.kind;
        if ((kind === "custom" || kind === "editor") && !this.broker.hasAdapterPrompt()) {
            this.terminalWaits = Math.max(0, this.terminalWaits + (active ? 1 : -1));
            this.updateWaiting();
            this.emitEvent({
                type: "terminal_wait",
                kind,
                title: this.cfg.redactContent ? null : (ev?.title ?? null),
                active,
            });
        }
    }
    updateWaiting() {
        this.statuses.setWaiting(this.broker.openCount + this.terminalWaits);
    }
    // ---------- relay → Pi ----------
    onRelayMessage(env) {
        routeInbound(env, {
            userMessage: (b) => void this.deliverer.handle(b),
            abort: () => {
                try {
                    this.lastCtx.abort();
                }
                catch {
                    /* ignore */
                }
            },
            promptAnswer: (id, answer) => void this.broker.handleAnswer(id, answer),
            promptCancel: (id) => this.broker.handleCancel(id),
            resync: () => this.sendSnapshot(false),
            error: (code, message) => this.log(`relay error ${code}: ${message}`),
        });
    }
    onWelcome(w) {
        this.sendSnapshot(true);
        this.conn.sendDirect("agent.status", { status: this.statuses.current });
        const items = this.filterStatuses(this.statuses.snapshot());
        if (Object.keys(items).length)
            this.conn.sendDirect("agent.statuses", { items });
        this.conn.needsSnapshot = false;
        for (const p of pendingAnswers(w))
            this.broker.handleAnswer(p.promptId, p.answer);
    }
    sendSnapshot(direct) {
        const { entries, truncated } = buildSnapshotEntries(this.safeBranch(), this.cfg.redactContent);
        if (direct) {
            if (this.conn.needsSnapshot) {
                this.conn.dropQueuedEventsUpTo(this.seq);
            }
            const minQueued = this.conn.minQueuedEventSeq();
            const snapSeq = minQueued !== null ? Math.max(0, minQueued - 1) : this.seq;
            this.conn.sendDirect("agent.snapshot", { epoch: this.epoch, seq: snapSeq, entries, truncated });
        }
        else {
            this.conn.send("agent.snapshot", { epoch: this.epoch, seq: this.seq, entries, truncated });
        }
    }
    filterStatuses(items) {
        if (!this.cfg.redactContent)
            return items;
        const out = {};
        for (const [k, v] of Object.entries(items)) {
            if (/^(gentle:mode|gentle:vim|vim|pi:theme|rp)$/i.test(k))
                out[k] = v;
        }
        return out;
    }
    safeBranch() {
        try {
            return this.lastCtx.sessionManager.getBranch();
        }
        catch {
            return [];
        }
    }
    // ---------- hello ----------
    gentleInfo() {
        const present = hasGentleAskTools(this.pi) || this.statuses.sawGentleStatus;
        if (!present)
            return null;
        return { version: detectGentleVersion(this.pi), mode: this.statuses.gentleMode ?? "unknown" };
    }
    features() {
        const f = ["attachments", "statuses", "comm"];
        if (this.mirror.dialogs)
            f.push("mirror_ui");
        if (this.adapters.enabled && this.gentleInfo())
            f.push("adapters:gentle-ask");
        if (this.gateMode() !== "off")
            f.push("gate");
        if (this.askUserRegistered)
            f.push("rp_ask_user");
        if (this.info.mode === "tui" && this.cfg.delivery.interactive)
            f.push("deliver_terminal");
        if (this.env.herdr)
            f.push("deliver_herdr");
        return f;
    }
    makeHello() {
        const { mode, cwd, sessionFile, sessionName } = this.info;
        const gentle = this.gentleInfo();
        return {
            agentId: this.agentId,
            kind: "pi",
            instance: this.instance,
            epoch: this.epoch,
            pi: { version: detectPiVersion(), mode },
            plugin: { version: pluginVersion(), features: this.features() },
            session: { id: this.sessionId, file: sessionFile, name: this.cfg.redactContent ? null : sessionName },
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
            status: this.statuses.current,
            openPrompts: this.broker.openPrompts(),
            todos: this.currentTodos.length > 0 ? { tasks: this.cfg.redactContent ? redactTodoTasks(this.currentTodos) : this.currentTodos } : null,
            subagents: this.subagents.getSnapshot().length > 0 ? this.subagents.getSnapshot() : undefined,
        };
    }
    refreshGit() {
        const cwd = this.info.cwd;
        const run = (args) => new Promise((resolve) => execFile("git", args, { cwd, timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
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
    askSelect(title, options) {
        const ctx = this.lastCtx;
        if (this.info.hasUI && this.mirror.dialogs)
            return ctx.ui.select(title, options);
        if (this.info.hasUI)
            return this.broker.race({ kind: "select", title, options }, (signal) => ctx.ui.select(title, options, { signal }));
        return this.broker.race({ kind: "select", title, options }, null);
    }
    askInput(title, placeholder) {
        const ctx = this.lastCtx;
        if (this.info.hasUI && this.mirror.dialogs)
            return ctx.ui.input(title, placeholder);
        if (this.info.hasUI)
            return this.broker.race({ kind: "input", title, placeholder }, (signal) => ctx.ui.input(title, placeholder, { signal }));
        return this.broker.race({ kind: "input", title, placeholder }, null);
    }
    maybeRegisterAskUser() {
        try {
            if (!shouldRegisterAskUser(toolNames(this.pi)))
                return;
            this.pi.registerTool(askUserToolDefinition(() => (this.disposed ? null : { askSelect: (t, o) => this.askSelect(t, o), askInput: (t, p) => this.askInput(t, p) })));
            this.askUserRegistered = true;
        }
        catch (e) {
            this.log(`rp_ask_user not registered: ${errMsg(e)}`);
        }
    }
    gateMode() {
        const gentle = hasGentleAskTools(this.pi) || this.statuses.sawGentleStatus;
        return effectiveMode(this.cfg.gate.mode, gentle);
    }
    safeIdle() {
        try {
            return this.lastCtx.isIdle();
        }
        catch {
            return true;
        }
    }
    toolInfo(name) {
        try {
            return this.pi.getAllTools().find((t) => t.name === name);
        }
        catch {
            return undefined;
        }
    }
    adaptersAllowed() {
        const v = detectGentleVersion(this.pi);
        if (v === null)
            return true; // shape guards in each adapter protect us
        if (!gentleVersionSupported(v)) {
            warnOnce(this.lastCtx, "gentle-range", `RP: gentle-pi ${v} fuera del rango probado (>=4.0 <5); las preguntas de ask_user_* se notificarán como "esperando en la terminal".`);
            return false;
        }
        return true;
    }
    // ---------- interactive delivery wiring ----------
    interactiveDeps() {
        return {
            ctx: () => this.lastCtx,
            stdin: () => terminalStdin(),
            dialogOpen: () => this.dialogDepth > 0,
            waitNoDialog: (maxMs) => new Promise((resolve) => {
                if (this.dialogDepth === 0)
                    return resolve(true);
                const t = setTimeout(() => {
                    const i = this.dialogWaiters.indexOf(w);
                    if (i >= 0)
                        this.dialogWaiters.splice(i, 1);
                    resolve(false);
                }, maxMs);
                t.unref?.();
                const w = {
                    resolve: (v) => {
                        clearTimeout(t);
                        resolve(v);
                    },
                };
                this.dialogWaiters.push(w);
            }),
            waitSettled: () => new Promise((resolve) => (this.safeIdle() ? resolve() : this.settledWaiters.push({ resolve }))),
            expectInput: (text, ms) => new Promise((resolve) => {
                const norm = normalizeText(text);
                const timer = setTimeout(() => {
                    const i = this.inputWaiters.findIndex((w) => w.timer === timer);
                    if (i >= 0)
                        this.inputWaiters.splice(i, 1);
                    resolve(false);
                }, ms);
                timer.unref?.();
                this.inputWaiters.push({ text: norm, resolve, timer });
            }),
            statuses: () => this.statuses.snapshot(),
            enabled: () => !this.disposed && this.cfg.delivery.interactive,
        };
    }
    // ---------- connection state ----------
    onConnState(state, transport, detail) {
        try {
            const ui = this.lastCtx.ui;
            if (state === "connected") {
                this.everConnected = true;
                ui.setStatus("rp", transport === "longpoll" ? "📱~" : "📱");
            }
            else if (state === "connecting") {
                if (this.everConnected)
                    ui.setStatus("rp", "RP …");
            }
            else if (state === "stopped" && this.fatal) {
                ui.setStatus("rp", "RP ✗");
            }
        }
        catch {
            /* stale ctx */
        }
        if (detail)
            this.log(`${state}: ${detail}`);
    }
    onFatal(code, reason) {
        this.fatal = { code, reason };
        const why = code === 4001 ? "credenciales inválidas o revocadas; vuelve a emparejar con /rp pair" : code === 4002 ? "versión de protocolo incompatible; actualiza @j3pf/pi-rp o el relay" : "otra instancia abrió la misma sesión";
        this.notify(`RP desconectado (${code}): ${why}`, "warning");
        try {
            this.lastCtx.ui.setStatus("rp", "RP ✗");
        }
        catch {
            /* ignore */
        }
    }
    notify(msg, level = "info") {
        try {
            this.lastCtx.ui.notify(msg, level);
        }
        catch {
            /* ignore */
        }
    }
    log(m) {
        if (process.env.RP_DEBUG)
            process.stderr.write(`[rp] ${m}\n`);
    }
    // ---------- introspection for /rp status ----------
    describe() {
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
export function toolDetail(name, args) {
    if (!args || typeof args !== "object")
        return "";
    if (name === "subagent_run") {
        const agent = typeof args.agent === "string" ? args.agent : "";
        const label = typeof args.label === "string"
            ? args.label
            : typeof args.task === "string"
                ? args.task
                : "";
        const desc = agent && label ? `${agent}: ${label}` : agent || label;
        return desc ? `: ${preview(desc, 60)}` : "";
    }
    if (name === "intercom") {
        const action = typeof args.action === "string" ? args.action : "";
        const to = typeof args.to === "string" ? args.to : "";
        const desc = action && to ? `${action} → ${to}` : action || to;
        return desc ? `: ${preview(desc, 60)}` : "";
    }
    if (name === "orchestrator_send_message") {
        const to = typeof args.recipient_session_id === "string" ? args.recipient_session_id : "";
        return to ? `: → ${preview(to, 60)}` : "";
    }
    const v = typeof args.command === "string"
        ? args.command
        : typeof args.path === "string"
            ? args.path
            : typeof args.query === "string"
                ? args.query
                : typeof args.pattern === "string"
                    ? args.pattern
                    : typeof args.message === "string"
                        ? args.message
                        : "";
    return v ? `: ${preview(v, 60)}` : "";
}
function spawnIdFlag(pi) {
    try {
        const v = pi.getFlag("rp-spawn-id");
        return typeof v === "string" && v ? v : null;
    }
    catch {
        return null;
    }
}
