// Test-only Pi extension: registers a scripted fake model so a REAL Pi TUI can run without any API.
// FAUX_SCRIPT points to a JSON array consumed one entry per model request:
//   { "text": "..." }                       → plain assistant message
//   { "tool": "bash", "args": {...} }       → one tool call
// FAUX_LOG receives one JSON line per request with the step and the text of the last message
// (so tests can assert what the model saw, e.g. a tool result).
import fs from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function lastText(ctx: any): string {
  const m = ctx?.messages?.at?.(-1);
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((b: any) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
}

export default function fauxExt(pi: any) {
  const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false }] });
  const respond = (ctx: any, _opts: any, state: any) => {
    const file = process.env.FAUX_SCRIPT;
    const script: any[] = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const step = script[state.callCount - 1] ?? { text: "(script exhausted)" };
    if (process.env.FAUX_LOG) fs.appendFileSync(process.env.FAUX_LOG, JSON.stringify({ call: state.callCount, step, lastMessage: lastText(ctx), role: ctx?.messages?.at?.(-1)?.role }) + "\n");
    if (step.tool) return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})]);
    return fauxAssistantMessage(step.text ?? "ok");
  };
  faux.setResponses(Array.from({ length: 60 }, () => respond));
  pi.registerProvider(faux.provider);
}
