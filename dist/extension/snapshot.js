// getBranch() → agent.snapshot (last 200 entries, normalized).
import { normalizeMessage } from "./forwarder.js";
import { toEpochMs } from "../shared/util.js";
export const SNAPSHOT_LIMIT = 200;
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
            return { eid, kind: "compaction", at: at(entry), msg: redact ? {} : { summary: entry.summary } };
        case "branch_summary":
            return { eid, kind: "branch_summary", at: at(entry), msg: redact ? {} : { summary: entry.summary } };
        case "model_change":
            return { eid, kind: "model_change", at: at(entry), msg: { provider: entry.provider, modelId: entry.modelId } };
        case "custom_message":
            return { eid, kind: "custom", at: at(entry), msg: redact ? {} : { customType: entry.customType, content: entry.content } };
        default:
            return null;
    }
}
export function buildSnapshotEntries(branch, redact) {
    const picked = [];
    let truncated = false;
    for (let i = branch.length - 1; i >= 0; i--) {
        const s = toSnapshotEntry(branch[i], redact);
        if (!s)
            continue;
        if (picked.length < SNAPSHOT_LIMIT) {
            picked.push(s);
        }
        else {
            truncated = true;
            break;
        }
    }
    picked.reverse();
    return { entries: picked, truncated };
}
