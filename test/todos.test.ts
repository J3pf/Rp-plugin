import { describe, expect, it } from "vitest";
import { parseTodoTasks, replayTodoBranch } from "../src/extension/todos.ts";
import { makeCtx, makePi, baseConfig, FakeRelay, waitUntil } from "./helpers.ts";
import { Runtime } from "../src/extension/runtime.ts";
import { detectStaticEnv } from "../src/extension/environment.ts";

describe("parseTodoTasks", () => {
  it("parses gentleTodo details with valid tasks", () => {
    const details = {
      gentleTodo: {
        tasks: [
          { id: 1, title: "Task 1", status: "pending" },
          { id: 2, title: "Task 2", status: "in_progress", note: "working on it" },
          { id: 3, title: "Task 3", status: "done" },
        ],
        nextId: 4,
      },
    };
    const tasks = parseTodoTasks(details);
    expect(tasks).toEqual([
      { id: 1, title: "Task 1", status: "pending" },
      { id: 2, title: "Task 2", status: "in_progress", note: "working on it" },
      { id: 3, title: "Task 3", status: "done" },
    ]);
  });

  it("handles rpiv-todo style details (tasks directly at top level)", () => {
    const details = {
      tasks: [{ id: 10, title: "Direct task", status: "blocked", note: "waiting" }],
    };
    const tasks = parseTodoTasks(details);
    expect(tasks).toEqual([
      { id: 10, title: "Direct task", status: "blocked", note: "waiting" },
    ]);
  });

  it("returns null for non-objects or missing tasks", () => {
    expect(parseTodoTasks(null)).toBeNull();
    expect(parseTodoTasks("string")).toBeNull();
    expect(parseTodoTasks({})).toBeNull();
    expect(parseTodoTasks({ gentleTodo: {} })).toBeNull();
  });
});

describe("replayTodoBranch", () => {
  it("extracts the latest successful todo result from branch history", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "do work" } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: false,
          details: {
            gentleTodo: {
              tasks: [{ id: 1, title: "Old task", status: "done" }],
            },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: false,
          details: {
            gentleTodo: {
              tasks: [
                { id: 1, title: "Old task", status: "done" },
                { id: 2, title: "New task", status: "in_progress" },
              ],
            },
          },
        },
      },
    ];
    const tasks = replayTodoBranch(branch);
    expect(tasks).toEqual([
      { id: 1, title: "Old task", status: "done" },
      { id: 2, title: "New task", status: "in_progress" },
    ]);
  });

  it("ignores error results", () => {
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: false,
          details: { gentleTodo: { tasks: [{ id: 1, title: "Good task", status: "pending" }] } },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: true,
          details: { error: "bad input" },
        },
      },
    ];
    expect(replayTodoBranch(branch)).toEqual([
      { id: 1, title: "Good task", status: "pending" },
    ]);
  });

  it("returns empty array for empty or missing branch", () => {
    expect(replayTodoBranch(undefined)).toEqual([]);
    expect(replayTodoBranch([])).toEqual([]);
  });
});

describe("Runtime TODO integration", () => {
  it("initializes hello with replayed branch TODOs", () => {
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: false,
          details: {
            gentleTodo: {
              tasks: [{ id: 1, title: "Initial task", status: "in_progress" }],
            },
          },
        },
      },
    ];
    const ctx = makeCtx({ branch });
    const { pi } = makePi();
    const rt = new Runtime(pi, ctx, baseConfig("http://localhost"), detectStaticEnv(), "startup");
    const hello = rt.makeHello();
    expect(hello.todos).toEqual({
      tasks: [{ id: 1, title: "Initial task", status: "in_progress" }],
    });
  });

  it("emits todo_update when tool todo finishes successfully", async () => {
    const relay = await new FakeRelay().start();
    const ctx = makeCtx();
    const { pi } = makePi();
    const rt = new Runtime(pi, ctx, baseConfig(relay.url), detectStaticEnv(), "startup");
    rt.start();
    await waitUntil(() => relay.of("agent.snapshot").length === 1);

    // Fire tool_execution_end for todo
    rt.forward("tool_execution_end", {
      toolCallId: "call_todo_1",
      toolName: "todo",
      isError: false,
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          gentleTodo: {
            tasks: [{ id: 1, title: "Updated task", status: "done" }],
          },
        },
      },
    }, ctx);

    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e?.type === "todo_update"));
    const events = relay.of("agent.event").map((e) => e.d.e);
    const todoEv = events.find((e: any) => e.type === "todo_update");
    expect(todoEv).toEqual({
      type: "todo_update",
      tasks: [{ id: 1, title: "Updated task", status: "done" }],
    });

    await rt.dispose();
    await relay.stop();
  });
});
