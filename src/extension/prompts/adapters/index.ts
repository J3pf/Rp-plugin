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
  private current: Current | null = null;
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

  /** tool_execution_start: both gentle tools are executionMode "sequential", so at most one is active. */
  onStart(ev: { toolCallId?: string; toolName?: string; args?: unknown }): void {
    if (!this.enabled || !ev?.toolName) return;
    const adapter = this.byTool.get(ev.toolName);
    if (!adapter || !adapter.accepts(ev.args)) return;
    this.current = { toolCallId: String(ev.toolCallId), args: ev.args, adapter };
  }

  onEnd(ev: { toolCallId?: string }): void {
    if (this.current && this.current.toolCallId === String(ev?.toolCallId)) this.current = null;
  }

  active(): boolean {
    return this.enabled && this.current !== null;
  }

  async race<T>(factory: (...a: any[]) => any, _options: unknown, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T> {
    const cur = this.current!;
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
