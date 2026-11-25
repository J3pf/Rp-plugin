// Minimal HTTP(S) client honoring HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS via proxy-agent.
import http from "node:http";
import https from "node:https";
import type { Agent } from "node:http";
import WebSocket from "ws";
import { CLOSE, MAX_FRAME_BYTES } from "./protocol.ts";

let sharedAgentPromise: Promise<Agent | undefined> | undefined;
export function getProxyAgent(): Promise<Agent | undefined> {
  if (!sharedAgentPromise) {
    sharedAgentPromise = (async () => {
      try {
        const mod: any = await import("proxy-agent");
        return new mod.ProxyAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 128 } as any) as Agent;
      } catch {
        return undefined;
      }
    })();
  }
  return sharedAgentPromise;
}

export interface HttpResult<T = any> {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: T | undefined;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | object;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported HTTP protocol: ${u.protocol}`);
  }
  const lib = u.protocol === "https:" ? https : http;
  const agent = await getProxyAgent();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let payload: Buffer | undefined;
  if (opts.body !== undefined) {
    if (Buffer.isBuffer(opts.body)) payload = opts.body;
    else if (typeof opts.body === "string") payload = Buffer.from(opts.body);
    else {
      payload = Buffer.from(JSON.stringify(opts.body));
      headers["content-type"] ??= "application/json";
    }
    headers["content-length"] = String(payload.length);
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };
    const succeed = (result: HttpResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const req = lib.request(
      u,
      { method: opts.method ?? (payload ? "POST" : "GET"), headers, agent, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (maxBytes > 0 && size > maxBytes) {
            const err = new Error("response too large");
            req.destroy(err);
            fail(err);
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          let json: any;
          if ((res.headers["content-type"] ?? "").includes("json") && body.length) {
            try {
              json = JSON.parse(body.toString("utf8"));
            } catch {
              json = undefined;
            }
          }
          succeed({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
        res.on("close", () => {
          if (!res.complete) fail(new Error("response closed prematurely"));
        });
        res.on("error", (err) => fail(err));
      },
    );
    if (timeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        const err = new Error("request timeout");
        req.destroy(err);
        fail(err);
      }, timeoutMs);
      deadlineTimer.unref?.();
    }
    req.on("timeout", () => {
      const err = new Error("request timeout");
      req.destroy(err);
      fail(err);
    });
    req.on("error", (err) => fail(err));
    if (opts.signal) {
      if (opts.signal.aborted) {
        const err = new Error("aborted");
        req.destroy(err);
        fail(err);
        return;
      }
      onAbort = () => {
        const err = new Error("aborted");
        req.destroy(err);
        fail(err);
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function buildRelayEndpointUrl(relayUrl: string, targetPath: string, wantWs: boolean): string {
  const u = new URL(relayUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`Unsupported relay URL protocol: ${u.protocol}`);
  }
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  u.protocol = wantWs ? (secure ? "wss:" : "ws:") : (secure ? "https:" : "http:");
  u.search = "";
  u.hash = "";
  const basePath = u.pathname.replace(/\/+$/, "");
  const qIdx = targetPath.indexOf("?");
  const pathPart = qIdx >= 0 ? targetPath.slice(0, qIdx) : targetPath;
  const queryPart = qIdx >= 0 ? targetPath.slice(qIdx) : "";
  if (!pathPart) {
    u.pathname = basePath || "/";
    u.search = queryPart;
    const out = u.toString();
    return !basePath && !queryPart ? out.replace(/\/$/, "") : out;
  }
  const suffix = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  u.pathname = `${basePath}${suffix}`;
  u.search = queryPart;
  return u.toString();
}

export function toHttpUrl(relayUrl: string, path: string): string {
  return buildRelayEndpointUrl(relayUrl, path, false);
}

export function toWsUrl(relayUrl: string, path: string): string {
  return buildRelayEndpointUrl(relayUrl, path, true);
}

/** Shared WebSocket client ping + silence-watchdog keepalive timer helper. */
export class WsKeepalive {
  private watchdog: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly watchdogMs: number,
    private readonly pingIntervalMs = 20_000,
  ) {}

  start(ws: { readyState: number; ping(): void; terminate(): void }, openState = 1): void {
    this.stop();
    this.arm(ws);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === openState) {
        try {
          ws.ping();
        } catch {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  arm(ws: { terminate(): void }): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }, this.watchdogMs);
    this.watchdog.unref?.();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

const DEFAULT_WS_PER_MESSAGE_DEFLATE = {
  threshold: 1024,
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
} as const;

/** Returns true for relay close codes that must permanently stop reconnection. */
export function isFatalCloseCode(code: number | undefined): boolean {
  return code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE || code === CLOSE.REPLACED;
}

export interface RelayWebSocketOptions {
  handshakeTimeout?: number;
  maxPayload?: number;
  perMessageDeflate?: WebSocket.ClientOptions["perMessageDeflate"];
  keepalive?: WsKeepalive;
  agent?: Agent;
  /** Checked after awaiting proxy agent; when true, skips opening the socket and returns null. */
  isCancelled?: () => boolean;
  /** Checked on keepalive events so a superseded socket does not arm or stop the active keepalive. */
  isStale?: (ws: WebSocket) => boolean;
}

export function createRelayWebSocket(
  url: string,
  token: string,
  opts?: RelayWebSocketOptions & { isCancelled?: undefined },
): Promise<WebSocket>;
export function createRelayWebSocket(
  url: string,
  token: string,
  opts: RelayWebSocketOptions & { isCancelled: () => boolean },
): Promise<WebSocket | null>;
export async function createRelayWebSocket(
  url: string,
  token: string,
  opts: RelayWebSocketOptions = {},
): Promise<WebSocket | null> {
  const agent = opts.agent !== undefined ? opts.agent : await getProxyAgent();
  if (opts.isCancelled?.()) return null;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    agent,
    maxPayload: opts.maxPayload ?? MAX_FRAME_BYTES,
    handshakeTimeout: opts.handshakeTimeout ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
    perMessageDeflate: opts.perMessageDeflate ?? { ...DEFAULT_WS_PER_MESSAGE_DEFLATE },
  });
  const keepalive = opts.keepalive;
  if (keepalive) {
    ws.on("open", () => {
      if (opts.isCancelled?.() || opts.isStale?.(ws)) return;
      keepalive.start(ws, WebSocket.OPEN);
    });
    ws.on("ping", () => {
      if (opts.isCancelled?.() || opts.isStale?.(ws)) return;
      keepalive.arm(ws);
    });
    ws.on("pong", () => {
      if (opts.isCancelled?.() || opts.isStale?.(ws)) return;
      keepalive.arm(ws);
    });
    ws.on("message", () => {
      if (opts.isCancelled?.() || opts.isStale?.(ws)) return;
      keepalive.arm(ws);
    });
    ws.on("close", () => {
      if (!opts.isStale?.(ws)) keepalive.stop();
    });
  }
  return ws;
}
