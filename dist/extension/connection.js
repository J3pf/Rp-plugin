// Relay connection: WebSocket (through proxy) with automatic fallback to HTTP long-poll, reconnection and a bounded queue.
import WebSocket from "ws";
import { CLOSE, CRITICAL_TYPES, MAX_FRAME_BYTES, envelope, newId, parseEnvelope } from "../shared/protocol.js";
import { backoffDelay, errMsg } from "../shared/util.js";
import { getProxyAgent, httpRequest, toHttpUrl, toWsUrl } from "../shared/http.js";
export class WsTransport {
    url;
    token;
    h;
    name = "ws";
    ws = null;
    opened = false;
    closed = false;
    watchdog = null;
    pingTimer = null;
    constructor(url, token, h) {
        this.url = url;
        this.token = token;
        this.h = h;
    }
    start() {
        void this.connect();
    }
    async connect() {
        const agent = await getProxyAgent();
        if (this.closed)
            return;
        let ws;
        try {
            ws = new WebSocket(this.url, {
                headers: { Authorization: `Bearer ${this.token}` },
                agent,
                maxPayload: MAX_FRAME_BYTES,
                handshakeTimeout: 10_000,
            });
        }
        catch (e) {
            this.h.onClose({ code: 1006, reason: errMsg(e), opened: false, unsent: [] });
            return;
        }
        this.ws = ws;
        ws.on("open", () => {
            this.opened = true;
            // RP must never keep Pi alive: an open socket alone does not hold the event loop
            ws._socket?.unref?.();
            this.arm();
            this.startHeartbeat();
            this.h.onOpen();
        });
        ws.on("ping", () => this.arm());
        ws.on("pong", () => this.arm());
        ws.on("message", (data) => {
            this.arm();
            const env = parseEnvelope(data.toString("utf8"));
            if (env)
                this.h.onMessage(env);
        });
        ws.on("error", () => {
            /* 'close' always follows */
        });
        ws.on("close", (code, reason) => {
            this.stopHeartbeat();
            this.clearWatchdog();
            if (this.closed && !this.opened)
                return;
            this.closed = true;
            this.h.onClose({ code, reason: reason.toString("utf8"), opened: this.opened, unsent: [] });
        });
        ws.on("unexpected-response", (_req, res) => {
            // HTTP-level rejection of the upgrade. Without aborting here `ws` would wait forever.
            res.resume();
            if (res.statusCode === 401 || res.statusCode === 403) {
                this.closed = true;
                this.h.onClose({ code: CLOSE.INVALID_TOKEN, reason: `http ${res.statusCode}`, opened: false, unsent: [] });
            }
            try {
                ws.terminate();
            }
            catch {
                /* ignore */
            }
        });
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.ping();
                }
                catch {
                    this.ws.terminate();
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
    /** The relay pings every 25 s, client pings every 20 s; silence beyond 45 s means a dead socket. */
    arm() {
        this.clearWatchdog();
        this.watchdog = setTimeout(() => this.ws?.terminate(), 45_000);
        this.watchdog.unref?.();
    }
    clearWatchdog() {
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.watchdog = null;
    }
    send(env) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return false;
        // backpressure: drop non-critical frames when the socket buffer is saturated, and cap critical frames at 4x MAX_FRAME_BYTES
        if (this.ws.bufferedAmount > 4 * MAX_FRAME_BYTES)
            return false;
        if (this.ws.bufferedAmount > 1_000_000 && !CRITICAL_TYPES.has(env.t))
            return false;
        try {
            this.ws.send(JSON.stringify(env));
            return true;
        }
        catch {
            return false;
        }
    }
    close() {
        this.closed = true;
        this.stopHeartbeat();
        this.clearWatchdog();
        try {
            this.ws?.close(1000);
            const ws = this.ws;
            setTimeout(() => ws?.terminate(), 500).unref?.();
        }
        catch {
            /* ignore */
        }
    }
}
export class LongPollTransport {
    base;
    token;
    ids;
    h;
    name = "longpoll";
    closed = false;
    outbox = [];
    inFlight = [];
    flushing = false;
    flushScheduled = false;
    ac = new AbortController();
    constructor(base, token, ids, h) {
        this.base = base;
        this.token = token;
        this.ids = ids;
        this.h = h;
    }
    headers() {
        return {
            authorization: `Bearer ${this.token}`,
            "x-rp-agent-id": this.ids.agentId,
            "x-rp-instance": this.ids.instance,
        };
    }
    start() {
        queueMicrotask(() => {
            if (this.closed)
                return;
            this.h.onOpen();
            void this.flush().then(() => {
                if (!this.closed)
                    void this.pollLoop();
            });
        });
    }
    drainUnsent() {
        return [...this.inFlight.splice(0), ...this.outbox.splice(0)];
    }
    isSending() {
        return this.flushing;
    }
    fail(res, err) {
        if (this.closed)
            return true;
        this.closed = true;
        this.ac.abort();
        let code = 1006;
        if (res?.status === 401 || res?.status === 403)
            code = CLOSE.INVALID_TOKEN;
        else if (res?.status === 426)
            code = CLOSE.INCOMPATIBLE;
        else if (res?.status === 409)
            code = CLOSE.REPLACED;
        const unsent = this.drainUnsent();
        this.h.onClose({ code, reason: res ? `http ${res.status}` : errMsg(err), opened: true, unsent });
        return true;
    }
    async pollLoop() {
        while (!this.closed) {
            try {
                const q = `?agentId=${encodeURIComponent(this.ids.agentId)}&instance=${encodeURIComponent(this.ids.instance)}&wait=25`;
                const res = await httpRequest(this.base + "/v1/agent/poll" + q, {
                    method: "POST",
                    headers: this.headers(),
                    body: "{}",
                    timeoutMs: 35_000,
                    signal: this.ac.signal,
                });
                if (this.closed)
                    return;
                if (res.status >= 400) {
                    this.fail(res);
                    return;
                }
                const list = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.messages) ? res.json.messages : [];
                for (const m of list) {
                    const env = parseEnvelope(m);
                    if (env)
                        this.h.onMessage(env);
                }
            }
            catch (e) {
                this.fail(null, e);
                return;
            }
        }
    }
    send(env) {
        if (this.closed)
            return false;
        this.outbox.push(env);
        if (!this.flushScheduled && !this.flushing) {
            this.flushScheduled = true;
            setImmediate(() => {
                this.flushScheduled = false;
                void this.flush();
            });
        }
        return true;
    }
    async flush() {
        if (this.flushing || this.closed)
            return;
        this.flushing = true;
        try {
            while (this.outbox.length && !this.closed) {
                const batch = this.outbox.splice(0, 50);
                this.inFlight = [...batch];
                try {
                    const res = await httpRequest(this.base + "/v1/agent/send", {
                        method: "POST",
                        headers: this.headers(),
                        body: batch,
                        timeoutMs: 20_000,
                        signal: this.ac.signal,
                    });
                    if (res.status >= 400) {
                        if (!this.closed) {
                            this.outbox.unshift(...this.inFlight.splice(0));
                            this.fail(res);
                        }
                        return;
                    }
                    this.inFlight = [];
                }
                catch (e) {
                    if (!this.closed) {
                        this.outbox.unshift(...this.inFlight.splice(0));
                        this.fail(null, e);
                    }
                    return;
                }
            }
        }
        finally {
            this.inFlight = [];
            this.flushing = false;
        }
    }
    close() {
        this.closed = true;
        this.ac.abort();
    }
}
export class Connection {
    o;
    state = "idle";
    transportName = "ws";
    /** Set when events were dropped from the queue; the next snapshot covers it. */
    needsSnapshot = false;
    t = null;
    welcomed = false;
    stopped = false;
    attempt = 0;
    wsFailures = 0;
    forceLongPoll = false;
    wsRetryTimer = null;
    reconnectTimer = null;
    probingWs = false;
    connectedWaiters = [];
    queue = [];
    queueBytes = 0;
    maxMsgs;
    maxBytes;
    constructor(o) {
        this.o = o;
        this.maxMsgs = o.maxQueueMessages ?? 500;
        this.maxBytes = o.maxQueueBytes ?? 2 * 1024 * 1024;
    }
    get connected() {
        return this.state === "connected" && this.welcomed;
    }
    get queued() {
        return this.queue.length;
    }
    start() {
        if (this.stopped)
            return;
        this.open();
    }
    /** Resolves true as soon as the relay has welcomed us, false after `ms` (or when stopped). */
    whenConnected(ms) {
        if (this.connected)
            return Promise.resolve(true);
        if (this.stopped || ms <= 0)
            return Promise.resolve(false);
        return new Promise((resolve) => {
            const t = setTimeout(() => done(false), ms);
            t.unref?.();
            const done = (ok) => {
                clearTimeout(t);
                const i = this.connectedWaiters.indexOf(done);
                if (i >= 0)
                    this.connectedWaiters.splice(i, 1);
                resolve(ok);
            };
            this.connectedWaiters.push(done);
        });
    }
    stop() {
        this.stopped = true;
        this.setState("stopped");
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.wsRetryTimer)
            clearTimeout(this.wsRetryTimer);
        this.reconnectTimer = this.wsRetryTimer = null;
        this.t?.close();
        this.t = null;
        for (const w of this.connectedWaiters.splice(0))
            w(false);
    }
    log(m) {
        this.o.onLog?.(m);
    }
    setState(s, detail) {
        this.state = s;
        this.o.onState?.(s, this.transportName, detail);
    }
    makeTransport(name, h) {
        if (this.o.transportFactory)
            return this.o.transportFactory(name, h);
        if (name === "ws")
            return new WsTransport(toWsUrl(this.o.relayUrl, "/ws/agent"), this.o.token, h);
        return new LongPollTransport(toHttpUrl(this.o.relayUrl, ""), this.o.token, { agentId: this.o.agentId, instance: this.o.instance }, h);
    }
    open() {
        if (this.stopped)
            return;
        const name = this.forceLongPoll ? "longpoll" : "ws";
        this.transportName = name;
        this.welcomed = false;
        this.setState("connecting");
        const probe = this.probingWs;
        const handlers = {
            onOpen: () => {
                if (this.t !== t)
                    return;
                this.sendHello();
            },
            onMessage: (env) => {
                if (this.t !== t)
                    return;
                this.handle(env);
            },
            onClose: (info) => {
                if (this.t !== t)
                    return;
                this.t = null;
                const wasWelcomed = this.welcomed;
                this.welcomed = false;
                this.onTransportClosed(info, probe, wasWelcomed);
            },
        };
        const t = this.makeTransport(name, handlers);
        this.t = t;
        t.start();
    }
    sendHello() {
        const env = envelope("agent.hello", this.o.makeHello(), { id: newId() });
        this.t?.send(env);
    }
    handle(env) {
        if (env.t === "agent.welcome") {
            this.welcomed = true;
            this.attempt = 0;
            this.wsFailures = 0;
            this.probingWs = false;
            this.setState("connected");
            if (this.transportName === "longpoll")
                this.scheduleWsRetry();
            this.o.onWelcome(env.d);
            this.flush();
            for (const w of this.connectedWaiters.splice(0))
                w(true);
            return;
        }
        this.o.onMessage(env);
    }
    rescueUnsent(unsent) {
        for (let i = unsent.length - 1; i >= 0; i--) {
            const e = unsent[i];
            if (CRITICAL_TYPES.has(e.t) && e.t !== "agent.hello")
                this.enqueue(e, true, true);
        }
    }
    onTransportClosed(info, probe, wasWelcomed = false) {
        // keep critical messages that never made it out (in original FIFO order)
        this.rescueUnsent(info.unsent);
        if (this.stopped)
            return;
        const { code } = info;
        if (code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE || code === CLOSE.REPLACED) {
            this.stopped = true;
            this.setState("stopped", `${code} ${info.reason}`);
            this.o.onFatal?.(code, info.reason);
            return;
        }
        this.log(`transport ${this.transportName} closed: ${code} ${info.reason}`);
        if (this.transportName === "ws") {
            if (!info.opened || !wasWelcomed)
                this.wsFailures++;
            if (probe) {
                // WS probe from long-poll failed: go back to long-poll without waiting for 3 more failures
                this.probingWs = false;
                this.forceLongPoll = true;
                this.scheduleWsRetry();
            }
            else if (this.wsFailures >= (this.o.wsFailuresBeforeLongPoll ?? 3)) {
                this.forceLongPoll = true;
                this.log("falling back to long-poll transport");
                this.scheduleWsRetry();
            }
        }
        else {
            // Long-poll failed or closed: reset forceLongPoll so next reconnect cycle retries WebSocket
            this.forceLongPoll = false;
            this.probingWs = false;
        }
        this.setState("connecting", "reconnecting");
        const delay = code === CLOSE.SERVICE_RESTART ? 0 : (this.o.backoff ?? backoffDelay)(this.attempt++);
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
    }
    /** While on long-poll, retry WebSocket periodically (default 15s instead of 10 min). */
    scheduleWsRetry(delayMs = this.o.wsRetryMs ?? 15_000) {
        if (this.wsRetryTimer)
            return;
        this.wsRetryTimer = setTimeout(() => {
            this.wsRetryTimer = null;
            if (this.stopped || this.transportName !== "longpoll")
                return;
            if (this.t?.isSending?.()) {
                this.scheduleWsRetry(250);
                return;
            }
            this.forceLongPoll = false;
            this.probingWs = true;
            if (this.t?.drainUnsent)
                this.rescueUnsent(this.t.drainUnsent());
            this.t?.close();
            this.t = null;
            this.welcomed = false;
            this.open();
        }, delayMs);
        this.wsRetryTimer.unref?.();
    }
    /** Drop queued non-critical `agent.event` envelopes already covered by a snapshot up to `maxSeq`. */
    dropQueuedEventsUpTo(maxSeq) {
        if (maxSeq <= 0)
            return;
        for (let i = this.queue.length - 1; i >= 0; i--) {
            const q = this.queue[i];
            if (q.env.t === "agent.event") {
                const seq = q.env.d?.seq;
                if (typeof seq === "number" && seq <= maxSeq) {
                    this.queue.splice(i, 1);
                    this.queueBytes -= q.bytes;
                }
            }
        }
    }
    /** Lowest `seq` among currently queued `agent.event` envelopes, or `null` if none. */
    minQueuedEventSeq() {
        let min = null;
        for (const q of this.queue) {
            if (q.env.t === "agent.event") {
                const seq = q.env.d?.seq;
                if (typeof seq === "number" && (min === null || seq < min)) {
                    min = seq;
                }
            }
        }
        return min;
    }
    /** Send now if connected, otherwise queue (bounded). */
    send(t, d, opts = {}) {
        const env = envelope(t, d, opts);
        const critical = CRITICAL_TYPES.has(t);
        if (this.connected && this.t?.send(env))
            return;
        this.enqueue(env, critical, false);
    }
    /** Send during the onWelcome callback (before the queue is flushed). */
    sendDirect(t, d) {
        if (!this.t)
            return false;
        return this.t.send(envelope(t, d));
    }
    enqueue(env, critical, front) {
        const bytes = Buffer.byteLength(JSON.stringify(env));
        const item = { env, critical, bytes };
        if (front)
            this.queue.unshift(item);
        else
            this.queue.push(item);
        this.queueBytes += bytes;
        while (this.queue.length > this.maxMsgs || this.queueBytes > this.maxBytes) {
            const i = this.queue.findIndex((q) => !q.critical);
            if (i < 0)
                break;
            const [dropped] = this.queue.splice(i, 1);
            this.queueBytes -= dropped.bytes;
            this.needsSnapshot = true;
        }
        while (this.queue.length > this.maxMsgs * 2 || this.queueBytes > this.maxBytes * 2) {
            const [dropped] = this.queue.splice(0, 1);
            if (!dropped)
                break;
            this.queueBytes -= dropped.bytes;
            this.needsSnapshot = true;
        }
    }
    flush() {
        const q = this.queue;
        this.queue = [];
        this.queueBytes = 0;
        for (const item of q) {
            if (!this.t?.send(item.env))
                this.enqueue(item.env, item.critical, false);
        }
    }
}
