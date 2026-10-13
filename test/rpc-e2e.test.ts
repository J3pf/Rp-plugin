// Real `pi --mode rpc` (IDE / RPC-client mode): ctx.hasUI is true, dialogs go through the extension_ui sub-protocol,
// and the phone competes with the RPC client for the answer (PLAN §12, rpc row).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRelay, baseConfig, waitUntil } from "./helpers.ts";

const root = path.resolve(import.meta.dirname, "..");
const CLI = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

let relay: FakeRelay;
let tmp: string;
let child: ChildProcessWithoutNullStreams | undefined;
let lines: any[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-rpc-"));
  fs.mkdirSync(path.join(tmp, "agent"));
  fs.mkdirSync(path.join(tmp, "cwd"));
  lines = [];
});
afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await relay.stop();
});

function start(script: any[]) {
  fs.writeFileSync(path.join(tmp, "script.json"), JSON.stringify(script));
  fs.writeFileSync(path.join(tmp, "rp.json"), JSON.stringify(baseConfig(relay.url, { delivery: { method: "api", interactive: false } })));
  child = spawn(
    "node",
    [CLI, "--mode", "rpc", "--no-extensions", "-e", path.join(root, "src/extension/index.ts"), "-e", path.join(root, "test/fixtures/faux-ext.ts"), "--model", "faux/faux-1", "--api-key", "k", "--no-session", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--tools", "bash"],
    {
      cwd: path.join(tmp, "cwd"),
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "agent"), FAUX_SCRIPT: path.join(tmp, "script.json"), FAUX_LOG: path.join(tmp, "faux.log"), RP_CONFIG: path.join(tmp, "rp.json"), PI_OFFLINE: "1" },
    },
  );
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    try {
      lines.push(JSON.parse(l));
    } catch {
      /* not json */
    }
  });
}
const send = (o: unknown) => child!.stdin.write(JSON.stringify(o) + "\n");

describe("pi --mode rpc", () => {
  it("hello reports mode rpc; the phone answers a dialog while the RPC client's own request is cancelled", async () => {
    start([{ tool: "bash", args: { command: "rm -rf /tmp/rp-rpc-nonexistent-dir" } }, { text: "listo (rpc)" }]);
    const hello = await waitUntil(() => relay.of("agent.hello")[0], 20000, "hello");
    expect(hello.d.pi.mode).toBe("rpc");
    expect(hello.d.plugin.features).toContain("mirror_ui");
    send({ id: "p1", type: "prompt", message: "borra" });
    const open = await waitUntil(() => relay.of("prompt.open")[0], 20000, "prompt.open");
    expect(open.d).toMatchObject({ category: "permission", kind: "select" });
    const uiReq = await waitUntil(() => lines.find((l) => l.type === "extension_ui_request" && l.method === "select"), 10000, "extension_ui_request");
    expect(uiReq.title).toContain("rm -rf /tmp/rp-rpc-nonexistent-dir");
    relay.push("prompt.answer", { promptId: open.d.promptId, answer: { optionIds: ["0"] } });
    await waitUntil(() => lines.find((l) => l.type === "agent_settled"), 20000, "agent_settled");
    expect(relay.of("prompt.ack")[0]!.d.accepted).toBe(true);
    const text = JSON.stringify(lines.filter((l) => l.type === "message_end"));
    expect(text).toContain("listo (rpc)");
  }, 60000);

  it("the RPC client answering first resolves the phone prompt as local", async () => {
    start([{ tool: "bash", args: { command: "rm -rf /tmp/rp-rpc-nonexistent-dir" } }, { text: "hecho por el cliente" }]);
    await waitUntil(() => relay.of("agent.hello")[0], 20000);
    send({ id: "p2", type: "prompt", message: "borra" });
    const uiReq = await waitUntil(() => lines.find((l) => l.type === "extension_ui_request" && l.method === "select"), 20000);
    send({ type: "extension_ui_response", id: uiReq.id, value: "Permitir" });
    const resolved = await waitUntil(() => relay.of("prompt.resolved")[0], 10000);
    expect(resolved.d).toMatchObject({ by: "local", answer: { optionIds: ["0"] } });
    await waitUntil(() => lines.find((l) => l.type === "agent_settled"), 20000);
  }, 60000);

  it("a message from the phone becomes a turn and streams back to both", async () => {
    start([{ text: "recibido en rpc" }]);
    await waitUntil(() => relay.of("agent.hello")[0], 20000);
    relay.push("user.message", { clientMsgId: "rpc-1", text: "hola rpc" });
    await waitUntil(() => relay.of("user.message.ack")[0], 15000);
    expect(relay.of("user.message.ack")[0]!.d).toMatchObject({ disposition: "sent", method: "api" });
    await waitUntil(() => lines.find((l) => l.type === "agent_settled"), 20000);
    await waitUntil(() => relay.of("agent.event").some((e) => e.d.e.type === "agent_settled"), 10000);
  }, 60000);
});
