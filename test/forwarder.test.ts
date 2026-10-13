import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Forwarder, LIMITS, normalizeMessage, normalizeToolResult } from "../src/extension/forwarder.ts";
import { buildSnapshotEntries, toSnapshotEntry, SNAPSHOT_LIMIT } from "../src/extension/snapshot.ts";
import { StatusTracker } from "../src/extension/status.ts";

describe("Forwarder", () => {
  let sent: any[];
  let fw: Forwarder;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    fw = new Forwarder({ send: (e) => sent.push(e), redact: false });
  });
  afterEach(() => vi.useRealTimers());

  const delta = (idx: number, kind: string, d: string) => ({ type: "message_update", message: {}, assistantMessageEvent: { type: `${kind}_delta`, contentIndex: idx, delta: d, partial: {} } });

  it("coalesces message_update deltas every 100 ms", () => {
    for (const ch of ["He", "llo", " wor", "ld"]) fw.handle("message_update", delta(0, "text", ch));
    fw.handle("message_update", delta(1, "thinking", "hmm"));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([
      { type: "message_delta", contentIndex: 0, kind: "text", delta: "Hello world" },
      { type: "message_delta", contentIndex: 1, kind: "thinking", delta: "hmm" },
    ]);
  });
  it("ignores non-delta assistant events", () => {
    fw.handle("message_update", { assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(0);
  });
  it("flushes pending deltas before message_end and keeps order", () => {
    fw.handle("message_update", delta(0, "text", "abc"));
    fw.handle("message_end", { message: { role: "assistant", content: [{ type: "text", text: "abc" }] } });
    expect(sent.map((e) => e.type)).toEqual(["message_delta", "message_end"]);
  });
  it("tool_execution_update: at most one per 500 ms, latest value wins, truncated to 8 KiB", () => {
    const upd = (t: string) => ({ toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: t }] } });
    fw.handle("tool_execution_update", upd("1"));
    expect(sent).toHaveLength(1);
    fw.handle("tool_execution_update", upd("2"));
    fw.handle("tool_execution_update", upd("3"));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(2);
    expect(sent[1].partialResult.content[0].text).toBe("3");
    fw.handle("tool_execution_update", upd("x".repeat(20000)));
    vi.advanceTimersByTime(500);
    const big = sent[sent.length - 1];
    expect(Buffer.byteLength(big.partialResult.content[0].text)).toBeLessThanOrEqual(LIMITS.updateMaxBytes);
    expect(big.truncated).toBe(true);
  });
  it("tool_execution_end truncates text to 32 KiB with truncated:true and cancels pending updates", () => {
    fw.handle("tool_execution_update", { toolCallId: "c", toolName: "t", partialResult: "a" });
    fw.handle("tool_execution_update", { toolCallId: "c", toolName: "t", partialResult: "b" });
    fw.handle("tool_execution_end", { toolCallId: "c", toolName: "t", isError: false, result: { content: [{ type: "text", text: "y".repeat(100_000) }] } });
    vi.advanceTimersByTime(1000);
    const end = sent.find((e) => e.type === "tool_execution_end");
    expect(end.truncated).toBe(true);
    expect(end.result.truncated).toBe(true);
    expect(Buffer.byteLength(end.result.content[0].text)).toBeLessThanOrEqual(LIMITS.resultMaxBytes);
    expect(sent.filter((e) => e.type === "tool_execution_update")).toHaveLength(1);
  });
  it("images become image_ref", () => {
    const m = normalizeMessage({ role: "user", content: [{ type: "text", text: "x" }, { type: "image", data: "AAAA".repeat(100), mimeType: "image/png" }] });
    expect(m.content[1]).toEqual({ type: "image_ref", mimeType: "image/png", bytes: 300 });
    const r = normalizeToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] }, 100);
    expect(r.result.content[0].type).toBe("image_ref");
  });
  it("forwards parentToolCallId on nested calls", () => {
    fw.handle("tool_execution_start", { toolCallId: "a/1", toolName: "read", args: { path: "x" }, parentToolCallId: "a" });
    fw.handle("tool_execution_end", { toolCallId: "a/1", toolName: "read", isError: false, result: "ok", parentToolCallId: "a" });
    expect(sent[0].parentToolCallId).toBe("a");
    expect(sent[1].parentToolCallId).toBe("a");
  });
  it("turn_end drops message/toolResults; model_select/compact are slimmed", () => {
    fw.handle("turn_end", { turnIndex: 2, message: { huge: true }, toolResults: [1] });
    fw.handle("model_select", { model: { provider: "p", id: "m", secret: 1 }, previousModel: undefined, source: "set" });
    fw.handle("session_compact", { reason: "manual", compactionEntry: { summary: "sum", extra: 1 } });
    fw.handle("session_info_changed", { name: undefined });
    expect(sent[0]).toEqual({ type: "turn_end", turnIndex: 2 });
    expect(sent[1].model).toEqual({ provider: "p", id: "m" });
    expect(sent[2]).toEqual({ type: "session_compact", reason: "manual", summary: "sum" });
    expect(sent[3]).toEqual({ type: "session_info_changed", name: null });
  });
  it("callbacks for status derivation", () => {
    const calls: string[] = [];
    const f = new Forwarder({ send: () => {}, redact: false, onAgentStart: () => calls.push("start"), onAgentSettled: () => calls.push("settled"), onToolStart: (n) => calls.push("tool:" + n) });
    f.handle("agent_start", {});
    f.handle("tool_execution_start", { toolName: "bash", args: {} });
    f.handle("agent_settled", { aborted: true });
    expect(calls).toEqual(["start", "tool:bash", "settled"]);
  });
  it("redactContent: only state, tool names and ids", () => {
    const r: any[] = [];
    const f = new Forwarder({ send: (e) => r.push(e), redact: true });
    f.handle("message_start", { message: { role: "user", content: "secret" } });
    f.handle("message_update", delta(0, "text", "secret"));
    f.handle("message_end", { message: { role: "assistant", content: "secret" } });
    f.handle("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "cat secret" } });
    f.handle("tool_execution_update", { toolCallId: "1", toolName: "bash", partialResult: "secret" });
    f.handle("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: false, result: "secret" });
    f.handle("session_compact", { reason: "manual", compactionEntry: { summary: "secret" } });
    vi.advanceTimersByTime(1000);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_end", "session_compact"]);
  });
  it("dispose stops everything", () => {
    fw.handle("message_update", delta(0, "text", "x"));
    fw.dispose();
    vi.advanceTimersByTime(1000);
    fw.handle("agent_start", {});
    expect(sent.map((e) => e.type)).toEqual(["message_delta"]); // flushed on dispose, nothing after
  });
});

describe("snapshot", () => {
  const msg = (id: string, role: string, content: any = "x") => ({ type: "message", id, timestamp: "2026-10-13T00:00:00Z", message: { role, content } });
  it("maps roles and entry types", () => {
    expect(toSnapshotEntry(msg("1", "user"), false)?.kind).toBe("user");
    expect(toSnapshotEntry(msg("2", "assistant"), false)?.kind).toBe("assistant");
    expect(toSnapshotEntry(msg("3", "toolResult"), false)?.kind).toBe("tool_result");
    expect(toSnapshotEntry(msg("4", "bashExecution"), false)?.kind).toBe("bash");
    expect(toSnapshotEntry(msg("5", "custom"), false)?.kind).toBe("custom");
    expect(toSnapshotEntry({ type: "compaction", id: "6", summary: "s" }, false)?.kind).toBe("compaction");
    expect(toSnapshotEntry({ type: "branch_summary", id: "7", summary: "s" }, false)?.kind).toBe("branch_summary");
    expect(toSnapshotEntry({ type: "model_change", id: "8", provider: "p", modelId: "m" }, false)?.msg).toEqual({ provider: "p", modelId: "m" });
    expect(toSnapshotEntry({ type: "label", id: "9" }, false)).toBeNull();
    expect(toSnapshotEntry(null, false)).toBeNull();
    expect(toSnapshotEntry(msg("a", "user"), false)?.at).toBe(Date.parse("2026-10-13T00:00:00Z"));
  });
  it("keeps the last 200 and flags truncation", () => {
    const branch = Array.from({ length: 250 }, (_, i) => msg(String(i), "user"));
    const { entries, truncated } = buildSnapshotEntries(branch, false);
    expect(entries).toHaveLength(SNAPSHOT_LIMIT);
    expect(truncated).toBe(true);
    expect(entries[0]!.eid).toBe("50");
    expect(buildSnapshotEntries(branch.slice(0, 5), false).truncated).toBe(false);
  });
  it("redacts content", () => {
    const { entries } = buildSnapshotEntries([msg("1", "user", "top secret"), { type: "compaction", id: "2", summary: "top secret" }], true);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });
});

describe("StatusTracker", () => {
  it("derives status with waiting_input priority and emits only changes", () => {
    const st: any[] = [];
    const t = new StatusTracker((s, d) => st.push([s, d]), () => {});
    t.working();
    t.working("bash: ls");
    t.working("bash: ls");
    t.setWaiting(1);
    t.setWaiting(2);
    t.setWaiting(0);
    t.setCompacting(true);
    t.setCompacting(false);
    t.idle();
    expect(st).toEqual([["working", undefined], ["working", "bash: ls"], ["waiting_input", undefined], ["working", "bash: ls"], ["compacting", undefined], ["working", "bash: ls"], ["idle", undefined]]);
  });
  it("coalesces setStatus observations to ≤1/s and derives gentle mode", () => {
    vi.useFakeTimers();
    const out: any[] = [];
    const modes: string[] = [];
    const t = new StatusTracker(() => {}, (i) => out.push(i), (m) => modes.push(m));
    t.observe("a", "1");
    t.observe("gentle:mode", "Permissions: AUTO");
    t.observe("a", "2");
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(out).toEqual([{ a: "2", "gentle:mode": "Permissions: AUTO" }]);
    expect(modes).toEqual(["auto"]);
    t.observe("a", "2"); // unchanged → nothing
    vi.advanceTimersByTime(2000);
    expect(out).toHaveLength(1);
    t.observe("a", undefined);
    vi.advanceTimersByTime(1000);
    expect(out[1]).toEqual({ "gentle:mode": "Permissions: AUTO" });
    expect(t.sawGentleStatus).toBe(true);
    t.dispose();
    vi.useRealTimers();
  });
});
