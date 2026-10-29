import { describe, expect, it, vi } from "vitest";
import { Broker } from "../src/extension/prompts/broker.ts";
import { AdapterRegistry, BUILTIN_ADAPTERS, gentleAskUserChoice, reviewConsent } from "../src/extension/prompts/adapters/index.ts";
import { Classifier } from "../src/extension/prompts/classify.ts";

const ACTIONS = [
  "1. Review this change\nEffect: reviews the frozen candidate",
  "2. Skip this time\nEffect: skips this candidate",
  "3. Review and allow this session\nEffect: allows later reviews in this session",
];
const ACTIONS_FOOTER = "↑↓ choose · Enter confirm · Esc cancel · D details";
const DETAILS_FOOTER = "PgUp/PgDn · D return · Esc";

function makeComponent(over: { missingRender?: boolean; actions?: string[]; missingDetails?: boolean; unstableRestore?: boolean } = {}) {
  let mode: "actions" | "details" = "actions";
  let actionRenders = 0;
  const renders: Array<{ width: number; lines: string[] }> = [];
  const component: any = {
    getActionOptions: () => over.actions ?? ACTIONS,
    handleInput: (key: string) => {
      if (key.toLowerCase() === "d") mode = mode === "actions" ? "details" : "actions";
    },
    render: (width: number) => {
      const lines = mode === "actions"
        ? ["\u001b[1mReview consent\u001b[0m", "Gentle AI can review this change", "Reason: inspect the patch", "1. Review this change", "2. Skip this time", "3. Review and allow this session", ...(over.unstableRestore && actionRenders++ > 0 ? ["Changed after details toggle"] : []), ACTIONS_FOOTER]
        : over.missingDetails
          ? ["Different details title", "Value: frozen candidate", DETAILS_FOOTER]
          : ["Details (read-only)", "Provider headline: Gentle AI can review this change", "Reason: inspect the patch", "Value: frozen candidate", "Risk: medium", "Target: current repository", "Projection: one review", "Risk evidence:", "- changed files were validated", "Off-path note: no other changes", DETAILS_FOOTER];
      renders.push({ width, lines });
      return lines;
    },
  };
  if (over.missingRender) delete component.render;
  return { component, renders };
}

function makePagedComponent() {
  let mode: "actions" | "details" = "actions";
  let offset = 0;
  const pageSize = 3;
  const details = [
    "Provider headline: Review candidate",
    "Reason: compare the changes",
    "Value: current candidate",
    "Risk: high",
    "Target: current repository",
    "Projection: provider review only",
    "Risk evidence:",
    "- evidence item one",
    "- evidence item two",
    "Off-path note: no unrelated paths",
  ];
  const renders: Array<{ width: number; lines: string[] }> = [];
  const component = {
    getActionOptions: () => ACTIONS,
    handleInput(key: string) {
      if (key.toLowerCase() === "d") {
        mode = mode === "actions" ? "details" : "actions";
        offset = 0;
      } else if (mode === "details" && key === "\u001b[6~") {
        offset = Math.min(details.length - pageSize, offset + pageSize - 1);
      }
    },
    render(width: number) {
      const lines = mode === "actions"
        ? ["Review consent", "1. Review this change", "2. Skip this time", "3. Review and allow this session", ACTIONS_FOOTER]
        : ["Details (read-only)", ...details.slice(offset, offset + pageSize), DETAILS_FOOTER];
      renders.push({ width, lines });
      return lines;
    },
  };
  return { component, details, renders };
}

function setup(adapter: any = reviewConsent) {
  const sent: Array<[string, any]> = [];
  const broker = new Broker({
    agentId: "M:S",
    send: (type, body) => sent.push([type, body]),
    hasUI: true,
    classifier: new Classifier(),
    herdr: null,
  });
  const registry = new AdapterRegistry(broker, [adapter]);
  registry.onStart({ toolCallId: "tc1", toolName: adapter.tool, args: { operation: "start" } });
  const of = (type: string) => sent.filter(([t]) => t === type).map(([, body]) => body);
  return { broker, registry, of };
}

function factoryFor(component: unknown, onDone: (done: (value: unknown) => void) => void) {
  return (_tui: unknown, _theme: unknown, _kb: unknown, done: (value: unknown) => void) => {
    onDone(done);
    return component;
  };
}

describe("gentle_review component mirror", () => {
  it("registers the gentle_review adapter", () => {
    expect(BUILTIN_ADAPTERS).toContain(reviewConsent);
  });

  it("emits the fixed, lossless prompt and restores the mounted actions screen byte-for-byte", async () => {
    const { broker, registry, of } = setup();
    const { component, renders } = makeComponent();
    let capturedDone!: (value: unknown) => void;
    const runOrig = (factory: (...args: any[]) => any) => new Promise((resolve) => {
      factory({ terminal: { columns: 173 } }, {}, {}, (value: unknown) => resolve(value));
    });
    const p = registry.customMirror(factoryFor(component, (done) => { capturedDone = done; }), undefined, runOrig);
    const [open] = of("prompt.open");

    expect(open).toMatchObject({
      kind: "select",
      category: "permission",
      danger: "high",
      title: "Review consent",
      options: [
        { id: "0", label: "Review this change", description: "Effect: reviews the frozen candidate" },
        { id: "1", label: "Skip this time", description: "Effect: skips this candidate" },
        { id: "2", label: "Review and allow this session", description: "Effect: allows later reviews in this session" },
      ],
    });
    expect(open.message).toBe([
      "Review consent",
      "Gentle AI can review this change",
      "Reason: inspect the patch",
      "1. Review this change",
      "2. Skip this time",
      "3. Review and allow this session",
      "Provider headline: Gentle AI can review this change",
      "Reason: inspect the patch",
      "Value: frozen candidate",
      "Risk: medium",
      "Target: current repository",
      "Projection: one review",
      "Risk evidence:",
      "- changed files were validated",
      "Off-path note: no other changes",
    ].join("\n"));
    expect(renders.map((r) => r.width)).toEqual([80, 80, 80, 80, 80]);
    expect(renders[0]!.lines.join("\n")).toBe(renders.at(-1)!.lines.join("\n"));

    expect(broker.handleAnswer(open.promptId, { optionIds: ["0"] })).toBe(true);
    await expect(p).resolves.toEqual({ kind: "provider", answer: "granted" });
    expect(capturedDone).toBeTypeOf("function");
  });

  it("collects every scrollable details page in order and restores the actions screen", async () => {
    const { broker, registry, of } = setup();
    const { component, details, renders } = makePagedComponent();
    const p = registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => resolve(value));
    }));
    const [open] = of("prompt.open");
    const actionBlock = ["Review consent", "1. Review this change", "2. Skip this time", "3. Review and allow this session"].join("\n");
    expect(open.message).toBe(`${actionBlock}\n${details.join("\n")}`);
    expect(renders.every((r) => r.width === 80)).toBe(true);
    expect(renders[0]!.lines.join("\n")).toBe(renders.at(-1)!.lines.join("\n"));
    broker.handleAnswer(open.promptId, { optionIds: ["0"] });
    await p;
  });

  it.each([
    ["0", { kind: "provider", answer: "granted" }],
    ["1", { kind: "provider", answer: "declined" }],
    ["2", { kind: "host-session" }],
  ])("routes remote option %s through done with the canonical consent result", async (id, expected) => {
    const { broker, registry, of } = setup();
    const { component } = makeComponent();
    let done!: (value: unknown) => void;
    let doneCalls = 0;
    const p = registry.customMirror(factoryFor(component, (d) => { done = d; }), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => { doneCalls++; resolve(value); });
    }));
    const [open] = of("prompt.open");
    broker.handleAnswer(open.promptId, { optionIds: [id] });
    await expect(p).resolves.toEqual(expected);
    expect(done).toBeTypeOf("function");
    expect(doneCalls).toBe(1);
    expect(broker.openCount).toBe(0);
    expect(broker.handleAnswer(open.promptId, { optionIds: ["2"] })).toBe(false);
    expect(of("prompt.ack")).toEqual([
      { promptId: open.promptId, accepted: true },
      { promptId: open.promptId, accepted: false },
    ]);
    expect(of("prompt.resolved")).toHaveLength(0);
    component.render(80);
    expect(of("prompt.open")).toHaveLength(1);
  });

  it("maps a remote cancelled answer to done(undefined)", async () => {
    const { broker, registry, of } = setup();
    const { component } = makeComponent();
    const done = vi.fn((value: unknown) => value);
    const p = registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => { done(value); resolve(value); });
    }));
    const [open] = of("prompt.open");
    broker.handleAnswer(open.promptId, { cancelled: true });
    await expect(p).resolves.toBeUndefined();
    expect(done).toHaveBeenCalledWith(undefined);
    expect(of("prompt.ack")).toEqual([{ promptId: open.promptId, accepted: true }]);
  });

  it("uses the actions-only terminal-visible fallback when restoration cannot be proven, without rendering details", async () => {
    const { broker, registry, of } = setup();
    const { component, renders } = makeComponent({ unstableRestore: true });
    const p = registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => resolve(value));
    }));
    const [open] = of("prompt.open");
    expect(renders).toHaveLength(2);
    expect(renders.every((r) => r.lines[0]?.includes("Review consent"))).toBe(true);
    expect(open.message).toContain("Value, risk and evidence are visible on the terminal.");
    expect(open.message).not.toContain("Value: frozen candidate");
    broker.handleAnswer(open.promptId, { optionIds: ["0"] });
    await p;
  });

  it.each([
    ["missing render", { missingRender: true }],
    ["two actions", { actions: ACTIONS.slice(0, 2) }],
    ["missing details screen", { missingDetails: true }],
  ])("passes through %s without a prompt or a synthetic done call", async (_label, shape) => {
    const { registry, of } = setup();
    const { component } = makeComponent(shape as any);
    const done = vi.fn();
    const result = await registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => {
      factory({}, {}, {}, done);
      return Promise.resolve("terminal result");
    });
    expect(result).toBe("terminal result");
    expect(done).not.toHaveBeenCalled();
    expect(of("prompt.open")).toHaveLength(0);
    expect(of("prompt.ack")).toHaveLength(0);
    expect(of("prompt.resolved")).toHaveLength(0);
  });

  it("retires the prompt when the terminal wins and ignores a later phone answer", async () => {
    const { broker, registry, of } = setup();
    const { component } = makeComponent();
    let finish!: (value: unknown) => void;
    const p = registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => {
      factory({}, {}, {}, () => {});
      return new Promise((resolve) => { finish = (value) => resolve(value); });
    });
    const [open] = of("prompt.open");
    finish({ kind: "provider", answer: "declined" });
    await expect(p).resolves.toEqual({ kind: "provider", answer: "declined" });
    expect(of("prompt.resolved")).toEqual([{ promptId: open.promptId, by: "local", answer: { optionIds: ["1"] } }]);
    expect(broker.openCount).toBe(0);
    expect(broker.handleAnswer(open.promptId, { optionIds: ["0"] })).toBe(false);
    expect(of("prompt.ack")).toEqual([{ promptId: open.promptId, accepted: false }]);
  });

  it("posts only one prompt for a repeated encounter of the same component identity", async () => {
    const { broker, registry, of } = setup();
    const { component } = makeComponent();
    const run = () => registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => resolve(value));
    }));
    const first = run();
    const [open] = of("prompt.open");
    broker.handleAnswer(open.promptId, { optionIds: ["0"] });
    await first;
    await registry.customMirror(factoryFor(component, () => {}), undefined, (factory) => {
      factory({}, {}, {}, () => {});
      return Promise.resolve("terminal retry");
    });
    expect(of("prompt.open")).toHaveLength(1);
  });

  it("keeps the existing ask_user_choice registry path", async () => {
    const args = { question: "Pick", options: [{ label: "A", value: "a", description: "first" }, { label: "B", value: "b", description: "second" }] };
    const { broker, registry, of } = setup(gentleAskUserChoice);
    registry.onStart({ toolCallId: "choice", toolName: "ask_user_choice", args });
    const p = registry.race((_t: unknown, _th: unknown, _kb: unknown, done: (value: unknown) => void) => ({}), undefined, (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (value: unknown) => resolve(value));
    }));
    const [open] = of("prompt.open");
    expect(open).toMatchObject({ kind: "select", title: "Pick", options: [{ id: "0", label: "A" }, { id: "1", label: "B" }] });
    broker.handleAnswer(open.promptId, { optionIds: ["1"] });
    await expect(p).resolves.toEqual({ value: "b", label: "B", index: 2 });
  });
});
