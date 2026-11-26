import { parseOptionIndex } from "../../extension/prompts/broker.js";
import { parseAgyArgs } from "./agy-normalize.js";
/** Maximum questions per `prompt.open` (`kind: "questionnaire"`) enforced by Rp-relay's wire schema. */
export const MAX_AGY_QUESTIONNAIRE_BATCH = 4;
/** Default pacing delay (ms) between TUI input steps so Bubble Tea processes each transition cleanly. */
export const DEFAULT_KEYSTROKE_STEP_DELAY_MS = 45;
/** Match agy's internal ask_question tool name (bare or namespace-prefixed). */
export function isAgyAskQuestionToolName(name) {
    if (!name)
        return false;
    const trimmed = name.trim();
    return trimmed === "ask_question" || trimmed === "default_api:ask_question";
}
function normalizeOptionLabel(raw) {
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (raw && typeof raw === "object") {
        const obj = raw;
        const candidate = obj.label ?? obj.text ?? obj.value;
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}
/**
 * Parse raw `ask_question` tool arguments from agy's transcript.
 * Handles both JSON-stringified `questions` (protojson transcript format) and already-parsed arrays.
 */
export function parseAgyAskQuestionArgs(rawArgs) {
    const parsed = parseAgyArgs(rawArgs);
    let rawQuestions = parsed.questions ?? parsed.Questions;
    if (typeof rawQuestions === "string") {
        try {
            rawQuestions = JSON.parse(rawQuestions);
        }
        catch {
            return null;
        }
    }
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0)
        return null;
    const questions = [];
    for (const item of rawQuestions) {
        if (!item || typeof item !== "object")
            return null;
        const obj = item;
        const questionText = typeof obj.question === "string" ? obj.question.trim() : "";
        if (!questionText)
            return null;
        const rawOpts = Array.isArray(obj.options) ? obj.options : [];
        const options = [];
        for (const opt of rawOpts) {
            const label = normalizeOptionLabel(opt);
            if (label !== null)
                options.push(label);
        }
        const multiSelect = Boolean(obj.is_multi_select ?? obj.isMultiSelect ?? obj.multiSelect);
        questions.push({ question: questionText, options, multiSelect });
    }
    return questions.length > 0 ? { questions } : null;
}
/**
 * Build a RemotePi `AdapterPromptSpec` (`kind: "questionnaire"`) for a slice of up to 4 questions.
 */
export function buildAskQuestionPromptSpec(spec, offset = 0) {
    const total = spec.questions.length;
    const batch = spec.questions.slice(offset, offset + MAX_AGY_QUESTIONNAIRE_BATCH);
    const paginated = total > MAX_AGY_QUESTIONNAIRE_BATCH;
    const title = total === 1 && batch[0]
        ? batch[0].question.length > 160
            ? `${batch[0].question.slice(0, 159)}…`
            : batch[0].question
        : paginated
            ? `Questions ${offset + 1}–${offset + batch.length} of ${total}`
            : `${total} questions`;
    return {
        kind: "questionnaire",
        title,
        questions: batch.map((q, i) => ({
            question: q.question,
            ...(paginated ? { header: `${offset + i + 1}/${total}` } : {}),
            multiSelect: q.multiSelect,
            allowFreeText: true,
            options: q.options.map((label, oi) => ({
                id: String(oi),
                label,
            })),
        })),
        source: { extension: "agy", tool: "ask_question", subagent: false },
        category: "question",
        danger: "low",
        herdrReported: false,
    };
}
/** Sanitize user free-text for single-submission write-in input in agy's AskQuestionModel. */
export function sanitizeWriteInText(raw) {
    return raw
        .replace(/[\r\n]+/g, " ")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim();
}
/** Build the keystroke sequence to cancel/skip `remainingQuestions` prompts in agy's AskQuestionModel. */
export function buildAskQuestionCancelPlan(remainingQuestions) {
    const count = Math.max(1, Math.floor(remainingQuestions));
    const steps = [];
    for (let i = 0; i < count; i++) {
        steps.push({ type: "keys", keys: ["esc"] });
    }
    return steps;
}
/**
 * Plan the exact deterministic Herdr keystroke/text sequence to answer a batch of agy `ask_question` prompts.
 *
 * Matches `agy`'s Bubble Tea `AskQuestionModel`:
 * - Each question starts with cursor at `0` (`0..N-1` are predefined options; `N` is the synthetic "Other" row).
 * - Single-select predefined option `i`: `down` × `i`, then `enter` (auto-advances or submits on last question).
 * - Single-select write-in ("Other"): `down` × `N`, `enter` (focuses EditArea), `send-text`, `enter` (submits/advances).
 * - Multi-select predefined options: move `down` to each sorted index, `space` to toggle, then `enter` while `cursor < N`.
 * - Multi-select with write-in ("Other"): toggle predefined options first, move `down` to `N`, `enter`, `send-text`, `enter`.
 * - Cancel (`{ cancelled: true }`): `esc` once per remaining question (each `esc` skips current question and calls `advanceOrSubmit`).
 *
 * Returns `null` if the mobile answer is malformed or missing a question response.
 */
export function buildAskQuestionKeystrokePlan(spec, answer, offset = 0) {
    const remainingTotal = Math.max(0, spec.questions.length - offset);
    if (remainingTotal === 0)
        return null;
    const anyAnswer = answer;
    if (!anyAnswer || typeof anyAnswer !== "object")
        return null;
    if (anyAnswer.cancelled === true) {
        return buildAskQuestionCancelPlan(remainingTotal);
    }
    const batch = spec.questions.slice(offset, offset + MAX_AGY_QUESTIONNAIRE_BATCH);
    const rawAnswers = Array.isArray(anyAnswer.answers) ? anyAnswer.answers : null;
    if (!rawAnswers)
        return null;
    const byQuestion = new Map();
    for (const item of rawAnswers) {
        if (!item || typeof item !== "object")
            continue;
        const rec = item;
        const qIdx = rec.questionIndex;
        if (typeof qIdx !== "number" || !Number.isInteger(qIdx) || qIdx < 0 || qIdx >= batch.length)
            continue;
        const q = batch[qIdx];
        const rawIds = Array.isArray(rec.optionIds) ? rec.optionIds : [];
        const seen = new Set();
        const optionIndices = [];
        for (const id of rawIds) {
            if (typeof id !== "string")
                continue;
            const idx = parseOptionIndex(id);
            if (idx >= 0 && idx < q.options.length && !seen.has(idx)) {
                seen.add(idx);
                optionIndices.push(idx);
            }
        }
        optionIndices.sort((a, b) => a - b);
        const rawText = typeof rec.text === "string" ? sanitizeWriteInText(rec.text) : "";
        const text = rawText.length > 0 ? rawText : undefined;
        if (optionIndices.length === 0 && text === undefined)
            continue;
        byQuestion.set(qIdx, { optionIndices, ...(text !== undefined ? { text } : {}) });
    }
    if (byQuestion.size !== batch.length)
        return null;
    const steps = [];
    for (let qi = 0; qi < batch.length; qi++) {
        const q = batch[qi];
        const ans = byQuestion.get(qi);
        const otherIndex = q.options.length;
        if (q.multiSelect) {
            let cursor = 0;
            for (const idx of ans.optionIndices) {
                const delta = idx - cursor;
                if (delta > 0) {
                    steps.push({ type: "keys", keys: Array(delta).fill("down") });
                    cursor = idx;
                }
                steps.push({ type: "keys", keys: ["space"] });
            }
            if (ans.text !== undefined) {
                const deltaToOther = otherIndex - cursor;
                if (deltaToOther > 0) {
                    steps.push({ type: "keys", keys: Array(deltaToOther).fill("down") });
                }
                steps.push({ type: "keys", keys: ["enter"] });
                steps.push({ type: "text", text: ans.text });
                steps.push({ type: "keys", keys: ["enter"] });
            }
            else if (otherIndex > 0) {
                // Cursor is strictly < otherIndex (predefined options exist and only indices < otherIndex were visited).
                steps.push({ type: "keys", keys: ["enter"] });
            }
            else {
                // Degenerate multi-select question with zero predefined options and no write-in text: skip.
                steps.push({ type: "keys", keys: ["esc"] });
            }
        }
        else if (ans.text !== undefined) {
            if (otherIndex > 0) {
                steps.push({ type: "keys", keys: Array(otherIndex).fill("down") });
            }
            steps.push({ type: "keys", keys: ["enter"] });
            steps.push({ type: "text", text: ans.text });
            steps.push({ type: "keys", keys: ["enter"] });
        }
        else {
            const targetIndex = ans.optionIndices[0];
            if (targetIndex > 0) {
                steps.push({ type: "keys", keys: Array(targetIndex).fill("down") });
            }
            steps.push({ type: "keys", keys: ["enter"] });
        }
    }
    return steps;
}
/**
 * Execute a keystroke/text plan against an active agy pane via `herdr pane send-keys` and `herdr pane send-text`.
 * Returns `true` when every step succeeded, `false` if aborted or any Herdr invocation failed.
 */
export async function deliverAskQuestionPlan(runner, paneId, env, plan, opts = {}) {
    if (!paneId || plan.length === 0)
        return false;
    const delayMs = opts.stepDelayMs ?? DEFAULT_KEYSTROKE_STEP_DELAY_MS;
    const timeoutMs = opts.timeoutMs ?? 5_000;
    for (let i = 0; i < plan.length; i++) {
        if (opts.shouldAbort?.())
            return false;
        const step = plan[i];
        const args = step.type === "keys"
            ? ["pane", "send-keys", paneId, ...step.keys]
            : ["pane", "send-text", paneId, ...(step.text.startsWith("-") ? ["--", step.text] : [step.text])];
        const res = await runner("herdr", args, { timeoutMs, env });
        if (res.code !== 0)
            return false;
        if (delayMs > 0 && i < plan.length - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    return true;
}
