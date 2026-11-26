// gentle-pi 4.1.0 extensions/ask-user-choice.ts
//   params : { question, options:[{label,description,value}] (2..4), allowCustomResponse? }
//   result : { value, label, index /* 1-based */ } | { customResponse } | undefined (cancelled)
// gentle-pi 5.0.0 keeps both shapes and flips the free-text default: the "Type your answer" row is
// offered unless `allowCustomResponse` is false (4.x required true). `caps.freeTextByDefault` carries that.
import { parseOptionIndex } from "../broker.js";
import { DEFAULT_ADAPTER_CAPS } from "./types.js";
/** Mirrors the default the loaded gentle-pi applies for the free-text row. */
function freeTextAllowed(a, caps) {
    return caps.freeTextByDefault ? a.allowCustomResponse !== false : a.allowCustomResponse === true;
}
export const gentleAskUserChoice = {
    tool: "ask_user_choice",
    extension: "gentle-pi",
    accepts(args) {
        const a = args;
        return (!!a &&
            typeof a.question === "string" &&
            Array.isArray(a.options) &&
            a.options.length >= 2 &&
            a.options.every((o) => o && typeof o.label === "string" && typeof o.value === "string"));
    },
    toPrompt(args, caps = DEFAULT_ADAPTER_CAPS) {
        const a = args;
        return {
            kind: "select",
            title: a.question,
            options: a.options.map((o, i) => ({ id: String(i), label: o.label, description: o.description })),
            allowFreeText: freeTextAllowed(a, caps),
            source: { extension: "gentle-pi", tool: "ask_user_choice", subagent: false },
            category: "question",
            danger: "low",
        };
    },
    toResult(args, answer, caps = DEFAULT_ADAPTER_CAPS) {
        const a = args;
        const any = answer;
        if (any.cancelled)
            return undefined;
        if (Array.isArray(any.optionIds) && any.optionIds.length) {
            const idx = parseOptionIndex(any.optionIds[0]);
            const o = idx >= 0 ? a.options[idx] : undefined;
            if (o)
                return { value: o.value, label: o.label, index: idx + 1 };
            return undefined;
        }
        if (typeof any.text === "string" && any.text.trim() && freeTextAllowed(a, caps))
            return { customResponse: any.text };
        return undefined;
    },
    fromResult(_args, result) {
        const r = result;
        if (r === undefined || r === null)
            return { cancelled: true };
        if (typeof r.customResponse === "string")
            return { text: r.customResponse };
        if (typeof r.index === "number")
            return { optionIds: [String(r.index - 1)] };
        return { cancelled: true };
    },
};
