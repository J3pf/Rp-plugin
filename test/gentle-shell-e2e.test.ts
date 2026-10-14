// End-to-end with the REAL gentle-shell launcher + gentle-pi 4.1.0 (isolated home, package installed by path),
// a real Pi TUI in tmux, an in-memory relay and a scripted model. Spike S4.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRelay, baseConfig, waitUntil } from "./helpers.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const root = path.resolve(import.meta.dirname, "..");
const GENTLE_SHELL = path.join(root, "node_modules/gentle-pi/bin/gentle-shell.mjs");
const PI_CLI = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

let relay: FakeRelay;
let tmp: string;
let session: string | undefined;
let seq = 0;

const screen = () => {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", session!], { encoding: "utf8" });
  } catch {
    return "";
  }
};
async function waitScreen(re: RegExp | string, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = screen();
    if (typeof re === "string" ? s.includes(re) : re.test(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`screen never matched ${re}\n--- screen ---\n${s}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-gs-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.mkdirSync(path.join(tmp, "cwd"));
  fs.writeFileSync(path.join(tmp, "bin", "pi"), `#!/bin/sh\nexec node ${PI_CLI} "$@"\n`, { mode: 0o755 });
  // a package carrying the scripted-model fixture
  const fauxPkg = path.join(tmp, "home", "fauxpkg");
  fs.mkdirSync(fauxPkg, { recursive: true });
  fs.writeFileSync(path.join(fauxPkg, "package.json"), JSON.stringify({ name: "faux-pkg", version: "1.0.0", keywords: ["pi-package"], pi: { extensions: ["./faux-ext.ts"] } }));
  fs.copyFileSync(path.join(root, "test/fixtures/faux-ext.ts"), path.join(fauxPkg, "faux-ext.ts"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fauxPkg, "node_modules"));
});
afterEach(async () => {
  if (session) spawnSync("tmux", ["kill-session", "-t", session]);
  session = undefined;
  await relay.stop();
});

function env(extra: Record<string, string> = {}) {
  return {
    HOME: path.join(tmp, "home"),
    PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
    PI_OFFLINE: "1",
    GENTLE_SHELL_NO_AUTO_SETUP: "1",
    FAUX_SCRIPT: path.join(tmp, "script.json"),
    FAUX_LOG: path.join(tmp, "faux.log"),
    RP_CONFIG: path.join(tmp, "rp.json"),
    ...extra,
  };
}

function shell(args: string[], extra: Record<string, string> = {}) {
  return spawnSync("node", [GENTLE_SHELL, ...args], { env: { ...process.env, ...env(extra) }, encoding: "utf8", timeout: 120000 });
}

function install() {
  // the same command a user runs for the second Pi home (docs: `gentle-shell install npm:@j3pf/pi-rp`; by path until published)
  expect(shell(["install", root]).status).toBe(0);
  expect(shell(["install", path.join(tmp, "home", "fauxpkg")]).status).toBe(0);
}

function launchShell(script: any[], cfg: Record<string, any> = {}, args: string[] = []) {
  fs.writeFileSync(path.join(tmp, "script.json"), JSON.stringify(script));
  fs.writeFileSync(path.join(tmp, "rp.json"), JSON.stringify(baseConfig(relay.url, cfg)));
  session = `rpgs${process.pid}x${seq++}`;
  const e = Object.entries(env()).map(([k, v]) => `${k}='${v}'`).join(" ");
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "170", "-y", "50", "-c", path.join(tmp, "cwd"), `env ${e} node ${GENTLE_SHELL} ${args.join(" ")} --model faux/faux-1 --api-key k --no-session`]);
}

const fauxLog = () => (fs.existsSync(path.join(tmp, "faux.log")) ? fs.readFileSync(path.join(tmp, "faux.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe.skipIf(!hasTmux)("real gentle-shell + gentle-pi", () => {
  it("G1/G3: `gentle-shell install` puts the plugin in ~/.gentle-shell/agent (not ~/.pi/agent) and it loads there", async () => {
    install();
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, "home", ".gentle-shell", "agent", "settings.json"), "utf8"));
    expect(settings.packages.some((p: string) => p.includes("Rp-plugin") || p.endsWith(path.basename(root)))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "home", ".pi", "agent", "settings.json"))).toBe(false);
    launchShell([{ text: "hola" }]);
    const hello = await waitUntil(() => relay.of("agent.hello")[0], 60000, "agent.hello from gentle-shell");
    expect(hello.d.launcher).toBe("gentle-shell");
    expect(hello.d.pi.mode).toBe("tui");
    expect(hello.d.gentle?.version).toMatch(/^4\./);
    expect(hello.d.plugin.features).toContain("adapters:gentle-ask");
    expect(hello.d.plugin.features).not.toContain("gate"); // gentle-pi asks for confirmations itself → own gate off (auto-detect)
  }, 120000);

  it("P5: the footer mode published by gentle-pi reaches the relay as agent.statuses and in the next hello", async () => {
    install();
    launchShell([{ text: "hola" }]);
    await waitUntil(() => relay.of("agent.hello")[0], 60000);
    await waitScreen("faux-1");
    relay.push("user.message", { clientMsgId: "gs-p5", text: "hola", method: "api" });
    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled"), 30000);
    await new Promise((r) => setTimeout(r, 1500));
    console.log("STATUSES", JSON.stringify(relay.of("agent.statuses").map((x) => x.d.items)));
    const st = await waitUntil(() => relay.of("agent.statuses").find((s) => s.d.items["gentle:mode"]), 20000, "gentle:mode status");
    expect(st.d.items["gentle:mode"]).toMatch(/Permissions: NORMAL/i);
    relay.closeAll(1012);
    await waitUntil(() => relay.of("agent.hello").length === 2, 15000);
    expect(relay.of("agent.hello")[1]!.d.gentle.mode).toBe("normal");
  }, 120000);

  it("P1/P2: a gentle-pi permission dialog in NORMAL mode is mirrored as an authorization and answered from the phone", async () => {
    install();
    launchShell([{ tool: "bash", args: { command: "rm -rf /tmp/rp-gs-nonexistent-dir" } }, { text: "listo tras la autorización" }]);
    await waitUntil(() => relay.of("agent.hello")[0], 60000);
    await waitScreen("faux-1");
    relay.push("user.message", { clientMsgId: "gs-1", text: "borra eso", method: "api" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 30000, "prompt.open");
    console.log("GENTLE PROMPT", JSON.stringify(open.d).slice(0, 600));
    expect(open.d.category).toBe("permission");
    expect(open.d.tool?.name).toBe("bash");
    const confirm = open.d.kind === "confirm";
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: confirm ? { confirmed: true } : { optionIds: ["0"] } });
    await waitScreen("listo tras la autorización", 30000);
    expect(relay.of("prompt.ack")[0]!.d.accepted).toBe(true);
    expect(fauxLog().find((l) => l.call === 2)!.lastMessage).not.toMatch(/denied|blocked|not allowed/i);
  }, 150000);

  it("S4: `/gentle:mode` sent from the phone as a command runs through sendUserMessage", async () => {
    install();
    launchShell([{ text: "x" }]);
    await waitUntil(() => relay.of("agent.hello")[0], 60000);
    await waitScreen("faux-1");
    relay.push("user.message", { clientMsgId: "gs-2", text: "/gentle:mode", asCommand: true });
    await waitUntil(() => relay.of("user.message.ack")[0], 15000);
    expect(relay.of("user.message.ack")[0]!.d).toMatchObject({ disposition: "command", method: "api" });
    await waitScreen(/Permissions: NORMAL/);
  }, 120000);

  it("G4: gentle-pi subagents (GENTLE_PI_AGENTS_CHILD=1) never register as agents", async () => {
    install();
    fs.writeFileSync(path.join(tmp, "script.json"), JSON.stringify([{ text: "x" }]));
    fs.writeFileSync(path.join(tmp, "rp.json"), JSON.stringify(baseConfig(relay.url)));
    session = `rpgs${process.pid}x${seq++}`;
    const e = Object.entries(env({ GENTLE_PI_AGENTS_CHILD: "1" })).map(([k, v]) => `${k}='${v}'`).join(" ");
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "170", "-y", "50", "-c", path.join(tmp, "cwd"), `env ${e} node ${GENTLE_SHELL} --model faux/faux-1 --api-key k --no-session`]);
    await waitScreen("faux-1", 60000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(relay.conns).toHaveLength(0);
  }, 120000);
});
