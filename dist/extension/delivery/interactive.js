export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CONFIRM_TIMEOUT_MS = 3000;
export function normalizeText(s) {
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
export function editorAcceptsText(_ctx, statuses) {
    const vimKey = Object.keys(statuses).find((k) => /vim/i.test(k) || /vim/i.test(statuses[k] ?? ""));
    if (vimKey) {
        return /insert/i.test(statuses[vimKey] ?? "") ? { ok: true } : { ok: false, reason: `editor not in insert mode (${statuses[vimKey]})` };
    }
    return { ok: true };
}
export async function deliverInteractive(d, text, mode) {
    const fail = (reason) => ({ ok: false, error: "interactive_unavailable", reason });
    let afterDialog = false;
    const checkReady = async () => {
        if (!d.enabled())
            return { ok: false, outcome: fail("interactive delivery disabled") };
        const ctx = d.ctx();
        if (ctx.mode !== "tui")
            return { ok: false, outcome: fail(`mode ${ctx.mode} has no terminal UI`) };
        const stdin = d.stdin();
        if (!stdin)
            return { ok: false, outcome: fail("stdin unavailable") };
        if (d.dialogOpen()) {
            afterDialog = true;
            if (!(await d.waitNoDialog(d.maxDialogWaitMs ?? 10 * 60_000)))
                return { ok: false, outcome: fail("a dialog stayed open") };
            if (!d.enabled())
                return { ok: false, outcome: fail("interactive delivery disabled") };
        }
        const safe = editorAcceptsText(ctx, d.statuses());
        if (!safe.ok)
            return { ok: false, outcome: fail(safe.reason ?? "editor not ready") };
        return { ok: true, ctx, stdin };
    };
    let ready = await checkReady();
    if (!ready.ok)
        return ready.outcome;
    // follow-up while working: wait for the agent to settle (the follow-up key is configurable); steer: Enter while working = steer
    if (!ready.ctx.isIdle() && mode !== "steer") {
        await d.waitSettled();
        ready = await checkReady();
        if (!ready.ok)
            return ready.outcome;
    }
    const { ctx, stdin } = ready;
    let draft = "";
    try {
        draft = ctx.ui.getEditorText();
        if (draft)
            ctx.ui.setEditorText("");
    }
    catch {
        draft = "";
    }
    const restore = () => {
        try {
            ctx.ui.setEditorText(draft);
        }
        catch {
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
