// "First answer wins": terminal dialog vs. phone answer (PLAN §8.2).
import { newId } from "../../shared/protocol.js";
export function withSignal(opts, extra) {
    const signal = opts?.signal ? AbortSignal.any([opts.signal, extra]) : extra;
    return { ...(opts ?? {}), signal };
}
export class Broker {
    d;
    prompts = new Map();
    constructor(d) {
        this.d = d;
    }
    get openCount() {
        return this.prompts.size;
    }
    /** Bodies of currently open prompts, for agent.hello.openPrompts. */
    openPrompts() {
        return [...this.prompts.values()].map((p) => p.body);
    }
    /** Whether any prompt originated from an adapter (suppresses the "waiting on terminal" notice for its custom() dialog). */
    hasAdapterPrompt() {
        for (const p of this.prompts.values())
            if (p.isAdapter)
                return true;
        return false;
    }
    build(req) {
        const message = req.kind === "confirm" ? req.message : undefined;
        const cls = this.d.classifier.classifyDialog(req.kind, req.title, message);
        const redact = !!this.d.redact?.();
        let options;
        if (req.kind === "select") {
            const keepLabels = cls.source?.tool === "gate" || cls.source?.tool === "agy-gate";
            options = req.options.map((label, i) => ({
                id: String(i),
                label: redact && !keepLabels ? `[option ${i + 1}]` : label,
            }));
        }
        else if (req.kind === "confirm") {
            const perm = cls.category === "permission";
            options = [
                { id: "yes", label: perm ? "Permitir" : "Sí" },
                { id: "no", label: perm ? "Denegar" : "No" },
            ];
        }
        const expiresAt = req.opts?.timeout ? (this.d.now ?? Date.now)() + req.opts.timeout : null;
        const rawMsg = cls.message ?? message;
        const title = redact
            ? (cls.tool ? `⚠ ${cls.tool.name}: [redacted]` : "[redacted]")
            : req.title;
        return {
            cls,
            body: {
                kind: req.kind,
                category: cls.category,
                title,
                message: redact && rawMsg ? "[redacted]" : rawMsg,
                options,
                allowFreeText: req.kind === "input" || (req.kind === "select" && !!req.allowFreeText),
                placeholder: req.kind === "input" ? (redact && req.placeholder ? "[redacted]" : (req.placeholder ?? null)) : null,
                questions: null,
                source: cls.source,
                tool: cls.tool ? (redact && cls.tool.args ? { ...cls.tool, args: { redacted: true } } : cls.tool) : undefined,
                danger: cls.danger,
                expiresAt,
            },
        };
    }
    register(body, req, herdrReported, isAdapter = false, hasLocalUi = false) {
        let resolveRemote;
        const remoteAnswer = new Promise((r) => (resolveRemote = r));
        const p = {
            id: body.promptId,
            body,
            req,
            isAdapter,
            hasLocalUi,
            closed: false,
            answered: false,
            remoteAnswer,
            resolveRemote,
            openedAt: (this.d.now ?? Date.now)(),
        };
        this.prompts.set(p.id, p);
        this.d.send("prompt.open", body);
        this.d.herdr?.block(p.id, body.title, herdrReported);
        this.d.onChange?.(this.prompts.size);
        return p;
    }
    open(req, hasLocalUi = false) {
        const { body, cls } = this.build(req);
        return this.register({ promptId: newId(), agentId: this.d.agentId, ...body }, req, cls.herdrReported, false, hasLocalUi);
    }
    /** Open a prompt described by an adapter (custom() dialogs). */
    openSpec(spec, hasLocalUi = true) {
        const redact = !!this.d.redact?.();
        const sanitizeOptions = (opts) => redact && opts
            ? opts.map(({ preview: _p, description: _d, ...rest }, i) => ({
                ...rest,
                label: `[option ${i + 1}]`,
            }))
            : opts;
        const body = {
            promptId: newId(),
            agentId: this.d.agentId,
            kind: spec.kind,
            category: spec.category ?? "question",
            title: redact ? "[redacted]" : spec.title,
            message: redact && spec.message ? "[redacted]" : spec.message,
            options: sanitizeOptions(spec.options),
            allowFreeText: !!spec.allowFreeText,
            placeholder: null,
            questions: spec.questions
                ? spec.questions.map((q, qi) => ({
                    ...q,
                    question: redact ? `[question ${qi + 1}]` : q.question,
                    header: redact && q.header ? "[redacted]" : q.header,
                    options: sanitizeOptions(q.options) ?? [],
                }))
                : null,
            source: spec.source,
            danger: spec.danger ?? "low",
            expiresAt: null,
        };
        const herdrReported = spec.herdrReported ?? (spec.source?.extension !== "@eko24ive/pi-ask");
        return this.register(body, null, herdrReported, true, hasLocalUi);
    }
    close(p) {
        if (p.closed)
            return;
        p.closed = true;
        this.prompts.delete(p.id);
        this.d.herdr?.unblock(p.id);
        this.d.onChange?.(this.prompts.size);
    }
    resolved(p, by, answer) {
        let safeAnswer = answer;
        if (safeAnswer && this.d.redact?.()) {
            const any = safeAnswer;
            if (typeof any.text === "string")
                safeAnswer = { ...any, text: "[redacted]" };
            else if (Array.isArray(any.answers)) {
                safeAnswer = {
                    ...any,
                    answers: any.answers.map((a) => (typeof a?.text === "string" ? { ...a, text: "[redacted]" } : a)),
                };
            }
        }
        this.d.send("prompt.resolved", { promptId: p.id, by, answer: safeAnswer });
    }
    ack(promptId, accepted) {
        this.d.send("prompt.ack", { promptId, accepted });
    }
    /** Relay → plugin: prompt.answer. Always replies with prompt.ack. */
    handleAnswer(promptId, answer) {
        const p = this.prompts.get(promptId);
        if (!p || p.closed || p.answered) {
            this.ack(promptId, false);
            return false;
        }
        p.answered = true;
        p.resolveRemote(answer);
        return true;
    }
    /** Relay → plugin: prompt.cancel (expired by the relay). */
    handleCancel(promptId) {
        const p = this.prompts.get(promptId);
        if (p && !p.answered) {
            p.answered = true;
            p.cancelledBySystem = true;
            if (p.hasLocalUi) {
                // Retire only the mobile mirror so an active local PC dialog stays open for the user.
                this.close(p);
            }
            else {
                p.resolveRemote({ cancelled: true });
            }
        }
    }
    /**
     * Race the local dialog against the phone. `runLocal` is null when there is no local UI
     * (json/print modes): then only the phone can answer.
     */
    async race(req, runLocal) {
        const p = this.open(req, runLocal !== null);
        const ac = new AbortController();
        const started = (this.d.now ?? Date.now)();
        const timeoutMs = req.opts?.timeout;
        const callerSignal = req.opts?.signal;
        const racers = [p.remoteAnswer.then((a) => ({ src: "remote", a }))];
        let timer;
        let onAbort;
        if (runLocal) {
            racers.push(runLocal(ac.signal).then((v) => ({ src: "local", v })));
        }
        else {
            // headless: Pi's own timeout/signal never fire for us, so honor them here
            if (timeoutMs) {
                racers.push(new Promise((r) => {
                    timer = setTimeout(() => r({ src: "timeout" }), timeoutMs);
                    timer.unref?.();
                }));
            }
            if (callerSignal) {
                racers.push(new Promise((r) => {
                    if (callerSignal.aborted)
                        r({ src: "cancelled" });
                    else {
                        onAbort = () => r({ src: "cancelled" });
                        callerSignal.addEventListener("abort", onAbort, { once: true });
                    }
                }));
            }
        }
        let w;
        try {
            w = await Promise.race(racers);
        }
        catch (e) {
            if (!p.closed)
                this.resolved(p, "cancelled", null);
            this.close(p);
            throw e;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (callerSignal && onAbort)
                callerSignal.removeEventListener("abort", onAbort);
        }
        if (w.src === "remote") {
            ac.abort();
            if (!p.cancelledBySystem)
                this.ack(p.id, true);
            this.close(p);
            return toLocalValue(req, w.a);
        }
        if (w.src === "timeout") {
            if (!p.closed)
                this.resolved(p, "timeout", null);
            this.close(p);
            return emptyValue(req);
        }
        if (w.src === "cancelled") {
            if (!p.closed)
                this.resolved(p, "cancelled", null);
            this.close(p);
            return emptyValue(req);
        }
        // local answer
        const v = w.v;
        let by = "local";
        if (callerSignal?.aborted)
            by = "cancelled";
        else if (timeoutMs && (v === undefined || v === false) && (this.d.now ?? Date.now)() - started >= timeoutMs - 50)
            by = "timeout";
        if (!p.closed)
            this.resolved(p, by, by === "local" ? fromLocal(req, v) : null);
        this.close(p);
        return v;
    }
    /** Close everything on shutdown: the relay cancels orphaned prompts after 2 min, but tell it now. */
    shutdown(opts = {}) {
        for (const p of [...this.prompts.values()]) {
            this.resolved(p, "cancelled", null);
            p.answered = true;
            p.cancelledBySystem = true;
            if (!(opts.keepLocal && p.hasLocalUi)) {
                p.resolveRemote({ cancelled: true });
            }
            this.close(p);
        }
    }
}
export function emptyValue(req) {
    return req.kind === "confirm" ? false : undefined;
}
/** Phone Answer → value expected by the Pi dialog caller. select returns the exact option label. */
export function toLocalValue(req, a) {
    const any = a;
    if (any.cancelled)
        return emptyValue(req);
    if (req.kind === "select") {
        if (Array.isArray(any.optionIds) && any.optionIds.length) {
            const idx = Number(any.optionIds[0]);
            return Number.isInteger(idx) && idx >= 0 && idx < req.options.length ? req.options[idx] : undefined;
        }
        if (typeof any.text === "string") {
            return req.allowFreeText || req.options.includes(any.text) ? any.text : undefined;
        }
        return undefined;
    }
    if (req.kind === "confirm") {
        if (typeof any.confirmed === "boolean")
            return any.confirmed;
        if (Array.isArray(any.optionIds))
            return any.optionIds[0] === "yes";
        return false;
    }
    if (typeof any.text === "string")
        return any.text;
    return undefined;
}
/** Local value → Answer for prompt.resolved. */
export function fromLocal(req, v) {
    if (req.kind === "select") {
        if (v === undefined)
            return { cancelled: true };
        const i = req.options.indexOf(v);
        return i >= 0 ? { optionIds: [String(i)] } : { text: String(v) };
    }
    if (req.kind === "confirm")
        return { confirmed: !!v };
    return v === undefined ? { cancelled: true } : { text: String(v) };
}
