import { describe, expect, it } from "vitest";
import { CommTracker } from "../src/extension/comm.ts";
import type { CommEvent } from "../src/shared/protocol.ts";

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
    expect(events[1]).toEqual({ ...events[0], commId, messageId: "sent-1", delivered: true, at: 101 });
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
});
