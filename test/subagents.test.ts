import { describe, expect, it } from "vitest";
import { SubagentTracker } from "../src/extension/subagents.ts";
import type { SubagentUpdateEvent } from "../src/shared/protocol.ts";
import { makeCtx, makePi, baseConfig, FakeRelay, waitUntil } from "./helpers.ts";
import { Runtime } from "../src/extension/runtime.ts";
import { detectStaticEnv } from "../src/extension/environment.ts";

describe("SubagentTracker", () => {
  it("tracks subagent_run start and end lifecycle", () => {
    const emitted: SubagentUpdateEvent[] = [];
    let currentTime = 1000;
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => currentTime,
    });

    // Subagent start
    tracker.onToolStart("subagent_run", { agent: "sdd-explore", task: "explore auth", label: "explore auth module" }, "call_1");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: "subagent_update",
      taskId: "call_1",
      agent: "sdd-explore",
      label: "explore auth module",
      status: "running",
      startedAt: 1000,
      tools: [],
    });

    // Child tool run
    tracker.onToolStart("read", { path: "src/auth.ts" }, "child_tool_1", "call_1");
    expect(emitted).toHaveLength(2);
    expect(emitted[1].tools).toEqual([
      { toolCallId: "child_tool_1", name: "read", status: "running" },
    ]);
    expect(emitted[1].toolCalls).toBe(1);

    // Child tool end
    tracker.onToolEnd("read", "file contents", false, "child_tool_1", 50, "call_1");
    expect(emitted).toHaveLength(3);
    expect(emitted[2].tools![0]).toEqual({
      toolCallId: "child_tool_1",
      name: "read",
      status: "completed",
      durationMs: 50,
    });

    // Subagent completion
    currentTime = 1500;
    tracker.onToolEnd("subagent_run", "explored successfully", false, "call_1", 500);
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toMatchObject({
      type: "subagent_update",
      taskId: "call_1",
      status: "completed",
      endedAt: 1500,
      durationMs: 500,
      result: "explored successfully",
    });

    expect(tracker.getSnapshot()).toHaveLength(1);
    expect(tracker.getSnapshot()[0].taskId).toBe("call_1");
  });

  it("handles subagent failure", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => 2000,
    });

    tracker.onToolStart("subagent_run", { agent: "worker", task: "fix bug" }, "call_fail");
    tracker.onToolEnd("subagent_run", "out of budget", true, "call_fail", 300);

    const last = emitted[emitted.length - 1];
    expect(last.status).toBe("failed");
    expect(last.error).toBe("out of budget");
  });

  it("integrates with gentle-pi notification events", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => 5000,
    });

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_1",
      status: "running",
      occurredAt: 5000,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].taskId).toBe("gentle_task_1");
    expect(emitted[0].status).toBe("running");

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_1",
      status: "completed",
      occurredAt: 5400,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].status).toBe("completed");
    expect(emitted[1].durationMs).toBe(400);
  });

  it("integrates with gentle child metrics events", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => 6000,
    });

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "metric_task_1",
      status: "running",
    });

    tracker.onGentleMetrics({
      schema: "gentle:runtime-metrics:child/v1",
      taskId: "metric_task_1",
      launch: {
        agentClass: "sdd-apply",
        selectedModelId: "claude-3-5-sonnet",
        selectedEffort: "high",
      },
      responses: [
        {
          tokens: {
            totalTokens: { state: "reported", value: 1250 },
          },
        },
        {
          tokens: {
            totalTokens: { state: "reported", value: 850 },
          },
        },
      ],
    });

    const last = emitted[emitted.length - 1];
    expect(last.agent).toBe("sdd-apply");
    expect(last.model).toBe("claude-3-5-sonnet");
    expect(last.thinking).toBe("high");
    expect(last.tokens).toBe(2100);
    expect(last.turns).toBe(2);
  });
});

describe("Runtime Subagent integration", () => {
  it("emits subagent_update event over relay when subagent_run starts and ends", async () => {
    const relay = await new FakeRelay().start();
    const ctx = makeCtx();
    const { pi } = makePi();
    const rt = new Runtime(pi, ctx, baseConfig(relay.url), detectStaticEnv(), "startup");
    rt.start();
    await waitUntil(() => relay.of("agent.snapshot").length === 1);

    // tool_execution_start for subagent_run
    rt.forward("tool_execution_start", {
      toolCallId: "subagent_call_99",
      toolName: "subagent_run",
      args: { agent: "sdd-verify", label: "verify spec", task: "verify changes" },
    }, ctx);

    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e?.type === "subagent_update" && e.d.e?.taskId === "subagent_call_99"));
    const events = relay.of("agent.event").map((e) => e.d.e);
    const subagentStart = events.find((e: any) => e.type === "subagent_update" && e.taskId === "subagent_call_99");
    expect(subagentStart).toMatchObject({
      type: "subagent_update",
      taskId: "subagent_call_99",
      agent: "sdd-verify",
      label: "verify spec",
      status: "running",
    });

    // tool_execution_end
    rt.forward("tool_execution_end", {
      toolCallId: "subagent_call_99",
      toolName: "subagent_run",
      isError: false,
      durationMs: 450,
      result: { content: [{ type: "text", text: "all specs pass" }] },
    }, ctx);

    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e?.type === "subagent_update" && e.d.e?.status === "completed"));
    const eventsAfter = relay.of("agent.event").map((e) => e.d.e);
    const subagentEnd = eventsAfter.filter((e: any) => e.type === "subagent_update" && e.taskId === "subagent_call_99").pop();
    expect(subagentEnd).toMatchObject({
      type: "subagent_update",
      taskId: "subagent_call_99",
      status: "completed",
      durationMs: 450,
    });

    await rt.dispose();
    await relay.stop();
  });
});
