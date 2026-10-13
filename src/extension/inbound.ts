// Relay → plugin message routing (PLAN §9).
import type { Envelope, UserMessageBody, WelcomeBody, Answer } from "../shared/protocol.ts";

export interface InboundHandlers {
  userMessage(body: UserMessageBody): void;
  abort(): void;
  promptAnswer(promptId: string, answer: Answer, deviceId?: string): void;
  promptCancel(promptId: string): void;
  resync(): void;
  error?(code: string, message: string): void;
}

export function routeInbound(env: Envelope, h: InboundHandlers): boolean {
  const d: any = env.d ?? {};
  switch (env.t) {
    case "user.message":
      if (typeof d.clientMsgId !== "string" || typeof d.text !== "string") return false;
      h.userMessage(d as UserMessageBody);
      return true;
    case "agent.abort":
      h.abort();
      return true;
    case "prompt.answer":
      if (typeof d.promptId !== "string" || !d.answer || typeof d.answer !== "object") return false;
      h.promptAnswer(d.promptId, d.answer as Answer, d.deviceId);
      return true;
    case "prompt.cancel":
      if (typeof d.promptId !== "string") return false;
      h.promptCancel(d.promptId);
      return true;
    case "agent.resync":
      h.resync();
      return true;
    case "error":
      h.error?.(String(d.code ?? "internal"), String(d.message ?? ""));
      return true;
    default:
      return false;
  }
}

export function pendingAnswers(w: WelcomeBody): Array<{ promptId: string; answer: Answer; deviceId?: string }> {
  return Array.isArray(w?.pendingAnswers) ? w.pendingAnswers.filter((p) => p && typeof p.promptId === "string" && p.answer) : [];
}
