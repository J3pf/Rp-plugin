import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RpConfig } from "../src/extension/config.ts";
import { ALLOW, ALLOW_SESSION, DENY } from "../src/extension/prompts/gate.ts";
import {
  AGY_CONTEXT_WINDOW,
  AgyTranscriptReader,
  extractAgyUserText,
  normalizeAgyToolCall,
  normalizeAgyToolCalls,
  parseAgyArgs,
  resolveAgyTranscriptPath,
} from "../src/host/agy-transcript.ts";
import {
  BridgedAgentSession,
  HerdrAgentBridge,
  extractRecentCommandOutput,
  herdrPriorityStatusRank,
  installAgyHooks,
  mapHerdrAgentStatus,
  parseHerdrAgentList,
  parseTerminalContextUsage,
  readExternalAgentContextUsage,
  readExternalAgentModel,
  runAgyHook,
} from "../src/host/herdr-bridge.ts";
import { Connection, type Transport, type TransportHandlers, type TransportName } from "../src/extension/connection.ts";
import type { Envelope } from "../src/shared/protocol.ts";

class FakeTransport implements Transport {
  readonly sent: Envelope[] = [];
  private isOpen = false;
  constructor(
    readonly name: TransportName,
    private readonly h: TransportHandlers,
  ) {}
  start(): void {}
  open(): void {
    this.isOpen = true;
    this.h.onOpen();
  }
  send(env: Envelope): boolean {
    if (!this.isOpen) return false;
    this.sent.push(env);
    return true;
  }
  receive(env: Envelope): void {
    this.h.onMessage(env);
  }
  close(): void {
    this.isOpen = false;
  }
}

describe("agy-transcript", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts clean user request text and skips system wakeups", () => {
    expect(
      extractAgyUserText(
        "<USER_REQUEST>\nHola desde agy\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTime\n</ADDITIONAL_METADATA>",
      ),
    ).toEqual({ kind: "user", text: "Hola desde agy" });

    expect(
      extractAgyUserText("The following is a <SYSTEM_MESSAGE>\nTask finished\n</SYSTEM_MESSAGE>"),
    ).toEqual({ kind: "skip", text: "" });

    expect(extractAgyUserText("<CONTEXT_SUMMARY>\nSummary\n</CONTEXT_SUMMARY>")).toEqual({
      kind: "compaction",
      text: "Contexto de conversación compactado",
    });
  });

  it("normalizes agy protojson tool arguments and tool names", () => {
    expect(
       parseAgyArgs({
        CommandLine: '"npm test"',
        WaitMsBeforeAsync: "5000",
        IsDaemon: "false",
      }),
    ).toEqual({
      CommandLine: "npm test",
      WaitMsBeforeAsync: 5000,
      IsDaemon: false,
    });

    const bashCall = normalizeAgyToolCall(10, 0, {
      name: "run_command",
      args: { CommandLine: '"git status"', Cwd: '"/repo"' },
    });
    expect(bashCall).toEqual({
      toolCallId: "agy:10:0",
      name: "bash",
      args: { command: "git status", cwd: "/repo" },
    });

    const editCall = normalizeAgyToolCall(11, 0, {
      name: "replace_file_content",
      args: {
        TargetFile: '"/repo/a.ts"',
        TargetContent: '"const x = 1;"',
        ReplacementContent: '"const x = 2;"',
      },
    });
    expect(editCall).toEqual({
      toolCallId: "agy:11:0",
      name: "edit",
      args: {
        path: "/repo/a.ts",
        oldText: "const x = 1;",
        newText: "const x = 2;",
      },
    });

    const subCall = normalizeAgyToolCall(12, 0, {
      name: "invoke_subagent",
      args: {
        Subagents: JSON.stringify([{ Role: "Auditor", TypeName: "research", Prompt: "Audit repo" }]),
      },
    });
    expect(subCall.name).toBe("subagent_run");
    expect(subCall.subagentSpec).toEqual({
      role: "Auditor",
      typeName: "research",
      prompt: "Audit repo",
    });

    const editFileCall = normalizeAgyToolCall(13, 0, {
      name: "edit_file",
      args: {
        Path: '"/repo/src/main.ts"',
        Target: '"old"',
        Replacement: '"new"',
      },
    });
    expect(editFileCall).toEqual({
      toolCallId: "agy:13:0",
      name: "edit",
      args: {
        path: "/repo/src/main.ts",
        oldText: "old",
        newText: "new",
      },
    });

    const summaryBash = normalizeAgyToolCall(14, 0, {
      name: "run_command",
      args: { CommandLine: '"npm test"', toolSummary: '"Unit test execution"' },
    });
    expect(summaryBash.args).toEqual({
      command: "npm test",
      toolSummary: "Unit test execution",
    });
  });

  it("tracks getActiveTask while a tool call is pending and clears on generic result", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-active-task-"));
    tmpDirs.push(dir);
    const tPath = path.join(dir, "transcript.jsonl");

    fs.writeFileSync(
      tPath,
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-19T10:00:01Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: '"npm test"', toolSummary: '"Unit test execution"' } }],
      }) + "\n",
    );

    const reader = new AgyTranscriptReader(tPath);
    reader.pollNewEvents();
    expect(reader.getActiveTask()).toBe("Unit test execution");

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-10-19T10:00:02Z",
        content: "ok",
      }) + "\n",
    );
    reader.pollNewEvents();
    expect(reader.getActiveTask()).toBeNull();
  });

  it("reads transcript.jsonl and resolves truncated_fields from transcript_full.jsonl", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-transcript-"));
    tmpDirs.push(dir);
    const tPath = path.join(dir, "transcript.jsonl");
    const fullPath = path.join(dir, "transcript_full.jsonl");

    const steps = [
      {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-10-19T10:00:00Z",
        content: "<USER_REQUEST>\nRevisar archivos\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-19T10:00:01Z",
        thinking: "Voy a listar archivos",
        content: "Truncated...",
        truncated_fields: ["content"],
        tool_calls: [{ name: "run_command", args: { CommandLine: '"ls -la"' } }],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-10-19T10:00:02Z",
        content: "total 4\nREADME.md",
      },
    ];

    const fullSteps = [
      steps[0],
      {
        ...steps[1],
        content: "Respuesta completa desde transcript_full.jsonl",
        truncated_fields: undefined,
      },
      steps[2],
    ];

    fs.writeFileSync(tPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.writeFileSync(fullPath, fullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const reader = new AgyTranscriptReader(tPath);
    const snap = reader.readSnapshot();
    expect(snap.entries).toHaveLength(3);
    expect(snap.entries[0]!.kind).toBe("user");
    expect(snap.entries[1]!.kind).toBe("assistant");
    const assistantMsg = snap.entries[1]!.msg as any;
    expect(assistantMsg.content).toEqual([
      { type: "thinking", thinking: "Voy a listar archivos" },
      { type: "text", text: "Respuesta completa desde transcript_full.jsonl" },
      { type: "toolCall", id: "agy:1:0", name: "bash", arguments: { command: "ls -la" } },
    ]);
    expect(snap.entries[2]!.kind).toBe("tool_result");
    expect((snap.entries[2]!.msg as any).toolCallId).toBe("agy:1:0");
  });

  it("computes getLastActivityAt from entries or mtime and attaches to snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-activity-"));
    tmpDirs.push(dir);
    const tPath = path.join(dir, "transcript.jsonl");

    // File doesn't exist yet
    const readerMissing = new AgyTranscriptReader(tPath);
    expect(readerMissing.getLastActivityAt()).toBeNull();

    // Empty file: falls back to stat mtime
    fs.writeFileSync(tPath, "");
    const stat = fs.statSync(tPath);
    const readerEmpty = new AgyTranscriptReader(tPath);
    expect(readerEmpty.getLastActivityAt()).toBe(Math.floor(stat.mtimeMs));

    // File with entries: returns highest timestamp
    const t1 = 1729000000000;
    const t2 = 1729000050000;
    const steps = [
      { step_index: 0, type: "USER_INPUT", created_at: new Date(t1).toISOString(), content: "<USER_REQUEST>Hola</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(t2).toISOString(), content: "Mundo" },
    ];
    fs.writeFileSync(tPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const readerWithEntries = new AgyTranscriptReader(tPath);
    const snap = readerWithEntries.readSnapshot();
    expect(snap.entries.length).toBe(2);
    // created_at + step_index offset
    expect(readerWithEntries.getLastActivityAt()).toBe(t2 + 1);
  });

  it("rejects path traversal in resolveAgyTranscriptPath", () => {
    expect(() => resolveAgyTranscriptPath("../etc/passwd", "/tmp/home")).toThrow(/invalid conversationId/);
    expect(() => resolveAgyTranscriptPath("conv/../../secret", "/tmp/home")).toThrow(/invalid conversationId/);
    expect(resolveAgyTranscriptPath("conv-123", "/tmp/home")).toBe(
      path.join("/tmp/home", ".gemini", "antigravity-cli", "brain", "conv-123", ".system_generated", "logs", "transcript.jsonl"),
    );
  });

  it("extracts context usage tokens and percent from PLANNER_RESPONSE steps and attaches usage to assistant messages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-context-"));
    tmpDirs.push(dir);
    const tPath = path.join(dir, "transcript.jsonl");

    const steps = [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-11T10:00:00Z",
        content: "<USER_REQUEST>Hola</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-11T10:00:05Z",
        content: "Respuesta con tokens",
        input_tokens: 12_000,
        cache_read_tokens: 115_000,
        output_tokens: 1_000,
      },
    ];
    fs.writeFileSync(tPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const reader = new AgyTranscriptReader(tPath);
    const snap = reader.readSnapshot();
    expect(reader.getContextUsage()).toEqual({
      tokens: 128_000,
      contextWindow: AGY_CONTEXT_WINDOW,
      percent: 50,
    });
    const assistantMsg = snap.entries[1]!.msg as any;
    expect(assistantMsg.usage).toEqual({
      input: 12_000,
      output: 1_000,
      cacheRead: 115_000,
      cacheWrite: 0,
      totalTokens: 128_000,
      contextWindow: AGY_CONTEXT_WINDOW,
      contextPercent: 50,
    });
  });

  it("expands parallel Subagents arrays via normalizeAgyToolCalls and resolves truncated invoke_subagent tool_calls from transcript_full.jsonl", () => {
    const norms = normalizeAgyToolCalls(20, 0, {
      name: "invoke_subagent",
      args: {
        Subagents: JSON.stringify([
          { Role: "Explorer", TypeName: "explore", Prompt: "Find files" },
          { role: "Reviewer", typeName: "review", prompt: "Check diffs" },
        ]),
      },
    });
    expect(norms).toHaveLength(2);
    expect(norms[0]).toMatchObject({
      toolCallId: "agy:20:0:sub:0",
      name: "subagent_run",
      args: { agent: "explore", label: "Explorer", task: "Find files" },
      subagentSpec: { role: "Explorer", typeName: "explore", prompt: "Find files" },
    });
    expect(norms[1]).toMatchObject({
      toolCallId: "agy:20:0:sub:1",
      name: "subagent_run",
      args: { agent: "review", label: "Reviewer", task: "Check diffs" },
      subagentSpec: { role: "Reviewer", typeName: "review", prompt: "Check diffs" },
    });

    // Single-element Subagents preserves baseId for backwards compatibility
    const single = normalizeAgyToolCalls(21, 0, {
      name: "invoke_subagent",
      args: { Subagents: [{ Role: "Solo", TypeName: "worker", Prompt: "Do it" }] },
    });
    expect(single).toHaveLength(1);
    expect(single[0]!.toolCallId).toBe("agy:21:0");

    // Truncated invoke_subagent more than 5 lines from tail still resolves from transcript_full.jsonl
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-trunc-"));
    tmpDirs.push(dir);
    const parentDir = path.join(dir, "parent-conv");
    fs.mkdirSync(parentDir, { recursive: true });
    const tPath = path.join(parentDir, "transcript.jsonl");
    const fullPath = path.join(parentDir, "transcript_full.jsonl");

    const paddingSteps = Array.from({ length: 7 }, (_, i) => ({
      step_index: i + 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: `2026-11-14T10:00:0${i + 1}Z`,
      content: `Note ${i}`,
    }));
    const truncatedSpawnStep = {
      step_index: 0,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-14T10:00:00Z",
      truncated_fields: ["tool_calls"],
      tool_calls: [{ name: "invoke_subagent", args: { Subagents: "[]" } }],
    };
    const fullSpawnStep = {
      ...truncatedSpawnStep,
      truncated_fields: undefined,
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: JSON.stringify([
              { Role: "Alpha", TypeName: "explore", Prompt: "Scan A" },
              { Role: "Beta", TypeName: "research", Prompt: "Scan B" },
            ]),
          },
        },
      ],
    };

    fs.writeFileSync(tPath, [truncatedSpawnStep, ...paddingSteps].map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.writeFileSync(fullPath, [fullSpawnStep, ...paddingSteps].map((s) => JSON.stringify(s)).join("\n") + "\n");

    const reader = new AgyTranscriptReader(tPath);
    const events = reader.pollNewEvents();
    const subs = events.filter((e) => e.type === "subagent_update");
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.taskId)).toEqual(["agy:0:0:sub:0", "agy:0:0:sub:1"]);
    expect(subs.map((s) => s.label)).toEqual(["Alpha", "Beta"]);
    expect(reader.hasRunningSubagents()).toBe(true);
  });

  it("tracks async GENERIC spawn ack, live child transcript telemetry, and SYSTEM_MESSAGE completion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-life-"));
    tmpDirs.push(dir);
    const parentDir = path.join(dir, "parent-conv");
    const child1Dir = path.join(dir, "child-conv-1");
    const child2Dir = path.join(dir, "child-conv-2");
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(child1Dir, { recursive: true });
    fs.mkdirSync(child2Dir, { recursive: true });

    const parentPath = path.join(parentDir, "transcript.jsonl");
    const parentFullPath = path.join(parentDir, "transcript_full.jsonl");
    const child1Path = path.join(child1Dir, "transcript.jsonl");
    const child2Path = path.join(child2Dir, "transcript.jsonl");

    const step0 = {
      step_index: 0,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-14T10:00:00.000Z",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: JSON.stringify([
              { Role: "Auditor", TypeName: "research", Prompt: "Audit code" },
              { Role: "Tester", TypeName: "test", Prompt: "Run checks" },
            ]),
          },
        },
      ],
    };
    const step1 = {
      step_index: 1,
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-14T10:00:01.000Z",
      content:
        "Created the following subagents:\n" +
        JSON.stringify({ conversationId: "child-conv-1", logAbsoluteUri: pathToFileURL(child1Path).href }) +
        "\n" +
        JSON.stringify({ conversationId: "child-conv-2", logAbsoluteUri: pathToFileURL(child2Path).href }),
    };

    fs.writeFileSync(parentPath, [step0, step1].map((s) => JSON.stringify(s)).join("\n") + "\n");

    const reader = new AgyTranscriptReader(parentPath);
    const initialEvents = reader.pollNewEvents();
    // GENERIC ack keeps both subagents running and emits tool_execution_end for each
    expect(initialEvents.filter((e) => e.type === "tool_execution_end").map((e) => e.toolCallId)).toEqual([
      "agy:0:0:sub:0",
      "agy:0:0:sub:1",
    ]);
    expect(reader.hasRunningSubagents()).toBe(true);
    expect(reader.getSubagents().every((s) => s.status === "running")).toBe(true);

    // Child 1 writes steps while parent transcript has NO new bytes (deltaBytes === 0)
    fs.writeFileSync(
      child1Path,
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          content: "User changed setting `Model Selection` from Gemini 2.5 Flash to Claude Sonnet 4.5.",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:02.000Z",
          thinking: "Inspecting repository layout",
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_tokens: 5000,
          cache_write_tokens: 200,
          tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/repo/a.ts"' } }],
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:03.000Z",
          input_tokens: 800,
          output_tokens: 150,
          tool_calls: [{ name: "run_command", args: { CommandLine: '"npm test"' } }],
        },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );

    const childPollEvents = reader.pollNewEvents();
    const child1Update = childPollEvents.find((e) => e.type === "subagent_update" && e.taskId === "agy:0:0:sub:0") as any;
    expect(child1Update).toBeDefined();
    expect(child1Update.status).toBe("running");
    expect(child1Update.model).toBe("Claude Sonnet 4.5");
    expect(child1Update.thinking).toBe("Inspecting repository layout");
    expect(child1Update.turns).toBe(2);
    expect(child1Update.toolCalls).toBe(2);
    expect(child1Update.tools).toEqual(["read", "bash"]);
    expect(child1Update.tokens).toEqual({
      input: 2000,
      output: 450,
      cacheRead: 5000,
      cacheWrite: 200,
      total: 7650,
    });

    // Child 1 finishes via SYSTEM_MESSAGE (with truncated_fields resolved from transcript_full.jsonl)
    // and Child 2 writes final tool before SYSTEM_MESSAGE arrives
    fs.writeFileSync(
      child2Path,
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-14T10:00:04.000Z",
        tool_calls: [{ name: "grep_search", args: { Query: '"TODO"' } }],
      }) + "\n",
    );
    const sys1Trunc = {
      step_index: 2,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      created_at: "2026-11-14T10:00:10.000Z",
      truncated_fields: ["content"],
      content: "<SYSTEM_MESSAGE>\n[Message] sender=child-conv-1 content=Trunc...",
    };
    const sys1Full = {
      ...sys1Trunc,
      truncated_fields: undefined,
      content:
        "The following is a <SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T10:00:10Z sender=child-conv-1 priority=HIGH content=Full audit findings from child 1\n</SYSTEM_MESSAGE>",
    };
    const sys2 = {
      step_index: 3,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      created_at: "2026-11-14T10:00:15.000Z",
      content:
        "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T10:00:15Z sender=child-conv-2 content=All checks green\n</SYSTEM_MESSAGE>",
    };
    fs.writeFileSync(parentFullPath, [step0, step1, sys1Full, sys2].map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.appendFileSync(parentPath, [sys1Trunc, sys2].map((s) => JSON.stringify(s)).join("\n") + "\n");

    const doneEvents = reader.pollNewEvents();
    const done1 = doneEvents.find((e) => e.type === "subagent_update" && e.taskId === "agy:0:0:sub:0") as any;
    const done2 = doneEvents.find((e) => e.type === "subagent_update" && e.taskId === "agy:0:0:sub:1") as any;
    expect(done1).toMatchObject({
      status: "completed",
      result: "Full audit findings from child 1",
      turns: 2,
      toolCalls: 2,
    });
    expect(done1.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(done2).toMatchObject({
      status: "completed",
      result: "All checks green",
      tools: ["grep"],
      toolCalls: 1,
      turns: 1,
    });
    expect(reader.hasRunningSubagents()).toBe(false);
  });

  it("masks subagent label, thinking, result, and error when redactContent is enabled, and marks GENERIC error cleanly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-redact-"));
    tmpDirs.push(dir);
    const parentDir = path.join(dir, "parent");
    const childDir = path.join(dir, "child-r1");
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    const parentPath = path.join(parentDir, "transcript.jsonl");
    const childPath = path.join(childDir, "transcript.jsonl");

    fs.writeFileSync(
      parentPath,
      [
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:00Z",
          tool_calls: [{ name: "invoke_subagent", args: { Role: "SecretRole", TypeName: "worker", Prompt: "Secret" } }],
        },
        {
          step_index: 1,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-14T10:00:01Z",
          content: JSON.stringify({ conversationId: "child-r1", logAbsoluteUri: pathToFileURL(childPath).href }),
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:02Z",
          tool_calls: [{ name: "invoke_subagent", args: { Role: "FailRole", TypeName: "worker", Prompt: "Fail" } }],
        },
        {
          step_index: 3,
          type: "GENERIC",
          status: "ERROR",
          created_at: "2026-11-14T10:00:03Z",
          content: "sensitive error message",
        },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );
    fs.writeFileSync(
      childPath,
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-14T10:00:02Z",
        thinking: "Secret thoughts",
        tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }],
      }) + "\n",
    );

    const reader = new AgyTranscriptReader(parentPath, () => true);
    reader.pollNewEvents();
    fs.appendFileSync(
      parentPath,
      JSON.stringify({
        step_index: 4,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-14T10:00:05Z",
        content: "<SYSTEM_MESSAGE>\n[Message] sender=child-r1 content=secret output\n</SYSTEM_MESSAGE>",
      }) + "\n",
    );
    reader.pollNewEvents();

    const subs = reader.getSubagents();
    expect(subs).toHaveLength(2);
    expect(subs[0]!.label).toBe("[redacted]");
    expect(subs[0]!.thinking).toBeUndefined();
    expect(subs[0]!.result).toBeUndefined();
    expect(subs[0]!.tools).toEqual(["bash"]);
    expect(subs[1]!.status).toBe("error");
    expect(subs[1]!.label).toBe("[redacted]");
    expect(subs[1]!.error).toBeUndefined();
  });

  it("rejects path traversal and out-of-scope logAbsoluteUri in GENERIC spawn ack", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-sec-"));
    tmpDirs.push(dir);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-home-"));
    tmpDirs.push(homeDir);
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    try {
      const parentDir = path.join(dir, "parent");
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-outside-"));
      tmpDirs.push(outsideDir);
      fs.mkdirSync(parentDir, { recursive: true });

      const parentPath = path.join(parentDir, "transcript.jsonl");
      const outsideTranscript = path.join(outsideDir, "transcript.jsonl");
      fs.writeFileSync(
        outsideTranscript,
        JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:01Z",
          thinking: "LEAKED_OUTSIDE_THINKING",
          tool_calls: [{ name: "run_command", args: { CommandLine: '"cat /etc/shadow"' } }],
        }) + "\n",
      );

      fs.writeFileSync(
        parentPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-14T10:00:00Z",
            tool_calls: [
              {
                name: "invoke_subagent",
                args: {
                  Subagents: JSON.stringify([
                    { Role: "OutsideUri", TypeName: "worker", Prompt: "Test 1" },
                    { Role: "TraversalId", TypeName: "worker", Prompt: "Test 2" },
                  ]),
                },
              },
            ],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-11-14T10:00:01Z",
            content:
              JSON.stringify({ conversationId: "valid-child-id", logAbsoluteUri: pathToFileURL(outsideTranscript).href }) +
              "\n" +
              JSON.stringify({ conversationId: "../../etc/passwd", logAbsoluteUri: "file:///etc/passwd" }),
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(parentPath);
      reader.pollNewEvents();
      const subs = reader.getSubagents();
      // Neither subagent should ever read from outsideTranscript or /etc/passwd
      expect(subs.every((s) => !s.thinking?.includes("LEAKED_OUTSIDE_THINKING"))).toBe(true);
      expect(subs[0]!.tools).toEqual([]);
      // Invalid conversationId "../../etc/passwd" is rejected as non-ack -> done, not running
      expect(subs[1]!.status).toBe("done");
    } finally {
      homeSpy.mockRestore();
    }
  });


  it("reads external context usage for claude, codex, and terminal footers", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-ext-ctx-"));
    tmpDirs.push(home);
    const cwd = "/mnt/repo/demo";
    const claudeDir = path.join(home, ".claude", "projects", "-mnt-repo-demo");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "sess-claude.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10_000,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: 49_000,
            output_tokens: 1_000,
          },
        },
      }) + "\n",
    );
    expect(readExternalAgentContextUsage("claude", cwd, "sess-claude", "", home)).toEqual({
      tokens: 80_000,
      contextWindow: 200_000,
      percent: 40,
    });

    const codexDir = path.join(home, ".codex", "sessions", "2026", "11", "11");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "rollout-sess-codex.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 64_600 },
            model_context_window: 258_400,
          },
        },
      }) + "\n",
    );
    expect(readExternalAgentContextUsage("codex", cwd, "sess-codex", "", home)).toEqual({
      tokens: 64_600,
      contextWindow: 258_400,
      percent: 25,
    });

    expect(parseTerminalContextUsage("Footer: 92k / 200k tokens")).toEqual({
      tokens: 92_000,
      contextWindow: 200_000,
      percent: 46,
    });
    expect(parseTerminalContextUsage("65% context left", 200_000)).toEqual({
      tokens: 70_000,
      contextWindow: 200_000,
      percent: 35,
    });

    const agyDir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(agyDir, { recursive: true });
    fs.writeFileSync(path.join(agyDir, "settings.json"), JSON.stringify({ model: "Gemini 4 Hydrogen (Medium)" }));
    expect(readExternalAgentModel("agy", cwd, null, home)).toEqual({
      provider: "google",
      id: "Gemini 4 Hydrogen (Medium)",
    });

    // Per-session model from transcript USER_SETTINGS_CHANGE overrides global settings.json
    const sessionA = "conv-argon";
    const tPathA = resolveAgyTranscriptPath(sessionA, home);
    fs.mkdirSync(path.dirname(tPathA), { recursive: true });
    fs.writeFileSync(
      tPathA,
      JSON.stringify({
        step_index: 1,
        type: "USER_INPUT",
        content: "<USER_REQUEST>Hola</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Hydrogen (Medium) to Gemini 4 Argon (Medium).\n</USER_SETTINGS_CHANGE>",
      }) + "\n",
    );
    expect(readExternalAgentModel("agy", cwd, sessionA, home)).toEqual({
      provider: "google",
      id: "Gemini 4 Argon (Medium)",
    });

    const codexHomeDir = path.join(home, ".codex");
    fs.mkdirSync(codexHomeDir, { recursive: true });
    fs.writeFileSync(path.join(codexHomeDir, "config.toml"), 'model = "gpt-5.3-codex"\n');
    expect(readExternalAgentModel("codex", cwd, null, home)).toEqual({
      provider: "openai",
      id: "gpt-5.3-codex",
    });
  });

  it("getSessionTopic skips short confirmations and locks onto the first substantive prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-topic-"));
    tmpDirs.push(dir);
    const tPath = path.join(dir, "transcript.jsonl");

    fs.writeFileSync(
      tPath,
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-15T10:00:00Z",
        content: "<USER_REQUEST>\nsiii\n</USER_REQUEST>",
      }) + "\n",
    );

    const reader = new AgyTranscriptReader(tPath);
    reader.readSnapshot();
    expect(reader.getSessionTopic()).toBeNull();

    fs.appendFileSync(
      tPath,
      [
        {
          step_index: 1,
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-11-15T10:01:00Z",
          content: "<USER_REQUEST>\nok si hagamole!\n</USER_REQUEST>",
        },
        {
          step_index: 2,
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-11-15T10:02:00Z",
          content: "<USER_REQUEST>\nAdelante!\n</USER_REQUEST>",
        },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );
    reader.pollNewEvents();
    expect(reader.getSessionTopic()).toBeNull();

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 3,
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-15T10:03:00Z",
        content: "<USER_REQUEST>\nOk,\nCompactar tarjetas del panel de agentes\n</USER_REQUEST>",
      }) + "\n",
    );
    reader.pollNewEvents();
    expect(reader.getSessionTopic()).toBe("Compactar tarjetas del panel de agentes");

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 4,
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-15T10:04:00Z",
        content: "<USER_REQUEST>\nCambiar completamente de tema después\n</USER_REQUEST>",
      }) + "\n",
    );
    reader.pollNewEvents();
    expect(reader.getSessionTopic()).toBe("Compactar tarjetas del panel de agentes");
  });
});

describe("herdr-bridge & PreToolUse gate", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses herdr agent list and filters out pi and gentle-shell", () => {
    const raw = JSON.stringify({
      result: {
        agents: [
          {
            agent: "pi",
            pane_id: "w1:p1",
            cwd: "/repo/pi",
            agent_status: "idle",
          },
          {
            agent: "agy",
            pane_id: "w2:p1",
            tab_id: "w2:t1",
            workspace_id: "w2",
            cwd: "/repo/rempi",
            agent_status: "working",
            agent_session: {
              agent: "agy",
              kind: "id",
              value: "714f3508-72d1-45fb-bae6-89ddfec13d7a",
            },
            state_change_seq: 42,
          },
        ],
      },
    });
    const parsed = parseHerdrAgentList(raw);
    expect(parsed).toEqual([
      {
        agent: "agy",
        sessionId: "714f3508-72d1-45fb-bae6-89ddfec13d7a",
        status: "working",
        cwd: "/repo/rempi",
        paneId: "w2:p1",
        tabId: "w2:t1",
        workspaceId: "w2",
        title: null,
        stateChangeSeq: 42,
      },
    ]);
  });

  it("maps herdr agent status to Rp status preserving done", () => {
    expect(mapHerdrAgentStatus("working")).toBe("working");
    expect(mapHerdrAgentStatus("done")).toBe("done");
    expect(mapHerdrAgentStatus("blocked")).toBe("waiting_input");
    expect(mapHerdrAgentStatus("error")).toBe("error");
    expect(mapHerdrAgentStatus("idle")).toBe("idle");
    expect(mapHerdrAgentStatus(null)).toBe("idle");
    expect(mapHerdrAgentStatus(undefined)).toBe("idle");

    expect(herdrPriorityStatusRank({ status: "waiting_input" })).toBe(4);
    expect(herdrPriorityStatusRank({ status: "working" })).toBe(3);
    expect(herdrPriorityStatusRank({ status: "idle" })).toBe(2);
    expect(herdrPriorityStatusRank({ status: "done" })).toBe(2);
    expect(herdrPriorityStatusRank({ status: "error" })).toBe(1);
  });

  it("sends agent.closed once after a discovered pane disappears, then stops its connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-closed-"));
    tmpDirs.push(dir);
    let listPoll = 0;
    const transports = new Map<string, FakeTransport>();
    const runner = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        listPoll++;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agents: listPoll === 1 ? [{ agent: "claude", pane_id: "wS:p1", cwd: dir, agent_status: "idle" }] : [],
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: path.join(dir, "agy-gate.sock"),
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const transport = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, transport);
            return transport;
          },
        }),
    });

    try {
      await bridge.poll();
      const session = bridge.getActiveSessions()[0]!;
      const transport = transports.get(session.agentId)!;
      transport.open();
      transport.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      expect(transport.sent.filter((env) => env.t === "agent.closed")).toHaveLength(0);
      expect(bridge.getActiveSessions()).toContain(session);

      const closeOriginal = session.closeFromHerdr.bind(session);
      const close = vi.spyOn(session, "closeFromHerdr");
      close.mockImplementation((reason, _graceMs) => closeOriginal(reason, 20));

      await bridge.poll();
      expect(transport.sent.filter((env) => env.t === "agent.closed")).toHaveLength(0);
      expect(bridge.getActiveSessions()).toContain(session);
      await bridge.poll();

      const closed = transport.sent.filter((env) => env.t === "agent.closed");
      expect(closed).toHaveLength(1);
      expect(closed[0]!.d).toEqual({ reason: "pane_closed" });
      expect(close).toHaveBeenCalledTimes(1);
      expect(bridge.getActiveSessions()).not.toContain(session);
      expect(session.conn.state).toBe("connected");
      await vi.waitFor(() => expect(session.conn.state).toBe("stopped"), { timeout: 1_000, interval: 5 });
    } finally {
      bridge.stop();
    }
  });

  it("never sends agent.closed while the pane is still listed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-still-listed-"));
    tmpDirs.push(dir);
    const transports = new Map<string, FakeTransport>();
    const runner = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { agents: [{ agent: "claude", pane_id: "wL:p1", cwd: dir, agent_status: "idle" }] },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: path.join(dir, "agy-gate.sock"),
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const transport = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, transport);
            return transport;
          },
        }),
    });

    try {
      await bridge.poll();
      const session = bridge.getActiveSessions()[0]!;
      const transport = transports.get(session.agentId)!;
      transport.open();
      transport.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

      await bridge.poll();
      await bridge.poll();
      await bridge.poll();

      expect(transport.sent.filter((env) => env.t === "agent.closed")).toHaveLength(0);
      expect(bridge.getActiveSessions()).toContain(session);
      expect(session.conn.state).toBe("connected");
    } finally {
      bridge.stop();
    }
  });

  it("keeps a vanished pane with an open prompt and does not send agent.closed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-closed-prompt-"));
    tmpDirs.push(dir);
    let listPoll = 0;
    const transports = new Map<string, FakeTransport>();
    const runner = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        listPoll++;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agents: listPoll === 1 ? [{ agent: "claude", pane_id: "wS:p2", cwd: dir, agent_status: "idle" }] : [],
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: path.join(dir, "agy-gate.sock"),
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const transport = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, transport);
            return transport;
          },
        }),
    });

    try {
      await bridge.poll();
      const session = bridge.getActiveSessions()[0]!;
      const transport = transports.get(session.agentId)!;
      transport.open();
      transport.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      session.broker.open({ kind: "confirm", title: "Confirm", message: "Keep pane open?" });

      await bridge.poll();
      await bridge.poll();

      expect(transport.sent.filter((env) => env.t === "agent.closed")).toHaveLength(0);
      expect(bridge.getActiveSessions()).toContain(session);
    } finally {
      bridge.stop();
    }
  });

  it("bridges discovered agy agents, delivers prompts via herdr, and gates dangerous commands via PreToolUse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-bridge-"));
    tmpDirs.push(dir);
    const sockPath = path.join(dir, "agy-gate.sock");

    const transports = new Map<string, FakeTransport>();
    const calls: Array<{ cmd: string; args: string[] }> = [];

    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  agent: "agy",
                  pane_id: "wS:p1",
                  tab_id: "wS:t1",
                  workspace_id: "wS",
                  cwd: dir,
                  agent_status: "idle",
                  agent_session: { value: "conv-123" },
                  state_change_seq: 1,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };

    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };

    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: sockPath,
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const t = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, t);
            return t;
          },
        }),
    });

    bridge.start();
    try {
      await bridge.poll();
      const t = transports.get("M1:herdr:conv-123");
      expect(t).toBeDefined();
      t!.open();
      expect(t!.sent[0]?.t).toBe("agent.hello");
      expect((t!.sent[0]?.d as any).kind).toBe("agy");
      expect((t!.sent[0]?.d as any).herdr).toEqual({
        paneId: "wS:p1",
        tabId: "#0001|wS:t1",
        workspaceId: "wS",
        session: null,
      });

      t!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      expect(t!.sent.some((e) => e.t === "agent.snapshot")).toBe(true);

      // Test user.message delivery to Herdr pane
      t!.receive({
        v: 1,
        id: "m1",
        t: "user.message",
        ts: Date.now(),
        d: { clientMsgId: "c1", text: "Hola agy" },
      });
      await vi.waitFor(() => {
        expect(calls).toContainEqual({ cmd: "herdr", args: ["agent", "prompt", "wS:p1", "Hola agy"] });
        expect(t!.sent.some((e) => e.t === "user.message.ack" && (e.d as any).disposition === "typed")).toBe(true);
      }, { timeout: 3_000, interval: 10 });

      // Fast-path PreToolUse: safe command returns allow immediately
      const safeRes = await runAgyHook(
        cfg,
        JSON.stringify({
          conversationId: "conv-123",
          toolCall: { name: "run_command", args: { CommandLine: '"npm test"' } },
        }),
        sockPath,
      );
      expect(safeRes).toEqual({ decision: "allow" });

      // Slow-path PreToolUse: dangerous command (sudo) opens prompt on relay and waits for phone answer
      const gatePromise = runAgyHook(
        cfg,
        JSON.stringify({
          conversationId: "conv-123",
          toolCall: { name: "run_command", args: { CommandLine: '"sudo rm -rf /tmp/test"' } },
        }),
        sockPath,
      );

      await vi.waitFor(() => {
        const promptEnv = t!.sent.find((e) => e.t === "prompt.open");
        expect(promptEnv).toBeDefined();
      }, { timeout: 3_000, interval: 10 });
      const promptEnv = t!.sent.find((e) => e.t === "prompt.open")!;
      const promptId = (promptEnv.d as any).promptId as string;

      // Simulate user tapping "Permitir siempre en esta sesión" (option index "1" -> ALLOW_SESSION) on phone
      t!.receive({
        v: 1,
        id: "pa1",
        t: "prompt.answer",
        ts: Date.now(),
        d: { promptId, clientMsgId: "ca1", answer: { optionIds: ["1"] } },
      });

      const gateRes = await gatePromise;
      expect(gateRes).toEqual({ decision: "allow" });

      // Subsequent identical dangerous command in same session is auto-allowed
      const cachedRes = await runAgyHook(
        cfg,
        JSON.stringify({
          conversationId: "conv-123",
          toolCall: { name: "run_command", args: { CommandLine: '"sudo rm -rf /tmp/test"' } },
        }),
        sockPath,
      );
      expect(cachedRes).toEqual({ decision: "allow" });

      // Test denying another dangerous command from phone
      const denyPromise = runAgyHook(
        cfg,
        JSON.stringify({
          conversationId: "conv-123",
          toolCall: { name: "run_command", args: { CommandLine: '"sudo reboot"' } },
        }),
        sockPath,
      );
      await vi.waitFor(() => {
        const denyPrompt = t!.sent.filter((e) => e.t === "prompt.open").at(-1);
        expect(denyPrompt).toBeDefined();
        expect((denyPrompt!.d as any).promptId).not.toBe(promptId);
      }, { timeout: 3_000, interval: 10 });
      const denyPrompt = t!.sent.filter((e) => e.t === "prompt.open").at(-1)!;
      t!.receive({
        v: 1,
        id: "pa2",
        t: "prompt.answer",
        ts: Date.now(),
        d: { promptId: (denyPrompt!.d as any).promptId, clientMsgId: "ca2", answer: { optionIds: ["2"] } },
      });
      const denyRes = await denyPromise;
      expect(denyRes).toEqual({ decision: "deny", reason: "Denegado desde RP móvil" });
    } finally {
      bridge.stop();
    }
  });

  it("installs rp-gate in ~/.gemini/config/hooks.json while preserving existing hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-hooks-"));
    tmpDirs.push(dir);
    const cfgDir = path.join(dir, ".gemini", "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "hooks.json"),
      JSON.stringify({
        herdr: { PreInvocation: [{ command: "herdr-hook", type: "command" }] },
      }),
    );

    const writtenPath = installAgyHooks("/usr/bin/node", "/opt/rp-plugin/bin/rp-host.mjs", dir);
    const content = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    expect(content.herdr).toBeDefined();
    expect(content["rp-gate"]).toEqual({
      enabled: true,
      PreToolUse: [
        {
          matcher: "run_command",
          hooks: [
            {
              type: "command",
              command: "'/usr/bin/node' '/opt/rp-plugin/bin/rp-host.mjs' agy-hook PreToolUse",
              timeout: 300,
            },
          ],
        },
      ],
    });

    // Test Windows quoting
    const winPath = installAgyHooks("C:\\Program Files\\nodejs\\node.exe", "C:\\opt\\rp\\bin\\rp-host.mjs", dir, "win32");
    const winContent = JSON.parse(fs.readFileSync(winPath, "utf8"));
    expect(winContent["rp-gate"].PreToolUse[0].hooks[0].command).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\opt\\rp\\bin\\rp-host.mjs" agy-hook PreToolUse',
    );
  });

  it("fails closed on malformed input, missing command, or broken socket request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-bridge-failclose-"));
    tmpDirs.push(dir);
    const sockPath = path.join(dir, "agy-gate.sock");
    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };

    // Malformed JSON stdin to runAgyHook fails closed
    const badJsonRes = await runAgyHook(cfg, "not valid json {", sockPath);
    expect(badJsonRes.decision).toBe("ask");

    // Disabled config or gate.mode === "off" returns "ask" instead of auto-allowing run_command
    const disabledRes = await runAgyHook(
      { ...cfg, enabled: false },
      JSON.stringify({
        conversationId: "conv-disabled",
        toolCall: { name: "run_command", args: { CommandLine: '"sudo rm -rf /tmp/test"' } },
      }),
      sockPath,
    );
    expect(disabledRes.decision).toBe("ask");

    const offModeRes = await runAgyHook(
      { ...cfg, gate: { ...cfg.gate, mode: "off" } },
      JSON.stringify({
        conversationId: "conv-off",
        toolCall: { name: "run_command", args: { CommandLine: '"sudo rm -rf /tmp/test"' } },
      }),
      sockPath,
    );
    expect(offModeRes.decision).toBe("ask");

    // run_command with empty / unparseable command fails closed
    const emptyCmdRes = await runAgyHook(
      cfg,
      JSON.stringify({
        conversationId: "conv-fail",
        toolCall: { name: "run_command", args: {} },
      }),
      sockPath,
    );
    expect(emptyCmdRes.decision).toBe("ask");

    // Start a bridge to test socket fail-closed behavior
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner: async () => ({ code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" }),
      socketPath: sockPath,
      pollIntervalMs: 60_000,
    });
    bridge.start();

    try {
      // Connect directly to the gate socket and send malformed line
      const client = net.createConnection(sockPath);
      const respPromise = new Promise<any>((resolve) => {
        let buf = "";
        client.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl).trim()));
        });
      });
      client.write("broken json line\n");
      const resp = await respPromise;
      expect(resp.decision).toBe("ask");
      client.destroy();

      // Send JSON missing conversationId or command
      const client2 = net.createConnection(sockPath);
      const respPromise2 = new Promise<any>((resolve) => {
        let buf = "";
        client2.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl).trim()));
        });
      });
      client2.write(JSON.stringify({ conversationId: "", command: "" }) + "\n");
      const resp2 = await respPromise2;
      expect(resp2.decision).toBe("ask");
      client2.destroy();
    } finally {
      bridge.stop();
    }
  });

  it("extractRecentCommandOutput returns snippet from last command occurrence", () => {
    const term = "Previous history\nline 2\n> /usage\n  Model: gemini-3.8-flash\n  Tokens: 120";
    expect(extractRecentCommandOutput(term, "/usage")).toBe("> /usage\n  Model: gemini-3.8-flash\n  Tokens: 120");
    expect(extractRecentCommandOutput(term, "/nonexistent")).toBe(term);
    expect(extractRecentCommandOutput(term)).toBe(term);
  });

  it("captures slash command output via pane fallback and settles without infinite thinking", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-slash-cmd-"));
    tmpDirs.push(dir);
    const sockPath = path.join(dir, "agy-gate.sock");
    const transports = new Map<string, FakeTransport>();
    const calls: Array<{ cmd: string; args: string[] }> = [];

    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  agent: "claude",
                  pane_id: "wS:p2",
                  cwd: dir,
                  agent_status: "idle",
                  state_change_seq: 1,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (cmd === "herdr" && args[0] === "pane" && args[1] === "read") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              text: "Previous logs\n> /usage\n  Claude 3.7 Sonnet: 450 tokens\n",
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };

    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: sockPath,
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const t = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, t);
            return t;
          },
        }),
    });

    bridge.start();
    try {
      await bridge.poll();
      const t = transports.get("M1:herdr:pane-wS:p2");
      expect(t).toBeDefined();
      t!.open();
      t!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

      // Deliver slash command with asCommand: true
      t!.receive({
        v: 1,
        id: "m2",
        t: "user.message",
        ts: Date.now(),
        d: { clientMsgId: "c2", text: "/usage", asCommand: true },
      });

      // Verify immediate send-text + send-keys Enter and ack
      await vi.waitFor(() => {
        expect(calls).toContainEqual({ cmd: "herdr", args: ["pane", "send-text", "wS:p2", "/usage"] });
        expect(calls).toContainEqual({ cmd: "herdr", args: ["pane", "send-keys", "wS:p2", "Enter"] });
        expect(t!.sent.some((e) => e.t === "user.message.ack" && (e.d as any).disposition === "command")).toBe(true);
      }, { timeout: 3_000, interval: 10 });

      // Wait for the slash command fallback timer to fire and settle
      await vi.waitFor(() => {
        const userEnd = t!.sent.find(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "message_end" && (e.d as any).e?.message?.role === "user",
        );
        expect(userEnd).toBeDefined();
        const msgEnd = t!.sent.find(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "message_end" && (e.d as any).e?.message?.role === "assistant",
        );
        expect(msgEnd).toBeDefined();
        const content = ((msgEnd!.d as any).e.message.content[0] as any).text;
        expect(content).toContain("> /usage\n  Claude 3.7 Sonnet: 450 tokens");

        const settled = t!.sent.find((e) => e.t === "agent.event" && (e.d as any).e?.type === "agent_settled");
        expect(settled).toBeDefined();
      }, { timeout: 4_000, interval: 25 });

      // Test /term live terminal peek without typing /term into the pane
      t!.sent.length = 0;
      calls.length = 0;
      t!.receive({
        v: 1,
        id: "m3",
        t: "user.message",
        ts: Date.now(),
        d: { clientMsgId: "c3", text: "/term", asCommand: true },
      });

      await vi.waitFor(() => {
        expect(calls).not.toContainEqual({ cmd: "herdr", args: ["pane", "send-text", "wS:p2", "/term"] });
        expect(calls).toContainEqual({ cmd: "herdr", args: ["pane", "read", "--source", "recent", "--lines", "60", "wS:p2"] });
        const termEnd = t!.sent.find(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "message_end" && (e.d as any).e?.message?.role === "assistant",
        );
        expect(termEnd).toBeDefined();
        const termText = ((termEnd!.d as any).e.message.content[0] as any).text;
        expect(termText).toContain("Claude 3.7 Sonnet: 450 tokens");
      }, { timeout: 2_000, interval: 20 });
    } finally {
      bridge.stop();
    }
  });

  it("avoids fake timestamps on initial terminal snapshot and defers message_end on initial poll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-no-fake-ts-"));
    tmpDirs.push(dir);
    const sockPath = path.join(dir, "agy-gate.sock");
    const transports = new Map<string, FakeTransport>();

    const runner = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  agent: "codex",
                  pane_id: "wS:p3",
                  cwd: dir,
                  agent_status: "idle",
                  state_change_seq: 1,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (cmd === "herdr" && args[0] === "pane" && args[1] === "read") {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { text: "Existing terminal contents\n" } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };

    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: sockPath,
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const t = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, t);
            return t;
          },
        }),
    });

    bridge.start();
    try {
      await bridge.poll();
      const t = transports.get("M1:herdr:pane-wS:p3");
      expect(t).toBeDefined();
      t!.open();
      t!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

      // The initial snapshot must NOT have fake timestamps or entries before any turn
      const snapshotEnv = t!.sent.find((e) => e.t === "agent.snapshot");
      expect(snapshotEnv).toBeDefined();
      expect((snapshotEnv!.d as any).entries).toEqual([]);
      expect((snapshotEnv!.d as any).lastActivityAt).toBeUndefined();

      // Trigger poll now - initial poll must establish baseline without emitting message_end
      const session = bridge.getActiveSessions()[0]!;
      await session.pollTranscriptNow();

      const initialMessageEnd = t!.sent.find((e) => e.t === "agent.event" && (e.d as any).e?.type === "message_end");
      expect(initialMessageEnd).toBeUndefined();
    } finally {
      bridge.stop();
    }
  });

  it("does not produce an unhandled rejection if transcript reader throws during polling", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-throw-transcript-"));
    tmpDirs.push(dir);

    let unhandled: any = null;
    const onUnhandled = (reason: any) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const logs: string[] = [];
      const session = new BridgedAgentSession(
        {
          agent: "agy",
          sessionId: "conv-throw",
          status: "idle",
          cwd: dir,
          paneId: "wS:p9",
          tabId: null,
          workspaceId: null,
          title: null,
          stateChangeSeq: 1,
        },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          onLog: (m) => logs.push(m),
        },
      );

      const brokenReader = (session as any).transcriptReader;
      brokenReader.pollNewEvents = () => {
        throw new Error("simulated disk error in pollNewEvents");
      };

      // Call pollTranscriptNow() without await
      session.pollTranscriptNow();

      // Give event loop ticks to see if unhandledRejection is triggered
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).toBeNull();
      expect(logs.some((l) => l.includes("simulated disk error"))).toBe(true);

      session.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves Herdr visual order, closes pane fallback on migration, retires persisted orphans, and handles notifyPaneClosed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-lifecycle-"));
    tmpDirs.push(dir);
    const stateFile = path.join(dir, "herdr-active-sessions.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify([
        {
          agent: "agy",
          sessionId: "orphan-session",
          status: "idle",
          cwd: dir,
          paneId: "wOrphan:p1",
          tabId: "wOrphan:t1",
          workspaceId: "wOrphan",
          title: null,
          stateChangeSeq: 0,
        },
      ]),
    );

    let pollStep = 0;
    const transports = new Map<string, FakeTransport>();
    const runner = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        pollStep++;
        const agents =
          pollStep === 1
            ? [
                { agent: "agy", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: dir, agent_status: "idle" },
                {
                  agent: "agy",
                  pane_id: "w2:p1",
                  tab_id: "w2:t1",
                  workspace_id: "w2",
                  cwd: dir,
                  agent_status: "working",
                  agent_session: { value: "conv-second" },
                },
              ]
            : [
                {
                  agent: "agy",
                  pane_id: "w1:p1",
                  tab_id: "w1:t1",
                  workspace_id: "w1",
                  cwd: dir,
                  agent_status: "idle",
                  agent_session: { value: "conv-first" },
                },
                {
                  agent: "agy",
                  pane_id: "w2:p1",
                  tab_id: "w2:t1",
                  workspace_id: "w2",
                  cwd: dir,
                  agent_status: "idle",
                  agent_session: { value: "conv-second" },
                },
              ];
        return { code: 0, stdout: JSON.stringify({ result: { agents } }), stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };

    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: path.join(dir, "agy-gate.sock"),
      stateFile,
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const t = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, t);
            return t;
          },
        }),
    });

    try {
      await bridge.poll();

      // 1. Orphan session from previous run connects and sends agent.closed
      const orphanT = transports.get("M1:herdr:orphan-session");
      expect(orphanT).toBeDefined();
      orphanT!.open();
      orphanT!.receive({ v: 1, id: "wo", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      await vi.waitFor(() => {
        expect(orphanT!.sent.some((e) => e.t === "agent.closed" && (e.d as any).reason === "pane_closed")).toBe(true);
      }, { timeout: 2_000, interval: 10 });

      // 2. Priority sort places the working session (w2:p1) first (#0001) and the idle fallback (w1:p1) second (#0002)
      const fallbackT = transports.get("M1:herdr:pane-w1:p1");
      const secondT = transports.get("M1:herdr:conv-second");
      expect(fallbackT).toBeDefined();
      expect(secondT).toBeDefined();
      fallbackT!.open();
      fallbackT!.receive({ v: 1, id: "wf", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      secondT!.open();
      secondT!.receive({ v: 1, id: "ws", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
      expect((secondT!.sent[0]?.d as any).herdr.tabId).toBe("#0001|w2:t1");
      expect((fallbackT!.sent[0]?.d as any).herdr.tabId).toBe("#0002|w1:t1");

      // 3. On poll 2, w1:p1 gets sessionId "conv-first" -> pane-w1:p1 sends agent.closed
      await bridge.poll();
      expect(fallbackT!.sent.some((e) => e.t === "agent.closed" && (e.d as any).reason === "pane_closed")).toBe(true);

      const firstT = transports.get("M1:herdr:conv-first");
      expect(firstT).toBeDefined();
      firstT!.open();
      firstT!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

      // 4. notifyPaneClosed immediately sends agent.closed and suppresses revival on poll
      bridge.notifyPaneClosed("w2:p1");
      expect(secondT!.sent.some((e) => e.t === "agent.closed" && (e.d as any).reason === "pane_closed")).toBe(true);
    } finally {
      bridge.stop();
    }
  });

  it("deduplicates user.message by clientMsgId, rejects agent_blocked without send-text, expires optimistic working, rejects unauthenticated gate IPC, and defers promotion while gate prompts are open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-hardening-"));
    tmpDirs.push(dir);
    const sockPath = path.join(dir, "gate.sock");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let pollStep = 0;

    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
        pollStep++;
        const agents =
          pollStep === 1
            ? [{ agent: "agy", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: dir, agent_status: "idle" }]
            : [
                {
                  agent: "agy",
                  pane_id: "w1:p1",
                  tab_id: "w1:t1",
                  workspace_id: "w1",
                  cwd: dir,
                  agent_status: "idle",
                  agent_session: { value: "conv-promoted" },
                },
              ];
        return { code: 0, stdout: JSON.stringify({ result: { agents } }), stderr: "" };
      }
      if (cmd === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        if (args.includes("blocked prompt")) {
          return { code: 1, stdout: "", stderr: "agent_blocked: dialog open" };
        }
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };

    const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
    const transports = new Map<string, FakeTransport>();
    const bridge = new HerdrAgentBridge({
      relayUrl: "https://relay.example.com",
      machineId: "M1",
      token: "T1",
      cfg,
      herdrSession: null,
      runner,
      socketPath: sockPath,
      stateFile: null,
      pollIntervalMs: 60_000,
      connectionFactory: (opts) =>
        new Connection({
          ...opts,
          transportFactory: (_name, handlers) => {
            const t = new FakeTransport("ws", handlers);
            transports.set(opts.agentId, t);
            return t;
          },
        }),
    });

    bridge.start();
    try {
      await bridge.poll();
      const t1 = transports.get("M1:herdr:pane-w1:p1")!;
      t1.open();
      t1.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

      // 1. clientMsgId deduplication prevents duplicate prompt injection
      t1.receive({ v: 1, id: "m1", t: "user.message", ts: Date.now(), d: { clientMsgId: "dup-1", text: "first prompt" } });
      await vi.waitFor(() => {
        expect(t1.sent.some((e) => e.t === "user.message.ack" && (e.d as any).clientMsgId === "dup-1")).toBe(true);
      });
      t1.receive({ v: 1, id: "m2", t: "user.message", ts: Date.now(), d: { clientMsgId: "dup-1", text: "first prompt" } });
      await new Promise((r) => setTimeout(r, 30));
      const promptCalls = calls.filter((c) => c.cmd === "herdr" && c.args[0] === "agent" && c.args[1] === "prompt" && c.args.includes("first prompt"));
      expect(promptCalls).toHaveLength(1);
      expect(t1.sent.filter((e) => e.t === "user.message.ack" && (e.d as any).clientMsgId === "dup-1")).toHaveLength(2);

      // 2. agent_blocked rejects cleanly without pane send-text fallback
      t1.receive({ v: 1, id: "m3", t: "user.message", ts: Date.now(), d: { clientMsgId: "blk-1", text: "blocked prompt" } });
      await vi.waitFor(() => {
        expect(t1.sent.some((e) => e.t === "user.message.ack" && (e.d as any).clientMsgId === "blk-1")).toBe(true);
      });
      const blkAck = t1.sent.find((e) => e.t === "user.message.ack" && (e.d as any).clientMsgId === "blk-1")!;
      expect(blkAck.d).toEqual({ clientMsgId: "blk-1", disposition: "rejected", method: "herdr", error: "agent_blocked" });
      expect(calls.some((c) => c.cmd === "herdr" && c.args[0] === "pane" && c.args[1] === "send-text")).toBe(false);

      // 3. Unauthenticated gate socket client request fails closed without opening a prompt
      const rawResp = await new Promise<any>((resolve, reject) => {
        const client = net.createConnection(sockPath);
        client.setEncoding("utf8");
        let out = "";
        client.on("connect", () => {
          client.write(JSON.stringify({ conversationId: "conv-unauth", paneId: "w1:p1", command: "sudo ls", nonce: "n1", sig: "0000" }) + "\n");
        });
        client.on("data", (chunk) => {
          out += chunk;
          if (out.includes("\n")) {
            client.destroy();
            resolve(JSON.parse(out.trim()));
          }
        });
        client.on("error", reject);
      });
      expect(rawResp.decision).toBe("ask");
      expect(t1.sent.some((e) => e.t === "prompt.open")).toBe(false);

      // 4. Open gate prompt on pane fallback defers pane promotion across poll, then completes once resolved
      const prevPaneEnv = process.env.HERDR_PANE_ID;
      process.env.HERDR_PANE_ID = "w1:p1";
      let gatePromise: ReturnType<typeof runAgyHook>;
      try {
        gatePromise = runAgyHook(
          cfg,
          JSON.stringify({ conversationId: "conv-during-gate", toolCall: { name: "run_command", args: { CommandLine: '"sudo ls"' } } }),
          sockPath,
        );
      } finally {
        if (prevPaneEnv === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = prevPaneEnv;
      }
      await vi.waitFor(() => {
        expect(t1.sent.some((e) => e.t === "prompt.open")).toBe(true);
      });
      const promptId = (t1.sent.find((e) => e.t === "prompt.open")!.d as any).promptId as string;

      // Poll while gate prompt is open -> pane-w1:p1 stays alive, no agent.closed yet
      await bridge.poll();
      expect(t1.sent.some((e) => e.t === "agent.closed")).toBe(false);
      expect(transports.has("M1:herdr:conv-promoted")).toBe(false);

      t1.receive({ v: 1, id: "pa-defer", t: "prompt.answer", ts: Date.now(), d: { promptId, answer: { optionIds: ["0"] } } });
      await expect(gatePromise).resolves.toEqual({ decision: "allow" });

      // Next poll after prompt closes completes promotion seamlessly
      await bridge.poll();
      expect(t1.sent.some((e) => e.t === "agent.closed" && (e.d as any).reason === "pane_closed")).toBe(true);
      expect(transports.has("M1:herdr:conv-promoted")).toBe(true);
    } finally {
      bridge.stop();
    }
  });

  it("expires optimistic working state and emits agent_settled when Herdr stays idle", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-optimistic-"));
    tmpDirs.push(dir);
    try {
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const t = { instance: null as FakeTransport | null };
      const runner = async () => ({ code: 0, stdout: "{}", stderr: "" });
      const session = new BridgedAgentSession(
        { agent: "codex", sessionId: null, status: "idle", cwd: dir, paneId: "w9:p1", tabId: null, workspaceId: "w9", title: null, stateChangeSeq: 0 },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner,
          connectionFactory: (opts) =>
            new Connection({
              ...opts,
              transportFactory: (_name, handlers) => {
                const ft = new FakeTransport("ws", handlers);
                t.instance = ft;
                return ft;
              },
            }),
        },
      );
      try {
        t.instance!.open();
        t.instance!.receive({ v: 1, id: "w", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
        t.instance!.receive({ v: 1, id: "u", t: "user.message", ts: Date.now(), d: { clientMsgId: "opt-1", text: "ping" } });
        await vi.waitFor(() => {
          expect(t.instance!.sent.some((e) => e.t === "agent.status" && (e.d as any).status === "working")).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(8_200);
        const statuses = t.instance!.sent.filter((e) => e.t === "agent.status").map((e) => (e.d as any).status);
        expect(statuses[statuses.length - 1]).toBe("idle");
        expect(t.instance!.sent.some((e) => e.t === "agent.event" && (e.d as any).e?.type === "agent_settled")).toBe(true);
      } finally {
        session.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-emits AGY subagents after early pollTranscriptNow on snapshot/resync and keeps fast 900ms polling while running", async () => {
    vi.useFakeTimers();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-sub-home-"));
    tmpDirs.push(homeDir);
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    try {
      const parentConv = "conv-parent-sub";
      const childConv = "conv-child-sub";
      const parentPath = resolveAgyTranscriptPath(parentConv, homeDir);
      const childPath = resolveAgyTranscriptPath(childConv, homeDir);
      fs.mkdirSync(path.dirname(parentPath), { recursive: true });
      fs.mkdirSync(path.dirname(childPath), { recursive: true });

      fs.writeFileSync(
        parentPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-14T10:00:00Z",
            tool_calls: [{ name: "invoke_subagent", args: { Role: "Researcher", TypeName: "research", Prompt: "Check" } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-11-14T10:00:01Z",
            content: JSON.stringify({ conversationId: childConv, logAbsoluteUri: pathToFileURL(childPath).href }),
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const t = { instance: null as FakeTransport | null };
      const session = new BridgedAgentSession(
        { agent: "agy", sessionId: parentConv, status: "idle", cwd: homeDir, paneId: "w1:p1", tabId: null, workspaceId: "w1", title: null, stateChangeSeq: 0 },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          connectionFactory: (opts) =>
            new Connection({
              ...opts,
              transportFactory: (_name, handlers) => {
                const ft = new FakeTransport("ws", handlers);
                t.instance = ft;
                return ft;
              },
            }),
        },
      );

      try {
        // Early poll before welcome queues events that dropQueuedEventsUpTo(this.seq) clears
        await session.pollTranscriptNow();

        t.instance!.open();
        t.instance!.receive({ v: 1, id: "w", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        const snap = t.instance!.sent.find((e) => e.t === "agent.snapshot");
        expect(snap).toBeDefined();
        const snapSeq = (snap!.d as any).seq as number;
        const subEventsAfterSnap = t.instance!.sent.filter(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "subagent_update" && (e.d as any).seq > snapSeq,
        );
        expect(subEventsAfterSnap).toHaveLength(1);
        expect((subEventsAfterSnap[0]!.d as any).e).toMatchObject({
          taskId: "agy:0:0",
          label: "Researcher",
          status: "running",
        });

        // Fast 900ms polling runs even though session status is "idle", picking up child transcript updates
        fs.writeFileSync(
          childPath,
          JSON.stringify({
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-14T10:00:02Z",
            tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/repo/x.ts"' } }],
          }) + "\n",
        );
        await vi.advanceTimersByTimeAsync(950);
        const childUpdated = t.instance!.sent.filter(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "subagent_update" && ((e.d as any).e?.tools?.length ?? 0) > 0,
        );
        expect(childUpdated.length).toBeGreaterThanOrEqual(1);
        expect((childUpdated[childUpdated.length - 1]!.d as any).e.tools).toEqual(["read"]);

        // Resync (sendSnapshot(false)) also emits current subagents after the new agent.snapshot
        const prevSentCount = t.instance!.sent.length;
        t.instance!.receive({ v: 1, id: "r1", t: "agent.resync", ts: Date.now(), d: {} });
        const afterResync = t.instance!.sent.slice(prevSentCount);
        const resyncSnap = afterResync.find((e) => e.t === "agent.snapshot");
        expect(resyncSnap).toBeDefined();
        const resyncSnapSeq = (resyncSnap!.d as any).seq as number;
        const resyncSub = afterResync.find(
          (e) => e.t === "agent.event" && (e.d as any).e?.type === "subagent_update" && (e.d as any).seq > resyncSnapSeq,
        );
        expect(resyncSub).toBeDefined();
        expect((resyncSub!.d as any).e.tools).toEqual(["read"]);
      } finally {
        session.stop();
      }
    } finally {
      homeSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("tracks child subagent model from requested Model arg and child session db instead of locking global settings.json", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-sub-model-"));
    tmpDirs.push(homeDir);
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    try {
      const agyCliDir = path.join(homeDir, ".gemini", "antigravity-cli");
    fs.mkdirSync(path.join(agyCliDir, "conversations"), { recursive: true });
    fs.writeFileSync(path.join(agyCliDir, "settings.json"), JSON.stringify({ model: "Gemini 4 Hydrogen (High)" }));

    const parentConv = "conv-parent-model";
    const childConv = "conv-child-flash";
    const parentPath = resolveAgyTranscriptPath(parentConv, homeDir);
    const childPath = resolveAgyTranscriptPath(childConv, homeDir);
    fs.mkdirSync(path.dirname(parentPath), { recursive: true });
    fs.mkdirSync(path.dirname(childPath), { recursive: true });

    fs.writeFileSync(
      parentPath,
      [
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:00Z",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: { Role: "Flash Probe", TypeName: "research", Model: "flash", Prompt: "Check" },
            },
          ],
        },
        {
          step_index: 1,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-14T10:00:01Z",
          content: JSON.stringify({ conversationId: childConv, logAbsoluteUri: pathToFileURL(childPath).href }),
        },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
    );

    const reader = new AgyTranscriptReader(parentPath);
    const firstEvents = reader.pollNewEvents();
    const initialSub = firstEvents.find((e) => e.type === "subagent_update") as any;
    expect(initialSub?.model).toBe("flash");
    expect(reader.getSubagents()[0]?.model).toBe("flash");

    // Once the child conversation writes gen_metadata to its own sqlite db, poll upgrades model cleanly
    const db = new DatabaseSync(path.join(agyCliDir, "conversations", `${childConv}.db`));
    try {
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      const modelId = "gemini-3.8-flash-tiered";
      const blob = Buffer.concat([Buffer.from([0xaa, 0x01, modelId.length]), Buffer.from(modelId, "utf8")]);
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(1, blob);
    } finally {
      db.close();
    }

    fs.writeFileSync(
      childPath,
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-14T10:00:02Z",
        tool_calls: [{ name: "read_file", args: { Path: "/repo/a.ts" } }],
      }) + "\n",
    );

    const secondEvents = reader.pollNewEvents();
    const upgradedSub = secondEvents.find((e) => e.type === "subagent_update") as any;
    expect(upgradedSub?.model).toBe("gemini-3.8-flash-tiered");
    expect(reader.getSubagents()[0]?.model).toBe("gemini-3.8-flash-tiered");
    } finally {
      homeSpy.mockRestore();
    }
  });

  it("omits completed pre-snapshot subagents after agent.snapshot while retaining recent and running ones", () => {
    vi.useFakeTimers();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-herdr-sub-trunc-"));
    tmpDirs.push(homeDir);
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    try {
      const parentConv = "conv-parent-trunc";
      const oldChildConv = "conv-child-old";
      const recentChildConv = "conv-child-recent";
      const parentPath = resolveAgyTranscriptPath(parentConv, homeDir);
      const oldChildPath = resolveAgyTranscriptPath(oldChildConv, homeDir);
      const recentChildPath = resolveAgyTranscriptPath(recentChildConv, homeDir);
      fs.mkdirSync(path.dirname(parentPath), { recursive: true });
      fs.mkdirSync(path.dirname(oldChildPath), { recursive: true });
      fs.mkdirSync(path.dirname(recentChildPath), { recursive: true });

      const steps: unknown[] = [
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:00:00Z",
          tool_calls: [{ name: "invoke_subagent", args: { Role: "Old Worker", TypeName: "odd-worker", Prompt: "Old" } }],
        },
        {
          step_index: 1,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-14T10:00:01Z",
          content: JSON.stringify({ conversationId: oldChildConv, logAbsoluteUri: pathToFileURL(oldChildPath).href }),
        },
        {
          step_index: 2,
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-14T10:00:02Z",
          content: `[Message] timestamp=2026-11-14T10:00:02Z sender=${oldChildConv} priority=MESSAGE_PRIORITY_HIGH content=Old finished`,
        },
      ];
      // Push enough subsequent turns to evict the old completed worker out of SNAPSHOT_LIMIT (200 entries)
      let idx = 3;
      for (let i = 0; i < 210; i++) {
        steps.push({
          step_index: idx++,
          type: "USER_INPUT",
          created_at: "2026-11-14T10:01:00Z",
          content: `<USER_REQUEST>msg ${i}</USER_REQUEST>`,
        });
      }
      steps.push(
        {
          step_index: idx++,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T10:02:00Z",
          tool_calls: [{ name: "invoke_subagent", args: { Role: "Recent Worker", TypeName: "research", Prompt: "New" } }],
        },
        {
          step_index: idx++,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-14T10:02:01Z",
          content: JSON.stringify({ conversationId: recentChildConv, logAbsoluteUri: pathToFileURL(recentChildPath).href }),
        },
        {
          step_index: idx++,
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-14T10:02:02Z",
          content: `[Message] timestamp=2026-11-14T10:02:02Z sender=${recentChildConv} priority=MESSAGE_PRIORITY_HIGH content=Recent finished`,
        },
      );
      fs.writeFileSync(parentPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const t = { instance: null as FakeTransport | null };
      const session = new BridgedAgentSession(
        { agent: "agy", sessionId: parentConv, status: "idle", cwd: homeDir, paneId: "w1:p1", tabId: null, workspaceId: "w1", title: null, stateChangeSeq: 0 },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          connectionFactory: (opts) =>
            new Connection({
              ...opts,
              transportFactory: (_name, handlers) => {
                const ft = new FakeTransport("ws", handlers);
                t.instance = ft;
                return ft;
              },
            }),
        },
      );

      try {
        t.instance!.open();
        t.instance!.receive({ v: 1, id: "w", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        const snap = t.instance!.sent.find((e) => e.t === "agent.snapshot");
        expect(snap).toBeDefined();
        expect((snap!.d as any).truncated).toBe(true);
        const snapSeq = (snap!.d as any).seq as number;
        const postSnapSubs = t.instance!.sent
          .filter((e) => e.t === "agent.event" && (e.d as any).e?.type === "subagent_update" && (e.d as any).seq > snapSeq)
          .map((e) => (e.d as any).e.label);

        expect(postSnapSubs).toEqual(["Recent Worker"]);
        expect(postSnapSubs).not.toContain("Old Worker");
      } finally {
        session.stop();
      }
    } finally {
      homeSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("agy background run_command tasks", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setupBgWorkspace() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-bg-"));
    dirs.push(tmp);
    const homeDir = path.join(tmp, "home");
    const convId = "bgparent-1111-2222-3333-444455556666";
    const transcriptPath = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      convId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    const tasksDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      convId,
      ".system_generated",
      "tasks",
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    return { homeDir, convId, transcriptPath, tasksDir };
  }

  it("keeps background run_command running with live log tails until completion SYSTEM_MESSAGE", () => {
    const { convId, transcriptPath, tasksDir } = setupBgWorkspace();
    const taskId = "task-10";
    const taskSender = `${convId}/${taskId}`;
    const logPath = path.join(tasksDir, `${taskId}.log`);
    fs.writeFileSync(logPath, "Building project...\n");

    const appendSteps = (steps: unknown[]) => {
      fs.appendFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    };

    appendSteps([
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-14T22:00:00Z",
        tool_calls: [
          {
            id: "call-deploy-1",
            name: "run_command",
            args: { CommandLine: '"npm run deploy"', toolSummary: '"Deploy cloud functions"' },
          },
        ],
      },
      {
        step_index: 1,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-14T22:00:05Z",
        content: [
          "Created At: 2026-11-14T22:00:00-05:00",
          `Tool is running as a background task with task id: ${taskSender}`,
          "Task Description: npm run deploy",
          `Task logs are available at: ${pathToFileURL(logPath).href}`,
          "Log output:",
          "Building project...",
        ].join("\n"),
      },
    ]);

    const reader = new AgyTranscriptReader(transcriptPath);
    const snap = reader.readSnapshot();
    expect(snap.events.some((e) => e.type === "tool_execution_end")).toBe(false);
    expect(reader.hasRunningBackgroundTasks()).toBe(true);
    expect(reader.getActiveTask()).toBe("Deploy cloud functions");
    const startUpdates = snap.events.filter((e) => e.type === "tool_execution_update");
    expect(startUpdates.length).toBeGreaterThanOrEqual(1);
    expect((startUpdates.at(-1) as any).partialResult.content[0].text).toContain("Building project...");

    // Log grows asynchronously before transcript.jsonl appends anything new
    fs.appendFileSync(logPath, "Deploying endpoint alpha...\n");
    const poll1 = reader.pollNewEvents();
    expect(poll1.some((e) => e.type === "tool_execution_end")).toBe(false);
    const update1 = poll1.find((e) => e.type === "tool_execution_update") as any;
    expect(update1).toBeDefined();
    expect(update1.toolCallId).toBe("call-deploy-1");
    expect(update1.partialResult.content[0].text).toContain("Deploying endpoint alpha...");

    // Intermediate stabilization notice must NOT finish the background task
    appendSteps([
      {
        step_index: 2,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-14T22:00:15Z",
        content: `[Message] timestamp=2026-11-14T22:00:15Z sender=${taskSender} priority=MESSAGE_PRIORITY_HIGH content=The command output has stabilized for 5s. The output delta since last report is:\nStill deploying...`,
      },
    ]);
    const poll2 = reader.pollNewEvents();
    expect(poll2.some((e) => e.type === "tool_execution_end")).toBe(false);
    expect(reader.hasRunningBackgroundTasks()).toBe(true);

    // Final completion notice finishes the tool cleanly
    appendSteps([
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-14T22:00:30Z",
        content: `[Message] timestamp=2026-11-14T22:00:30Z sender=${taskSender} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskSender}" finished with result:\n\nCommand exited with code 0.\n\nCommand output:\nDeployed OK`,
      },
    ]);
    const poll3 = reader.pollNewEvents();
    const endEv = poll3.find((e) => e.type === "tool_execution_end") as any;
    expect(endEv).toBeDefined();
    expect(endEv.toolCallId).toBe("call-deploy-1");
    expect(endEv.toolName).toBe("bash");
    expect(endEv.isError).toBe(false);
    expect(endEv.durationMs).toBe(30_003);
    expect(endEv.result.content[0].text).toContain("Deployed OK");
    expect(reader.hasRunningBackgroundTasks()).toBe(false);
  });

  it("handles non-zero exit code, safe log path confinement, daemons, kill, and redactContent", () => {
    const { convId, transcriptPath, tasksDir } = setupBgWorkspace();
    const taskFail = `${convId}/task-11`;
    const taskDaemon = `${convId}/task-12`;
    const taskKill = `${convId}/task-13`;
    const canonicalFailLog = path.join(tasksDir, "task-11.log");
    const daemonLog = path.join(tasksDir, "task-12.log");
    fs.writeFileSync(canonicalFailLog, "Safe log line\n");
    fs.writeFileSync(daemonLog, "Server listening on 3000\n");

    const lines = [
      // Traversal URI should fall back to canonical tasksDir/task-11.log
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-14T22:01:00Z",
        tool_calls: [{ id: "call-fail", name: "run_command", args: { CommandLine: '"npm test"' } }],
      },
      {
        step_index: 1,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-14T22:01:05Z",
        content: [
          `Tool is running as a background task with task id: ${taskFail}`,
          "Task logs are available at: file:///etc/passwd",
        ].join("\n"),
      },
      // Daemon task should stream updates without marking foreground work as running
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-14T22:01:06Z",
        tool_calls: [
          {
            id: "call-daemon",
            name: "run_command",
            args: { CommandLine: '"npm run dev"', IsDaemon: true },
          },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-14T22:01:07Z",
        content: [
          `Tool is running as a background task with task id: ${taskDaemon}`,
          `Task logs are available at: ${pathToFileURL(daemonLog).href}`,
        ].join("\n"),
      },
    ];
    fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    let redact = false;
    const reader = new AgyTranscriptReader(transcriptPath, () => redact);
    const snap = reader.readSnapshot();
    const failUpdate = snap.events.find((e) => e.type === "tool_execution_update" && e.toolCallId === "call-fail") as any;
    expect(failUpdate?.partialResult?.content?.[0]?.text).toContain("Safe log line");
    expect(failUpdate?.partialResult?.content?.[0]?.text).not.toContain("root:");
    // Foreground fail task is running, daemon is excluded from foreground status
    expect(reader.hasRunningBackgroundTasks()).toBe(true);

    // Finish fail task with code 1
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-14T22:01:20Z",
        content: `[Message] timestamp=2026-11-14T22:01:20Z sender=${taskFail} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskFail}" finished with result:\n\nThe command exited with code 1`,
      }) + "\n",
    );
    const evFail = reader.pollNewEvents();
    const failEnd = evFail.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call-fail") as any;
    expect(failEnd).toBeDefined();
    expect(failEnd.isError).toBe(true);
    // Only daemon remains -> hasRunningBackgroundTasks() is false
    expect(reader.hasRunningBackgroundTasks()).toBe(false);

    // Start task-13 then kill it via manage_task while redacted
    redact = true;
    fs.appendFileSync(
      transcriptPath,
      [
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-14T22:01:30Z",
          tool_calls: [{ id: "call-kill", name: "run_command", args: { CommandLine: '"sleep 99"' } }],
        },
        {
          step_index: 6,
          type: "GENERIC",
          status: "RUNNING",
          created_at: "2026-11-14T22:01:35Z",
          content: `Tool is running as a background task with task id: ${taskKill}\nLog output:\nsecret output`,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const evRedactedStart = reader.pollNewEvents();
    expect(evRedactedStart.some((e) => e.type === "tool_execution_update")).toBe(false);
    expect(reader.hasRunningBackgroundTasks()).toBe(true);

    fs.appendFileSync(
      transcriptPath,
      [
        {
          step_index: 7,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-14T22:01:40Z",
          tool_calls: [{ id: "call-mt", name: "manage_task", args: { Action: '"kill"', TaskId: `"${taskKill}"` } }],
        },
        {
          step_index: 8,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-14T22:01:41Z",
          content: `Killed task ${taskKill}`,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const evKilled = reader.pollNewEvents();
    const killedEnd = evKilled.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call-kill") as any;
    expect(killedEnd).toBeDefined();
    expect(killedEnd.result).toBeUndefined();
    expect(reader.hasRunningBackgroundTasks()).toBe(false);
  });

  it("keeps BridgedAgentSession working with detail and streams live log tails even after Herdr reports done", async () => {
    vi.useFakeTimers();
    const { homeDir, convId, transcriptPath, tasksDir } = setupBgWorkspace();
    const taskSender = `${convId}/task-99`;
    const logPath = path.join(tasksDir, "task-99.log");
    fs.writeFileSync(logPath, "Step 1: compiling\n");
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    try {
      fs.writeFileSync(
        transcriptPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-14T22:05:00Z",
            tool_calls: [{ id: "call-bg-bridge", name: "run_command", args: { CommandLine: '"npm run build"', toolSummary: '"Build release"' } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-14T22:05:05Z",
            content: [
              `Tool is running as a background task with task id: ${taskSender}`,
              `Task logs are available at: ${pathToFileURL(logPath).href}`,
              "Log output:",
              "Step 1: compiling",
            ].join("\n"),
          },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const t = { instance: null as FakeTransport | null };
      const session = new BridgedAgentSession(
        { agent: "agy", sessionId: convId, status: "working", cwd: homeDir, paneId: "w1:p1", tabId: "t1", workspaceId: "w1", title: null, stateChangeSeq: 1 },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          connectionFactory: (opts) =>
            new Connection({
              ...opts,
              transportFactory: (_name, handlers) => {
                const ft = new FakeTransport("ws", handlers);
                t.instance = ft;
                return ft;
              },
            }),
        },
      );

      try {
        t.instance!.open();
        t.instance!.receive({ v: 1, id: "w", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        // Herdr transitions to "done" while background task is still active
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "done",
          cwd: homeDir,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 2,
        });

        const statusesWhileBg = t.instance!.sent.filter((e) => e.t === "agent.status").map((e) => (e.d as any).status);
        expect(statusesWhileBg).not.toContain("done");
        expect(t.instance!.sent.some((e) => e.t === "agent.event" && (e.d as any).e?.type === "agent_settled")).toBe(false);

        // Append live log line and advance 900ms poll timer
        fs.appendFileSync(logPath, "Step 2: bundling\n");
        await vi.advanceTimersByTimeAsync(950);

        const updates = t.instance!.sent.filter((e) => e.t === "agent.event" && (e.d as any).e?.type === "tool_execution_update");
        expect(updates.some((e) => String((e.d as any).e?.partialResult?.content?.[0]?.text ?? "").includes("Step 2: bundling"))).toBe(true);

        // Reconnect / resync still restores the running background log tail
        const sentBeforeResync = t.instance!.sent.length;
        t.instance!.receive({ v: 1, id: "r1", t: "agent.resync", ts: Date.now(), d: {} });
        const afterResync = t.instance!.sent.slice(sentBeforeResync);
        expect(afterResync.some((e) => e.t === "agent.event" && (e.d as any).e?.type === "tool_execution_update")).toBe(true);

        // Complete the background task via SYSTEM_MESSAGE -> settles and flips to done
        fs.appendFileSync(
          transcriptPath,
          JSON.stringify({
            step_index: 2,
            type: "SYSTEM_MESSAGE",
            status: "DONE",
            created_at: "2026-11-14T22:05:25Z",
            content: `[Message] timestamp=2026-11-14T22:05:25Z sender=${taskSender} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskSender}" finished with result:\n\nCommand exited with code 0.\n\nCommand output:\nAll built`,
          }) + "\n",
        );
        await vi.advanceTimersByTimeAsync(950);

        expect(t.instance!.sent.some((e) => e.t === "agent.event" && (e.d as any).e?.type === "tool_execution_end" && (e.d as any).e?.toolCallId === "call-bg-bridge")).toBe(true);
        expect(t.instance!.sent.some((e) => e.t === "agent.status" && (e.d as any).status === "done")).toBe(true);
        expect(t.instance!.sent.some((e) => e.t === "agent.event" && (e.d as any).e?.type === "agent_settled")).toBe(true);
      } finally {
        session.stop();
      }
    } finally {
      homeSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
