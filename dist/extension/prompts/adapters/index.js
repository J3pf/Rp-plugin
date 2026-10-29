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
    // gentle-pi/lib/review-consent-ui.ts:89-97 passes done to the factory and returns the renderable component.
    async customMirror(factory, options, runOrig) {
        const cur = this.stack[this.stack.length - 1];
        const fromComponent = cur.adapter.fromComponent;
        // The existing args-driven adapters continue through the original race path unchanged.
        if (!fromComponent)
            return this.race(factory, options, runOrig);
        let doneRef;
        let doneCalled = false;
        let p;
        const wrapped = (tui, theme, kb, done) => {
            const capturedDone = (value) => {
                doneCalled = true;
                return done(value);
            };
            doneRef = capturedDone;
            const component = factory(tui, theme, kb, capturedDone);
            if (!component || typeof component !== "object")
                return component;
            if (this.mirroredComponents.has(component))
                return component;
            this.mirroredComponents.add(component);
            if (doneCalled)
                return component;
            try {
                const spec = fromComponent(component);
                if (spec)
                    p = this.broker.openSpec(spec);
            }
            catch {
                // Shape drift must leave custom() in control without a partial broker prompt.
            }
            return component;
        };
        let localPromise;
        try {
            localPromise = Promise.resolve(runOrig(wrapped));
        }
        catch (error) {
            if (p) {
                this.broker.resolved(p, "cancelled", null);
                this.broker.close(p);
            }
            throw error;
        }
        if (!p)
            return await localPromise;
        let answeredRemotely = false;
        const prompt = p;
        void prompt.remoteAnswer.then((answer) => {
            if (prompt.closed && !prompt.cancelledBySystem)
                return;
            answeredRemotely = true;
            const result = cur.adapter.toResult(cur.args, answer);
            doneRef?.(result);
            if (!prompt.cancelledBySystem)
                this.broker.ack(prompt.id, true);
        });
        try {
            const value = await localPromise;
            if (!prompt.closed && !answeredRemotely)
                this.broker.resolved(prompt, "local", cur.adapter.fromResult(cur.args, value));
            return value;
        }
        catch (error) {
            if (!prompt.closed)
                this.broker.resolved(prompt, "cancelled", null);
            throw error;
        }
        finally {
            this.broker.close(prompt);
        }
    }
    async race(factory, _options, runOrig) {
        const cur = this.stack[this.stack.length - 1];
        let doneRef;
        let pendingResult = undefined;
        let hasPendingResult = false;
        const wrapped = (tui, theme, kb, done) => {
            doneRef = done;
            if (hasPendingResult) {
                done(pendingResult);
            }
            return factory(tui, theme, kb, done);
        };
        const p = this.broker.openSpec(cur.adapter.toPrompt(cur.args));
        let answeredRemotely = false;
        void p.remoteAnswer.then((a) => {
            if (p.closed && !p.cancelledBySystem)
                return;
            answeredRemotely = true;
            const res = cur.adapter.toResult(cur.args, a);
            if (doneRef) {
                doneRef(res);
            }
            else {
                hasPendingResult = true;
                pendingResult = res;
            }
            if (!p.cancelledBySystem)
                this.broker.ack(p.id, true);
        });
        try {
            const v = await runOrig(wrapped);
            if (!p.closed && !answeredRemotely)
                this.broker.resolved(p, "local", cur.adapter.fromResult(cur.args, v));
            return v;
        }
        catch (e) {
            if (!p.closed)
                this.broker.resolved(p, "cancelled", null);
            throw e;
        }
        finally {
            this.broker.close(p);
        }
    }
}
