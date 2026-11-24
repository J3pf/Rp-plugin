import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RpConfig } from "../src/extension/config.ts";
import { Connection, type Transport, type TransportHandlers, type TransportName } from "../src/extension/connection.ts";
import { AgyTranscriptReader, resolveAgyTranscriptPath } from "../src/host/agy-transcript.ts";
import { runAgyHook, signGatePayload, verifyGateSignature } from "../src/host/bridge/agy-hooks.ts";
import {
  readAgySessionModel,
  readExternalAgentContextUsage,
  readJsonlHeadLine,
} from "../src/host/bridge/external-metadata.ts";
import { BridgedAgentSession, HerdrAgentBridge } from "../src/host/herdr-bridge.ts";
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
  close(code = 1006, reason = "closed"): void {
    const opened = this.isOpen;
    this.isOpen = false;
    this.h.onClose({ code, reason, opened, unsent: [] });
  }
}

describe("bridge hardening (T3 / S3)", () => {
  const tmpDirs: string[] = [];
let testSockSeq = 0;

function makeTestSocketPath(dir: string, name = "gate.sock"): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\rp-test-bh-${process.pid}-${Date.now()}-${++testSockSeq}`;
  }
  return path.join(dir, name);
}

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  describe("C-01: agy-hooks fail-closed HMAC & token requirement", () => {
    it("verifyGateSignature fails closed when machineToken is missing or empty", () => {
      expect(verifyGateSignature(null, ["req", "c1", "", "ls", "n1"], undefined)).toBe(false);
      expect(verifyGateSignature(undefined, ["req", "c1", "", "ls", "n1"], "")).toBe(false);
      expect(verifyGateSignature("", ["req", "c1", "", "ls", "n1"], "deadbeef")).toBe(false);

      const sig = signGatePayload("secret-token", ["req", "c1", "", "ls", "n1"]);
      expect(sig).toBeDefined();
      expect(verifyGateSignature("secret-token", ["req", "c1", "", "ls", "n1"], sig)).toBe(true);
      expect(verifyGateSignature("wrong-token", ["req", "c1", "", "ls", "n1"], sig)).toBe(false);
    });

    it("runAgyHook bails out with ask when machineToken is null or empty even for safe commands", async () => {
      const dir = mkTmp("rp-c01-hook-");
      const sockPath = path.join(dir, "gate.sock");
      const baseCfg: RpConfig = { ...DEFAULT_CONFIG, enabled: true, relayUrl: "https://relay.example.com", machineId: "M1" };

      const safePayload = JSON.stringify({
        conversationId: "conv-unpaired",
        toolCall: { name: "run_command", args: { CommandLine: '"npm test"' } },
      });
      const nonBashPayload = JSON.stringify({
        conversationId: "conv-unpaired",
        toolCall: { name: "view_file", args: { AbsolutePath: '"/tmp/a"' } },
      });

      expect(await runAgyHook({ ...baseCfg, machineToken: null }, safePayload, sockPath)).toEqual({ decision: "ask" });
      expect(await runAgyHook({ ...baseCfg, machineToken: "" }, safePayload, sockPath)).toEqual({ decision: "ask" });
      expect(await runAgyHook({ ...baseCfg, machineToken: null }, nonBashPayload, sockPath)).toEqual({ decision: "ask" });
    });
  });

  describe("C-04 + W-02 + W-06: agy-transcript TOCTOU, symlink confinement, and bgTasks bounds", () => {
    it("survives fs.openSync TOCTOU errors in readTranscriptChunk and readLogTail without throwing", () => {
      const dir = mkTmp("rp-c04-toctou-");
      const homeDir = path.join(dir, "home");
      const convId = "toctou-conv-1";
      const tPath = resolveAgyTranscriptPath(convId, homeDir);
      const tasksDir = path.join(path.dirname(path.dirname(tPath)), "tasks");
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const logPath = path.join(tasksDir, "task-1.log");
      fs.writeFileSync(logPath, "line 1\n");
      fs.writeFileSync(
        tPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ id: "call-1", name: "run_command", args: { CommandLine: '"npm test"' } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:01Z",
            content: `Tool is running as a background task with task id: ${convId}/task-1\nTask logs are available at: ${pathToFileURL(logPath).href}`,
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(tPath);
      reader.readSnapshot();

      // Append data so statSync sees size > offset, then make openSync throw EBUSY
      fs.appendFileSync(tPath, JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "next" }) + "\n");
      fs.appendFileSync(logPath, "line 2\n");

      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(() => {
        const err: any = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      });
      try {
        expect(() => reader.pollNewEvents()).not.toThrow();
        expect(() => reader.readSnapshot()).not.toThrow();
      } finally {
        openSpy.mockRestore();
      }

      // After transient error clears, reading resumes cleanly
      const events = reader.pollNewEvents();
      expect(events.some((e) => e.type === "message_end")).toBe(true);
      expect(events.some((e) => e.type === "tool_execution_update")).toBe(true);
    });

    it("isolates per-cursor errors inside pollActiveChildren and pollActiveBackgroundTasks (C-04)", () => {
      const dir = mkTmp("rp-c04-isolate-");
      const homeDir = path.join(dir, "home");
      const convId = "isolate-parent";
      const child1 = "isolate-child-1";
      const child2 = "isolate-child-2";
      const parentPath = resolveAgyTranscriptPath(convId, homeDir);
      const child1Path = resolveAgyTranscriptPath(child1, homeDir);
      const child2Path = resolveAgyTranscriptPath(child2, homeDir);
      const tasksDir = path.join(path.dirname(path.dirname(parentPath)), "tasks");
      fs.mkdirSync(path.dirname(parentPath), { recursive: true });
      fs.mkdirSync(path.dirname(child1Path), { recursive: true });
      fs.mkdirSync(path.dirname(child2Path), { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const log1 = path.join(tasksDir, "bg-1.log");
      const log2 = path.join(tasksDir, "bg-2.log");
      fs.writeFileSync(log1, "bg1 initial\n");
      fs.writeFileSync(log2, "bg2 initial\n");

      fs.writeFileSync(
        parentPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [
              {
                name: "invoke_subagent",
                args: {
                  Subagents: JSON.stringify([
                    { Role: "Child1", TypeName: "worker", Prompt: "A" },
                    { Role: "Child2", TypeName: "worker", Prompt: "B" },
                  ]),
                },
              },
            ],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-11-24T10:00:01Z",
            content:
              JSON.stringify({ conversationId: child1, logAbsoluteUri: pathToFileURL(child1Path).href }) +
              "\n" +
              JSON.stringify({ conversationId: child2, logAbsoluteUri: pathToFileURL(child2Path).href }),
          },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:02Z",
            tool_calls: [{ id: "call-bg-1", name: "run_command", args: { CommandLine: '"echo 1"' } }],
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:03Z",
            content: `Tool is running as a background task with task id: ${convId}/bg-1\nTask logs are available at: ${pathToFileURL(log1).href}`,
          },
          {
            step_index: 4,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:04Z",
            tool_calls: [{ id: "call-bg-2", name: "run_command", args: { CommandLine: '"echo 2"' } }],
          },
          {
            step_index: 5,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:05Z",
            content: `Tool is running as a background task with task id: ${convId}/bg-2\nTask logs are available at: ${pathToFileURL(log2).href}`,
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(parentPath);
      reader.pollNewEvents();

      fs.writeFileSync(
        child2Path,
        JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-24T10:00:06Z",
          tool_calls: [{ name: "read_file", args: { Path: "/repo/b.ts" } }],
        }) + "\n",
      );
      fs.appendFileSync(log2, "bg2 updated\n");

      const origPollChild = (reader as any).pollChildCursor.bind(reader);
      vi.spyOn(reader as any, "pollChildCursor").mockImplementation((...args: any[]) => {
        if (args[0] === child1) throw new Error("boom child1");
        return origPollChild(...args);
      });
      const origPollBg = (reader as any).pollBackgroundTaskCursor.bind(reader);
      vi.spyOn(reader as any, "pollBackgroundTaskCursor").mockImplementation((...args: any[]) => {
        if (args[0]?.taskSender === `${convId}/bg-1`) throw new Error("boom bg1");
        return origPollBg(...args);
      });

      const events = reader.pollNewEvents();
      expect(events.some((e) => e.type === "subagent_update" && e.taskId === "agy:0:0:sub:1" && Array.isArray(e.tools) && e.tools.includes("read"))).toBe(true);
      expect(events.some((e) => e.type === "tool_execution_update" && e.toolCallId === "call-bg-2")).toBe(true);
    });

    it("rejects symlinks in resolveTaskLogPath and non-tasks paths under brainRoot (W-02)", () => {
      if (process.platform === "win32") return;
      const dir = mkTmp("rp-w02-tasklog-");
      const homeDir = path.join(dir, "home");
      const outsideSecret = path.join(dir, "secret.log");
      fs.writeFileSync(outsideSecret, "TOP_SECRET_HOST_CONTENT\n");

      const convId = "symlink-task-conv";
      const tPath = resolveAgyTranscriptPath(convId, homeDir);
      const sysGenDir = path.dirname(path.dirname(tPath));
      const logsDir = path.dirname(tPath);
      const tasksDir = path.join(sysGenDir, "tasks");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const symlinkLog = path.join(tasksDir, "evil-task.log");
      fs.symlinkSync(outsideSecret, symlinkLog);

      const nonTasksLog = path.join(logsDir, "not-a-task.log");
      fs.writeFileSync(nonTasksLog, "SHOULD_NOT_READ_LOGS_DIR\n");

      fs.writeFileSync(
        tPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ id: "call-sym", name: "run_command", args: { CommandLine: '"sleep 5"' } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:01Z",
            content: `Tool is running as a background task with task id: ${convId}/evil-task\nTask logs are available at: ${pathToFileURL(symlinkLog).href}`,
          },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-24T10:00:02Z",
            tool_calls: [{ id: "call-nontasks", name: "run_command", args: { CommandLine: '"sleep 5"' } }],
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:03Z",
            content: `Tool is running as a background task with task id: ${convId}/other-task\nTask logs are available at: ${pathToFileURL(nonTasksLog).href}`,
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(tPath);
      const events = reader.pollNewEvents();
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("TOP_SECRET_HOST_CONTENT");
      expect(serialized).not.toContain("SHOULD_NOT_READ_LOGS_DIR");
    });

    it("rejects symlinks in resolveChildTranscriptPath (W-02)", () => {
      if (process.platform === "win32") return;
      const dir = mkTmp("rp-w02-child-");
      const homeDir = path.join(dir, "home");
      const outsideTranscript = path.join(dir, "outside-transcript.jsonl");
      fs.writeFileSync(
        outsideTranscript,
        JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-24T10:00:01Z",
          thinking: "SECRET_SYMLINK_LEAK",
          tool_calls: [{ name: "run_command", args: { CommandLine: '"cat /etc/shadow"' } }],
        }) + "\n",
      );

      const parentConv = "parent-sym-conv";
      const childConv = "child-sym-conv";
      const parentPath = resolveAgyTranscriptPath(parentConv, homeDir);
      const childPath = resolveAgyTranscriptPath(childConv, homeDir);
      fs.mkdirSync(path.dirname(parentPath), { recursive: true });
      fs.mkdirSync(path.dirname(childPath), { recursive: true });
      fs.symlinkSync(outsideTranscript, childPath);

      fs.writeFileSync(
        parentPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ name: "invoke_subagent", args: { Role: "Spy", TypeName: "worker", Prompt: "Read" } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-11-24T10:00:01Z",
            content: JSON.stringify({ conversationId: childConv, logAbsoluteUri: pathToFileURL(childPath).href }),
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(parentPath);
      const events = reader.pollNewEvents();
      const subs = reader.getSubagents();
      expect(JSON.stringify(events)).not.toContain("SECRET_SYMLINK_LEAK");
      expect(subs.every((s) => !s.thinking?.includes("SECRET_SYMLINK_LEAK"))).toBe(true);
      expect(subs[0]?.tools).toEqual([]);
    });

    it("caps bgTasks and expires stale background tasks via pruneStaleBackgroundTasks (W-06)", () => {
      const dir = mkTmp("rp-w06-bgcap-");
      const homeDir = path.join(dir, "home");
      const convId = "bg-cap-conv";
      const tPath = resolveAgyTranscriptPath(convId, homeDir);
      const tasksDir = path.join(path.dirname(path.dirname(tPath)), "tasks");
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const steps: unknown[] = [];
      let idx = 0;
      for (let i = 0; i < 60; i++) {
        const logPath = path.join(tasksDir, `task-${i}.log`);
        fs.writeFileSync(logPath, `output ${i}\n`);
        steps.push(
          {
            step_index: idx++,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ id: `call-${i}`, name: "run_command", args: { CommandLine: `"echo ${i}"` } }],
          },
          {
            step_index: idx++,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:01Z",
            content: `Tool is running as a background task with task id: ${convId}/task-${i}\nTask logs are available at: ${pathToFileURL(logPath).href}`,
          },
        );
      }
      fs.writeFileSync(tPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

      const reader = new AgyTranscriptReader(tPath);
      reader.pollNewEvents();
      expect((reader as any).bgTasks.size).toBeLessThanOrEqual(50);
      expect(reader.hasRunningBackgroundTasks()).toBe(true);

      // Delete one task's log file -> pruned immediately
      fs.unlinkSync(path.join(tasksDir, "task-59.log"));
      const prunedDeleted = reader.pruneStaleBackgroundTasks(Date.now(), 5 * 60_000);
      expect(prunedDeleted).toBe(1);
      expect((reader as any).bgTasks.has(`${convId}/task-59`)).toBe(false);

      // Advance > 5 minutes -> all remaining stale tasks expire
      const prunedStale = reader.pruneStaleBackgroundTasks(Date.now() + 6 * 60_000, 5 * 60_000);
      expect(prunedStale).toBeGreaterThan(0);
      expect(reader.hasRunningBackgroundTasks()).toBe(false);
    });
  });

  describe("C-05 + C-07 + C-04 + W-08 + W-09 + W-14 + S-01: herdr-bridge hardening", () => {
    it("C-05: second HerdrAgentBridge.stop() does NOT unlink an already-held live agy-gate.sock", async () => {
      if (process.platform === "win32") return;
      const dir = mkTmp("rp-c05-sock-");
      const sockPath = path.join(dir, "agy-gate.sock");
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };

      const makeBridge = () =>
        new HerdrAgentBridge({
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" }),
          socketPath: sockPath,
          stateFile: null,
          pollIntervalMs: 60_000,
        });

      const bridge1 = makeBridge();
      bridge1.start();
      await vi.waitFor(() => expect(fs.existsSync(sockPath)).toBe(true), { timeout: 2_000, interval: 10 });

      const logs2: string[] = [];
      const bridge2 = new HerdrAgentBridge({
        relayUrl: "https://relay.example.com",
        machineId: "M1",
        token: "T1",
        cfg,
        herdrSession: null,
        runner: async () => ({ code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" }),
        socketPath: sockPath,
        stateFile: null,
        pollIntervalMs: 60_000,
        onLog: (m) => logs2.push(m),
      });
      bridge2.start();
      await vi.waitFor(() => expect(logs2.some((l) => l.includes("already held"))).toBe(true), { timeout: 2_000, interval: 10 });

      // Stopping bridge2 MUST leave bridge1's socket intact and alive
      bridge2.stop();
      expect(fs.existsSync(sockPath)).toBe(true);

      const connected = await new Promise<boolean>((resolve) => {
        const c = net.createConnection(sockPath);
        c.on("connect", () => {
          c.destroy();
          resolve(true);
        });
        c.on("error", () => resolve(false));
      });
      expect(connected).toBe(true);

      // Stopping bridge1 unlinks its own socket
      bridge1.stop();
      expect(fs.existsSync(sockPath)).toBe(false);
    });

    it("C-07: BridgedAgentSession.onWelcome sends snapshot when w.lastSeq < this.seq and skips only when w.lastSeq >= this.seq", () => {
      const dir = mkTmp("rp-c07-welcome-");
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const t = { instance: null as FakeTransport | null };
      const session = new BridgedAgentSession(
        { agent: "codex", sessionId: null, status: "idle", cwd: dir, paneId: "w1:p1", tabId: null, workspaceId: "w1", title: null, stateChangeSeq: 0 },
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
        t.instance!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
        expect(t.instance!.sent.filter((e) => e.t === "agent.snapshot")).toHaveLength(1);

        // Emit two events so session.seq advances to 2
        (session as any).sendEvent({ type: "agent_start" });
        (session as any).sendEvent({ type: "agent_settled", aborted: false });
        expect((session as any).seq).toBe(2);

        // Reconnect where relay only saw lastSeq: 0 (< this.seq === 2) -> MUST send snapshot!
        t.instance!.sent.length = 0;
        t.instance!.receive({ v: 1, id: "w2", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: 0, pendingAnswers: [] } });
        expect(t.instance!.sent.filter((e) => e.t === "agent.snapshot")).toHaveLength(1);

        // Reconnect where relay already has lastSeq: 2 (>= this.seq === 2) -> may skip snapshot
        t.instance!.sent.length = 0;
        t.instance!.receive({ v: 1, id: "w3", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: 2, pendingAnswers: [] } });
        expect(t.instance!.sent.filter((e) => e.t === "agent.snapshot")).toHaveLength(0);
      } finally {
        session.stop();
      }
    });

    it("C-04: sendSnapshot and commandTimer catch transcript read errors without crashing", async () => {
      vi.useFakeTimers();
      const dir = mkTmp("rp-c04-bridge-");
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const logs: string[] = [];
      const t = { instance: null as FakeTransport | null };
      let unhandled: unknown = null;
      const onUnhandled = (reason: unknown) => {
        unhandled = reason;
      };
      process.on("unhandledRejection", onUnhandled);

      const session = new BridgedAgentSession(
        { agent: "agy", sessionId: "conv-snap-err", status: "idle", cwd: dir, paneId: "w1:p2", tabId: null, workspaceId: "w1", title: null, stateChangeSeq: 0 },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg,
          herdrSession: null,
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          onLog: (m) => logs.push(m),
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
        const reader = (session as any).transcriptReader;
        reader.readSnapshot = () => {
          throw new Error("simulated readSnapshot EBUSY");
        };
        reader.pollNewEvents = () => {
          throw new Error("simulated commandTimer EBUSY");
        };

        t.instance!.open();
        expect(() =>
          t.instance!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } }),
        ).not.toThrow();
        expect(logs.some((l) => l.includes("simulated readSnapshot EBUSY"))).toBe(true);

        t.instance!.receive({
          v: 1,
          id: "m1",
          t: "user.message",
          ts: Date.now(),
          d: { clientMsgId: "c1", text: "hello" },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(unhandled).toBeNull();
        expect(logs.some((l) => l.includes("simulated commandTimer EBUSY"))).toBe(true);
      } finally {
        session.stop();
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("W-08 + W-09 + S-01: unsigned ask on bad HMAC, single-request socket, validatePaneId, and gate-created /quit cleanup", async () => {
      const dir = mkTmp("rp-w08-gate-");
      const sockPath = makeTestSocketPath(dir, "gate.sock");
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const transports = new Map<string, FakeTransport>();

      const bridge = new HerdrAgentBridge({
        relayUrl: "https://relay.example.com",
        machineId: "M1",
        token: "T1",
        cfg,
        herdrSession: null,
        runner: async () => ({ code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" }),
        socketPath: sockPath,
        stateFile: null,
        pollIntervalMs: 60_000,
        connectionFactory: (opts) =>
          new Connection({
            ...opts,
            transportFactory: (_name, handlers) => {
              const ft = new FakeTransport("ws", handlers);
              transports.set(opts.agentId, ft);
              return ft;
            },
          }),
      });

      bridge.start();
      try {
        await vi.waitFor(() => expect((bridge as any).ownsGateSocket).toBe(true), { timeout: 2_000, interval: 10 });
        if (process.platform !== "win32") expect(fs.existsSync(sockPath)).toBe(true);
        expect((bridge as any).gateServer?.maxConnections).toBe(64);

        // S-01: failed HMAC must return UNSIGNED ask (no signing oracle)
        // W-08: sending two pipelined lines on one socket must produce only one response
        const rawLines = await new Promise<string[]>((resolve, reject) => {
          const c = net.createConnection(sockPath);
          c.setEncoding("utf8");
          let out = "";
          c.on("connect", () => {
            c.write(
              JSON.stringify({ conversationId: "conv-bad", paneId: "w1:p1", command: "sudo ls", nonce: "n1", sig: "0000" }) +
                "\n" +
                JSON.stringify({ conversationId: "conv-bad2", paneId: "w1:p1", command: "sudo id", nonce: "n2", sig: "0000" }) +
                "\n",
            );
          });
          c.on("data", (chunk) => {
            out += chunk;
          });
          c.on("end", () => {
            resolve(out.trim().split("\n").filter(Boolean));
          });
          c.on("error", reject);
        });
        expect(rawLines).toHaveLength(1);
        const badResp = JSON.parse(rawLines[0]!);
        expect(badResp.decision).toBe("ask");
        expect(badResp.sig).toBeUndefined();

        // S-01: invalid paneId in a valid signed gate request falls back to ""
        const nonceBadPane = "nonce-bad-pane";
        const invalidPane = "--evil-flag";
        const sigBadPane = signGatePayload("T1", ["req", "conv-badpane", invalidPane, "sudo ls", nonceBadPane])!;
        const badPaneReq = new Promise<any>((resolve, reject) => {
          const c = net.createConnection(sockPath);
          c.setEncoding("utf8");
          let out = "";
          c.on("connect", () => {
            c.write(
              JSON.stringify({
                conversationId: "conv-badpane",
                paneId: invalidPane,
                command: "sudo ls",
                nonce: nonceBadPane,
                sig: sigBadPane,
              }) + "\n",
            );
          });
          c.on("data", (chunk) => {
            out += chunk;
          });
          c.on("end", () => resolve(JSON.parse(out.trim())));
          c.on("error", reject);
        });

        await vi.waitFor(() => expect(transports.has("M1:herdr:conv-badpane")).toBe(true), { timeout: 2_000, interval: 10 });
        const badPaneSession = bridge.getActiveSessions().find((s) => s.conversationId === "conv-badpane")!;
        expect(badPaneSession.paneId).toBe("");
        const badPaneT = transports.get("M1:herdr:conv-badpane")!;
        badPaneT.open();
        badPaneT.receive({ v: 1, id: "wbp", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
        await vi.waitFor(() => expect(badPaneT.sent.some((e) => e.t === "prompt.open")).toBe(true));
        const bpPromptId = (badPaneT.sent.find((e) => e.t === "prompt.open")!.d as any).promptId;
        badPaneT.receive({ v: 1, id: "pabp", t: "prompt.answer", ts: Date.now(), d: { promptId: bpPromptId, answer: { optionIds: ["0"] } } });
        expect((await badPaneReq).decision).toBe("allow");

        // W-09: gate-created session with valid paneId cleans up on /quit
        const nonceQuit = "nonce-quit";
        const sigQuit = signGatePayload("T1", ["req", "conv-gate-quit", "w9:p9", "sudo ls", nonceQuit])!;
        const quitGateReq = new Promise<any>((resolve, reject) => {
          const c = net.createConnection(sockPath);
          c.setEncoding("utf8");
          let out = "";
          c.on("connect", () => {
            c.write(
              JSON.stringify({
                conversationId: "conv-gate-quit",
                paneId: "w9:p9",
                command: "sudo ls",
                nonce: nonceQuit,
                sig: sigQuit,
              }) + "\n",
            );
          });
          c.on("data", (chunk) => {
            out += chunk;
          });
          c.on("end", () => resolve(JSON.parse(out.trim())));
          c.on("error", reject);
        });

        await vi.waitFor(() => expect(transports.has("M1:herdr:conv-gate-quit")).toBe(true), { timeout: 2_000, interval: 10 });
        const quitT = transports.get("M1:herdr:conv-gate-quit")!;
        quitT.open();
        quitT.receive({ v: 1, id: "wq", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });
        await vi.waitFor(() => expect(quitT.sent.some((e) => e.t === "prompt.open")).toBe(true));
        const qPromptId = (quitT.sent.find((e) => e.t === "prompt.open")!.d as any).promptId;
        quitT.receive({ v: 1, id: "paq", t: "prompt.answer", ts: Date.now(), d: { promptId: qPromptId, answer: { optionIds: ["0"] } } });
        expect((await quitGateReq).decision).toBe("allow");

        // Send /quit to the gate-created session -> must be removed from sessionsByKey and added to closedPanesUntil
        quitT.receive({
          v: 1,
          id: "mq",
          t: "user.message",
          ts: Date.now(),
          d: { clientMsgId: "cm-quit", text: "/quit", asCommand: true },
        });
        await vi.waitFor(() => {
          expect(bridge.getActiveSessions().some((s) => s.conversationId === "conv-gate-quit")).toBe(false);
        }, { timeout: 2_000, interval: 10 });
        expect((bridge as any).closedPanesUntil.has("w9:p9")).toBe(true);
      } finally {
        bridge.stop();
      }
    });

    it("W-14: logs herdr agent list failure and recovery transitions once", async () => {
      const dir = mkTmp("rp-w14-herdr-log-");
      const cfg: RpConfig = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example.com", machineId: "M1", machineToken: "T1" };
      const logs: string[] = [];
      let failing = true;
      const bridge = new HerdrAgentBridge({
        relayUrl: "https://relay.example.com",
        machineId: "M1",
        token: "T1",
        cfg,
        herdrSession: null,
        runner: async () =>
          failing
            ? { code: 1, stdout: "", stderr: "daemon unreachable" }
            : { code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" },
        socketPath: makeTestSocketPath(dir, "gate.sock"),
        stateFile: null,
        pollIntervalMs: 60_000,
        onLog: (m) => logs.push(m),
      });

      try {
        await bridge.poll();
        await bridge.poll();
        expect(logs.filter((l) => l.includes("herdr agent list failed"))).toHaveLength(1);

        failing = false;
        await bridge.poll();
        await bridge.poll();
        expect(logs.filter((l) => l.includes("herdr agent list recovered"))).toHaveLength(1);
      } finally {
        bridge.stop();
      }
    });

    it("W-06 integration: BridgedAgentSession prunes stale background tasks when Herdr reports done/idle", async () => {
      vi.useFakeTimers();
      const dir = mkTmp("rp-w06-bridge-");
      const homeDir = path.join(dir, "home");
      const convId = "bg-stale-bridge";
      const tPath = resolveAgyTranscriptPath(convId, homeDir);
      const tasksDir = path.join(path.dirname(path.dirname(tPath)), "tasks");
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const logPath = path.join(tasksDir, "task-stale.log");
      fs.writeFileSync(logPath, "working...\n");
      // Backdate log mtime to 10 minutes ago
      const tenMinAgo = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(logPath, tenMinAgo, tenMinAgo);

      fs.writeFileSync(
        tPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ id: "call-stale", name: "run_command", args: { CommandLine: '"npm run build"' } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:01Z",
            content: `Tool is running as a background task with task id: ${convId}/task-stale\nTask logs are available at: ${pathToFileURL(logPath).href}`,
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
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
        t.instance!.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        // Herdr reports idle -> stale bg task is pruned -> status transitions to idle instead of staying stuck in working
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "idle",
          cwd: homeDir,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 2,
        });

        const statuses = t.instance!.sent.filter((e) => e.t === "agent.status").map((e) => (e.d as any).status);
        expect(statuses.at(-1)).toBe("idle");
      } finally {
        session.stop();
        homeSpy.mockRestore();
      }
    });
  });

  describe("C-06 + C-10: external-metadata head line, dotted model names, and SQLite caching", () => {
    it("C-10: readJsonlHeadLine & matchesCodexCwd match cwd from line 1 even on > 16 KB Codex JSONL files", () => {
      const home = mkTmp("rp-c10-codex-");
      const codexDir = path.join(home, ".codex", "sessions", "2026", "11", "24");
      fs.mkdirSync(codexDir, { recursive: true });

      const otherFile = path.join(codexDir, "rollout-2026-11-24-other.jsonl");
      const targetFile = path.join(codexDir, "rollout-2026-11-24-target.jsonl");
      const padding = Array.from({ length: 120 }, (_, i) =>
        JSON.stringify({ type: "event_msg", payload: { type: "msg", text: `padding line ${i} ${"x".repeat(140)}` } }),
      ).join("\n");

      // Write target file first, then other file (newer mtime) so otherFile is checked first
      fs.writeFileSync(
        targetFile,
        [
          JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/alpha" } }),
          padding,
          JSON.stringify({
            type: "event_msg",
            payload: { type: "token_count", info: { last_token_usage: { total_tokens: 51_680 }, model_context_window: 258_400 } },
          }),
        ].join("\n") + "\n",
      );
      fs.writeFileSync(
        otherFile,
        [
          JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/beta" } }),
          padding,
          JSON.stringify({
            type: "event_msg",
            payload: { type: "token_count", info: { last_token_usage: { total_tokens: 200_000 }, model_context_window: 258_400 } },
          }),
        ].join("\n") + "\n",
      );
      // Ensure otherFile has a strictly newer mtime so collectRecentCodexSessionFiles visits it first
      const newer = new Date(Date.now() + 5_000);
      fs.utimesSync(otherFile, newer, newer);

      expect(readJsonlHeadLine(otherFile)).toContain("/repo/beta");
      expect(readJsonlHeadLine(targetFile)).toContain("/repo/alpha");

      // Without sessionId, /repo/alpha MUST skip otherFile (beta) and read targetFile (51_680)
      const usage = readExternalAgentContextUsage("codex", "/repo/alpha", null, "", home);
      expect(usage).toEqual({ tokens: 51_680, contextWindow: 258_400, percent: 20 });
    });

    it("C-10: readAgySessionModel preserves dots in versioned model names", () => {
      const home = mkTmp("rp-c10-model-");
      const convId = "conv-dotted-model";
      const tPath = resolveAgyTranscriptPath(convId, home);
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.writeFileSync(
        tPath,
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content:
            "<USER_REQUEST>Hi</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 2.5 Flash to Claude Sonnet 4.5 (High).\n</USER_SETTINGS_CHANGE>",
        }) + "\n",
      );

      expect(readAgySessionModel(convId, home)).toEqual({
        model: "Claude Sonnet 4.5 (High)",
        uncertain: false,
      });
    });

    it("C-06: readAgySessionModel caches results for >=10s unless mtime changes and preserves cached value on DB error", () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-c06-cache-");
      const convId = "conv-cache-1";
      const convDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
      fs.mkdirSync(convDir, { recursive: true });
      const dbPath = path.join(convDir, `${convId}.db`);

      const writeDbModel = (modelId: string) => {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER, data BLOB)");
          db.exec("DELETE FROM gen_metadata");
          const blob = Buffer.concat([Buffer.from([0xaa, 0x01, modelId.length]), Buffer.from(modelId, "utf8")]);
          db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(1, blob);
        } finally {
          db.close();
        }
      };

      writeDbModel("gemini-3.8-flash");
      const baseTime = new Date(Math.floor(Date.now() / 1000) * 1000);
      fs.utimesSync(dbPath, baseTime, baseTime);
      const openSpy = vi.spyOn(fs, "openSync");

      // First call populates cache
      expect(readAgySessionModel(convId, home)).toEqual({ model: "gemini-3.8-flash", uncertain: false });
      const callsAfterFirst = openSpy.mock.calls.length;

      // Mutate DB content while preserving exact mtime -> within 10s throttle must still serve cached model
      writeDbModel("gemini-4-unseen-yet");
      fs.utimesSync(dbPath, baseTime, baseTime);
      vi.advanceTimersByTime(5_000);
      expect(readAgySessionModel(convId, home)).toEqual({ model: "gemini-3.8-flash", uncertain: false });
      expect(openSpy.mock.calls.length).toBe(callsAfterFirst);

      // Once >= 10s elapses, throttle expires and re-reads DB
      vi.advanceTimersByTime(5_500);
      expect(readAgySessionModel(convId, home)).toEqual({ model: "gemini-4-unseen-yet", uncertain: false });

      // Update DB + bump mtime -> cache invalidates immediately even within 10s
      writeDbModel("claude-sonnet-4.5");
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(dbPath, future, future);
      expect(readAgySessionModel(convId, home)).toEqual({ model: "claude-sonnet-4.5", uncertain: false });

      // Corrupt/lock DB on next refresh -> preserves cached model instead of dropping to null
      fs.writeFileSync(dbPath, "not a sqlite db");
      const future2 = new Date(Date.now() + 4_000);
      fs.utimesSync(dbPath, future2, future2);
      const afterErr = readAgySessionModel(convId, home);
      expect(afterErr.model).toBe("claude-sonnet-4.5");
    });
  });
});
