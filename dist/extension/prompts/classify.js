// Classification of dialogs into permission / question / dialog (PLAN §8.3).
import { AsyncLocalStorage } from "node:async_hooks";
export const AGENTS_GLYPH = "❀ ";
/** Our own gate / rp_ask_user wrap their dialogs in this context so the classifier can tell them apart. */
export const promptContext = new AsyncLocalStorage();
export class Classifier {
    now;
    sameTickMs;
    pending = null;
    /** When set, `adapterTool` identifies the gentle-pi tool whose custom() dialog is being adapted. */
    constructor(now = Date.now, sameTickMs = 150) {
        this.now = now;
        this.sameTickMs = sameTickMs;
    }
    /** `pi-permission-system:permission-request` (gentle-pi P1): fired right before the confirm dialog. */
    onPermissionRequest(d) {
        const o = d;
        if (!o || o.state !== "waiting")
            return;
        this.pending = { at: this.now(), toolName: typeof o.toolName === "string" ? o.toolName : "bash", requestId: o.requestId };
    }
    classifyDialog(kind, title, message) {
        const ctx = promptContext.getStore();
        if (ctx) {
            return {
                category: ctx.category,
                danger: ctx.danger ?? "low",
                tool: ctx.tool,
                source: ctx.source,
                herdrReported: false,
                message: ctx.message ?? message,
            };
        }
        const p = this.pending;
        if (p && this.now() - p.at <= this.sameTickMs) {
            this.pending = null;
            return {
                category: "permission",
                danger: /data-?loss/i.test(title) ? "high" : "medium",
                tool: { name: p.toolName, args: kind === "confirm" && message ? { command: message } : {} },
                source: { extension: "gentle-pi" },
                herdrReported: true,
                message,
            };
        }
        if (title.startsWith(AGENTS_GLYPH)) {
            return {
                category: "question",
                danger: "low",
                source: { extension: "gentle-pi", subagent: true },
                herdrReported: true,
                message,
            };
        }
        return { category: "dialog", danger: "low", herdrReported: false, message };
    }
}
