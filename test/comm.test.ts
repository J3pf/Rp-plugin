import { describe, expect, it } from "vitest";
import { BoundedMap, BoundedSet, CommTracker } from "../src/extension/comm.ts";
import type { CommEvent } from "../src/shared/protocol.ts";
import { validateEnvelope } from "./contract.ts";

describe("bounded collections", () => {
  it("evicts the least-recently-used entry after exceeding capacity", () => {
    const map = new BoundedMap<number, number>();
    for (let i = 0; i <= 500; i++) map.set(i, i);
    expect(map.size).toBe(500);
    expect(map.has(0)).toBe(false);
    expect(map.get(500)).toBe(500);

    // Accessing and updating existing keys refreshes their LRU position.
    map.get(1);
    map.set(2, 2);
    map.set(501, 501);
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(true);
    expect(map.has(3)).toBe(false);

    const set = new BoundedSet<number>();
    for (let i = 0; i <= 500; i++) set.add(i);
    expect(set.size).toBe(500);
    expect(set.has(0)).toBe(false);
    expect(set.has(500)).toBe(true);

    // has() and add() of an existing value refresh its LRU position.
    set.has(1);
    set.add(2);
    set.add(501);
    expect(set.has(1)).toBe(true);
    expect(set.has(2)).toBe(true);
    expect(set.has(3)).toBe(false);
  });
});

describe("CommTracker outgoing events", () => {
  function tracker(redacted = false) {
    const events: CommEvent[] = [];
    let at = 100;
    const comm = new CommTracker({ emit: (event) => events.push(event), isRedacted: () => redacted, now: () => at++ });
    return { comm, events };
  }

  it.each(["send", "ask", "handover"] as const)("correlates intercom %s start and end", (action) => {
    const { comm, events } = tracker();
    comm.onToolStart("intercom", { action, to: "peer-ref", message: "hello", replyTo: "incoming-1" }, "call-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "comm",
      direction: "out",
      channel: "intercom",
      action,
      peer: { sessionId: null, name: null, cwd: null, ref: "peer-ref" },
      messageId: null,
      replyTo: "incoming-1",
      expectsReply: action === "ask",
      text: "hello",
      truncated: false,
      delivered: null,
      at: 100,
    });
    const commId = events[0]!.commId;

    comm.onToolEnd("intercom", { details: { delivered: true, messageId: "sent-1" } }, false, "call-1");

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ ...events[0], commId, messageId: "sent-1", delivered: true });
    expect(events[1]!.at).toBe(events[0]!.at);
    expect(events[1]!.at).toBe(100);
  });

  it("ignores unsupported intercom actions and replies without a message", () => {
    const { comm, events } = tracker();
    for (const action of ["list", "list-cwd", "status", "pending", "cancel"]) {
      comm.onToolStart("intercom", { action, message: "ignored" }, `call-${action}`);
    }
    comm.onToolStart("intercom", { action: "reply" }, "call-reply");
    expect(events).toEqual([]);
  });

  it("tracks orchestrator_send_message recipient and correlates completion", () => {
    const { comm, events } = tracker();
    comm.onToolStart("orchestrator_send_message", { recipient_session_id: "session-2", message: "hello" }, "call-2");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "comm",
      direction: "out",
      channel: "orchestrator",
      action: "message",
      peer: { sessionId: "session-2", name: null, cwd: null, ref: "session-2" },
      expectsReply: false,
      replyTo: null,
      text: "hello",
      truncated: false,
      delivered: null,
    });
    comm.onToolEnd("orchestrator_send_message", { details: { messageId: "sent-2" } }, false, "call-2");
    expect(events[1]).toMatchObject({ commId: events[0]!.commId, messageId: "sent-2", delivered: true });
  });

  it("fills a reply peer from the tracked inbound message", () => {
    const { comm, events } = tracker();
    comm.recordInbound({ id: "peer-session", name: "Peer", cwd: "/peer" }, { id: "incoming-1", expectsReply: true });
    comm.onToolStart("intercom", { action: "reply", replyTo: "incoming-1", message: "answer" }, "call-reply");

    expect(events).toEqual([
      expect.objectContaining({
        type: "comm",
        action: "reply",
        replyTo: "incoming-1",
        peer: { sessionId: "peer-session", name: "Peer", cwd: "/peer", ref: null },
      }),
    ]);
  });

  it("resolves replies only from the matching inbound message or explicit peer ref", () => {
    const { comm, events } = tracker();
    comm.recordInbound({ id: "peer-a", name: "Agent A", cwd: "/a" }, { id: "msg-1" });
    comm.recordInbound({ id: "peer-b", name: "Agent B", cwd: "/b" }, { id: "msg-2" });

    comm.onToolStart("intercom", { action: "reply", replyTo: "msg-1", message: "answer A" }, "reply-a");
    expect(events[0]!.peer.sessionId).toBe("peer-a");
    expect(events[0]!.peer.name).toBe("Agent A");
    expect(events[0]!.peer.cwd).toBe("/a");

    comm.onToolStart("intercom", { action: "reply", replyTo: "msg-unknown", message: "unknown reply" }, "reply-unknown");
    expect(events[1]!.peer.sessionId).toBeNull();
    expect(events[1]!.peer.name).toBeNull();
    expect(events[1]!.peer.cwd).toBeNull();
    expect(events[1]!.replyTo).toBe("msg-unknown");
  });

  it("clears active calls after an aborted agent settles", () => {
    const { comm, events } = tracker();
    comm.onToolStart("intercom", { action: "send", message: "hello" }, "aborted-call");
    comm.onAgentSettled(true);
    comm.onToolEnd("intercom", { details: { delivered: true, messageId: "late-message" } }, false, "aborted-call");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "out", messageId: null, delivered: null });
  });

  it("reset clears active calls, inbound messages, known peers, and deduplication state", () => {
    const { comm, events } = tracker();
    const previouslySeen = {
      customType: "intercom_message",
      details: { from: { id: "peer-session", name: "Peer", cwd: "/peer" }, message: { id: "seen-message" }, bodyText: "hello" },
    };
    comm.onToolStart("intercom", { action: "send", message: "pending" }, "pending-call");
    comm.recordInbound({ id: "peer-session", name: "Peer", cwd: "/peer" }, { id: "inbound-message" });
    comm.onMessage(previouslySeen);
    expect(events).toHaveLength(2);

    comm.reset();
    comm.onToolEnd("intercom", { details: { delivered: true, messageId: "late-message" } }, false, "pending-call");
    comm.onToolStart("intercom", { action: "reply", replyTo: "inbound-message", message: "answer" }, "reply-1");
    comm.onToolStart("intercom", { action: "reply", to: "Peer", replyTo: "unknown-message", message: "answer" }, "reply-2");

    expect(events).toHaveLength(4);
    expect(events[2]!.peer).toEqual({ sessionId: null, name: null, cwd: null, ref: null });
    expect(events[3]!.peer).toEqual({ sessionId: null, name: null, cwd: null, ref: "Peer" });

    comm.onMessage(previouslySeen);
    expect(events).toHaveLength(5);
    expect(events[4]).toMatchObject({ direction: "in", messageId: "seen-message" });
  });

  it("preserves active calls when an agent settles without aborting", () => {
    const { comm, events } = tracker();
    comm.onToolStart("intercom", { action: "send", message: "hello" }, "call-1");
    comm.onAgentSettled(false);
    comm.onToolEnd("intercom", { details: { messageId: "sent-1" } }, false, "call-1");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ messageId: "sent-1", delivered: true });
  });

  it("uses details.delivered when boolean and otherwise derives delivery from error", () => {
    const { comm, events } = tracker();
    comm.onToolStart("intercom", { action: "send", message: "a" }, "call-1");
    comm.onToolEnd("intercom", { details: { delivered: false } }, false, "call-1");
    comm.onToolStart("intercom", { action: "send", message: "b" }, "call-2");
    comm.onToolEnd("intercom", { details: { error: "failed" } }, false, "call-2");
    comm.onToolStart("intercom", { action: "send", message: "c" }, "call-3");
    comm.onToolEnd("intercom", { details: {} }, false, "call-3");
    comm.onToolStart("intercom", { action: "send", message: "d" }, "call-4");
    comm.onToolEnd("intercom", { details: {} }, true, "call-4");

    expect(events.map((event) => event.delivered)).toEqual([null, false, null, false, null, true, null, false]);
  });

  it("redacts content and truncates unredacted text to 2000 characters", () => {
    const redacted = tracker(true);
    redacted.comm.onToolStart("intercom", { action: "send", message: "secret" }, "redacted");
    expect(redacted.events[0]).toMatchObject({ text: null, truncated: false });

    const plain = tracker();
    const message = "x".repeat(2001);
    plain.comm.onToolStart("intercom", { action: "send", message }, "long");
    expect(plain.events[0]).toMatchObject({ text: "x".repeat(2000), truncated: true });
  });

  it("emits incoming intercom messages with sender and reply metadata", () => {
    const { comm, events } = tracker();
    comm.onMessage({
      customType: "intercom_message",
      details: {
        from: { id: "peer-session", name: "Peer", cwd: "/peer" },
        message: { id: "incoming-1", expectsReply: true, replyTo: "outgoing-1" },
        bodyText: "hello from peer",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "comm",
        direction: "in",
        channel: "intercom",
        action: "ask",
        peer: { sessionId: "peer-session", name: "Peer", cwd: "/peer", ref: null },
        messageId: "incoming-1",
        expectsReply: true,
        replyTo: "outgoing-1",
        text: "hello from peer",
        truncated: false,
      }),
    ]);
    expect("delivered" in events[0]!).toBe(false);
  });

  it("deduplicates the same incoming intercom message", () => {
    const { comm, events } = tracker();
    const message = {
      customType: "intercom_message",
      details: { from: { id: "peer-session" }, message: { id: "incoming-1" }, bodyText: "hello" },
    };

    comm.onMessage(message);
    comm.onMessage(message);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "in", messageId: "incoming-1" });
  });

  it("seeds existing branch messages without emitting them again", () => {
    const { comm, events } = tracker();
    const message = {
      customType: "intercom_message",
      details: {
        from: { id: "peer-session", name: "Peer", cwd: "/peer" },
        message: { id: "incoming-1", expectsReply: true },
        bodyText: "already in branch",
      },
    };

    comm.seedSeen([{ type: "message", message }]);
    comm.onMessage(message);

    expect(events).toEqual([]);
    comm.onToolStart("intercom", { action: "reply", replyTo: "incoming-1", message: "answer" }, "reply-1");
    expect(events[0]).toMatchObject({ peer: { sessionId: "peer-session", name: "Peer", cwd: "/peer" } });
  });

  it("correlates replies when inbound message ID is provided on details.id instead of details.message.id", () => {
    const { comm, events } = tracker();
    comm.onMessage({
      customType: "intercom_message",
      details: {
        id: "details-only-id",
        from: { id: "peer-top", name: "TopPeer", cwd: "/top" },
        message: { expectsReply: true },
        bodyText: "question",
      },
    });
    comm.onToolStart("intercom", { action: "reply", replyTo: "details-only-id", message: "answer" }, "reply-top");
    expect(events[1]).toMatchObject({
      action: "reply",
      replyTo: "details-only-id",
      peer: { sessionId: "peer-top", name: "TopPeer", cwd: "/top", ref: null },
    });
  });

  it("redacts incoming intercom message content", () => {
    const { comm, events } = tracker(true);
    comm.onMessage({ customType: "intercom_message", details: { message: { id: "incoming-1" }, bodyText: "secret" } });
    expect(events[0]).toMatchObject({ direction: "in", text: null, truncated: false });
  });

  it("truncates incoming intercom message content to 2000 characters", () => {
    const { comm, events } = tracker();
    const bodyText = "x".repeat(2001);
    comm.onMessage({ customType: "intercom_message", details: { message: { id: "incoming-1" }, bodyText } });
    expect(events[0]).toMatchObject({ direction: "in", text: "x".repeat(2000), truncated: true });
  });

  it("ignores messages that are not intercom custom messages or lack an id", () => {
    const { comm, events } = tracker();
    comm.onMessage({ customType: "other", details: { message: { id: "other-1" } } });
    comm.onMessage({ customType: "intercom_message", details: { message: { expectsReply: true } } });
    expect(events).toEqual([]);
  });

  it("produces zero comm events when intercom is absent or unrelated tools run", () => {
    const { comm, events } = tracker();
    comm.onToolStart("bash", { command: "ls" }, "call-bash");
    comm.onToolEnd("bash", { result: "ok" }, false, "call-bash");
    comm.onToolStart("read", { path: "src/index.ts" }, "call-read");
    comm.onToolEnd("read", { content: "text" }, false, "call-read");
    comm.onToolStart("subagent_run", { agent: "worker" }, "call-subagent");
    comm.onToolEnd("subagent_run", { result: "done" }, false, "call-subagent");
    expect(events).toEqual([]);
  });

  it("never throws for malformed or throwing incoming message objects", () => {
    const { comm, events } = tracker();
    expect(() => comm.onMessage(null)).not.toThrow();
    expect(() => comm.onMessage({ customType: "intercom_message", details: null })).not.toThrow();
    expect(() => comm.seedSeen([{ message: null }, null])).not.toThrow();

    const throwingMessage = Object.defineProperty({}, "customType", { get: () => { throw new Error("bad input"); } });
    expect(() => comm.onMessage(throwingMessage)).not.toThrow();
    expect(() => comm.seedSeen([throwingMessage])).not.toThrow();
    expect(events).toEqual([]);
  });

  it("emits CommTracker events that validate against the frozen envelope contract", () => {
    const { comm, events } = tracker();
    const envelope = (event: CommEvent, seq: number) => ({
      v: 1,
      t: "agent.event",
      ts: event.at,
      d: { epoch: "test-epoch", seq, e: event },
    });

    comm.onToolStart("intercom", { action: "ask", to: "peer-ref", message: "question" }, "ask-1");
    const start = events[0]!;
    comm.onToolEnd("intercom", { details: { delivered: true, messageId: "ask-message" } }, false, "ask-1");
    const end = events[1]!;

    expect(validateEnvelope(envelope(start, 1))).toEqual([]);
    expect(validateEnvelope(envelope(end, 2))).toEqual([]);
    expect(start).toMatchObject({ delivered: null, messageId: null });
    expect(end).toMatchObject({ delivered: true, messageId: "ask-message" });
    expect(end.commId).toBe(start.commId);
    expect(end.at).toBe(start.at);
    expect(end.peer).toEqual(start.peer);
    expect(end.text).toBe(start.text);
    expect(end.channel).toBe(start.channel);
    expect(end.action).toBe(start.action);

    for (const action of ["send", "ask", "reply", "handover"] as const) {
      comm.onToolStart("intercom", { action, to: "peer-ref", message: "message" }, `call-${action}`);
    }
    comm.onToolStart("orchestrator_send_message", { recipient_session_id: "session-2", message: "delegated" }, "orch-1");
    comm.onMessage({
      customType: "intercom_message",
      details: {
        from: { id: "peer-session", name: "Peer", cwd: "/peer" },
        message: { id: "incoming-1", expectsReply: true },
        bodyText: "inbound",
      },
    });

    for (const [index, event] of events.entries()) {
      expect(validateEnvelope(envelope(event, index + 1))).toEqual([]);
      if (event.channel === "intercom") {
        expect(["send", "ask", "reply", "handover"]).toContain(event.action);
      } else {
        expect(event.channel).toBe("orchestrator");
        expect(event.action).toBe("message");
      }
    }
    const inbound = events.at(-1)!;
    expect(inbound.direction).toBe("in");
    expect("delivered" in inbound).toBe(false);

    const redacted = tracker(true);
    redacted.comm.onMessage({
      customType: "intercom_message",
      details: { message: { id: "redacted-1" }, bodyText: "secret" },
    });
    expect(validateEnvelope(envelope(redacted.events[0]!, 1))).toEqual([]);
    expect(redacted.events[0]).toMatchObject({ text: null, truncated: false });
  });
});
