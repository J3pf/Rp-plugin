import type { TodoStatus, TodoTask } from "../shared/protocol.ts";

export const VALID_TODO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "blocked",
  "done",
  "dropped",
]);

export function parseTodoTasks(details: unknown): TodoTask[] | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const state = (d.gentleTodo ?? d) as Record<string, unknown>;
  if (!Array.isArray(state?.tasks)) return null;

  return state.tasks.flatMap((item): TodoTask[] => {
    if (!item || typeof item !== "object") return [];
    const t = item as Record<string, unknown>;
    const rawStatus = typeof t.status === "string" ? t.status : "pending";
    const status: TodoStatus = VALID_TODO_STATUSES.has(rawStatus)
      ? (rawStatus as TodoStatus)
      : "pending";
    const task: TodoTask = {
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

export function replayTodoBranch(branch: readonly unknown[] | undefined): TodoTask[] {
  if (!Array.isArray(branch)) return [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | {
          type?: string;
          message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
        }
      | undefined;
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "toolResult" || msg.toolName !== "todo" || msg.isError === true) continue;
    const parsed = parseTodoTasks(msg.details);
    if (parsed) return parsed;
  }
  return [];
}

export function redactTodoTasks(tasks: readonly TodoTask[]): TodoTask[] {
  return tasks.map((t) => ({
    id: t.id,
    title: "[redacted]",
    status: t.status,
  }));
}
