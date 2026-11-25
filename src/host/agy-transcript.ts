// Antigravity CLI (agy) stateful transcript.jsonl reader for RemotePi.
import fs from "node:fs";
import path from "node:path";
import type { SnapshotEntry } from "../extension/snapshot.ts";
import { SNAPSHOT_LIMIT } from "../extension/snapshot.ts";
import { LIMITS } from "../extension/forwarder.ts";
import type { SubagentTokens, SubagentUpdateEvent } from "../shared/protocol.ts";
import { SAFE_CONV_ID_RE, truncateBytes } from "../shared/util.ts";
import {
  AGY_CLAUDE_CONTEXT_WINDOW,
  AGY_CONTEXT_WINDOW,
  AGY_GEMINI_CONTEXT_WINDOW,
  AGY_GPT_OSS_CONTEXT_WINDOW,
  computeContextUsage,
  extractAgyUserText,
  extractSessionTopic,
  isBackgroundTaskError,
  isFinalBackgroundWakeup,
  isSafeSystemSender,
  normalizeAgyToolCall,
  normalizeAgyToolCalls,
  parseAgyArgs,
  parseBackgroundTaskAck,
  parseSpawnedSubagentRefs,
  parseSystemWakeup,
  readFullStepsMap,
  readLogTail,
  readTranscriptChunk,
  realpathOrNull,
  resolveAgyContextWindow,
  resolveAllowedFileUri,
  resolveSafeFileCandidate,
  stepTimestampMs,
  subagentChanged,
  summarizeAgyToolTask,
  toNonNegInt,
  type AgyMediaRaw,
  type AgyStepRaw,
  type AgyToolCallRaw,
  type NormalizedAgyTool,
} from "./bridge/agy-normalize.ts";
import {
  AGY_TAIL_WINDOW_BYTES,
  MODEL_CHANGE_RE,
  inferAgyHomeFromTranscriptPath,
  readTailBuffer,
  resolveAgyTranscriptPath,
  type ContextUsageInfo,
} from "./bridge/agy-paths.ts";
import { readAgySessionModel } from "./bridge/external-metadata.ts";
import { isInside } from "./validate.ts";

export {
  AGY_CLAUDE_CONTEXT_WINDOW,
  AGY_CONTEXT_WINDOW,
  AGY_GEMINI_CONTEXT_WINDOW,
  AGY_GPT_OSS_CONTEXT_WINDOW,
  AGY_TAIL_WINDOW_BYTES,
  MODEL_CHANGE_RE,
  extractAgyUserText,
  extractSessionTopic,
  inferAgyHomeFromTranscriptPath,
  normalizeAgyToolCall,
  normalizeAgyToolCalls,
  parseAgyArgs,
  readTailBuffer,
  resolveAgyContextWindow,
  resolveAgyTranscriptPath,
  summarizeAgyToolTask,
  type AgyMediaRaw,
  type AgyStepRaw,
  type AgyToolCallRaw,
  type ContextUsageInfo,
  type NormalizedAgyTool,
};

const MAX_SUBAGENTS = 100;
const MAX_SUBAGENT_TOOLS = 100;
const MAX_SUBAGENT_THINKING_BYTES = 1024;
const MAX_SUBAGENT_RESULT_BYTES = 4096;
const MAX_BG_TASKS = 50;
const CHILD_MODEL_CHECK_THROTTLE_MS = 10_000;

export const DEFAULT_BG_TASK_MAX_IDLE_MS = 5 * 60 * 1000;
export const MAX_SNAPSHOT_BYTES = 220 * 1024;

interface ChildCursor {
  taskId: string;
  convId: string;
  transcriptPath: string;
  offset: number;
  remainder: string;
  lastStepIndex: number;
  tools: string[];
  toolCalls: number;
  turns: number;
  tokens: Required<Pick<SubagentTokens, "input" | "output" | "cacheRead" | "cacheWrite" | "total">>;
  thinking?: string;
  model?: string;
  modelFromSession: boolean;
  verifiedIno?: number;
  verifiedMtimeMs?: number;
  verifiedSize?: number;
  lastModelCheckAt: number;
  hadTranscriptData: boolean;
}

interface PendingTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  at: number;
  isDaemon?: boolean;
  killTaskSender?: string;
  subagentSpec?: { role: string; typeName: string; prompt: string; model?: string };
  subagentIds?: string[];
}

interface BackgroundTaskCursor {
  taskSender: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  lastActivityAt: number;
  isDaemon: boolean;
  logPath: string | null;
  hasExplicitLogUri: boolean;
  lastSize: number;
  lastMtimeMs: number;
  lastTail?: string;
  verifiedIno?: number;
  verifiedMtimeMs?: number;
  verifiedSize?: number;
}

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
  private convToTaskId = new Map<string, string>();
  private childCursors = new Map<string, ChildCursor>();
  private bgTasks = new Map<string, BackgroundTaskCursor>();
  private lastTopic: string | null = null;
  private lastModel: string | null = null;
  private lastContextUsage: ContextUsageInfo | null = null;
  private fullStepsCache: {
    fullPath: string;
    mtimeMs: number;
    size: number;
    map: Map<number, AgyStepRaw> | null;
  } | null = null;
  private readonly homeDir: string;
  private readonly siblingRoot: string;
  private readonly brainRoot: string;
  private cachedRealSiblingRoot: string | null;
  private cachedRealBrainRoot: string | null;

  constructor(
    readonly transcriptPath: string,
    private redact: () => boolean = () => false,
    private resolveModel: () => string | null = () => null,
  ) {
    this.homeDir = inferAgyHomeFromTranscriptPath(this.transcriptPath);
    this.siblingRoot = path.dirname(path.dirname(path.resolve(this.transcriptPath)));
    this.brainRoot = path.resolve(this.homeDir, ".gemini", "antigravity-cli", "brain");
    this.cachedRealSiblingRoot = realpathOrNull(this.siblingRoot);
    this.cachedRealBrainRoot = realpathOrNull(this.brainRoot);
  }

  hasRunningSubagents(): boolean {
    if (this.childCursors.size > 0) return true;
    for (const sub of this.subagents.values()) {
      if (sub.status === "running") return true;
    }
    return false;
  }

  /** Return true when any non-daemon background tool task (e.g. long `run_command`) is still executing. */
  hasRunningBackgroundTasks(): boolean {
    for (const bg of this.bgTasks.values()) {
      if (!bg.isDaemon) return true;
    }
    return false;
  }

  /**
   * Prune stale background task cursors whose log file disappeared or whose activity/mtime
   * has been idle for longer than `maxIdleMs` (default 5 minutes).
   */
  pruneStaleBackgroundTasks(nowMs = Date.now(), maxIdleMs = DEFAULT_BG_TASK_MAX_IDLE_MS): number {
    if (this.bgTasks.size === 0) return 0;
    let pruned = 0;
    for (const [taskSender, bg] of this.bgTasks.entries()) {
      if (bg.logPath) {
        let st: fs.Stats | null = null;
        try {
          st = fs.lstatSync(bg.logPath);
        } catch {
          st = null;
        }
        if (!st || st.isSymbolicLink() || !st.isFile()) {
          if (bg.lastMtimeMs > 0 || bg.hasExplicitLogUri || nowMs - bg.lastActivityAt > maxIdleMs) {
            this.bgTasks.delete(taskSender);
            pruned++;
          }
          continue;
        }
        if (st.size !== bg.lastSize || st.mtimeMs !== bg.lastMtimeMs) {
          bg.lastSize = st.size;
          bg.lastMtimeMs = st.mtimeMs;
          bg.lastActivityAt = nowMs;
          continue;
        }
        if (nowMs - st.mtimeMs > maxIdleMs) {
          this.bgTasks.delete(taskSender);
          pruned++;
        }
      } else if (nowMs - bg.lastActivityAt > maxIdleMs) {
        this.bgTasks.delete(taskSender);
        pruned++;
      }
    }
    return pruned;
  }

  hasRunningWork(): boolean {
    return this.hasRunningSubagents() || this.hasRunningBackgroundTasks();
  }

  /** Return latest live partial-result updates for still-running background tools present in the snapshot. */
  getRunningBackgroundUpdates(snapshotToolIds?: Set<string>): Record<string, unknown>[] {
    if (this.redact() || this.bgTasks.size === 0) return [];
    const out: Record<string, unknown>[] = [];
    for (const bg of this.bgTasks.values()) {
      if (!bg.lastTail) continue;
      if (snapshotToolIds && !snapshotToolIds.has(bg.toolCallId)) continue;
      out.push({
        type: "tool_execution_update",
        toolCallId: bg.toolCallId,
        toolName: bg.name,
        partialResult: { content: [{ type: "text", text: bg.lastTail }] },
      });
    }
    return out;
  }

  getSubagents(): SubagentUpdateEvent[] {
    const isRedacted = this.redact();
    return Array.from(this.subagents.values(), (sub) => this.cloneSubagent(sub, isRedacted));
  }

  private cloneSubagent(sub: SubagentUpdateEvent, isRedacted = this.redact()): SubagentUpdateEvent {
    const copy: SubagentUpdateEvent = {
      ...sub,
      ...(sub.tools ? { tools: [...sub.tools] } : {}),
      ...(sub.tokens ? { tokens: { ...sub.tokens } } : {}),
    };
    if (isRedacted) {
      copy.label = "[redacted]";
      delete copy.thinking;
      delete copy.result;
      delete copy.error;
    }
    return copy;
  }

  getSessionTopic(): string | null {
    if (this.redact()) return null;
    return this.lastTopic;
  }

  /** Return the most recent model parsed from `USER_SETTINGS_CHANGE` in the transcript, if any. */
  getLastModel(): string | null {
    return this.lastModel;
  }

  /** Return the most recent context window token usage observed in the transcript, if any. */
  getContextUsage(): ContextUsageInfo | null {
    if (!this.lastContextUsage) return null;
    return computeContextUsage(this.lastContextUsage.tokens, this.resolveModel() ?? this.lastModel);
  }

  /** Current byte offset into the main transcript file. */
  get byteOffset(): number {
    return this.offset;
  }

  /** Return a compact description of the currently executing tool call, if any. */
  getActiveTask(): string | null {
    if (this.redact()) return null;
    if (this.pendingTools.length > 0) {
      const latest = this.pendingTools[this.pendingTools.length - 1]!;
      return summarizeAgyToolTask(latest.name, latest.args);
    }
    let latestBg: BackgroundTaskCursor | null = null;
    for (const bg of this.bgTasks.values()) {
      if (!bg.isDaemon) latestBg = bg;
    }
    return latestBg ? summarizeAgyToolTask(latestBg.name, latestBg.args) : null;
  }

  /** Return the timestamp (ms) of the most recent conversation entry, or the transcript file mtime. */
  getLastActivityAt(): number | null {
    if (this.entries.length > 0) {
      let maxAt = 0;
      for (const e of this.entries) {
        if (typeof e.at === "number" && Number.isFinite(e.at) && e.at > maxAt) {
          maxAt = e.at;
        }
      }
      if (maxAt > 0) return maxAt;
    }
    try {
      const st = fs.statSync(this.transcriptPath);
      if (Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) return Math.floor(st.mtimeMs);
    } catch {
      /* ignore */
    }
    return null;
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

  /** Read any newly appended lines from transcript.jsonl and active child transcripts, converting them into live events. */
  pollNewEvents(): Record<string, unknown>[] {
    const liveEvents: Record<string, unknown>[] = [];
    const chunk = readTranscriptChunk(this.transcriptPath, this.offset, this.remainder);

    if (chunk) {
      if (chunk.reset) {
        this.lastStepIndex = -1;
        this.pendingTools = [];
        this.entries = [];
        this.subagents.clear();
        this.convToTaskId.clear();
        this.childCursors.clear();
        this.bgTasks.clear();
        this.lastModel = null;
        this.lastContextUsage = null;
        this.fullStepsCache = null;
      }
      this.offset = chunk.nextOffset;
      this.remainder = chunk.nextRemainder;

      if (chunk.lines.length > 0) {
        let fullStepsMap: Map<number, AgyStepRaw> | null | undefined;
        for (let li = 0; li < chunk.lines.length; li++) {
          const line = chunk.lines[li]!.trim();
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

          const truncFields = Array.isArray(step.truncated_fields) ? step.truncated_fields : null;
          const hasTrunc = Boolean(truncFields && (truncFields.includes("content") || truncFields.includes("tool_calls")));
          const isTailLine = li >= chunk.lines.length - 5;
          const isTailPlannerOrSys =
            (isTailLine && (step.type === "PLANNER_RESPONSE" || step.type === "SYSTEM_MESSAGE")) ||
            (step.type === "SYSTEM_MESSAGE" && (this.convToTaskId.size > 0 || this.bgTasks.size > 0));
          const isSubagentToolCall =
            step.type === "PLANNER_RESPONSE" &&
            Boolean(truncFields?.includes("tool_calls")) &&
            Array.isArray(step.tool_calls) &&
            step.tool_calls.some((tc) => tc?.name === "invoke_subagent");

          if (hasTrunc && (isTailPlannerOrSys || isSubagentToolCall)) {
            if (fullStepsMap === undefined) {
              fullStepsMap = this.getFullStepsMap();
            }
            const full = fullStepsMap?.get(idx);
            if (full) step = full;
          }

          this.processStep(step, idx, liveEvents);
        }

        if (this.entries.length > SNAPSHOT_LIMIT * 2) {
          this.entries = this.entries.slice(this.entries.length - SNAPSHOT_LIMIT - 20);
        }
      }
    }

    this.pollActiveChildren(liveEvents);
    this.pollActiveBackgroundTasks(liveEvents);
    return liveEvents;
  }

  private getFullStepsMap(): Map<number, AgyStepRaw> | null {
    const fullPath = path.join(path.dirname(this.transcriptPath), "transcript_full.jsonl");
    let st: fs.Stats;
    try {
      st = fs.statSync(fullPath);
    } catch {
      this.fullStepsCache = null;
      return null;
    }
    if (!st.isFile()) {
      this.fullStepsCache = null;
      return null;
    }
    if (
      this.fullStepsCache &&
      this.fullStepsCache.fullPath === fullPath &&
      this.fullStepsCache.mtimeMs === st.mtimeMs &&
      this.fullStepsCache.size === st.size
    ) {
      return this.fullStepsCache.map;
    }
    const map = readFullStepsMap(this.transcriptPath);
    this.fullStepsCache = { fullPath, mtimeMs: st.mtimeMs, size: st.size, map };
    return map;
  }

  private getRealSiblingRoot(): string | null {
    if (this.cachedRealSiblingRoot === null) {
      this.cachedRealSiblingRoot = realpathOrNull(this.siblingRoot);
    }
    return this.cachedRealSiblingRoot;
  }

  private getRealBrainRoot(): string | null {
    if (this.cachedRealBrainRoot === null) {
      this.cachedRealBrainRoot = realpathOrNull(this.brainRoot);
    }
    return this.cachedRealBrainRoot;
  }

  private isContainedTaskLogPath(candidate: string, requireExists = false): boolean {
    if (!path.basename(candidate).endsWith(".log")) return false;
    const resolved = resolveSafeFileCandidate(candidate, requireExists);
    if (!resolved) return false;
    const realSiblingRoot = this.getRealSiblingRoot();
    if (realSiblingRoot && isInside(path.join(realSiblingRoot, "tasks"), resolved.realPath)) {
      return true;
    }
    const realBrainRoot = this.getRealBrainRoot();
    if (
      realBrainRoot &&
      isInside(realBrainRoot, resolved.realPath) &&
      path.basename(path.dirname(resolved.realPath)) === "tasks"
    ) {
      return true;
    }
    return false;
  }

  private resolveTaskLogPath(taskSender: string, logUri?: string): string | null {
    if (!isSafeSystemSender(taskSender)) return null;
    const parts = taskSender.split("/");
    const taskPart = parts.length === 2 ? parts[1]! : parts[0]!;
    return resolveAllowedFileUri(
      logUri,
      (candidate) => this.isContainedTaskLogPath(candidate, false),
      () => (SAFE_CONV_ID_RE.test(taskPart) ? path.join(this.siblingRoot, "tasks", `${taskPart}.log`) : null),
    );
  }

  private pollActiveBackgroundTasks(outEvents: Record<string, unknown>[]): void {
    if (this.bgTasks.size === 0) return;
    const isRedacted = this.redact();
    for (const bg of this.bgTasks.values()) {
      try {
        this.pollBackgroundTaskCursor(bg, outEvents, isRedacted);
      } catch {
        /* isolate per-cursor errors so one broken task log cannot stall others */
      }
    }
  }

  private pollBackgroundTaskCursor(
    bg: BackgroundTaskCursor,
    outEvents: Record<string, unknown>[],
    isRedacted: boolean,
  ): void {
    if (!bg.logPath || isRedacted) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(bg.logPath);
    } catch {
      bg.verifiedIno = undefined;
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      bg.verifiedIno = undefined;
      return;
    }
    const unchangedVerified =
      bg.verifiedIno !== undefined &&
      st.ino === bg.verifiedIno &&
      st.mtimeMs === bg.verifiedMtimeMs &&
      st.size === bg.verifiedSize;
    if (unchangedVerified && st.size === bg.lastSize && st.mtimeMs === bg.lastMtimeMs) return;
    if (!unchangedVerified) {
      if (!this.isContainedTaskLogPath(bg.logPath, true)) {
        bg.verifiedIno = undefined;
        return;
      }
      bg.verifiedIno = st.ino;
      bg.verifiedMtimeMs = st.mtimeMs;
      bg.verifiedSize = st.size;
    }
    if (st.size === bg.lastSize && st.mtimeMs === bg.lastMtimeMs) return;
    const tail = readLogTail(bg.logPath);
    if (!tail) return;
    bg.lastSize = tail.size;
    bg.lastMtimeMs = tail.mtimeMs;
    bg.lastActivityAt = Date.now();
    if (tail.text === bg.lastTail) return;
    bg.lastTail = tail.text;
    outEvents.push({
      type: "tool_execution_update",
      toolCallId: bg.toolCallId,
      toolName: bg.name,
      partialResult: { content: [{ type: "text", text: tail.text }] },
    });
  }

  private finalizeToolResult(
    eid: string,
    toolCallId: string,
    toolName: string,
    startedAt: number,
    endedAt: number,
    isError: boolean,
    rawOut: string,
    isRedacted: boolean,
    outEvents: Record<string, unknown>[],
  ): void {
    const { text, truncated } = truncateBytes(rawOut, LIMITS.resultMaxBytes);
    const resultObj = {
      content: [{ type: "text", text }],
      ...(truncated ? { truncated: true } : {}),
    };
    const entryMsg = {
      role: "toolResult",
      toolCallId,
      toolName,
      isError,
      ...(isRedacted ? {} : { content: resultObj.content }),
    };
    this.entries.push({ eid, kind: "tool_result", at: endedAt, msg: entryMsg });
    outEvents.push({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      isError,
      durationMs: Math.max(0, endedAt - startedAt),
      ...(isRedacted ? {} : { result: resultObj, ...(truncated ? { truncated: true } : {}) }),
    });
  }

  private isContainedChildTranscriptPath(candidate: string, requireExists = false): boolean {
    if (path.basename(candidate) !== "transcript.jsonl") return false;
    const resolved = resolveSafeFileCandidate(candidate, requireExists);
    if (!resolved) return false;
    const realBrainRoot = this.getRealBrainRoot();
    if (realBrainRoot && isInside(realBrainRoot, resolved.realPath)) return true;
    const realSiblingRoot = this.getRealSiblingRoot();
    if (realSiblingRoot && isInside(realSiblingRoot, resolved.realPath)) return true;
    return false;
  }

  private resolveChildTranscriptPath(convId: string, logAbsoluteUri?: string): string | null {
    if (!SAFE_CONV_ID_RE.test(convId)) return null;
    return resolveAllowedFileUri(
      logAbsoluteUri,
      (candidate) => this.isContainedChildTranscriptPath(candidate, false),
      () => {
        try {
          return resolveAgyTranscriptPath(convId, this.homeDir);
        } catch {
          return null;
        }
      },
    );
  }

  private pollActiveChildren(outEvents: Record<string, unknown>[]): void {
    if (this.childCursors.size === 0) return;
    for (const convId of this.childCursors.keys()) {
      try {
        this.pollChildCursor(convId, outEvents, true);
      } catch {
        /* isolate per-cursor errors so one broken child transcript cannot stall others */
      }
    }
  }

  private pollChildCursor(convId: string, outEvents: Record<string, unknown>[], emitIfChanged: boolean): void {
    const cursor = this.childCursors.get(convId);
    if (!cursor) return;
    const isRedacted = this.redact();
    let chunk: ReturnType<typeof readTranscriptChunk> = null;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(cursor.transcriptPath);
    } catch {
      st = null;
    }
    if (st && !st.isSymbolicLink() && st.isFile()) {
      const unchangedVerified =
        cursor.verifiedIno !== undefined &&
        st.ino === cursor.verifiedIno &&
        st.mtimeMs === cursor.verifiedMtimeMs &&
        st.size === cursor.verifiedSize &&
        st.size === cursor.offset;
      if (!unchangedVerified) {
        if (this.isContainedChildTranscriptPath(cursor.transcriptPath, true)) {
          cursor.verifiedIno = st.ino;
          cursor.verifiedMtimeMs = st.mtimeMs;
          cursor.verifiedSize = st.size;
          chunk = readTranscriptChunk(cursor.transcriptPath, cursor.offset, cursor.remainder);
        } else {
          cursor.verifiedIno = undefined;
        }
      }
    } else {
      cursor.verifiedIno = undefined;
    }
    if (chunk) {
      if (chunk.reset) {
        cursor.lastStepIndex = -1;
        cursor.tools = [];
        cursor.toolCalls = 0;
        cursor.turns = 0;
        cursor.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        cursor.thinking = undefined;
      }
      cursor.offset = chunk.nextOffset;
      cursor.remainder = chunk.nextRemainder;

      for (const rawLine of chunk.lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) continue;
        let step: AgyStepRaw;
        try {
          step = JSON.parse(line) as AgyStepRaw;
        } catch {
          continue;
        }
        const idx = typeof step.step_index === "number" ? step.step_index : cursor.lastStepIndex + 1;
        if (idx <= cursor.lastStepIndex) continue;
        cursor.lastStepIndex = idx;

        if (step.type === "USER_INPUT" && typeof step.content === "string") {
          const m = MODEL_CHANGE_RE.exec(step.content);
          if (m?.[1]?.trim()) {
            cursor.model = m[1].trim();
            cursor.modelFromSession = true;
          }
          continue;
        }

        if (step.type === "PLANNER_RESPONSE") {
          cursor.turns += 1;
          if (!isRedacted && typeof step.thinking === "string" && step.thinking.trim()) {
            cursor.thinking = truncateBytes(step.thinking.trim(), MAX_SUBAGENT_THINKING_BYTES).text;
          }
          const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
          for (let ci = 0; ci < calls.length; ci++) {
            const norm = normalizeAgyToolCall(idx, ci, calls[ci]!);
            cursor.toolCalls += 1;
            cursor.tools.push(norm.name);
          }
          if (cursor.tools.length > MAX_SUBAGENT_TOOLS) {
            cursor.tools.splice(0, cursor.tools.length - MAX_SUBAGENT_TOOLS);
          }
          const inTok = toNonNegInt(step.input_tokens);
          const cacheReadTok = toNonNegInt(step.cache_read_tokens);
          const cacheWriteTok = toNonNegInt(step.cache_write_tokens);
          const outTok = toNonNegInt(step.output_tokens);
          const stepTotal = inTok + cacheReadTok + cacheWriteTok + outTok;
          if (stepTotal > 0) {
            cursor.tokens.input += inTok;
            cursor.tokens.output += outTok;
            cursor.tokens.cacheRead += cacheReadTok;
            cursor.tokens.cacheWrite += cacheWriteTok;
            cursor.tokens.total += stepTotal;
          }
        }
      }
      if (chunk.lines.length > 0 && !cursor.hadTranscriptData) {
        cursor.hadTranscriptData = true;
        if (!cursor.modelFromSession) cursor.lastModelCheckAt = 0;
      }
    }

    if (!cursor.modelFromSession) {
      const now = Date.now();
      if (cursor.lastModelCheckAt === 0 || now - cursor.lastModelCheckAt >= CHILD_MODEL_CHECK_THROTTLE_MS) {
        cursor.lastModelCheckAt = now;
        const homeDir = inferAgyHomeFromTranscriptPath(cursor.transcriptPath);
        const { model: sessionModel } = readAgySessionModel(cursor.convId, homeDir, {
          knownTranscriptModel: null,
        });
        if (sessionModel) {
          cursor.model = sessionModel;
          cursor.modelFromSession = true;
        }
      }
    }

    const sub = this.subagents.get(cursor.taskId);
    if (!sub) return;
    const next: SubagentUpdateEvent = {
      ...sub,
      label: isRedacted ? "[redacted]" : sub.label,
      tools: [...cursor.tools],
      ...(cursor.toolCalls > 0 ? { toolCalls: cursor.toolCalls } : {}),
      ...(cursor.turns > 0 ? { turns: cursor.turns } : {}),
      ...(cursor.tokens.total > 0 ? { tokens: { ...cursor.tokens } } : {}),
      ...(cursor.model ? { model: cursor.model } : {}),
      ...(!isRedacted && cursor.thinking ? { thinking: cursor.thinking } : {}),
    };
    if (isRedacted) {
      delete next.thinking;
      delete next.result;
      delete next.error;
    }

    if (subagentChanged(sub, next)) {
      this.setSubagent(cursor.taskId, next);
      if (emitIfChanged) {
        outEvents.push(this.cloneSubagent(next, isRedacted) as unknown as Record<string, unknown>);
      }
    }
  }

  private processStep(step: AgyStepRaw, stepIndex: number, outEvents: Record<string, unknown>[]): void {
    const at = stepTimestampMs(step, stepIndex);
    const eid = `agy:${stepIndex}`;
    const isRedacted = this.redact();

    if (step.type === "USER_INPUT") {
      this.handleUserInputStep(step, eid, at, isRedacted, outEvents);
    } else if (step.type === "SYSTEM_MESSAGE") {
      this.handleSystemMessageStep(step, eid, at, isRedacted, outEvents);
    } else if (step.type === "PLANNER_RESPONSE") {
      this.handlePlannerResponseStep(step, stepIndex, eid, at, isRedacted, outEvents);
    } else if (step.type === "GENERIC" && this.pendingTools.length > 0) {
      this.handleGenericStep(step, eid, at, isRedacted, outEvents);
    }
  }

  private handleUserInputStep(
    step: AgyStepRaw,
    eid: string,
    at: number,
    isRedacted: boolean,
    outEvents: Record<string, unknown>[],
  ): void {
    // Flush any unmatched pending tools before a new user turn
    this.pendingTools = [];
    if (typeof step.content === "string") {
      const modelChange = MODEL_CHANGE_RE.exec(step.content);
      if (modelChange?.[1]?.trim()) {
        this.lastModel = modelChange[1].trim();
      }
    }
    const extracted = extractAgyUserText(step.content);
    if (extracted.kind === "skip") return;
    if (extracted.kind === "compaction") {
      this.entries.push({ eid, kind: "compaction", at, msg: isRedacted ? {} : { summary: extracted.text } });
      outEvents.push({ type: "session_compact", ...(isRedacted ? {} : { summary: extracted.text }) });
      return;
    }
    if (!this.lastTopic) {
      this.lastTopic = extractSessionTopic(extracted.text);
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
  }

  private handleSystemMessageStep(
    step: AgyStepRaw,
    eid: string,
    at: number,
    isRedacted: boolean,
    outEvents: Record<string, unknown>[],
  ): void {
    const parsed = parseSystemWakeup(typeof step.content === "string" ? step.content : "");
    if (!parsed) return;

    const bg = this.bgTasks.get(parsed.sender);
    if (bg) {
      if (!isFinalBackgroundWakeup(parsed.content)) {
        this.pollBackgroundTaskCursor(bg, outEvents, isRedacted);
        const snippet = !isRedacted && parsed.content ? truncateBytes(parsed.content, LIMITS.resultMaxBytes).text : "";
        if (snippet && snippet !== bg.lastTail) {
          bg.lastTail = snippet;
          bg.lastActivityAt = Date.now();
          outEvents.push({
            type: "tool_execution_update",
            toolCallId: bg.toolCallId,
            toolName: bg.name,
            partialResult: { content: [{ type: "text", text: snippet }] },
          });
        }
        return;
      }
      const bgIsError = isBackgroundTaskError(parsed.content);
      const finalOut = parsed.content || bg.lastTail || "";
      this.bgTasks.delete(parsed.sender);
      this.finalizeToolResult(eid, bg.toolCallId, bg.name, bg.startedAt, at, bgIsError, finalOut, isRedacted, outEvents);
      return;
    }

    const taskId = this.convToTaskId.get(parsed.sender);
    if (!taskId) return;

    this.pollChildCursor(parsed.sender, outEvents, false);
    this.convToTaskId.delete(parsed.sender);
    this.childCursors.delete(parsed.sender);

    const sub = this.subagents.get(taskId);
    if (sub) {
      const completed: SubagentUpdateEvent = {
        ...sub,
        label: isRedacted ? "[redacted]" : sub.label,
        status: "completed",
        endedAt: at,
        durationMs: Math.max(0, at - (sub.startedAt ?? at)),
        ...(!isRedacted && parsed.content
          ? { result: truncateBytes(parsed.content, MAX_SUBAGENT_RESULT_BYTES).text }
          : {}),
      };
      if (isRedacted) {
        delete completed.thinking;
        delete completed.result;
        delete completed.error;
      }
      this.setSubagent(taskId, completed);
      outEvents.push(this.cloneSubagent(completed, isRedacted) as unknown as Record<string, unknown>);
    }
  }

  private handlePlannerResponseStep(
    step: AgyStepRaw,
    stepIndex: number,
    eid: string,
    at: number,
    isRedacted: boolean,
    outEvents: Record<string, unknown>[],
  ): void {
    const inTok = toNonNegInt(step.input_tokens);
    const cacheReadTok = toNonNegInt(step.cache_read_tokens);
    const cacheWriteTok = toNonNegInt(step.cache_write_tokens);
    const outTok = toNonNegInt(step.output_tokens);
    const totalTok = inTok + cacheReadTok + cacheWriteTok + outTok;
    let stepUsage: Record<string, number> | undefined;
    if (totalTok > 0) {
      const usageInfo = computeContextUsage(totalTok, this.lastModel ?? this.resolveModel());
      this.lastContextUsage = usageInfo;
      stepUsage = {
        input: inTok,
        output: outTok,
        cacheRead: cacheReadTok,
        cacheWrite: cacheWriteTok,
        totalTokens: totalTok,
        contextWindow: usageInfo.contextWindow,
        contextPercent: usageInfo.percent,
      };
    }

    const blocks: unknown[] = [];
    if (!isRedacted && typeof step.thinking === "string" && step.thinking.trim()) {
      blocks.push({ type: "thinking", thinking: truncateBytes(step.thinking.trim(), LIMITS.resultMaxBytes).text });
    }
    if (!isRedacted && typeof step.content === "string" && step.content.trim()) {
      blocks.push({ type: "text", text: truncateBytes(step.content.trim(), LIMITS.resultMaxBytes).text });
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const expandedPerCall: NormalizedAgyTool[][] = [];
    for (let i = 0; i < calls.length; i++) {
      const norms = normalizeAgyToolCalls(stepIndex, i, calls[i]!);
      expandedPerCall.push(norms);
      for (const norm of norms) {
        blocks.push({
          type: "toolCall",
          id: norm.toolCallId,
          name: norm.name,
          arguments: isRedacted ? {} : norm.args,
        });
      }
    }

    if (blocks.length > 0) {
      const msg = isRedacted
        ? { role: "assistant", timestamp: at, ...(stepUsage ? { usage: stepUsage } : {}) }
        : { role: "assistant", timestamp: at, content: blocks, ...(stepUsage ? { usage: stepUsage } : {}) };
      this.entries.push({ eid, kind: "assistant", at, msg });
      if (!isRedacted) {
        outEvents.push({ type: "message_end", message: msg });
      }
    }

    for (const norms of expandedPerCall) {
      if (norms.length === 0) continue;
      const first = norms[0]!;
      const subagentIds = norms.filter((n) => Boolean(n.subagentSpec)).map((n) => n.toolCallId);
      this.pendingTools.push({
        toolCallId: first.toolCallId,
        name: first.name,
        args: first.args,
        at,
        ...(first.isDaemon ? { isDaemon: true } : {}),
        ...(first.killTaskSender ? { killTaskSender: first.killTaskSender } : {}),
        subagentSpec: first.subagentSpec,
        ...(subagentIds.length > 0 ? { subagentIds } : {}),
      });
      for (const norm of norms) {
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
            ...(norm.subagentSpec.model ? { model: norm.subagentSpec.model } : {}),
            tools: [],
          };
          this.setSubagent(norm.toolCallId, sub);
          outEvents.push(this.cloneSubagent(sub, isRedacted) as unknown as Record<string, unknown>);
        }
      }
    }
  }

  private handleGenericStep(
    step: AgyStepRaw,
    eid: string,
    at: number,
    isRedacted: boolean,
    outEvents: Record<string, unknown>[],
  ): void {
    const pending = this.pendingTools.shift()!;
    const isError = step.status === "ERROR";
    const rawOut = typeof step.content === "string" ? step.content : "";

    if (pending.killTaskSender && !isError) {
      const killed = this.bgTasks.get(pending.killTaskSender);
      if (killed) {
        this.bgTasks.delete(pending.killTaskSender);
        this.finalizeToolResult(
          `${eid}:killed`,
          killed.toolCallId,
          killed.name,
          killed.startedAt,
          at,
          false,
          rawOut || killed.lastTail || "",
          isRedacted,
          outEvents,
        );
      }
    }

    if (!pending.subagentIds?.length && !isError && (step.status === "RUNNING" || !step.status)) {
      const bgAck = parseBackgroundTaskAck(rawOut);
      if (bgAck) {
        const logPath = this.resolveTaskLogPath(bgAck.taskSender, bgAck.logUri);
        const cursor: BackgroundTaskCursor = {
          taskSender: bgAck.taskSender,
          toolCallId: pending.toolCallId,
          name: pending.name,
          args: pending.args,
          startedAt: pending.at,
          lastActivityAt: Date.now(),
          isDaemon: Boolean(pending.isDaemon),
          logPath,
          hasExplicitLogUri: Boolean(bgAck.logUri),
          lastSize: 0,
          lastMtimeMs: 0,
        };
        this.setBgTask(bgAck.taskSender, cursor);
        this.pollBackgroundTaskCursor(cursor, outEvents, isRedacted);
        if (!isRedacted && !cursor.lastTail && bgAck.initialTail) {
          cursor.lastTail = bgAck.initialTail;
          outEvents.push({
            type: "tool_execution_update",
            toolCallId: cursor.toolCallId,
            toolName: cursor.name,
            partialResult: { content: [{ type: "text", text: bgAck.initialTail }] },
          });
        }
        return;
      }
    }

    const targetIds = pending.subagentIds && pending.subagentIds.length > 0 ? pending.subagentIds : [pending.toolCallId];
    for (let si = 0; si < targetIds.length; si++) {
      this.finalizeToolResult(
        si === 0 ? eid : `${eid}:${si}`,
        targetIds[si]!,
        pending.name,
        pending.at,
        at,
        isError,
        rawOut,
        isRedacted,
        outEvents,
      );
    }

    if (pending.subagentIds && pending.subagentIds.length > 0) {
      const refs = isError ? [] : parseSpawnedSubagentRefs(rawOut);
      const hasValidAck = !isError && refs.some(Boolean);
      for (let si = 0; si < pending.subagentIds.length; si++) {
        const subId = pending.subagentIds[si]!;
        const sub = this.subagents.get(subId);
        if (!sub) continue;
        const ref = hasValidAck ? refs[si] ?? null : null;
        if (ref) {
          const childPath = this.resolveChildTranscriptPath(ref.conversationId, ref.logAbsoluteUri);
          if (childPath) {
            this.convToTaskId.set(ref.conversationId, subId);
            this.childCursors.set(ref.conversationId, {
              taskId: subId,
              convId: ref.conversationId,
              transcriptPath: childPath,
              offset: 0,
              remainder: "",
              lastStepIndex: -1,
              tools: [],
              toolCalls: 0,
              turns: 0,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              ...(sub.model ? { model: sub.model } : {}),
              modelFromSession: false,
              lastModelCheckAt: 0,
              hadTranscriptData: false,
            });
          }
          continue;
        }
        const finished: SubagentUpdateEvent = {
          ...sub,
          label: isRedacted ? "[redacted]" : sub.label,
          status: isError ? "error" : "done",
          endedAt: at,
          durationMs: Math.max(0, at - (sub.startedAt ?? at)),
          ...(isRedacted
            ? {}
            : isError
              ? { error: truncateBytes(rawOut, MAX_SUBAGENT_RESULT_BYTES).text }
              : { result: truncateBytes(rawOut, MAX_SUBAGENT_RESULT_BYTES).text }),
        };
        if (isRedacted) {
          delete finished.thinking;
          delete finished.result;
          delete finished.error;
        }
        this.setSubagent(subId, finished);
        outEvents.push(this.cloneSubagent(finished, isRedacted) as unknown as Record<string, unknown>);
      }
    }
  }

  private setBgTask(taskSender: string, cursor: BackgroundTaskCursor): void {
    this.bgTasks.delete(taskSender);
    this.bgTasks.set(taskSender, cursor);
    while (this.bgTasks.size > MAX_BG_TASKS) {
      const oldest = this.bgTasks.keys().next().value;
      if (!oldest) break;
      this.bgTasks.delete(oldest);
    }
  }

  private setSubagent(taskId: string, sub: SubagentUpdateEvent): void {
    this.subagents.set(taskId, sub);
    while (this.subagents.size > MAX_SUBAGENTS) {
      let victim: string | undefined;
      for (const [id, s] of this.subagents) {
        if (s.status !== "running") {
          victim = id;
          break;
        }
      }
      if (!victim) victim = this.subagents.keys().next().value;
      if (!victim) break;
      this.subagents.delete(victim);
      for (const [convId, mappedTaskId] of this.convToTaskId) {
        if (mappedTaskId === victim) {
          this.convToTaskId.delete(convId);
          this.childCursors.delete(convId);
        }
      }
    }
  }
}
