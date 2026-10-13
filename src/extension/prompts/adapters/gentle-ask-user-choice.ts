// gentle-pi 4.1.0 extensions/ask-user-choice.ts
//   params : { question, options:[{label,description,value}] (2..4), allowCustomResponse? }
//   result : { value, label, index /* 1-based */ } | { customResponse } | undefined (cancelled)
import type { CustomDialogAdapter } from "./types.ts";

interface ChoiceOption {
  label: string;
  description: string;
  value: string;
}
interface ChoiceArgs {
  question: string;
  options: ChoiceOption[];
  allowCustomResponse?: boolean;
}

export const gentleAskUserChoice: CustomDialogAdapter = {
  tool: "ask_user_choice",
  extension: "gentle-pi",
  accepts(args) {
    const a = args as ChoiceArgs;
    return (
      !!a &&
      typeof a.question === "string" &&
      Array.isArray(a.options) &&
      a.options.length >= 2 &&
      a.options.every((o) => o && typeof o.label === "string" && typeof o.value === "string")
    );
  },
  toPrompt(args) {
    const a = args as ChoiceArgs;
    return {
      kind: "select",
      title: a.question,
      options: a.options.map((o, i) => ({ id: String(i), label: o.label, description: o.description })),
      allowFreeText: a.allowCustomResponse === true,
      source: { extension: "gentle-pi", tool: "ask_user_choice", subagent: false },
      category: "question",
      danger: "low",
    };
  },
  toResult(args, answer) {
    const a = args as ChoiceArgs;
    const any = answer as any;
    if (any.cancelled) return undefined;
    if (Array.isArray(any.optionIds) && any.optionIds.length) {
      const idx = Number(any.optionIds[0]);
      const o = a.options[idx];
      if (Number.isInteger(idx) && o) return { value: o.value, label: o.label, index: idx + 1 };
      return undefined;
    }
    if (typeof any.text === "string" && any.text.trim() && a.allowCustomResponse === true) return { customResponse: any.text };
    return undefined;
  },
  fromResult(_args, result) {
    const r = result as any;
    if (r === undefined || r === null) return { cancelled: true };
    if (typeof r.customResponse === "string") return { text: r.customResponse };
    if (typeof r.index === "number") return { optionIds: [String(r.index - 1)] };
    return { cancelled: true };
  },
};
