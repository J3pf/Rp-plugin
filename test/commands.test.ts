import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenize, parseFlags, pairMachine, pluginDeclaredIn, checkDeclared, formatChecks, runDoctor, formatStatus, registerCommands, PLUGIN_PACKAGE } from "../src/extension/commands.ts";
import { normalizeConfig } from "../src/extension/config.ts";
import { FakeRelay, baseConfig, makeCtx, makePi, makeUi } from "./helpers.ts";

let relay: FakeRelay | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

describe("command parsing", () => {
  it("tokenizes with quotes", () => {
    expect(tokenize(`pair https://r CODE --name "PC Empresa" --context work`)).toEqual(["pair", "https://r", "CODE", "--name", "PC Empresa", "--context", "work"]);
    expect(tokenize("a 'b c' d")).toEqual(["a", "b c", "d"]);
    expect(tokenize("")).toEqual([]);
  });
  it("parses flags in both forms", () => {
    expect(parseFlags(["https://r", "C", "--name", "PC", "--context=work", "--persist"])).toEqual({ positional: ["https://r", "C"], flags: { name: "PC", context: "work", persist: true } });
  });
});

describe("pairing", () => {
  it("POST /v1/pair/machine and returns credentials", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/pair/machine", (_r, body) => ({ status: 200, body: { machineId: "01MACH", machineToken: "tok123", echo: body } }));
    const r = await pairMachine(relay.url, "ABCD2345", { hostname: "devbox", name: "PC Empresa", context: "work" });
    expect(r).toEqual({ machineId: "01MACH", machineToken: "tok123" });
    expect(relay.httpLog[0]!.body).toEqual({ code: "ABCD2345", hostname: "devbox", name: "PC Empresa", context: "work" });
  });
  it("surfaces relay rejections", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/pair/machine", () => ({ status: 400, body: { message: "code expired" } }));
    await expect(pairMachine(relay.url, "X", { hostname: "h" })).rejects.toThrow(/code expired/);
  });
});

describe("doctor helpers", () => {
  it("detects the plugin in settings.json (string or {source}), never via git:", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rphome-"));
    expect(pluginDeclaredIn(dir)).toMatchObject({ found: false, error: "no existe" });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi", `npm:${PLUGIN_PACKAGE}`] }));
    expect(pluginDeclaredIn(dir).found).toBe(true);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [{ source: `npm:${PLUGIN_PACKAGE}@0.1.0` }] }));
    expect(pluginDeclaredIn(dir).found).toBe(true);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [`git:github.com/j3pf/${PLUGIN_PACKAGE}`] }));
    expect(pluginDeclaredIn(dir).found).toBe(false);
    fs.writeFileSync(path.join(dir, "settings.json"), "{oops");
    expect(pluginDeclaredIn(dir).found).toBe(false);
  });
  it("checks both Pi and gentle-shell homes and tells which command to run", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rphome2-"));
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [`npm:${PLUGIN_PACKAGE}`] }));
    const prev = process.env.HOME;
    const prevU = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const checks = checkDeclared({});
      // os.homedir() reads HOME on POSIX
      if (process.platform !== "win32") {
        expect(checks[0]).toMatchObject({ level: "ok" });
        expect(checks[1]).toMatchObject({ level: "warn" });
        expect(checks[1]!.detail).toContain(`gentle-shell install npm:${PLUGIN_PACKAGE}`);
      }
    } finally {
      process.env.HOME = prev;
      process.env.USERPROFILE = prevU;
    }
  });
  it("runDoctor reports DNS/HTTP/WS/proxy against a live relay and flags a missing relay", async () => {
    relay = await new FakeRelay().start();
    const checks = await runDoctor(null, normalizeConfig({ relayUrl: relay.url, machineToken: "t" }), { HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" });
    const by = Object.fromEntries(checks.map((c) => [c.label, c]));
    expect(by["DNS"]!.level).toBe("ok");
    expect(by["HTTP /healthz"]!.level).toBe("ok");
    expect(by["WebSocket"]!.level).toBe("ok");
    expect(by["Proxy"]!.detail).toContain("HTTPS_PROXY");
    expect(by["CA corporativa"]!.detail).toContain("/ca.pem");
    expect(formatChecks(checks)).toMatch(/✓ DNS/);
    const none = await runDoctor(null, normalizeConfig({}), {});
    expect(none[0]).toMatchObject({ level: "fail", label: "Relay no configurado" });
  });
  it("WebSocket check warns when the relay rejects the upgrade with 503, fails on 401 or invalid URL", async () => {
    relay = await new FakeRelay().start();
    relay.rejectUpgrade = 503;
    const checks = await runDoctor(null, normalizeConfig({ relayUrl: relay.url, machineToken: "t" }), {});
    expect(checks.find((c) => c.label === "WebSocket")!.level).toBe("warn");
    relay.rejectUpgrade = 401;
    const checks401 = await runDoctor(null, normalizeConfig({ relayUrl: relay.url, machineToken: "t" }), {});
    expect(checks401.find((c) => c.label === "WebSocket")!.level).toBe("fail");
    const badUrl = await runDoctor(null, normalizeConfig({ relayUrl: "not-a-valid-url", machineToken: "t" }), {});
    expect(badUrl[0]).toMatchObject({ level: "fail", label: "URL del relay inválida" });
  });
  it("formatStatus without a runtime", () => {
    const text = formatStatus({ cfg: normalizeConfig({ relayUrl: "https://r", machineToken: "t", machine: { name: "PC", context: "work" } }), cfgPath: "x", getRuntime: () => undefined, startRuntime() {}, stopRuntime: async () => {} }, undefined);
    expect(text).toContain("https://r");
    expect(text).toContain("work");
    expect(text).toContain("inactivo");
  });

  it("formatStatus reports the direct-mode endpoint so the QR can be re-issued without guessing", () => {
    const text = formatStatus(
      {
        cfg: normalizeConfig({
          relayUrl: "http://127.0.0.1:4321",
          machineToken: "t",
          direct: { publicUrl: "https://direct.example", tunnel: "cloudflared", dataDir: "/tmp/d", port: 4321, keyId: "fingerprint", updatedAt: "" },
        }),
        cfgPath: "x",
        getRuntime: () => undefined,
        startRuntime() {},
        stopRuntime: async () => {},
      },
      undefined,
    );
    expect(text).toContain("Modo directo: https://direct.example · túnel cloudflared · huella fingerprint");
  });
});

describe("/rp command", () => {
  function setup() {
    const { pi, commands } = makePi();
    const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpcmd-")), "config.json");
    const cfg = baseConfig("http://127.0.0.1:1", { machineToken: null });
    let started = 0;
    let stopped = 0;
    registerCommands(pi, { cfg, cfgPath, getRuntime: () => undefined, startRuntime: () => void started++, stopRuntime: async () => void stopped++ });
    const ctx: any = makeCtx();
    const run = (args: string) => commands.get("rp").handler(args, ctx);
    return { run, ctx, cfg, cfgPath, counts: () => ({ started, stopped }), commands };
  }
  it("registers a single /rp command with completions", () => {
    const { commands } = setup();
    expect(commands.get("rp").getArgumentCompletions("p").map((c: any) => c.value)).toEqual(["pair"]);
    expect(commands.get("rp").getArgumentCompletions("zz")).toBeNull();
  });
  it("pair: stores credentials (0600), updates the live config and starts the runtime", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/pair/machine", () => ({ status: 200, body: { machineId: "01M", machineToken: "T0K" } }));
    const s = setup();
    await s.run(`pair ${relay.url} abcd2345 --name "PC Empresa" --context work`);
    expect(relay.httpLog[0]!.body.code).toBe("ABCD2345");
    const saved = JSON.parse(fs.readFileSync(s.cfgPath, "utf8"));
    expect(saved).toMatchObject({ relayUrl: relay.url, machineId: "01M", machineToken: "T0K", machine: { name: "PC Empresa", context: "work" } });
    if (process.platform !== "win32") expect(fs.statSync(s.cfgPath).mode & 0o777).toBe(0o600);
    expect(s.cfg.machineToken).toBe("T0K");
    expect(s.counts()).toEqual({ started: 1, stopped: 1 });
  });
  it("pair with a bad code reports an error and keeps the config untouched", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/pair/machine", () => ({ status: 400, body: { message: "bad code" } }));
    const s = setup();
    await s.run(`pair ${relay.url} NOPE --name x --context work`);
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/bad code/), "error");
    expect(fs.existsSync(s.cfgPath)).toBe(false);
    expect(s.cfg.machineToken).toBeNull();
  });
  it("pair asks for missing pieces through the UI", async () => {
    relay = await new FakeRelay().start();
    relay.httpResponses.set("/v1/pair/machine", () => ({ status: 200, body: { machineId: "M", machineToken: "T" } }));
    const s = setup();
    s.ctx.ui.input = async (title: string) => (title.startsWith("URL") ? relay!.url : title.startsWith("Código") ? "CODE1234" : "Mi PC");
    s.ctx.ui.select = async () => "work";
    await s.run("pair");
    expect(JSON.parse(fs.readFileSync(s.cfgPath, "utf8"))).toMatchObject({ machine: { name: "Mi PC", context: "work" } });
  });
  it("gate / off --persist / on / unpair persist what they should", async () => {
    const s = setup();
    await s.run("gate writes");
    expect(s.cfg.gate.mode).toBe("writes");
    expect(JSON.parse(fs.readFileSync(s.cfgPath, "utf8")).gate.mode).toBe("writes");
    await s.run("gate nonsense");
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/Uso: \/rp gate/), "warning");
    await s.run("off");
    expect(s.cfg.enabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(s.cfgPath, "utf8")).enabled).toBe(true); // session-only
    await s.run("off --persist");
    expect(JSON.parse(fs.readFileSync(s.cfgPath, "utf8")).enabled).toBe(false);
    s.cfg.machineToken = "t";
    await s.run("on");
    expect(s.cfg.enabled).toBe(true);
    expect(s.counts().started).toBe(1);
    await s.run("unpair");
    const after = JSON.parse(fs.readFileSync(s.cfgPath, "utf8"));
    expect(after.machineToken).toBeNull();
    expect(s.cfg.machineToken).toBeNull();
  });
  it("status / unknown subcommand / test without runtime are friendly", async () => {
    const s = setup();
    await s.run("status");
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("SIN emparejar"), "info");
    await s.run("bogus");
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("desconocido"), "warning");
    await s.run("test");
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("no está activo"), "warning");
  });
});

describe("serve (modo directo)", () => {
  it("persists the endpoint, prints the QR and restarts the runtime against the embedded relay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpservecmd-"));
    const cfgPath = path.join(dir, "config.json");
    const cfg = baseConfig("https://relay.example");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const startRuntime = vi.fn();
    const stopRuntime = vi.fn(async () => {});
    const startDirect = vi.fn(async () => ({
      publicUrl: "https://direct.example",
      localUrl: "http://127.0.0.1:4321",
      port: 4321,
      dataDir: path.join(dir, "direct"),
      tunnel: "cloudflared" as const,
      pubkey: "PUBKEY",
      keyId: "fingerprint0123456789",
      machineId: "mach-9",
      machineToken: "tok-9",
      machinePaired: true,
      qr: "▄▀▄▀",
      uri: "rp://pair?u=https%3A%2F%2Fdirect.example&c=DEVI2345&k=direct&f=fingerprint0123456789",
      deviceCode: "DEVI2345",
      stop: vi.fn(async () => {}),
    }));
    const { pi, commands, sent } = makePi();
    registerCommands(pi as never, {
      cfg: cfg as never,
      cfgPath,
      getRuntime: () => undefined,
      startRuntime,
      stopRuntime,
      startDirect: startDirect as never,
    });
    const ctx = makeCtx() as never;

    await commands.get("rp")!.handler("serve --tunnel none --name MiPC", ctx);

    expect(startDirect).toHaveBeenCalledOnce();
    expect(startDirect.mock.calls[0]![0]).toMatchObject({ tunnel: "none", name: "MiPC" });
    expect(stopRuntime).toHaveBeenCalled();
    expect(startRuntime).toHaveBeenCalledOnce();

    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(saved.relayUrl).toBe("http://127.0.0.1:4321");
    expect(saved.machineId).toBe("mach-9");
    expect(saved.direct).toMatchObject({ publicUrl: "https://direct.example", tunnel: "cloudflared", keyId: "fingerprint0123456789" });
    expect(sent.at(-1)!.message.content).toContain("▄▀▄▀");
    expect(sent.at(-1)!.message.content).toContain("https://direct.example");
  });

  it("warns that the app must rescan when the public URL changed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpservecmd2-"));
    const cfgPath = path.join(dir, "config.json");
    const withDirect = baseConfig("https://relay.example", {
      direct: { publicUrl: "https://old.example", tunnel: "cloudflared", dataDir: dir, port: 1, keyId: "k", updatedAt: "" },
    });
    fs.writeFileSync(cfgPath, JSON.stringify(withDirect));
    const ui = makeUi();
    const { pi, commands } = makePi();
    registerCommands(pi as never, {
      cfg: withDirect as never,
      cfgPath,
      getRuntime: () => undefined,
      startRuntime: vi.fn(),
      stopRuntime: vi.fn(async () => {}),
      startDirect: (async () => ({
        publicUrl: "https://new.example",
        localUrl: "http://127.0.0.1:4322",
        port: 4322,
        dataDir: dir,
        tunnel: "cloudflared" as const,
        pubkey: "P",
        keyId: "kkkkkkkkkkkkkkkkkkkkkk",
        machineId: "m",
        machineToken: "t",
        machinePaired: false,
        qr: "QR",
        uri: "rp://pair?u=x",
        deviceCode: "D",
        stop: vi.fn(async () => {}),
      })) as never,
    });
    await commands.get("rp")!.handler("serve", makeCtx({ ui }) as never);
    expect(ui.mocks.notify.mock.calls.some((c: any[]) => String(c[0]).includes("La URL cambió"))).toBe(true);
  });

  it("rejects an unknown tunnel provider without starting anything", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpservecmd3-"));
    const cfgPath = path.join(dir, "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify(baseConfig("https://relay.example")));
    const ui = makeUi();
    const startDirect = vi.fn();
    const { pi, commands } = makePi();
    registerCommands(pi as never, {
      cfg: baseConfig("https://relay.example") as never,
      cfgPath,
      getRuntime: () => undefined,
      startRuntime: vi.fn(),
      stopRuntime: vi.fn(async () => {}),
      startDirect: startDirect as never,
    });
    await commands.get("rp")!.handler("serve --tunnel ngrok", makeCtx({ ui }) as never);
    expect(startDirect).not.toHaveBeenCalled();
    expect(ui.mocks.notify.mock.calls.some((c: any[]) => String(c[0]).includes("unknown serve.tunnel"))).toBe(true);
  });
});
