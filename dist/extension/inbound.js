export function routeInbound(env, h) {
    const d = env.d ?? {};
    switch (env.t) {
        case "user.message":
            if (typeof d.clientMsgId !== "string" || typeof d.text !== "string")
                return false;
            h.userMessage(d);
            return true;
        case "agent.abort":
            h.abort();
            return true;
        case "prompt.answer":
            if (typeof d.promptId !== "string" || !d.answer || typeof d.answer !== "object")
                return false;
            h.promptAnswer(d.promptId, d.answer, d.deviceId);
            return true;
        case "prompt.cancel":
            if (typeof d.promptId !== "string")
                return false;
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
export function pendingAnswers(w) {
    return Array.isArray(w?.pendingAnswers) ? w.pendingAnswers.filter((p) => p && typeof p.promptId === "string" && p.answer) : [];
}
