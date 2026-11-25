import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RpConfig } from "../src/extension/config.ts";
import { Connection, type Transport, type TransportHandlers, type TransportName } from "../src/extension/connection.ts";
import { AgyTranscriptReader, resolveAgyTranscriptPath } from "../src/host/agy-transcript.ts";
import {
  readAgySessionModel,
  readExternalAgentContextUsage,
  readExternalAgentMetadata,
  readExternalAgentModel,
} from "../src/host/bridge/external-metadata.ts";
import { readHerdrPanelSortMode } from "../src/host/bridge/herdr-discovery.ts";
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
  close(): void {
    this.isOpen = false;
  }
}

let sockSeq = 0;

function makeSocketPath(dir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\rp-perf-${process.pid}-${Date.now()}-${++sockSeq}`;
  }
  return path.join(dir, `gate-${++sockSeq}.sock`);
}

function makeConnFactory(transports: Map<string, FakeTransport>) {
  return (opts: ConstructorParameters<typeof Connection>[0]) =>
    new Connection({
      ...opts,
      transportFactory: (_name, handlers) => {
        const ft = new FakeTransport("ws", handlers);
        transports.set(opts.agentId, ft);
        return ft;
      },
    });
}

describe("S1 bridge performance & battery optimizations", () => {
  const tmpDirs: string[] = [];

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

  const baseCfg: RpConfig = {
    ...DEFAULT_CONFIG,
    relayUrl: "https://relay.example.com",
    machineId: "M1",
    machineToken: "T1",
  };

  describe("PLG-PERF-01: Herdr bridge backoff, zero-session idle interval, triggerPoll & config.toml cache", () => {
    it("backs off 5s -> 15s -> 30s -> 60s on consecutive failures, relaxes to 15s with 0 sessions, and wakes on triggerPoll()", async () => {
      vi.useFakeTimers();
      const dir = mkTmp("rp-perf01-backoff-");
      let mode: "fail" | "empty" | "idle" | "working" = "fail";
      let listCalls = 0;
      const transports = new Map<string, FakeTransport>();

      const bridge = new HerdrAgentBridge({
        relayUrl: "https://relay.example.com",
        machineId: "M1",
        token: "T1",
        cfg: baseCfg,
        herdrSession: null,
        socketPath: makeSocketPath(dir),
        stateFile: null,
        panelSortMode: "priority",
        connectionFactory: makeConnFactory(transports),
        runner: async (cmd, args) => {
          if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
            listCalls++;
            if (mode === "fail") return { code: 1, stdout: "", stderr: "ENOENT" };
            if (mode === "empty") return { code: 0, stdout: '{"result":{"agents":[]}}', stderr: "" };
            return {
              code: 0,
              stdout: JSON.stringify({
                result: {
                  agents: [
                    {
                      agent: "claude",
                      pane_id: "w1:p1",
                      cwd: dir,
                      agent_status: mode === "working" ? "working" : "idle",
                      state_change_seq: listCalls,
                    },
                  ],
                },
              }),
              stderr: "",
            };
          }
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });

      bridge.start();
      try {
        // Initial poll fails (#1) -> next scheduled at +5s
        await vi.advanceTimersByTimeAsync(0);
        expect(listCalls).toBe(1);

        await vi.advanceTimersByTimeAsync(4_900);
        expect(listCalls).toBe(1);

        // +5s -> fail #2 -> next scheduled at +15s
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(2);

        await vi.advanceTimersByTimeAsync(14_900);
        expect(listCalls).toBe(2);

        // +15s -> fail #3 -> next scheduled at +30s
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(3);

        await vi.advanceTimersByTimeAsync(29_900);
        expect(listCalls).toBe(3);

        // +30s -> fail #4 -> next scheduled at +60s
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(4);

        await vi.advanceTimersByTimeAsync(59_900);
        expect(listCalls).toBe(4);

        // +60s -> fail #5 -> capped at +60s
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(5);

        await vi.advanceTimersByTimeAsync(59_900);
        expect(listCalls).toBe(5);

        // Recover with 0 sessions -> backoff resets, idle 0-session poll is 15s
        mode = "empty";
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(6);

        await vi.advanceTimersByTimeAsync(14_900);
        expect(listCalls).toBe(6);

        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(7);

        // triggerPoll() wakes immediately without waiting 15s
        mode = "idle";
        await bridge.triggerPoll();
        expect(listCalls).toBe(8);
        expect(bridge.getActiveSessions()).toHaveLength(1);

        // With 1 idle session, poll cadence is 5s
        await vi.advanceTimersByTimeAsync(4_900);
        expect(listCalls).toBe(8);
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(9);

        // Switch to working -> poll cadence tightens to 2.5s
        mode = "working";
        await bridge.triggerPoll();
        expect(listCalls).toBe(10);
        await vi.advanceTimersByTimeAsync(2_400);
        expect(listCalls).toBe(10);
        await vi.advanceTimersByTimeAsync(100);
        expect(listCalls).toBe(11);
      } finally {
        bridge.stop();
      }
    });

    it("caches readHerdrPanelSortMode() by config.toml mtimeMs and size", () => {
      const dir = mkTmp("rp-perf01-toml-");
      const cfgPath = path.join(dir, "config.toml");
      fs.writeFileSync(cfgPath, 'agent_panel_sort = "spaces"\n');

      const readSpy = vi.spyOn(fs, "readFileSync");
      expect(readHerdrPanelSortMode({ HERDR_CONFIG_PATH: cfgPath })).toBe("spaces");
      expect(readSpy).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        expect(readHerdrPanelSortMode({ HERDR_CONFIG_PATH: cfgPath })).toBe("spaces");
      }
      expect(readSpy).toHaveBeenCalledTimes(1);

      // Update file content and bump mtime -> cache invalidates
      fs.writeFileSync(cfgPath, 'agent_panel_sort = "priority"\n');
      const future = new Date(Date.now() + 5_000);
      fs.utimesSync(cfgPath, future, future);

      expect(readHerdrPanelSortMode({ HERDR_CONFIG_PATH: cfgPath })).toBe("priority");
      expect(readSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("PLG-PERF-02 & PERF-07: Claude/Codex single-pass mtime cache, poll pacing & refreshGit debounce", () => {
    it("reads Claude JSONL once for both usage & model and skips disk reads while mtime/size unchanged", () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf02-claude-");
      const cwd = path.join(home, "repo-claude");
      const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
      const projDir = path.join(home, ".claude", "projects", slug);
      fs.mkdirSync(projDir, { recursive: true });
      const jsonlPath = path.join(projDir, "sess-1.jsonl");
      fs.writeFileSync(
        jsonlPath,
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 10_000, cache_read_input_tokens: 30_000, output_tokens: 2_000 },
          },
        }) + "\n",
      );

      const openSpy = vi.spyOn(fs, "openSync");
      const readdirSpy = vi.spyOn(fs, "readdirSync");

      const first = readExternalAgentMetadata("claude", cwd, "sess-1", "", home);
      expect(first.usage).toEqual({ tokens: 42_000, contextWindow: 200_000, percent: 21 });
      expect(first.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
      expect(openSpy).toHaveBeenCalledTimes(1);

      // Repeated metadata, usage, and model calls on unchanged file do ZERO openSync and ZERO readdirSync
      for (let i = 0; i < 5; i++) {
        expect(readExternalAgentMetadata("claude", cwd, "sess-1", "", home).usage).toEqual(first.usage);
        expect(readExternalAgentContextUsage("claude", cwd, "sess-1", "", home)).toEqual(first.usage);
        expect(readExternalAgentModel("claude", cwd, "sess-1", home)).toEqual(first.model);
      }
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(readdirSpy).toHaveBeenCalledTimes(0);

      // Append a new line -> size/mtime changes -> re-reads once
      fs.appendFileSync(
        jsonlPath,
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-5",
            usage: { input_tokens: 50_000, output_tokens: 10_000 },
          },
        }) + "\n",
      );
      const updated = readExternalAgentMetadata("claude", cwd, "sess-1", "", home);
      expect(updated.usage).toEqual({ tokens: 60_000, contextWindow: 200_000, percent: 30 });
      expect(updated.model).toEqual({ provider: "anthropic", id: "claude-opus-4-5" });
      expect(openSpy).toHaveBeenCalledTimes(2);
    });

    it("caches Codex session directory scan (TTL) and JSONL tail parse by mtime/size", () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf02-codex-");
      const cwd = path.join(home, "repo-codex");
      const codexDir = path.join(home, ".codex", "sessions", "2026", "11", "24");
      fs.mkdirSync(codexDir, { recursive: true });
      const file = path.join(codexDir, "rollout-codex-1.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { cwd } }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { last_token_usage: { total_tokens: 25_840 }, model_context_window: 258_400 },
            },
          }),
        ].join("\n") + "\n",
      );

      const openSpy = vi.spyOn(fs, "openSync");
      const readdirSpy = vi.spyOn(fs, "readdirSync");

      const first = readExternalAgentContextUsage("codex", cwd, null, "", home);
      expect(first).toEqual({ tokens: 25_840, contextWindow: 258_400, percent: 10 });
      const opensAfterFirst = openSpy.mock.calls.length;
      const readdirsAfterFirst = readdirSpy.mock.calls.length;
      expect(readdirsAfterFirst).toBeGreaterThan(0);

      // Repeated polls within TTL do ZERO extra openSync and ZERO extra readdirSync
      vi.advanceTimersByTime(5_000);
      for (let i = 0; i < 5; i++) {
        expect(readExternalAgentContextUsage("codex", cwd, null, "", home)).toEqual(first);
      }
      expect(openSpy.mock.calls.length).toBe(opensAfterFirst);
      expect(readdirSpy.mock.calls.length).toBe(readdirsAfterFirst);
    });

    it("relaxes non-watcher idle polling to 20s and active pollPaneFallback to 2s without duplicate JSONL scan", async () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf02-pacing-");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
      const cwd = path.join(home, "repo");
      fs.mkdirSync(cwd, { recursive: true });
      const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
      const projDir = path.join(home, ".claude", "projects", slug);
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "c-pace.jsonl"),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-sonnet-4-5", usage: { input_tokens: 20_000, output_tokens: 0 } },
        }) + "\n",
      );

      let paneReads = 0;
      const transports = new Map<string, FakeTransport>();
      const session = new BridgedAgentSession(
        {
          agent: "claude",
          sessionId: "c-pace",
          status: "idle",
          cwd,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
        },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg: baseCfg,
          herdrSession: null,
          connectionFactory: makeConnFactory(transports),
          runner: async (cmd, args) => {
            if (cmd === "herdr" && args[0] === "pane" && args[1] === "read") {
              paneReads++;
              return { code: 0, stdout: JSON.stringify({ result: { text: `output ${paneReads}` } }), stderr: "" };
            }
            return { code: 0, stdout: "{}", stderr: "" };
          },
        },
      );

      try {
        const ft = transports.get(session.agentId)!;
        ft.open();
        ft.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        // Idle non-watcher poll should NOT fire at 4.5s or 19s; fires at 20s
        await vi.advanceTimersByTimeAsync(19_500);
        expect(paneReads).toBe(0);
        await vi.advanceTimersByTimeAsync(600);
        expect(paneReads).toBe(1);

        // Transition to working -> active pollPaneFallback runs every 2s (NOT 900ms)
        session.updateFromHerdr({
          agent: "claude",
          sessionId: "c-pace",
          status: "working",
          cwd,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 2,
        });
        const readsAfterTransition = paneReads;
        await vi.advanceTimersByTimeAsync(1_800);
        expect(paneReads).toBe(readsAfterTransition);
        await vi.advanceTimersByTimeAsync(300);
        expect(paneReads).toBe(readsAfterTransition + 1);
      } finally {
        session.stop();
        homeSpy.mockRestore();
      }
    });

    it("debounces refreshGit() trailing 3s after edit/write/bash tool ends, skips when already dirty mid-turn, and refreshes immediately on agent_settled", async () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf07-git-");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
      const convId = "conv-git-debounce";
      const tPath = resolveAgyTranscriptPath(convId, home);
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.writeFileSync(tPath, "");

      const transports = new Map<string, FakeTransport>();
      const session = new BridgedAgentSession(
        {
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
        },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg: baseCfg,
          herdrSession: null,
          connectionFactory: makeConnFactory(transports),
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        },
      );

      try {
        const ft = transports.get(session.agentId)!;
        ft.open();
        ft.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        // Reset git state to clean and spy on refreshGit
        (session as any).git = { branch: "main", dirty: false };
        let gitRefreshCalls = 0;
        vi.spyOn(session as any, "refreshGit").mockImplementation(async () => {
          gitRefreshCalls++;
          (session as any).git = { branch: "main", dirty: true };
        });

        const appendEditTool = (baseIdx: number) => {
          fs.appendFileSync(
            tPath,
            [
              {
                step_index: baseIdx,
                type: "PLANNER_RESPONSE",
                status: "DONE",
                created_at: "2026-11-24T10:00:00Z",
                tool_calls: [{ id: `c-${baseIdx}`, name: "edit_file", args: { Path: "/repo/a.ts", Target: "a", Replacement: "b" } }],
              },
              {
                step_index: baseIdx + 1,
                type: "GENERIC",
                status: "DONE",
                created_at: "2026-11-24T10:00:01Z",
                content: "ok",
              },
            ]
              .map((s) => JSON.stringify(s))
              .join("\n") + "\n",
          );
        };

        // 3 rapid edit tool ends within 1.5s -> debounced to 1 trailing refresh after 3s
        appendEditTool(0);
        await session.pollTranscriptNow();
        await vi.advanceTimersByTimeAsync(500);
        appendEditTool(2);
        await session.pollTranscriptNow();
        await vi.advanceTimersByTimeAsync(500);
        appendEditTool(4);
        await session.pollTranscriptNow();

        expect(gitRefreshCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(2_900);
        expect(gitRefreshCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(gitRefreshCalls).toBe(1);

        // Now git.dirty === true during working turn -> another edit tool end skips scheduling
        appendEditTool(6);
        await session.pollTranscriptNow();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(gitRefreshCalls).toBe(1);

        // Turn settles (working -> idle) -> refreshes immediately
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "idle",
          cwd: home,
          paneId: "w1:p1",
          tabId: "t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 2,
        });
        expect(gitRefreshCalls).toBe(2);
      } finally {
        session.stop();
        homeSpy.mockRestore();
      }
    });
  });

  describe("PLG-PERF-03: AGY strict SQLite throttle, getLastModel, transcript_full cache, realpathSync cache & child throttle", () => {
    it("enforces 10s wall-clock throttle in readAgySessionModel even under rapid transcript.jsonl appends, and skips 256KB scan when knownTranscriptModel is passed", () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf03-sqlite-");
      const convId = "conv-throttle-1";
      const tPath = resolveAgyTranscriptPath(convId, home);
      const convDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
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
      fs.writeFileSync(tPath, JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", content: "step 0" }) + "\n");

      const openSpy = vi.spyOn(fs, "openSync");

      // First call with knownTranscriptModel: null -> skips 256KB transcript openSync and reads DB
      expect(readAgySessionModel(convId, home, { knownTranscriptModel: null })).toEqual({
        model: "gemini-3.8-flash",
        uncertain: false,
      });
      const opensAfterFirst = openSpy.mock.calls.filter((c) => String(c[0]) === tPath).length;
      expect(opensAfterFirst).toBe(0);

      // Simulate rapid transcript appends AND DB updates within 10s -> strictly throttled!
      writeDbModel("gemini-4-later");
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(dbPath, future, future);

      for (let i = 1; i <= 5; i++) {
        fs.appendFileSync(tPath, JSON.stringify({ step_index: i, type: "PLANNER_RESPONSE", content: `step ${i}` }) + "\n");
        vi.advanceTimersByTime(1_000);
        expect(readAgySessionModel(convId, home)).toEqual({
          model: "gemini-3.8-flash",
          uncertain: false,
        });
      }
      // Zero transcript.jsonl reads during throttle window!
      expect(openSpy.mock.calls.filter((c) => String(c[0]) === tPath).length).toBe(0);

      // Passing a newly detected knownTranscriptModel takes effect immediately without opening transcript.jsonl
      expect(readAgySessionModel(convId, home, { knownTranscriptModel: "Claude Sonnet 4.5" })).toEqual({
        model: "Claude Sonnet 4.5",
        uncertain: false,
      });
      expect(openSpy.mock.calls.filter((c) => String(c[0]) === tPath).length).toBe(0);

      // After >= 10s elapses and DB changed, refreshes from DB
      const future2 = new Date(Date.now() + 15_000);
      fs.utimesSync(dbPath, future2, future2);
      vi.advanceTimersByTime(10_500);
      expect(readAgySessionModel(convId, home, { knownTranscriptModel: "Claude Sonnet 4.5" })).toEqual({
        model: "gemini-4-later",
        uncertain: false,
      });
    });

    it("exposes getLastModel() from AgyTranscriptReader and caches readFullStepsMap() by (fullPath, mtimeMs, size)", () => {
      const dir = mkTmp("rp-perf03-fullsteps-");
      const tPath = path.join(dir, "transcript.jsonl");
      const fullPath = path.join(dir, "transcript_full.jsonl");

      const fullSteps = [
        {
          step_index: 0,
          type: "USER_INPUT",
          content:
            "<USER_REQUEST>Hi</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 2.5 to Claude Sonnet 4.5.\n</USER_SETTINGS_CHANGE>",
        },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "Full content 1" },
        { step_index: 2, type: "PLANNER_RESPONSE", content: "Full content 2" },
      ];
      fs.writeFileSync(fullPath, fullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
      fs.writeFileSync(
        tPath,
        [
          fullSteps[0],
          { step_index: 1, type: "PLANNER_RESPONSE", content: "Trunc 1...", truncated_fields: ["content"] },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const openSpy = vi.spyOn(fs, "openSync");
      const reader = new AgyTranscriptReader(tPath);
      const ev1 = reader.pollNewEvents();
      expect(reader.getLastModel()).toBe("Claude Sonnet 4.5");
      expect(JSON.stringify(ev1)).toContain("Full content 1");
      expect(openSpy.mock.calls.filter((c) => String(c[0]) === fullPath)).toHaveLength(1);

      // Append another truncated step while transcript_full.jsonl mtime/size is unchanged -> cache HIT (0 extra opens)
      fs.appendFileSync(
        tPath,
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Trunc 2...", truncated_fields: ["content"] }) + "\n",
      );
      const ev2 = reader.pollNewEvents();
      expect(JSON.stringify(ev2)).toContain("Full content 2");
      expect(openSpy.mock.calls.filter((c) => String(c[0]) === fullPath)).toHaveLength(1);

      // Update transcript_full.jsonl with step 3 -> size/mtime changes -> cache invalidates and reads once
      fs.appendFileSync(fullPath, JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", content: "Full content 3" }) + "\n");
      fs.appendFileSync(
        tPath,
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", content: "Trunc 3...", truncated_fields: ["content"] }) + "\n",
      );
      const ev3 = reader.pollNewEvents();
      expect(JSON.stringify(ev3)).toContain("Full content 3");
      expect(openSpy.mock.calls.filter((c) => String(c[0]) === fullPath)).toHaveLength(2);
    });

    it("skips realpathSync on unchanged child/bgTask files while still rejecting symlink replacement, and throttles child readAgySessionModel()", () => {
      vi.useFakeTimers();
      const dir = mkTmp("rp-perf03-realpath-");
      const homeDir = path.join(dir, "home");
      const parentConv = "perf03-parent";
      const childConv = "perf03-child";
      const parentPath = resolveAgyTranscriptPath(parentConv, homeDir);
      const childPath = resolveAgyTranscriptPath(childConv, homeDir);
      const tasksDir = path.join(path.dirname(path.dirname(parentPath)), "tasks");
      fs.mkdirSync(path.dirname(parentPath), { recursive: true });
      fs.mkdirSync(path.dirname(childPath), { recursive: true });
      fs.mkdirSync(tasksDir, { recursive: true });

      const logPath = path.join(tasksDir, "bg-1.log");
      fs.writeFileSync(logPath, "bg line 1\n");
      fs.writeFileSync(
        childPath,
        JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "/a" } }] }) + "\n",
      );
      fs.writeFileSync(
        parentPath,
        [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:00Z",
            tool_calls: [{ name: "invoke_subagent", args: { Role: "Worker", TypeName: "worker", Prompt: "Go" } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-11-24T10:00:01Z",
            content: JSON.stringify({ conversationId: childConv, logAbsoluteUri: pathToFileURL(childPath).href }),
          },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T10:00:02Z",
            tool_calls: [{ id: "call-bg", name: "run_command", args: { CommandLine: '"sleep 5"' } }],
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "RUNNING",
            created_at: "2026-11-24T10:00:03Z",
            content: `Tool is running as a background task with task id: ${parentConv}/bg-1\nTask logs are available at: ${pathToFileURL(logPath).href}`,
          },
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      const reader = new AgyTranscriptReader(parentPath);
      reader.pollNewEvents();

      const realpathSpy = vi.spyOn(fs, "realpathSync");
      const statSpy = vi.spyOn(fs, "statSync");

      // 5 steady-state polls within 5s: ZERO realpathSync calls, and child model DB stat throttled!
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(900);
        reader.pollNewEvents();
      }
      expect(realpathSpy).toHaveBeenCalledTimes(0);
      const childDbPath = path.join(homeDir, ".gemini", "antigravity-cli", "conversations", `${childConv}.db`);
      expect(statSpy.mock.calls.filter((c) => String(c[0]) === childDbPath)).toHaveLength(0);

      // Security invariant: replacing logPath with a symlink to outside file MUST be rejected immediately
      if (process.platform !== "win32") {
        const outsideSecret = path.join(dir, "secret.log");
        fs.writeFileSync(outsideSecret, "LEAKED_SECRET_CONTENT\n");
        fs.unlinkSync(logPath);
        fs.symlinkSync(outsideSecret, logPath);
        const evs = reader.pollNewEvents();
        expect(JSON.stringify(evs)).not.toContain("LEAKED_SECRET_CONTENT");
      }
    });
  });

  describe("PLG-PERF-04 (bridge side): agent.hello dedup & model reuse", () => {
    it("does NOT send agent.hello on context token changes, coalesces orderIndex-only updates with 1.5s debounce, and reuses cached model in makeHello()", async () => {
      vi.useFakeTimers();
      const home = mkTmp("rp-perf04-hello-");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
      const convId = "conv-hello-dedup";
      const tPath = resolveAgyTranscriptPath(convId, home);
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.writeFileSync(tPath, "");

      const transports = new Map<string, FakeTransport>();
      const session = new BridgedAgentSession(
        {
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
          orderIndex: 1,
        },
        {
          relayUrl: "https://relay.example.com",
          machineId: "M1",
          token: "T1",
          cfg: baseCfg,
          herdrSession: null,
          connectionFactory: makeConnFactory(transports),
          runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        },
      );

      try {
        const ft = transports.get(session.agentId)!;
        ft.open();
        ft.receive({ v: 1, id: "w1", t: "agent.welcome", ts: Date.now(), d: { serverTime: Date.now(), lastSeq: null, pendingAnswers: [] } });

        ft.sent.length = 0;

        // 1. Context token changes -> emits agent.statuses (rp:context) ONLY, ZERO agent.hello!
        for (let i = 0; i < 4; i++) {
          fs.appendFileSync(
            tPath,
            JSON.stringify({
              step_index: i,
              type: "PLANNER_RESPONSE",
              created_at: `2026-11-24T10:00:0${i}Z`,
              content: `Turn ${i}`,
              input_tokens: 10_000 * (i + 1),
              output_tokens: 500,
            }) + "\n",
          );
          await session.pollTranscriptNow();
        }
        expect(ft.sent.filter((e) => e.t === "agent.statuses").length).toBe(4);
        expect(ft.sent.filter((e) => e.t === "agent.hello")).toHaveLength(0);

        // 2. Rapid orderIndex-only reorders -> debounced 1.5s into a single agent.hello
        ft.sent.length = 0;
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
          orderIndex: 2,
        });
        await vi.advanceTimersByTimeAsync(500);
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
          orderIndex: 3,
        });
        expect(ft.sent.filter((e) => e.t === "agent.hello")).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1_600);
        const orderHellos = ft.sent.filter((e) => e.t === "agent.hello");
        expect(orderHellos).toHaveLength(1);
        expect((orderHellos[0]!.d as any).herdr.tabId).toMatch(/^#0003(?:@[^|]+)?\|w1:t1$/);

        // 2b. Transient orderIndex bounce (3 -> 2 -> 3 within 1.5s) sends ZERO agent.hello
        ft.sent.length = 0;
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
          orderIndex: 2,
        });
        await vi.advanceTimersByTimeAsync(400);
        session.updateFromHerdr({
          agent: "agy",
          sessionId: convId,
          status: "working",
          cwd: home,
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          title: null,
          stateChangeSeq: 1,
          orderIndex: 3,
        });
        await vi.advanceTimersByTimeAsync(1_600);
        expect(ft.sent.filter((e) => e.t === "agent.hello")).toHaveLength(0);

        // 3. makeHello() reuses cached model without re-reading settings/DB from disk
        const readSpy = vi.spyOn(fs, "readFileSync");
        const statSpy = vi.spyOn(fs, "statSync");
        session.makeHello();
        session.makeHello();
        expect(readSpy).toHaveBeenCalledTimes(0);
        expect(statSpy.mock.calls.filter((c) => String(c[0]).includes("conversations") || String(c[0]).includes("settings.json"))).toHaveLength(0);
      } finally {
        session.stop();
        homeSpy.mockRestore();
      }
    });
  });

  describe("PLG-PERF-10: identity-only session persistence", () => {
    it("persists only stable identity fields and skips disk writes on volatile status/stateChangeSeq/orderIndex changes", async () => {
      const dir = mkTmp("rp-perf10-persist-");
      const stateFile = path.join(dir, "herdr-active-sessions.json");
      let pollStep = 0;
      const transports = new Map<string, FakeTransport>();

      const bridge = new HerdrAgentBridge({
        relayUrl: "https://relay.example.com",
        machineId: "M1",
        token: "T1",
        cfg: baseCfg,
        herdrSession: null,
        socketPath: makeSocketPath(dir),
        stateFile,
        pollIntervalMs: 60_000,
        panelSortMode: "priority",
        connectionFactory: makeConnFactory(transports),
        runner: async (cmd, args) => {
          if (cmd === "herdr" && args[0] === "agent" && args[1] === "list") {
            pollStep++;
            const cwd = pollStep >= 5 ? path.join(dir, "moved") : dir;
            const status = pollStep === 1 ? "idle" : pollStep === 2 ? "working" : "done";
            return {
              code: 0,
              stdout: JSON.stringify({
                result: {
                  agents: [
                    {
                      agent: "claude",
                      pane_id: "w1:p1",
                      tab_id: "w1:t1",
                      workspace_id: "w1",
                      cwd,
                      agent_status: status,
                      state_change_seq: pollStep * 10,
                    },
                  ],
                },
              }),
              stderr: "",
            };
          }
          return { code: 0, stdout: "{}", stderr: "" };
        },
      });

      const renameSpy = vi.spyOn(fs, "renameSync");
      try {
        // Poll 1: creates stateFile with identity-only fields
        await bridge.poll();
        expect(renameSpy).toHaveBeenCalledTimes(1);
        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        expect(saved).toEqual([
          {
            agent: "claude",
            sessionId: null,
            paneId: "w1:p1",
            cwd: dir,
            tabId: "w1:t1",
            workspaceId: "w1",
            title: null,
          },
        ]);
        expect("status" in saved[0]).toBe(false);
        expect("stateChangeSeq" in saved[0]).toBe(false);
        expect("orderIndex" in saved[0]).toBe(false);

        // Polls 2, 3, 4: volatile status & stateChangeSeq change -> ZERO extra disk writes!
        await bridge.poll();
        await bridge.poll();
        await bridge.poll();
        expect(renameSpy).toHaveBeenCalledTimes(1);

        // Poll 5: stable identity field (cwd) changes -> triggers disk write
        await bridge.poll();
        expect(renameSpy).toHaveBeenCalledTimes(2);
        const updated = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        expect(updated[0].cwd).toBe(path.join(dir, "moved"));
      } finally {
        bridge.stop();
      }
    });
  });
});
