import type { SubagentToolCall, SubagentUpdateEvent } from "../shared/protocol.ts";
import { safeDurationMs, toEpochMs, truncateBytes } from "../shared/util.ts";

const MAX_SUBAGENT_TASKS = 100;
const MAX_SUBAGENT_TOOLS = 100;
const MAX_SUBAGENT_RESULT_BYTES = 4096;

export interface SubagentTrackerDeps {
  emit: (event: SubagentUpdateEvent) => void;
  isRedacted?: () => boolean;
  now?: () => number;
}

export class SubagentTracker {
  private tasks = new Map<string, SubagentUpdateEvent>();
  private callToTaskId = new Map<string, string>();
  private now: () => number;

  constructor(private deps: SubagentTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private isRedacted(): boolean {
    return !!this.deps.isRedacted?.();
  }

  private sanitizeTask(task: SubagentUpdateEvent): SubagentUpdateEvent {
    const copy: SubagentUpdateEvent = {
      ...task,
      ...(task.tools ? { tools: task.tools.map((t) => ({ ...t })) } : {}),
    };
    if (this.isRedacted()) {
      copy.label = "[redacted]";
      delete copy.result;
      delete copy.error;
    }
    return copy;
  }

  private setTask(taskId: string, task: SubagentUpdateEvent): void {
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    while (this.tasks.size > MAX_SUBAGENT_TASKS) {
      let victimId: string | undefined;
      for (const [id, t] of this.tasks) {
        if (t.status !== "running") {
          victimId = id;
          break;
        }
      }
      if (!victimId) {
        victimId = this.tasks.keys().next().value;
      }
      if (!victimId) break;
      this.tasks.delete(victimId);
      for (const [callId, mappedId] of this.callToTaskId) {
        if (mappedId === victimId || callId === victimId) {
          this.callToTaskId.delete(callId);
        }
      }
    }
  }

  getSnapshot(): SubagentUpdateEvent[] {
    return Array.from(this.tasks.values(), (t) => this.sanitizeTask(t));
  }

  getTask(id: string): SubagentUpdateEvent | undefined {
    const task = this.tasks.get(id);
    return task ? this.sanitizeTask(task) : undefined;
  }

  onToolStart(name: string, args: unknown, toolCallId?: string, parentToolCallId?: string): void {
    if (name === "subagent_run" && toolCallId) {
      const taskId = toolCallId;
      this.callToTaskId.set(toolCallId, taskId);
      const a = args as Record<string, unknown> | undefined;
      const agent = typeof a?.agent === "string" ? a.agent : "subagent";
      const label = this.isRedacted()
        ? "[redacted]"
        : typeof a?.label === "string"
          ? a.label
          : typeof a?.task === "string"
            ? a.task.slice(0, 72)
            : "Subagent task";
      const task: SubagentUpdateEvent = {
        type: "subagent_update",
        taskId,
        agent,
        label,
        status: "running",
        startedAt: toEpochMs(this.now(), this.now()),
        tools: [],
      };
      this.setTask(taskId, task);
      this.deps.emit(this.sanitizeTask(task));
      return;
    }

    if (parentToolCallId && toolCallId) {
      const taskId = this.callToTaskId.get(parentToolCallId) ?? parentToolCallId;
      const task = this.tasks.get(taskId);
      if (task) {
        task.tools = task.tools ?? [];
        task.tools.push({
          toolCallId,
          name,
          status: "running",
        });
        while (task.tools.length > MAX_SUBAGENT_TOOLS) {
          task.tools.shift();
        }
        task.toolCalls = (task.toolCalls ?? 0) + 1;
        this.deps.emit(this.sanitizeTask(task));
      }
    }
  }

  onToolEnd(
    name: string,
    result: unknown,
    isError: boolean,
    toolCallId?: string,
    durationMs?: number,
    parentToolCallId?: string,
  ): void {
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
          } else {
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
      if (task && task.tools) {
        const t = task.tools.find((x) => x.toolCallId === toolCallId);
        if (t) {
          t.status = isError ? "error" : "completed";
          if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
            t.durationMs = Math.round(durationMs);
          }
        }
        this.deps.emit(this.sanitizeTask(task));
      }
    }
  }

  onGentleNotification(d: unknown): void {
    if (!d || typeof d !== "object") return;
    const ev = d as Record<string, unknown>;
    if (ev.source !== "subagent" || typeof ev.taskId !== "string") return;

    const existing = this.tasks.get(ev.taskId);
    const task: SubagentUpdateEvent = existing ?? {
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
    const isFinished =
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.status === "timed_out";
    if (isFinished) {
      task.endedAt = toEpochMs(ev.occurredAt, this.now());
      const sourceDuration =
        typeof ev.durationMs === "number"
          ? ev.durationMs
          : typeof ev.duration === "number"
            ? ev.duration
            : undefined;
      task.durationMs = safeDurationMs(task.startedAt, task.endedAt, sourceDuration);
    }

    this.setTask(ev.taskId, task);
    this.deps.emit(this.sanitizeTask(task));
  }

  onGentleMetrics(d: unknown): void {
    if (!d || typeof d !== "object") return;
    const ev = d as Record<string, unknown>;
    if (typeof ev.taskId !== "string") return;

    const task = this.tasks.get(ev.taskId);
    if (!task) return;

    const launch = ev.launch as Record<string, unknown> | undefined;
    if (launch) {
      if (typeof launch.agentClass === "string") task.agent = launch.agentClass;
      if (typeof launch.selectedModelId === "string") task.model = launch.selectedModelId;
      if (typeof launch.selectedEffort === "string" && launch.selectedEffort !== "unavailable") {
        task.thinking = launch.selectedEffort;
      }
    }

    if (Array.isArray(ev.responses)) {
      let totalTokens = 0;
      for (const item of ev.responses) {
        const res = item as Record<string, unknown>;
        const tokens = res.tokens as Record<string, { state?: string; value?: number }> | undefined;
        if (tokens?.totalTokens?.state === "reported" && typeof tokens.totalTokens.value === "number") {
          totalTokens += tokens.totalTokens.value;
        }
      }
      if (totalTokens > 0) {
        task.tokens = totalTokens;
      }
      task.turns = (task.turns ?? 0) + ev.responses.length;
    }

    this.deps.emit(this.sanitizeTask(task));
  }
}
