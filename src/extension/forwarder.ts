// Pi events → agent.event (coalesced, truncated, redacted). Handlers only enqueue: they never await the network.
import { truncateBytes } from "../shared/util.ts";

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
] as const;
export type ForwardedEvent = (typeof FORWARDED_EVENTS)[number];

export const LIMITS = {
  deltaFlushMs: 100,
  updateIntervalMs: 500,
  updateMaxBytes: 8 * 1024,
  resultMaxBytes: 32 * 1024,
  thinkingMaxBytes: 16 * 1024,
  toolArgsMaxBytes: 16 * 1024,
  summaryMaxBytes: 16 * 1024,
};

/** Bound an arbitrary JSON-serializable value to at most `maxBytes` UTF-8 bytes when serialized. */
export function truncateJsonValue(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") {
    return { value, truncated: false };
  }
  if (typeof value === "string") {
    const t = truncateBytes(value, maxBytes);
    return { value: t.text, truncated: t.truncated };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src);
    const perField = Math.max(256, Math.floor((maxBytes - 256) / Math.max(1, keys.length)));
    const copy: Record<string, unknown> = {};
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && Buffer.byteLength(v, "utf8") > perField) {
        copy[k] = truncateBytes(v, perField).text;
      } else {
        copy[k] = v;
      }
    }
    try {
      if (Buffer.byteLength(JSON.stringify(copy), "utf8") <= maxBytes) {
        return { value: copy, truncated: true };
      }
    } catch {
      /* fall through to preview */
    }
  }
  const previewBudget = Math.max(64, maxBytes - 64);
  return {
    value: { _truncated: true, preview: truncateBytes(serialized, previewBudget).text },
    truncated: true,
  };
}

/** Replace inline image data with a reference; bound text, thinking, and tool call payloads. */
export function normalizeContentBlock(block: any, maxTextBytes: number): any {
  if (!block || typeof block !== "object") return block;
  if (block.type === "image") {
    const bytes = typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0;
    return { type: "image_ref", mimeType: block.mimeType, bytes };
  }
  if (block.type === "text" && typeof block.text === "string") {
    const { text, truncated } = truncateBytes(block.text, maxTextBytes);
    return truncated ? { ...block, text, truncated: true } : block;
  }
  if (block.type === "thinking") {
    const budget = Math.min(maxTextBytes, LIMITS.thinkingMaxBytes);
    let out = block;
    let truncated = false;
    if (typeof block.thinking === "string") {
      const t = truncateBytes(block.thinking, budget);
      if (t.truncated) {
        out = { ...out, thinking: t.text, truncated: true };
        truncated = true;
      }
    }
    if (typeof block.text === "string") {
      const t = truncateBytes(block.text, budget);
      if (t.truncated) {
        out = { ...out, text: t.text, truncated: true };
        truncated = true;
      }
    }
    return truncated ? out : block;
  }
  if (block.type === "toolCall" || block.type === "tool_use") {
    const budget = Math.min(maxTextBytes, LIMITS.toolArgsMaxBytes);
    let out = block;
    let truncated = false;
    for (const field of ["arguments", "args", "input"] as const) {
      if (block[field] !== undefined) {
        const res = truncateJsonValue(block[field], budget);
        if (res.truncated) {
          out = { ...out, [field]: res.value, truncated: true };
          truncated = true;
        }
      }
    }
    return truncated ? out : block;
  }
  return block;
}

export function normalizeMessage(msg: any, maxTextBytes = LIMITS.resultMaxBytes): any {
  if (!msg || typeof msg !== "object") return msg;
  let out = msg;
  let changed = false;
  const clone = () => {
    if (!changed) {
      out = { ...msg };
      changed = true;
    }
    return out;
  };
  if (Array.isArray(msg.content)) {
    const next = msg.content.map((b: any) => normalizeContentBlock(b, maxTextBytes));
    clone().content = next;
  } else if (typeof msg.content === "string") {
    const { text, truncated } = truncateBytes(msg.content, maxTextBytes);
    if (truncated) {
      const c = clone();
      c.content = text;
      c.truncated = true;
    }
  }
  for (const field of ["summary", "output", "command"] as const) {
    if (typeof msg[field] === "string") {
      const { text, truncated } = truncateBytes(msg[field], maxTextBytes);
      if (truncated) {
        const c = clone();
        c[field] = text;
        c.truncated = true;
      }
    }
  }
  if (msg.details !== undefined) {
    const d = truncateJsonValue(msg.details, maxTextBytes);
    if (d.truncated) {
      const c = clone();
      c.details = d.value;
      c.truncated = true;
    }
  }
  return out;
}

export function normalizeToolResult(result: any, maxBytes: number): { result: any; truncated: boolean } {
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
    out.content = out.content.map((b: any) => {
      const n = normalizeContentBlock(b, maxBytes);
      if (n?.truncated) truncated = true;
      return n;
    });
  }
  if (out.details !== undefined) {
    const d = truncateJsonValue(out.details, maxBytes);
    if (d.truncated) {
      out.details = d.value;
      truncated = true;
    }
  }
  if (truncated) out.truncated = true;
  return { result: out, truncated };
}

export interface ForwarderDeps {
  send: (e: Record<string, unknown>) => void;
  redact: boolean;
  /** Notified for status derivation (not part of the wire). */
  onToolStart?: (toolName: string, args: any, toolCallId?: string, parentToolCallId?: string) => void;
  onToolEnd?: (toolName: string, result: any, isError: boolean, toolCallId?: string, durationMs?: number, parentToolCallId?: string) => void;
  onAgentStart?: () => void;
  onAgentSettled?: (aborted?: boolean) => void;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
  now?: () => number;
}

interface DeltaBuf {
  contentIndex: number;
  kind: "text" | "thinking" | "toolcall";
  delta: string;
}

export class Forwarder {
  private deltas = new Map<string, DeltaBuf>();
  private deltaTimer: NodeJS.Timeout | null = null;
  private lastUpdateAt = new Map<string, number>();
  private pendingUpdate = new Map<string, { ev: any; timer: NodeJS.Timeout | null }>();
  private disposed = false;
  private set: typeof setTimeout;
  private clear: typeof clearTimeout;
  private now: () => number;

  constructor(private d: ForwarderDeps) {
    this.set = d.timers?.set ?? setTimeout;
    this.clear = d.timers?.clear ?? clearTimeout;
    this.now = d.now ?? Date.now;
  }

  handle(name: ForwardedEvent, ev: any): void {
    if (this.disposed) return;
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
        if (this.d.redact) return;
        this.flushDeltas();
        return this.d.send({ type: "message_start", message: normalizeMessage(ev?.message) });
      case "message_update":
        if (this.d.redact) return;
        return this.onMessageUpdate(ev);
      case "message_end":
        if (this.d.redact) return;
        this.flushDeltas();
        return this.d.send({ type: "message_end", message: normalizeMessage(ev?.message) });
      case "tool_execution_start": {
        this.d.onToolStart?.(ev?.toolName, ev?.args, ev?.toolCallId, ev?.parentToolCallId);
        const boundedArgs = this.d.redact ? undefined : truncateJsonValue(ev?.args, LIMITS.toolArgsMaxBytes).value;
        return this.d.send({
          type: "tool_execution_start",
          toolCallId: ev?.toolCallId,
          toolName: ev?.toolName,
          ...(this.d.redact ? {} : { args: boundedArgs }),
          ...(ev?.parentToolCallId ? { parentToolCallId: ev.parentToolCallId } : {}),
        });
      }
      case "tool_execution_update":
        if (this.d.redact) return;
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
      case "session_compact": {
        const rawSummary = ev?.compactionEntry?.summary;
        const summary =
          typeof rawSummary === "string" ? truncateBytes(rawSummary, LIMITS.summaryMaxBytes).text : rawSummary;
        return this.d.send({
          type: "session_compact",
          reason: ev?.reason,
          ...(this.d.redact ? {} : { summary }),
        });
      }
    }
  }

  private onMessageUpdate(ev: any): void {
    const ame = ev?.assistantMessageEvent;
    const m = /^(text|thinking|toolcall)_delta$/.exec(ame?.type ?? "");
    if (!m || typeof ame.delta !== "string") return;
    const kind = m[1] as DeltaBuf["kind"];
    const key = `${ame.contentIndex}:${kind}`;
    const cur = this.deltas.get(key);
    if (cur) cur.delta += ame.delta;
    else this.deltas.set(key, { contentIndex: ame.contentIndex, kind, delta: ame.delta });
    if (!this.deltaTimer) {
      this.deltaTimer = this.set(() => this.flushDeltas(), LIMITS.deltaFlushMs);
      this.deltaTimer.unref?.();
    }
  }

  flushDeltas(): void {
    if (this.deltaTimer) this.clear(this.deltaTimer);
    this.deltaTimer = null;
    if (!this.deltas.size || this.disposed) return;
    const items = [...this.deltas.values()];
    this.deltas.clear();
    for (const it of items) {
      let rem = it.delta;
      if (Buffer.byteLength(rem, "utf8") <= LIMITS.resultMaxBytes) {
        this.d.send({ type: "message_delta", contentIndex: it.contentIndex, kind: it.kind, delta: rem });
        continue;
      }
      while (rem.length > 0) {
        const chunk = truncateBytes(rem, LIMITS.resultMaxBytes).text;
        if (!chunk) break;
        this.d.send({ type: "message_delta", contentIndex: it.contentIndex, kind: it.kind, delta: chunk });
        rem = rem.slice(chunk.length);
      }
    }
  }

  private emitUpdate(ev: any): void {
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
  private onToolUpdate(ev: any): void {
    const id = ev.toolCallId as string;
    const last = this.lastUpdateAt.get(id) ?? 0;
    const wait = LIMITS.updateIntervalMs - (this.now() - last);
    const pending = this.pendingUpdate.get(id);
    if (wait <= 0 && !pending) return this.emitUpdate(ev);
    if (pending) {
      pending.ev = ev;
      return;
    }
    const entry: { ev: any; timer: NodeJS.Timeout | null } = { ev, timer: null };
    entry.timer = this.set(() => {
      this.pendingUpdate.delete(id);
      if (!this.disposed) this.emitUpdate(entry.ev);
    }, Math.max(0, wait));
    entry.timer.unref?.();
    this.pendingUpdate.set(id, entry);
  }

  private onToolEnd(ev: any): void {
    const id = ev?.toolCallId as string;
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
    if (this.d.redact) return this.d.send(base);
    const { result, truncated } = normalizeToolResult(ev?.result, LIMITS.resultMaxBytes);
    this.d.send({ ...base, result, ...(truncated ? { truncated: true } : {}) });
  }

  dispose(): void {
    this.flushDeltas();
    this.disposed = true;
    for (const p of this.pendingUpdate.values()) if (p.timer) this.clear(p.timer);
    this.pendingUpdate.clear();
  }
}
