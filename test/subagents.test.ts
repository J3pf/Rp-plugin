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

  it("integrates with gentle-pi notification events with epoch timestamps", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const t0 = 1760000000000;
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => t0,
    });

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_1",
      status: "running",
      occurredAt: t0,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].taskId).toBe("gentle_task_1");
    expect(emitted[0].status).toBe("running");
    expect(emitted[0].startedAt).toBe(t0);

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_1",
      status: "completed",
      occurredAt: t0 + 400,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].status).toBe("completed");
    expect(emitted[1].endedAt).toBe(t0 + 400);
    expect(emitted[1].durationMs).toBe(400);
  });

  it("normalizes performance.now timestamps (e.g. 47725510.340108) to integer epoch ms from now", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const before = Date.now();
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
    });

    // 47725510.340108 is performance.now() (~13h since boot), not epoch ms
    tracker.onGentleNotification({
      source: "subagent",
      taskId: "perf_task",
      status: "running",
      occurredAt: 47725510.340108,
    });
    const after = Date.now();

    expect(emitted).toHaveLength(1);
    const start = emitted[0].startedAt!;
    expect(Number.isInteger(start)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);

    // End with another performance.now timestamp
    tracker.onGentleNotification({
      source: "subagent",
      taskId: "perf_task",
      status: "completed",
      occurredAt: 47725610.123456,
    });
    const end = emitted[1].endedAt!;
    expect(Number.isInteger(end)).toBe(true);
    expect(end).toBeGreaterThanOrEqual(start);
    expect(emitted[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(emitted[1].durationMs!)).toBe(true);
  });

  it("keeps valid epoch occurredAt (rounded) and guarantees durationMs is never negative", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const validEpoch = 1760000000123.6;
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => 1760000000500,
    });

    tracker.onGentleNotification({
      source: "subagent",
      taskId: "valid_task",
      status: "running",
      occurredAt: validEpoch,
    });
    expect(emitted[0].startedAt).toBe(1760000000124);

    // Backward clock anomaly: endedAt earlier than startedAt -> durationMs must clamp to 0
    tracker.onGentleNotification({
      source: "subagent",
      taskId: "valid_task",
      status: "completed",
      occurredAt: validEpoch - 500,
    });
    expect(emitted[1].durationMs).toBe(0);

    // Prefers explicit source duration if provided
    tracker.onGentleNotification({
      source: "subagent",
      taskId: "valid_task_2",
      status: "completed",
      occurredAt: validEpoch + 1000,
      durationMs: 750.8,
    });
    expect(emitted[2].durationMs).toBe(751);
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

  it("normalizes gentle notification with performance.now timestamp end-to-end over relay", async () => {
    const relay = await new FakeRelay().start();
    const ctx = makeCtx();
    const { pi } = makePi();
    const rt = new Runtime(pi, ctx, baseConfig(relay.url), detectStaticEnv(), "startup");
    rt.start();
    await waitUntil(() => relay.of("agent.snapshot").length === 1);

    const before = Date.now();
    rt.subagents.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_perf",
      status: "running",
      occurredAt: 47725510.340108,
    });

    await waitUntil(() =>
      relay.of("agent.event").some((e) => e.d.e?.type === "subagent_update" && e.d.e?.taskId === "gentle_task_perf"),
    );
    const after = Date.now();
    const events = relay.of("agent.event").map((e) => e.d.e);
    const startEvent = events.find((e: any) => e.type === "subagent_update" && e.taskId === "gentle_task_perf");
    expect(startEvent).toBeDefined();
    expect(Number.isInteger(startEvent.startedAt)).toBe(true);
    expect(startEvent.startedAt).toBeGreaterThanOrEqual(before);
    expect(startEvent.startedAt).toBeLessThanOrEqual(after);

    rt.subagents.onGentleNotification({
      source: "subagent",
      taskId: "gentle_task_perf",
      status: "completed",
      occurredAt: 47725610.123456,
      durationMs: 99.8,
    });

    await waitUntil(() =>
      relay.of("agent.event").some((e) => e.d.e?.type === "subagent_update" && e.d.e?.status === "completed" && e.d.e?.taskId === "gentle_task_perf"),
    );
    const endEvents = relay.of("agent.event").map((e) => e.d.e);
    const endEvent = endEvents.filter((e: any) => e.type === "subagent_update" && e.taskId === "gentle_task_perf").pop();
    expect(endEvent).toBeDefined();
    expect(Number.isInteger(endEvent.endedAt)).toBe(true);
    expect(endEvent.durationMs).toBe(100);

    await rt.dispose();
    await relay.stop();
  });

  it("redacts subagent labels and omits result/error when redactContent is true, truncates large outputs, and bounds task capacity", () => {
    const emitted: SubagentUpdateEvent[] = [];
    let redacted = true;
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      isRedacted: () => redacted,
      now: () => 3000,
    });

    tracker.onToolStart("subagent_run", { agent: "worker", label: "secret label", task: "secret task" }, "call_sec");
    expect(emitted.at(-1)?.label).toBe("[redacted]");

    tracker.onToolEnd("subagent_run", "secret output", false, "call_sec", 100);
    expect(emitted.at(-1)?.label).toBe("[redacted]");
    expect(emitted.at(-1)?.result).toBeUndefined();
    expect(tracker.getSnapshot()[0]?.label).toBe("[redacted]");
    expect(tracker.getSnapshot()[0]?.result).toBeUndefined();

    // Unredacted: truncates large results to <= 4096 UTF-8 bytes
    redacted = false;
    tracker.onToolStart("subagent_run", { agent: "worker", label: "big task" }, "call_big");
    tracker.onToolEnd("subagent_run", "x".repeat(10_000), false, "call_big", 200);
    expect(Buffer.byteLength(emitted.at(-1)!.result!, "utf8")).toBeLessThanOrEqual(4096);

    // Capacity bound: at most 100 tasks retained
    for (let i = 0; i < 110; i++) {
      tracker.onToolStart("subagent_run", { agent: "worker", label: `t-${i}` }, `cap_${i}`);
      tracker.onToolEnd("subagent_run", "ok", false, `cap_${i}`, 10);
    }
    expect(tracker.getSnapshot().length).toBeLessThanOrEqual(100);
  });

  it("bounds child tool calls history to MAX_SUBAGENT_TOOLS (100) while incrementing toolCalls accurately", () => {
    const emitted: SubagentUpdateEvent[] = [];
    const tracker = new SubagentTracker({
      emit: (ev) => emitted.push(ev),
      now: () => 1000,
    });

    tracker.onToolStart("subagent_run", { agent: "worker", label: "many tools task" }, "parent_call");

    for (let i = 0; i < 120; i++) {
      tracker.onToolStart("read", { path: `file_${i}.ts` }, `child_${i}`, "parent_call");
      tracker.onToolEnd("read", "ok", false, `child_${i}`, 10, "parent_call");
    }

    const last = emitted.at(-1)!;
    expect(last.tools).toHaveLength(100);
    expect(last.toolCalls).toBe(120);
    // Oldest tool calls (child_0 .. child_19) were shifted out
    expect(last.tools![0].toolCallId).toBe("child_20");
    expect(last.tools![99].toolCallId).toBe("child_119");
  });
});
