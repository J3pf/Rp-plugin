// Shared Antigravity CLI (agy) path helpers, context usage types, model-change regex, and tail buffer reader.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SAFE_CONV_ID_RE } from "../../shared/util.js";
import { isInside } from "../validate.js";
export const AGY_TAIL_WINDOW_BYTES = 512 * 1024;
export const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to ([^\n<]+?)\.(?:\s|$)/i;
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
/** Infer the user home directory from a canonical agy transcript path, falling back to `os.homedir()`. */
export function inferAgyHomeFromTranscriptPath(transcriptPath) {
    const resolved = path.resolve(transcriptPath);
    const logsDir = path.dirname(resolved);
    const sysDir = path.dirname(logsDir);
    const convDir = path.dirname(sysDir);
    const brainDir = path.dirname(convDir);
    const cliDir = path.dirname(brainDir);
    const geminiDir = path.dirname(cliDir);
    if (path.basename(cliDir) === "antigravity-cli" && path.basename(geminiDir) === ".gemini") {
        return path.dirname(geminiDir);
    }
    return os.homedir();
}
/** Safely read up to the last `maxBytes` of a regular file, returning null on missing/non-file/read errors. */
export function readTailBuffer(filePath, maxBytes) {
    if (maxBytes <= 0)
        return null;
    let st;
    try {
        st = fs.statSync(filePath);
    }
    catch {
        return null;
    }
    if (!st.isFile() || st.size <= 0)
        return null;
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    try {
        const fd = fs.openSync(filePath, "r");
        try {
            const raw = Buffer.allocUnsafe(len);
            const bytesRead = fs.readSync(fd, raw, 0, len, start);
            if (bytesRead <= 0)
                return null;
            return {
                buf: bytesRead === len ? raw : raw.subarray(0, bytesRead),
                size: st.size,
                mtimeMs: st.mtimeMs,
                start,
            };
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
