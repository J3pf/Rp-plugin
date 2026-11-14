// Antigravity CLI (agy) transcript.jsonl reader & normalizer for RemotePi.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_LIMIT } from "../extension/snapshot.js";
import { LIMITS } from "../extension/forwarder.js";
import { SAFE_CONV_ID_RE, truncateBytes } from "../shared/util.js";
import { readExternalAgentModel } from "./bridge/external-metadata.js";
import { isInside } from "./validate.js";
const MAX_SUBAGENTS = 100;
const MAX_SUBAGENT_TOOLS = 100;
const MAX_SUBAGENT_THINKING_BYTES = 1024;
const MAX_SUBAGENT_RESULT_BYTES = 4096;
const MAX_POLL_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_REMAINDER_BYTES = 1024 * 1024;
const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to ([^\n<]+?)\.(?:\s|$)/i;
/** Empirical context window before Antigravity CLI (agy) triggers conversation compaction (~256k tokens). */
export const AGY_CONTEXT_WINDOW = 256_000;
const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
/** Extract clean user message text from an agy USER_INPUT content payload. */
export function extractAgyUserText(rawContent) {
    if (!rawContent || typeof rawContent !== "string")
        return { kind: "skip", text: "" };
    const match = USER_REQ_RE.exec(rawContent);
    if (match) {
        const clean = match[1].trim();
        return clean ? { kind: "user", text: clean } : { kind: "skip", text: "" };
    }
    const trimmed = rawContent.trim();
    if (!trimmed)
        return { kind: "skip", text: "" };
    if (trimmed.includes("<SYSTEM_MESSAGE>"))
        return { kind: "skip", text: "" };
    if (trimmed.includes("<CONTEXT_SUMMARY>")) {
        return { kind: "compaction", text: "Contexto de conversación compactado" };
    }
    return { kind: "user", text: trimmed };
}
/** Parse stringified JSON values inside agy's protojson tool_calls.args map. */
export function parseAgyArgs(raw) {
    if (!raw)
        return {};
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw);
            if (p && typeof p === "object" && !Array.isArray(p))
                return parseAgyArgs(p);
        }
        catch {
            return { value: raw };
        }
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw))
        return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") {
            const t = v.trim();
            if ((t.startsWith('"') && t.endsWith('"')) ||
                (t.startsWith("{") && t.endsWith("}")) ||
                (t.startsWith("[") && t.endsWith("]")) ||
                t === "true" ||
                t === "false" ||
                /^-?\d+(\.\d+)?$/.test(t)) {
                try {
                    out[k] = JSON.parse(t);
                    continue;
                }
                catch {
                    /* keep raw string */
                }
            }
        }
        out[k] = v;
    }
    return out;
}
/** Map agy tool names and arguments to Rp-app's canonical tool card format. */
export function normalizeAgyToolCall(stepIndex, callIndex, rawCall) {
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
                    ...(typeof parsed.toolSummary === "string" && parsed.toolSummary.trim()
                        ? { toolSummary: parsed.toolSummary.trim() }
                        : {}),
                },
            };
        case "view_file":
        case "read_file":
            return {
                toolCallId,
                name: "read",
                args: {
                    path: String(parsed.AbsolutePath ?? parsed.Path ?? parsed.path ?? ""),
                    ...(parsed.StartLine !== undefined ? { startLine: parsed.StartLine } : {}),
                    ...(parsed.EndLine !== undefined ? { endLine: parsed.EndLine } : {}),
                },
            };
        case "write_to_file":
        case "write_file":
            return {
                toolCallId,
                name: "write",
                args: {
                    path: String(parsed.TargetFile ?? parsed.Path ?? parsed.path ?? ""),
                    ...(parsed.Description ? { description: parsed.Description } : {}),
                },
            };
        case "replace_file_content":
        case "edit_file":
            return {
                toolCallId,
                name: "edit",
                args: {
                    path: String(parsed.TargetFile ?? parsed.Path ?? parsed.path ?? ""),
                    oldText: truncateBytes(String(parsed.TargetContent ?? parsed.Target ?? ""), 4096).text,
                    newText: truncateBytes(String(parsed.ReplacementContent ?? parsed.Replacement ?? ""), 4096).text,
                    ...(parsed.Instruction ? { instruction: truncateBytes(String(parsed.Instruction), 512).text } : {}),
                },
            };
        case "multi_replace_file_content": {
            const chunks = Array.isArray(parsed.ReplacementChunks) ? parsed.ReplacementChunks : [];
            const first = chunks[0] && typeof chunks[0] === "object" ? chunks[0] : null;
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
                    edits: chunks.slice(0, 10).map((c) => ({
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
        case "invoke_subagent":
            return normalizeInvokeSubagentEntry(rawCall.id && String(rawCall.id).trim() ? String(rawCall.id).trim() : `agy:${stepIndex}:${callIndex}`, {}, parsed, Array.isArray(parsed.Subagents) ? parsed.Subagents : []);
        default: {
            const safeArgs = {};
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
function normalizeInvokeSubagentEntry(toolCallId, entry, parsed, subs) {
    const first = subs[0] && typeof subs[0] === "object" ? subs[0] : {};
    const src = Object.keys(entry).length > 0 ? entry : first;
    const role = String(src.Role ?? src.role ?? parsed.Role ?? parsed.role ?? parsed.toolSummary ?? "Subagent");
    const typeName = String(src.TypeName ?? src.typeName ?? src.type_name ?? parsed.TypeName ?? parsed.typeName ?? "subagent");
    const prompt = String(src.Prompt ?? src.prompt ?? parsed.Prompt ?? parsed.prompt ?? "");
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
/** Expand a raw agy tool call into one or more normalized tool calls (e.g. parallel `invoke_subagent` `Subagents`). */
export function normalizeAgyToolCalls(stepIndex, callIndex, rawCall) {
    const rawName = String(rawCall.name ?? "tool");
    if (rawName !== "invoke_subagent") {
        return [normalizeAgyToolCall(stepIndex, callIndex, rawCall)];
    }
    const baseId = rawCall.id && String(rawCall.id).trim() ? String(rawCall.id).trim() : `agy:${stepIndex}:${callIndex}`;
    const parsed = parseAgyArgs(rawCall.args ?? rawCall.arguments);
    const subs = Array.isArray(parsed.Subagents) ? parsed.Subagents : [];
    if (subs.length > 1) {
        return subs.map((entry, si) => normalizeInvokeSubagentEntry(`${baseId}:sub:${si}`, entry && typeof entry === "object" ? entry : {}, parsed, subs));
    }
    return [normalizeInvokeSubagentEntry(baseId, {}, parsed, subs)];
}
/** Produce a compact human-readable label for an active tool call. */
export function summarizeAgyToolTask(name, args) {
    if (typeof args.toolSummary === "string" && args.toolSummary.trim()) {
        return args.toolSummary.trim().slice(0, 80);
    }
    if (name === "bash" && typeof args.command === "string" && args.command.trim()) {
        const firstLine = args.command.trim().split(/\r?\n/)[0].trim();
        return `$ ${firstLine.slice(0, 64)}`;
    }
    if ((name === "read" || name === "edit" || name === "write") && typeof args.path === "string" && args.path.trim()) {
        const base = path.basename(args.path.trim()) || args.path.trim();
        const label = name === "read" ? "Read" : name === "edit" ? "Edit" : "Write";
        return `${label}: ${base}`;
    }
    if ((name === "grep" || name === "find") && typeof args.pattern === "string" && args.pattern.trim()) {
        return `Search: ${args.pattern.trim().slice(0, 48)}`;
    }
    if (name === "subagent_run") {
        return `Subagent: ${String(args.label ?? args.agent ?? "subagent").slice(0, 56)}`;
    }
    return name;
}
function stepTimestampMs(step, stepIndex) {
    const base = step.created_at ? Date.parse(step.created_at) : NaN;
    const ms = Number.isFinite(base) ? base : Date.now();
    // Add stepIndex offset so rapid steps within the same second never collide in ChatReducer.keyOf
    return ms + stepIndex;
}
/** Resolve the default path to an agy conversation's transcript.jsonl. */
export function resolveAgyTranscriptPath(conversationId, home = os.homedir()) {
    if (typeof conversationId !== "string" || !SAFE_CONV_ID_RE.test(conversationId)) {
        throw new Error("invalid conversationId");
    }
    const brainRoot = path.resolve(home, ".gemini", "antigravity-cli", "brain");
    const resolved = path.resolve(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
    if (!isInside(brainRoot, resolved)) {
        throw new Error("transcript path escapes brain directory");
    }
    return resolved;
}
/** Build a step_index -> AgyStepRaw map from the last 512 KB of transcript_full.jsonl. */
function readFullStepsMap(transcriptPath) {
    const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
    try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile())
            return null;
        const tailBytes = Math.min(stat.size, 512 * 1024);
        const fd = fs.openSync(fullPath, "r");
        try {
            const buf = Buffer.allocUnsafe(tailBytes);
            fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
            const lines = buf.toString("utf8").split("\n");
            const minIdx = tailBytes < stat.size ? 1 : 0;
            const map = new Map();
            for (let i = minIdx; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line.startsWith("{"))
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    if (typeof parsed.step_index === "number") {
                        map.set(parsed.step_index, parsed);
                    }
                }
                catch {
                    /* ignore partial line */
                }
            }
            return map;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
function readTranscriptChunk(filePath, offset, remainder) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        return null;
    }
    if (!stat.isFile())
        return null;
    let reset = false;
    let curOffset = offset;
    let curRemainder = remainder;
    if (stat.size < curOffset) {
        reset = true;
        curOffset = 0;
        curRemainder = "";
    }
    let midLineSeek = false;
    if (curOffset === 0 && stat.size > 512 * 1024) {
        curOffset = stat.size - 512 * 1024;
        curRemainder = "";
        midLineSeek = true;
    }
    else if (stat.size - curOffset > MAX_POLL_DELTA_BYTES) {
        curOffset = stat.size - MAX_POLL_DELTA_BYTES;
        curRemainder = "";
        midLineSeek = true;
    }
    const deltaBytes = stat.size - curOffset;
    if (deltaBytes <= 0) {
        return { reset, nextOffset: curOffset, nextRemainder: curRemainder, lines: [] };
    }
    let chunk = "";
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.allocUnsafe(deltaBytes);
        const bytesRead = fs.readSync(fd, buf, 0, deltaBytes, curOffset);
        curOffset += bytesRead;
        chunk = curRemainder + buf.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        fs.closeSync(fd);
    }
    const lines = chunk.split("\n");
    let nextRemainder = lines.pop() ?? "";
    if (Buffer.byteLength(nextRemainder, "utf8") > MAX_REMAINDER_BYTES) {
        nextRemainder = "";
    }
    if (midLineSeek && lines.length > 0) {
        lines.shift();
    }
    return { reset, nextOffset: curOffset, nextRemainder, lines };
}
function toNonNegInt(v) {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}
function extractSpawnedRef(obj, out) {
    if (!obj || typeof obj !== "object")
        return;
    if (Array.isArray(obj)) {
        for (const item of obj)
            extractSpawnedRef(item, out);
        return;
    }
    const rec = obj;
    if (typeof rec.conversationId !== "string")
        return;
    const conversationId = rec.conversationId.trim();
    if (!SAFE_CONV_ID_RE.test(conversationId)) {
        out.push(null);
        return;
    }
    out.push({
        conversationId,
        logAbsoluteUri: typeof rec.logAbsoluteUri === "string" ? rec.logAbsoluteUri.trim() : undefined,
    });
}
function parseSpawnedSubagentRefs(rawOut) {
    if (!rawOut)
        return [];
    const refs = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;
    let openChar = "";
    for (let i = 0; i < rawOut.length; i++) {
        const ch = rawOut[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === "\\")
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (depth === 0 && (ch === "{" || ch === "[")) {
            depth = 1;
            start = i;
            openChar = ch;
        }
        else if (depth > 0) {
            if (ch === openChar)
                depth++;
            else if ((openChar === "{" && ch === "}") || (openChar === "[" && ch === "]")) {
                depth--;
                if (depth === 0 && start >= 0) {
                    try {
                        extractSpawnedRef(JSON.parse(rawOut.slice(start, i + 1)), refs);
                    }
                    catch {
                        /* ignore malformed JSON fragment */
                    }
                    start = -1;
                }
            }
        }
    }
    if (refs.length > 0)
        return refs;
    // Regex fallback for non-JSON or truncated fragments
    const re = /"conversationId"\s*:\s*"([^"]+)"(?:[\s\S]{0,400}?"logAbsoluteUri"\s*:\s*"([^"]+)")?/g;
    let m;
    while ((m = re.exec(rawOut)) !== null) {
        const conversationId = m[1].trim();
        if (!SAFE_CONV_ID_RE.test(conversationId)) {
            refs.push(null);
        }
        else {
            refs.push({ conversationId, logAbsoluteUri: m[2]?.trim() });
        }
    }
    return refs;
}
function parseSystemWakeup(raw) {
    if (!raw)
        return null;
    const senderMatch = /\bsender=([^\s\]\n<>]+)/.exec(raw);
    const sender = senderMatch?.[1]?.trim();
    if (!sender || !SAFE_CONV_ID_RE.test(sender))
        return null;
    let content = "";
    const contentIdx = raw.search(/\bcontent=/);
    if (contentIdx >= 0) {
        let rest = raw.slice(contentIdx + "content=".length);
        const closeIdx = rest.lastIndexOf("</SYSTEM_MESSAGE>");
        if (closeIdx >= 0)
            rest = rest.slice(0, closeIdx);
        content = rest.trim();
    }
    return { sender, content };
}
function subagentChanged(a, b) {
    if (a.status !== b.status ||
        a.label !== b.label ||
        a.model !== b.model ||
        a.thinking !== b.thinking ||
        a.turns !== b.turns ||
        a.toolCalls !== b.toolCalls ||
        a.endedAt !== b.endedAt ||
        a.durationMs !== b.durationMs ||
        a.result !== b.result ||
        a.error !== b.error) {
        return true;
    }
    const at = a.tools ?? [];
    const bt = b.tools ?? [];
    if (at.length !== bt.length)
        return true;
    for (let i = 0; i < at.length; i++) {
        if (at[i] !== bt[i])
            return true;
    }
    const ak = a.tokens;
    const bk = b.tokens;
    if (Boolean(ak) !== Boolean(bk))
        return true;
    if (ak && bk) {
        if (ak.total !== bk.total ||
            ak.input !== bk.input ||
            ak.output !== bk.output ||
            ak.cacheRead !== bk.cacheRead ||
            ak.cacheWrite !== bk.cacheWrite) {
            return true;
        }
    }
    return false;
}
export const MAX_SNAPSHOT_BYTES = 220 * 1024;
function compactSnapshotEntry(entry, isRecent) {
    if (isRecent || entry.kind !== "tool_result" || !entry.msg || typeof entry.msg !== "object")
        return entry;
    const msg = entry.msg;
    const content = Array.isArray(msg.content) ? msg.content : null;
    if (!content || content.length === 0)
        return entry;
    const first = content[0];
    if (!first || first.type !== "text" || typeof first.text !== "string" || first.text.length <= 1024)
        return entry;
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
    transcriptPath;
    redact;
    offset = 0;
    remainder = "";
    lastStepIndex = -1;
    pendingTools = [];
    entries = [];
    subagents = new Map();
    convToTaskId = new Map();
    childCursors = new Map();
    lastTopic = null;
    lastContextUsage = null;
    constructor(transcriptPath, redact = () => false) {
        this.transcriptPath = transcriptPath;
        this.redact = redact;
    }
    hasRunningSubagents() {
        if (this.childCursors.size > 0)
            return true;
        for (const sub of this.subagents.values()) {
            if (sub.status === "running")
                return true;
        }
        return false;
    }
    getSubagents() {
        const isRedacted = this.redact();
        return Array.from(this.subagents.values(), (sub) => this.cloneSubagent(sub, isRedacted));
    }
    cloneSubagent(sub, isRedacted = this.redact()) {
        const copy = {
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
    getSessionTopic() {
        if (this.redact())
            return null;
        return this.lastTopic;
    }
    /** Return the most recent context window token usage observed in the transcript, if any. */
    getContextUsage() {
        return this.lastContextUsage ? { ...this.lastContextUsage } : null;
    }
    /** Return a compact description of the currently executing tool call, if any. */
    get byteOffset() {
        return this.offset;
    }
    getActiveTask() {
        if (this.redact() || this.pendingTools.length === 0)
            return null;
        const latest = this.pendingTools[this.pendingTools.length - 1];
        return summarizeAgyToolTask(latest.name, latest.args);
    }
    /** Return the timestamp (ms) of the most recent conversation entry, or the transcript file mtime. */
    getLastActivityAt() {
        if (this.entries.length > 0) {
            let maxAt = 0;
            for (const e of this.entries) {
                if (typeof e.at === "number" && Number.isFinite(e.at) && e.at > maxAt) {
                    maxAt = e.at;
                }
            }
            if (maxAt > 0)
                return maxAt;
        }
        try {
            const st = fs.statSync(this.transcriptPath);
            if (Number.isFinite(st.mtimeMs) && st.mtimeMs > 0)
                return Math.floor(st.mtimeMs);
        }
        catch {
            /* ignore */
        }
        return null;
    }
    /** Load or refresh the transcript from disk and return the current snapshot (capped by count and byte budget). */
    readSnapshot() {
        const events = this.pollNewEvents();
        const picked = [];
        let bytesUsed = 0;
        let truncated = false;
        const recentThreshold = Math.max(0, this.entries.length - 12);
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = compactSnapshotEntry(this.entries[i], i >= recentThreshold);
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
    pollNewEvents() {
        const liveEvents = [];
        const chunk = readTranscriptChunk(this.transcriptPath, this.offset, this.remainder);
        if (chunk) {
            if (chunk.reset) {
                this.lastStepIndex = -1;
                this.pendingTools = [];
                this.entries = [];
                this.subagents.clear();
                this.convToTaskId.clear();
                this.childCursors.clear();
                this.lastContextUsage = null;
            }
            this.offset = chunk.nextOffset;
            this.remainder = chunk.nextRemainder;
            if (chunk.lines.length > 0) {
                let fullStepsMap;
                for (let li = 0; li < chunk.lines.length; li++) {
                    const line = chunk.lines[li].trim();
                    if (!line.startsWith("{"))
                        continue;
                    let step;
                    try {
                        step = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    const idx = typeof step.step_index === "number" ? step.step_index : this.lastStepIndex + 1;
                    if (idx <= this.lastStepIndex)
                        continue;
                    this.lastStepIndex = idx;
                    const truncFields = Array.isArray(step.truncated_fields) ? step.truncated_fields : null;
                    const hasTrunc = Boolean(truncFields && (truncFields.includes("content") || truncFields.includes("tool_calls")));
                    const isTailLine = li >= chunk.lines.length - 5;
                    const isTailPlannerOrSys = (isTailLine && (step.type === "PLANNER_RESPONSE" || step.type === "SYSTEM_MESSAGE")) ||
                        (step.type === "SYSTEM_MESSAGE" && this.convToTaskId.size > 0);
                    const isSubagentToolCall = step.type === "PLANNER_RESPONSE" &&
                        Boolean(truncFields?.includes("tool_calls")) &&
                        Array.isArray(step.tool_calls) &&
                        step.tool_calls.some((tc) => tc?.name === "invoke_subagent");
                    if (hasTrunc && (isTailPlannerOrSys || isSubagentToolCall)) {
                        if (fullStepsMap === undefined) {
                            fullStepsMap = readFullStepsMap(this.transcriptPath);
                        }
                        const full = fullStepsMap?.get(idx);
                        if (full)
                            step = full;
                    }
                    this.processStep(step, idx, liveEvents);
                }
                if (this.entries.length > SNAPSHOT_LIMIT * 2) {
                    this.entries = this.entries.slice(this.entries.length - SNAPSHOT_LIMIT - 20);
                }
            }
        }
        this.pollActiveChildren(liveEvents);
        return liveEvents;
    }
    resolveChildTranscriptPath(convId, logAbsoluteUri) {
        if (!SAFE_CONV_ID_RE.test(convId))
            return null;
        if (logAbsoluteUri && typeof logAbsoluteUri === "string") {
            try {
                const url = new URL(logAbsoluteUri);
                if (url.protocol === "file:") {
                    const candidate = path.resolve(fileURLToPath(url));
                    if (path.basename(candidate) === "transcript.jsonl") {
                        const brainRoot = path.resolve(os.homedir(), ".gemini", "antigravity-cli", "brain");
                        const siblingRoot = path.dirname(path.dirname(path.resolve(this.transcriptPath)));
                        if (isInside(brainRoot, candidate) || isInside(siblingRoot, candidate)) {
                            return candidate;
                        }
                    }
                }
            }
            catch {
                /* fall back to canonical path below */
            }
        }
        try {
            return resolveAgyTranscriptPath(convId);
        }
        catch {
            return null;
        }
    }
    pollActiveChildren(outEvents) {
        if (this.childCursors.size === 0)
            return;
        for (const convId of this.childCursors.keys()) {
            this.pollChildCursor(convId, outEvents, true);
        }
    }
    pollChildCursor(convId, outEvents, emitIfChanged) {
        const cursor = this.childCursors.get(convId);
        if (!cursor)
            return;
        const isRedacted = this.redact();
        const chunk = readTranscriptChunk(cursor.transcriptPath, cursor.offset, cursor.remainder);
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
                if (!line.startsWith("{"))
                    continue;
                let step;
                try {
                    step = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const idx = typeof step.step_index === "number" ? step.step_index : cursor.lastStepIndex + 1;
                if (idx <= cursor.lastStepIndex)
                    continue;
                cursor.lastStepIndex = idx;
                if (step.type === "USER_INPUT" && typeof step.content === "string") {
                    const m = MODEL_CHANGE_RE.exec(step.content);
                    if (m?.[1]?.trim()) {
                        cursor.model = m[1].trim();
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
                        const norm = normalizeAgyToolCall(idx, ci, calls[ci]);
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
        }
        if (!cursor.model && !cursor.modelChecked) {
            cursor.modelChecked = true;
            const ext = readExternalAgentModel("agy", "", cursor.convId);
            if (ext.id && ext.id !== "antigravity") {
                cursor.model = ext.id;
            }
        }
        const sub = this.subagents.get(cursor.taskId);
        if (!sub)
            return;
        const next = {
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
                outEvents.push(this.cloneSubagent(next, isRedacted));
            }
        }
    }
    processStep(step, stepIndex, outEvents) {
        const at = stepTimestampMs(step, stepIndex);
        const eid = `agy:${stepIndex}`;
        const isRedacted = this.redact();
        if (step.type === "USER_INPUT") {
            // Flush any unmatched pending tools before a new user turn
            this.pendingTools = [];
            const extracted = extractAgyUserText(step.content);
            if (extracted.kind === "skip")
                return;
            if (extracted.kind === "compaction") {
                this.entries.push({ eid, kind: "compaction", at, msg: isRedacted ? {} : { summary: extracted.text } });
                outEvents.push({ type: "session_compact", ...(isRedacted ? {} : { summary: extracted.text }) });
                return;
            }
            const firstLine = extracted.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
            if (!this.lastTopic && firstLine) {
                this.lastTopic = firstLine.length > 42 ? firstLine.slice(0, 41) + "…" : firstLine;
            }
            const contentBlocks = [{ type: "text", text: truncateBytes(extracted.text, LIMITS.resultMaxBytes).text }];
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
        if (step.type === "SYSTEM_MESSAGE") {
            const parsed = parseSystemWakeup(typeof step.content === "string" ? step.content : "");
            if (!parsed)
                return;
            const taskId = this.convToTaskId.get(parsed.sender);
            if (!taskId)
                return;
            this.pollChildCursor(parsed.sender, outEvents, false);
            this.convToTaskId.delete(parsed.sender);
            this.childCursors.delete(parsed.sender);
            const sub = this.subagents.get(taskId);
            if (sub) {
                const completed = {
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
                outEvents.push(this.cloneSubagent(completed, isRedacted));
            }
            return;
        }
        if (step.type === "PLANNER_RESPONSE") {
            const inTok = toNonNegInt(step.input_tokens);
            const cacheReadTok = toNonNegInt(step.cache_read_tokens);
            const cacheWriteTok = toNonNegInt(step.cache_write_tokens);
            const outTok = toNonNegInt(step.output_tokens);
            const totalTok = inTok + cacheReadTok + cacheWriteTok + outTok;
            let stepUsage;
            if (totalTok > 0) {
                const pct = Math.min(100, Math.max(0, Math.round((totalTok / AGY_CONTEXT_WINDOW) * 100)));
                this.lastContextUsage = {
                    tokens: totalTok,
                    contextWindow: AGY_CONTEXT_WINDOW,
                    percent: pct,
                };
                stepUsage = {
                    input: inTok,
                    output: outTok,
                    cacheRead: cacheReadTok,
                    cacheWrite: cacheWriteTok,
                    totalTokens: totalTok,
                    contextWindow: AGY_CONTEXT_WINDOW,
                    contextPercent: pct,
                };
            }
            const blocks = [];
            if (!isRedacted && typeof step.thinking === "string" && step.thinking.trim()) {
                blocks.push({ type: "thinking", thinking: truncateBytes(step.thinking.trim(), LIMITS.resultMaxBytes).text });
            }
            if (!isRedacted && typeof step.content === "string" && step.content.trim()) {
                blocks.push({ type: "text", text: truncateBytes(step.content.trim(), LIMITS.resultMaxBytes).text });
            }
            const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
            const expandedPerCall = [];
            for (let i = 0; i < calls.length; i++) {
                const norms = normalizeAgyToolCalls(stepIndex, i, calls[i]);
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
                if (norms.length === 0)
                    continue;
                const first = norms[0];
                const subagentIds = norms.filter((n) => Boolean(n.subagentSpec)).map((n) => n.toolCallId);
                this.pendingTools.push({
                    toolCallId: first.toolCallId,
                    name: first.name,
                    args: first.args,
                    at,
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
                        const sub = {
                            type: "subagent_update",
                            taskId: norm.toolCallId,
                            agent: norm.subagentSpec.typeName,
                            label: isRedacted ? "[redacted]" : norm.subagentSpec.role,
                            status: "running",
                            startedAt: at,
                            tools: [],
                        };
                        this.setSubagent(norm.toolCallId, sub);
                        outEvents.push(this.cloneSubagent(sub, isRedacted));
                    }
                }
            }
            return;
        }
        if (step.type === "GENERIC" && this.pendingTools.length > 0) {
            const pending = this.pendingTools.shift();
            const isError = step.status === "ERROR";
            const rawOut = typeof step.content === "string" ? step.content : "";
            const { text, truncated } = truncateBytes(rawOut, LIMITS.resultMaxBytes);
            const resultObj = {
                content: [{ type: "text", text }],
                ...(truncated ? { truncated: true } : {}),
            };
            const targetIds = pending.subagentIds && pending.subagentIds.length > 0 ? pending.subagentIds : [pending.toolCallId];
            for (let si = 0; si < targetIds.length; si++) {
                const toolCallId = targetIds[si];
                const entryMsg = {
                    role: "toolResult",
                    toolCallId,
                    toolName: pending.name,
                    isError,
                    ...(isRedacted ? {} : { content: resultObj.content }),
                };
                this.entries.push({ eid: si === 0 ? eid : `${eid}:${si}`, kind: "tool_result", at, msg: entryMsg });
                outEvents.push({
                    type: "tool_execution_end",
                    toolCallId,
                    toolName: pending.name,
                    isError,
                    durationMs: Math.max(0, at - pending.at),
                    ...(isRedacted ? {} : { result: resultObj, ...(truncated ? { truncated: true } : {}) }),
                });
            }
            if (pending.subagentIds && pending.subagentIds.length > 0) {
                const refs = isError ? [] : parseSpawnedSubagentRefs(rawOut);
                const hasValidAck = !isError && refs.some(Boolean);
                for (let si = 0; si < pending.subagentIds.length; si++) {
                    const subId = pending.subagentIds[si];
                    const sub = this.subagents.get(subId);
                    if (!sub)
                        continue;
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
                                modelChecked: false,
                            });
                        }
                        continue;
                    }
                    const finished = {
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
                    outEvents.push(this.cloneSubagent(finished, isRedacted));
                }
                return;
            }
        }
    }
    setSubagent(taskId, sub) {
        this.subagents.set(taskId, sub);
        while (this.subagents.size > MAX_SUBAGENTS) {
            let victim;
            for (const [id, s] of this.subagents) {
                if (s.status !== "running") {
                    victim = id;
                    break;
                }
            }
            if (!victim)
                victim = this.subagents.keys().next().value;
            if (!victim)
                break;
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
