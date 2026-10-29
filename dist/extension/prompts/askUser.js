// rp_ask_user: our own question tool, only registered when no other ask_user*/question* tool exists (COMPATIBILIDAD P6).
import { Type } from "typebox";
import { isAskLikeTool } from "../environment.js";
import { promptContext } from "./classify.js";
export const OTHER_LABEL = "Otra respuesta…";
export function shouldRegisterAskUser(existingToolNames) {
    return !existingToolNames.some(isAskLikeTool);
}
export async function runAskUser(deps, p) {
    return promptContext.run({ category: "question", danger: "low", source: { extension: "rp", tool: "rp_ask_user" } }, async () => {
        const opts = (p.options ?? []).filter((o) => typeof o === "string" && o.length);
        if (opts.length === 0) {
            const text = await deps.askInput(p.question, "Escribe tu respuesta");
            return text === undefined ? { cancelled: true } : { cancelled: false, answer: text, custom: true };
        }
        const list = p.allowFreeText ? [...opts, OTHER_LABEL] : opts;
        const picked = await deps.askSelect(p.question, list);
        if (picked === undefined)
            return { cancelled: true };
        if (p.allowFreeText && picked === OTHER_LABEL) {
            const text = await deps.askInput(p.question, "Escribe tu respuesta");
            return text === undefined ? { cancelled: true } : { cancelled: false, answer: text, custom: true };
        }
        return { cancelled: false, answer: picked };
    });
}
export function askUserToolDefinition(getDeps) {
    return {
        name: "rp_ask_user",
        label: "Ask User (RP)",
        description: "Ask the user a question and wait for the answer. The question is shown in the terminal and sent to the user's phone; the first answer wins. Optionally give a list of options.",
        promptGuidelines: ["Use rp_ask_user when you need a decision or missing information from the user."],
        parameters: Type.Object({
            question: Type.String({ description: "The question to ask" }),
            options: Type.Optional(Type.Array(Type.String(), { description: "Closed list of options" })),
            allowFreeText: Type.Optional(Type.Boolean({ description: "Also offer a free-text answer when options are given" })),
        }),
        executionMode: "sequential",
        async execute(_id, params) {
            const deps = getDeps();
            if (!deps)
                return { content: [{ type: "text", text: "rp_ask_user is unavailable (RP not connected)" }], details: { unavailable: true } };
            const r = await runAskUser(deps, params);
            if (r.cancelled)
                return { content: [{ type: "text", text: "User cancelled the question" }], details: { cancelled: true } };
            return { content: [{ type: "text", text: `User answered: ${r.answer}` }], details: { answer: r.answer, custom: !!r.custom } };
        },
    };
}
