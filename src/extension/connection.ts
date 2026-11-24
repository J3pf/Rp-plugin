// Relay connection: WebSocket (through proxy) with automatic fallback to HTTP long-poll, reconnection and a bounded queue.
import WebSocket from "ws";
import { CLOSE, CRITICAL_TYPES, MAX_FRAME_BYTES, envelope, newId, parseEnvelope, type Envelope, type WelcomeBody } from "../shared/protocol.ts";
import { backoffDelay, errMsg } from "../shared/util.ts";
import { WsKeepalive, getProxyAgent, httpRequest, toHttpUrl, toWsUrl } from "../shared/http.ts";

export type TransportName = "ws" | "longpoll";
export type ConnState = "idle" | "connecting" | "connected" | "stopped";

export interface Transport {
  readonly name: TransportName;
  start(): void;
  /** Returns false if the message could not be accepted (transport not open). */
  send(env: Envelope): boolean;
  drainUnsent?(): Envelope[];
  isSending?(): boolean;
  close(): void;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(env: Envelope): void;
  /** `opened` tells whether the transport had established itself before closing; `unsent` are messages never delivered. */
  onClose(info: { code: number; reason: string; opened: boolean; unsent: Envelope[] }): void;
}

export interface ConnectionOptions {
  relayUrl: string;
  token: string;
  /** Called on every (re)connect to build the body of agent.hello. */
  makeHello: () => unknown;
  /** Called after agent.welcome; send the snapshot from here (before the queue is flushed). */
  onWelcome: (w: WelcomeBody) => void;
  onMessage: (env: Envelope) => void;
  onState?: (state: ConnState, transport: TransportName, detail?: string) => void;
  /** Called once when the connection gives up for good (4001/4002/4003). */
  onFatal?: (code: number, reason: string) => void;
  onLog?: (msg: string) => void;
  /** Identify this agent to the long-poll endpoints. */
  agentId: string;
  instance: string;
  maxQueueMessages?: number;
  maxQueueBytes?: number;
  wsFailuresBeforeLongPoll?: number;
  wsRetryMs?: number;
  stabilityWindowMs?: number;
  backoff?: (attempt: number) => number;
  transportFactory?: (name: TransportName, handlers: TransportHandlers) => Transport;
}

const MAX_LONGPOLL_OUTBOX_MESSAGES = 500;
const MAX_LONGPOLL_OUTBOX_BYTES = 2 * 1024 * 1024;
const MAX_LONGPOLL_BATCH_MESSAGES = 50;
const MAX_LONGPOLL_BATCH_BYTES = 750 * 1024;
const LONGPOLL_TIMEOUT_MS = 25_000;
const DEFAULT_STABILITY_WINDOW_MS = 5_000;

function sleepUnref(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class WsTransport implements Transport {
  readonly name = "ws" as const;
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  /** The relay pings every 25 s, client pings every 20 s; silence beyond 45 s means a dead socket. */
  private keepalive = new WsKeepalive(45_000, 20_000);

  constructor(private url: string, private token: string, private h: TransportHandlers) {}

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    const agent = await getProxyAgent();
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent,
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: 10_000,
        perMessageDeflate: {
          threshold: 1024,
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
        },
      });
    } catch (e) {
      this.h.onClose({ code: 1006, reason: errMsg(e), opened: false, unsent: [] });
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.closed || this.ws !== ws) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      this.opened = true;
      // RP must never keep Pi alive: an open socket alone does not hold the event loop
      (ws as any)._socket?.unref?.();
      this.keepalive.start(ws, WebSocket.OPEN);
      this.h.onOpen();
    });
    ws.on("ping", () => this.keepalive.arm(ws));
    ws.on("pong", () => this.keepalive.arm(ws));
    ws.on("message", (data) => {
      this.keepalive.arm(ws);
      const env = parseEnvelope(data.toString("utf8"));
      if (env) this.h.onMessage(env);
    });
    ws.on("error", () => {
      /* 'close' always follows */
    });
    ws.on("close", (code, reason) => {
      this.keepalive.stop();
      if (this.closed && !this.opened) return;
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
      } catch {
        /* ignore */
      }
    });
  }

  send(env: Envelope): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // backpressure: drop non-critical frames when the socket buffer is saturated, and cap critical frames at 4x MAX_FRAME_BYTES
    if (this.ws.bufferedAmount > 4 * MAX_FRAME_BYTES) return false;
    if (this.ws.bufferedAmount > 1_000_000 && !CRITICAL_TYPES.has(env.t)) return false;
    try {
      const payload = JSON.stringify(env);
      if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) return false;
      this.ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.closed = true;
    this.keepalive.stop();
    try {
      this.ws?.close(1000);
      const ws = this.ws;
      setTimeout(() => ws?.terminate(), 500).unref?.();
    } catch {
      /* ignore */
    }
  }
}

interface OutboxItem {
  env: Envelope;
  bytes: number;
}

export class LongPollTransport implements Transport {
  readonly name = "longpoll" as const;
  private closed = false;
  private outbox: OutboxItem[] = [];
  private outboxBytes = 0;
  private inFlight: OutboxItem[] = [];
  private flushing = false;
  private flushScheduled = false;
  private ac = new AbortController();

  constructor(
    private base: string,
    private token: string,
    private ids: { agentId: string; instance: string },
    private h: TransportHandlers,
    private onLog?: (msg: string) => void,
  ) {}

  private headers() {
    return {
      authorization: `Bearer ${this.token}`,
      "x-rp-agent-id": this.ids.agentId,
      "x-rp-instance": this.ids.instance,
    };
  }

  start(): void {
    queueMicrotask(() => {
      if (this.closed) return;
      this.h.onOpen();
      void this.flush().then(() => {
        if (!this.closed) void this.pollLoop();
      });
    });
  }

  drainUnsent(): Envelope[] {
    this.outboxBytes = 0;
    return [...this.inFlight.splice(0), ...this.outbox.splice(0)].map((item) => item.env);
  }

  isSending(): boolean {
    return this.flushing;
  }

  private fail(res: { status: number; json?: any } | null, err?: unknown): boolean {
    if (this.closed) return true;
    this.closed = true;
    this.ac.abort();
    let code = 1006;
    if (res?.status === 401 || res?.status === 403) code = CLOSE.INVALID_TOKEN;
    else if (res?.status === 426) code = CLOSE.INCOMPATIBLE;
    else if (res?.status === 409) code = CLOSE.REPLACED;
    else if (res?.status === 410) {
      code = typeof res.json?.closeCode === "number" ? res.json.closeCode : CLOSE.REPLACED;
    }
    const unsent = this.drainUnsent();
    const reason = err ? errMsg(err) : res ? `http ${res.status}` : "unknown error";
    this.h.onClose({ code, reason, opened: true, unsent });
    return true;
  }

  private async pollLoop(): Promise<void> {
    let fastEmptyPolls = 0;
    while (!this.closed) {
      const t0 = Date.now();
      try {
        const res = await httpRequest(this.base + "/v1/agent/poll", {
          method: "POST",
          headers: this.headers(),
          body: {
            agentId: this.ids.agentId,
            instance: this.ids.instance,
            timeout: LONGPOLL_TIMEOUT_MS,
          },
          timeoutMs: 35_000,
          signal: this.ac.signal,
        });
        if (this.closed) return;
        if (res.status < 200 || res.status >= 300) {
          this.fail(res);
          return;
        }
        if (res.body.length > 0 && res.json === undefined) {
          this.fail(res, new Error("non-JSON response on long-poll"));
          return;
        }
        const list = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.messages) ? res.json.messages : [];
        for (const m of list) {
          const env = parseEnvelope(m);
          if (env) this.h.onMessage(env);
        }
        if (list.length === 0 && Date.now() - t0 < 500) {
          fastEmptyPolls++;
          const waitMs = Math.min(5_000, 100 * 2 ** Math.min(fastEmptyPolls - 1, 6));
          await sleepUnref(waitMs, this.ac.signal);
        } else {
          fastEmptyPolls = 0;
        }
      } catch (e) {
        this.fail(null, e);
        return;
      }
    }
  }

  send(env: Envelope): boolean {
    if (this.closed) return false;
    const bytes = Buffer.byteLength(JSON.stringify(env), "utf8");
    if (bytes > MAX_FRAME_BYTES) return false;
    if (this.outbox.length >= MAX_LONGPOLL_OUTBOX_MESSAGES || this.outboxBytes + bytes > MAX_LONGPOLL_OUTBOX_BYTES) {
      return false;
    }
    this.outbox.push({ env, bytes });
    this.outboxBytes += bytes;
    if (!this.flushScheduled && !this.flushing) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        void this.flush();
      });
    }
    return true;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.outbox.length && !this.closed) {
        const batch: OutboxItem[] = [];
        let batchBytes = 2; // []
        while (this.outbox.length && batch.length < MAX_LONGPOLL_BATCH_MESSAGES) {
          const next = this.outbox[0]!;
          const extra = next.bytes + (batch.length > 0 ? 1 : 0);
          if (batch.length > 0 && batchBytes + extra > MAX_LONGPOLL_BATCH_BYTES) break;
          this.outbox.shift();
          this.outboxBytes = Math.max(0, this.outboxBytes - next.bytes);
          batch.push(next);
          batchBytes += extra;
        }
        this.inFlight = [...batch];
        try {
          const res = await httpRequest(this.base + "/v1/agent/send", {
            method: "POST",
            headers: this.headers(),
            body: batch.map((item) => item.env),
            timeoutMs: 20_000,
            signal: this.ac.signal,
          });
          if (res.status < 200 || res.status >= 300) {
            if (!this.closed) {
              const restored = this.inFlight.splice(0);
              for (const item of restored) this.outboxBytes += item.bytes;
              this.outbox.unshift(...restored);
              this.fail(res);
            }
            return;
          }
          if (typeof res.json?.rejected === "number" && res.json.rejected > 0) {
            this.inFlight = [];
            const msg = `long-poll send rejected ${res.json.rejected} message(s)`;
            this.onLog?.(msg);
            if (!this.closed) this.fail(null, new Error(msg));
            return;
          }
          this.inFlight = [];
        } catch (e) {
          if (!this.closed) {
            const restored = this.inFlight.splice(0);
            for (const item of restored) this.outboxBytes += item.bytes;
            this.outbox.unshift(...restored);
            this.fail(null, e);
          }
          return;
        }
      }
    } finally {
      this.inFlight = [];
      this.flushing = false;
    }
  }

  close(): void {
    this.closed = true;
    this.ac.abort();
  }
}

interface Queued {
  env: Envelope;
  critical: boolean;
  bytes: number;
}

export class Connection {
  state: ConnState = "idle";
  transportName: TransportName = "ws";
  /** Set when events were dropped from the queue; the next snapshot covers it. */
  needsSnapshot = false;

  private t: Transport | null = null;
  private welcomed = false;
  private stopped = false;
  private attempt = 0;
  private wsFailures = 0;
  private consecutiveServiceRestarts = 0;
  private forceLongPoll = false;
  private wsRetryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private probingWs = false;
  private connectedWaiters: Array<(ok: boolean) => void> = [];
  private queue: Queued[] = [];
  private queueBytes = 0;
  private readonly maxMsgs: number;
  private readonly maxBytes: number;

  constructor(private o: ConnectionOptions) {
    this.maxMsgs = o.maxQueueMessages ?? 500;
    this.maxBytes = o.maxQueueBytes ?? 2 * 1024 * 1024;
  }

  get connected(): boolean {
    return this.state === "connected" && this.welcomed;
  }
  get queued(): number {
    return this.queue.length;
  }

  start(): void {
    if (this.stopped) return;
    this.open();
  }

  /** Reopen the transport immediately so updated `agent.hello` metadata is registered cleanly. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearStabilityTimer();
    const prev = this.t;
    this.t = null;
    this.welcomed = false;
    prev?.close();
    this.open();
  }

  /** Resolves true as soon as the relay has welcomed us, false after `ms` (or when stopped). */
  whenConnected(ms: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.stopped || ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => done(false), ms);
      t.unref?.();
      const done = (ok: boolean) => {
        clearTimeout(t);
        const i = this.connectedWaiters.indexOf(done);
        if (i >= 0) this.connectedWaiters.splice(i, 1);
        resolve(ok);
      };
      this.connectedWaiters.push(done);
    });
  }

  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    this.clearStabilityTimer();
    this.reconnectTimer = this.wsRetryTimer = null;
    this.queue = [];
    this.queueBytes = 0;
    this.t?.close();
    this.t = null;
    for (const w of this.connectedWaiters.splice(0)) w(false);
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private log(m: string) {
    this.o.onLog?.(m);
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    this.o.onState?.(s, this.transportName, detail);
  }

  private makeTransport(name: TransportName, h: TransportHandlers): Transport {
    if (this.o.transportFactory) return this.o.transportFactory(name, h);
    if (name === "ws") return new WsTransport(toWsUrl(this.o.relayUrl, "/ws/agent"), this.o.token, h);
    return new LongPollTransport(
      toHttpUrl(this.o.relayUrl, ""),
      this.o.token,
      { agentId: this.o.agentId, instance: this.o.instance },
      h,
      (m) => this.log(m),
    );
  }

  private open(): void {
    if (this.stopped) return;
    const name: TransportName = this.forceLongPoll ? "longpoll" : "ws";
    this.transportName = name;
    this.welcomed = false;
    this.setState("connecting");
    const probe = this.probingWs;
    const handlers: TransportHandlers = {
      onOpen: () => {
        if (this.t !== t) return;
        this.sendHello();
      },
      onMessage: (env) => {
        if (this.t !== t) return;
        this.handle(env);
      },
      onClose: (info) => {
        if (this.t !== t) return;
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

  private sendHello(): void {
    const env = envelope("agent.hello", this.o.makeHello(), { id: newId() });
    this.t?.send(env);
  }

  private handle(env: Envelope): void {
    if (env.t === "agent.welcome") {
      this.welcomed = true;
      this.probingWs = false;
      this.clearStabilityTimer();
      const stabilityMs = this.o.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
      if (stabilityMs <= 0) {
        this.attempt = 0;
        this.wsFailures = 0;
        this.consecutiveServiceRestarts = 0;
      } else {
        this.stabilityTimer = setTimeout(() => {
          this.stabilityTimer = null;
          if (!this.stopped && this.welcomed) {
            this.attempt = 0;
            this.wsFailures = 0;
            this.consecutiveServiceRestarts = 0;
          }
        }, stabilityMs);
        this.stabilityTimer.unref?.();
      }
      this.setState("connected");
      if (this.transportName === "longpoll") this.scheduleWsRetry();
      this.o.onWelcome(env.d as WelcomeBody);
      this.flush();
      for (const w of this.connectedWaiters.splice(0)) w(true);
      return;
    }
    this.o.onMessage(env);
  }

  private rescueUnsent(unsent: Envelope[]): void {
    for (let i = unsent.length - 1; i >= 0; i--) {
      const e = unsent[i]!;
      if (CRITICAL_TYPES.has(e.t) && e.t !== "agent.hello") this.enqueue(e, true, true);
    }
  }

  private onTransportClosed(info: { code: number; reason: string; opened: boolean; unsent: Envelope[] }, probe: boolean, wasWelcomed = false): void {
    this.clearStabilityTimer();
    // keep critical messages that never made it out (in original FIFO order)
    this.rescueUnsent(info.unsent);
    if (this.stopped) return;
    const { code } = info;
    if (code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE || code === CLOSE.REPLACED) {
      this.stopped = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
      this.reconnectTimer = this.wsRetryTimer = null;
      this.queue = [];
      this.queueBytes = 0;
      for (const w of this.connectedWaiters.splice(0)) w(false);
      this.setState("stopped", `${code} ${info.reason}`);
      this.o.onFatal?.(code, info.reason);
      return;
    }
    this.log(`transport ${this.transportName} closed: ${code} ${info.reason}`);
    if (this.transportName === "ws") {
      if (!info.opened || !wasWelcomed) this.wsFailures++;
      if (probe) {
        // WS probe from long-poll failed: go back to long-poll without waiting for 3 more failures
        this.probingWs = false;
        this.forceLongPoll = true;
        this.scheduleWsRetry();
      } else if (this.wsFailures >= (this.o.wsFailuresBeforeLongPoll ?? 3)) {
        this.forceLongPoll = true;
        this.log("falling back to long-poll transport");
        this.scheduleWsRetry();
      }
    } else {
      // Long-poll failed or closed: reset forceLongPoll so next reconnect cycle retries WebSocket
      this.forceLongPoll = false;
      this.probingWs = false;
    }
    this.setState("connecting", "reconnecting");
    let delay: number;
    if (code === CLOSE.SERVICE_RESTART) {
      this.consecutiveServiceRestarts++;
      if (this.consecutiveServiceRestarts === 1) {
        delay = 250 + Math.floor(Math.random() * 1251);
      } else {
        delay = (this.o.backoff ?? backoffDelay)(this.attempt++);
      }
    } else {
      this.consecutiveServiceRestarts = 0;
      delay = (this.o.backoff ?? backoffDelay)(this.attempt++);
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
    this.reconnectTimer.unref?.();
  }

  /** While on long-poll, retry WebSocket periodically (default 15s instead of 10 min). */
  private scheduleWsRetry(delayMs = this.o.wsRetryMs ?? 15_000): void {
    if (this.wsRetryTimer) return;
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      if (this.stopped || this.transportName !== "longpoll") return;
      if (this.t?.isSending?.()) {
        this.scheduleWsRetry(250);
        return;
      }
      this.forceLongPoll = false;
      this.probingWs = true;
      if (this.t?.drainUnsent) this.rescueUnsent(this.t.drainUnsent());
      this.t?.close();
      this.t = null;
      this.welcomed = false;
      this.open();
    }, delayMs);
    this.wsRetryTimer.unref?.();
  }

  /** Drop queued non-critical `agent.event` envelopes already covered by a snapshot up to `maxSeq`. */
  dropQueuedEventsUpTo(maxSeq: number): void {
    if (maxSeq <= 0) return;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      if (q.env.t === "agent.event") {
        const seq = (q.env.d as { seq?: unknown } | undefined)?.seq;
        if (typeof seq === "number" && seq <= maxSeq) {
          this.queue.splice(i, 1);
          this.queueBytes -= q.bytes;
        }
      }
    }
  }

  /** Lowest `seq` among currently queued `agent.event` envelopes, or `null` if none. */
  minQueuedEventSeq(): number | null {
    let min: number | null = null;
    for (const q of this.queue) {
      if (q.env.t === "agent.event") {
        const seq = (q.env.d as { seq?: unknown } | undefined)?.seq;
        if (typeof seq === "number" && (min === null || seq < min)) {
          min = seq;
        }
      }
    }
    return min;
  }

  /** Send now if connected, otherwise queue (bounded). */
  send<D>(t: string, d: D, opts: { id?: string; re?: string } = {}): void {
    const env = envelope(t, d, opts);
    const bytes = Buffer.byteLength(JSON.stringify(env), "utf8");
    if (bytes > MAX_FRAME_BYTES) {
      this.log(`dropping oversized frame ${t} (${bytes} bytes > MAX_FRAME_BYTES ${MAX_FRAME_BYTES})`);
      if (t === "agent.event") this.needsSnapshot = true;
      return;
    }
    const critical = CRITICAL_TYPES.has(t);
    if (this.connected && this.t?.send(env)) return;
    this.enqueue(env, critical, false);
  }

  /** Send during the onWelcome callback (before the queue is flushed). */
  sendDirect<D>(t: string, d: D): boolean {
    if (!this.t) return false;
    const env = envelope(t, d);
    const bytes = Buffer.byteLength(JSON.stringify(env), "utf8");
    if (bytes > MAX_FRAME_BYTES) {
      this.log(`dropping oversized direct frame ${t} (${bytes} bytes > MAX_FRAME_BYTES ${MAX_FRAME_BYTES})`);
      if (t === "agent.event") this.needsSnapshot = true;
      return false;
    }
    return this.t.send(env);
  }

  private enqueue(env: Envelope, critical: boolean, front: boolean): void {
    const bytes = Buffer.byteLength(JSON.stringify(env));
    const item: Queued = { env, critical, bytes };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    this.queueBytes += bytes;
    while (this.queue.length > this.maxMsgs || this.queueBytes > this.maxBytes) {
      const i = this.queue.findIndex((q) => !q.critical);
      if (i < 0) break;
      const [dropped] = this.queue.splice(i, 1);
      this.queueBytes -= dropped!.bytes;
      this.needsSnapshot = true;
    }
    while (this.queue.length > this.maxMsgs * 2 || this.queueBytes > this.maxBytes * 2) {
      const [dropped] = this.queue.splice(0, 1);
      if (!dropped) break;
      this.queueBytes -= dropped.bytes;
      this.needsSnapshot = true;
    }
  }

  private flush(): void {
    const q = this.queue;
    this.queue = [];
    this.queueBytes = 0;
    for (const item of q) {
      if (!this.t?.send(item.env)) this.enqueue(item.env, item.critical, false);
    }
  }
}
