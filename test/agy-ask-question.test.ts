import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RpConfig } from "../src/extension/config.ts";
import { Connection, type Transport, type TransportHandlers, type TransportName } from "../src/extension/connection.ts";
import { AgyTranscriptReader } from "../src/host/agy-transcript.ts";
import {
  buildAskQuestionKeystrokePlan,
  buildAskQuestionPromptSpec,
  deliverAskQuestionPlan,
  isAgyAskQuestionToolName,
  parseAgyAskQuestionArgs,
} from "../src/host/bridge/agy-ask-question.ts";
import { BridgedAgentSession } from "../src/host/herdr-bridge.ts";
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

function inbound(t: string, d: unknown): Envelope {
  return { v: 1, id: `in-${Math.random().toString(36).slice(2)}`, t, ts: Date.now(), d };
}

async function flushAsync(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 15));
}

describe("agy-ask-question pure helpers", () => {
  it("matches bare and namespaced ask_question tool names", () => {
    expect(isAgyAskQuestionToolName("ask_question")).toBe(true);
    expect(isAgyAskQuestionToolName("default_api:ask_question")).toBe(true);
    expect(isAgyAskQuestionToolName("run_command")).toBe(false);
    expect(isAgyAskQuestionToolName(null)).toBe(false);
  });

  it("parses both JSON-stringified and array questions arguments", () => {
    const fromJsonString = parseAgyAskQuestionArgs({
      questions: JSON.stringify([
        {
          question: "Which deployment strategy?",
          options: ["(Recommended) Rolling", "Blue-green", "Canary"],
          is_multi_select: false,
        },
      ]),
    });
    expect(fromJsonString).toEqual({
      questions: [
        {
          question: "Which deployment strategy?",
          options: ["(Recommended) Rolling", "Blue-green", "Canary"],
          multiSelect: false,
        },
      ],
    });

    const fromArray = parseAgyAskQuestionArgs({
      questions: [
        {
          question: "Select target platforms",
          options: ["Android", "iOS", "Desktop"],
          is_multi_select: true,
        },
      ],
    });
    expect(fromArray).toEqual({
      questions: [
        {
          question: "Select target platforms",
          options: ["Android", "iOS", "Desktop"],
          multiSelect: true,
        },
      ],
    });

    expect(parseAgyAskQuestionArgs({ questions: "not-json" })).toBeNull();
    expect(parseAgyAskQuestionArgs({ questions: [] })).toBeNull();
    expect(parseAgyAskQuestionArgs({})).toBeNull();
  });

  it("builds questionnaire prompt specs respecting the 4-question wire batch cap", () => {
    const spec = {
      questions: Array.from({ length: 5 }, (_, i) => ({
        question: `Question ${i + 1}?`,
        options: ["Yes", "No"],
        multiSelect: i === 2,
      })),
    };

    const batch0 = buildAskQuestionPromptSpec(spec, 0);
    expect(batch0.kind).toBe("questionnaire");
    expect(batch0.title).toBe("Questions 1–4 of 5");
    expect(batch0.questions).toHaveLength(4);
    expect(batch0.questions?.[0]?.header).toBe("1/5");
    expect(batch0.questions?.[2]?.multiSelect).toBe(true);
    expect(batch0.questions?.[0]?.allowFreeText).toBe(true);

    const batch1 = buildAskQuestionPromptSpec(spec, 4);
    expect(batch1.title).toBe("Questions 5–5 of 5");
    expect(batch1.questions).toHaveLength(1);
    expect(batch1.questions?.[0]?.header).toBe("5/5");
  });

  it("plans single-select predefined and custom write-in keystrokes", () => {
    const spec = {
      questions: [{ question: "Pick one", options: ["A", "B", "C"], multiSelect: false }],
    };

    expect(
      buildAskQuestionKeystrokePlan(spec, { answers: [{ questionIndex: 0, optionIds: ["0"] }] }),
    ).toEqual([{ type: "keys", keys: ["enter"] }]);

    expect(
      buildAskQuestionKeystrokePlan(spec, { answers: [{ questionIndex: 0, optionIds: ["2"] }] }),
    ).toEqual([
      { type: "keys", keys: ["down", "down"] },
      { type: "keys", keys: ["enter"] },
    ]);

    expect(
      buildAskQuestionKeystrokePlan(spec, { answers: [{ questionIndex: 0, text: "Custom\nanswer" }] }),
    ).toEqual([
      { type: "keys", keys: ["down", "down", "down"] },
      { type: "keys", keys: ["enter"] },
      { type: "text", text: "Custom answer" },
      { type: "keys", keys: ["enter"] },
    ]);
  });

  it("plans multi-select checkboxes, optional write-in, multi-question, and cancel", () => {
    const spec = {
      questions: [
        { question: "Modules", options: ["Auth", "Sync", "Push", "UI"], multiSelect: true },
        { question: "Extra", options: ["Default", "Strict"], multiSelect: true },
        { question: "Mode", options: ["Fast", "Safe"], multiSelect: false },
      ],
    };

    expect(
      buildAskQuestionKeystrokePlan(spec, {
        answers: [
          { questionIndex: 0, optionIds: ["3", "1"] },
          { questionIndex: 1, optionIds: ["0"], text: "custom-flag" },
          { questionIndex: 2, optionIds: ["1"] },
        ],
      }),
    ).toEqual([
      // Q1: cursor 0 -> 1 (space) -> 3 (space) -> enter
      { type: "keys", keys: ["down"] },
      { type: "keys", keys: ["space"] },
      { type: "keys", keys: ["down", "down"] },
      { type: "keys", keys: ["space"] },
      { type: "keys", keys: ["enter"] },
      // Q2: cursor 0 (space) -> 2 (Other) -> enter -> text -> enter
      { type: "keys", keys: ["space"] },
      { type: "keys", keys: ["down", "down"] },
      { type: "keys", keys: ["enter"] },
      { type: "text", text: "custom-flag" },
      { type: "keys", keys: ["enter"] },
      // Q3: cursor 0 -> 1 -> enter
      { type: "keys", keys: ["down"] },
      { type: "keys", keys: ["enter"] },
    ]);

    // Cancel sends one esc per remaining question
    expect(buildAskQuestionKeystrokePlan(spec, { cancelled: true }, 0)).toEqual([
      { type: "keys", keys: ["esc"] },
      { type: "keys", keys: ["esc"] },
      { type: "keys", keys: ["esc"] },
    ]);
    expect(buildAskQuestionKeystrokePlan(spec, { cancelled: true }, 1)).toEqual([
      { type: "keys", keys: ["esc"] },
      { type: "keys", keys: ["esc"] },
    ]);

    // Incomplete answer rejected
    expect(
      buildAskQuestionKeystrokePlan(spec, { answers: [{ questionIndex: 0, optionIds: ["0"] }] }),
    ).toBeNull();
  });

  it("delivers keystroke plans with leading-dash guard and abort check", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });

    const ok = await deliverAskQuestionPlan(
      runner,
      "w1:p1",
      { HERDR_SESSION: "default" },
      [
        { type: "keys", keys: ["down", "down"] },
        { type: "keys", keys: ["enter"] },
        { type: "text", text: "--custom-option" },
        { type: "keys", keys: ["enter"] },
      ],
      { stepDelayMs: 0 },
    );

    expect(ok).toBe(true);
    expect(calls).toEqual([
      ["pane", "send-keys", "w1:p1", "down", "down"],
      ["pane", "send-keys", "w1:p1", "enter"],
      ["pane", "send-text", "w1:p1", "--", "--custom-option"],
      ["pane", "send-keys", "w1:p1", "enter"],
    ]);

    let aborted = false;
    const abortCalls: string[][] = [];
    const abortRunner = vi.fn(async (_cmd: string, args: string[]) => {
      abortCalls.push(args);
      aborted = true;
      return { code: 0, stdout: "", stderr: "" };
    });
    const ok2 = await deliverAskQuestionPlan(
      abortRunner,
      "w1:p1",
      {},
      [
        { type: "keys", keys: ["down"] },
        { type: "keys", keys: ["enter"] },
      ],
      { stepDelayMs: 0, shouldAbort: () => aborted },
    );
    expect(ok2).toBe(false);
    expect(abortCalls).toEqual([["pane", "send-keys", "w1:p1", "down"]]);
  });
});

describe("AgyTranscriptReader ask_question tracking", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTranscriptFiles(lines: Record<string, unknown>[], fullLines?: Record<string, unknown>[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-askq-"));
    tmpDirs.push(dir);
    const logsDir = path.join(dir, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const tPath = path.join(logsDir, "transcript.jsonl");
    fs.writeFileSync(tPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    if (fullLines) {
      const fPath = path.join(logsDir, "transcript_full.jsonl");
      fs.writeFileSync(fPath, fullLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    }
    return tPath;
  }

  it("exposes pending ask_question, hides it from activeTask, and clears on GENERIC response", () => {
    const tPath = createTranscriptFiles([
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-25T10:00:00Z",
        content: "<USER_REQUEST>\nSetup auth\n</USER_REQUEST>",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T10:00:01Z",
        tool_calls: [
          {
            id: "tc-ask-1",
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                { question: "OAuth provider?", options: ["Google", "GitHub"], is_multi_select: false },
              ]),
            },
          },
        ],
      },
    ]);

    const reader = new AgyTranscriptReader(tPath);
    reader.readSnapshot();

    const pending = reader.getPendingAskQuestion();
    expect(pending).not.toBeNull();
    expect(pending?.key).toBe("tc-ask-1@2");
    expect(pending?.spec.questions).toEqual([
      { question: "OAuth provider?", options: ["Google", "GitHub"], multiSelect: false },
    ]);
    expect(reader.getActiveTask()).toBeNull();

    // Terminal answers the question -> GENERIC step arrives
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T10:00:05Z",
        content: "A1: GitHub",
      }) + "\n",
      "utf8",
    );
    reader.pollNewEvents();
    expect(reader.getPendingAskQuestion()).toBeNull();
  });

  it("loads full ask_question payload from transcript_full.jsonl when tool_calls is truncated", () => {
    const fullQuestions = [
      { question: "Choose architecture", options: ["Hexagonal", "Clean", "Vertical Slice"], is_multi_select: false },
    ];
    const tPath = createTranscriptFiles(
      [
        {
          step_index: 10,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-25T10:00:01Z",
          truncated_fields: ["tool_calls"],
          tool_calls: [{ id: "tc-trunc", name: "ask_question", args: { questions: "[truncated" } }],
        },
      ],
      [
        {
          step_index: 10,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-25T10:00:01Z",
          tool_calls: [
            { id: "tc-trunc", name: "ask_question", args: { questions: JSON.stringify(fullQuestions) } },
          ],
        },
      ],
    );

    const reader = new AgyTranscriptReader(tPath);
    reader.readSnapshot();
    const pending = reader.getPendingAskQuestion();
    expect(pending?.spec.questions).toEqual([
      { question: "Choose architecture", options: ["Hexagonal", "Clean", "Vertical Slice"], multiSelect: false },
    ]);
  });

  it("returns null for historical already-answered ask_question steps in snapshot", () => {
    const tPath = createTranscriptFiles([
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Old?", options: ["A", "B"] }]) },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content: "A1: A",
      },
    ]);

    const reader = new AgyTranscriptReader(tPath);
    reader.readSnapshot();
    expect(reader.getPendingAskQuestion()).toBeNull();
  });
});

describe("BridgedAgentSession bidirectional ask_question mirroring", () => {
  const tmpDirs: string[] = [];
  const sessions: BridgedAgentSession[] = [];
  const origHome = process.env.HOME;

  afterEach(() => {
    while (sessions.length) {
      sessions.pop()!.stop();
    }
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  function setupSession(opts?: {
    initialLines?: Record<string, unknown>[];
    redactContent?: boolean;
    runner?: (cmd: string, args: string[], o?: unknown) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "rp-agy-bridge-"));
    tmpDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    const convId = "11111111-2222-3333-4444-555555555555";
    const logsDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const tPath = path.join(logsDir, "transcript.jsonl");
    const lines = opts?.initialLines ?? [
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-25T10:00:00Z",
        content: "<USER_REQUEST>\nBuild feature\n</USER_REQUEST>",
      },
    ];
    fs.writeFileSync(tPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const herdrCalls: string[][] = [];
    const runner =
      opts?.runner ??
      vi.fn(async (_cmd: string, args: string[]) => {
        herdrCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      });

    let transport!: FakeTransport;
    const cfg: RpConfig = {
      ...DEFAULT_CONFIG,
      redactContent: opts?.redactContent ?? false,
    };
    const session = new BridgedAgentSession(
      {
        paneId: "w1:p9",
        tabId: "w1:t1",
        workspaceId: "w1",
        agent: "agy",
        sessionId: convId,
        cwd: fakeHome,
        title: null,
        status: "working",
        stateChangeSeq: 1,
      },
      {
        relayUrl: "ws://127.0.0.1:9999",
        machineId: "m1",
        token: "tok",
        cfg,
        herdrSession: "default",
        runner,
        activePollIntervalMs: 60_000,
        idlePollIntervalMs: 60_000,
        askQuestionStepDelayMs: 0,
        connectionFactory: (co) =>
          new Connection({
            ...co,
            transportFactory: (name, h) => {
              transport = new FakeTransport(name, h);
              return transport;
            },
          }),
      },
    );
    sessions.push(session);

    transport.open();
    transport.receive({
      v: 1,
      id: "w1",
      t: "agent.welcome",
      ts: Date.now(),
      d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] },
    });
    return { session, transport, tPath, herdrCalls, runner };
  }

  it("opens prompt.open with waiting_input when ask_question appears and delivers mobile answer via herdr", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession();

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T10:00:02Z",
        tool_calls: [
          {
            id: "tc-q1",
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                { question: "Pick database", options: ["SQLite", "Postgres", "MySQL"], is_multi_select: false },
              ]),
            },
          },
        ],
      }) + "\n",
      "utf8",
    );

    await session.pollTranscriptNow();

    const opened = transport.sent.filter((e) => e.t === "prompt.open");
    expect(opened).toHaveLength(1);
    const promptBody = opened[0]!.d as any;
    expect(promptBody.kind).toBe("questionnaire");
    expect(promptBody.title).toBe("Pick database");
    expect(promptBody.questions).toEqual([
      {
        question: "Pick database",
        multiSelect: false,
        allowFreeText: true,
        options: [
          { id: "0", label: "SQLite" },
          { id: "1", label: "Postgres" },
          { id: "2", label: "MySQL" },
        ],
      },
    ]);

    const statuses = transport.sent.filter((e) => e.t === "agent.status").map((e) => (e.d as any).status);
    expect(statuses[statuses.length - 1]).toBe("waiting_input");

    // Mobile selects option "1" (Postgres)
    transport.receive(
      inbound("prompt.answer", {
        promptId: promptBody.promptId,
        answer: { answers: [{ questionIndex: 0, optionIds: ["1"] }] },
      }),
    );
    await flushAsync();

    expect(transport.sent.some((e) => e.t === "prompt.ack" && (e.d as any).accepted === true)).toBe(true);
    expect(
      transport.sent.some(
        (e) => e.t === "prompt.resolved" && (e.d as any).promptId === promptBody.promptId && (e.d as any).by === "remote",
      ),
    ).toBe(true);
    expect(herdrCalls).toEqual([
      ["pane", "send-keys", "w1:p9", "down"],
      ["pane", "send-keys", "w1:p9", "enter"],
    ]);

    // Subsequent poll before GENERIC arrives must NOT re-open the same ask_question
    await session.pollTranscriptNow();
    expect(transport.sent.filter((e) => e.t === "prompt.open")).toHaveLength(1);
  });

  it("dismisses mobile prompt with by='local' and sends zero keys when answered in terminal", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession();

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-local",
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Continue?", options: ["Yes", "No"] }]) },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const opened = transport.sent.filter((e) => e.t === "prompt.open");
    expect(opened).toHaveLength(1);
    const promptId = (opened[0]!.d as any).promptId;

    // User answers directly in terminal -> GENERIC step appended
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "A1: Yes",
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();

    expect(
      transport.sent.some(
        (e) =>
          e.t === "prompt.resolved" &&
          (e.d as any).promptId === promptId &&
          (e.d as any).by === "local" &&
          (e.d as any).answer === null,
      ),
    ).toBe(true);
    expect(herdrCalls).toEqual([]);
  });

  it("sends one esc per question on explicit mobile cancel and none on relay expiry", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession();

    // First: explicit mobile cancel on a 2-question ask_question
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-cancel",
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                { question: "Q1", options: ["A", "B"] },
                { question: "Q2", options: ["C", "D"] },
              ]),
            },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const prompt1 = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;

    transport.receive(inbound("prompt.answer", { promptId: prompt1.promptId, answer: { cancelled: true } }));
    await flushAsync();
    expect(herdrCalls).toEqual([
      ["pane", "send-keys", "w1:p9", "esc"],
      ["pane", "send-keys", "w1:p9", "esc"],
    ]);

    // Finish step 2 locally
    fs.appendFileSync(
      tPath,
      JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE", content: "Skipped" }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    herdrCalls.length = 0;

    // Second: relay prompt.cancel (expiry) should only retire mobile mirror, never send esc or re-open
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 4,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-expire",
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Q3", options: ["X", "Y"] }]) },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const openedAfter = transport.sent.filter((e) => e.t === "prompt.open");
    expect(openedAfter).toHaveLength(2);
    const prompt2 = openedAfter[1]!.d as any;

    transport.receive(inbound("prompt.cancel", { promptId: prompt2.promptId }));
    await flushAsync();
    await session.pollTranscriptNow();

    expect(herdrCalls).toEqual([]);
    expect(transport.sent.filter((e) => e.t === "prompt.open")).toHaveLength(2);
  });

  it("batches >4 questions into sequential questionnaires without re-opening batch 0 during delivery", async () => {
    let releaseStep!: () => void;
    const gate = new Promise<void>((r) => (releaseStep = r));
    const herdrCalls: string[][] = [];
    let firstCall = true;
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      herdrCalls.push(args);
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { session, transport, tPath } = setupSession({ runner });
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-5q",
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                { question: "Q1", options: ["A", "B"] },
                { question: "Q2", options: ["A", "B"] },
                { question: "Q3", options: ["A", "B"] },
                { question: "Q4", options: ["A", "B"] },
                { question: "Q5", options: ["A", "B"] },
              ]),
            },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();

    const firstPrompt = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;
    expect(firstPrompt.questions).toHaveLength(4);
    expect(firstPrompt.title).toBe("Questions 1–4 of 5");

    // Answer batch 1
    transport.receive(
      inbound("prompt.answer", {
        promptId: firstPrompt.promptId,
        answer: {
          answers: [
            { questionIndex: 0, optionIds: ["0"] },
            { questionIndex: 1, optionIds: ["1"] },
            { questionIndex: 2, optionIds: ["0"] },
            { questionIndex: 3, optionIds: ["1"] },
          ],
        },
      }),
    );
    await flushAsync();

    // Poll while batch 1 is mid-delivery -> must NOT re-open batch 0!
    await session.pollTranscriptNow();
    expect(transport.sent.filter((e) => e.t === "prompt.open")).toHaveLength(1);

    // Let batch 1 finish -> batch 2 (Q5) opens automatically
    releaseStep();
    await flushAsync();
    const opensAfterBatch1 = transport.sent.filter((e) => e.t === "prompt.open");
    expect(opensAfterBatch1).toHaveLength(2);
    const secondPrompt = opensAfterBatch1[1]!.d as any;
    expect(secondPrompt.questions).toHaveLength(1);
    expect(secondPrompt.questions[0].header).toBe("5/5");

    // Answer batch 2 (Q5) with custom text
    transport.receive(
      inbound("prompt.answer", {
        promptId: secondPrompt.promptId,
        answer: { answers: [{ questionIndex: 0, text: "Final note" }] },
      }),
    );
    await flushAsync();

    expect(herdrCalls).toEqual([
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-keys", "w1:p9", "down"],
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-keys", "w1:p9", "down"],
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-keys", "w1:p9", "down", "down"],
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-text", "w1:p9", "Final note"],
      ["pane", "send-keys", "w1:p9", "enter"],
    ]);
  });

  it("does not open prompts for historical completed ask_question on startup", () => {
    const { transport } = setupSession({
      initialLines: [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              id: "tc-old",
              name: "ask_question",
              args: { questions: JSON.stringify([{ question: "Old?", options: ["A", "B"] }]) },
            },
          ],
        },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "A1: A" },
      ],
    });
    expect(transport.sent.filter((e) => e.t === "prompt.open")).toHaveLength(0);
  });

  it("redacts prompt content over the wire when redactContent is enabled while delivering real text locally", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession({ redactContent: true });

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-red",
            name: "ask_question",
            args: {
              questions: JSON.stringify([{ question: "Secret prod key?", options: ["Alpha", "Beta"] }]),
            },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();

    const opened = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;
    expect(opened.title).toBe("[redacted]");
    expect(opened.questions[0].question).toBe("[question 1]");
    expect(opened.questions[0].options).toEqual([
      { id: "0", label: "[option 1]" },
      { id: "1", label: "[option 2]" },
    ]);

    transport.receive(
      inbound("prompt.answer", {
        promptId: opened.promptId,
        answer: { answers: [{ questionIndex: 0, text: "real-secret-input" }] },
      }),
    );
    await flushAsync();

    const resolved = transport.sent.find((e) => e.t === "prompt.resolved")?.d as any;
    expect(resolved.answer.answers[0].text).toBe("[redacted]");
    expect(herdrCalls).toEqual([
      ["pane", "send-keys", "w1:p9", "down", "down"],
      ["pane", "send-keys", "w1:p9", "enter"],
      ["pane", "send-text", "w1:p9", "real-secret-input"],
      ["pane", "send-keys", "w1:p9", "enter"],
    ]);
  });

  it("clears prompt without zombie waiting_input when [prompt.answer, resync] arrive synchronously after local resolution", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession();

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-race-sync",
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Race?", options: ["A", "B"] }]) },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const opened = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;

    // Terminal answers locally on disk
    fs.appendFileSync(
      tPath,
      JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE", content: "A1: A" }) + "\n",
      "utf8",
    );

    // Long-poll style synchronous batch: prompt.answer followed immediately by agent.resync before microtasks drain
    transport.receive(
      inbound("prompt.answer", {
        promptId: opened.promptId,
        answer: { answers: [{ questionIndex: 0, optionIds: ["1"] }] },
      }),
    );
    transport.receive(inbound("agent.resync", {}));
    await flushAsync();

    expect(session.broker.openCount).toBe(0);
    expect(session.makeHello().status).not.toBe("waiting_input");
    expect(session.makeHello().openPrompts).toEqual([]);
    expect(herdrCalls).toEqual([]);
    expect(
      transport.sent.filter((e) => e.t === "prompt.ack" && (e.d as any).promptId === opened.promptId),
    ).toMatchObject([{ d: { promptId: opened.promptId, accepted: false } }]);
    expect(
      transport.sent.filter((e) => e.t === "prompt.resolved" && (e.d as any).promptId === opened.promptId),
    ).toMatchObject([{ d: { promptId: opened.promptId, by: "local", answer: null } }]);
  });

  it("syncs transcript from disk on prompt.answer so already-answered terminal dialogs receive zero stray keys", async () => {
    const { session, transport, tPath, herdrCalls } = setupSession();

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-stale-window",
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Proceed?", options: ["Yes", "No"] }]) },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const opened = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;

    // Terminal answers locally on disk, WITHOUT calling pollTranscriptNow() first (simulates 150-900ms debounce window)
    fs.appendFileSync(
      tPath,
      JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE", content: "A1: Yes" }) + "\n",
      "utf8",
    );

    transport.receive(
      inbound("prompt.answer", {
        promptId: opened.promptId,
        answer: { answers: [{ questionIndex: 0, optionIds: ["1"] }] },
      }),
    );
    await flushAsync();

    expect(herdrCalls).toEqual([]);
    expect(session.broker.openCount).toBe(0);
    expect(
      transport.sent.some(
        (e) => e.t === "prompt.ack" && (e.d as any).promptId === opened.promptId && (e.d as any).accepted === false,
      ),
    ).toBe(true);
    expect(
      transport.sent.some(
        (e) =>
          e.t === "prompt.resolved" &&
          (e.d as any).promptId === opened.promptId &&
          (e.d as any).by === "local" &&
          (e.d as any).answer === null,
      ),
    ).toBe(true);
  });

  it("aborts remaining keystrokes mid-delivery if local terminal answers on disk between steps", async () => {
    const herdrCalls: string[][] = [];
    let tPathRef = "";
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      herdrCalls.push(args);
      if (herdrCalls.length === 1) {
        // Simulate terminal answering right after first step
        fs.appendFileSync(
          tPathRef,
          JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE", content: "A1: A" }) + "\n",
          "utf8",
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { session, transport, tPath } = setupSession({ runner });
    tPathRef = tPath;
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-mid-abort",
            name: "ask_question",
            args: { questions: JSON.stringify([{ question: "Pick?", options: ["A", "B", "C"] }]) },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const opened = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;

    transport.receive(
      inbound("prompt.answer", {
        promptId: opened.promptId,
        answer: { answers: [{ questionIndex: 0, optionIds: ["2"] }] },
      }),
    );
    await flushAsync();

    // Only the first step (down, down) ran; enter was aborted because GENERIC appeared on disk
    expect(herdrCalls).toEqual([["pane", "send-keys", "w1:p9", "down", "down"]]);
  });

  it("handles rejecting runner on non-final >4-question batch without re-opening batch 0", async () => {
    const runner = vi.fn(async () => {
      throw new Error("herdr boom");
    });
    const { session, transport, tPath } = setupSession({ runner });

    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            id: "tc-5q-err",
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                { question: "Q1", options: ["A", "B"] },
                { question: "Q2", options: ["A", "B"] },
                { question: "Q3", options: ["A", "B"] },
                { question: "Q4", options: ["A", "B"] },
                { question: "Q5", options: ["A", "B"] },
              ]),
            },
          },
        ],
      }) + "\n",
      "utf8",
    );
    await session.pollTranscriptNow();
    const firstPrompt = transport.sent.filter((e) => e.t === "prompt.open")[0]!.d as any;

    transport.receive(
      inbound("prompt.answer", {
        promptId: firstPrompt.promptId,
        answer: {
          answers: [
            { questionIndex: 0, optionIds: ["0"] },
            { questionIndex: 1, optionIds: ["0"] },
            { questionIndex: 2, optionIds: ["0"] },
            { questionIndex: 3, optionIds: ["0"] },
          ],
        },
      }),
    );
    await flushAsync();
    await session.pollTranscriptNow();

    expect(transport.sent.filter((e) => e.t === "prompt.open")).toHaveLength(1);
    expect(session.broker.openCount).toBe(0);
  });
});
