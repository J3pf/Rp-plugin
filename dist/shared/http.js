// Minimal HTTP(S) client honoring HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS via proxy-agent.
import http from "node:http";
import https from "node:https";
import WebSocket from "ws";
import { CLOSE, MAX_FRAME_BYTES } from "./protocol.js";
let sharedAgentPromise;
export function getProxyAgent() {
    if (!sharedAgentPromise) {
        sharedAgentPromise = (async () => {
            try {
                const mod = await import("proxy-agent");
                return new mod.ProxyAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 128 });
            }
            catch {
                return undefined;
            }
        })();
    }
    return sharedAgentPromise;
}
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export async function httpRequest(url, opts = {}) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`Unsupported HTTP protocol: ${u.protocol}`);
    }
    const lib = u.protocol === "https:" ? https : http;
    const agent = await getProxyAgent();
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const headers = { ...(opts.headers ?? {}) };
    let payload;
    if (opts.body !== undefined) {
        if (Buffer.isBuffer(opts.body))
            payload = opts.body;
        else if (typeof opts.body === "string")
            payload = Buffer.from(opts.body);
        else {
            payload = Buffer.from(JSON.stringify(opts.body));
            headers["content-type"] ??= "application/json";
        }
        headers["content-length"] = String(payload.length);
    }
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
        let settled = false;
        let deadlineTimer;
        let onAbort;
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
        const succeed = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const req = lib.request(u, { method: opts.method ?? (payload ? "POST" : "GET"), headers, agent, timeout: timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on("data", (c) => {
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
                let json;
                if ((res.headers["content-type"] ?? "").includes("json") && body.length) {
                    try {
                        json = JSON.parse(body.toString("utf8"));
                    }
                    catch {
                        json = undefined;
                    }
                }
                succeed({ status: res.statusCode ?? 0, headers: res.headers, body, json });
            });
            res.on("close", () => {
                if (!res.complete)
                    fail(new Error("response closed prematurely"));
            });
            res.on("error", (err) => fail(err));
        });
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
        if (payload)
            req.write(payload);
        req.end();
    });
}
function buildRelayEndpointUrl(relayUrl, targetPath, wantWs) {
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
export function toHttpUrl(relayUrl, path) {
    return buildRelayEndpointUrl(relayUrl, path, false);
}
export function toWsUrl(relayUrl, path) {
    return buildRelayEndpointUrl(relayUrl, path, true);
}
/** Shared WebSocket client ping + silence-watchdog keepalive timer helper. */
export class WsKeepalive {
    watchdogMs;
    pingIntervalMs;
    watchdog = null;
    pingTimer = null;
    constructor(watchdogMs, pingIntervalMs = 20_000) {
        this.watchdogMs = watchdogMs;
        this.pingIntervalMs = pingIntervalMs;
    }
    start(ws, openState = 1) {
        this.stop();
        this.arm(ws);
        this.pingTimer = setInterval(() => {
            if (ws.readyState === openState) {
                try {
                    ws.ping();
                }
                catch {
                    try {
                        ws.terminate();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
        }, this.pingIntervalMs);
        this.pingTimer.unref?.();
    }
    arm(ws) {
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
            try {
                ws.terminate();
            }
            catch {
                /* ignore */
            }
        }, this.watchdogMs);
        this.watchdog.unref?.();
    }
    stop() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.watchdog = null;
    }
}
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_WS_PER_MESSAGE_DEFLATE = {
    threshold: 1024,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
};
/** Returns true for relay close codes that must permanently stop reconnection. */
export function isFatalCloseCode(code) {
    return code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE || code === CLOSE.REPLACED;
}
export async function createRelayWebSocket(url, token, opts = {}) {
    const agent = opts.agent !== undefined ? opts.agent : await getProxyAgent();
    if (opts.isCancelled?.())
        return null;
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
            if (opts.isCancelled?.() || opts.isStale?.(ws))
                return;
            keepalive.start(ws, WebSocket.OPEN);
        });
        ws.on("ping", () => {
            if (opts.isCancelled?.() || opts.isStale?.(ws))
                return;
            keepalive.arm(ws);
        });
        ws.on("pong", () => {
            if (opts.isCancelled?.() || opts.isStale?.(ws))
                return;
            keepalive.arm(ws);
        });
        ws.on("message", () => {
            if (opts.isCancelled?.() || opts.isStale?.(ws))
                return;
            keepalive.arm(ws);
        });
        ws.on("close", () => {
            if (!opts.isStale?.(ws))
                keepalive.stop();
        });
    }
    return ws;
}
