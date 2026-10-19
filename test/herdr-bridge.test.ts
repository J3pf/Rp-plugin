import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RpConfig } from "../src/extension/config.ts";
import { ALLOW, ALLOW_SESSION, DENY } from "../src/extension/prompts/gate.ts";
import {
  AgyTranscriptReader,
  extractAgyUserText,
  normalizeAgyToolCall,
  parseAgyArgs,
} from "../src/host/agy-transcript.ts";
import {
  HerdrAgentBridge,
  extractRecentCommandOutput,
  installAgyHooks,
  parseHerdrAgentList,
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
        tabId: "wS:t1",
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
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toContainEqual({ cmd: "herdr", args: ["agent", "prompt", "wS:p1", "Hola agy"] });
      expect(t!.sent.some((e) => e.t === "user.message.ack" && (e.d as any).disposition === "typed")).toBe(true);

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

      await new Promise((r) => setTimeout(r, 40));
      const promptEnv = t!.sent.find((e) => e.t === "prompt.open");
      expect(promptEnv).toBeDefined();
      const promptId = (promptEnv!.d as any).promptId as string;

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
      await new Promise((r) => setTimeout(r, 40));
      const denyPrompt = t!.sent.filter((e) => e.t === "prompt.open").at(-1);
      expect(denyPrompt).toBeDefined();
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
  });

  it("extractRecentCommandOutput returns snippet from last command occurrence", () => {
    const term = "Previous history\nline 2\n> /usage\n  Model: gemini-3.8-flash\n  Tokens: 120";
    expect(extractRecentCommandOutput(term, "/usage")).toBe("> /usage\n  Model: gemini-3.8-flash\n  Tokens: 120");
    expect(extractRecentCommandOutput(term, "/nonexistent")).toBe(term);
    expect(extractRecentCommandOutput(term)).toBe(term);
  });
});
