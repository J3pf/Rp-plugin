// End-to-end against a REAL Pi 1.2.0 TUI running inside tmux (spikes S1 / S4 / S7 on Linux),
// with real gentle-pi 4.1.0 tools, an in-memory relay and a scripted fake model.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRelay, baseConfig, waitUntil } from "./helpers.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const root = path.resolve(import.meta.dirname, "..");
const CLI = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

class Tui {
  constructor(public name: string) {}
  screen(): string {
    try {
      return execFileSync("tmux", ["capture-pane", "-p", "-t", this.name], { encoding: "utf8" });
    } catch {
      return "";
    }
  }
  keys(...k: string[]) {
    execFileSync("tmux", ["send-keys", "-t", this.name, ...k]);
  }
  literal(text: string) {
    execFileSync("tmux", ["send-keys", "-t", this.name, "-l", text]);
  }
  async waitScreen(re: RegExp | string, ms = 20000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      const s = this.screen();
      if (typeof re === "string" ? s.includes(re) : re.test(s)) return s;
      if (Date.now() - t0 > ms) throw new Error(`screen never matched ${re}\n--- screen ---\n${s}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async waitGone(re: RegExp | string, ms = 20000) {
    const t0 = Date.now();
    for (;;) {
      const s = this.screen();
      if (!(typeof re === "string" ? s.includes(re) : re.test(s))) return;
      if (Date.now() - t0 > ms) throw new Error(`screen still matches ${re}\n--- screen ---\n${s}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  alive(): boolean {
    return spawnSync("tmux", ["has-session", "-t", this.name]).status === 0;
  }
  kill() {
    spawnSync("tmux", ["kill-session", "-t", this.name]);
  }
}

let relay: FakeRelay;
let tmp: string;
let tui: Tui | undefined;
let seq = 0;

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-e2e-"));
  fs.mkdirSync(path.join(tmp, "agent"));
  fs.mkdirSync(path.join(tmp, "cwd"));
});
afterEach(async () => {
  tui?.kill();
  tui = undefined;
  await relay.stop();
});

function launch(script: any[], opts: { cfg?: Record<string, any>; extensions?: string[]; tools?: string[]; env?: Record<string, string>; sessionId?: string } = {}): Tui {
  fs.writeFileSync(path.join(tmp, "script.json"), JSON.stringify(script));
  fs.writeFileSync(path.join(tmp, "rp.json"), JSON.stringify(baseConfig(relay.url, opts.cfg)));
  const name = `rpe2e${process.pid}x${seq++}`;
  const exts = [path.join(root, "src/extension/index.ts"), path.join(root, "test/fixtures/faux-ext.ts"), path.join(root, "test/fixtures/input-probe-ext.ts"), ...(opts.extensions ?? [])];
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
    FAUX_SCRIPT: path.join(tmp, "script.json"),
    FAUX_LOG: path.join(tmp, "faux.log"),
    INPUT_LOG: path.join(tmp, "input.log"),
    RP_CONFIG: path.join(tmp, "rp.json"),
    PI_OFFLINE: "1",
    ...opts.env,
  };
  const cmd =
    `env ${Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(" ")} node ${CLI} --no-extensions ${exts.map((e) => `-e '${e}'`).join(" ")} ` +
    `--model faux/faux-1 --api-key k ${opts.sessionId ? `--session-id ${opts.sessionId}` : "--no-session"} --no-skills --no-themes --no-prompt-templates --no-context-files --no-mcp --tools bash,read${(opts.tools ?? []).map((t) => `,${t}`).join("")}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-x", "170", "-y", "50", "-c", path.join(tmp, "cwd"), cmd]);
  return new Tui(name);
}

const fauxLog = () => (fs.existsSync(path.join(tmp, "faux.log")) ? fs.readFileSync(path.join(tmp, "faux.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const inputLog = () => (fs.existsSync(path.join(tmp, "input.log")) ? fs.readFileSync(path.join(tmp, "input.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe.skipIf(!hasTmux)("real Pi TUI in tmux", () => {
  it("S1: a gate dialog shown in the real TUI is closed when the phone answers first", async () => {
    tui = launch([{ tool: "bash", args: { command: "rm -rf /tmp/rp-e2e-nonexistent-dir" } }, { text: "terminé sin problemas" }]);
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000, "hello");
    expect(relay.of("agent.hello")[0]!.d.pi.mode).toBe("tui");
    relay.push("user.message", { clientMsgId: "e2e-1", text: "borra ese directorio", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000, "prompt.open");
    expect(open.d).toMatchObject({ category: "permission", danger: "high" });
    await tui.waitScreen("rp-e2e-nonexistent-dir"); // the local TUI dialog is visible too
    await tui.waitScreen("Permitir siempre en esta sesión");
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["0"] }, deviceId: "dev" });
    await tui.waitScreen("terminé sin problemas"); // the tool ran and the turn continued
    await tui.waitGone("Permitir siempre en esta sesión", 5000); // dialog closed by the AbortSignal
    expect(relay.of("prompt.ack")[0]!.d).toEqual({ promptId: open.d.promptId, accepted: true });
  }, 60000);

  it("S1: answering in the terminal first resolves the phone prompt as 'local'", async () => {
    tui = launch([{ tool: "bash", args: { command: "rm -rf /tmp/rp-e2e-nonexistent-dir" } }, { text: "hecho localmente" }]);
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-2", text: "borra", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000);
    await tui.waitScreen("Permitir siempre en esta sesión");
    tui.keys("Enter"); // first option: Permitir
    await tui.waitScreen("hecho localmente");
    const resolved = await waitUntil(() => relay.of("prompt.resolved")[0], 5000);
    expect(resolved.d).toEqual({ promptId: open.d.promptId, by: "local", answer: { optionIds: ["0"] } });
    // a late phone answer is rejected
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["2"] } });
    await waitUntil(() => relay.of("prompt.ack").some((a) => a.d.accepted === false), 5000);
  }, 60000);

  it("S1: denying from the phone blocks the command and the model sees the denial", async () => {
    tui = launch([{ tool: "bash", args: { command: "sudo reboot" } }, { text: "no lo hago" }]);
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-3", text: "reinicia", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000);
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["2"] } });
    await tui.waitScreen("no lo hago");
    const second = fauxLog().find((l) => l.call === 2)!;
    expect(second.lastMessage).toContain("Denegado por el usuario");
  }, 60000);

  it("S4: real gentle-pi ask_user_question (custom() TUI dialog) is answered from the phone through the adapter", async () => {
    const ask = {
      questions: [
        { question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "relational" }, { label: "SQLite", description: "embedded" }] },
        { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Auth", description: "login" }, { label: "Billing", description: "pay" }, { label: "Search", description: "find" }] },
      ],
    };
    tui = launch([{ tool: "ask_user_question", args: ask }, { text: "gracias por las respuestas" }], { extensions: [path.join(root, "node_modules/gentle-pi/extensions/ask-user-question.ts")], tools: ["ask_user_question"], cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    expect(relay.of("agent.hello")[0]!.d.plugin.features).toContain("adapters:gentle-ask");
    relay.push("user.message", { clientMsgId: "e2e-4", text: "pregúntame", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000, "questionnaire prompt");
    expect(open.d).toMatchObject({ kind: "questionnaire", category: "question", source: { extension: "gentle-pi", tool: "ask_user_question" } });
    expect(open.d.questions).toHaveLength(2);
    await tui.waitScreen("Type something."); // the real questionnaire (with its free-text row) is on screen
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { answers: [{ questionIndex: 0, optionIds: ["1"] }, { questionIndex: 1, optionIds: ["0", "2"] }] } });
    await tui.waitScreen("gracias por las respuestas");
    await tui.waitGone("Type something.", 5000); // dialog closed by the adapter's done()
    const second = fauxLog().find((l) => l.call === 2)!;
    expect(second.lastMessage).toContain("1. Which database? — SQLite");
    expect(second.lastMessage).toContain("2. Which features? — selected: Auth, Search");
    // no "waiting on terminal" noise for an adapted dialog
    expect(relay.of("agent.event").map((e) => e.d.e.type)).not.toContain("terminal_wait");
  }, 60000);

  it("S4: real gentle-pi ask_user_choice answered from the phone (and custom response)", async () => {
    const args = { question: "Cómo seguimos?", options: [{ label: "Rápido", description: "r", value: "fast" }, { label: "Seguro", description: "s", value: "safe" }], allowCustomResponse: true };
    tui = launch([{ tool: "ask_user_choice", args }, { text: "ok choice" }], { extensions: [path.join(root, "node_modules/gentle-pi/extensions/ask-user-choice.ts")], tools: ["ask_user_choice"], cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-5", text: "elige", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000);
    expect(open.d).toMatchObject({ kind: "select", allowFreeText: true });
    await tui.waitScreen("Cómo seguimos?");
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { text: "a mi manera" } });
    await tui.waitScreen("ok choice");
    expect(fauxLog().find((l) => l.call === 2)!.lastMessage).toContain("User responded: a mi manera");
  }, 60000);

  it("S7: interactive delivery types into the real TUI; Pi sees source 'interactive'", async () => {
    tui = launch([{ text: "te escuché" }], { cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-6", deviceId: "dev", text: "hola desde el móvil\nsegunda línea", method: "interactive" });
    await waitUntil(() => relay.of("user.message.ack")[0], 15000, "ack");
    expect(relay.of("user.message.ack")[0]!.d).toEqual({ clientMsgId: "e2e-6", disposition: "typed", method: "interactive", error: null });
    await tui.waitScreen("te escuché");
    expect(inputLog()).toEqual([{ source: "interactive", text: "hola desde el móvil\nsegunda línea" }]);
    expect(fauxLog()[0]!.lastMessage).toContain("hola desde el móvil");
  }, 60000);

  it("S7: the local editor draft survives an interactive delivery", async () => {
    tui = launch([{ text: "respuesta" }], { cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    tui.literal("borrador sin enviar");
    await tui.waitScreen("borrador sin enviar");
    relay.push("user.message", { clientMsgId: "e2e-7", text: "mensaje remoto", method: "interactive" });
    await waitUntil(() => relay.of("user.message.ack")[0], 15000);
    expect(relay.of("user.message.ack")[0]!.d.disposition).toBe("typed");
    await tui.waitScreen("respuesta");
    await new Promise((r) => setTimeout(r, 400));
    expect(tui.screen()).toContain("borrador sin enviar"); // restored into the editor
    expect(inputLog().map((i) => i.text)).toEqual(["mensaje remoto"]); // the draft was not submitted with it
  }, 60000);

  it("S7: while a dialog is open the message waits and is acked typed_after_dialog", async () => {
    tui = launch([{ tool: "bash", args: { command: "rm -rf /tmp/rp-e2e-nonexistent-dir" } }, { text: "primer turno listo" }, { text: "segundo turno listo" }]);
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-8a", text: "borra", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000);
    await tui.waitScreen("Permitir siempre en esta sesión");
    relay.push("user.message", { clientMsgId: "e2e-8b", text: "y luego esto", method: "interactive", delivery: "followUp" });
    await new Promise((r) => setTimeout(r, 800));
    expect(relay.of("user.message.ack").filter((a) => a.d.clientMsgId === "e2e-8b")).toHaveLength(0); // still waiting
    expect(inputLog().filter((i) => i.source === "interactive")).toHaveLength(0); // nothing typed while the dialog is open
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["0"] } });
    await tui.waitScreen("segundo turno listo", 30000);
    const ack = relay.of("user.message.ack").find((a) => a.d.clientMsgId === "e2e-8b")!;
    expect(ack.d).toMatchObject({ disposition: "typed_after_dialog", method: "interactive", error: null });
    expect(inputLog().filter((i) => i.source === "interactive")).toEqual([{ source: "interactive", text: "y luego esto" }]);
  }, 90000);

  it("S5 (stand-in herdr CLI): delivery 'herdr' runs `herdr agent prompt <pane> <text>` without a shell and Pi sees it as typed", async () => {
    // The real herdr cannot be built offline here, so a tiny CLI with the documented contract types into the pane via tmux.
    const bin = path.join(tmp, "fakebin");
    fs.mkdirSync(bin);
    const argLog = path.join(tmp, "herdr-args.log");
    fs.writeFileSync(
      path.join(bin, "herdr"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argLog}'\nif [ "$1" = agent ] && [ "$2" = prompt ]; then\n  tmux send-keys -t "$3" -l "$4" && tmux send-keys -t "$3" Enter\n  exit 0\nfi\nexit 2\n`,
      { mode: 0o755 },
    );
    const sessionName = `rpe2e${process.pid}x${seq}`; // launch() will use seq++ for the same name
    tui = launch([{ text: "recibido por herdr" }], { cfg: { gate: { mode: "off" } }, env: { PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: sessionName, HERDR_TAB_ID: "t1", HERDR_WORKSPACE_ID: "w1" } });
    expect(tui.name).toBe(sessionName);
    await tui.waitScreen("faux-1");
    const hello = await waitUntil(() => relay.of("agent.hello")[0], 15000);
    expect(hello.d.herdr).toEqual({ paneId: sessionName, tabId: "t1", workspaceId: "w1", session: null });
    relay.push("user.message", { clientMsgId: "e2e-h", text: "hola; echo $(whoami) `id`", method: "herdr" });
    await waitUntil(() => relay.of("user.message.ack")[0], 15000);
    expect(relay.of("user.message.ack")[0]!.d).toEqual({ clientMsgId: "e2e-h", disposition: "typed", method: "herdr", error: null });
    await tui.waitScreen("recibido por herdr");
    expect(inputLog()).toEqual([{ source: "interactive", text: "hola; echo $(whoami) `id`" }]); // metacharacters stayed literal
    expect(fs.readFileSync(argLog, "utf8")).toContain(`agent prompt ${sessionName} hola; echo $(whoami) \`id\``);
  }, 60000);

  it("H5: restarting Pi on the same session keeps the agentId (history continues) with a new instance and epoch", async () => {
    tui = launch([{ text: "primera vida" }], { sessionId: "e2e-resume-1", cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    const h1 = await waitUntil(() => relay.of("agent.hello")[0], 15000);
    relay.push("user.message", { clientMsgId: "r-1", text: "hola", method: "api" });
    await tui.waitScreen("primera vida");
    tui.kill(); // the process dies (e.g. herdr/terminal restarted)
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3, 10000, "old socket closed");
    tui = launch([{ text: "segunda vida" }], { sessionId: "e2e-resume-1", cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    const h2 = await waitUntil(() => relay.of("agent.hello")[1], 15000);
    expect(h2.d.agentId).toBe(h1.d.agentId);
    expect(h2.d.instance).not.toBe(h1.d.instance);
    expect(h2.d.epoch).not.toBe(h1.d.epoch);
    // the resumed session's transcript is in the snapshot
    const snap = await waitUntil(() => relay.of("agent.snapshot")[1], 10000, "second snapshot");
    expect(JSON.stringify(snap.d.entries)).toContain("primera vida");
  }, 60000);

  it("agent.abort interrupts a running tool in the real TUI", async () => {
    tui = launch([{ tool: "bash", args: { command: "sleep 60" } }, { text: "nunca" }], { cfg: { gate: { mode: "off" } } });
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-9", text: "duerme", method: "api" });
    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "tool_execution_start"), 20000);
    relay.push("agent.abort", {});
    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled" && e.d.e.aborted === true), 20000, "aborted settle");
    expect(fauxLog().some((l) => l.step.text === "nunca")).toBe(false);
  }, 60000);

  it("quitting Pi closes the relay connection and cancels pending prompts (session_shutdown)", async () => {
    tui = launch([{ tool: "bash", args: { command: "rm -rf /tmp/rp-e2e-nonexistent-dir" } }]);
    await tui.waitScreen("faux-1");
    await waitUntil(() => relay.of("agent.hello").length === 1, 15000);
    relay.push("user.message", { clientMsgId: "e2e-10", text: "borra", method: "api" });
    await waitUntil(() => relay.of("prompt.open")[0], 20000);
    await tui.waitScreen("Permitir siempre en esta sesión");
    tui.keys("Escape"); // cancel the dialog locally → denied
    await waitUntil(() => relay.of("prompt.resolved")[0], 10000);
    tui.keys("C-c");
    tui.keys("C-c");
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3, 20000, "socket closed after quit");
  }, 60000);

  it("the extension adds no startup latency: Pi is interactive before the relay answers", async () => {
    relay.autoWelcome = false;
    tui = launch([{ text: "x" }]);
    await tui.waitScreen("faux-1", 10000);
    tui.literal("hola");
    await tui.waitScreen("hola");
  }, 60000);
});
