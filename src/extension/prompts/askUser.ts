// rp_ask_user: our own question tool, only registered when no other ask_user*/question* tool exists (COMPATIBILIDAD P6).
import { Type } from "typebox";
import { isAskLikeTool } from "../environment.ts";
import { promptContext } from "./classify.ts";

export const OTHER_LABEL = "Otra respuesta…";

export function shouldRegisterAskUser(existingToolNames: string[]): boolean {
  return !existingToolNames.some(isAskLikeTool);
}

export interface AskUserDeps {
  askSelect(title: string, options: string[]): Promise<string | undefined>;
  askInput(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface AskUserParams {
  question: string;
  options?: string[];
  allowFreeText?: boolean;
}

export async function runAskUser(deps: AskUserDeps, p: AskUserParams): Promise<{ answer?: string; cancelled: boolean; custom?: boolean }> {
  return promptContext.run({ category: "question", danger: "low", source: { extension: "rp", tool: "rp_ask_user" } }, async () => {
    const opts = (p.options ?? []).filter((o) => typeof o === "string" && o.length);
    if (opts.length === 0) {
      const text = await deps.askInput(p.question, "Escribe tu respuesta");
      return text === undefined ? { cancelled: true } : { cancelled: false, answer: text, custom: true };
    }
    const list = p.allowFreeText ? [...opts, OTHER_LABEL] : opts;
    const picked = await deps.askSelect(p.question, list);
    if (picked === undefined) return { cancelled: true };
    if (p.allowFreeText && picked === OTHER_LABEL) {
      const text = await deps.askInput(p.question, "Escribe tu respuesta");
      return text === undefined ? { cancelled: true } : { cancelled: false, answer: text, custom: true };
    }
    return { cancelled: false, answer: picked };
  });
}

export function askUserToolDefinition(getDeps: () => AskUserDeps | null) {
  return {
    name: "rp_ask_user",
    label: "Ask User (RP)",
    description:
      "Ask the user a question and wait for the answer. The question is shown in the terminal and sent to the user's phone; the first answer wins. Optionally give a list of options.",
    promptGuidelines: ["Use rp_ask_user when you need a decision or missing information from the user."],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Closed list of options" })),
      allowFreeText: Type.Optional(Type.Boolean({ description: "Also offer a free-text answer when options are given" })),
    }),
    executionMode: "sequential" as const,
    async execute(_id: string, params: AskUserParams) {
      const deps = getDeps();
      if (!deps) return { content: [{ type: "text" as const, text: "rp_ask_user is unavailable (RP not connected)" }], details: { unavailable: true } };
      const r = await runAskUser(deps, params);
      if (r.cancelled) return { content: [{ type: "text" as const, text: "User cancelled the question" }], details: { cancelled: true } };
      return { content: [{ type: "text" as const, text: `User answered: ${r.answer}` }], details: { answer: r.answer, custom: !!r.custom } };
    },
  };
}
