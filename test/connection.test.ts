import { afterEach, describe, expect, it } from "vitest";
import { Connection, type ConnectionOptions } from "../src/extension/connection.ts";
import { FakeRelay, waitUntil } from "./helpers.ts";

let relay: FakeRelay;
let conn: Connection | undefined;
afterEach(async () => {
  conn?.stop();
  conn = undefined;
  await relay?.stop();
});

function mk(over: Partial<ConnectionOptions> = {}) {
  const log = { welcomes: 0, fatal: [] as any[], states: [] as string[], messages: [] as any[], hellos: 0 };
  conn = new Connection({
    relayUrl: relay.url,
    token: "secret-token",
    agentId: "M:S",
    instance: "INST",
    makeHello: () => ({ agentId: "M:S", n: ++log.hellos, openPrompts: [] }),
    onWelcome: (w) => {
      log.welcomes++;
      conn!.sendDirect("agent.snapshot", { epoch: "E", seq: 0, entries: [] });
    },
    onMessage: (e) => log.messages.push(e),
    onState: (s, t) => log.states.push(`${s}/${t}`),
    onFatal: (code, reason) => log.fatal.push([code, reason]),
    backoff: () => 20,
    ...over,
  });
  return log;
}

describe("Connection over WebSocket", () => {
  it("authenticates, hello → welcome → snapshot → queued messages, in that order", async () => {
    relay = await new FakeRelay().start();
    const log = mk();
    conn!.send("agent.event", { seq: 1 }); // queued before connecting
    conn!.send("prompt.open", { promptId: "P1" });
    conn!.start();
    await waitUntil(() => relay.of("agent.event").length === 1);
    expect(relay.conns[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(relay.conns[0]!.path).toBe("/ws/agent");
    expect(relay.all.map((e) => e.t)).toEqual(["agent.hello", "agent.snapshot", "agent.event", "prompt.open"]);
    expect(log.welcomes).toBe(1);
    expect(conn!.connected).toBe(true);
    expect(relay.all[0]!.id).toBeTruthy(); // hello carries an id
  });
  it("routes non-welcome relay messages to onMessage", async () => {
    relay = await new FakeRelay().start();
    const log = mk();
    conn!.start();
    await waitUntil(() => conn!.connected);
    relay.push("user.message", { clientMsgId: "c" });
    await waitUntil(() => log.messages.length === 1);
    expect(log.messages[0].t).toBe("user.message");
  });
  it("1012 (service restart) reconnects immediately and re-sends hello (with fresh openPrompts)", async () => {
    relay = await new FakeRelay().start();
    const log = mk({ backoff: () => 60_000 });
    conn!.start();
    await waitUntil(() => conn!.connected);
    relay.closeAll(1012);
    await waitUntil(() => relay.of("agent.hello").length === 2, 3000, "second hello");
    expect(log.hellos).toBe(2);
  });
  it("reconnects after an abnormal close and after the relay process dies and comes back", async () => {
    relay = await new FakeRelay().start();
    const port = relay.port;
    mk({ wsFailuresBeforeLongPoll: 10 });
    conn!.start();
    await waitUntil(() => conn!.connected);
    relay.closeAll(1011);
    await waitUntil(() => relay.of("agent.hello").length === 2);
    conn!.send("agent.event", { seq: 1, note: "sent while relay is down" });
    await relay.stop();
    await waitUntil(() => !conn!.connected);
    conn!.send("agent.event", { seq: 2, note: "queued while down" });
    relay = await new FakeRelay().start(port);
    await waitUntil(() => relay.of("agent.hello").length === 1 && conn!.connected, 10_000, "reconnect to the new relay");
    await waitUntil(() => relay.of("agent.event").length >= 1);
    expect(relay.of("agent.event").some((e) => e.d.seq === 2)).toBe(true);
  }, 15_000);
  it("messages sent while disconnected are queued and delivered after reconnect; prompt.* are never dropped on overflow", async () => {
    relay = await new FakeRelay().start();
    mk({ maxQueueMessages: 5, maxQueueBytes: 10_000 });
    conn!.send("prompt.open", { promptId: "keep-1" });
    for (let i = 0; i < 20; i++) conn!.send("agent.event", { seq: i });
    conn!.send("prompt.resolved", { promptId: "keep-1" });
    expect(conn!.needsSnapshot).toBe(true);
    expect(conn!.queued).toBeLessThanOrEqual(7);
    conn!.start();
    await waitUntil(() => relay.of("prompt.resolved").length === 1);
    expect(relay.of("prompt.open")).toHaveLength(1);
    expect(relay.of("agent.event").length).toBeLessThan(20);
  });
  it("byte cap drops old events first (2 MB default)", async () => {
    relay = await new FakeRelay().start();
    mk({ maxQueueBytes: 5000 });
    conn!.send("user.message.ack", { clientMsgId: "a" });
    for (let i = 0; i < 50; i++) conn!.send("agent.event", { pad: "x".repeat(500), i });
    expect(conn!.needsSnapshot).toBe(true);
    conn!.start();
    await waitUntil(() => relay.of("user.message.ack").length === 1);
    expect(relay.of("agent.event").length).toBeLessThan(50);
  });
  for (const code of [4001, 4002, 4003]) {
    it(`close ${code} is fatal: no reconnect, onFatal called`, async () => {
      relay = await new FakeRelay().start();
      const log = mk();
      conn!.start();
      await waitUntil(() => conn!.connected);
      relay.closeAll(code, "nope");
      await waitUntil(() => log.fatal.length === 1);
      await new Promise((r) => setTimeout(r, 150));
      expect(relay.of("agent.hello")).toHaveLength(1);
      expect(log.fatal[0][0]).toBe(code);
      expect(conn!.state).toBe("stopped");
    });
  }
  it("HTTP 401 on upgrade is fatal (invalid token)", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 401;
    const log = mk();
    conn!.start();
    await waitUntil(() => log.fatal.length === 1);
    expect(log.fatal[0][0]).toBe(4001);
  });
  it("stop() closes the socket and prevents reconnects", async () => {
    relay = await new FakeRelay().start();
    mk();
    conn!.start();
    await waitUntil(() => conn!.connected);
    conn!.stop();
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.of("agent.hello")).toHaveLength(1);
  });
});

describe("Connection fallback to HTTP long-poll", () => {
  it("3 consecutive failed WS upgrades → long-poll with the same messages; welcome/snapshot/events/inbound all work", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    const log = mk({ wsRetryMs: 60_000 });
    conn!.start();
    await waitUntil(() => conn!.transportName === "longpoll" && conn!.connected, 8000, "longpoll connected");
    expect(log.states.some((s) => s.endsWith("/longpoll"))).toBe(true);
    conn!.send("agent.event", { epoch: "E", seq: 1, e: { type: "agent_start" } });
    await waitUntil(() => relay.of("agent.event").length === 1);
    expect(relay.all.map((e) => e.t).slice(0, 3)).toEqual(["agent.hello", "agent.snapshot", "agent.event"]);
    const sendReq = relay.httpLog.find((h) => h.url.startsWith("/v1/agent/send"))!;
    expect(sendReq.headers.authorization).toBe("Bearer secret-token");
    expect(sendReq.headers["x-rp-agent-id"]).toBe("M:S");
    relay.push("user.message", { clientMsgId: "lp1", text: "hi" });
    await waitUntil(() => log.messages.some((m) => m.t === "user.message"));
  });
  it("fewer than 3 failures keep using WebSocket", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    mk({ wsFailuresBeforeLongPoll: 3 });
    conn!.start();
    await waitUntil(() => relay.rejectUpgrade && conn!["wsFailures"] >= 1);
    relay.rejectUpgrade = null;
    await waitUntil(() => conn!.connected);
    expect(conn!.transportName).toBe("ws");
  });
  it("retries WebSocket periodically while on long-poll and switches back when it works", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    mk({ wsRetryMs: 300 });
    conn!.start();
    await waitUntil(() => conn!.transportName === "longpoll" && conn!.connected, 8000);
    relay.rejectUpgrade = null; // proxy now lets WS through
    await waitUntil(() => conn!.transportName === "ws" && conn!.connected, 8000, "back on ws");
  });
  it("a failed WS probe returns to long-poll without waiting for 3 new failures", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    mk({ wsRetryMs: 300 });
    conn!.start();
    await waitUntil(() => conn!.transportName === "longpoll" && conn!.connected, 8000);
    const helloCount = relay.of("agent.hello").length;
    await waitUntil(() => relay.of("agent.hello").length > helloCount, 8000, "re-hello via longpoll after failed probe");
    expect(conn!.transportName).toBe("longpoll");
  });
  it("long-poll 401 is fatal", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    relay.httpResponses.set("/v1/agent/send", () => ({ status: 401, body: { error: "unauthorized" } }));
    relay.httpResponses.set("/v1/agent/poll", () => ({ status: 401, body: { error: "unauthorized" } }));
    const log = mk();
    conn!.start();
    await waitUntil(() => log.fatal.length === 1, 8000);
    expect(log.fatal[0][0]).toBe(4001);
  });
  it("preserves FIFO order of unsent critical messages when transport closes mid-send", async () => {
    relay = await new FakeRelay().start();
    let failFirstSend = true;
    relay.httpResponses.set("/v1/agent/send", (_req, body) => {
      const arr = Array.isArray(body) ? body : [];
      if (failFirstSend && arr.some((e: any) => e.t === "prompt.open")) {
        failFirstSend = false;
        relay.pollWaiters.length = 0;
        return { status: 502, body: { error: "bad_gateway" } };
      }
      for (const env of arr) {
        relay.all.push(env);
        if (env.t === "agent.hello" && relay.autoWelcome) relay.pollQueue.push({ v: 1, id: "w", t: "agent.welcome", ts: Date.now(), re: env.id, d: relay.welcomeBody });
      }
      (relay as any).flushPoll();
      return { status: 200, body: {} };
    });
    relay.rejectUpgrade = 503;
    mk({ wsFailuresBeforeLongPoll: 1, wsRetryMs: 60_000 });
    conn!.start();
    await waitUntil(() => conn!.transportName === "longpoll" && conn!.connected, 8000);
    conn!.send("prompt.open", { promptId: "P1" });
    conn!.send("prompt.resolved", { promptId: "P1", by: "local", answer: null });
    await waitUntil(() => relay.of("prompt.resolved").length === 1, 8000);
    const critical = relay.all.filter((e) => e.t === "prompt.open" || e.t === "prompt.resolved").map((e) => e.t);
    expect(critical).toEqual(["prompt.open", "prompt.resolved"]);
  });
});
