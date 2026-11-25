import { LruSet } from "../../shared/util.js";
import { resolveAttachments } from "../attachments.js";
import { deliverApi } from "./api.js";
import { deliverHerdr } from "./herdr.js";
import { deliverInteractive } from "./interactive.js";
import { handleModelCommand, handleThinkingCommand } from "./slash-commands.js";
/** Order of methods to try for a message. */
export function methodChain(requested, cfgMethod, opts) {
    if (opts.asCommand)
        return ["api"];
    const want = requested && requested !== "auto" ? requested : cfgMethod;
    const chain = [];
    const canInteractive = opts.interactiveEnabled && opts.isTui;
    if (want === "api")
        return ["api"];
    if (want === "interactive") {
        if (canInteractive)
            chain.push("interactive");
        if (opts.hasHerdr)
            chain.push("herdr");
        chain.push("api");
        return chain;
    }
    if (want === "herdr") {
        if (opts.hasHerdr)
            chain.push("herdr");
        chain.push("api");
        return chain;
    }
    // auto: gentle AUTO → interactive → herdr → api; otherwise api
    if (opts.gentleAuto) {
        if (canInteractive)
            chain.push("interactive");
        if (opts.hasHerdr)
            chain.push("herdr");
    }
    chain.push("api");
    return chain;
}
const ACTIVE_SELECT_WAIT_TIMEOUT_MS = 60_000;
function appendAttachmentLines(baseText, lines) {
    if (lines.length === 0)
        return baseText;
    return baseText ? `${baseText}\n\n${lines.join("\n")}` : lines.join("\n");
}
function createAttachmentCache(msg, deps) {
    const blobCache = new Map();
    const cachedFetchBlob = deps.fetchBlob
        ? (blobId) => {
            let p = blobCache.get(blobId);
            if (!p) {
                p = deps.fetchBlob(blobId);
                blobCache.set(blobId, p);
            }
            return p;
        }
        : null;
    const writtenFiles = new Map();
    let resolvedApi = null;
    let resolvedTextNonInline = null;
    return {
        async resolveFor(method) {
            if (!msg.attachments?.length || !cachedFetchBlob) {
                return { text: msg.text, images: [] };
            }
            if (method === "api") {
                if (!resolvedApi) {
                    const r = await resolveAttachments(msg.attachments, {
                        fetchBlob: cachedFetchBlob,
                        inboxDir: deps.inboxDir(),
                        sessionId: deps.sessionId(),
                        inlineImages: true,
                        writtenFiles,
                    });
                    resolvedApi = {
                        text: appendAttachmentLines(msg.text, r.lines),
                        images: r.images,
                    };
                }
                return resolvedApi;
            }
            if (resolvedTextNonInline === null) {
                const r = await resolveAttachments(msg.attachments, {
                    fetchBlob: cachedFetchBlob,
                    inboxDir: deps.inboxDir(),
                    sessionId: deps.sessionId(),
                    inlineImages: false,
                    writtenFiles,
                });
                resolvedTextNonInline = appendAttachmentLines(msg.text, r.lines);
            }
            return { text: resolvedTextNonInline, images: [] };
        },
    };
}
export class Deliverer {
    d;
    seen = new LruSet(500);
    /** Serialize deliveries: typing into the editor must never interleave. */
    tail = Promise.resolve();
    activeSelectPromises = new Set();
    constructor(d) {
        this.d = d;
    }
    handle(msg) {
        let bg = null;
        const step = this.tail
            .then(() => this.process(msg, (task) => {
            bg = task;
            this.activeSelectPromises.add(task);
            void task.finally(() => this.activeSelectPromises.delete(task)).catch(() => { });
        }))
            .catch(() => { });
        this.tail = step;
        return step.then(() => bg ?? undefined).catch(() => { });
    }
    async tryHandleSlashCommand(msg, ctx, textTrimmed, onBackground) {
        const id = msg.clientMsgId;
        if (textTrimmed === "/quit" || textTrimmed === "/exit") {
            this.record(msg, "api");
            this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
            const shutdown = ctx.shutdown;
            if (typeof shutdown === "function")
                shutdown();
            return true;
        }
        const lower = textTrimmed.toLowerCase();
        if (lower === "/model" || /^\/model\s+/i.test(textTrimmed)) {
            this.record(msg, "api");
            this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
            const arg = textTrimmed.replace(/^\/model\s*/i, "").trim();
            await handleModelCommand(this.d.pi, ctx, arg, { askSelect: this.d.askSelect, onBackground });
            return true;
        }
        if (lower === "/thinking" || /^\/thinking\s+/i.test(textTrimmed)) {
            this.record(msg, "api");
            this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
            const arg = textTrimmed.replace(/^\/thinking\s*/i, "").trim();
            await handleThinkingCommand(this.d.pi, ctx, arg, {
                askSelect: this.d.askSelect,
                onBackground,
                onThinkingSelected: this.d.onThinkingSelected,
            });
            return true;
        }
        return false;
    }
    async waitForActiveSelects() {
        if (this.activeSelectPromises.size === 0)
            return;
        let timer;
        await Promise.race([
            Promise.allSettled([...this.activeSelectPromises]),
            new Promise((resolve) => {
                timer = setTimeout(resolve, ACTIVE_SELECT_WAIT_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]).finally(() => {
            if (timer)
                clearTimeout(timer);
        });
    }
    async process(msg, onBackground) {
        const id = msg.clientMsgId;
        if (this.seen.has(id)) {
            this.d.sendAck({ clientMsgId: id, disposition: "duplicate", method: "api", error: null });
            return;
        }
        this.seen.add(id);
        const ctx = this.d.ctx();
        const textTrimmed = msg.text.trim();
        if (await this.tryHandleSlashCommand(msg, ctx, textTrimmed, onBackground)) {
            return;
        }
        const cfg = this.d.cfg();
        const asCommand = !!msg.asCommand || textTrimmed.startsWith("/");
        const mode = this.d.gentleMode();
        // Until gentle-pi publishes its mode (first turn) assume it could be AUTO: typing is correct in every mode.
        const gentleAuto = mode === "auto" || (!!this.d.gentlePresent?.() && (mode === null || mode === "unknown"));
        const chain = methodChain(msg.method, cfg.delivery.method, {
            gentleAuto,
            interactiveEnabled: cfg.delivery.interactive,
            hasHerdr: !!this.d.herdr,
            isTui: ctx.mode === "tui",
            asCommand,
        });
        let lastError = null;
        const attachments = createAttachmentCache(msg, this.d);
        for (const method of chain) {
            const { text, images } = await attachments.resolveFor(method);
            try {
                if (method === "api") {
                    const res = deliverApi(this.d.pi, {
                        text,
                        images,
                        delivery: msg.delivery ?? "auto",
                        asCommand,
                        idle: ctx.isIdle(),
                    });
                    if (mode === "auto" && !asCommand) {
                        this.d.notify("RP: mensaje del móvil entregado por la API; en modo Auto de gentle-pi no autoriza acciones.", "warning");
                    }
                    this.record(msg, "api");
                    this.d.sendAck({ clientMsgId: id, disposition: res.disposition, method: "api", error: null });
                    return;
                }
                if (method === "interactive") {
                    await this.waitForActiveSelects();
                    const r = await deliverInteractive(this.d.interactive(), text, msg.delivery ?? "auto");
                    if (r.ok) {
                        this.record(msg, "interactive");
                        this.d.sendAck({ clientMsgId: id, disposition: r.afterDialog ? "typed_after_dialog" : "typed", method: "interactive", error: null });
                        return;
                    }
                    lastError = "interactive_unavailable";
                    continue;
                }
                const draftUi = ctx.hasUI
                    ? {
                        getText: () => ctx.ui.getEditorText(),
                        setText: (t) => ctx.ui.setEditorText(t),
                    }
                    : undefined;
                const r = await deliverHerdr(this.d.pi, this.d.herdr?.paneId ?? null, text, draftUi);
                if (r.ok) {
                    this.record(msg, "herdr");
                    this.d.sendAck({ clientMsgId: id, disposition: "typed", method: "herdr", error: null });
                    return;
                }
                lastError = r.error;
                if (r.error === "agent_blocked") {
                    // the agent waits on a dialog: typing would be ignored; report instead of falling to api
                    this.d.sendAck({ clientMsgId: id, disposition: "rejected", method: "herdr", error: "agent_blocked" });
                    return;
                }
            }
            catch {
                if (method === "herdr")
                    lastError = "herdr_unavailable";
                else if (method === "interactive")
                    lastError = "interactive_unavailable";
                else
                    lastError = null;
            }
        }
        this.d.sendAck({ clientMsgId: id, disposition: "rejected", method: chain[chain.length - 1] ?? "api", error: lastError });
    }
    record(msg, method) {
        try {
            this.d.pi.appendEntry("rp.origin", { clientMsgId: msg.clientMsgId, deviceId: msg.deviceId ?? null, method, delivery: method });
        }
        catch {
            /* auditing must never break delivery */
        }
    }
}
