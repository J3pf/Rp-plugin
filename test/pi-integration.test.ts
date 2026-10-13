// Integration against the REAL Pi 1.2.0 runtime (SDK createAgentSession) with the faux provider and an in-memory relay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import rpExtension from "../src/extension/index.ts";
import { FakeRelay, baseConfig, waitUntil } from "./helpers.ts";

let relay: FakeRelay;
let tmp: string;
const envBackup = { ...process.env };

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-pi-int-"));
  process.env.RP_CONFIG = path.join(tmp, "rp-config.json");
  fs.writeFileSync(process.env.RP_CONFIG, JSON.stringify(baseConfig(relay.url, { delivery: { method: "api", interactive: false } })));
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
  Object.assign(process.env, envBackup);
  await relay.stop();
});

async function makeSession(script: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
  faux.setResponses(script);
  const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(tmp, "agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [rpExtension],
  } as any);
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(tmp, "auth.json"), modelsPath: path.join(tmp, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
  const { session } = await createAgentSession({
    cwd,
    agentDir: path.join(tmp, "agent"),
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } } as any),
    tools: ["bash", "read"],
  } as any);
  await session.bindExtensions({} as any);
  return { session, faux, cwd };
}

describe("rp extension inside the real Pi runtime", () => {
  it("connects on session_start, streams real Pi events and sends a snapshot", async () => {
    const { session, faux } = await makeSession([fauxAssistantMessage("hola desde el agente")]);
    try {
      await waitUntil(() => relay.of("agent.hello").length === 1, 8000, "agent.hello");
      const hello = relay.of("agent.hello")[0]!.d;
      expect(hello.agentId).toMatch(/^MACHINE1:/);
      expect(hello.kind).toBe("pi");
      expect(hello.plugin.features).toContain("attachments");
      await session.prompt("di hola");
      await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled"), 8000, "agent_settled");
      const types = relay.of("agent.event").map((e) => e.d.e.type);
      expect(types).toEqual(expect.arrayContaining(["agent_start", "message_start", "message_end", "agent_settled"]));
      const msgEnds = relay.of("agent.event").map((e) => e.d.e).filter((e) => e.type === "message_end");
      expect(JSON.stringify(msgEnds)).toContain("hola desde el agente");
      const seqs = relay.of("agent.event").map((e) => e.d.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(relay.of("agent.status").map((e) => e.d.status)).toEqual(expect.arrayContaining(["working", "idle"]));
    } finally {
      session.dispose();
      void faux;
    }
  });

  it("the gate asks the phone before a dangerous command; denying blocks the real tool call", async () => {
    const cmd = "rm -rf /tmp/rp-int-does-not-exist-" + Date.now();
    const { session } = await makeSession([
      fauxAssistantMessage([fauxToolCall("bash", { command: cmd })]),
      fauxAssistantMessage("entendido, no lo ejecuto"),
    ]);
    try {
      await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
      const run = session.prompt("borra eso");
      const open = await waitUntil(() => relay.of("prompt.open")[0], 8000, "prompt.open");
      expect(open.d).toMatchObject({ kind: "select", category: "permission", danger: "high", tool: { name: "bash", args: { command: cmd } } });
      relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["2"] }, deviceId: "dev" });
      await run;
      await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled"), 8000, "agent_settled");
      const ends = relay.of("agent.event").map((e) => e.d.e).filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
      expect(ends).toHaveLength(1);
      expect(ends[0].isError).toBe(true);
      expect(JSON.stringify(ends[0].result)).toContain("Denegado por el usuario");
      expect(relay.of("prompt.ack")[0]!.d).toEqual({ promptId: open.d.promptId, accepted: true });
    } finally {
      session.dispose();
    }
  });

  it("allowing from the phone lets the command run; a safe command is never asked", async () => {
    const marker = path.join(tmp, "marker-dir");
    fs.mkdirSync(marker);
    const { session } = await makeSession([
      fauxAssistantMessage([fauxToolCall("bash", { command: `rm -rf ${JSON.stringify(marker)}` })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo seguro" })]),
      fauxAssistantMessage("listo"),
    ]);
    try {
      await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
      const run = session.prompt("hazlo");
      const open = await waitUntil(() => relay.of("prompt.open")[0], 8000);
      relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["0"] } });
      await run;
      expect(fs.existsSync(marker)).toBe(false); // really executed
      expect(relay.of("prompt.open")).toHaveLength(1); // `echo seguro` did not ask
    } finally {
      session.dispose();
    }
  });

  it("a message from the phone becomes a real user turn (source extension) and its answer streams back", async () => {
    const { session } = await makeSession([fauxAssistantMessage("recibido")]);
    try {
      await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
      relay.push("user.message", { clientMsgId: "real-1", deviceId: "dev", text: "mensaje desde el móvil" });
      await waitUntil(() => relay.of("user.message.ack").length === 1, 8000);
      expect(relay.of("user.message.ack")[0]!.d).toMatchObject({ clientMsgId: "real-1", disposition: "sent", method: "api" });
      await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled"), 8000);
      const userEnd = relay.of("agent.event").map((e) => e.d.e).find((e) => e.type === "message_end" && e.message.role === "user");
      expect(JSON.stringify(userEnd)).toContain("mensaje desde el móvil");
      const origin = session.sessionManager.getBranch().find((e: any) => e.type === "custom" && e.customType === "rp.origin") as any;
      expect(origin.data).toMatchObject({ clientMsgId: "real-1", method: "api" });
    } finally {
      session.dispose();
    }
  });

  it("abort from the phone stops a running turn", async () => {
    const { session } = await makeSession([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })]),
      fauxAssistantMessage("nunca llega"),
    ]);
    try {
      await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
      const run = session.prompt("duerme").catch(() => {});
      await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "tool_execution_start"), 8000);
      relay.push("agent.abort", {});
      await run;
      await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled" && e.d.e.aborted === true), 8000, "aborted settle");
    } finally {
      session.dispose();
    }
  });

  it("session_shutdown (what Pi's runtime emits on quit) closes the socket cleanly and cancels open prompts", async () => {
    const { session } = await makeSession([fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /tmp/rp-int-nope-" + Date.now() })]), fauxAssistantMessage("x")]);
    await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
    void session.prompt("borra").catch(() => {});
    await waitUntil(() => relay.of("prompt.open")[0], 8000, "prompt.open");
    // AgentSessionRuntime.dispose() emits exactly this before invalidating the session
    await (session as any).extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await waitUntil(() => relay.of("prompt.resolved")[0], 8000, "prompt.resolved");
    expect(relay.of("prompt.resolved")[0]!.d).toMatchObject({ by: "cancelled" });
    await waitUntil(() => relay.conns[0]!.ws.readyState === 3, 8000, "socket closed");
    session.dispose();
  });

  it("session.dispose() without a shutdown event does not keep the process alive (socket is unref'd)", async () => {
    const { session } = await makeSession([fauxAssistantMessage("x")]);
    await waitUntil(() => relay.of("agent.hello").length === 1, 8000);
    const sock = (relay.conns[0]!.ws as any)._socket;
    expect(sock).toBeTruthy();
    session.dispose();
    // the plugin side socket is unref'd: verify through the active handles diagnostic
    const handles = (process as any)._getActiveHandles().filter((h: any) => h?.constructor?.name === "Socket" && h.remotePort === relay.port && h.hasRef?.());
    expect(handles).toHaveLength(0);
  });
});
