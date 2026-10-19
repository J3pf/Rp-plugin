// Antigravity CLI (agy) transcript.jsonl reader & normalizer for RemotePi.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SnapshotEntry } from "../extension/snapshot.ts";
import { SNAPSHOT_LIMIT } from "../extension/snapshot.ts";
import { LIMITS } from "../extension/forwarder.ts";
import type { SubagentToolCall, SubagentUpdateEvent } from "../shared/protocol.ts";
import { truncateBytes } from "../shared/util.ts";

export interface AgyToolCallRaw {
  id?: string | null;
  name?: string;
  args?: Record<string, unknown> | string | null;
  arguments?: Record<string, unknown> | string | null;
}

export interface AgyMediaRaw {
  mime_type?: string;
  uri?: string;
}

export interface AgyStepRaw {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string | null;
  thinking?: string | null;
  tool_calls?: AgyToolCallRaw[] | null;
  media?: AgyMediaRaw[] | null;
  truncated_fields?: string[] | null;
}

export interface NormalizedAgyTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  subagentSpec?: {
    role: string;
    typeName: string;
    prompt: string;
  };
}

const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;

/** Extract clean user message text from an agy USER_INPUT content payload. */
export function extractAgyUserText(rawContent: string | null | undefined): {
  kind: "user" | "compaction" | "skip";
  text: string;
} {
  if (!rawContent || typeof rawContent !== "string") return { kind: "skip", text: "" };
  const match = USER_REQ_RE.exec(rawContent);
  if (match) {
    const clean = match[1]!.trim();
    return clean ? { kind: "user", text: clean } : { kind: "skip", text: "" };
  }
  const trimmed = rawContent.trim();
  if (!trimmed) return { kind: "skip", text: "" };
  if (trimmed.includes("<SYSTEM_MESSAGE>")) return { kind: "skip", text: "" };
  if (trimmed.includes("<CONTEXT_SUMMARY>")) {
    return { kind: "compaction", text: "Contexto de conversación compactado" };
  }
  return { kind: "user", text: trimmed };
}

/** Parse stringified JSON values inside agy's protojson tool_calls.args map. */
export function parseAgyArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) return parseAgyArgs(p);
    } catch {
      return { value: raw };
    }
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") {
      const t = v.trim();
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("{") && t.endsWith("}")) ||
        (t.startsWith("[") && t.endsWith("]")) ||
        t === "true" ||
        t === "false" ||
        /^-?\d+(\.\d+)?$/.test(t)
      ) {
        try {
          out[k] = JSON.parse(t);
          continue;
        } catch {
          /* keep raw string */
        }
      }
    }
    out[k] = v;
  }
  return out;
}

/** Map agy tool names and arguments to Rp-app's canonical tool card format. */
export function normalizeAgyToolCall(
  stepIndex: number,
  callIndex: number,
  rawCall: AgyToolCallRaw,
): NormalizedAgyTool {
  const toolCallId = rawCall.id && String(rawCall.id).trim() ? String(rawCall.id).trim() : `agy:${stepIndex}:${callIndex}`;
  const rawName = String(rawCall.name ?? "tool");
  const parsed = parseAgyArgs(rawCall.args ?? rawCall.arguments);

  switch (rawName) {
    case "run_command":
      return {
        toolCallId,
        name: "bash",
        args: {
          command: String(parsed.CommandLine ?? parsed.command ?? ""),
          ...(parsed.Cwd ? { cwd: parsed.Cwd } : {}),
        },
      };
    case "view_file":
      return {
        toolCallId,
        name: "read",
        args: {
          path: String(parsed.AbsolutePath ?? parsed.path ?? ""),
          ...(parsed.StartLine !== undefined ? { startLine: parsed.StartLine } : {}),
          ...(parsed.EndLine !== undefined ? { endLine: parsed.EndLine } : {}),
        },
      };
    case "write_to_file":
      return {
        toolCallId,
        name: "write",
        args: {
          path: String(parsed.TargetFile ?? parsed.path ?? ""),
          ...(parsed.Description ? { description: parsed.Description } : {}),
        },
      };
    case "replace_file_content":
      return {
        toolCallId,
        name: "edit",
        args: {
          path: String(parsed.TargetFile ?? parsed.path ?? ""),
          oldText: truncateBytes(String(parsed.TargetContent ?? ""), 4096).text,
          newText: truncateBytes(String(parsed.ReplacementContent ?? ""), 4096).text,
          ...(parsed.Instruction ? { instruction: truncateBytes(String(parsed.Instruction), 512).text } : {}),
        },
      };
    case "multi_replace_file_content": {
      const chunks = Array.isArray(parsed.ReplacementChunks) ? parsed.ReplacementChunks : [];
      const first = chunks[0] && typeof chunks[0] === "object" ? (chunks[0] as Record<string, unknown>) : null;
      return {
        toolCallId,
        name: "edit",
        args: {
          path: String(parsed.TargetFile ?? parsed.path ?? ""),
          ...(first
            ? {
                oldText: truncateBytes(String(first.TargetContent ?? ""), 4096).text,
                newText: truncateBytes(String(first.ReplacementContent ?? ""), 4096).text,
              }
            : {}),
          edits: chunks.slice(0, 10).map((c: any) => ({
            oldText: truncateBytes(String(c?.TargetContent ?? ""), 2048).text,
            newText: truncateBytes(String(c?.ReplacementContent ?? ""), 2048).text,
          })),
        },
      };
    }
    case "grep_search":
      return {
        toolCallId,
        name: "grep",
        args: {
          pattern: String(parsed.Query ?? parsed.pattern ?? ""),
          ...(parsed.SearchPath ? { path: parsed.SearchPath } : {}),
        },
      };
    case "find_by_name":
      return {
        toolCallId,
        name: "find",
        args: {
          pattern: String(parsed.Pattern ?? parsed.pattern ?? ""),
          ...(parsed.SearchDirectory ? { path: parsed.SearchDirectory } : {}),
        },
      };
    case "invoke_subagent": {
      const subs = Array.isArray(parsed.Subagents) ? parsed.Subagents : [];
      const first = subs[0] && typeof subs[0] === "object" ? (subs[0] as Record<string, unknown>) : {};
      const role = String(first.Role ?? parsed.toolSummary ?? "Subagent");
      const typeName = String(first.TypeName ?? "subagent");
      const prompt = String(first.Prompt ?? "");
      return {
        toolCallId,
        name: "subagent_run",
        args: {
          agent: typeName,
          label: role,
          task: truncateBytes(prompt, 500).text,
        },
        subagentSpec: { role, typeName, prompt },
      };
    }
    default: {
      const safeArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        safeArgs[k] = typeof v === "string" ? truncateBytes(v, 2048).text : v;
      }
      return {
        toolCallId,
        name: rawName,
        args: safeArgs,
      };
    }
  }
}

function stepTimestampMs(step: AgyStepRaw, stepIndex: number): number {
  const base = step.created_at ? Date.parse(step.created_at) : NaN;
  const ms = Number.isFinite(base) ? base : Date.now();
  // Add stepIndex offset so rapid steps within the same second never collide in ChatReducer.keyOf
  return ms + stepIndex;
}

/** Resolve the default path to an agy conversation's transcript.jsonl. */
export function resolveAgyTranscriptPath(conversationId: string, home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/** Read a specific step_index from transcript_full.jsonl when truncated_fields is present. */
function readFullStep(transcriptPath: string, stepIndex: number): AgyStepRaw | null {
  const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
  try {
    const stat = fs.statSync(fullPath);
    const tailBytes = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(fullPath, "r");
    try {
      const buf = Buffer.allocUnsafe(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as AgyStepRaw;
          if (parsed.step_index === stepIndex) return parsed;
        } catch {
          /* ignore partial first line */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* full transcript unavailable */
  }
  return null;
}

interface PendingTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  at: number;
  subagentSpec?: { role: string; typeName: string; prompt: string };
}

export const MAX_SNAPSHOT_BYTES = 220 * 1024;

function compactSnapshotEntry(entry: SnapshotEntry, isRecent: boolean): SnapshotEntry {
  if (isRecent || entry.kind !== "tool_result" || !entry.msg || typeof entry.msg !== "object") return entry;
  const msg = entry.msg as Record<string, unknown>;
  const content = Array.isArray(msg.content) ? msg.content : null;
  if (!content || content.length === 0) return entry;
  const first = content[0] as Record<string, unknown> | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string" || first.text.length <= 1024) return entry;
  return {
    ...entry,
    msg: {
      ...msg,
      content: [{ type: "text", text: truncateBytes(first.text, 1024).text }],
    },
  };
}

/**
 * Stateful incremental reader for an agy `transcript.jsonl` file.
 * Produces SnapshotEntries for initial history and live AgentEventPayloads on new lines.
 */
export class AgyTranscriptReader {
  private offset = 0;
  private remainder = "";
  private lastStepIndex = -1;
  private pendingTools: PendingTool[] = [];
  private entries: SnapshotEntry[] = [];
  private subagents = new Map<string, SubagentUpdateEvent>();
  private lastTopic: string | null = null;

  constructor(
    readonly transcriptPath: string,
    private redact: () => boolean = () => false,
  ) {}

  getSubagents(): SubagentUpdateEvent[] {
    return [...this.subagents.values()];
  }

  getSessionTopic(): string | null {
    if (this.redact()) return null;
    return this.lastTopic;
  }

  /** Load or refresh the transcript from disk and return the current snapshot (capped by count and byte budget). */
  readSnapshot(): { entries: SnapshotEntry[]; truncated: boolean; events: Record<string, unknown>[] } {
    const events = this.pollNewEvents();
    const picked: SnapshotEntry[] = [];
    let bytesUsed = 0;
    let truncated = false;
    const recentThreshold = Math.max(0, this.entries.length - 12);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = compactSnapshotEntry(this.entries[i]!, i >= recentThreshold);
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 2;
      if (picked.length >= SNAPSHOT_LIMIT || (picked.length > 0 && bytesUsed + entryBytes > MAX_SNAPSHOT_BYTES)) {
        truncated = true;
        break;
      }
      picked.push(entry);
      bytesUsed += entryBytes;
    }
    picked.reverse();
    return { entries: picked, truncated, events };
  }

  /** Read any newly appended lines from transcript.jsonl and convert them into live events. */
  pollNewEvents(): Record<string, unknown>[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.transcriptPath);
    } catch {
      return [];
    }

    // If file was truncated/replaced, reset state
    if (stat.size < this.offset) {
      this.offset = 0;
      this.remainder = "";
      this.lastStepIndex = -1;
      this.pendingTools = [];
      this.entries = [];
      this.subagents.clear();
    }

    // On first read of a large file (>512 KB), seek to the last 512 KB so startup is fast and light
    if (this.offset === 0 && stat.size > 512 * 1024) {
      this.offset = stat.size - 512 * 1024;
    }

    const deltaBytes = stat.size - this.offset;
    if (deltaBytes <= 0) return [];

    let chunk = "";
    const fd = fs.openSync(this.transcriptPath, "r");
    try {
      const buf = Buffer.allocUnsafe(deltaBytes);
      const bytesRead = fs.readSync(fd, buf, 0, deltaBytes, this.offset);
      this.offset += bytesRead;
      chunk = this.remainder + buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    const lines = chunk.split("\n");
    this.remainder = lines.pop() ?? "";

    const liveEvents: Record<string, unknown>[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!.trim();
      if (!line.startsWith("{")) continue;
      let step: AgyStepRaw;
      try {
        step = JSON.parse(line) as AgyStepRaw;
      } catch {
        continue;
      }
      const idx = typeof step.step_index === "number" ? step.step_index : this.lastStepIndex + 1;
      if (idx <= this.lastStepIndex) continue;
      this.lastStepIndex = idx;

      // Only resolve from transcript_full.jsonl for recent tail lines (last 5 lines) to avoid bulk I/O during initial load
      if (
        li >= lines.length - 5 &&
        step.type === "PLANNER_RESPONSE" &&
        Array.isArray(step.truncated_fields) &&
        (step.truncated_fields.includes("content") || step.truncated_fields.includes("tool_calls"))
      ) {
        const full = readFullStep(this.transcriptPath, idx);
        if (full) step = full;
      }

      this.processStep(step, idx, liveEvents);
    }

    // Cap stored entries in memory
    if (this.entries.length > SNAPSHOT_LIMIT * 2) {
      this.entries = this.entries.slice(this.entries.length - SNAPSHOT_LIMIT - 20);
    }

    return liveEvents;
  }

  private processStep(step: AgyStepRaw, stepIndex: number, outEvents: Record<string, unknown>[]): void {
    const at = stepTimestampMs(step, stepIndex);
    const eid = `agy:${stepIndex}`;
    const isRedacted = this.redact();

    if (step.type === "USER_INPUT") {
      // Flush any unmatched pending tools before a new user turn
      this.pendingTools = [];
      const extracted = extractAgyUserText(step.content);
      if (extracted.kind === "skip") return;
      if (extracted.kind === "compaction") {
        this.entries.push({ eid, kind: "compaction", at, msg: isRedacted ? {} : { summary: extracted.text } });
        outEvents.push({ type: "session_compact", ...(isRedacted ? {} : { summary: extracted.text }) });
        return;
      }
      const firstLine = extracted.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      if (firstLine) {
        this.lastTopic = firstLine.length > 42 ? firstLine.slice(0, 41) + "…" : firstLine;
      }
      const contentBlocks: unknown[] = [{ type: "text", text: truncateBytes(extracted.text, LIMITS.resultMaxBytes).text }];
      if (Array.isArray(step.media)) {
        for (const m of step.media) {
          if (m?.mime_type?.startsWith("image/")) {
            contentBlocks.push({ type: "image_ref", mimeType: m.mime_type, bytes: 0 });
          }
        }
      }
      const msg = isRedacted ? { role: "user", timestamp: at } : { role: "user", timestamp: at, content: contentBlocks };
      this.entries.push({ eid, kind: "user", at, msg });
      if (!isRedacted) {
        outEvents.push({ type: "message_end", message: msg });
      }
      return;
    }

    if (step.type === "PLANNER_RESPONSE") {
      const blocks: unknown[] = [];
      if (!isRedacted && typeof step.thinking === "string" && step.thinking.trim()) {
        blocks.push({ type: "thinking", thinking: truncateBytes(step.thinking.trim(), LIMITS.resultMaxBytes).text });
      }
      if (!isRedacted && typeof step.content === "string" && step.content.trim()) {
        blocks.push({ type: "text", text: truncateBytes(step.content.trim(), LIMITS.resultMaxBytes).text });
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const normalizedCalls: NormalizedAgyTool[] = [];
      for (let i = 0; i < calls.length; i++) {
        const norm = normalizeAgyToolCall(stepIndex, i, calls[i]!);
        normalizedCalls.push(norm);
        blocks.push({
          type: "toolCall",
          id: norm.toolCallId,
          name: norm.name,
          arguments: isRedacted ? {} : norm.args,
        });
      }

      if (blocks.length > 0) {
        const msg = isRedacted
          ? { role: "assistant", timestamp: at }
          : { role: "assistant", timestamp: at, content: blocks };
        this.entries.push({ eid, kind: "assistant", at, msg });
        if (!isRedacted) {
          outEvents.push({ type: "message_end", message: msg });
        }
      }

      for (const norm of normalizedCalls) {
        this.pendingTools.push({
          toolCallId: norm.toolCallId,
          name: norm.name,
          args: norm.args,
          at,
          subagentSpec: norm.subagentSpec,
        });
        outEvents.push({
          type: "tool_execution_start",
          toolCallId: norm.toolCallId,
          toolName: norm.name,
          ...(isRedacted ? {} : { args: norm.args }),
        });
        if (norm.subagentSpec) {
          const sub: SubagentUpdateEvent = {
            type: "subagent_update",
            taskId: norm.toolCallId,
            agent: norm.subagentSpec.typeName,
            label: isRedacted ? "[redacted]" : norm.subagentSpec.role,
            status: "running",
            startedAt: at,
            tools: [] as SubagentToolCall[],
          };
          this.subagents.set(norm.toolCallId, sub);
          outEvents.push(sub as unknown as Record<string, unknown>);
        }
      }
      return;
    }

    if (step.type === "GENERIC" && this.pendingTools.length > 0) {
      const pending = this.pendingTools.shift()!;
      const isError = step.status === "ERROR";
      const rawOut = typeof step.content === "string" ? step.content : "";
      const { text, truncated } = truncateBytes(rawOut, LIMITS.resultMaxBytes);
      const resultObj = {
        content: [{ type: "text", text }],
        ...(truncated ? { truncated: true } : {}),
      };
      const entryMsg = {
        role: "toolResult",
        toolCallId: pending.toolCallId,
        toolName: pending.name,
        isError,
        ...(isRedacted ? {} : { content: resultObj.content }),
      };
      this.entries.push({ eid, kind: "tool_result", at, msg: entryMsg });
      outEvents.push({
        type: "tool_execution_end",
        toolCallId: pending.toolCallId,
        toolName: pending.name,
        isError,
        durationMs: Math.max(0, at - pending.at),
        ...(isRedacted ? {} : { result: resultObj, ...(truncated ? { truncated: true } : {}) }),
      });

      const sub = this.subagents.get(pending.toolCallId);
      if (sub) {
        const finished: SubagentUpdateEvent = {
          ...sub,
          status: isError ? "error" : "done",
          endedAt: at,
          durationMs: Math.max(0, at - (sub.startedAt ?? at)),
          ...(isRedacted
            ? {}
            : isError
              ? { error: truncateBytes(rawOut, 4096).text }
              : { result: truncateBytes(rawOut, 4096).text }),
        };
        this.subagents.set(pending.toolCallId, finished);
        outEvents.push(finished as unknown as Record<string, unknown>);
      }
    }
  }
}
