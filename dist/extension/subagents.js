import { safeDurationMs, toEpochMs, truncateBytes } from "../shared/util.js";
const MAX_SUBAGENT_TASKS = 100;
const MAX_SUBAGENT_TOOLS = 100;
const MAX_SUBAGENT_RESULT_BYTES = 4096;
export class SubagentTracker {
    deps;
    tasks = new Map();
    childTools = new Map();
    callToTaskId = new Map();
    now;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }
    isRedacted() {
        return !!this.deps.isRedacted?.();
    }
    sanitizeTask(task) {
        const copy = {
            ...task,
            ...(task.tools ? { tools: [...task.tools] } : {}),
            ...(task.tokens ? { tokens: { ...task.tokens } } : {}),
        };
        if (this.isRedacted()) {
            copy.label = "[redacted]";
            delete copy.result;
            delete copy.error;
        }
        return copy;
    }
    setTask(taskId, task) {
        this.tasks.delete(taskId);
        this.tasks.set(taskId, task);
        while (this.tasks.size > MAX_SUBAGENT_TASKS) {
            let victimId;
            for (const [id, t] of this.tasks) {
                if (t.status !== "running") {
                    victimId = id;
                    break;
                }
            }
            if (!victimId) {
                victimId = this.tasks.keys().next().value;
            }
            if (!victimId)
                break;
            this.tasks.delete(victimId);
            this.childTools.delete(victimId);
            for (const [callId, mappedId] of this.callToTaskId) {
                if (mappedId === victimId || callId === victimId) {
                    this.callToTaskId.delete(callId);
                }
            }
        }
    }
    getSnapshot() {
        return Array.from(this.tasks.values(), (t) => this.sanitizeTask(t));
    }
    getTask(id) {
        const task = this.tasks.get(id);
        return task ? this.sanitizeTask(task) : undefined;
    }
    getTaskToolCalls(id) {
        return (this.childTools.get(id) ?? []).map((t) => ({ ...t }));
    }
    onToolStart(name, args, toolCallId, parentToolCallId) {
        if (name === "subagent_run" && toolCallId) {
            const taskId = toolCallId;
            this.callToTaskId.set(toolCallId, taskId);
            const a = args;
            const agent = typeof a?.agent === "string" ? a.agent : "subagent";
            const label = this.isRedacted()
                ? "[redacted]"
                : typeof a?.label === "string"
                    ? a.label
                    : typeof a?.task === "string"
                        ? a.task.slice(0, 72)
                        : "Subagent task";
            const task = {
                type: "subagent_update",
                taskId,
                agent,
                label,
                status: "running",
                startedAt: toEpochMs(this.now(), this.now()),
                tools: [],
            };
            this.childTools.set(taskId, []);
            this.setTask(taskId, task);
            this.deps.emit(this.sanitizeTask(task));
            return;
        }
        if (parentToolCallId && toolCallId) {
            const taskId = this.callToTaskId.get(parentToolCallId) ?? parentToolCallId;
            const task = this.tasks.get(taskId);
            if (task) {
                const list = this.childTools.get(taskId) ?? [];
                list.push({
                    toolCallId,
                    name,
                    status: "running",
                });
                while (list.length > MAX_SUBAGENT_TOOLS) {
                    list.shift();
                }
                this.childTools.set(taskId, list);
                task.tools = list.map((t) => t.name);
                task.toolCalls = (task.toolCalls ?? 0) + 1;
                this.deps.emit(this.sanitizeTask(task));
            }
        }
    }
    onToolEnd(name, result, isError, toolCallId, durationMs, parentToolCallId) {
        if (name === "subagent_run" && toolCallId) {
            const taskId = this.callToTaskId.get(toolCallId) ?? toolCallId;
            this.callToTaskId.delete(toolCallId);
            const task = this.tasks.get(taskId);
            if (task) {
                task.status = isError ? "failed" : "completed";
                task.endedAt = toEpochMs(this.now(), this.now());
                task.durationMs = safeDurationMs(task.startedAt, task.endedAt, durationMs);
                if (!this.isRedacted()) {
                    const raw = typeof result === "string" ? result : JSON.stringify(result) ?? String(result);
                    const text = truncateBytes(raw, MAX_SUBAGENT_RESULT_BYTES).text;
                    if (isError) {
                        task.error = text;
                    }
                    else {
                        task.result = text;
                    }
                }
                this.deps.emit(this.sanitizeTask(task));
            }
            return;
        }
        if (parentToolCallId && toolCallId) {
            const taskId = this.callToTaskId.get(parentToolCallId) ?? parentToolCallId;
            const task = this.tasks.get(taskId);
            const list = this.childTools.get(taskId);
            if (task && list) {
                const t = list.find((x) => x.toolCallId === toolCallId);
                if (t) {
                    t.status = isError ? "error" : "completed";
                    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
                        t.durationMs = Math.round(durationMs);
                    }
                }
                task.tools = list.map((x) => x.name);
                this.deps.emit(this.sanitizeTask(task));
            }
        }
    }
    onGentleNotification(d) {
        if (!d || typeof d !== "object")
            return;
        const ev = d;
        if (ev.source !== "subagent" || typeof ev.taskId !== "string")
            return;
        const existing = this.tasks.get(ev.taskId);
        const task = existing ?? {
            type: "subagent_update",
            taskId: ev.taskId,
            agent: "subagent",
            label: this.isRedacted() ? "[redacted]" : ev.taskId,
            status: typeof ev.status === "string" ? ev.status : "running",
            startedAt: toEpochMs(ev.occurredAt, this.now()),
            tools: [],
        };
        if (typeof ev.status === "string") {
            task.status = ev.status;
        }
        const isFinished = task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled" ||
            task.status === "timed_out";
        if (isFinished) {
            task.endedAt = toEpochMs(ev.occurredAt, this.now());
            const sourceDuration = typeof ev.durationMs === "number"
                ? ev.durationMs
                : typeof ev.duration === "number"
                    ? ev.duration
                    : undefined;
            task.durationMs = safeDurationMs(task.startedAt, task.endedAt, sourceDuration);
        }
        this.setTask(ev.taskId, task);
        this.deps.emit(this.sanitizeTask(task));
    }
    onGentleMetrics(d) {
        if (!d || typeof d !== "object")
            return;
        const ev = d;
        if (typeof ev.taskId !== "string")
            return;
        const task = this.tasks.get(ev.taskId);
        if (!task)
            return;
        const launch = ev.launch;
        if (launch) {
            if (typeof launch.agentClass === "string")
                task.agent = launch.agentClass;
            if (typeof launch.selectedModelId === "string")
                task.model = launch.selectedModelId;
            if (typeof launch.selectedEffort === "string" && launch.selectedEffort !== "unavailable") {
                task.thinking = launch.selectedEffort;
            }
        }
        if (Array.isArray(ev.responses)) {
            let totalTokens = 0;
            let inputTokens = 0;
            let outputTokens = 0;
            for (const item of ev.responses) {
                const res = item;
                const tokens = res.tokens;
                if (tokens?.totalTokens?.state === "reported" && typeof tokens.totalTokens.value === "number") {
                    totalTokens += tokens.totalTokens.value;
                }
                if (tokens?.inputTokens?.state === "reported" && typeof tokens.inputTokens.value === "number") {
                    inputTokens += tokens.inputTokens.value;
                }
                if (tokens?.outputTokens?.state === "reported" && typeof tokens.outputTokens.value === "number") {
                    outputTokens += tokens.outputTokens.value;
                }
            }
            if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
                task.tokens = {
                    total: totalTokens || inputTokens + outputTokens,
                    ...(inputTokens > 0 ? { input: inputTokens } : {}),
                    ...(outputTokens > 0 ? { output: outputTokens } : {}),
                };
            }
            task.turns = (task.turns ?? 0) + ev.responses.length;
        }
        this.deps.emit(this.sanitizeTask(task));
    }
}
