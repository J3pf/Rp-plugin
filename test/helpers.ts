import http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { Envelope } from "../src/shared/protocol.ts";
import { envelope, parseEnvelope } from "../src/shared/protocol.ts";

export async function waitUntil<T>(fn: () => T | undefined | null | false, ms = 5000, label = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface RelayConn {
  ws: WebSocket;
  path: string;
  headers: http.IncomingHttpHeaders;
  received: Envelope[];
}

/** In-memory relay speaking enough of PROTOCOLO v1 to test the plugin and rp-host. */
export class FakeRelay {
  server = http.createServer();
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  conns: RelayConn[] = [];
  all: Envelope[] = [];
  autoWelcome = true;
  welcomeBody: any = { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] };
  rejectUpgrade: number | null = null;
  /** HTTP handlers for long-poll etc. */
  httpLog: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  pollQueue: Envelope[] = [];
  pollWaiters: Array<(m: Envelope[]) => void> = [];
  httpResponses = new Map<string, (req: http.IncomingMessage, body: any) => { status: number; body?: any; headers?: Record<string, string> }>();
  port = 0;

  async start(port = 0): Promise<this> {
    this.server.on("upgrade", (req, socket, head) => {
      if (this.rejectUpgrade) {
        socket.write(`HTTP/1.1 ${this.rejectUpgrade} X\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const conn: RelayConn = { ws, path: req.url ?? "", headers: req.headers, received: [] };
        this.conns.push(conn);
        ws.on("message", (data) => {
          const env = parseEnvelope(data.toString("utf8"));
          if (!env) return;
          conn.received.push(env);
          this.all.push(env);
          if (env.t === "agent.hello" && this.autoWelcome) ws.send(JSON.stringify(envelope("agent.welcome", this.welcomeBody, { re: env.id })));
        });
      });
    });
    this.server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let body: any = raw.length ? raw.toString("utf8") : undefined;
        try {
          body = body ? JSON.parse(body) : undefined;
        } catch {
          /* keep raw */
        }
        const url = new URL(req.url ?? "/", "http://x");
        this.httpLog.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const custom = this.httpResponses.get(url.pathname);
        if (custom) {
          const r = custom(req, body);
          res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
          res.end(r.body === undefined ? "" : Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body));
          return;
        }
        if (url.pathname === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ ok: true, version: "test", uptime: 1 }));
        }
        if (url.pathname === "/v1/agent/send") {
          const arr: Envelope[] = Array.isArray(body) ? body : [];
          for (const env of arr) {
            this.all.push(env);
            if (env.t === "agent.hello" && this.autoWelcome) this.pollQueue.push(envelope("agent.welcome", this.welcomeBody, { re: env.id }));
          }
          this.flushPoll();
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end("{}");
        }
        if (url.pathname === "/v1/agent/poll") {
          const done = (msgs: Envelope[]) => {
            if (res.writableEnded) return;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(msgs));
          };
          if (this.pollQueue.length) return done(this.pollQueue.splice(0));
          const timer = setTimeout(() => {
            const i = this.pollWaiters.indexOf(waiter);
            if (i >= 0) this.pollWaiters.splice(i, 1);
            done([]);
          }, 2000);
          const waiter = (m: Envelope[]) => {
            clearTimeout(timer);
            done(m);
          };
          this.pollWaiters.push(waiter);
          req.on("close", () => clearTimeout(timer));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private flushPoll(): void {
    if (this.pollQueue.length && this.pollWaiters.length) this.pollWaiters.shift()!(this.pollQueue.splice(0));
  }

  /** Send to the most recent plugin connection (ws) or the long-poll queue. */
  push(t: string, d: unknown, opts: { id?: string } = {}): void {
    const env = envelope(t, d, opts);
    const c = this.conns.filter((x) => x.ws.readyState === 1).pop();
    if (c) c.ws.send(JSON.stringify(env));
    else {
      this.pollQueue.push(env);
      this.flushPoll();
    }
  }

  of(t: string): Envelope[] {
    return this.all.filter((e) => e.t === t);
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  closeAll(code = 1012, reason = ""): void {
    for (const c of this.conns) if (c.ws.readyState === 1) c.ws.close(code, reason);
  }
}

// ---------- fake Pi ----------

export class FakeBus {
  private em = new EventEmitter();
  emit(ch: string, data: unknown) {
    this.em.emit(ch, data);
  }
  on(ch: string, h: (d: unknown) => void) {
    this.em.on(ch, h);
    return () => this.em.off(ch, h);
  }
}

export interface FakeUiOptions {
  select?: (title: string, options: string[], opts?: any) => Promise<string | undefined>;
}

export function makeUi() {
  const calls: any[] = [];
  const ui: any = {
    select: vi.fn(async (title: string, options: string[], opts?: any) => {
      calls.push({ m: "select", title, options });
      // default: stay open until aborted (so the phone can win)
      return new Promise<string | undefined>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }),
    confirm: vi.fn(async (title: string, message: string, opts?: any) => {
      calls.push({ m: "confirm", title, message });
      return new Promise<boolean>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(false), { once: true }));
    }),
    input: vi.fn(async (title: string, _p?: string, opts?: any) => {
      calls.push({ m: "input", title });
      return new Promise<string | undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
    }),
    custom: vi.fn(async (factory: any) => {
      return new Promise((resolve) => {
        factory({}, {}, {}, (v: unknown) => resolve(v));
      });
    }),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(() => ""),
    getEditorComponent: vi.fn(() => undefined),
    calls,
  };
  // the mirror patches the shared ui in place; keep handles on the original spies
  ui.mocks = { select: ui.select, confirm: ui.confirm, input: ui.input, custom: ui.custom, notify: ui.notify, setStatus: ui.setStatus };
  return ui;
}

export interface FakeCtxOptions {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  sessionId?: string;
  idle?: boolean;
  branch?: any[];
  ui?: any;
  modelRegistry?: any;
}

export function makeCtx(o: FakeCtxOptions = {}) {
  const ui = o.ui ?? makeUi();
  let idle = o.idle ?? true;
  const ctx: any = {
    ui,
    mode: o.mode ?? "tui",
    hasUI: o.hasUI ?? true,
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => o.sessionId ?? "sess1",
      getSessionFile: () => "/tmp/sess1.jsonl",
      getSessionName: () => "test session",
      getBranch: () => o.branch ?? [],
    },
    model: { provider: "fake", id: "fake-1" },
    modelRegistry: o.modelRegistry ?? {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(async () => []),
    },
    thinkingLevel: "off",
    isIdle: () => idle,
    abort: vi.fn(),
    shutdown: vi.fn(),
    setIdle: (v: boolean) => (idle = v),
  };
  return ctx;
}

export function makePi(tools: any[] = []) {
  const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>();
  const sent: any[] = [];
  const entries: any[] = [];
  const registeredTools: any[] = [];
  const commands = new Map<string, any>();
  const flags = new Map<string, any>();
  const flagValues = new Map<string, any>();
  const events = new FakeBus();
  const pi: any = {
    events,
    on: vi.fn((name: string, h: any) => {
      const arr = handlers.get(name) ?? [];
      arr.push(h);
      handlers.set(name, arr);
      return () => {};
    }),
    registerFlag: vi.fn((name: string, o: any) => flags.set(name, o)),
    getFlag: vi.fn((name: string) => flagValues.get(name)),
    registerCommand: vi.fn((name: string, o: any) => commands.set(name, o)),
    registerTool: vi.fn((t: any) => {
      registeredTools.push(t);
      tools.push({ name: t.name, sourceInfo: { path: "x" } });
    }),
    getAllTools: vi.fn(() => tools),
    sendUserMessage: vi.fn((content: any, opts?: any) => sent.push({ content, opts })),
    appendEntry: vi.fn((type: string, data: any) => entries.push({ type: "custom", customType: type, data })),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
    setModel: vi.fn(async (_m: any) => true),
    setThinkingLevel: vi.fn((_l: any) => {}),
  };
  return {
    pi,
    handlers,
    sent,
    entries,
    registeredTools,
    commands,
    flags,
    flagValues,
    events,
    async fire(name: string, ev: any, ctx: any) {
      let result: any;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(ev, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}

export function baseConfig(relayUrl: string, over: Record<string, any> = {}) {
  return {
    relayUrl,
    machineId: "MACHINE1",
    machineToken: "tok",
    machine: { name: "PC", context: "personal" },
    enabled: true,
    redactContent: false,
    gate: {
      mode: "auto-detect",
      dangerousPatterns: ["\\brm\\s+-[a-z]*r", "\\bsudo\\b"],
      alwaysAllowTools: ["read", "grep", "find", "ls"],
      useAnnotations: true,
    },
    mirrorDialogs: true,
    delivery: { method: "auto", interactive: true },
    subagents: "skip",
    inboxDir: null,
    ...over,
  } as any;
}

export const noEnv = { isGentleChild: false, launcher: "pi", herdr: null, spawnId: null, platform: "linux" } as any;
