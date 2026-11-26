// Registry that resolves custom() dialogs of known tools through the broker (PLAN §8.5).
import type { Broker, OpenPrompt } from "../broker.ts";
import type { AdapterCaps, CustomDialogAdapter } from "./types.ts";
import { DEFAULT_ADAPTER_CAPS } from "./types.ts";
import { gentleAskUserChoice } from "./gentle-ask-user-choice.ts";
import { gentleAskUserQuestion } from "./gentle-ask-user-question.ts";
import { piAskUser } from "./pi-ask-user.ts";
import { reviewConsent } from "./review-consent.ts";
import type { CustomInterceptor } from "../mirror.ts";

export type { AdapterCaps, ComponentDialogAdapter, CustomDialogAdapter } from "./types.ts";
export { DEFAULT_ADAPTER_CAPS } from "./types.ts";
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
  /** Version-dependent behavior of the loaded gentle-pi; the runtime sets it from the detected version. */
  caps: AdapterCaps = { ...DEFAULT_ADAPTER_CAPS };

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

  private async raceOpenedPrompt<T>(
    cur: Current,
    runWithPrompt: (opts: {
      attachPrompt: (prompt: OpenPrompt) => void;
      deliverDone: (done: (value: unknown) => void) => void;
      isSettled: () => boolean;
    }) => Promise<T>,
  ): Promise<T> {
    let doneRef: ((v: unknown) => void) | undefined;
    let pendingResult: unknown = undefined;
    let hasPendingResult = false;
    let settled = false;
    let answeredRemotely = false;
    let prompt: OpenPrompt | undefined;

    const attachPrompt = (p: OpenPrompt) => {
      prompt = p;
      void p.remoteAnswer
        .then((answer) => {
          if (p.closed || p.cancelledBySystem || settled) return;
          answeredRemotely = true;
          const result = cur.adapter.toResult(cur.args, answer);
          if (doneRef) {
            doneRef(result);
          } else {
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

    const deliverDone = (done: (value: unknown) => void) => {
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
        this.broker.resolved(prompt, "local", cur.adapter.fromResult(cur.args, value, this.caps));
      }
      return value;
    } catch (error) {
      settled = true;
      if (prompt && !prompt.closed) {
        this.broker.resolved(prompt, "cancelled", null);
      }
      throw error;
    } finally {
      settled = true;
      if (prompt) this.broker.close(prompt);
    }
  }

  // gentle-pi/lib/review-consent-ui.ts:89-97 passes done to the factory and returns the renderable component.
  async customMirror<T>(factory: (...a: any[]) => any, options: unknown, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T> {
    const cur = this.stack[this.stack.length - 1]!;
    const fromComponent = cur.adapter.fromComponent;
    // The existing args-driven adapters continue through the original race path unchanged.
    if (!fromComponent) return this.race(factory, options, runOrig);

    return this.raceOpenedPrompt(cur, ({ attachPrompt, deliverDone, isSettled }) => {
      let doneCalled = false;
      const wrapped = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => {
        const capturedDone = (value: unknown) => {
          doneCalled = true;
          return done(value);
        };
        deliverDone(capturedDone);
        const component = factory(tui, theme, kb, capturedDone);
        if (!component || typeof component !== "object") return component;
        if (this.mirroredComponents.has(component)) return component;
        this.mirroredComponents.add(component);
        if (doneCalled || isSettled()) return component;
        try {
          const spec = fromComponent(component);
          if (spec) attachPrompt(this.broker.openSpec(spec));
        } catch {
          // Shape drift must leave custom() in control without a partial broker prompt.
        }
        return component;
      };
      return runOrig(wrapped as any);
    });
  }

  async race<T>(factory: (...a: any[]) => any, _options: unknown, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T> {
    const cur = this.stack[this.stack.length - 1]!;
    return this.raceOpenedPrompt(cur, ({ attachPrompt, deliverDone }) => {
      const wrapped = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => {
        deliverDone(done);
        return factory(tui, theme, kb, done);
      };
      attachPrompt(this.broker.openSpec(cur.adapter.toPrompt(cur.args, this.caps)));
      return runOrig(wrapped as any);
    });
  }
}
