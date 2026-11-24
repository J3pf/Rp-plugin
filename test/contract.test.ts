import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import rpExtension from "../src/extension/index.ts";
import { FakeRelay, baseConfig, makeCtx, makePi, waitUntil } from "./helpers.ts";
import { validateEnvelope, validators, check, promptOpenShape } from "./contract.ts";
import os from "node:os";

let relay: FakeRelay;
const commFixtureFiles = [
  "up__agent.event__comm_in.valid.json",
  "up__agent.event__comm_out_ask.valid.json",
  "up__agent.event__comm_out_end.valid.json",
  "up__agent.event__comm_out_start.valid.json",
  "up__agent.event__comm_redacted.valid.json",
];
const envBackup = { ...process.env };
beforeEach(async () => {
  relay = await new FakeRelay().start();
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
  Object.assign(process.env, envBackup);
  await relay.stop();
});

describe("wire contract (PROTOCOLO v1)", () => {
  it("every message the plugin sends in a full session validates against the spec", async () => {
    const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpc-")), "c.json");
    fs.writeFileSync(cfgFile, JSON.stringify(baseConfig(relay.url)));
    process.env.RP_CONFIG = cfgFile;
    const tools = [{ name: "bash", sourceInfo: { path: "x" } }];
    const f = makePi(tools);
    rpExtension(f.pi);
    const branch = [{ type: "message", id: "e1", timestamp: 1, message: { role: "user", content: "hi" } }];
    const ctx = makeCtx({ branch });
    await f.fire("session_start", { reason: "startup" }, ctx);
    await waitUntil(() => relay.of("agent.snapshot").length === 1);
    // events
    await f.fire("agent_start", {}, ctx);
    await f.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }, ctx);
    await f.fire("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "ls" } }, ctx);
    await f.fire("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "a" }] } }, ctx);
    // prompts: gate (permission/select), confirm, input, answered by phone, local and cancelled
    const g = f.fire("tool_call", { toolCallId: "t", toolName: "bash", input: { command: "rm -rf x" } }, ctx);
    const o1 = await waitUntil(() => relay.of("prompt.open")[0]);
    relay.push("prompt.answer", { promptId: o1.d.promptId, answer: { optionIds: ["0"] } });
    await g;
    ctx.ui.mocks.select.mockImplementationOnce(async () => "b");
    await ctx.ui.select("Local wins", ["a", "b"]);
    const c = ctx.ui.confirm("Sure?", "msg");
    const i = ctx.ui.input("Name?", "ph");
    await waitUntil(() => relay.of("prompt.open").length >= 4);
    relay.push("prompt.answer", { promptId: relay.of("prompt.open")[2]!.d.promptId, answer: { confirmed: true } });
    relay.push("prompt.answer", { promptId: relay.of("prompt.open")[3]!.d.promptId, answer: { text: "Ann" } });
    await Promise.all([c, i]);
    relay.push("prompt.answer", { promptId: "GHOST", answer: { confirmed: true } });
    ctx.ui.setStatus("gentle:mode", "Permissions: NORMAL"); // after the gate: gentle-pi presence switches the own gate off
    // messages
    relay.push("user.message", { clientMsgId: "m1", text: "hi" });
    relay.push("user.message", { clientMsgId: "m1", text: "hi" });
    await waitUntil(() => relay.of("user.message.ack").length === 2);
    await new Promise((r) => setTimeout(r, 1200)); // let coalesced statuses flush

    const bad: string[] = [];
    const seen = new Set<string>();
    for (const e of relay.all) {
      seen.add(e.t);
      const errs = validateEnvelope(e);
      if (errs.length) bad.push(`${e.t}: ${errs.join("; ")}`);
    }
    expect(bad).toEqual([]);
    for (const t of ["agent.hello", "agent.snapshot", "agent.event", "agent.status", "agent.statuses", "prompt.open", "prompt.resolved", "prompt.ack", "user.message.ack"]) expect(seen.has(t), `no ${t} sent`).toBe(true);
    expect(relay.all[0]!.id).toBeTruthy(); // hello needs an id (it expects welcome)
    expect(relay.all[0]!.d.plugin.features).toContain("comm");

    if (process.env.UPDATE_FIXTURES === "1") {
      const dir = path.resolve(import.meta.dirname, "fixtures/protocol");
      for (const t of seen) {
        const sample = JSON.parse(JSON.stringify(relay.all.find((e) => e.t === t)));
        if (t === "agent.hello") {
          // no machine-specific data in committed fixtures
          sample.d.host = { hostname: "devbox", user: "dev", pid: 4242, os: "linux" };
          sample.d.cwd = "/home/dev/proyectos/api";
          sample.d.session.file = "/home/dev/.pi/agent/sessions/session.jsonl";
          sample.d.git = { branch: "main", dirty: true };
        }
        fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(sample, null, 2) + "\n");
      }
    }
    await f.fire("session_shutdown", {}, ctx);
  });

  it("validates outgoing and incoming comm events and rejects malformed comm events", () => {
    const comm = {
      type: "comm",
      commId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      direction: "out",
      channel: "intercom",
      action: "ask",
      peer: { sessionId: null, name: null, cwd: null, ref: "agent-2" },
      messageId: null,
      replyTo: null,
      expectsReply: true,
      text: "hello",
      truncated: false,
      delivered: null,
      at: 1710000000000,
    };
    const envelope = (e: unknown) => ({ v: 1, t: "agent.event", ts: 1710000000000, d: { epoch: "epoch", seq: 1, e } });

    const { delivered: _ignored, ...incomingComm } = {
      ...comm,
      direction: "in" as const,
      channel: "intercom" as const,
      action: "send" as const,
    };
    expect(validateEnvelope(envelope(comm))).toEqual([]);
    expect(validateEnvelope(envelope(incomingComm))).toEqual([]);

    const malformed = [
      { ...comm, commId: 42 },
      { ...comm, direction: "sideways" },
      { ...comm, channel: "unknown" },
      { ...comm, channel: "orchestrator", action: "send" }, // orchestrator action must be "message"
      { ...comm, action: "cancel" },
      { ...comm, peer: { ...comm.peer, sessionId: 42 } },
      { ...comm, peer: { ...comm.peer, name: 42 } },
      { ...comm, peer: { ...comm.peer, cwd: 42 } },
      { ...comm, peer: { ...comm.peer, ref: 42 } },
      { ...comm, peer: null },
      { ...comm, messageId: 42 },
      { ...comm, replyTo: 42 },
      { ...comm, expectsReply: "yes" },
      { ...comm, text: 42 },
      { ...comm, truncated: "no" },
      { ...comm, delivered: "yes" },
      { ...comm, at: "now" },
      { ...incomingComm, delivered: true }, // delivered must be omitted on "in"
      { ...incomingComm, delivered: null },
    ];
    for (const event of malformed) expect(validateEnvelope(envelope(event as typeof comm))).not.toEqual([]);
  });

  it("validates frozen comm fixtures and aligns local copies with rp-relay when available", () => {
    const localDir = path.resolve(import.meta.dirname, "fixtures/comm");
    const relayDir = process.env.RP_RELAY_FIXTURES_DIR ?? path.resolve(import.meta.dirname, "../../Rp-relay/packages/protocol/fixtures");
    const hasRelayFixtures = fs.existsSync(relayDir);

    for (const file of commFixtureFiles) {
      const local = JSON.parse(fs.readFileSync(path.join(localDir, file), "utf8"));
      expect(validateEnvelope(local), file).toEqual([]);

      if (hasRelayFixtures) {
        const canonical = JSON.parse(fs.readFileSync(path.join(relayDir, file), "utf8"));
        expect(validateEnvelope(canonical), `relay/${file}`).toEqual([]);
        expect(local, `${file} must match the frozen relay fixture`).toEqual(canonical);
      }
    }
  });

  it("the committed fixtures validate (shared with rp-relay / rp-app contract tests)", () => {
    const dir = path.resolve(import.meta.dirname, "fixtures/protocol");
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const env = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      expect(validateEnvelope(env), f).toEqual([]);
      expect(`${env.t}.json`).toBe(f);
    }
  });

  it("the validators reject malformed messages (they are not vacuous)", () => {
    expect(validators["agent.hello"]!({})).not.toEqual([]);
    expect(validators["prompt.open"]!({ promptId: "x" })).not.toEqual([]);
    expect(validators["user.message.ack"]!({ clientMsgId: "a", disposition: "bogus", method: "api", error: null })).not.toEqual([]);
    expect(validators["agent.event"]!({ epoch: "e", seq: 0, e: { type: "x" } })).not.toEqual([]);
    expect(check({ options: [{ id: 1 }] }, { options: promptOpenShape.options }, "x")).not.toEqual([]);
    expect(validateEnvelope({ v: 2, t: "agent.hello", ts: 1, d: {} })).not.toEqual([]);
    // Stale host.herdr_layout.result shape ({ available, workspaces: [{ name, panes }] }) must be rejected
    expect(validators["host.herdr_layout.result"]!({ available: true, workspaces: [{ id: "w1", name: "old", panes: [] }] })).not.toEqual([]);
    expect(validators["host.herdr_layout.result"]!({ workspaces: [{ id: "w1", label: "Main", cwd: "/repo", tabs: [{ id: "t1", label: "T1", panes: [{ id: "p1", agent: "pi" }] }] }] })).toEqual([]);
    expect(validators["host.herdr_layout.result"]!({ workspaces: [{ id: "w1", label: "Main", cwd: null, tabs: [{ id: "t1", label: "T1", panes: [{ id: "p1", agent: 123 }] }] }] })).not.toEqual([]);
    // Removed "untracked" status in host.git_diff.result must be rejected
    expect(
      validators["host.git_diff.result"]!({
        cwd: "/repo",
        branch: "main",
        files: [{ path: "a.ts", status: "untracked", additions: 1, deletions: 0, binary: false, patch: "+a", truncated: false }],
        totalAdditions: 1,
        totalDeletions: 0,
      }),
    ).not.toEqual([]);
    expect(validators["host.git_discard.result"]!({ cwd: "/repo", path: "", ok: true })).not.toEqual([]);
  });

  it("rp-host messages validate", async () => {
    const { HostConnection } = await import("../src/host/connection.ts");
    const { HostManager } = await import("../src/host/manager.ts");
    const { normalizeHostConfig } = await import("../src/host/config.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpch-"));
    const repoDir = path.join(root, "p");
    fs.mkdirSync(repoDir);
    execSync("git init", { cwd: repoDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: repoDir, stdio: "ignore" });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
    execSync("git add file.txt && git commit -m init", { cwd: repoDir, stdio: "ignore" });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello world\n");
    fs.writeFileSync(path.join(repoDir, "new.txt"), "brand new\n");

    const cfg = normalizeHostConfig({ roots: [root] });
    const run = async (cmd: string, args: string[]) => {
      if (cmd === "tmux") {
        return { code: 0, stdout: args[0] === "-V" ? "tmux 3.4" : "", stderr: "" };
      }
      if (cmd === "herdr") {
        if (args.includes("--version")) return { code: 0, stdout: "herdr 0.9.3", stderr: "" };
        if (args.includes("workspace") && args.includes("list")) {
          return {
            code: 0,
            stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "Work", cwd: repoDir }] } }),
            stderr: "",
          };
        }
        if (args.includes("tab") && args.includes("list")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              result: {
                tabs: [
                  {
                    tab_id: "t1",
                    workspace_id: "w1",
                    label: "Main",
                    panes: [{ pane_id: "p1", agent: "pi" }, { pane_id: "p2" }],
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const manager = new HostManager(cfg, { run, platform: "linux", storeFile: path.join(root, "s.json") });
    const hc = new HostConnection({ relayUrl: relay.url, machineId: "M", token: "t", cfg, manager, backoff: () => 20 });
    hc.start();
    try {
      const hello = await waitUntil(() => relay.of("host.hello")[0]);
      expect(validateEnvelope(hello)).toEqual([]);
      const ask = async (t: string, d: any) => {
        const id = "R" + t;
        const before = relay.all.length;
        relay.conns[0]!.ws.send(JSON.stringify({ v: 1, t, id, ts: 1, d }));
        return waitUntil(() => relay.all.slice(before).find((e) => e.re === id));
      };
      expect(validateEnvelope(await ask("host.list_dirs", { machineId: "M", path: root }))).toEqual([]);
      const sp = await ask("host.spawn", { machineId: "M", cwd: repoDir, backend: "tmux" });
      expect(sp.t).toBe("host.spawned");
      expect(validateEnvelope(sp)).toEqual([]);

      const layout = await ask("host.herdr_layout", { machineId: "M" });
      expect(layout.t).toBe("host.herdr_layout.result");
      expect(validateEnvelope(layout)).toEqual([]);
      expect(layout.d.workspaces).toHaveLength(1);
      expect(layout.d.workspaces[0].tabs[0].panes).toEqual([{ id: "p1", agent: "pi" }, { id: "p2" }]);

      const diff = await ask("host.git_diff", { machineId: "M", cwd: repoDir });
      expect(diff.t).toBe("host.git_diff.result");
      expect(validateEnvelope(diff)).toEqual([]);
      expect(diff.d.files.map((f: any) => f.status).sort()).toEqual(["added", "modified"]);

      const discard = await ask("host.git_discard", { machineId: "M", cwd: repoDir, path: "new.txt" });
      expect(discard.t).toBe("host.git_discard.result");
      expect(validateEnvelope(discard)).toEqual([]);
      expect(discard.d).toMatchObject({ ok: true, path: "new.txt" });
    } finally {
      hc.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
