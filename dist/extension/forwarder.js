// Pi events → agent.event (coalesced, truncated, redacted). Handlers only enqueue: they never await the network.
import { truncateBytes } from "../shared/util.js";
export const FORWARDED_EVENTS = [
    "agent_start",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_info_changed",
    "model_select",
    "thinking_level_select",
    "session_compact",
];
export const LIMITS = {
    deltaFlushMs: 100,
    updateIntervalMs: 500,
    updateMaxBytes: 8 * 1024,
    resultMaxBytes: 32 * 1024,
};
/** Replace inline image data with a reference; keep everything else as Pi produced it. */
export function normalizeContentBlock(block, maxTextBytes) {
    if (!block || typeof block !== "object")
        return block;
    if (block.type === "image") {
        const bytes = typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0;
        return { type: "image_ref", mimeType: block.mimeType, bytes };
    }
    if (block.type === "text" && typeof block.text === "string") {
        const { text, truncated } = truncateBytes(block.text, maxTextBytes);
        return truncated ? { ...block, text, truncated: true } : block;
    }
    return block;
}
export function normalizeMessage(msg, maxTextBytes = LIMITS.resultMaxBytes) {
    if (!msg || typeof msg !== "object")
        return msg;
    if (Array.isArray(msg.content))
        return { ...msg, content: msg.content.map((b) => normalizeContentBlock(b, maxTextBytes)) };
    if (typeof msg.content === "string") {
        const { text, truncated } = truncateBytes(msg.content, maxTextBytes);
        return truncated ? { ...msg, content: text, truncated: true } : msg;
    }
    return msg;
}
export function normalizeToolResult(result, maxBytes) {
    if (!result || typeof result !== "object") {
        if (typeof result === "string") {
            const t = truncateBytes(result, maxBytes);
            return { result: t.text, truncated: t.truncated };
        }
        return { result, truncated: false };
    }
    let truncated = false;
    const out = { ...result };
    if (Array.isArray(out.content)) {
        out.content = out.content.map((b) => {
            const n = normalizeContentBlock(b, maxBytes);
            if (n?.truncated)
                truncated = true;
            return n;
        });
    }
    if (truncated)
        out.truncated = true;
    return { result: out, truncated };
}
export class Forwarder {
    d;
    deltas = new Map();
    deltaTimer = null;
    lastUpdateAt = new Map();
    pendingUpdate = new Map();
    disposed = false;
    set;
    clear;
    now;
    constructor(d) {
        this.d = d;
        this.set = d.timers?.set ?? setTimeout;
        this.clear = d.timers?.clear ?? clearTimeout;
        this.now = d.now ?? Date.now;
    }
    handle(name, ev) {
        if (this.disposed)
            return;
        switch (name) {
            case "agent_start":
                this.d.onAgentStart?.();
                return this.d.send({ type: "agent_start" });
            case "agent_settled":
                this.flushDeltas();
                this.d.onAgentSettled?.(!!ev?.aborted);
                return this.d.send({ type: "agent_settled", aborted: !!ev?.aborted });
            case "turn_start":
                return this.d.send({ type: "turn_start", turnIndex: ev?.turnIndex });
            case "turn_end":
                // message/toolResults already travel via message_end
                return this.d.send({ type: "turn_end", turnIndex: ev?.turnIndex });
            case "message_start":
                if (this.d.redact)
                    return;
                this.flushDeltas();
                return this.d.send({ type: "message_start", message: normalizeMessage(ev?.message) });
            case "message_update":
                if (this.d.redact)
                    return;
                return this.onMessageUpdate(ev);
            case "message_end":
                if (this.d.redact)
                    return;
                this.flushDeltas();
                return this.d.send({ type: "message_end", message: normalizeMessage(ev?.message) });
            case "tool_execution_start":
                this.d.onToolStart?.(ev?.toolName, ev?.args, ev?.toolCallId, ev?.parentToolCallId);
                return this.d.send({
                    type: "tool_execution_start",
                    toolCallId: ev?.toolCallId,
                    toolName: ev?.toolName,
                    ...(this.d.redact ? {} : { args: ev?.args }),
                    ...(ev?.parentToolCallId ? { parentToolCallId: ev.parentToolCallId } : {}),
                });
            case "tool_execution_update":
                if (this.d.redact)
                    return;
                return this.onToolUpdate(ev);
            case "tool_execution_end":
                return this.onToolEnd(ev);
            case "session_info_changed":
                return this.d.send({ type: "session_info_changed", name: this.d.redact ? null : (ev?.name ?? null) });
            case "model_select":
                return this.d.send({
                    type: "model_select",
                    model: ev?.model ? { provider: ev.model.provider, id: ev.model.id } : null,
                    previousModel: ev?.previousModel ? { provider: ev.previousModel.provider, id: ev.previousModel.id } : null,
                    source: ev?.source,
                });
            case "thinking_level_select":
                return this.d.send({ type: "thinking_level_select", level: ev?.level, previousLevel: ev?.previousLevel });
            case "session_compact":
                return this.d.send({
                    type: "session_compact",
                    reason: ev?.reason,
                    ...(this.d.redact ? {} : { summary: ev?.compactionEntry?.summary }),
                });
        }
    }
    onMessageUpdate(ev) {
        const ame = ev?.assistantMessageEvent;
        const m = /^(text|thinking|toolcall)_delta$/.exec(ame?.type ?? "");
        if (!m || typeof ame.delta !== "string")
            return;
        const kind = m[1];
        const key = `${ame.contentIndex}:${kind}`;
        const cur = this.deltas.get(key);
        if (cur)
            cur.delta += ame.delta;
        else
            this.deltas.set(key, { contentIndex: ame.contentIndex, kind, delta: ame.delta });
        if (!this.deltaTimer) {
            this.deltaTimer = this.set(() => this.flushDeltas(), LIMITS.deltaFlushMs);
            this.deltaTimer.unref?.();
        }
    }
    flushDeltas() {
        if (this.deltaTimer)
            this.clear(this.deltaTimer);
        this.deltaTimer = null;
        if (!this.deltas.size || this.disposed)
            return;
        const items = [...this.deltas.values()];
        this.deltas.clear();
        for (const it of items)
            this.d.send({ type: "message_delta", contentIndex: it.contentIndex, kind: it.kind, delta: it.delta });
    }
    emitUpdate(ev) {
        const { result, truncated } = normalizeToolResult(ev.partialResult, LIMITS.updateMaxBytes);
        this.lastUpdateAt.set(ev.toolCallId, this.now());
        this.d.send({
            type: "tool_execution_update",
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            partialResult: result,
            ...(truncated ? { truncated: true } : {}),
            ...(ev.parentToolCallId ? { parentToolCallId: ev.parentToolCallId } : {}),
        });
    }
    /** ≤ 1 update / 500 ms per tool call; the latest value is flushed on the trailing edge. */
    onToolUpdate(ev) {
        const id = ev.toolCallId;
        const last = this.lastUpdateAt.get(id) ?? 0;
        const wait = LIMITS.updateIntervalMs - (this.now() - last);
        const pending = this.pendingUpdate.get(id);
        if (wait <= 0 && !pending)
            return this.emitUpdate(ev);
        if (pending) {
            pending.ev = ev;
            return;
        }
        const entry = { ev, timer: null };
        entry.timer = this.set(() => {
            this.pendingUpdate.delete(id);
            if (!this.disposed)
                this.emitUpdate(entry.ev);
        }, Math.max(0, wait));
        entry.timer.unref?.();
        this.pendingUpdate.set(id, entry);
    }
    onToolEnd(ev) {
        const id = ev?.toolCallId;
        const p = this.pendingUpdate.get(id);
        if (p?.timer) {
            this.clear(p.timer);
            this.pendingUpdate.delete(id);
        }
        this.lastUpdateAt.delete(id);
        this.d.onToolEnd?.(ev?.toolName, ev?.result, !!ev?.isError, id, ev?.durationMs, ev?.parentToolCallId);
        const base = {
            type: "tool_execution_end",
            toolCallId: id,
            toolName: ev?.toolName,
            isError: !!ev?.isError,
            ...(ev?.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
            ...(ev?.parentToolCallId ? { parentToolCallId: ev.parentToolCallId } : {}),
        };
        if (this.d.redact)
            return this.d.send(base);
        const { result, truncated } = normalizeToolResult(ev?.result, LIMITS.resultMaxBytes);
        this.d.send({ ...base, result, ...(truncated ? { truncated: true } : {}) });
    }
    dispose() {
        this.flushDeltas();
        this.disposed = true;
        for (const p of this.pendingUpdate.values())
            if (p.timer)
                this.clear(p.timer);
        this.pendingUpdate.clear();
    }
}
