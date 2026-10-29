export const VALID_TODO_STATUSES = new Set([
    "pending",
    "in_progress",
    "blocked",
    "done",
    "dropped",
]);
export function parseTodoTasks(details) {
    if (!details || typeof details !== "object")
        return null;
    const d = details;
    const state = (d.gentleTodo ?? d);
    if (!Array.isArray(state?.tasks))
        return null;
    return state.tasks.flatMap((item) => {
        if (!item || typeof item !== "object")
            return [];
        const t = item;
        const rawStatus = typeof t.status === "string" ? t.status : "pending";
        const status = VALID_TODO_STATUSES.has(rawStatus)
            ? rawStatus
            : "pending";
        const task = {
            id: typeof t.id === "number" ? t.id : 0,
            title: typeof t.title === "string" ? t.title : "",
            status,
        };
        if (typeof t.note === "string") {
            task.note = t.note;
        }
        return [task];
    });
}
export function replayTodoBranch(branch) {
    if (!Array.isArray(branch))
        return [];
    for (let i = branch.length - 1; i >= 0; i--) {
        try {
            const entry = branch[i];
            if (entry?.type !== "message")
                continue;
            const msg = entry.message;
            if (msg?.role !== "toolResult" || msg.toolName !== "todo" || msg.isError === true)
                continue;
            const parsed = parseTodoTasks(msg.details);
            if (parsed)
                return parsed;
        }
        catch {
            /* ignore malformed entry */
        }
    }
    return [];
}
export function redactTodoTasks(tasks) {
    return tasks.map((t) => ({
        id: t.id,
        title: "[redacted]",
        status: t.status,
    }));
}
