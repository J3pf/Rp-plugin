// gentle-pi 4.1.0 extensions/ask-user-question.ts + lib/questionnaire/{schema,questionnaire-view}.ts
//   params : { questions:[{ question, header, options:[{label,description,preview?}] (2..4), multiSelect? }] (1..4) }
//   result : QuestionnaireResult { cancelled, answers: AnswerRow[] }
//   AnswerRow { questionIndex, question, kind:"option"|"custom"|"multi", answer:string|null, selected?:string[], preview? }
// The view always offers a free-text "Type something." row, so every question allows free text.
import type { Answer } from "../../../shared/protocol.ts";
import type { CustomDialogAdapter } from "./types.ts";

interface QOption {
  label: string;
  description: string;
  preview?: string;
}
interface Question {
  question: string;
  header: string;
  options: QOption[];
  multiSelect?: boolean;
}
interface QArgs {
  questions: Question[];
}
interface AnswerRow {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  preview?: string;
}

export const gentleAskUserQuestion: CustomDialogAdapter = {
  tool: "ask_user_question",
  extension: "gentle-pi",
  accepts(args) {
    const a = args as QArgs;
    return (
      !!a &&
      Array.isArray(a.questions) &&
      a.questions.length >= 1 &&
      a.questions.length <= 4 &&
      a.questions.every((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.every((o) => o && typeof o.label === "string"))
    );
  },
  toPrompt(args) {
    const a = args as QArgs;
    const first = a.questions[0]!;
    return {
      kind: "questionnaire",
      title: a.questions.length === 1 ? first.question : `${a.questions.length} preguntas`,
      questions: a.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect === true,
        allowFreeText: true,
        options: q.options.map((o, i) => ({ id: String(i), label: o.label, description: o.description, preview: o.preview })),
      })),
      source: { extension: "gentle-pi", tool: "ask_user_question", subagent: false },
      category: "question",
      danger: "low",
    };
  },
  toResult(args, answer) {
    const a = args as QArgs;
    const any = answer as any;
    if (any.cancelled || !Array.isArray(any.answers)) return { cancelled: true, answers: [] };
    const rows: AnswerRow[] = [];
    for (const item of any.answers as Array<{ questionIndex: number; optionIds?: string[]; text?: string }>) {
      const q = a.questions[item.questionIndex];
      if (!q) continue;
      const picked = (item.optionIds ?? []).map((id) => q.options[Number(id)]).filter((o): o is QOption => !!o);
      const text = typeof item.text === "string" && item.text.trim() ? item.text : undefined;
      if (q.multiSelect) {
        const selected = picked.map((o) => o.label);
        if (text !== undefined) rows.push({ questionIndex: item.questionIndex, question: q.question, kind: "custom", answer: text, selected });
        else rows.push({ questionIndex: item.questionIndex, question: q.question, kind: "multi", answer: null, selected });
      } else if (text !== undefined) {
        rows.push({ questionIndex: item.questionIndex, question: q.question, kind: "custom", answer: text });
      } else if (picked[0]) {
        rows.push({
          questionIndex: item.questionIndex,
          question: q.question,
          kind: "option",
          answer: picked[0].label,
          ...(picked[0].preview !== undefined ? { preview: picked[0].preview } : {}),
        });
      }
    }
    rows.sort((x, y) => x.questionIndex - y.questionIndex);
    // every question must be answered, otherwise treat as cancelled (never commit a partial questionnaire silently)
    if (rows.length !== a.questions.length) return { cancelled: true, answers: [] };
    return { cancelled: false, answers: rows };
  },
  fromResult(args, result): Answer {
    const r = result as { cancelled?: boolean; answers?: AnswerRow[] } | undefined;
    if (!r || r.cancelled || !Array.isArray(r.answers)) return { cancelled: true };
    const a = args as QArgs;
    return {
      answers: r.answers.map((row) => {
        const q = a.questions[row.questionIndex];
        if (row.kind === "custom") return { questionIndex: row.questionIndex, text: row.answer ?? "" };
        const labels = row.kind === "multi" ? (row.selected ?? []) : row.answer ? [row.answer] : [];
        const ids = labels.map((l) => String(q?.options.findIndex((o) => o.label === l) ?? -1)).filter((id) => id !== "-1");
        return { questionIndex: row.questionIndex, optionIds: ids };
      }),
    };
  },
};
