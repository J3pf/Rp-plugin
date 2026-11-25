// Pure parsers, tool/message normalizers, chunk/tail readers, and URI confinement helpers for agy transcripts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "../../extension/forwarder.js";
import { SAFE_CONV_ID_RE, truncateBytes } from "../../shared/util.js";
import { AGY_TAIL_WINDOW_BYTES, readTailBuffer } from "./agy-paths.js";
export const MAX_BG_TASK_LOG_BYTES = 8192;
const MAX_POLL_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_REMAINDER_BYTES = 1024 * 1024;
/** Default fallback context window for Antigravity CLI (agy) when model is unknown. */
export const AGY_CONTEXT_WINDOW = 256_000;
export const AGY_GEMINI_CONTEXT_WINDOW = 1_048_576;
export const AGY_CLAUDE_CONTEXT_WINDOW = 1_000_000;
export const AGY_GPT_OSS_CONTEXT_WINDOW = 131_072;
/** Resolve the actual AGY context window in tokens from a model ID or display label. */
export function resolveAgyContextWindow(model) {
    const m = (model ?? "").trim().toLowerCase();
    if (!m)
        return AGY_CONTEXT_WINDOW;
    if (m.includes("gemini") || m.includes("orchestrator"))
        return AGY_GEMINI_CONTEXT_WINDOW;
    if (m.includes("claude"))
        return AGY_CLAUDE_CONTEXT_WINDOW;
    if (m.includes("gpt-oss"))
        return AGY_GPT_OSS_CONTEXT_WINDOW;
    return AGY_CONTEXT_WINDOW;
}
export function computeContextUsage(tokens, model) {
    const contextWindow = resolveAgyContextWindow(model);
    const percent = Math.min(100, Math.max(0, Math.round((tokens / contextWindow) * 100)));
    return { tokens, contextWindow, percent };
}
const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
const TRIVIAL_TOPIC_WORDS = new Set([
    "si", "no", "ok", "okay", "okey", "oki", "okis", "k", "kk",
    "dale", "listo", "bueno", "bien", "vale", "claro", "va", "pues", "aja",
    "adelante", "perfecto", "genial", "excelente", "super", "gracias",
    "hola", "holi", "buenas", "hey", "ey", "yap", "sip", "nop", "simon",
    "obvio", "hagamoslo", "hagamole", "hazlo",
    "yes", "yep", "yeah", "yup", "nope", "sure", "fine", "good",
    "great", "nice", "cool", "perfect", "thanks", "thx", "ty",
    "hi", "hello", "yo", "go", "ahead", "continue", "proceed",
    "please", "do", "it", "sounds", "lgtm", "ya",
]);
function normalizeTopicWord(word) {
    return word.replace(/(.)\1{2,}/g, "$1").replace(/(.)\1+$/g, "$1");
}
function isTrivialTopicLine(line) {
    if (/^\[Archivo adjunto\b/i.test(line))
        return true;
    const cleaned = line
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .trim();
    if (!cleaned || !/\p{L}/u.test(cleaned))
        return true;
    const words = cleaned.split(/\s+/).filter(Boolean).map(normalizeTopicWord);
    if (words.length === 0)
        return true;
    return words.length <= 4 && words.every((w) => TRIVIAL_TOPIC_WORDS.has(w) || w.length <= 1);
}
/** Pick the first substantive non-trivial line from user prompt text for session naming. */
export function extractSessionTopic(rawText) {
    for (const rawLine of rawText.split("\n")) {
        const line = rawLine.trim();
        if (!line || isTrivialTopicLine(line))
            continue;
        return line.length > 42 ? `${line.slice(0, 41)}…` : line;
    }
    return null;
}
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
export function isSafeSystemSender(sender) {
    if (!sender)
        return false;
    if (SAFE_CONV_ID_RE.test(sender))
        return true;
    const parts = sender.split("/");
    return parts.length === 2 && SAFE_CONV_ID_RE.test(parts[0]) && SAFE_CONV_ID_RE.test(parts[1]);
}
function normalizeInvokeSubagentEntry(toolCallId, entry, parsed, subs) {
    const first = subs[0] && typeof subs[0] === "object" ? subs[0] : {};
    const src = Object.keys(entry).length > 0 ? entry : first;
    const role = String(src.Role ?? src.role ?? parsed.Role ?? parsed.role ?? parsed.toolSummary ?? "Subagent");
    const typeName = String(src.TypeName ?? src.typeName ?? src.type_name ?? parsed.TypeName ?? parsed.typeName ?? "subagent");
    const prompt = String(src.Prompt ?? src.prompt ?? parsed.Prompt ?? parsed.prompt ?? "");
    const rawModel = src.Model ?? src.model ?? parsed.Model ?? parsed.model;
    const requestedModel = typeof rawModel === "string" && rawModel.trim() && rawModel.trim().toLowerCase() !== "inherit"
        ? rawModel.trim()
        : undefined;
    return {
        toolCallId,
        name: "subagent_run",
        args: {
            agent: typeName,
            label: role,
            task: truncateBytes(prompt, 500).text,
            ...(requestedModel ? { model: requestedModel } : {}),
        },
        subagentSpec: { role, typeName, prompt, ...(requestedModel ? { model: requestedModel } : {}) },
    };
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
                ...(parsed.IsDaemon === true ? { isDaemon: true } : {}),
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
        case "manage_task": {
            const safeArgs = {};
            for (const [k, v] of Object.entries(parsed)) {
                safeArgs[k] = typeof v === "string" ? truncateBytes(v, 2048).text : v;
            }
            const rawTaskId = typeof parsed.TaskId === "string" ? parsed.TaskId.trim() : "";
            const killTaskSender = parsed.Action === "kill" && isSafeSystemSender(rawTaskId) ? rawTaskId : undefined;
            return {
                toolCallId,
                name: rawName,
                args: safeArgs,
                ...(killTaskSender ? { killTaskSender } : {}),
            };
        }
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
export function stepTimestampMs(step, stepIndex) {
    const base = step.created_at ? Date.parse(step.created_at) : NaN;
    const ms = Number.isFinite(base) ? base : Date.now();
    // Add stepIndex offset so rapid steps within the same second never collide in ChatReducer.keyOf
    return ms + stepIndex;
}
export function toNonNegInt(v) {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}
/** Build a step_index -> AgyStepRaw map from the last 512 KB of transcript_full.jsonl. */
export function readFullStepsMap(transcriptPath) {
    const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
    const tail = readTailBuffer(fullPath, AGY_TAIL_WINDOW_BYTES);
    if (!tail)
        return null;
    const lines = tail.buf.toString("utf8").split("\n");
    const minIdx = tail.start > 0 ? 1 : 0;
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
/** Read newly appended complete JSONL lines from a transcript file since `offset`. */
export function readTranscriptChunk(filePath, offset, remainder) {
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
    if (curOffset === 0 && stat.size > AGY_TAIL_WINDOW_BYTES) {
        curOffset = stat.size - AGY_TAIL_WINDOW_BYTES;
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
    try {
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
    }
    catch {
        return null;
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
export function parseSpawnedSubagentRefs(rawOut) {
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
export function parseSystemWakeup(raw) {
    if (!raw)
        return null;
    const senderMatch = /\bsender=([^\s\]\n<>]+)/.exec(raw);
    const sender = senderMatch?.[1]?.trim();
    if (!sender || !isSafeSystemSender(sender))
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
export function parseBackgroundTaskAck(rawOut) {
    if (!rawOut)
        return null;
    const idMatch = /Tool is running as a background task with task id:\s*([^\s\r\n]+)/i.exec(rawOut);
    const taskSender = idMatch?.[1]?.trim();
    if (!taskSender || !isSafeSystemSender(taskSender))
        return null;
    const logMatch = /Task logs are available at:\s*(file:\/\/[^\s\r\n]+)/i.exec(rawOut);
    const logMatchUri = logMatch?.[1]?.trim();
    const outMatch = /(?:^|\r?\n)Log output:\r?\n([\s\S]*)$/.exec(rawOut);
    const initialTail = outMatch?.[1]?.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
    return {
        taskSender,
        ...(logMatchUri ? { logUri: logMatchUri } : {}),
        ...(initialTail ? { initialTail: truncateBytes(initialTail, LIMITS.resultMaxBytes).text } : {}),
    };
}
export function isFinalBackgroundWakeup(content) {
    return (/\bfinished with (?:result|error)\b/i.test(content) ||
        /^(?:The )?[Cc]ommand exited with code \d+\b/m.test(content));
}
export function isBackgroundTaskError(content) {
    return (/\bfinished with error\b/i.test(content) ||
        /^(?:The )?[Cc]ommand exited with code [1-9]\d*\b/m.test(content));
}
/** Read and normalize the tail of a background task log file. */
export function readLogTail(filePath, maxReadBytes = MAX_BG_TASK_LOG_BYTES) {
    const tail = readTailBuffer(filePath, maxReadBytes);
    if (!tail)
        return null;
    let view = tail.buf;
    if (tail.start > 0) {
        const nl = view.indexOf(0x0a);
        if (nl >= 0 && nl + 1 < view.length) {
            view = view.subarray(nl + 1);
        }
        else {
            let idx = 0;
            while (idx < view.length && (view[idx] & 0xc0) === 0x80)
                idx++;
            if (idx > 0)
                view = view.subarray(idx);
        }
    }
    const normalized = view.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
    if (!normalized)
        return null;
    return {
        text: truncateBytes(normalized, LIMITS.resultMaxBytes).text,
        size: tail.size,
        mtimeMs: tail.mtimeMs,
    };
}
export function subagentChanged(a, b) {
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
export function realpathOrNull(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    }
    catch {
        return null;
    }
}
/**
 * Resolve a candidate file path for containment verification.
 * - If the file exists on disk: rejects symlinks and non-regular files, returning its `realpathSync`.
 * - If the file does not exist yet (`ENOENT`): resolves the nearest existing ancestor via `realpathSync`
 *   and rejoins the trailing non-existent segments.
 */
export function resolveSafeFileCandidate(candidate, requireExists = false) {
    const abs = path.resolve(candidate);
    try {
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile())
            return null;
        const realPath = fs.realpathSync(abs);
        return { realPath, exists: true };
    }
    catch (e) {
        if (requireExists || e?.code !== "ENOENT")
            return null;
    }
    const tail = [];
    let cur = abs;
    while (true) {
        try {
            const realAncestor = fs.realpathSync(cur);
            return {
                realPath: tail.length > 0 ? path.join(realAncestor, ...tail.reverse()) : realAncestor,
                exists: false,
            };
        }
        catch (e) {
            if (e?.code !== "ENOENT")
                return null;
            const parent = path.dirname(cur);
            if (parent === cur)
                return null;
            tail.push(path.basename(cur));
            cur = parent;
        }
    }
}
/**
 * Resolve an optional `file://` URI against a containment predicate, falling back to `buildFallback()`
 * only when the URI is absent, invalid, or non-symlink outside containment.
 * Explicit symlinks are rejected immediately (returning `null` without fallback).
 */
export function resolveAllowedFileUri(uri, isAllowed, buildFallback) {
    if (uri && typeof uri === "string") {
        try {
            const url = new URL(uri);
            if (url.protocol === "file:") {
                const candidate = path.resolve(fileURLToPath(url));
                if (isAllowed(candidate)) {
                    return candidate;
                }
                // Reject explicit symlinks immediately without falling back to the same path
                try {
                    if (fs.lstatSync(candidate).isSymbolicLink())
                        return null;
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch {
            /* fall back to canonical path */
        }
    }
    const fallback = buildFallback();
    return fallback && isAllowed(fallback) ? fallback : null;
}
