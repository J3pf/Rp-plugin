import { gentleAskUserChoice } from "./gentle-ask-user-choice.js";
import { gentleAskUserQuestion } from "./gentle-ask-user-question.js";
import { piAskUser } from "./pi-ask-user.js";
import { reviewConsent } from "./review-consent.js";
export { gentleAskUserChoice, gentleAskUserQuestion, piAskUser, reviewConsent };
export const BUILTIN_ADAPTERS = [gentleAskUserChoice, gentleAskUserQuestion, piAskUser, reviewConsent];
export class AdapterRegistry {
    broker;
    byTool = new Map();
    stack = [];
    mirroredComponents = new WeakSet();
    enabled = true;
    constructor(broker, adapters = BUILTIN_ADAPTERS) {
        this.broker = broker;
        for (const a of adapters)
            this.byTool.set(a.tool, a);
    }
    register(a) {
        this.byTool.set(a.tool, a);
    }
    has(tool) {
        return this.byTool.has(tool);
    }
    /** tool_execution_start: track active adapted tool calls by toolCallId. */
    onStart(ev) {
        if (!this.enabled || !ev?.toolName)
            return;
        const adapter = this.byTool.get(ev.toolName);
        if (!adapter || !adapter.accepts(ev.args))
            return;
        const id = String(ev.toolCallId);
        const idx = this.stack.findIndex((c) => c.toolCallId === id);
        if (idx >= 0)
            this.stack.splice(idx, 1);
        this.stack.push({ toolCallId: id, args: ev.args, adapter });
    }
    onEnd(ev) {
        const id = String(ev?.toolCallId);
        const idx = this.stack.findIndex((c) => c.toolCallId === id);
        if (idx >= 0)
            this.stack.splice(idx, 1);
    }
    active() {
        return this.enabled && this.stack.length > 0;
    }
    async raceOpenedPrompt(cur, runWithPrompt) {
        let doneRef;
        let pendingResult = undefined;
        let hasPendingResult = false;
        let settled = false;
        let answeredRemotely = false;
        let prompt;
        const attachPrompt = (p) => {
            prompt = p;
            void p.remoteAnswer
                .then((answer) => {
                if (p.closed || p.cancelledBySystem || settled)
                    return;
                answeredRemotely = true;
                const result = cur.adapter.toResult(cur.args, answer);
                if (doneRef) {
                    doneRef(result);
                }
                else {
                    hasPendingResult = true;
                    pendingResult = result;
                }
                this.broker.ack(p.id, true);
            })
                .catch(() => {
                if (!p.closed) {
                    this.broker.resolved(p, "cancelled", null);
                    this.broker.close(p);
                }
            });
        };
        const deliverDone = (done) => {
            doneRef = done;
            if (hasPendingResult) {
                hasPendingResult = false;
                done(pendingResult);
            }
        };
        try {
            const value = await runWithPrompt({
                attachPrompt,
                deliverDone,
                isSettled: () => settled,
            });
            settled = true;
            if (prompt && !prompt.closed && !answeredRemotely) {
                this.broker.resolved(prompt, "local", cur.adapter.fromResult(cur.args, value));
            }
            return value;
        }
        catch (error) {
            settled = true;
            if (prompt && !prompt.closed) {
                this.broker.resolved(prompt, "cancelled", null);
            }
            throw error;
        }
        finally {
            settled = true;
            if (prompt)
                this.broker.close(prompt);
        }
    }
    // gentle-pi/lib/review-consent-ui.ts:89-97 passes done to the factory and returns the renderable component.
    async customMirror(factory, options, runOrig) {
        const cur = this.stack[this.stack.length - 1];
        const fromComponent = cur.adapter.fromComponent;
        // The existing args-driven adapters continue through the original race path unchanged.
        if (!fromComponent)
            return this.race(factory, options, runOrig);
        return this.raceOpenedPrompt(cur, ({ attachPrompt, deliverDone, isSettled }) => {
            let doneCalled = false;
            const wrapped = (tui, theme, kb, done) => {
                const capturedDone = (value) => {
                    doneCalled = true;
                    return done(value);
                };
                deliverDone(capturedDone);
                const component = factory(tui, theme, kb, capturedDone);
                if (!component || typeof component !== "object")
                    return component;
                if (this.mirroredComponents.has(component))
                    return component;
                this.mirroredComponents.add(component);
                if (doneCalled || isSettled())
                    return component;
                try {
                    const spec = fromComponent(component);
                    if (spec)
                        attachPrompt(this.broker.openSpec(spec));
                }
                catch {
                    // Shape drift must leave custom() in control without a partial broker prompt.
                }
                return component;
            };
            return runOrig(wrapped);
        });
    }
    async race(factory, _options, runOrig) {
        const cur = this.stack[this.stack.length - 1];
        return this.raceOpenedPrompt(cur, ({ attachPrompt, deliverDone }) => {
            const wrapped = (tui, theme, kb, done) => {
                deliverDone(done);
                return factory(tui, theme, kb, done);
            };
            attachPrompt(this.broker.openSpec(cur.adapter.toPrompt(cur.args)));
            return runOrig(wrapped);
        });
    }
}
