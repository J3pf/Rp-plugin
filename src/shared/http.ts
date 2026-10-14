// Minimal HTTP(S) client honoring HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS via proxy-agent.
import http from "node:http";
import https from "node:https";
import type { Agent } from "node:http";

let sharedAgent: Agent | undefined;
export async function getProxyAgent(): Promise<Agent | undefined> {
  if (sharedAgent) return sharedAgent;
  try {
    const mod: any = await import("proxy-agent");
    sharedAgent = new mod.ProxyAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 } as any) as Agent;
  } catch {
    sharedAgent = undefined;
  }
  return sharedAgent;
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

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const agent = await getProxyAgent();
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
  return new Promise<HttpResult>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };
    const req = lib.request(
      u,
      { method: opts.method ?? (payload ? "POST" : "GET"), headers, agent, timeout: opts.timeoutMs ?? 30_000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (opts.maxBytes && size > opts.maxBytes) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          cleanup();
          const body = Buffer.concat(chunks);
          let json: any;
          if ((res.headers["content-type"] ?? "").includes("json") && body.length) {
            try {
              json = JSON.parse(body.toString("utf8"));
            } catch {
              json = undefined;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
        res.on("error", (err) => {
          cleanup();
          reject(err);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => {
      cleanup();
      reject(err);
    });
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new Error("aborted"));
      else {
        onAbort = () => req.destroy(new Error("aborted"));
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (payload) req.write(payload);
    req.end();
  });
}

export function toHttpUrl(relayUrl: string, path: string): string {
  const base = relayUrl.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
  return base + path;
}

export function toWsUrl(relayUrl: string, path: string): string {
  const base = relayUrl.replace(/\/+$/, "").replace(/^http(s?):\/\//, "ws$1://");
  return base + path;
}
