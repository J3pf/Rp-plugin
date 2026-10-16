import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rpExtension from "../src/extension/index.ts";
import { toolDetail } from "../src/extension/runtime.ts";
import * as configModule from "../src/extension/config.ts";
import { FakeRelay, baseConfig, makeCtx, makePi, makeUi, waitUntil } from "./helpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let relay: FakeRelay;
let cfgFile: string;
const envBackup = { ...process.env };

beforeEach(async () => {
  relay = await new FakeRelay().start();
  cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rprt-")), "config.json");
  process.env.RP_CONFIG = cfgFile;
  delete process.env.RP_DISABLED;
  delete process.env.RP_RELAY_URL;
  delete process.env.GENTLE_PI_AGENTS_CHILD;
  delete process.env.RP_SPAWN_ID;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("HERDR_") || k === "TMUX" || k === "GENTLE_SHELL") delete process.env[k];
  }
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
  Object.assign(process.env, envBackup);
  await relay.stop();
  vi.restoreAllMocks();
});

function writeCfg(over: Record<string, any> = {}) {
  fs.writeFileSync(cfgFile, JSON.stringify(baseConfig(relay.url, over)));
}

async function boot(opts: { cfg?: Record<string, any>; tools?: any[]; ctx?: any; reason?: string } = {}) {
  writeCfg(opts.cfg);
  const fake = makePi(opts.tools ?? [{ name: "bash", sourceInfo: { path: "builtin:bash" } }]);
  rpExtension(fake.pi);
  const ctx = opts.ctx ?? makeCtx();
  await fake.fire("session_start", { type: "session_start", reason: opts.reason ?? "startup" }, ctx);
  return { ...fake, ctx };
}

const lastHello = () => relay.of("agent.hello").at(-1)!.d;

describe("extension factory", () => {
  it("registers flags, the /rp command and handlers; does no I/O or sockets in the factory", () => {
    writeCfg();
    const f = makePi();
    rpExtension(f.pi);
    expect([...f.flags.keys()].sort()).toEqual(["rp-off", "rp-spawn-id"]);
    expect(f.commands.has("rp")).toBe(true);
    for (const ev of ["session_start", "session_shutdown", "tool_call", "tool_execution_start", "tool_execution_end", "ui_prompt_start", "ui_prompt_end", "input", "message_end", "agent_settled"]) {
      expect(f.handlers.has(ev), ev).toBe(true);
    }
    expect(relay.conns).toHaveLength(0);
  });
  it("is inert inside gentle-pi subagents (GENTLE_PI_AGENTS_CHILD=1) but still registers its flags", async () => {
    process.env.GENTLE_PI_AGENTS_CHILD = "1";
    writeCfg();
    const f = makePi();
    rpExtension(f.pi);
    expect(f.commands.size).toBe(0);
    expect(f.handlers.size).toBe(0);
    expect(f.flags.has("rp-off")).toBe(true);
    // unless explicitly allowed
    writeCfg({ subagents: "connect" });
    const g = makePi();
    rpExtension(g.pi);
    expect(g.handlers.has("session_start")).toBe(true);
  });
  it("does not connect when unpaired, disabled, or --rp-off", async () => {
    for (const over of [{ machineToken: null }, { enabled: false }]) {
      writeCfg(over);
      const f = makePi();
      rpExtension(f.pi);
      await f.fire("session_start", { reason: "startup" }, makeCtx());
    }
    writeCfg();
    const f = makePi();
    f.flagValues.set("rp-off", true);
    rpExtension(f.pi);
    await f.fire("session_start", { reason: "startup" }, makeCtx());
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.conns).toHaveLength(0);
  });
  it("RP_DISABLED=1 and RP_RELAY_URL overrides apply", async () => {
    process.env.RP_DISABLED = "1";
    writeCfg();
    const f = makePi();
    rpExtension(f.pi);
    await f.fire("session_start", { reason: "startup" }, makeCtx());
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.conns).toHaveLength(0);
  });
});

describe("agent.hello / snapshot / events", () => {
  it("sends a complete hello, then the snapshot, then streams events with epoch+seq", async () => {
    const branch = [{ type: "message", id: "e1", timestamp: 1, message: { role: "user", content: "hi" } }, { type: "message", id: "e2", timestamp: 2, message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }];
    const t = await boot({ ctx: makeCtx({ branch, sessionId: "pisess" }) });
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    const h = lastHello();
    expect(h).toMatchObject({
      agentId: "MACHINE1:pisess",
      kind: "pi",
      pi: { mode: "tui" },
      session: { id: "pisess", file: "/tmp/sess1.jsonl", name: "test session" },
      launcher: "pi",
      herdr: null,
      gentle: null,
      redacted: false,
      cwd: process.cwd(),
      spawnId: null,
      model: { provider: "fake", id: "fake-1" },
      thinking: "off",
      status: "idle",
      openPrompts: [],
    });
    expect(h.instance).toBeTruthy();
    expect(h.epoch).toBeTruthy();
    expect(h.plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.plugin.features).toEqual(expect.arrayContaining(["mirror_ui", "gate", "rp_ask_user", "attachments", "deliver_terminal"]));
    expect(h.host).toMatchObject({ pid: process.pid, os: process.platform });
    expect(relay.all.map((e) => e.t).slice(0, 2)).toEqual(["agent.hello", "agent.snapshot"]);
    const snap = relay.of("agent.snapshot")[0]!.d;
    expect(snap).toMatchObject({ epoch: h.epoch, seq: 0, truncated: false });
    expect(snap.entries.map((e: any) => e.kind)).toEqual(["user", "assistant"]);

    await t.fire("agent_start", { type: "agent_start" }, t.ctx);
    await t.fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "ls" } }, t.ctx);
    await t.fire("message_end", { message: { role: "assistant", content: "done" } }, t.ctx);
    await t.fire("agent_settled", { aborted: false }, t.ctx);
    await waitUntil(() => relay.of("agent.event").length >= 4);
    const evs = relay.of("agent.event").map((e) => e.d);
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(evs.every((e) => e.epoch === h.epoch)).toBe(true);
    expect(evs.map((e) => e.e.type)).toEqual(["agent_start", "tool_execution_start", "message_end", "agent_settled"]);
    const st = relay.of("agent.status").map((e) => e.d);
    expect(st[0]).toEqual({ status: "idle" }); // sent right after welcome
    expect(st[1]).toEqual({ status: "working" });
    expect(st[2]).toEqual({ status: "working", detail: "bash: ls" });
    expect(st.at(-1)).toEqual({ status: "idle" });
    expect(t.ctx.ui.mocks.setStatus).toHaveBeenCalledWith("rp", "📱");
  });
  it("new epoch on every session_start (reload); the old runtime is disposed and the mirror not double-wrapped", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const firstEpoch = lastHello().epoch;
    const wrapped = t.ctx.ui.select;
    await t.fire("session_start", { reason: "reload" }, t.ctx);
    await waitUntil(() => relay.of("agent.hello").length === 2);
    expect(lastHello().epoch).not.toBe(firstEpoch);
    expect(t.ctx.ui.select).not.toBe(wrapped); // re-installed over the restored original, not stacked
    const p = t.ctx.ui.select("Q", ["a"]);
    await waitUntil(() => relay.of("prompt.open").length === 1); // exactly one prompt.open, not two
    relay.push("prompt.answer", { promptId: relay.of("prompt.open")[0]!.d.promptId, answer: { optionIds: ["0"] } });
    await expect(p).resolves.toBe("a");
    expect(relay.of("prompt.open")).toHaveLength(1);
  });
  it("session_shutdown closes the connection, cancels open prompts and clears the footer", async () => {
    const t = await boot();
    await waitUntil(() => relay.conns.length === 1);
    void t.ctx.ui.select("Pending?", ["x"]);
    await waitUntil(() => relay.of("prompt.open").length === 1);
    await t.fire("session_shutdown", { reason: "quit" }, t.ctx);
    await waitUntil(() => relay.of("prompt.resolved").length === 1);
    expect(relay.of("prompt.resolved")[0]!.d).toMatchObject({ by: "cancelled" });
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3);
    expect(t.ctx.ui.mocks.setStatus).toHaveBeenLastCalledWith("rp", undefined);
    // shutdown twice is harmless
    await t.fire("session_shutdown", { reason: "quit" }, t.ctx);
  });
  it("redactContent: no transcript in snapshot, events or hello", async () => {
    const branch = [{ type: "message", id: "e1", timestamp: 1, message: { role: "user", content: "TOP-SECRET" } }];
    const t = await boot({ cfg: { redactContent: true }, ctx: makeCtx({ branch }) });
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    await t.fire("message_end", { message: { role: "assistant", content: "TOP-SECRET" } }, t.ctx);
    await t.fire("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: false, result: "TOP-SECRET" }, t.ctx);
    await waitUntil(() => relay.of("agent.event").length >= 1);
    expect(lastHello().redacted).toBe(true);
    expect(JSON.stringify(relay.all)).not.toContain("TOP-SECRET");
  });
  it("herdr location, launcher, spawn id (env and flag) reach the hello", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "p3";
    process.env.HERDR_TAB_ID = "t1";
    process.env.HERDR_WORKSPACE_ID = "w2";
    process.env.GENTLE_SHELL_USER_PI_HOME = "/h/.pi/agent";
    process.env.RP_SPAWN_ID = "SPAWNENV";
    await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(lastHello()).toMatchObject({ herdr: { paneId: "p3", tabId: "t1", workspaceId: "w2", session: null }, launcher: "gentle-shell", spawnId: "SPAWNENV" });
    expect(lastHello().plugin.features).toContain("deliver_herdr");
    delete process.env.RP_SPAWN_ID;
    writeCfg();
    const f = makePi();
    f.flagValues.set("rp-spawn-id", "SPAWNFLAG");
    rpExtension(f.pi);
    await f.fire("session_start", { reason: "startup" }, makeCtx());
    await waitUntil(() => relay.of("agent.hello").length === 2);
    expect(lastHello().spawnId).toBe("SPAWNFLAG");
  });
  it("observes setStatus from every extension → agent.statuses (gentle mode included in hello after reconnect)", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_choice", sourceInfo: { path: "/nonexistent/gentle/extensions/ask-user-choice.ts" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    t.ctx.ui.setStatus("gentle:mode", "Permissions: AUTO");
    await waitUntil(() => relay.of("agent.statuses").some((e) => e.d.items["gentle:mode"] === "Permissions: AUTO"), 4000, "statuses with gentle:mode");
    relay.closeAll(1012);
    await waitUntil(() => relay.of("agent.hello").length === 2);
    expect(lastHello().gentle).toMatchObject({ mode: "auto" });
    expect(lastHello().plugin.features).not.toContain("gate"); // gentle-pi present → auto-detect gate is off
  });
  it("emits pi:theme in agent.statuses on startup", async () => {
    const prev = process.env.PI_THEME;
    process.env.PI_THEME = "Gentleman-Cute";
    try {
      await boot();
      await waitUntil(() => relay.of("agent.hello").length === 1);
      await waitUntil(() => relay.of("agent.statuses").some((e) => e.d.items["pi:theme"] === "Gentleman-Cute"), 4000, "statuses with pi:theme");
    } finally {
      if (prev === undefined) delete process.env.PI_THEME;
      else process.env.PI_THEME = prev;
    }
  });
});

describe("questions & authorizations", () => {
  it("gate: dangerous command → prompt.open (permission) → phone says Permitir → tool proceeds; terminal dialog is closed", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const pending = t.fire("tool_call", { toolCallId: "tc", toolName: "bash", input: { command: "rm -rf build/" } }, t.ctx);
    const open = await waitUntil(() => relay.of("prompt.open")[0]);
    expect(open.d).toMatchObject({
      kind: "select",
      category: "permission",
      danger: "high",
      tool: { name: "bash", args: { command: "rm -rf build/" } },
      options: [{ id: "0", label: "Permitir" }, { id: "1", label: "Permitir siempre en esta sesión" }, { id: "2", label: "Denegar" }, { id: "3", label: "Denegar con motivo…" }],
      agentId: "MACHINE1:sess1",
    });
    expect(t.ctx.ui.calls.at(-1)).toMatchObject({ m: "select" });
    const passedSignal = t.ctx.ui.mocks.select.mock.calls[0][2].signal as AbortSignal;
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["0"] }, deviceId: "dev1" });
    expect(await pending).toBeUndefined();
    expect(passedSignal.aborted).toBe(true);
    await waitUntil(() => relay.of("prompt.ack").length === 1);
    expect(relay.of("prompt.ack")[0]!.d).toEqual({ promptId: open.d.promptId, accepted: true });
  });
  it("gate: phone denies → tool call is blocked; terminal first → prompt.resolved by local", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const p1 = t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "sudo reboot" } }, t.ctx);
    const o1 = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o1.d.promptId, answer: { optionIds: ["2"] } });
    expect(await p1).toMatchObject({ block: true, reason: "Denegado por el usuario" });

    // now the terminal answers first
    t.ctx.ui.mocks.select.mockImplementationOnce(async () => "Permitir");
    const r2 = await t.fire("tool_call", { toolCallId: "2", toolName: "bash", input: { command: "sudo ls" } }, t.ctx);
    expect(r2).toBeUndefined();
    const resolved = await waitUntil(() => relay.of("prompt.resolved")[0]);
    expect(resolved.d).toMatchObject({ by: "local", answer: { optionIds: ["0"] } });
  });
  it("gate: 'Permitir siempre' is persisted as an rp.allow entry and survives a reload (rebuilt from the branch)", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    t.ctx.ui.mocks.select.mockImplementationOnce(async () => "Permitir siempre en esta sesión");
    await t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "sudo ls" } }, t.ctx);
    expect(t.entries).toEqual([{ type: "custom", customType: "rp.allow", data: { key: "bash:sudo ls" } }]);
    // second call: same high-danger command is not asked again
    const n = (await waitUntil(() => relay.of("prompt.open").length, 3000, "first prompt.open"));
    expect(await t.fire("tool_call", { toolCallId: "2", toolName: "bash", input: { command: "sudo ls" } }, t.ctx)).toBeUndefined();
    expect(relay.of("prompt.open")).toHaveLength(n);
    // reload with the entry in the branch
    const ctx2 = makeCtx({ branch: t.entries });
    await t.fire("session_start", { reason: "reload" }, ctx2);
    await waitUntil(() => relay.of("agent.hello").length === 2);
    expect(await t.fire("tool_call", { toolCallId: "3", toolName: "bash", input: { command: "sudo ls" } }, ctx2)).toBeUndefined();
    expect(relay.of("prompt.open")).toHaveLength(n);
  });
  it("gate is disabled when gentle-pi tools are present (auto-detect), enabled by explicit mode", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_question", sourceInfo: { path: "x" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(await t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "rm -rf /" } }, t.ctx)).toBeUndefined();
    expect(relay.of("prompt.open")).toHaveLength(0);
    const t2 = await boot({ tools, cfg: { gate: { mode: "dangerous" } } });
    await waitUntil(() => relay.of("agent.hello").length === 2);
    const p = t2.fire("tool_call", { toolCallId: "2", toolName: "bash", input: { command: "rm -rf /" } }, t2.ctx);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["0"] } });
    await p;
  });
  it("gate fails safe with no UI and no relay connection", async () => {
    relay.rejectUpgrade = 503; // never connects (and long-poll is not reachable quickly either)
    const t = await boot({ ctx: makeCtx({ hasUI: false, mode: "print" }), cfg: { relayUrl: "http://127.0.0.1:1", gate: { approverWaitMs: 100 } } });
    const r = await t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "rm -rf /" } }, t.ctx);
    expect(r).toMatchObject({ block: true });
    expect(r.reason).toMatch(/nadie que pueda autorizar/);
  });
  it("headless: the gate waits for the relay to come up instead of failing at startup", async () => {
    relay.autoWelcome = false;
    const ctx = makeCtx({ hasUI: false, mode: "print" });
    const t = await boot({ ctx });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const p = t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "rm -rf x" } }, ctx);
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.of("prompt.open")).toHaveLength(0); // still waiting for welcome
    relay.conns[0]!.ws.send(JSON.stringify({ v: 1, t: "agent.welcome", ts: 1, d: {} }));
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["0"] } });
    expect(await p).toBeUndefined();
  });
  it("headless (print/json): the phone alone answers the gate", async () => {
    const ctx = makeCtx({ hasUI: false, mode: "json" });
    const t = await boot({ ctx });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(lastHello().pi.mode).toBe("json");
    const p = t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "rm -rf x" } }, ctx);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["2"] } });
    expect(await p).toMatchObject({ block: true });
    expect(ctx.ui.mocks.select).not.toHaveBeenCalled(); // never touched the no-op ui
  });
  it("another extension's confirm() is mirrored; gentle-pi permission-request classifies it as an authorization", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_choice", sourceInfo: { path: "x" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    t.events.emit("pi-permission-system:permission-request", { requestId: "r1", state: "waiting", toolName: "bash" });
    const p = t.ctx.ui.confirm("Dangerous command (data-loss)", "rm -rf ~/proj");
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    expect(o.d).toMatchObject({ kind: "confirm", category: "permission", danger: "high", tool: { name: "bash" }, message: "rm -rf ~/proj", options: [{ id: "yes", label: "Permitir" }, { id: "no", label: "Denegar" }] });
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { confirmed: true } });
    await expect(p).resolves.toBe(true);
  });
  it("prompts open while offline travel in hello.openPrompts after reconnecting; pendingAnswers in welcome resolve them", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.autoWelcome = false;
    const p = t.ctx.ui.select("Offline question", ["yes", "no"]);
    await waitUntil(() => relay.of("prompt.open").length === 1);
    const id = relay.of("prompt.open")[0]!.d.promptId;
    relay.closeAll(1012);
    await waitUntil(() => relay.of("agent.hello").length === 2);
    expect(lastHello().openPrompts.map((x: any) => x.promptId)).toEqual([id]);
    expect(lastHello().status).toBe("waiting_input");
    // relay answers while we were away
    relay.autoWelcome = true;
    relay.conns.at(-1)!.ws.send(JSON.stringify({ v: 1, t: "agent.welcome", ts: 1, d: { pendingAnswers: [{ promptId: id, answer: { optionIds: ["1"] } }] } }));
    await expect(p).resolves.toBe("no");
  });
  it("two devices answering the same prompt at once: exactly one wins, the other gets accepted:false", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const p = t.ctx.ui.select("Race?", ["a", "b"]);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["0"] }, deviceId: "phone-1" });
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["1"] }, deviceId: "phone-2" });
    await expect(p).resolves.toBe("a");
    await waitUntil(() => relay.of("prompt.ack").length === 2);
    expect(relay.of("prompt.ack").map((a) => a.d.accepted).sort()).toEqual([false, true]);
  });
  it("relay killed with a question open: the dialog keeps working, the question is re-announced and answered once the relay is back", async () => {
    const port = relay.port;
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const p = t.ctx.ui.select("Survives the outage?", ["yes", "no"]);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    await relay.stop(); // relay process dies abruptly
    await new Promise((r) => setTimeout(r, 300));
    relay = await new FakeRelay().start(port);
    const hello = await waitUntil(() => relay.of("agent.hello")[0], 10000, "hello on the new relay");
    expect(hello.d.openPrompts.map((x: any) => x.promptId)).toEqual([o.d.promptId]);
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["1"] } });
    await expect(p).resolves.toBe("no");
  });
  it("late/unknown prompt.answer gets prompt.ack{accepted:false}", async () => {
    await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.push("prompt.answer", { promptId: "GHOST", answer: { confirmed: true } });
    await waitUntil(() => relay.of("prompt.ack").length === 1);
    expect(relay.of("prompt.ack")[0]!.d).toEqual({ promptId: "GHOST", accepted: false });
  });
  it("custom()/editor dialogs → terminal_wait events and waiting_input status", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    await t.fire("ui_prompt_start", { kind: "custom", title: "Pick a file" }, t.ctx);
    await t.fire("ui_prompt_start", { kind: "select", title: "mirrored elsewhere" }, t.ctx);
    await t.fire("ui_prompt_end", { kind: "select" }, t.ctx);
    await t.fire("ui_prompt_end", { kind: "custom", title: "Pick a file" }, t.ctx);
    await waitUntil(() => relay.of("agent.event").length >= 2);
    const tw = relay.of("agent.event").map((e) => e.d.e).filter((e) => e.type === "terminal_wait");
    expect(tw).toEqual([{ type: "terminal_wait", kind: "custom", title: "Pick a file", active: true }, { type: "terminal_wait", kind: "custom", title: "Pick a file", active: false }]);
    expect(relay.of("agent.status").map((e) => e.d.status)).toEqual(expect.arrayContaining(["waiting_input", "idle"]));
  });
  it("gentle ask_user_question: the TUI custom() dialog is resolved from the phone through the adapter", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_question", sourceInfo: { path: "/nonexistent/x" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(lastHello().plugin.features).toContain("adapters:gentle-ask");
    const args = { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "PG", description: "p" }, { label: "SQLite", description: "s" }] }] };
    await t.fire("tool_execution_start", { toolCallId: "tc9", toolName: "ask_user_question", args }, t.ctx);
    const resultP = t.ctx.ui.custom((_tui: any, _th: any, _kb: any, done: any) => ({ done }));
    const open = await waitUntil(() => relay.of("prompt.open")[0]);
    await t.fire("ui_prompt_start", { kind: "custom" }, t.ctx); // Pi emits this after our wrapper already opened the prompt
    expect(open.d).toMatchObject({ kind: "questionnaire", category: "question", source: { extension: "gentle-pi", tool: "ask_user_question" } });
    expect(open.d.questions[0].options.map((o: any) => o.label)).toEqual(["PG", "SQLite"]);
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { answers: [{ questionIndex: 0, optionIds: ["1"] }] } });
    await expect(resultP).resolves.toEqual({ cancelled: false, answers: [{ questionIndex: 0, question: "Which DB?", kind: "option", answer: "SQLite" }] });
    await t.fire("ui_prompt_end", { kind: "custom" }, t.ctx);
    await t.fire("tool_execution_end", { toolCallId: "tc9", toolName: "ask_user_question" }, t.ctx);
    // no "waiting on terminal" noise for an adapted dialog
    expect(relay.of("agent.event").map((e) => e.d.e.type)).not.toContain("terminal_wait");
  });
  it("gentle-pi outside the tested range disables adapters and warns once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegentle-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "gentle-pi", version: "6.0.0" }));
    fs.mkdirSync(path.join(dir, "extensions"));
    const tools = [{ name: "ask_user_question", sourceInfo: { path: path.join(dir, "extensions", "ask-user-question.ts"), baseDir: dir } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(lastHello().gentle.version).toBe("6.0.0");
    expect(lastHello().plugin.features).not.toContain("adapters:gentle-ask");
    expect(t.ctx.ui.mocks.notify).toHaveBeenCalledWith(expect.stringMatching(/fuera del rango/), "warning");
  });
  it("rp_ask_user is registered only when no other question tool exists, and answers through the phone", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    expect(t.registeredTools.map((x) => x.name)).toEqual(["rp_ask_user"]);
    expect(lastHello().plugin.features).toContain("rp_ask_user");
    const run = t.registeredTools[0].execute("id", { question: "Color?", options: ["red", "blue"] });
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    expect(o.d).toMatchObject({ category: "question", kind: "select" });
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["1"] } });
    expect((await run).content[0].text).toBe("User answered: blue");
    const g = await boot({ tools: [{ name: "ask_user_question", sourceInfo: { path: "x" } }] });
    expect(g.registeredTools).toEqual([]);
  });
  it("mirrorDialogs:false leaves Pi's dialogs alone but the gate still reaches the phone", async () => {
    const t = await boot({ cfg: { mirrorDialogs: false } });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    const original = makeUi();
    expect(typeof t.ctx.ui.select).toBe("function");
    const p = t.ctx.ui.select("not mirrored", ["a"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.of("prompt.open")).toHaveLength(0);
    void p;
    const g = t.fire("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "rm -rf /" } }, t.ctx);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    expect(o.d.category).toBe("permission");
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["0"] } });
    await g;
    void original;
  });
});

describe("messages from the phone", () => {
  it("user.message → sendUserMessage + ack{sent,api}; duplicates ack 'duplicate'; origin recorded", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.push("user.message", { clientMsgId: "m1", deviceId: "dev", text: "hola agente" });
    await waitUntil(() => relay.of("user.message.ack").length === 1);
    expect(relay.of("user.message.ack")[0]!.d).toEqual({ clientMsgId: "m1", disposition: "sent", method: "api", error: null });
    expect(t.sent[0]).toEqual({ content: "hola agente", opts: undefined });
    expect(t.entries.find((e) => e.customType === "rp.origin")!.data).toMatchObject({ clientMsgId: "m1", deviceId: "dev", method: "api" });
    relay.push("user.message", { clientMsgId: "m1", text: "hola agente" });
    await waitUntil(() => relay.of("user.message.ack").length === 2);
    expect(relay.of("user.message.ack")[1]!.d.disposition).toBe("duplicate");
    expect(t.sent).toHaveLength(1);
  });
  it("busy agent queues as followUp/steer", async () => {
    const ctx = makeCtx({ idle: false });
    const t = await boot({ ctx });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.push("user.message", { clientMsgId: "a", text: "x", delivery: "steer" });
    relay.push("user.message", { clientMsgId: "b", text: "y", delivery: "followUp" });
    await waitUntil(() => relay.of("user.message.ack").length === 2);
    expect(relay.of("user.message.ack").map((e) => e.d.disposition)).toEqual(["queued_steer", "queued_followup"]);
    expect(t.sent.map((s) => s.opts)).toEqual([{ deliverAs: "steer" }, { deliverAs: "followUp" }]);
  });
  it("asCommand runs /… as a command", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.push("user.message", { clientMsgId: "c", text: "/gentle:mode normal", asCommand: true });
    await waitUntil(() => relay.of("user.message.ack").length === 1);
    expect(relay.of("user.message.ack")[0]!.d.disposition).toBe("command");
    expect(t.sent[0]).toEqual({ content: "/gentle:mode normal", opts: { expandPromptTemplates: true } });
  });
  it("attachments: images inline for api, other files saved in the inbox and cited", async () => {
    const inbox = fs.mkdtempSync(path.join(os.tmpdir(), "rpinbox2-"));
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    relay.httpResponses.set("/v1/blobs/IMG1", () => ({ status: 200, body: png, headers: { "content-type": "image/png" } }));
    relay.httpResponses.set("/v1/blobs/PDF1", () => ({ status: 200, body: Buffer.from("%PDF"), headers: { "content-type": "application/pdf" } }));
    const t = await boot({ cfg: { inboxDir: inbox } });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.push("user.message", {
      clientMsgId: "att",
      text: "mira",
      attachments: [
        { blobId: "IMG1", name: "shot.png", mime: "image/png", size: png.length },
        { blobId: "PDF1", name: "spec.pdf", mime: "application/pdf", size: 4 },
      ],
    });
    await waitUntil(() => relay.of("user.message.ack").length === 1, 5000);
    const content = t.sent[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/^mira\n\n\[Archivo adjunto desde el móvil: .*spec\.pdf \(application\/pdf, 4 B\)\]$/);
    expect(content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect(relay.httpLog.find((h) => h.url === "/v1/blobs/IMG1")!.headers.authorization).toBe("Bearer tok");
    expect(fs.readdirSync(path.join(inbox, "sess1"))).toHaveLength(1);
  });
  it("agent.abort → ctx.abort(); agent.resync → fresh snapshot", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    relay.push("agent.abort", {});
    await waitUntil(() => t.ctx.abort.mock.calls.length === 1);
    relay.push("agent.resync", {});
    await waitUntil(() => relay.of("agent.snapshot").length === 2);
  });
  it("gentle AUTO: the message is typed into the TUI of this process (source interactive) and acked as typed", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_choice", sourceInfo: { path: "x" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    t.ctx.ui.setStatus("gentle:mode", "Permissions: AUTO");
    const emitted: string[] = [];
    vi.spyOn(process.stdin, "emit").mockImplementation(((event: string, data: string) => {
      emitted.push(data);
      if (data === "\r") void t.fire("input", { type: "input", text: "autoriza y sigue", source: "interactive" }, t.ctx);
      return true;
    }) as any);
    relay.push("user.message", { clientMsgId: "typed1", deviceId: "dev", text: "autoriza y sigue" });
    await waitUntil(() => relay.of("user.message.ack").length === 1);
    expect(relay.of("user.message.ack")[0]!.d).toEqual({ clientMsgId: "typed1", disposition: "typed", method: "interactive", error: null });
    expect(emitted).toEqual(["\x1b[200~autoriza y sigue\x1b[201~", "\r"]);
    expect(t.sent).toHaveLength(0); // NOT via sendUserMessage (that would be source "extension")
    expect(t.entries.find((e) => e.customType === "rp.origin")!.data).toMatchObject({ method: "interactive", deviceId: "dev" });
  });
  it("gentle AUTO but Pi never reports the typed input → reverts, falls back to api and warns", async () => {
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }, { name: "ask_user_choice", sourceInfo: { path: "x" } }];
    const t = await boot({ tools });
    await waitUntil(() => relay.of("agent.hello").length === 1);
    t.ctx.ui.setStatus("gentle:mode", "Permissions: AUTO");
    vi.spyOn(process.stdin, "emit").mockImplementation((() => true) as any);
    relay.push("user.message", { clientMsgId: "typed2", text: "hello" });
    await waitUntil(() => relay.of("user.message.ack").length === 1, 6000);
    expect(relay.of("user.message.ack")[0]!.d).toMatchObject({ disposition: "sent", method: "api" });
    expect(t.ctx.ui.mocks.notify).toHaveBeenCalledWith(expect.stringMatching(/modo Auto/), "warning");
  });
});

describe("/rp commands with a live runtime", () => {
  it("/rp status describes the connection; /rp test round-trips a question through the phone", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    const cmd = t.commands.get("rp");
    await cmd.handler("status", t.ctx);
    const text = t.ctx.ui.mocks.notify.mock.calls.at(-1)[0] as string;
    expect(text).toContain("Conexión: conectado");
    expect(text).toContain("agentId: MACHINE1:sess1");
    expect(text).toContain("Funciones:");
    const run = cmd.handler("test", t.ctx);
    const o = await waitUntil(() => relay.of("prompt.open")[0]);
    expect(o.d).toMatchObject({ category: "question", options: [{ label: "Sí, llegó" }, { label: "No llegó" }] });
    relay.push("prompt.answer", { promptId: o.d.promptId, answer: { optionIds: ["0"] } });
    await run;
    expect(t.ctx.ui.mocks.notify.mock.calls.at(-1)[0]).toMatch(/RP test: "Sí, llegó"/);
  });
  it("/rp off stops the runtime (socket closes); /rp on starts it again", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    await t.commands.get("rp").handler("off", t.ctx);
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3);
    await t.commands.get("rp").handler("on", t.ctx);
    await waitUntil(() => relay.of("agent.hello").length === 2, 5000, "second hello after /rp on");
  });
  it("/rp pair inside a running session reconnects with the new credentials", async () => {
    writeCfg({ machineToken: null, machineId: null });
    const f = makePi();
    rpExtension(f.pi);
    const ctx = makeCtx();
    await f.fire("session_start", { reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.conns).toHaveLength(0); // unpaired → inert
    relay.httpResponses.set("/v1/pair/machine", () => ({ status: 200, body: { machineId: "NEWM", machineToken: "newtok" } }));
    await f.commands.get("rp").handler(`pair ${relay.url} ABCD2345 --name PC --context work`, ctx);
    await waitUntil(() => relay.of("agent.hello").length === 1, 5000, "hello after pairing");
    expect(relay.of("agent.hello")[0]!.d.agentId).toBe("NEWM:sess1");
    expect(relay.conns[0]!.headers.authorization).toBe("Bearer newtok");
  });
});

describe("fatal connection states", () => {
  it("4001 notifies the user and marks the footer; no reconnect storm", async () => {
    const t = await boot();
    await waitUntil(() => relay.of("agent.hello").length === 1);
    relay.closeAll(4001, "revoked");
    await waitUntil(() => t.ctx.ui.mocks.notify.mock.calls.some((c: any[]) => /4001/.test(c[0])));
    expect(t.ctx.ui.mocks.setStatus).toHaveBeenLastCalledWith("rp", "RP ✗");
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.of("agent.hello")).toHaveLength(1);
  });
});

describe("Pi never waits for the relay", () => {
  it("session_start returns immediately even when the relay is unreachable; handlers keep working", async () => {
    const t0 = Date.now();
    const t = await boot({ cfg: { relayUrl: "http://127.0.0.1:9" } });
    expect(Date.now() - t0).toBeLessThan(1500);
    await t.fire("agent_start", {}, t.ctx);
    await t.fire("message_end", { message: { role: "assistant", content: "x" } }, t.ctx);
    expect(await t.fire("tool_call", { toolCallId: "1", toolName: "read", input: { path: "x" } }, t.ctx)).toBeUndefined();
    await t.fire("session_shutdown", {}, t.ctx);
  });
});

describe("toolDetail telemetry", () => {
  it("formats subagent_run with agent and label or task", () => {
    expect(toolDetail("subagent_run", { agent: "worker", label: "fix bug" })).toBe(": worker: fix bug");
    expect(toolDetail("subagent_run", { agent: "worker", task: "investigate memory leak" })).toBe(": worker: investigate memory leak");
    expect(toolDetail("subagent_run", { label: "explore repo" })).toBe(": explore repo");
  });

  it("formats intercom with action and recipient", () => {
    expect(toolDetail("intercom", { action: "ask", to: "peer-session" })).toBe(": ask → peer-session");
    expect(toolDetail("intercom", { action: "reply" })).toBe(": reply");
  });

  it("formats orchestrator_send_message with recipient", () => {
    expect(toolDetail("orchestrator_send_message", { recipient_session_id: "orch-1" })).toBe(": → orch-1");
  });

  it("formats standard file, command, query and message tools", () => {
    expect(toolDetail("bash", { command: "npm test" })).toBe(": npm test");
    expect(toolDetail("read", { path: "src/app.ts" })).toBe(": src/app.ts");
    expect(toolDetail("search", { query: "CommEvent" })).toBe(": CommEvent");
    expect(toolDetail("grep", { pattern: "agent.event" })).toBe(": agent.event");
    expect(toolDetail("custom", null)).toBe("");
  });
});
void configModule;
