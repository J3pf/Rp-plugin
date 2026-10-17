// @eko24ive/pi-ask 1.x ask_user tool adapter
// Maps pi-ask's ask_user interactive custom() dialog to remote mobile questionnaires and back.
import type { Answer } from "../../../shared/protocol.ts";
import type { CustomDialogAdapter } from "./types.ts";

interface AskOption {
  label: string;
  value?: string;
  description?: string;
  preview?: string;
}

interface AskQuestionInput {
  id: string;
  prompt: string;
  label?: string;
  type?: "single" | "multi" | "preview";
  options: AskOption[];
}

interface AskParams {
  title?: string;
  questions: AskQuestionInput[];
}

interface AskResultAnswer {
  values: string[];
  labels: string[];
  indices: number[];
  customText?: string;
}

interface AskQuestionSummary {
  id: string;
  label: string;
  prompt: string;
  type: string;
}

interface AskResult {
  cancelled: boolean;
  mode: "submit" | "elaborate";
  title?: string;
  questions: AskQuestionSummary[];
  answers: Record<string, AskResultAnswer>;
}

export const piAskUser: CustomDialogAdapter = {
  tool: "ask_user",
  extension: "@eko24ive/pi-ask",

  accepts(args): boolean {
    const a = args as AskParams;
    if (
      !a ||
      !Array.isArray(a.questions) ||
      a.questions.length < 1 ||
      a.questions.length > 4 ||
      !a.questions.every(
        (q) =>
          q &&
          typeof q.id === "string" &&
          q.id.trim().length > 0 &&
          typeof q.prompt === "string" &&
          Array.isArray(q.options) &&
          q.options.every((o) => o && typeof o.label === "string"),
      )
    ) {
      return false;
    }
    return new Set(a.questions.map((q) => q.id)).size === a.questions.length;
  },

  toPrompt(args) {
    const a = args as AskParams;
    const first = a.questions[0]!;
    return {
      kind: "questionnaire",
      title: a.title ?? (a.questions.length === 1 ? first.prompt : `${a.questions.length} preguntas`),
      questions: a.questions.map((q) => ({
        question: q.prompt,
        header: q.label ?? q.id,
        multiSelect: q.type === "multi",
        allowFreeText: true,
        options: q.options.map((o, i) => ({
          id: String(i),
          label: o.label,
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(o.preview !== undefined ? { preview: o.preview } : {}),
        })),
      })),
      source: { extension: "@eko24ive/pi-ask", tool: "ask_user", subagent: false },
      category: "question",
      danger: "low",
      herdrReported: false,
    };
  },

  toResult(args, answer): AskResult {
    const a = args as AskParams;
    const questions: AskQuestionSummary[] = a.questions.map((q) => ({
      id: q.id,
      label: q.label ?? q.id,
      prompt: q.prompt,
      type: q.type ?? "single",
    }));

    const any = answer as any;
    if (any.cancelled || !Array.isArray(any.answers)) {
      return { cancelled: true, mode: "submit", title: a.title, questions, answers: {} };
    }

    const answers: Record<string, AskResultAnswer> = {};
    for (const item of any.answers as Array<{ questionIndex: number; optionIds?: string[]; text?: string }>) {
      const q = a.questions[item.questionIndex];
      if (!q) continue;

      const picked = (item.optionIds ?? [])
        .map((id) => {
          const idx = Number(id);
          return Number.isInteger(idx) && q.options[idx] ? { opt: q.options[idx]!, idx } : null;
        })
        .filter((p): p is { opt: AskOption; idx: number } => p !== null);

      const text = typeof item.text === "string" && item.text.trim() ? item.text.trim() : undefined;

      if (q.type === "multi") {
        const values = [...picked.map((p) => p.opt.value ?? p.opt.label), ...(text !== undefined ? [text] : [])];
        const labels = [...picked.map((p) => p.opt.label), ...(text !== undefined ? [text] : [])];
        const indices = picked.map((p) => p.idx + 1);
        if (values.length > 0) {
          answers[q.id] = {
            values,
            labels,
            indices,
            ...(text !== undefined ? { customText: text } : {}),
          };
        }
      } else if (text !== undefined) {
        answers[q.id] = {
          values: [text],
          labels: [text],
          indices: [],
          customText: text,
        };
      } else if (picked.length > 0) {
        const p0 = picked[0]!;
        answers[q.id] = {
          values: [p0.opt.value ?? p0.opt.label],
          labels: [p0.opt.label],
          indices: [p0.idx + 1],
        };
      }
    }

    // Every question must be answered; otherwise cancel rather than silently committing partial state
    if (Object.keys(answers).length !== a.questions.length) {
      return { cancelled: true, mode: "submit", title: a.title, questions, answers: {} };
    }

    return {
      cancelled: false,
      mode: "submit",
      title: a.title,
      questions,
      answers,
    };
  },

  fromResult(args, result): Answer {
    const r = result as AskResult | undefined;
    if (!r || r.cancelled || !r.answers) return { cancelled: true };
    const a = args as AskParams;

    return {
      answers: a.questions.map((q, qIndex) => {
        const ans = r.answers[q.id];
        if (!ans) return { questionIndex: qIndex, optionIds: [] };

        const optionIds = (ans.indices ?? [])
          .map((i) => String(i - 1))
          .filter((id) => Number(id) >= 0 && Number(id) < q.options.length);

        const text = typeof ans.customText === "string" && ans.customText.trim() ? ans.customText.trim() : undefined;

        return {
          questionIndex: qIndex,
          ...(optionIds.length > 0 ? { optionIds } : {}),
          ...(text !== undefined ? { text } : {}),
        };
      }),
    };
  },
};
