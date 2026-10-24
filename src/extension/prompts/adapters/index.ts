// Registry that resolves custom() dialogs of known tools through the broker (PLAN §8.5).
import type { Broker, OpenPrompt } from "../broker.ts";
import type { CustomDialogAdapter } from "./types.ts";
import { gentleAskUserChoice } from "./gentle-ask-user-choice.ts";
import { gentleAskUserQuestion } from "./gentle-ask-user-question.ts";
import { piAskUser } from "./pi-ask-user.ts";
import type { CustomInterceptor } from "../mirror.ts";

export type { CustomDialogAdapter } from "./types.ts";
export { gentleAskUserChoice, gentleAskUserQuestion, piAskUser };

export const BUILTIN_ADAPTERS: CustomDialogAdapter[] = [gentleAskUserChoice, gentleAskUserQuestion, piAskUser];

interface Current {
  toolCallId: string;
  args: unknown;
  adapter: CustomDialogAdapter;
}

export class AdapterRegistry implements CustomInterceptor {
  private byTool = new Map<string, CustomDialogAdapter>();
  private stack: Current[] = [];
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
