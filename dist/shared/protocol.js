// Local mirror of the RP wire protocol v1 (rp-relay/docs/PROTOCOLO.md).
// Kept dependency-free so the plugin works without @j3pf/rp-protocol being published.
import { ulid } from "ulid";
export const PROTOCOL_VERSION = 1;
export function newId() {
    return ulid();
}
export function envelope(t, d, opts = {}) {
    const e = { v: PROTOCOL_VERSION, t, ts: Date.now(), d };
    if (opts.id)
        e.id = opts.id;
    if (opts.re)
        e.re = opts.re;
    return e;
}
export function parseEnvelope(raw) {
    let o = raw;
    if (typeof raw === "string") {
        try {
            o = JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    if (!o || typeof o !== "object" || typeof o.t !== "string")
        return null;
    if (typeof o.v !== "number")
        return null;
    return { v: o.v, t: o.t, id: o.id, re: o.re, ts: typeof o.ts === "number" ? o.ts : Date.now(), d: o.d ?? {} };
}
export const CLOSE = {
    SERVICE_RESTART: 1012,
    INVALID_TOKEN: 4001,
    INCOMPATIBLE: 4002,
    REPLACED: 4003,
    BAD_FRAME: 4008,
};
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Encode optional panel display metadata into `AgentHerdrLocation.tabId` for bridged sessions. */
export function encodeHerdrTabId(opts) {
    const idx = opts.orderIndex;
    const hasOrder = typeof idx === "number" && Number.isFinite(idx) && idx > 0;
    const isDone = !!opts.isDone;
    const ctx = opts.context;
    const hasCtx = !!ctx && ctx.tokens > 0 && ctx.contextWindow > 0;
    if (!hasOrder && !isDone && !hasCtx) {
        return opts.tabId;
    }
    const orderPart = hasOrder ? `#${String(Math.floor(idx)).padStart(4, "0")}` : "";
    const donePart = isDone ? "~done" : "";
    const ctxPart = hasCtx ? `@${ctx.tokens}/${ctx.contextWindow}` : "";
    return `${orderPart}${donePart}${ctxPart}|${opts.tabId ?? ""}`;
}
/** Message types the plugin sends that must never be dropped from the outbound queue. */
export const CRITICAL_TYPES = new Set([
    "agent.hello",
    "prompt.open",
    "prompt.resolved",
    "prompt.ack",
    "user.message.ack",
]);
