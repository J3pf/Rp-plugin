import { describe, expect, it, vi } from "vitest";
import { Broker, fromLocal, toLocalValue, withSignal, type DialogRequest } from "../src/extension/prompts/broker.ts";
import { Classifier, promptContext } from "../src/extension/prompts/classify.ts";
import { AdapterRegistry, gentleAskUserChoice, gentleAskUserQuestion } from "../src/extension/prompts/adapters/index.ts";
import { Gate, ALLOW, ALLOW_SESSION, DENY, DENY_REASON, allowKey, allowedFromBranch, decide, effectiveMode, compilePatterns, summarize } from "../src/extension/prompts/gate.ts";
import { shouldRegisterAskUser, runAskUser, askUserToolDefinition } from "../src/extension/prompts/askUser.ts";
import { installMirror } from "../src/extension/prompts/mirror.ts";
import { StatusTracker } from "../src/extension/status.ts";
import { HerdrBlocker } from "../src/extension/herdr.ts";
import { baseConfig, makeCtx, makeUi, FakeBus } from "./helpers.ts";

function mkBroker(over: Partial<ConstructorParameters<typeof Broker>[0]> = {}) {
  const sent: Array<[string, any]> = [];
  const classifier = new Classifier();
  const broker = new Broker({ agentId: "M:S", send: (t, d) => sent.push([t, d]), hasUI: true, classifier, herdr: null, ...over });
  const of = (t: string) => sent.filter((s) => s[0] === t).map((s) => s[1]);
  return { broker, sent, of, classifier };
}

describe("Broker.race", () => {
  it("phone wins: aborts the local dialog, acks, returns the exact option label", async () => {
    const { broker, of } = mkBroker();
    let aborted = false;
    const p = broker.race({ kind: "select", title: "Pick", options: ["Alpha", "Beta"] }, (signal) => new Promise<string | undefined>((res) => signal.addEventListener("abort", () => { aborted = true; res(undefined); })));
    const open = of("prompt.open")[0];
    expect(open).toMatchObject({ kind: "select", category: "dialog", title: "Pick", options: [{ id: "0", label: "Alpha" }, { id: "1", label: "Beta" }] });
    expect(broker.handleAnswer(open.promptId, { optionIds: ["1"] })).toBe(true);
    await expect(p).resolves.toBe("Beta");
    expect(aborted).toBe(true);
    expect(of("prompt.ack")).toEqual([{ promptId: open.promptId, accepted: true }]);
    expect(of("prompt.resolved")).toHaveLength(0);
    expect(broker.openCount).toBe(0);
  });
  it("terminal wins: prompt.resolved by local with the answer; late phone answer is rejected", async () => {
    const { broker, of } = mkBroker();
    let finish!: (v: string) => void;
    const p = broker.race({ kind: "select", title: "T", options: ["A", "B"] }, () => new Promise<string>((r) => (finish = r)));
    const id = of("prompt.open")[0].promptId;
    finish("A");
    await expect(p).resolves.toBe("A");
    expect(of("prompt.resolved")).toEqual([{ promptId: id, by: "local", answer: { optionIds: ["0"] } }]);
    expect(broker.handleAnswer(id, { optionIds: ["1"] })).toBe(false);
    expect(of("prompt.ack").pop()).toEqual({ promptId: id, accepted: false });
  });
  it("a second phone answer is rejected (first wins)", async () => {
    const { broker, of } = mkBroker();
    const p = broker.race({ kind: "confirm", title: "OK?", message: "m" }, () => new Promise<boolean>(() => {}));
    const id = of("prompt.open")[0].promptId;
    expect(broker.handleAnswer(id, { confirmed: true })).toBe(true);
    expect(broker.handleAnswer(id, { confirmed: false })).toBe(false);
    await expect(p).resolves.toBe(true);
  });
  it("confirm answers: confirmed boolean, option ids yes/no, cancelled → false", () => {
    const req: DialogRequest = { kind: "confirm", title: "t", message: "m" };
    expect(toLocalValue(req, { confirmed: true })).toBe(true);
    expect(toLocalValue(req, { optionIds: ["yes"] })).toBe(true);
    expect(toLocalValue(req, { optionIds: ["no"] })).toBe(false);
    expect(toLocalValue(req, { cancelled: true })).toBe(false);
  });
  it("input answers; select free text; out-of-range option ids", () => {
    expect(toLocalValue({ kind: "input", title: "t" }, { text: "hi" })).toBe("hi");
    expect(toLocalValue({ kind: "input", title: "t" }, { cancelled: true })).toBeUndefined();
    const sel: DialogRequest = { kind: "select", title: "t", options: ["a"] };
    expect(toLocalValue({ ...sel, allowFreeText: true }, { text: "custom" })).toBe("custom");
    expect(toLocalValue(sel, { text: "custom" })).toBeUndefined();
    expect(toLocalValue({ ...sel, allowFreeText: false }, { text: "custom" })).toBeUndefined();
    expect(toLocalValue(sel, { text: "a" })).toBe("a");
    expect(toLocalValue(sel, { optionIds: ["7"] })).toBeUndefined();
    expect(fromLocal(sel, "a")).toEqual({ optionIds: ["0"] });
    expect(fromLocal(sel, "zzz")).toEqual({ text: "zzz" });
    expect(fromLocal(sel, undefined)).toEqual({ cancelled: true });
  });
  it("opts.timeout elapsed → by:timeout; caller abort → by:cancelled", async () => {
    vi.useFakeTimers();
    const { broker, of } = mkBroker();
    const p = broker.race({ kind: "select", title: "t", options: ["a"], opts: { timeout: 1000 } }, () => new Promise<string | undefined>((res) => setTimeout(() => res(undefined), 1000)));
    expect(of("prompt.open")[0].expiresAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(of("prompt.resolved")[0]).toMatchObject({ by: "timeout", answer: null });
    const ac = new AbortController();
    const p2 = broker.race({ kind: "select", title: "t2", options: ["a"], opts: { signal: ac.signal } }, () => new Promise<string | undefined>((res) => ac.signal.addEventListener("abort", () => res(undefined))));
    ac.abort();
    await p2;
    expect(of("prompt.resolved")[1]).toMatchObject({ by: "cancelled" });
    vi.useRealTimers();
  });
  it("headless (no local UI): only the phone answers; timeout and abort are honored", async () => {
    vi.useFakeTimers();
    const { broker, of } = mkBroker({ hasUI: false });
    const p = broker.race<string | undefined>({ kind: "select", title: "t", options: ["x", "y"] }, null);
    broker.handleAnswer(of("prompt.open")[0].promptId, { optionIds: ["0"] });
    await expect(p).resolves.toBe("x");
    const p2 = broker.race<string | undefined>({ kind: "input", title: "t", opts: { timeout: 50 } }, null);
    await vi.advanceTimersByTimeAsync(60);
    await expect(p2).resolves.toBeUndefined();
    expect(of("prompt.resolved").pop()).toMatchObject({ by: "timeout" });
    const ac = new AbortController();
    const p3 = broker.race<boolean>({ kind: "confirm", title: "t", message: "m", opts: { signal: ac.signal } }, null);
    ac.abort();
    await expect(p3).resolves.toBe(false);
    vi.useRealTimers();
  });
  it("prompt.cancel from the relay resolves as cancelled without sending prompt.ack", async () => {
    const { broker, of } = mkBroker();
    const p = broker.race({ kind: "confirm", title: "t", message: "m" }, () => new Promise<boolean>(() => {}));
    broker.handleCancel(of("prompt.open")[0].promptId);
    await expect(p).resolves.toBe(false);
    expect(of("prompt.ack")).toHaveLength(0);
  });
  it("concurrent prompts are independent; openPrompts() feeds agent.hello", async () => {
    const { broker, of } = mkBroker();
    const a = broker.race({ kind: "select", title: "A", options: ["1"] }, () => new Promise<string>(() => {}));
    const b = broker.race({ kind: "select", title: "B", options: ["2"] }, () => new Promise<string>(() => {}));
    expect(broker.openPrompts().map((p) => p.title)).toEqual(["A", "B"]);
    const [pa, pb] = of("prompt.open");
    broker.handleAnswer(pb.promptId, { optionIds: ["0"] });
    await expect(b).resolves.toBe("2");
    expect(broker.openPrompts().map((p) => p.title)).toEqual(["A"]);
    broker.handleAnswer(pa.promptId, { cancelled: true });
    await expect(a).resolves.toBeUndefined();
  });
  it("shutdown cancels open prompts without sending prompt.ack", async () => {
    const { broker, of } = mkBroker();
    const p = broker.race({ kind: "confirm", title: "t", message: "m" }, () => new Promise<boolean>(() => {}));
    broker.shutdown();
    await p;
    expect(of("prompt.resolved")[0]).toMatchObject({ by: "cancelled" });
    expect(of("prompt.ack")).toHaveLength(0);
  });
  it("withSignal merges the caller's signal", () => {
    const caller = new AbortController();
    const mine = new AbortController();
    const merged = withSignal({ timeout: 5, signal: caller.signal }, mine.signal);
    expect(merged.timeout).toBe(5);
    expect(merged.signal!.aborted).toBe(false);
    caller.abort();
    expect(merged.signal!.aborted).toBe(true);
    expect(withSignal(undefined, mine.signal).signal).toBe(mine.signal);
  });
  it("herdr blocked marker for prompts nobody else reported", async () => {
    const bus = new FakeBus();
    const events: any[] = [];
    bus.on("herdr:blocked", (d) => events.push(d));
    const { broker, of } = mkBroker({ herdr: new HerdrBlocker(bus, true) });
    const p = broker.race({ kind: "select", title: "Dialog", options: ["a"] }, () => new Promise<string>(() => {}));
    expect(events).toEqual([{ active: true, label: "Dialog" }]);
    broker.handleAnswer(of("prompt.open")[0].promptId, { optionIds: ["0"] });
    await p;
    expect(events[1]).toEqual({ active: false });
  });
});

describe("Classifier", () => {
  it("gentle-pi confirmation right after permission-request → permission", () => {
    let now = 1000;
    const c = new Classifier(() => now);
    c.onPermissionRequest({ state: "waiting", toolName: "bash", requestId: "r1" });
    const r = c.classifyDialog("confirm", "Dangerous: data-loss risk", "rm -rf /tmp/x");
    expect(r).toMatchObject({ category: "permission", danger: "high", herdrReported: true, tool: { name: "bash", args: { command: "rm -rf /tmp/x" } } });
    // consumed
    expect(c.classifyDialog("confirm", "again", "m").category).toBe("dialog");
    c.onPermissionRequest({ state: "waiting", toolName: "bash" });
    now += 1000;
    expect(c.classifyDialog("confirm", "late", "m").category).toBe("dialog");
    c.onPermissionRequest({ state: "resolved", toolName: "bash" });
    expect(c.classifyDialog("confirm", "x", "m").category).toBe("dialog");
    c.onPermissionRequest({ state: "waiting", toolName: "bash" });
    expect(c.classifyDialog("confirm", "Run command", "ls").danger).toBe("medium");
  });
  it("subagent glyph → question + subagent", () => {
    const r = new Classifier().classifyDialog("select", "❀ reviewer asks", undefined);
    expect(r).toMatchObject({ category: "question", danger: "low", source: { subagent: true } });
  });
  it("AsyncLocalStorage context from our gate/rp_ask_user wins", async () => {
    const c = new Classifier();
    const r = await promptContext.run({ category: "permission", danger: "high", tool: { name: "bash", args: { command: "rm -rf x" } } }, async () => {
      await Promise.resolve();
      return c.classifyDialog("select", "⚠ bash", undefined);
    });
    expect(r).toMatchObject({ category: "permission", danger: "high", tool: { name: "bash" } });
  });
});

describe("gentle-pi 4.1.0 adapters (fixtures taken from the real tool source)", () => {
  const choiceArgs = {
    question: "Which approach?",
    options: [
      { label: "Fast", description: "quick", value: "tok-fast" },
      { label: "Safe", description: "careful", value: "tok-safe" },
    ],
    allowCustomResponse: true,
  };
  it("ask_user_choice → select prompt; answers map to {value,label,index(1-based)} / {customResponse} / undefined", () => {
    expect(gentleAskUserChoice.accepts(choiceArgs)).toBe(true);
    expect(gentleAskUserChoice.accepts({ question: "x" })).toBe(false);
    const p = gentleAskUserChoice.toPrompt(choiceArgs);
    expect(p).toMatchObject({ kind: "select", title: "Which approach?", allowFreeText: true, options: [{ id: "0", label: "Fast", description: "quick" }, { id: "1", label: "Safe" }] });
    expect(gentleAskUserChoice.toResult(choiceArgs, { optionIds: ["1"] })).toEqual({ value: "tok-safe", label: "Safe", index: 2 });
    expect(gentleAskUserChoice.toResult(choiceArgs, { text: "my own" })).toEqual({ customResponse: "my own" });
    expect(gentleAskUserChoice.toResult({ ...choiceArgs, allowCustomResponse: false }, { text: "nope" })).toBeUndefined();
    expect(gentleAskUserChoice.toResult(choiceArgs, { cancelled: true })).toBeUndefined();
    expect(gentleAskUserChoice.toResult(choiceArgs, { optionIds: ["9"] })).toBeUndefined();
    expect(gentleAskUserChoice.fromResult(choiceArgs, { value: "tok-fast", label: "Fast", index: 1 })).toEqual({ optionIds: ["0"] });
    expect(gentleAskUserChoice.fromResult(choiceArgs, { customResponse: "z" })).toEqual({ text: "z" });
    expect(gentleAskUserChoice.fromResult(choiceArgs, undefined)).toEqual({ cancelled: true });
  });

  const qArgs = {
    questions: [
      { question: "DB?", header: "Database", options: [{ label: "PG", description: "postgres", preview: "pg-prev" }, { label: "SQLite", description: "file" }] },
      { question: "Features?", header: "Features", multiSelect: true, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }, { label: "C", description: "c" }] },
    ],
  };
  it("ask_user_question → questionnaire; QuestionnaireResult rows have the exact AnswerRow shape", () => {
    expect(gentleAskUserQuestion.accepts(qArgs)).toBe(true);
    expect(gentleAskUserQuestion.accepts({ questions: [] })).toBe(false);
    const p = gentleAskUserQuestion.toPrompt(qArgs);
    expect(p.kind).toBe("questionnaire");
    expect(p.questions).toHaveLength(2);
    expect(p.questions![1]).toMatchObject({ multiSelect: true, allowFreeText: true, header: "Features" });
    const res: any = gentleAskUserQuestion.toResult(qArgs, { answers: [{ questionIndex: 1, optionIds: ["0", "2"] }, { questionIndex: 0, optionIds: ["0"] }] });
    expect(res).toEqual({
      cancelled: false,
      answers: [
        { questionIndex: 0, question: "DB?", kind: "option", answer: "PG", preview: "pg-prev" },
        { questionIndex: 1, question: "Features?", kind: "multi", answer: null, selected: ["A", "C"] },
      ],
    });
    const custom: any = gentleAskUserQuestion.toResult(qArgs, { answers: [{ questionIndex: 0, text: "Mongo" }, { questionIndex: 1, optionIds: ["1"], text: "plus D" }] });
    expect(custom.answers[0]).toEqual({ questionIndex: 0, question: "DB?", kind: "custom", answer: "Mongo" });
    expect(custom.answers[1]).toEqual({ questionIndex: 1, question: "Features?", kind: "custom", answer: "plus D", selected: ["B"] });
  });
  it("partial or cancelled questionnaires are never committed silently", () => {
    expect(gentleAskUserQuestion.toResult(qArgs, { answers: [{ questionIndex: 0, optionIds: ["0"] }] })).toEqual({ cancelled: true, answers: [] });
    expect(gentleAskUserQuestion.toResult(qArgs, { cancelled: true })).toEqual({ cancelled: true, answers: [] });
  });
  it("fromResult reports what the terminal answered", () => {
    const ans = gentleAskUserQuestion.fromResult(qArgs, {
      cancelled: false,
      answers: [
        { questionIndex: 0, question: "DB?", kind: "option", answer: "SQLite" },
        { questionIndex: 1, question: "Features?", kind: "multi", answer: null, selected: ["B", "C"] },
      ],
    });
    expect(ans).toEqual({ answers: [{ questionIndex: 0, optionIds: ["1"] }, { questionIndex: 1, optionIds: ["1", "2"] }] });
    expect(gentleAskUserQuestion.fromResult(qArgs, { cancelled: true, answers: [] })).toEqual({ cancelled: true });
    expect(gentleAskUserQuestion.fromResult(qArgs, undefined)).toEqual({ cancelled: true });
  });

  async function runRegistry(args: any, tool: string, phoneAnswer: any | null, localValue?: any) {
    const { broker, of } = mkBroker();
    const reg = new AdapterRegistry(broker);
    reg.onStart({ toolCallId: "tc1", toolName: tool, args });
    expect(reg.active()).toBe(true);
    let done!: (v: unknown) => void;
    const factory = vi.fn((_t: any, _th: any, _kb: any, d: (v: unknown) => void) => {
      done = d;
      return {};
    });
    const orig = (f: any) => new Promise((resolve) => { f({}, {}, {}, (v: unknown) => resolve(v)); });
    const p = reg.race(factory, undefined, orig);
    const open = of("prompt.open")[0];
    if (phoneAnswer) broker.handleAnswer(open.promptId, phoneAnswer);
    else done(localValue);
    const v = await p;
    reg.onEnd({ toolCallId: "tc1" });
    expect(reg.active()).toBe(false);
    return { v, of, open };
  }
  it("registry: phone answers call the tool's done() with the typed result", async () => {
    const r = await runRegistry(choiceArgs, "ask_user_choice", { optionIds: ["0"] });
    expect(r.v).toEqual({ value: "tok-fast", label: "Fast", index: 1 });
    expect(r.open).toMatchObject({ kind: "select", category: "question", source: { extension: "gentle-pi", tool: "ask_user_choice" } });
    expect(r.of("prompt.ack")).toEqual([{ promptId: r.open.promptId, accepted: true }]);
    expect(r.of("prompt.resolved")).toHaveLength(0);
  });
  it("registry: terminal answers resolve the prompt as local", async () => {
    const r = await runRegistry(choiceArgs, "ask_user_choice", null, { value: "tok-safe", label: "Safe", index: 2 });
    expect(r.of("prompt.resolved")).toEqual([{ promptId: r.open.promptId, by: "local", answer: { optionIds: ["1"] } }]);
  });
  it("registry: questionnaire from the phone", async () => {
    const r: any = await runRegistry(qArgs, "ask_user_question", { answers: [{ questionIndex: 0, optionIds: ["1"] }, { questionIndex: 1, optionIds: ["0"] }] });
    expect(r.v.cancelled).toBe(false);
    expect(r.v.answers.map((a: any) => a.kind)).toEqual(["option", "multi"]);
  });
  it("registry ignores unknown tools, bad shapes, and disabled mode", () => {
    const { broker } = mkBroker();
    const reg = new AdapterRegistry(broker);
    reg.onStart({ toolCallId: "1", toolName: "other", args: {} });
    reg.onStart({ toolCallId: "2", toolName: "ask_user_choice", args: { nope: 1 } });
    expect(reg.active()).toBe(false);
    reg.enabled = false;
    reg.onStart({ toolCallId: "3", toolName: "ask_user_choice", args: choiceArgs });
    expect(reg.active()).toBe(false);
  });
});

describe("mirror", () => {
  const mk = (hasUI = true) => {
    const ui = makeUi();
    const ctx = makeCtx({ ui, hasUI });
    const { broker, of } = mkBroker();
    const statuses = new StatusTracker(() => {}, () => {});
    const adapters = new AdapterRegistry(broker);
    return { ui, ctx, broker, of, statuses, adapters };
  };
  it("patches the shared ui in place; every caller (even holding an old reference) goes through the broker", async () => {
    const { ui, ctx, broker, of, statuses, adapters } = mk();
    const held = ctx.ui; // reference saved before the patch (e.g. gentle-agents answerThroughUi)
    const origSelect = ui.select;
    const m = installMirror(ctx, broker, adapters, statuses, { dialogs: true });
    expect(m.installed).toBe(true);
    expect(ctx.ui.__rp).toBe(true);
    const p = held.select("Q?", ["a", "b"], { timeout: 99 });
    expect(of("prompt.open")).toHaveLength(1);
    expect(origSelect).toHaveBeenCalledTimes(1);
    broker.handleAnswer(of("prompt.open")[0].promptId, { optionIds: ["1"] });
    await expect(p).resolves.toBe("b");
    // local dialog got an AbortSignal merged with the caller's options
    const passed = origSelect.mock.calls[0][2];
    expect(passed.timeout).toBe(99);
    expect(passed.signal.aborted).toBe(true);
    m.uninstall();
    expect(ui.select).toBe(origSelect);
    expect(ui.__rp).toBeUndefined();
  });
  it("confirm and input are mirrored too; setStatus is observed and forwarded", async () => {
    const { ui, ctx, broker, of, statuses, adapters } = mk();
    const origSet = ui.setStatus;
    installMirror(ctx, broker, adapters, statuses, { dialogs: true });
    const c = ui.confirm("Sure?", "msg");
    const i = ui.input("Name?", "ph");
    broker.handleAnswer(of("prompt.open")[0].promptId, { confirmed: true });
    broker.handleAnswer(of("prompt.open")[1].promptId, { text: "Ann" });
    await expect(c).resolves.toBe(true);
    await expect(i).resolves.toBe("Ann");
    ui.setStatus("gentle:mode", "Permissions: AUTO");
    expect(origSet).toHaveBeenCalledWith("gentle:mode", "Permissions: AUTO");
    expect(statuses.gentleMode).toBe("auto");
  });
  it("custom() passes through unless an adapter is active", async () => {
    const { ui, ctx, broker, statuses, adapters } = mk();
    const origCustom = ui.custom;
    installMirror(ctx, broker, adapters, statuses, { dialogs: true });
    const f = (_t: any, _th: any, _k: any, done: any) => done("plain");
    await expect(ui.custom(f)).resolves.toBe("plain");
    expect(origCustom).toHaveBeenCalledTimes(1);
  });
  it("never touches the no-op ui of print/json modes", () => {
    const { ui, ctx, broker, statuses, adapters } = mk(false);
    const before = { ...ui };
    expect(installMirror(ctx, broker, adapters, statuses, { dialogs: true }).installed).toBe(false);
    expect(ui.select).toBe(before.select);
    expect(ui.__rp).toBeUndefined();
  });
  it("is idempotent and only observes statuses when dialogs are disabled", () => {
    const { ui, ctx, broker, statuses, adapters } = mk();
    const origSelect = ui.select;
    const first = installMirror(ctx, broker, adapters, statuses, { dialogs: false });
    expect(first.installed).toBe(true);
    expect(ui.select).toBe(origSelect);
    expect(installMirror(ctx, broker, adapters, statuses, { dialogs: true }).installed).toBe(false);
  });
  it("compat check: if ctx.ui is a getter returning copies, the mirror disables itself and warns once", () => {
    const real = makeUi();
    const ctx: any = { hasUI: true, mode: "tui", get ui() { return { ...real }; } };
    const { broker, statuses, adapters } = mk();
    const r = installMirror(ctx, broker, adapters, statuses, { dialogs: true });
    expect(r.installed).toBe(false);
  });
});

describe("gate", () => {
  const cfg = { ...baseConfig("x").gate, dangerousPatterns: ["\\brm\\s+-[a-z]*r", "\\bsudo\\b", "\\bgit\\s+push\\b.*--force"] };
  const patterns = compilePatterns(cfg.dangerousPatterns);
  it("auto-detect: off with gentle-pi, dangerous without", () => {
    expect(effectiveMode("auto-detect", true)).toBe("off");
    expect(effectiveMode("auto-detect", false)).toBe("dangerous");
    expect(effectiveMode("all", true)).toBe("all");
  });
  it("decide: dangerous commands, always-allow tools, modes", () => {
    expect(decide("dangerous", cfg, patterns, "bash", { command: "rm -rf build" }).ask).toBe(true);
    expect(decide("dangerous", cfg, patterns, "bash", { command: "rm -rf build" }).danger).toBe("high");
    expect(decide("dangerous", cfg, patterns, "bash", { command: "ls -la" }).ask).toBe(false);
    expect(decide("dangerous", cfg, patterns, "write", { path: "a" }).ask).toBe(false);
    expect(decide("writes", cfg, patterns, "write", { path: "a" })).toMatchObject({ ask: true, danger: "medium" });
    expect(decide("writes", cfg, patterns, "bash", { command: "ls" }).ask).toBe(true);
    expect(decide("writes", cfg, patterns, "read", { path: "a" }).ask).toBe(false);
    expect(decide("all", cfg, patterns, "custom", {}).ask).toBe(true);
    expect(decide("all", cfg, patterns, "grep", {}).ask).toBe(false);
    expect(decide("off", cfg, patterns, "bash", { command: "sudo reboot" }).ask).toBe(false);
  });
  it("annotations: destructiveHint asks, readOnlyHint tools are not 'writes'", () => {
    expect(decide("dangerous", cfg, patterns, "mcp_del", {}, { annotations: { destructiveHint: true } }).ask).toBe(true);
    expect(decide("dangerous", cfg, patterns, "mcp_del", {}, { annotations: { destructiveHint: true } }).danger).toBe("high");
    expect(decide("dangerous", { ...cfg, useAnnotations: false }, patterns, "mcp_del", {}, { annotations: { destructiveHint: true } }).ask).toBe(false);
    expect(decide("writes", cfg, patterns, "mcp_get", {}, { annotations: { readOnlyHint: true } }).ask).toBe(false);
    expect(decide("writes", cfg, patterns, "mcp_set", {}, { annotations: { readOnlyHint: false } }).ask).toBe(true);
  });
  it("powershell is treated like bash; keys and summaries", () => {
    expect(decide("dangerous", cfg, patterns, "powershell", { command: "sudo x" }).ask).toBe(true);
    expect(allowKey("bash", { command: "  git push --force" })).toBe("bash:git");
    expect(allowKey("bash", { command: "echo $(rm -rf /)" })).toBe("bash:echo $(rm -rf /)");
    expect(allowKey("bash", { command: "echo `id`" })).toBe("bash:echo `id`");
    expect(allowKey("bash", { command: "echo hi > /etc/passwd" })).toBe("bash:echo hi > /etc/passwd");
    expect(allowKey("bash", { command: "cat < /etc/shadow" })).toBe("bash:cat < /etc/shadow");
    expect(allowKey("write", { path: "x" })).toBe("write");
    expect(summarize("bash", { command: "ls" })).toBe("ls");
    expect(summarize("write", { path: "/a/b" })).toBe("/a/b");
    expect(summarize("x", { big: "y".repeat(1000) }).length).toBeLessThanOrEqual(300);
  });
  it("invalid regex patterns are skipped", () => {
    expect(compilePatterns(["(", "ok"])).toHaveLength(1);
  });

  function mkGate(mode: any, answers: Array<string | undefined>, over: any = {}) {
    const asked: any[] = [];
    const persisted: string[] = [];
    const g = new Gate({
      mode: () => mode,
      cfg: () => cfg,
      hasApprover: () => true,
      askSelect: async (title, options) => {
        asked.push({ title, options, ctx: promptContext.getStore() });
        return answers.shift();
      },
      askInput: async () => answers.shift(),
      toolInfo: () => undefined,
      persistAllow: (k) => persisted.push(k),
      allowed: new Set<string>(),
      ...over,
    });
    return { g, asked, persisted };
  }
  it("Permitir lets it through; the dialog runs inside the permission context", async () => {
    const { g, asked } = mkGate("dangerous", [ALLOW]);
    expect(await g.onToolCall({ toolName: "bash", input: { command: "rm -rf dist" } })).toBeUndefined();
    expect(asked[0].options).toEqual([ALLOW, ALLOW_SESSION, DENY, DENY_REASON]);
    expect(asked[0].ctx).toMatchObject({ category: "permission", danger: "high", tool: { name: "bash" } });
    expect(asked[0].title).toContain("rm -rf dist");
  });
  it("Permitir siempre en esta sesión persists and does not let benign prefixes bypass high-danger commands", async () => {
    const { g, asked, persisted } = mkGate("writes", [ALLOW_SESSION, DENY]);
    expect(await g.onToolCall({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
    expect(await g.onToolCall({ toolName: "bash", input: { command: "git diff" } })).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(persisted).toEqual(["bash:git"]);
    expect(await g.onToolCall({ toolName: "bash", input: { command: "git push --force" } })).toEqual({ block: true, reason: "Denegado por el usuario" });
    expect(asked).toHaveLength(2);
    const dGate = mkGate("dangerous", [ALLOW_SESSION, DENY]);
    expect(await dGate.g.onToolCall({ toolName: "bash", input: { command: "sudo ls" } })).toBeUndefined();
    expect(await dGate.g.onToolCall({ toolName: "bash", input: { command: "sudo ls" } })).toBeUndefined();
    expect(dGate.persisted).toEqual(["bash:sudo ls"]);
    expect(await dGate.g.onToolCall({ toolName: "bash", input: { command: "sudo reboot" } })).toEqual({ block: true, reason: "Denegado por el usuario" });
  });
  it("Denegar / cancel / Denegar con motivo block", async () => {
    expect(await mkGate("dangerous", [DENY]).g.onToolCall({ toolName: "bash", input: { command: "rm -rf /" } })).toEqual({ block: true, reason: "Denegado por el usuario" });
    expect(await mkGate("dangerous", [undefined]).g.onToolCall({ toolName: "bash", input: { command: "rm -rf /" } })).toMatchObject({ block: true });
    const r = await mkGate("dangerous", [DENY_REASON, "too risky"]).g.onToolCall({ toolName: "bash", input: { command: "rm -rf /" } });
    expect(r).toEqual({ block: true, reason: "Denegado por el usuario: too risky" });
  });
  it("fail-safe: no UI and no relay → block without asking", async () => {
    const { g, asked } = mkGate("dangerous", [ALLOW], { hasApprover: () => false });
    expect(await g.onToolCall({ toolName: "bash", input: { command: "rm -rf /" } })).toMatchObject({ block: true });
    expect(asked).toHaveLength(0);
  });
  it("safe calls and mode off are untouched", async () => {
    const { g, asked } = mkGate("dangerous", []);
    expect(await g.onToolCall({ toolName: "bash", input: { command: "ls" } })).toBeUndefined();
    expect(await mkGate("off", []).g.onToolCall({ toolName: "bash", input: { command: "rm -rf /" } })).toBeUndefined();
    expect(asked).toHaveLength(0);
  });
  it("allowed keys are rebuilt from the session branch", () => {
    const s = allowedFromBranch([{ type: "custom", customType: "rp.allow", data: { key: "bash:sudo" } }, { type: "custom", customType: "other", data: { key: "x" } }, { type: "message" }]);
    expect([...s]).toEqual(["bash:sudo"]);
  });
});

describe("rp_ask_user", () => {
  it("is only registered when no ask_user*/question* tool exists", () => {
    expect(shouldRegisterAskUser(["bash", "read"])).toBe(true);
    expect(shouldRegisterAskUser(["bash", "ask_user_question"])).toBe(false);
    expect(shouldRegisterAskUser(["question"])).toBe(false);
  });
  const mkDeps = (sel: Array<string | undefined>, inp: Array<string | undefined>) => ({
    askSelect: vi.fn(async () => sel.shift()),
    askInput: vi.fn(async () => inp.shift()),
  });
  it("options, free text via 'Otra respuesta…', plain input and cancel", async () => {
    expect(await runAskUser(mkDeps(["b"], []), { question: "q", options: ["a", "b"] })).toEqual({ cancelled: false, answer: "b" });
    const d = mkDeps(["Otra respuesta…"], ["mine"]);
    expect(await runAskUser(d, { question: "q", options: ["a"], allowFreeText: true })).toEqual({ cancelled: false, answer: "mine", custom: true });
    expect(d.askSelect).toHaveBeenCalledWith("q", ["a", "Otra respuesta…"]);
    expect(await runAskUser(mkDeps([], ["typed"]), { question: "q" })).toEqual({ cancelled: false, answer: "typed", custom: true });
    expect(await runAskUser(mkDeps([undefined], []), { question: "q", options: ["a"] })).toEqual({ cancelled: true });
  });
  it("tool definition executes through the deps and reports unavailability", async () => {
    const def = askUserToolDefinition(() => mkDeps(["a"], []));
    expect(def.name).toBe("rp_ask_user");
    const r = await def.execute("id", { question: "q", options: ["a", "b"] });
    expect(r.content[0]!.text).toBe("User answered: a");
    const none = await askUserToolDefinition(() => null).execute("id", { question: "q" });
    expect(none.details).toEqual({ unavailable: true });
  });
});
