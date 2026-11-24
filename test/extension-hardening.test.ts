import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, LongPollTransport, WsTransport, type ConnectionOptions } from "../src/extension/connection.ts";
import { Forwarder, LIMITS, normalizeMessage } from "../src/extension/forwarder.ts";
import { buildSnapshotEntries, toSnapshotEntry, MAX_SNAPSHOT_BYTES } from "../src/extension/snapshot.ts";
import { Broker, toLocalValue } from "../src/extension/prompts/broker.ts";
import { Classifier } from "../src/extension/prompts/classify.ts";
import { allowKey } from "../src/extension/prompts/gate.ts";
import { AdapterRegistry, gentleAskUserChoice, gentleAskUserQuestion, piAskUser, reviewConsent } from "../src/extension/prompts/adapters/index.ts";
import { Deliverer } from "../src/extension/delivery/index.ts";
import { handleModelCommand, handleThinkingCommand } from "../src/extension/delivery/slash-commands.ts";
import { Runtime } from "../src/extension/runtime.ts";
import { updateConfigFile } from "../src/extension/config.ts";
import { checkDeclared, pluginDeclaredIn } from "../src/extension/commands.ts";
import { getProxyAgent, httpRequest } from "../src/shared/http.ts";
import { atomicWriteFileSync, truncateBytes } from "../src/shared/util.ts";
import { CLOSE, MAX_FRAME_BYTES, envelope } from "../src/shared/protocol.ts";
import { FakeRelay, baseConfig, makeCtx, makePi, noEnv, waitUntil } from "./helpers.ts";

let relay: FakeRelay | undefined;
let conn: Connection | undefined;
let server: http.Server | undefined;
const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  conn?.stop();
  conn = undefined;
  await relay?.stop();
  relay = undefined;
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("B-02: LongPollTransport wire contract & bounds", () => {
  it("POSTs JSON { agentId, instance, timeout: 25000 } to /v1/agent/poll with application/json content-type", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M1:S1",
      instance: "INST-1",
      makeHello: () => ({ agentId: "M1:S1" }),
      onWelcome: () => {},
      onMessage: () => {},
      wsFailuresBeforeLongPoll: 1,
      wsRetryMs: 60_000,
      backoff: () => 20,
    });
    conn.start();
    await waitUntil(() => conn!.transportName === "longpoll" && conn!.connected, 5000);
    const pollReq = relay.httpLog.find((h) => h.url.startsWith("/v1/agent/poll"));
    expect(pollReq).toBeDefined();
    expect(pollReq!.url).toBe("/v1/agent/poll");
    expect(String(pollReq!.headers["content-type"] ?? "")).toContain("application/json");
    expect(pollReq!.body).toEqual({ agentId: "M1:S1", instance: "INST-1", timeout: 25_000 });

    // FakeRelay enforces application/json and JSON body.agentId on POST /v1/agent/poll
    const badMime = await httpRequest(`${relay.url}/v1/agent/poll`, { method: "POST", body: "{}" });
    expect(badMime.status).toBe(415);
    const missingId = await httpRequest(`${relay.url}/v1/agent/poll`, { method: "POST", body: {} });
    expect(missingId.status).toBe(400);
  });

  it("maps HTTP 410 { closeCode } to the exact fatal close code and defaults missing closeCode to CLOSE.REPLACED", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/agent/poll", () => ({
      status: 410,
      body: { error: { code: "conflict", message: "replaced" }, closeCode: CLOSE.INVALID_TOKEN },
    }));
    const closed: Array<{ code: number; reason: string }> = [];
    const lp = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I1" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (info) => closed.push({ code: info.code, reason: info.reason }),
    });
    lp.start();
    await waitUntil(() => closed.length === 1, 5000);
    expect(closed[0]!.code).toBe(CLOSE.INVALID_TOKEN);

    relay.httpResponses.set("/v1/agent/poll", () => ({ status: 410, body: {} }));
    const closed2: Array<{ code: number }> = [];
    const lp2 = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I2" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (info) => closed2.push({ code: info.code }),
    });
    lp2.start();
    await waitUntil(() => closed2.length === 1, 5000);
    expect(closed2[0]!.code).toBe(CLOSE.REPLACED);
  });

  it("fails on 3xx or non-JSON 200 HTML poll responses and backs off on fast empty polls", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/agent/poll", () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html>captive portal</html>"),
    }));
    const closed: number[] = [];
    const lp = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (info) => closed.push(info.code),
    });
    lp.start();
    await waitUntil(() => closed.length === 1, 5000);
    expect(closed[0]).toBe(1006);

    // 3xx status fails
    relay.httpResponses.set("/v1/agent/poll", () => ({ status: 302, headers: { location: "https://login.example" } }));
    const closed3xx: number[] = [];
    const lp3 = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (info) => closed3xx.push(info.code),
    });
    lp3.start();
    await waitUntil(() => closed3xx.length === 1, 5000);
    expect(closed3xx[0]).toBe(1006);

    // Fast empty 200 polls back off instead of spinning at 0ms
    let fastPolls = 0;
    relay.httpResponses.set("/v1/agent/poll", () => {
      fastPolls++;
      return { status: 200, body: { messages: [] } };
    });
    const lpFast = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
    });
    lpFast.start();
    await new Promise((r) => setTimeout(r, 350));
    lpFast.close();
    // With exponential backoff (100ms, 200ms, 400ms...), at most ~3 polls occur in 350ms instead of hundreds
    expect(fastPolls).toBeGreaterThanOrEqual(1);
    expect(fastPolls).toBeLessThan(8);
  });

  it("caps outbox, splits flush batches by serialized byte size, and fails when relay reports rejected > 0", async () => {
    relay = await new FakeRelay().start();
    const sendBatches: number[] = [];
    relay.httpResponses.set("/v1/agent/send", (_req, body) => {
      sendBatches.push(Buffer.byteLength(JSON.stringify(body)));
      return { status: 200, body: { ok: true, accepted: Array.isArray(body) ? body.length : 0, rejected: 0 } };
    });
    const lp = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
    });
    // Outbox count cap: sending > 500 messages before flush starts returns false
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 600; i++) {
      if (lp.send(envelope("agent.event", { seq: i }))) accepted++;
      else rejected++;
    }
    expect(accepted).toBeLessThanOrEqual(500);
    expect(rejected).toBeGreaterThan(0);
    lp.close();

    // Batch byte size cap (<= 750 KB)
    const lpBytes = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
    });
    for (let i = 0; i < 6; i++) {
      lpBytes.send(envelope("agent.event", { seq: i, pad: "x".repeat(200 * 1024) }));
    }
    lpBytes.start();
    await waitUntil(() => sendBatches.length >= 2, 5000);
    for (const sz of sendBatches) {
      expect(sz).toBeLessThanOrEqual(750 * 1024);
    }
    lpBytes.close();

    // Relay returns rejected > 0 -> transport fails
    relay.httpResponses.set("/v1/agent/send", () => ({ status: 200, body: { ok: true, accepted: 0, rejected: 1 } }));
    const closedRejected: Array<{ code: number; reason: string }> = [];
    const lpRej = new LongPollTransport(relay.url, "tok", { agentId: "M:S", instance: "I" }, {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (info) => closedRejected.push({ code: info.code, reason: info.reason }),
    });
    lpRej.send(envelope("agent.event", { seq: 1 }));
    lpRej.start();
    await waitUntil(() => closedRejected.length === 1, 5000);
    expect(closedRejected[0]!.reason).toMatch(/rejected/i);
  });
});

describe("W-10: httpRequest resilience & getProxyAgent memoization", () => {
  it("rejects on premature incomplete response close instead of hanging", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await expect(httpRequest(`http://127.0.0.1:${port}/test`, { timeoutMs: 3000 })).rejects.toThrow();
  });

  it("enforces total deadline timer against slow trickle responses", async () => {
    const intervals: NodeJS.Timeout[] = [];
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const iv = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write("a");
      }, 40);
      intervals.push(iv);
      res.on("close", () => clearInterval(iv));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const t0 = Date.now();
    await expect(httpRequest(`http://127.0.0.1:${port}/trickle`, { timeoutMs: 180 })).rejects.toThrow(/timeout/i);
    expect(Date.now() - t0).toBeLessThan(1500);
    for (const iv of intervals) clearInterval(iv);
  });

  it("memoizes in-flight getProxyAgent() calls to a single shared Agent instance", async () => {
    const [a, b, c] = await Promise.all([getProxyAgent(), getProxyAgent(), getProxyAgent()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("C-09 + W-11 + C-03: Connection reconnect jitter, fatal cleanup, stability window & frame/snapshot caps", () => {
  it("applies 250-1500ms jitter on first 1012 and escalates to backoff on consecutive 1012 closes", async () => {
    relay = await new FakeRelay().start();
    const backoffCalls: number[] = [];
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      backoff: (attempt) => {
        backoffCalls.push(attempt);
        return 120;
      },
      stabilityWindowMs: 5_000,
    });
    conn.start();
    await waitUntil(() => conn!.connected, 3000);
    const t0 = Date.now();
    relay.closeAll(CLOSE.SERVICE_RESTART);
    await waitUntil(() => relay!.of("agent.hello").length === 2, 3000);
    const firstElapsed = Date.now() - t0;
    expect(firstElapsed).toBeGreaterThanOrEqual(200);
    expect(backoffCalls).toHaveLength(0);

    // Second consecutive 1012 within stability window must escalate to backoff()
    await waitUntil(() => conn!.connected, 3000);
    relay.closeAll(CLOSE.SERVICE_RESTART);
    await waitUntil(() => relay!.of("agent.hello").length === 3, 3000);
    expect(backoffCalls).toEqual([0]);
  });

  it("flushes connectedWaiters(false) and empties queue on fatal close", async () => {
    relay = await new FakeRelay().start();
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      backoff: () => 20,
    });
    conn.send("agent.event", { seq: 1 });
    expect(conn.queued).toBe(1);
    const waiter = conn.whenConnected(10_000);
    relay.rejectUpgrade = 401;
    conn.start();
    const ok = await waiter;
    expect(ok).toBe(false);
    expect(conn.queued).toBe(0);
    expect(conn.state).toBe("stopped");
  });

  it("does not reset backoff attempt when welcome is followed by rapid disconnect", async () => {
    relay = await new FakeRelay().start();
    const attempts: number[] = [];
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {
        // simulate relay closing immediately after welcome (e.g. oversized snapshot)
        setTimeout(() => relay?.closeAll(1009, "message too big"), 5);
      },
      onMessage: () => {},
      backoff: (a) => {
        attempts.push(a);
        return 20;
      },
      stabilityWindowMs: 5_000,
    });
    conn.start();
    await waitUntil(() => attempts.length >= 3, 4000);
    expect(attempts.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it("resets backoff attempt after staying connected past stabilityWindowMs", async () => {
    relay = await new FakeRelay().start();
    const attempts: number[] = [];
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      backoff: (a) => {
        attempts.push(a);
        return 20;
      },
      stabilityWindowMs: 40,
    });
    conn.start();
    await waitUntil(() => conn!.connected, 3000);
    relay.closeAll(1011);
    await waitUntil(() => attempts.length === 1 && conn!.connected, 3000);
    await new Promise((r) => setTimeout(r, 80)); // past 40ms stabilityWindowMs
    relay.closeAll(1011);
    await waitUntil(() => attempts.length === 2, 3000);
    expect(attempts).toEqual([0, 0]);
  });

  it("WsTransport ignores open if close() was called before open completes", async () => {
    relay = await new FakeRelay().start();
    let opened = false;
    const ws = new WsTransport(`ws://127.0.0.1:${relay.port}/ws/agent`, "tok", {
      onOpen: () => {
        opened = true;
      },
      onMessage: () => {},
      onClose: () => {},
    });
    ws.start();
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toBe(false);
  });

  it("enforces MAX_SNAPSHOT_BYTES in buildSnapshotEntries and truncates thinking/toolCall/summaries", () => {
    const big = "x".repeat(60 * 1024);
    const branch = Array.from({ length: 20 }, (_, i) => ({
      type: "message",
      id: `m${i}`,
      timestamp: Date.now(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: big },
          { type: "toolCall", id: `tc${i}`, name: "write", arguments: { path: "a.ts", content: big } },
          { type: "text", text: big },
        ],
      },
    }));
    const { entries, truncated } = buildSnapshotEntries(branch, false);
    expect(truncated).toBe(true);
    const serializedBytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
    expect(serializedBytes).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);

    // Compaction & custom_message summaries are truncated
    const comp = toSnapshotEntry({ type: "compaction", id: "c1", summary: "s".repeat(100_000) }, false);
    expect(Buffer.byteLength(JSON.stringify(comp), "utf8")).toBeLessThan(40 * 1024);
    const custom = toSnapshotEntry({ type: "custom_message", id: "cm1", customType: "x", content: "c".repeat(100_000) }, false);
    expect(Buffer.byteLength(JSON.stringify(custom), "utf8")).toBeLessThan(40 * 1024);
  });

  it("Forwarder bounds thinking, toolCall args, tool_execution_start args and Connection guards MAX_FRAME_BYTES", async () => {
    const sent: any[] = [];
    const fw = new Forwarder({ send: (e) => sent.push(e), redact: false });
    const huge = "z".repeat(200_000);
    fw.handle("tool_execution_start", { toolCallId: "t1", toolName: "write", args: { path: "f.ts", content: huge } });
    expect(Buffer.byteLength(JSON.stringify(sent[0]), "utf8")).toBeLessThan(LIMITS.resultMaxBytes);
    const nm = normalizeMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: huge },
        { type: "toolCall", id: "t1", name: "write", arguments: { path: "f.ts", content: huge } },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(nm), "utf8")).toBeLessThan(100 * 1024);

    // Connection refuses to transmit oversized single frames (> MAX_FRAME_BYTES)
    relay = await new FakeRelay().start();
    const logs: string[] = [];
    conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      onLog: (m) => logs.push(m),
      backoff: () => 20,
    });
    conn.start();
    await waitUntil(() => conn!.connected, 3000);
    conn.send("agent.event", { huge: "A".repeat(MAX_FRAME_BYTES + 1024) });
    expect(conn.needsSnapshot).toBe(true);
    expect(logs.some((l) => /oversized|MAX_FRAME_BYTES/i.test(l))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.of("agent.event")).toHaveLength(0);
  });
});

describe("C-02 + S-02: Strict option index parsing & questionnaire deduplication", () => {
  it("rejects empty/whitespace/null/boolean optionIds instead of coercing to 0 (ALLOW / granted)", () => {
    const sel = { kind: "select" as const, title: "Gate", options: ["Permitir", "Denegar"] };
    for (const bad of ["", " ", "0x0", "-1", "1.5", null, false, 0]) {
      expect(toLocalValue(sel, { optionIds: [bad as any] })).toBeUndefined();
      expect(reviewConsent.toResult({}, { optionIds: [bad as any] })).toBeUndefined();
      expect(
        gentleAskUserChoice.toResult(
          {
            question: "Q",
            options: [
              { label: "A", description: "a", value: "a" },
              { label: "B", description: "b", value: "b" },
            ],
          },
          { optionIds: [bad as any] },
        ),
      ).toBeUndefined();
    }
    // Non-array optionIds in reviewConsent does not throw
    expect(reviewConsent.toResult({}, { optionIds: "0" as any })).toBeUndefined();
    expect(reviewConsent.toResult({}, { optionIds: null as any })).toBeUndefined();

    // piAskUser rejects empty/whitespace optionIds
    const askArgs = {
      questions: [{ id: "q1", prompt: "P", options: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }] }],
    };
    expect((piAskUser.toResult(askArgs, { answers: [{ questionIndex: 0, optionIds: [""] }] }) as any).cancelled).toBe(true);
    expect((piAskUser.toResult(askArgs, { answers: [{ questionIndex: 0, optionIds: [" "] }] }) as any).cancelled).toBe(true);
  });

  it("deduplicates questionIndex in gentleAskUserQuestion before validating all questions answered", () => {
    const qArgs = {
      questions: [
        { question: "Q1?", header: "H1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
        { question: "Q2?", header: "H2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
      ],
    };
    // Two entries both for questionIndex 0, missing questionIndex 1 -> must cancel!
    const dup = gentleAskUserQuestion.toResult(qArgs, {
      answers: [
        { questionIndex: 0, optionIds: ["0"] },
        { questionIndex: 0, optionIds: ["1"] },
      ],
    });
    expect(dup).toEqual({ cancelled: true, answers: [] });

    // Empty string optionId must not coerce to index 0
    const emptyOpt = gentleAskUserQuestion.toResult(qArgs, {
      answers: [
        { questionIndex: 0, optionIds: [""] },
        { questionIndex: 1, optionIds: ["0"] },
      ],
    });
    expect(emptyOpt).toEqual({ cancelled: true, answers: [] });
  });
});

describe("W-01: Gate.allowKey hardening", () => {
  it("keys full command for env-var prefixes, quotes, backslashes, CR, and shell wrappers", () => {
    const fullCmds = [
      "CI=1 npm test",
      "NODE_ENV=production node index.js",
      "'python3' -c 'import os'",
      '"bash" -c id',
      "\\rm -rf /tmp/x",
      "ls\rrm -rf /",
      "eval echo hi",
      "exec /bin/sh",
      "command rm -rf /",
      "source script.sh",
      ". script.sh",
      "timeout 5 rm -rf /",
      "nohup ./run.sh",
      "nice -n 10 ./run.sh",
      "time ./run.sh",
      "setsid ./run.sh",
      "stdbuf -o0 ./run.sh",
      "awk '{print}' file",
      "ssh host rm -rf /",
      "docker run alpine sh",
    ];
    for (const command of fullCmds) {
      expect(allowKey("bash", { command })).toBe(`bash:${command}`);
    }
  });
});

describe("W-08: AdapterRegistry async factory & remote error handling", () => {
  it("mirrors, accepts remote answers, and closes prompt when runOrig invokes factory asynchronously", async () => {
    const sent: Array<[string, any]> = [];
    const broker = new Broker({
      agentId: "M:S",
      send: (t, d) => sent.push([t, d]),
      hasUI: true,
      classifier: new Classifier(),
      herdr: null,
    });
    const registry = new AdapterRegistry(broker, [reviewConsent]);
    registry.onStart({ toolCallId: "tc-async", toolName: "gentle_review", args: { operation: "start" } });

    let mode: "actions" | "details" = "actions";
    const component = {
      getActionOptions: () => [
        "1. Review this change\nEffect: reviews the frozen candidate",
        "2. Skip this time\nEffect: skips this candidate",
        "3. Review and allow this session\nEffect: allows later reviews in this session",
      ],
      handleInput: (key: string) => {
        if (key.toLowerCase() === "d") mode = mode === "actions" ? "details" : "actions";
      },
      render: () =>
        mode === "actions"
          ? ["Review consent", "1. Review this change", "2. Skip this time", "3. Review and allow this session", "↑↓ choose · Enter confirm · Esc cancel · D details"]
          : ["Details (read-only)", "Risk: low", "PgUp/PgDn · D return · Esc"],
    };

    const p = registry.customMirror(
      (_t: unknown, _th: unknown, _kb: unknown, _done: (v: unknown) => void) => component,
      undefined,
      (wrapped) =>
        new Promise((resolve) => {
          setTimeout(() => {
            wrapped({}, {}, {}, (v: unknown) => resolve(v));
          }, 15);
        }),
    );

    const open = await waitUntil(() => sent.find(([t]) => t === "prompt.open")?.[1], 2000);
    expect(broker.openCount).toBe(1);
    expect(broker.handleAnswer(open.promptId, { optionIds: ["1"] })).toBe(true);
    await expect(p).resolves.toEqual({ kind: "provider", answer: "declined" });
    expect(broker.openCount).toBe(0);
  });

  it("catches errors in remoteAnswer handler without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const sent: Array<[string, any]> = [];
      const broker = new Broker({
        agentId: "M:S",
        send: (t, d) => sent.push([t, d]),
        hasUI: true,
        classifier: new Classifier(),
        herdr: null,
      });
      const throwingAdapter = {
        tool: "boom_tool",
        extension: "test",
        accepts: () => true,
        toPrompt: () => ({ kind: "select" as const, title: "T", options: [{ id: "0", label: "A" }] }),
        toResult: () => {
          throw new Error("adapter boom");
        },
        fromResult: () => ({ cancelled: true as const }),
      };
      const reg = new AdapterRegistry(broker, [throwingAdapter]);
      reg.onStart({ toolCallId: "t1", toolName: "boom_tool", args: {} });
      let finish!: (v: unknown) => void;
      const p = reg.race(
        () => ({}),
        undefined,
        (wrapped) =>
          new Promise((resolve) => {
            finish = resolve;
            wrapped({}, {}, {}, resolve);
          }),
      );
      const open = sent.find(([t]) => t === "prompt.open")![1];
      broker.handleAnswer(open.promptId, { optionIds: ["0"] });
      await new Promise((r) => setTimeout(r, 30));
      finish(undefined);
      await p;
      expect(unhandled).toHaveLength(0);
      expect(broker.openCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("W-05 + W-14: Runtime onLog, waitSettled timeout & Deliverer select timeout/rejection", () => {
  it("passes onLog from Runtime to Connection and bounds waitSettled()", async () => {
    vi.useFakeTimers();
    const { pi } = makePi();
    const ctx = makeCtx({ idle: false });
    let capturedConnOpts: ConnectionOptions | undefined;
    const rt = new Runtime(pi, ctx, baseConfig("http://127.0.0.1:1"), noEnv, "test", {
      connectionFactory: (o) => {
        capturedConnOpts = o;
        return {
          state: "idle",
          transportName: "ws",
          connected: false,
          queued: 0,
          needsSnapshot: false,
          start: () => {},
          stop: () => {},
          send: () => {},
          sendDirect: () => false,
          whenConnected: async () => false,
          dropQueuedEventsUpTo: () => {},
          minQueuedEventSeq: () => null,
        } as unknown as Connection;
      },
    });
    expect(typeof capturedConnOpts?.onLog).toBe("function");

    const deps = (rt as any).interactiveDeps();
    let resolved = false;
    const waitP = deps.waitSettled().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await waitP;
    expect(resolved).toBe(true);
    await rt.dispose();
  });

  it("guards rejecting select in /model & /thinking without unhandled rejection and bounds activeSelectPromises wait", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { pi } = makePi();
      const ctx = makeCtx();
      ctx.modelRegistry.getAvailable = vi.fn(async () => [{ provider: "p", id: "m" }]);
      ctx.ui.select = vi.fn(async () => {
        throw new Error("ui select crashed");
      });

      await expect(handleModelCommand(pi, ctx, "")).resolves.toBeUndefined();
      await expect(handleThinkingCommand(pi, ctx, "")).resolves.toBeUndefined();

      const acks: any[] = [];
      const d = new Deliverer({
        pi,
        ctx: () => ctx,
        cfg: () => baseConfig("http://x"),
        herdr: null,
        gentleMode: () => "auto",
        fetchBlob: null,
        inboxDir: () => os.tmpdir(),
        sessionId: () => "s1",
        interactive: () => ({
          ctx: () => ctx,
          enabled: () => true,
          stdin: () => ({ emit: () => true }),
          dialogOpen: () => false,
          waitNoDialog: async () => true,
          waitSettled: async () => {},
          expectInput: async () => true,
          statuses: () => ({}),
        }),
        sendAck: (a) => acks.push(a),
        notify: () => {},
      });
      await d.handle({ clientMsgId: "sel-err", text: "/model" });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);

      // Bounded wait on stuck activeSelectPromises
      vi.useFakeTimers();
      ctx.ui.select = vi.fn(() => new Promise<string | undefined>(() => {}));
      void d.handle({ clientMsgId: "sel-stuck", text: "/model" });
      await vi.advanceTimersByTimeAsync(10);
      let nextDone = false;
      const nextP = d.handle({ clientMsgId: "msg-after-stuck", text: "hello" }).then(() => {
        nextDone = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await nextP;
      expect(nextDone).toBe(true);
      expect(acks.some((a) => a.clientMsgId === "msg-after-stuck")).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("W-12 + S-03: truncateBytes UTF-8 boundary, atomicWriteFileSync cleanup & updateConfigFile corruption safety", () => {
  it("preserves complete trailing multi-byte UTF-8 characters in truncateBytes", () => {
    expect(truncateBytes("éa", 2)).toEqual({ text: "é", truncated: true });
    expect(truncateBytes("éa", 1)).toEqual({ text: "", truncated: true });
    expect(truncateBytes("a€b", 4)).toEqual({ text: "a€", truncated: true });
    expect(truncateBytes("a€b", 3)).toEqual({ text: "a", truncated: true });
    expect(truncateBytes("😀a", 4)).toEqual({ text: "😀", truncated: true });
    expect(truncateBytes("😀a", 3)).toEqual({ text: "", truncated: true });
    expect(truncateBytes("abc", 0)).toEqual({ text: "", truncated: true });
  });

  it("cleans up temp file when atomicWriteFileSync fails on rename", () => {
    const dir = mkTempDir("rpatomic-");
    const targetDir = path.join(dir, "existing-dir");
    fs.mkdirSync(targetDir);
    expect(() => atomicWriteFileSync(targetDir, "data")).toThrow();
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("updateConfigFile throws on corrupt JSON without wiping credentials, and creates on ENOENT", () => {
    const dir = mkTempDir("rpcfg-");
    const p = path.join(dir, "config.json");
    // ENOENT -> creates
    const created = updateConfigFile(p, (c) => {
      c.machineToken = "tok-1";
    });
    expect(created.machineToken).toBe("tok-1");

    // Corrupt JSON -> throws and leaves original file untouched
    fs.writeFileSync(p, '{"machineToken": "secret", broken');
    expect(() =>
      updateConfigFile(p, (c) => {
        c.redactContent = true;
      }),
    ).toThrow();
    expect(fs.readFileSync(p, "utf8")).toBe('{"machineToken": "secret", broken');
  });
});

describe("W-15: /rp doctor git: plugin declaration", () => {
  it("accepts git: Rp-plugin sources and recommends git:github.com/J3pf/Rp-plugin", () => {
    const dir = mkTempDir("rpdoc-");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["git:github.com/J3pf/Rp-plugin@v0.4.6"] }));
    expect(pluginDeclaredIn(dir).found).toBe(true);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [{ source: "git:github.com/J3pf/Rp-plugin" }] }));
    expect(pluginDeclaredIn(dir).found).toBe(true);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["git:github.com/other/repo"] }));
    expect(pluginDeclaredIn(dir).found).toBe(false);

    const emptyHome = mkTempDir("rpdoc-home-");
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    try {
      const checks = checkDeclared({});
      expect(checks[0]!.detail).toContain("pi install git:github.com/J3pf/Rp-plugin");
      expect(checks[1]!.detail).toContain("gentle-shell install git:github.com/J3pf/Rp-plugin");
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUser;
    }
  });
});
