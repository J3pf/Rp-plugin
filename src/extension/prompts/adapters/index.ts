// Registry that resolves custom() dialogs of known tools through the broker (PLAN §8.5).
import type { Broker, OpenPrompt } from "../broker.ts";
import type { CustomDialogAdapter } from "./types.ts";
import { gentleAskUserChoice } from "./gentle-ask-user-choice.ts";
import { gentleAskUserQuestion } from "./gentle-ask-user-question.ts";
import { piAskUser } from "./pi-ask-user.ts";
import { reviewConsent } from "./review-consent.ts";
import type { CustomInterceptor } from "../mirror.ts";

export type { ComponentDialogAdapter, CustomDialogAdapter } from "./types.ts";
export { gentleAskUserChoice, gentleAskUserQuestion, piAskUser, reviewConsent };

export const BUILTIN_ADAPTERS: CustomDialogAdapter[] = [gentleAskUserChoice, gentleAskUserQuestion, piAskUser, reviewConsent];

interface Current {
  toolCallId: string;
  args: unknown;
  adapter: CustomDialogAdapter;
}

export class AdapterRegistry implements CustomInterceptor {
  private byTool = new Map<string, CustomDialogAdapter>();
  private stack: Current[] = [];
  private mirroredComponents = new WeakSet<object>();
  enabled = true;

  constructor(private broker: Broker, adapters: CustomDialogAdapter[] = BUILTIN_ADAPTERS) {
    for (const a of adapters) this.byTool.set(a.tool, a);
  }

  register(a: CustomDialogAdapter): void {
    this.byTool.set(a.tool, a);
  }

  has(tool: string): boolean {
    return this.byTool.has(tool);
  }

  /** tool_execution_start: track active adapted tool calls by toolCallId. */
  onStart(ev: { toolCallId?: string; toolName?: string; args?: unknown }): void {
    if (!this.enabled || !ev?.toolName) return;
    const adapter = this.byTool.get(ev.toolName);
    if (!adapter || !adapter.accepts(ev.args)) return;
    const id = String(ev.toolCallId);
    const idx = this.stack.findIndex((c) => c.toolCallId === id);
    if (idx >= 0) this.stack.splice(idx, 1);
    this.stack.push({ toolCallId: id, args: ev.args, adapter });
  }

  onEnd(ev: { toolCallId?: string }): void {
    const id = String(ev?.toolCallId);
    const idx = this.stack.findIndex((c) => c.toolCallId === id);
    if (idx >= 0) this.stack.splice(idx, 1);
  }

  active(): boolean {
    return this.enabled && this.stack.length > 0;
  }

  // gentle-pi/lib/review-consent-ui.ts:89-97 passes done to the factory and returns the renderable component.
  async customMirror<T>(factory: (...a: any[]) => any, options: unknown, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T> {
    const cur = this.stack[this.stack.length - 1]!;
    const fromComponent = cur.adapter.fromComponent;
    // The existing args-driven adapters continue through the original race path unchanged.
    if (!fromComponent) return this.race(factory, options, runOrig);

    let doneRef: ((v: unknown) => void) | undefined;
    let doneCalled = false;
    let p: OpenPrompt | undefined;
    const wrapped = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => {
      const capturedDone = (value: unknown) => {
        doneCalled = true;
        return done(value);
      };
      doneRef = capturedDone;
      const component = factory(tui, theme, kb, capturedDone);
      if (!component || typeof component !== "object") return component;
      if (this.mirroredComponents.has(component)) return component;
      this.mirroredComponents.add(component);
      if (doneCalled) return component;
      try {
        const spec = fromComponent(component);
        if (spec) p = this.broker.openSpec(spec);
      } catch {
        // Shape drift must leave custom() in control without a partial broker prompt.
      }
      return component;
    };

    let localPromise: Promise<T>;
    try {
      localPromise = Promise.resolve(runOrig(wrapped as any));
    } catch (error) {
      if (p) {
        this.broker.resolved(p, "cancelled", null);
        this.broker.close(p);
      }
      throw error;
    }
    if (!p) return await localPromise;

    let answeredRemotely = false;
    const prompt = p;
    void prompt.remoteAnswer.then((answer) => {
      if (prompt.closed && !prompt.cancelledBySystem) return;
      answeredRemotely = true;
      const result = cur.adapter.toResult(cur.args, answer);
      doneRef?.(result);
      if (!prompt.cancelledBySystem) this.broker.ack(prompt.id, true);
    });

    try {
      const value = await localPromise;
      if (!prompt.closed && !answeredRemotely) this.broker.resolved(prompt, "local", cur.adapter.fromResult(cur.args, value));
      return value;
    } catch (error) {
      if (!prompt.closed) this.broker.resolved(prompt, "cancelled", null);
      throw error;
    } finally {
      this.broker.close(prompt);
    }
  }

  async race<T>(factory: (...a: any[]) => any, _options: unknown, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T> {
    const cur = this.stack[this.stack.length - 1]!;
    let doneRef: ((v: unknown) => void) | undefined;
    let pendingResult: unknown = undefined;
    let hasPendingResult = false;
    const wrapped = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => {
      doneRef = done;
      if (hasPendingResult) {
        done(pendingResult);
      }
      return factory(tui, theme, kb, done);
    };
    const p: OpenPrompt = this.broker.openSpec(cur.adapter.toPrompt(cur.args));
    let answeredRemotely = false;
    void p.remoteAnswer.then((a) => {
      if (p.closed && !p.cancelledBySystem) return;
      answeredRemotely = true;
      const res = cur.adapter.toResult(cur.args, a);
      if (doneRef) {
        doneRef(res);
      } else {
        hasPendingResult = true;
        pendingResult = res;
      }
      if (!p.cancelledBySystem) this.broker.ack(p.id, true);
    });
    try {
      const v = await runOrig(wrapped as any);
      if (!p.closed && !answeredRemotely) this.broker.resolved(p, "local", cur.adapter.fromResult(cur.args, v));
      return v;
    } catch (e) {
      if (!p.closed) this.broker.resolved(p, "cancelled", null);
      throw e;
    } finally {
      this.broker.close(p);
    }
  }
}
