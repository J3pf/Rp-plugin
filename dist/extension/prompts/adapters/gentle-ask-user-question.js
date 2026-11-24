import { parseOptionIndex } from "../broker.js";
export const gentleAskUserQuestion = {
    tool: "ask_user_question",
    extension: "gentle-pi",
    accepts(args) {
        const a = args;
        return (!!a &&
            Array.isArray(a.questions) &&
            a.questions.length >= 1 &&
            a.questions.length <= 4 &&
            a.questions.every((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.every((o) => o && typeof o.label === "string")));
    },
    toPrompt(args) {
        const a = args;
        const first = a.questions[0];
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
        const a = args;
        const any = answer;
        if (any.cancelled || !Array.isArray(any.answers))
            return { cancelled: true, answers: [] };
        const byQuestion = new Map();
        for (const item of any.answers) {
            if (!item || typeof item !== "object" || typeof item.questionIndex !== "number" || !Number.isInteger(item.questionIndex))
                continue;
            const q = a.questions[item.questionIndex];
            if (!q)
                continue;
            const rawIds = Array.isArray(item.optionIds) ? item.optionIds : [];
            const picked = rawIds
                .map((id) => {
                const idx = parseOptionIndex(id);
                return idx >= 0 ? q.options[idx] : undefined;
            })
                .filter((o) => !!o);
            const text = typeof item.text === "string" && item.text.trim() ? item.text : undefined;
            if (q.multiSelect) {
                const selected = picked.map((o) => o.label);
                if (text !== undefined)
                    byQuestion.set(item.questionIndex, { questionIndex: item.questionIndex, question: q.question, kind: "custom", answer: text, selected });
                else if (selected.length > 0)
                    byQuestion.set(item.questionIndex, { questionIndex: item.questionIndex, question: q.question, kind: "multi", answer: null, selected });
            }
            else if (text !== undefined) {
                byQuestion.set(item.questionIndex, { questionIndex: item.questionIndex, question: q.question, kind: "custom", answer: text });
            }
            else if (picked[0]) {
                byQuestion.set(item.questionIndex, {
                    questionIndex: item.questionIndex,
                    question: q.question,
                    kind: "option",
                    answer: picked[0].label,
                    ...(picked[0].preview !== undefined ? { preview: picked[0].preview } : {}),
                });
            }
        }
        // every question must be answered, otherwise treat as cancelled (never commit a partial questionnaire silently)
        if (byQuestion.size !== a.questions.length)
            return { cancelled: true, answers: [] };
        const rows = [...byQuestion.values()].sort((x, y) => x.questionIndex - y.questionIndex);
        return { cancelled: false, answers: rows };
    },
    fromResult(args, result) {
        const r = result;
        if (!r || r.cancelled || !Array.isArray(r.answers))
            return { cancelled: true };
        const a = args;
        return {
            answers: r.answers.map((row) => {
                const q = a.questions[row.questionIndex];
                if (row.kind === "custom")
                    return { questionIndex: row.questionIndex, text: row.answer ?? "" };
                const labels = row.kind === "multi" ? (row.selected ?? []) : row.answer ? [row.answer] : [];
                const ids = labels.map((l) => String(q?.options.findIndex((o) => o.label === l) ?? -1)).filter((id) => id !== "-1");
                return { questionIndex: row.questionIndex, optionIds: ids };
            }),
        };
    },
};
