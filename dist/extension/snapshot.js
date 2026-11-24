// getBranch() → agent.snapshot (last 200 entries, bounded by byte budget, normalized).
import { LIMITS, normalizeContentBlock, normalizeMessage, truncateJsonValue } from "./forwarder.js";
import { toEpochMs, truncateBytes } from "../shared/util.js";
export const SNAPSHOT_LIMIT = 200;
export const MAX_SNAPSHOT_BYTES = 220 * 1024;
function at(entry) {
    const t = entry?.timestamp;
    if (typeof t === "number")
        return toEpochMs(t);
    if (typeof t === "string") {
        const p = Date.parse(t);
        if (!Number.isNaN(p))
            return toEpochMs(p);
    }
    return Math.round(Date.now());
}
function normalizeSummary(summary) {
    if (typeof summary === "string") {
        const t = truncateBytes(summary, LIMITS.summaryMaxBytes);
        return t.truncated ? { summary: t.text, truncated: true } : { summary: t.text };
    }
    return { summary };
}
function normalizeCustomContent(content) {
    if (typeof content === "string")
        return truncateBytes(content, LIMITS.resultMaxBytes).text;
    if (Array.isArray(content))
        return content.map((b) => normalizeContentBlock(b, LIMITS.resultMaxBytes));
    if (content && typeof content === "object")
        return truncateJsonValue(content, LIMITS.resultMaxBytes).value;
    return content;
}
/** Map one Pi session entry to the wire Entry, or null when it should not be shown. */
export function toSnapshotEntry(entry, redact) {
    if (!entry || typeof entry !== "object")
        return null;
    const eid = String(entry.id ?? "");
    switch (entry.type) {
        case "message": {
            const m = entry.message;
            const role = m?.role;
            let kind = null;
            if (role === "user")
                kind = "user";
            else if (role === "assistant")
                kind = "assistant";
            else if (role === "toolResult")
                kind = "tool_result";
            else if (role === "bashExecution")
                kind = "bash";
            else if (role === "custom")
                kind = "custom";
            else if (role === "compactionSummary")
                kind = "compaction";
            else if (role === "branchSummary")
                kind = "branch_summary";
            if (!kind)
                return null;
            if (redact)
                return { eid, kind, at: at(entry), msg: { role } };
            return { eid, kind, at: at(entry), msg: normalizeMessage(m) };
        }
        case "compaction":
            return { eid, kind: "compaction", at: at(entry), msg: redact ? {} : normalizeSummary(entry.summary) };
        case "branch_summary":
            return { eid, kind: "branch_summary", at: at(entry), msg: redact ? {} : normalizeSummary(entry.summary) };
        case "model_change":
            return { eid, kind: "model_change", at: at(entry), msg: { provider: entry.provider, modelId: entry.modelId } };
        case "custom_message":
            return {
                eid,
                kind: "custom",
                at: at(entry),
                msg: redact ? {} : { customType: entry.customType, content: normalizeCustomContent(entry.content) },
            };
        default:
            return null;
    }
}
export function buildSnapshotEntries(branch, redact, maxBytes = MAX_SNAPSHOT_BYTES) {
    const picked = [];
    let truncated = false;
    let totalBytes = 2; // []
    for (let i = branch.length - 1; i >= 0; i--) {
        const s = toSnapshotEntry(branch[i], redact);
        if (!s)
            continue;
        if (picked.length >= SNAPSHOT_LIMIT) {
            truncated = true;
            break;
        }
        const serializedBytes = Buffer.byteLength(JSON.stringify(s), "utf8");
        const extra = serializedBytes + (picked.length > 0 ? 1 : 0);
        if (totalBytes + extra > maxBytes) {
            if (picked.length === 0) {
                const msgBudget = Math.max(512, maxBytes - 512);
                const bounded = { ...s, msg: truncateJsonValue(s.msg, msgBudget).value };
                if (totalBytes + Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) {
                    picked.push(bounded);
                }
            }
            truncated = true;
            break;
        }
        picked.push(s);
        totalBytes += extra;
    }
    picked.reverse();
    return { entries: picked, truncated };
}
