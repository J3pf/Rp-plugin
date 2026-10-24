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
          if (maxBytes > 0 && size > maxBytes) {
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
