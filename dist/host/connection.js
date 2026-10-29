// rp-host ⇄ relay: wss://<relay>/ws/host (PROTOCOLO §9).
import os from "node:os";
import WebSocket from "ws";
import { MAX_FRAME_BYTES, CLOSE, envelope, parseEnvelope } from "../shared/protocol.js";
import { getProxyAgent, toWsUrl } from "../shared/http.js";
import { backoffDelay, errMsg } from "../shared/util.js";
import { HostError, listDirs, validateSessionId } from "./validate.js";
import { gitDiff, gitDiscard } from "./git.js";
export class HostConnection {
    o;
    ws = null;
    stopped = false;
    attempt = 0;
    timer = null;
    watchdog = null;
    pingTimer = null;
    quotaTimer = null;
    quotaPolling = false;
    constructor(o) {
        this.o = o;
    }
    log(m) {
        this.o.onLog?.(m);
    }
    start() {
        void this.connect();
    }
    stop() {
        this.stopped = true;
        this.stopHeartbeat();
        this.clearWatchdog();
        this.stopQuotaTimer();
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        try {
            this.ws?.close(1000);
        }
        catch {
            /* ignore */
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.ping();
                }
                catch {
                    try {
                        this.ws.terminate();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
        }, 20_000);
        this.pingTimer.unref?.();
    }
    stopHeartbeat() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = null;
    }
    /** The relay pings every 25 s, client pings every 20 s; silence beyond 70 s means a dead socket. */
    arm() {
        this.clearWatchdog();
        this.watchdog = setTimeout(() => this.ws?.terminate(), 70_000);
        this.watchdog.unref?.();
    }
    clearWatchdog() {
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.watchdog = null;
    }
    scheduleReconnect(code) {
        if (this.stopped)
            return;
        if (code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE) {
            this.log(`relay closed the connection with ${code}; not reconnecting`);
            this.stopped = true;
            return;
        }
        const delay = code === CLOSE.SERVICE_RESTART ? 0 : (this.o.backoff ?? backoffDelay)(this.attempt++);
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.connect(), delay);
        this.timer.unref?.();
    }
    async connect() {
        if (this.stopped)
            return;
        const agent = await getProxyAgent();
        if (this.stopped)
            return;
        let ws;
        try {
            ws = new WebSocket(toWsUrl(this.o.relayUrl, "/ws/host"), {
                headers: { Authorization: `Bearer ${this.o.token}` },
                agent,
                maxPayload: MAX_FRAME_BYTES,
                handshakeTimeout: 10_000,
            });
        }
        catch (e) {
            this.log(`ws connect failed: ${errMsg(e)}`);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.on("open", () => {
            this.attempt = 0;
            this.arm();
            this.startHeartbeat();
            this.startQuotaTimer();
            void this.hello(ws).catch((e) => this.log(`hello failed: ${errMsg(e)}`));
        });
        ws.on("ping", () => this.arm());
        ws.on("pong", () => this.arm());
        ws.on("message", (data) => {
            this.arm();
            const env = parseEnvelope(data.toString("utf8"));
            if (env)
                void this.handle(env);
        });
        ws.on("error", () => { });
        ws.on("unexpected-response", (_req, res) => {
            res.resume();
            if (res.statusCode === 401 || res.statusCode === 403) {
                this.log(`relay rejected auth with http ${res.statusCode}; not reconnecting`);
                this.stopped = true;
            }
            try {
                ws.terminate();
            }
            catch {
                /* ignore */
            }
        });
        ws.on("close", (code) => {
            this.stopHeartbeat();
            this.clearWatchdog();
            this.stopQuotaTimer();
            if (this.ws !== ws)
                return;
            this.ws = null;
            this.scheduleReconnect(code);
        });
    }
    sendEnv(e) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        try {
            this.ws.send(JSON.stringify(e));
        }
        catch {
            /* ignore transient send error */
        }
    }
    startQuotaTimer() {
        this.stopQuotaTimer();
        const sec = this.o.cfg.quotaIntervalSec;
        if (!this.o.cfg.quotaEnabled || !sec || sec <= 0)
            return;
        this.quotaTimer = setInterval(() => void this.pollQuotas(), sec * 1000);
        this.quotaTimer.unref?.();
    }
    stopQuotaTimer() {
        if (this.quotaTimer) {
            clearInterval(this.quotaTimer);
            this.quotaTimer = null;
        }
    }
    async pollQuotas() {
        if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.quotaPolling)
            return;
        const ws = this.ws;
        this.quotaPolling = true;
        try {
            const quotas = await this.o.manager.collectQuotas();
            if (!this.stopped && this.ws === ws && ws.readyState === WebSocket.OPEN && quotas) {
                const body = { quotas };
                this.sendEnv(envelope("host.quotas", body));
            }
        }
        catch (e) {
            this.log(`error polling quotas: ${e.message}`);
        }
        finally {
            this.quotaPolling = false;
        }
    }
    async hello(ws) {
        const rep = await this.o.manager.detect(true);
        const def = await this.o.manager.defaultBackend();
        const quotas = await this.o.manager.collectQuotas();
        if (this.stopped || (ws && this.ws !== ws))
            return;
        const body = {
            machineId: this.o.machineId,
            hostname: os.hostname(),
            roots: this.o.cfg.roots,
            backends: { herdr: rep.herdr, tmux: rep.tmux, wt: rep.wt, console: rep.console },
            ...(def ? { defaultBackend: def } : {}),
            launchers: Object.keys(this.o.cfg.launchers),
            defaultLauncher: this.o.cfg.defaultLauncher,
        };
        if (quotas && quotas.length > 0) {
            body.quotas = quotas;
        }
        this.sendEnv(envelope("host.hello", body));
    }
    /** Handle one relay request; always answers with `re` = request id. */
    async handle(env) {
        const d = env.d ?? {};
        const reply = (t, body) => this.sendEnv(envelope(t, body, { re: env.id }));
        try {
            if (d.machineId && d.machineId !== this.o.machineId)
                throw new HostError("bad_request", "machineId mismatch");
            switch (env.t) {
                case "host.list_dirs":
                    return reply("host.dirs", listDirs(this.o.cfg, String(d.path ?? "")));
                case "host.git_diff": {
                    const res = await gitDiff(this.o.cfg, String(d.cwd ?? ""), typeof d.path === "string" ? d.path : undefined);
                    return reply("host.git_diff.result", res);
                }
                case "host.git_discard": {
                    const res = await gitDiscard(this.o.cfg, String(d.cwd ?? ""), String(d.path ?? ""));
                    return reply("host.git_discard.result", res);
                }
                case "host.herdr_layout":
                    return reply("host.herdr_layout.result", await this.o.manager.herdrLayout());
                case "host.spawn": {
                    const rec = await this.o.manager.spawn({
                        cwd: String(d.cwd ?? ""),
                        name: typeof d.name === "string" ? d.name : undefined,
                        launcher: typeof d.launcher === "string" ? d.launcher : undefined,
                        backend: ["herdr", "tmux", "wt", "console"].includes(d.backend) ? d.backend : undefined,
                        herdrTarget: parseTarget(d.herdrTarget),
                        sessionId: typeof d.sessionId === "string" && d.sessionId.trim() ? d.sessionId.trim() : undefined,
                    });
                    return reply("host.spawned", {
                        spawnId: rec.spawnId,
                        backend: rec.backend,
                        herdr: rec.herdr?.paneId ? { workspaceId: rec.herdr.workspaceId ?? "", paneId: rec.herdr.paneId } : null,
                        tmuxSession: rec.tmuxSession,
                    });
                }
                case "host.kill":
                    await this.o.manager.kill(d.spawnId);
                    return reply("ack", {});
                case "host.herdr_close":
                    return reply("host.herdr_closed", await this.o.manager.herdrClose(d.paneId));
                case "error":
                    this.log(`relay error: ${d.code} ${d.message}`);
                    return;
                default:
                    return;
            }
        }
        catch (e) {
            const code = e instanceof HostError ? e.code : "internal";
            this.log(`${env.t} failed: ${errMsg(e)}`);
            reply("error", { code, message: errMsg(e) });
        }
    }
}
export function parseTarget(t) {
    if (!t || typeof t !== "object")
        return undefined;
    if (t.type === "workspace")
        return { type: "workspace" };
    if (t.type === "tab" && typeof t.workspaceId === "string" && t.workspaceId) {
        return { type: "tab", workspaceId: validateSessionId(t.workspaceId) };
    }
    if (t.type === "split" && typeof t.paneId === "string" && t.paneId) {
        return {
            type: "split",
            paneId: validateSessionId(t.paneId),
            direction: t.direction === "down" ? "down" : "right",
        };
    }
    throw new HostError("bad_request", "invalid herdrTarget");
}
