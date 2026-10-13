// Classification of dialogs into permission / question / dialog (PLAN §8.3).
import { AsyncLocalStorage } from "node:async_hooks";
import type { Danger, PromptCategory } from "../../shared/protocol.ts";

export const AGENTS_GLYPH = "❀ ";

export interface PromptContext {
  category: PromptCategory;
  danger?: Danger;
  tool?: { name: string; args: unknown };
  source?: { extension?: string; tool?: string; subagent?: boolean };
  message?: string;
}

/** Our own gate / rp_ask_user wrap their dialogs in this context so the classifier can tell them apart. */
export const promptContext = new AsyncLocalStorage<PromptContext>();

export interface Classification {
  category: PromptCategory;
  danger: Danger;
  tool?: { name: string; args: unknown };
  source?: { extension?: string; tool?: string; subagent?: boolean };
  /** True when the dialog's herdr "blocked" marker is already emitted by someone else (gentle-pi). */
  herdrReported: boolean;
  message?: string;
}

interface PermissionRequest {
  at: number;
  toolName: string;
  requestId?: string;
}

export class Classifier {
  private pending: PermissionRequest | null = null;
  /** When set, `adapterTool` identifies the gentle-pi tool whose custom() dialog is being adapted. */
  constructor(private now: () => number = Date.now, private sameTickMs = 150) {}

  /** `pi-permission-system:permission-request` (gentle-pi P1): fired right before the confirm dialog. */
  onPermissionRequest(d: unknown): void {
    const o: any = d;
    if (!o || o.state !== "waiting") return;
    this.pending = { at: this.now(), toolName: typeof o.toolName === "string" ? o.toolName : "bash", requestId: o.requestId };
  }

  classifyDialog(kind: "select" | "confirm" | "input", title: string, message?: string): Classification {
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
