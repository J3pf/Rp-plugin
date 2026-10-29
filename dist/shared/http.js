// Minimal HTTP(S) client honoring HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS via proxy-agent.
import http from "node:http";
import https from "node:https";
let sharedAgent;
export async function getProxyAgent() {
    if (sharedAgent)
        return sharedAgent;
    try {
        const mod = await import("proxy-agent");
        sharedAgent = new mod.ProxyAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });
    }
    catch {
        sharedAgent = undefined;
    }
    return sharedAgent;
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
    return new Promise((resolve, reject) => {
        let onAbort;
        const cleanup = () => {
            if (onAbort && opts.signal) {
                opts.signal.removeEventListener("abort", onAbort);
                onAbort = undefined;
            }
        };
        const req = lib.request(u, { method: opts.method ?? (payload ? "POST" : "GET"), headers, agent, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
            const chunks = [];
            let size = 0;
            res.on("data", (c) => {
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
                let json;
                if ((res.headers["content-type"] ?? "").includes("json") && body.length) {
                    try {
                        json = JSON.parse(body.toString("utf8"));
                    }
                    catch {
                        json = undefined;
                    }
                }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
            });
            res.on("error", (err) => {
                cleanup();
                reject(err);
            });
        });
        req.on("timeout", () => req.destroy(new Error("request timeout")));
        req.on("error", (err) => {
            cleanup();
            reject(err);
        });
        if (opts.signal) {
            if (opts.signal.aborted)
                req.destroy(new Error("aborted"));
            else {
                onAbort = () => req.destroy(new Error("aborted"));
                opts.signal.addEventListener("abort", onAbort, { once: true });
            }
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
