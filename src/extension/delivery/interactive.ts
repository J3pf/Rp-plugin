// Interactive delivery: type the message into the TUI of this very process (RESILIENCIA §2).
// Pi's TUI reads process.stdin in-process and tags editor submissions as source "interactive".
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CONFIRM_TIMEOUT_MS = 3000;

export type InteractiveOutcome =
  | { ok: true; afterDialog: boolean }
  | { ok: false; error: "interactive_unavailable"; reason: string };

export interface InteractiveDeps {
  ctx: () => ExtensionContext;
  stdin: () => { emit(event: string, ...args: any[]): boolean } | null;
  dialogOpen: () => boolean;
  /** Resolves the next time no dialog is open. */
  waitNoDialog: (maxMs: number) => Promise<boolean>;
  /** Resolves on the next agent_settled (or immediately when idle). */
  waitSettled: () => Promise<void>;
  /** Resolves true if an `input` event with source "interactive" and this text arrives within `ms`. */
  expectInput: (text: string, ms: number) => Promise<boolean>;
  /** Footer statuses observed via setStatus (for Vim-mode detection). */
  statuses: () => Record<string, string>;
  enabled: () => boolean;
  confirmMs?: number;
  maxDialogWaitMs?: number;
}

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "")
    .replace(/\x1b/g, "")
    .trim();
}

/**
 * Vim-mode safeguard: with a custom editor installed we only type when we can see the editor is in insert mode.
 * Pending confirmation in spike S7.
 */
export function editorAcceptsText(_ctx: ExtensionContext, statuses: Record<string, string>): { ok: boolean; reason?: string } {
  const vimKey = Object.keys(statuses).find((k) => /vim/i.test(k) || /vim/i.test(statuses[k] ?? ""));
  if (vimKey) {
    return /insert/i.test(statuses[vimKey] ?? "") ? { ok: true } : { ok: false, reason: `editor not in insert mode (${statuses[vimKey]})` };
  }
  return { ok: true };
}

export async function deliverInteractive(d: InteractiveDeps, text: string, mode: "steer" | "followUp" | "auto"): Promise<InteractiveOutcome> {
  const fail = (reason: string): InteractiveOutcome => ({ ok: false, error: "interactive_unavailable", reason });
  let afterDialog = false;
  const checkReady = async (): Promise<
    { ok: true; ctx: ExtensionContext; stdin: { emit(event: string, ...args: any[]): boolean } } | { ok: false; outcome: InteractiveOutcome }
  > => {
    if (!d.enabled()) return { ok: false, outcome: fail("interactive delivery disabled") };
    const ctx = d.ctx();
    if (ctx.mode !== "tui") return { ok: false, outcome: fail(`mode ${ctx.mode} has no terminal UI`) };
    const stdin = d.stdin();
    if (!stdin) return { ok: false, outcome: fail("stdin unavailable") };
    if (d.dialogOpen()) {
      afterDialog = true;
      if (!(await d.waitNoDialog(d.maxDialogWaitMs ?? 10 * 60_000))) return { ok: false, outcome: fail("a dialog stayed open") };
      if (!d.enabled()) return { ok: false, outcome: fail("interactive delivery disabled") };
    }
    const safe = editorAcceptsText(ctx, d.statuses());
    if (!safe.ok) return { ok: false, outcome: fail(safe.reason ?? "editor not ready") };
    return { ok: true, ctx, stdin };
  };

  let ready = await checkReady();
  if (!ready.ok) return ready.outcome;

  // follow-up while working: wait for the agent to settle (the follow-up key is configurable); steer: Enter while working = steer
  if (!ready.ctx.isIdle() && mode !== "steer") {
    await d.waitSettled();
    ready = await checkReady();
    if (!ready.ok) return ready.outcome;
  }
  const { ctx, stdin } = ready;

  let draft = "";
  try {
    draft = ctx.ui.getEditorText();
    if (draft) ctx.ui.setEditorText("");
  } catch {
    draft = "";
  }
  const restore = () => {
    try {
      ctx.ui.setEditorText(draft);
    } catch {
      /* ignore */
    }
  };

  const safeText = text.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "").replace(/\x1b/g, "");
  const confirmed = d.expectInput(safeText, d.confirmMs ?? CONFIRM_TIMEOUT_MS);
  stdin.emit("data", BRACKETED_PASTE_START + safeText + BRACKETED_PASTE_END);
  stdin.emit("data", "\r");
  if (await confirmed) {
    restore();
    return { ok: true, afterDialog };
  }
  restore(); // also clears the text we pasted but that never got submitted
  return fail("Pi did not report the typed input in time");
}
