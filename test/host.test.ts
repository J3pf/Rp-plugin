import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHostConfig, withDetectedRoots, writeDefaultHostConfig, DEFAULT_HOST_CONFIG } from "../src/host/config.ts";
import { HostError, listDirs, resolveLauncher, resolveWithinRoots, sanitizeLabel, splitCommand, validateSpawnId } from "../src/host/validate.ts";
import { gitDiff, gitDiscard } from "../src/host/git.ts";
import { HerdrBackend, parseJson, pick, PANE_PATHS } from "../src/host/backends/herdr.ts";
import { TmuxBackend, parseTmuxVersion, tmuxSupportsEnv, tmuxSessionName } from "../src/host/backends/tmux.ts";
import { WindowsTerminalBackend, ConsoleBackend, wtArgs, consoleArgs, killScript } from "../src/host/backends/windows.ts";
import { HostManager } from "../src/host/manager.ts";
import { HostConnection, parseTarget } from "../src/host/connection.ts";
import { checkLinger, enableLinger, ensureHostService, inspectService, isStaleNodePath, launchdPlist, resolveStableNodePath, schtasksCreateArgs, schtasksCreateXmlArgs, schtasksXml, systemdUnit, installService, uninstallService } from "../src/host/service.ts";
import type { Runner } from "../src/host/runner.ts";
import { FakeRelay, waitUntil } from "./helpers.ts";
import { envelope } from "../src/shared/protocol.ts";
import { validateEnvelope } from "./contract.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rphost-"));

/** Fake process runner: records calls, answers per command prefix. */
function fakeRun(handlers: Record<string, (args: string[]) => { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: Array<{ cmd: string; args: string[]; env?: any; cwd?: string }> = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd });
    const key = Object.keys(handlers).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    const r = key ? handlers[key]!(args) : { code: 127, stderr: "not found" };
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("host config", () => {
  it("defaults, normalization and resolved roots", () => {
    const c = normalizeHostConfig({ roots: ["~/code"], backend: "tmux", launchers: { a: "pi --x", bad: 3 }, defaultLauncher: "nope", herdrSession: "work" }, "/home/u");
    expect(c.roots).toEqual([path.resolve("/home/u/code")]);
    expect(c.backend).toBe("tmux");
    expect(c.launchers).toEqual({ a: "pi --x" });
    expect(c.defaultLauncher).toBe("a");
    expect(c.herdrSession).toBe("work");
    const d = normalizeHostConfig(null);
    expect(d.launchers).toEqual(DEFAULT_HOST_CONFIG.launchers);
    expect(d.backend).toBe("auto");
    expect(d.quotaEnabled).toBe(true);
    expect(d.quotaCommand).toBe("piquota --json");
    expect(d.quotaIntervalSec).toBe(300);
    expect(normalizeHostConfig({ backend: "zzz" }).backend).toBe("auto");
    const customQuota = normalizeHostConfig({ quotaEnabled: false, quotaCommand: "custom-quota", quotaIntervalSec: 60 });
    expect(customQuota.quotaEnabled).toBe(false);
    expect(customQuota.quotaCommand).toBe("custom-quota");
    expect(customQuota.quotaIntervalSec).toBe(60);
  });
  it("writeDefaultHostConfig creates a 0600 file", () => {
    const p = path.join(tmp(), "x", "host.json");
    writeDefaultHostConfig(p);
    expect(JSON.parse(fs.readFileSync(p, "utf8")).defaultLauncher).toBe("gentle-shell");
    if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("validation (the phone can only pick a directory under roots and a launcher key)", () => {
  it("accepts directories inside roots, rejects outside, files, missing, NUL", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "proj"));
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    const cfg = normalizeHostConfig({ roots: [root] });
    expect(resolveWithinRoots(cfg, path.join(root, "proj"))).toBe(fs.realpathSync(path.join(root, "proj")));
    expect(resolveWithinRoots(cfg, root)).toBe(fs.realpathSync(root));
    expect(() => resolveWithinRoots(cfg, os.tmpdir())).toThrow(/outside/);
    expect(() => resolveWithinRoots(cfg, path.join(root, "..", "etc"))).toThrow();
    expect(() => resolveWithinRoots(cfg, path.join(root, "file.txt"))).toThrow(/not a directory/);
    expect(() => resolveWithinRoots(cfg, path.join(root, "missing"))).toThrow(/does not exist/);
    expect(() => resolveWithinRoots(cfg, "a\0b")).toThrow(/invalid/);
    expect(() => resolveWithinRoots(cfg, "")).toThrow();
  });
  it("symlinks escaping the root are rejected (realpath)", () => {
    if (process.platform === "win32") return;
    const root = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, "link"));
    const cfg = normalizeHostConfig({ roots: [root] });
    expect(() => resolveWithinRoots(cfg, path.join(root, "link"))).toThrow(/outside/);
    expect(() => listDirs(cfg, path.join(root, "link"))).toThrow(/outside/);
  });
  it("sibling directories sharing a prefix are not inside the root", () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, "proj"));
    fs.mkdirSync(path.join(base, "proj-evil"));
    const cfg = normalizeHostConfig({ roots: [path.join(base, "proj")] });
    expect(() => resolveWithinRoots(cfg, path.join(base, "proj-evil"))).toThrow(/outside/);
  });
  it("listDirs lists non-hidden subdirectories sorted; empty path lists the roots", () => {
    const root = tmp();
    for (const d of ["b", "a", ".hidden"]) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, "f"), "");
    const cfg = normalizeHostConfig({ roots: [root] });
    expect(listDirs(cfg, root).dirs).toEqual(["a", "b"]);
    expect(listDirs(cfg, "").dirs).toEqual([root]);
  });
  it("launcher is a key, never a command", () => {
    const cfg = normalizeHostConfig({ launchers: { pi: "pi", "gentle-shell": "gentle-shell --link" } });
    expect(resolveLauncher(cfg, undefined).key).toBe(cfg.defaultLauncher);
    expect(resolveLauncher(cfg, "gentle-shell").command).toBe("gentle-shell --link");
    expect(() => resolveLauncher(cfg, "rm -rf /")).toThrow(/unknown launcher/);
    expect(() => resolveLauncher(cfg, "__proto__")).toThrow(/unknown launcher/);
    expect(() => resolveLauncher(cfg, "constructor")).toThrow(/unknown launcher/);
  });
  it("labels and spawn ids are sanitized", () => {
    expect(sanitizeLabel("a;b\"c`$\\\n d", "x")).toBe("a b c d");
    expect(sanitizeLabel("   ", "fallback")).toBe("fallback");
    expect(sanitizeLabel("x".repeat(200), "f").length).toBe(60);
    expect(validateSpawnId("01JABCDEFGHJKMNPQRSTVWXYZ0")).toBeTruthy();
    expect(() => validateSpawnId("a'; rm -rf /")).toThrow(HostError);
    expect(() => validateSpawnId(5)).toThrow(HostError);
    expect(splitCommand(`gentle-shell --home "C:\\Program Files\\x"`)).toEqual(["gentle-shell", "--home", "C:\\Program Files\\x"]);
  });
});

describe("herdr backend", () => {
  const ws = (id = "w1", pane = "p1") => JSON.stringify({ result: { workspace: { workspace_id: id }, root_pane: { pane_id: pane } } });
  const mkH = (extra: Record<string, any> = {}, session: string | null = null) => {
    const f = fakeRun({
      "herdr --version": () => ({ stdout: "herdr 0.9.3\n" }),
      "herdr status server": () => ({ code: 0 }),
      "herdr workspace create": () => ({ stdout: ws() }),
      "herdr pane run": () => ({ code: 0 }),
      ...extra,
    });
    return { ...f, b: new HerdrBackend({ run: f.run, platform: "linux", herdrSession: session }) };
  };
  const req = { cwd: "/p", name: "api", launcherCommand: "gentle-shell", spawnId: "SPAWN1234567" };

  it("detects the version", async () => {
    expect(await mkH().b.detect()).toBe("0.9.3");
    expect(await new HerdrBackend({ run: fakeRun().run, platform: "linux", herdrSession: null }).detect()).toBeNull();
  });
  it("new workspace: create → pane run launcher; never steals focus; env carries RP_SPAWN_ID", async () => {
    const { b, calls } = mkH();
    const rec = await b.spawn(req);
    expect(calls.find((c) => c.args[0] === "workspace")!.args).toEqual(["workspace", "create", "--cwd", "/p", "--label", "api", "--env", "RP_SPAWN_ID=SPAWN1234567", "--no-focus"]);
    expect(calls.find((c) => c.args[0] === "pane")!.args).toEqual(["pane", "run", "p1", "gentle-shell"]);
    expect(rec).toMatchObject({ backend: "herdr", herdr: { workspaceId: "w1", paneId: "p1" }, tmuxSession: null });
  });
  it("new tab in an existing workspace", async () => {
    const { b, calls } = mkH({ "herdr tab create": () => ({ stdout: JSON.stringify({ result: { tab: { tab_id: "t9" }, root_pane: { pane_id: "p9" } } }) }) });
    const rec = await b.spawn({ ...req, herdrTarget: { type: "tab", workspaceId: "w7" } });
    expect(calls.find((c) => c.args[0] === "tab")!.args).toEqual(["tab", "create", "--workspace", "w7", "--cwd", "/p", "--label", "api", "--env", "RP_SPAWN_ID=SPAWN1234567", "--no-focus"]);
    expect(rec.herdr).toMatchObject({ workspaceId: "w7", tabId: "t9", paneId: "p9" });
  });
  it("split an existing pane", async () => {
    const { b, calls } = mkH({ "herdr pane split": () => ({ stdout: JSON.stringify({ result: { pane_id: "p5" } }) }) });
    const rec = await b.spawn({ ...req, herdrTarget: { type: "split", paneId: "p2", direction: "down" } });
    expect(calls.find((c) => c.args[1] === "split")!.args).toEqual(["pane", "split", "p2", "--direction", "down", "--cwd", "/p", "--env", "RP_SPAWN_ID=SPAWN1234567", "--no-focus"]);
    expect(calls.find((c) => c.args[1] === "run")!.args).toEqual(["pane", "run", "p5", "gentle-shell"]);
    expect(rec.herdr!.paneId).toBe("p5");
  });
  it("passes HERDR_SESSION when configured", async () => {
    const { b, calls } = mkH({}, "work");
    await b.spawn(req);
    expect(calls.every((c) => c.env?.HERDR_SESSION === "work")).toBe(true);
  });
  it("errors: failed create, missing pane id, failed pane run, bad direction", async () => {
    await expect(mkH({ "herdr workspace create": () => ({ code: 1, stderr: "boom" }) }).b.spawn(req)).rejects.toThrow(/boom/);
    await expect(mkH({ "herdr workspace create": () => ({ stdout: "{}" }) }).b.spawn(req)).rejects.toThrow(/pane id/);
    await expect(mkH({ "herdr pane run": () => ({ code: 1, stderr: "denied" }) }).b.spawn(req)).rejects.toThrow(/denied/);
    await expect(mkH().b.spawn({ ...req, herdrTarget: { type: "split", paneId: "p", direction: "left" as any } })).rejects.toThrow(/direction/);
  });
  it("kill: workspace close for owned workspaces, pane close otherwise", async () => {
    const { b, calls } = mkH({ "herdr workspace close": () => ({}), "herdr pane close": () => ({}) });
    await b.kill({ spawnId: "s", backend: "herdr", herdr: { workspaceId: "w1", paneId: "p1" }, tmuxSession: null, createdAt: 0 });
    await b.kill({ spawnId: "s", backend: "herdr", herdr: { workspaceId: "w1", tabId: "t1", paneId: "p2" }, tmuxSession: null, createdAt: 0 });
    // split/tab that returned workspaceId without tabId must NOT close workspace when ownsWorkspace is false
    await b.kill({ spawnId: "s", backend: "herdr", herdr: { workspaceId: "w1", paneId: "p3", ownsWorkspace: false }, tmuxSession: null, createdAt: 0 });
    // workspace target that also returned tabId MUST close workspace when ownsWorkspace is true
    await b.kill({ spawnId: "s", backend: "herdr", herdr: { workspaceId: "w2", tabId: "t2", paneId: "p4", ownsWorkspace: true }, tmuxSession: null, createdAt: 0 });
    expect(calls.map((c) => c.args.slice(0, 3).join(" "))).toEqual(["workspace close w1", "pane close p2", "pane close p3", "workspace close w2"]);
  });
  it("starts the herdr server headless when it is not running", async () => {
    let up = false;
    const { b, calls } = mkH({ "herdr status server": () => ({ code: up ? 0 : 1 }) });
    // simulate the server coming up shortly after being asked to start
    setTimeout(() => (up = true), 300);
    await expect(b.ensureServer()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.args[0] === "status").length).toBeGreaterThan(1);
  });
  it("layout: workspaces with their tabs and panes", async () => {
    const { b } = mkH({
      "herdr workspace list": () => ({ stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "api", cwd: "/p/api" }, { workspace_id: "w2", label: "web" }] } }) }),
      "herdr tab list": () => ({ stdout: JSON.stringify({ result: { tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main", panes: [{ pane_id: "p1", agent: "pi" }, { pane_id: "p2" }] }, { tab_id: "t2", workspace_id: "w2", label: "x" }] } }) }),
    });
    const l = await b.layout();
    expect(l.workspaces).toEqual([
      { id: "w1", label: "api", cwd: "/p/api", tabs: [{ id: "t1", label: "main", panes: [{ id: "p1", agent: "pi" }, { id: "p2" }] }] },
      { id: "w2", label: "web", cwd: null, tabs: [{ id: "t2", label: "x", panes: [] }] },
    ]);
  });
  it("json helpers are tolerant", () => {
    expect(parseJson('noise {"a":1} tail')).toEqual({ a: 1 });
    expect(parseJson("")).toBeNull();
    expect(pick({ result: { pane_id: 7 } }, PANE_PATHS)).toBe("7");
  });
});

describe("tmux backend", () => {
  it("version gate ≥ 3.2 and session naming", () => {
    expect(parseTmuxVersion("tmux 3.4")).toBe("3.4");
    expect(parseTmuxVersion("tmux next-3.5")).toBe("3.5");
    expect(parseTmuxVersion("tmux 3.3a")).toBe("3.3a");
    expect(tmuxSupportsEnv("3.2")).toBe(true);
    expect(tmuxSupportsEnv("3.1c")).toBe(false);
    expect(tmuxSupportsEnv("2.9")).toBe(false);
    expect(tmuxSupportsEnv("4.0")).toBe(true);
    expect(tmuxSupportsEnv(null)).toBe(false);
    expect(tmuxSessionName("01JABCDEFGHJKMNP")).toBe("rp-fghjkmnp");
  });
  it("detect honours the version gate; windows never has tmux", async () => {
    const ok = new TmuxBackend({ run: fakeRun({ "tmux -V": () => ({ stdout: "tmux 3.4\n" }) }).run, platform: "linux", herdrSession: null });
    expect(await ok.detect()).toBe("3.4");
    const old = new TmuxBackend({ run: fakeRun({ "tmux -V": () => ({ stdout: "tmux 3.0\n" }) }).run, platform: "linux", herdrSession: null });
    expect(await old.detect()).toBeNull();
    expect(await new TmuxBackend({ run: fakeRun().run, platform: "win32", herdrSession: null }).detect()).toBeNull();
  });
  it("spawn: detached session with cwd and RP_SPAWN_ID; kill by session", async () => {
    const f = fakeRun({ "tmux new-session": () => ({}), "tmux kill-session": () => ({}) });
    const b = new TmuxBackend({ run: f.run, platform: "linux", herdrSession: null });
    const rec = await b.spawn({ cwd: "/p", name: "n", launcherCommand: "gentle-shell", spawnId: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(f.calls[0]!.args).toEqual(["new-session", "-d", "-s", rec.tmuxSession!, "-c", "/p", "-e", "RP_SPAWN_ID=01JABCDEFGHJKMNPQRSTVWXYZ0", "gentle-shell"]);
    expect(rec.tmuxSession).toMatch(/^rp-[a-z0-9]{8}$/);
    await b.kill(rec);
    expect(f.calls[1]!.args).toEqual(["kill-session", "-t", rec.tmuxSession]);
    await expect(new TmuxBackend({ run: fakeRun({ "tmux new-session": () => ({ code: 1, stderr: "dup" }) }).run, platform: "linux", herdrSession: null }).spawn({ cwd: "/p", name: "n", launcherCommand: "pi", spawnId: "S12345678901" })).rejects.toThrow(/dup/);
  });
});

describe("Windows backends (id travels as --rp-spawn-id because wt/cmd do not pass env)", () => {
  const req = { cwd: "C:\\proyectos\\api", name: "api", launcherCommand: "gentle-shell --link", spawnId: "SPAWNID12345" };
  it("wt.exe arguments", () => {
    expect(wtArgs(req)).toEqual(["-w", "rp", "new-tab", "-d", "C:\\proyectos\\api", "--title", "api", "gentle-shell", "--link", "--rp-spawn-id", "SPAWNID12345"]);
    expect(() => wtArgs({ ...req, cwd: "C:\\a;b" })).toThrow(/;/);
  });
  it("cmd /c start arguments", () => {
    expect(consoleArgs(req)).toEqual(["/c", "start", '"api"', "/D", "C:\\proyectos\\api", "gentle-shell", "--link", "--rp-spawn-id", "SPAWNID12345"]);
    expect(() => consoleArgs({ ...req, cwd: "C:\\proyectos\\api&calc" })).toThrow(/unsafe/);
    expect(() => consoleArgs({ ...req, launcherCommand: "pi & whoami" })).toThrow(/unsafe/);
  });
  it("kill script matches only this spawn id", () => {
    expect(killScript("SPAWNID12345")).toContain("--rp-spawn-id SPAWNID12345*");
    expect(killScript("SPAWNID12345")).toContain("$_.ProcessId -ne $PID");
    expect(() => killScript("bad'; Stop-Process")).toThrow(HostError);
  });
  it("spawn/kill run wt.exe / cmd.exe / powershell without a shell string", async () => {
    const f = fakeRun({ "wt.exe": () => ({}), "cmd.exe": () => ({}), "powershell.exe": () => ({}), "where wt.exe": () => ({}) });
    const wt = new WindowsTerminalBackend({ run: f.run, platform: "win32", herdrSession: null });
    expect(await wt.detect()).toBe(true);
    const rec = await wt.spawn(req);
    expect(rec.backend).toBe("wt");
    await wt.kill(rec);
    const con = new ConsoleBackend({ run: f.run, platform: "win32", herdrSession: null });
    await con.spawn(req);
    expect(f.calls.map((c) => c.cmd)).toEqual(["where", "wt.exe", "powershell.exe", "cmd.exe"]);
    expect(await new WindowsTerminalBackend({ run: f.run, platform: "linux", herdrSession: null }).detect()).toBeNull();
    expect(await new ConsoleBackend({ run: f.run, platform: "linux", herdrSession: null }).detect()).toBeNull();
  });
});

describe("HostManager", () => {
  function mk(platform: NodeJS.Platform, handlers: Record<string, any>, over: any = {}) {
    const root = tmp();
    fs.mkdirSync(path.join(root, "proj"));
    const cfg = normalizeHostConfig({ roots: [root], launchers: { "gentle-shell": "gentle-shell", pi: "pi" }, ...over });
    const f = fakeRun(handlers);
    const mgr = new HostManager(cfg, { run: f.run, platform, storeFile: path.join(tmp(), "spawns.json") });
    return { mgr, f, root };
  }
  const linuxTmux = { "tmux -V": () => ({ stdout: "tmux 3.4" }), "tmux new-session": () => ({}), "tmux kill-session": () => ({}) };
  it("auto prefers herdr, then tmux (Linux)", async () => {
    expect(await mk("linux", linuxTmux).mgr.resolveBackend()).toBe("tmux");
    expect(await mk("linux", { ...linuxTmux, "herdr --version": () => ({ stdout: "herdr 0.9.3" }) }).mgr.resolveBackend()).toBe("herdr");
  });
  it("auto on Windows: herdr, then Windows Terminal, then console", async () => {
    expect(await mk("win32", { "where wt.exe": () => ({}) }).mgr.resolveBackend()).toBe("wt");
    expect(await mk("win32", {}).mgr.resolveBackend()).toBe("console");
    expect(await mk("win32", { "herdr --version": () => ({ stdout: "herdr 0.9.3" }), "where wt.exe": () => ({}) }).mgr.resolveBackend()).toBe("herdr");
  });
  it("no backend available is a clear error; an unavailable explicit backend too", async () => {
    await expect(mk("linux", {}).mgr.resolveBackend()).rejects.toThrow(/no backend available/);
    await expect(mk("linux", linuxTmux).mgr.resolveBackend("wt")).rejects.toThrow(/not available/);
  });
  it("host.json backend pins the choice", async () => {
    expect(await mk("linux", { ...linuxTmux, "herdr --version": () => ({ stdout: "herdr 0.9.3" }) }, { backend: "tmux" }).mgr.resolveBackend()).toBe("tmux");
  });
  it("spawn validates cwd/launcher, records the spawn and can kill it (including after a restart)", async () => {
    const { mgr, f, root } = mk("linux", linuxTmux);
    await expect(mgr.spawn({ cwd: os.tmpdir() })).rejects.toThrow(/outside/);
    await expect(mgr.spawn({ cwd: path.join(root, "proj"), launcher: "bash -c evil" })).rejects.toThrow(/unknown launcher/);
    const rec = await mgr.spawn({ cwd: path.join(root, "proj"), name: "Mi; proyecto", launcher: "pi" });
    expect(rec.backend).toBe("tmux");
    expect(f.calls.find((c) => c.args[0] === "new-session")!.args.at(-1)).toBe("pi");
    expect(mgr.list()).toHaveLength(1);
    await expect(mgr.kill("A".repeat(26))).rejects.toThrow(/only agents created/);
    await mgr.kill(rec.spawnId);
    expect(mgr.list()).toHaveLength(0);
    expect(f.calls.some((c) => c.args[0] === "kill-session")).toBe(true);
  });
  it("persists spawns so kill works after rp-host restarts", async () => {
    const { mgr, root } = mk("linux", linuxTmux);
    const rec = await mgr.spawn({ cwd: path.join(root, "proj") });
    const store = (mgr as any).storeFile;
    const cfg = (mgr as any).cfg;
    const mgr2 = new HostManager(cfg, { run: fakeRun(linuxTmux).run, platform: "linux", storeFile: store });
    expect(mgr2.list().map((r) => r.spawnId)).toEqual([rec.spawnId]);
    await mgr2.kill(rec.spawnId);
  });
  it("herdrTarget requires the herdr backend", async () => {
    const { mgr, root } = mk("linux", linuxTmux);
    await expect(mgr.spawn({ cwd: path.join(root, "proj"), herdrTarget: { type: "workspace" } })).rejects.toThrow(/requires the herdr backend/);
  });
  it("supports sessionId to resume a session (pi --session <id>)", async () => {
    const { mgr, f, root } = mk("linux", linuxTmux);
    const rec = await mgr.spawn({ cwd: path.join(root, "proj"), sessionId: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(f.calls.find((c) => c.args[0] === "new-session")!.args.at(-1)).toBe("gentle-shell --session 01JABCDEFGHJKMNPQRSTVWXYZ0");
    await expect(mgr.spawn({ cwd: path.join(root, "proj"), sessionId: "bad; rm -rf /" })).rejects.toThrow(/invalid sessionId/);
    await mgr.kill(rec.spawnId);
  });
  it("resolves and spawns agy, claude, and codex launchers", async () => {
    const { mgr, f, root } = mk("linux", linuxTmux, { launchers: DEFAULT_HOST_CONFIG.launchers });
    for (const launcher of ["agy", "claude", "codex"] as const) {
      const rec = await mgr.spawn({ cwd: path.join(root, "proj"), launcher });
      expect(rec.backend).toBe("tmux");
      const lastCall = f.calls.filter((c) => c.args[0] === "new-session").at(-1);
      expect(lastCall?.args.at(-1)).toBe(launcher);
      await mgr.kill(rec.spawnId);
    }
  });
});

describe("HostConnection protocol", () => {
  let relay: FakeRelay;
  let hc: HostConnection | undefined;
  afterEach(async () => {
    hc?.stop();
    await relay?.stop();
  });
  async function connect(handlers: Record<string, (args: string[]) => { code?: number; stdout?: string; stderr?: string }>, machineId = "MACH-H") {
    relay = await new FakeRelay().start();
    const cfg = normalizeHostConfig({ roots: [tmp()], quotaEnabled: false });
    const f = fakeRun(handlers);
    const manager = new HostManager(cfg, { run: f.run, platform: "linux", storeFile: path.join(tmp(), "spawns.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId, token: "tok", cfg, manager, backoff: () => 20 });
    hc.start();
    await waitUntil(() => relay.of("host.hello")[0]);
    let sequence = 0;
    const ask = async (t: string, d: any) => {
      const before = relay!.all.length;
      const id = `HERDR-${++sequence}`;
      relay!.conns[0]!.ws.send(JSON.stringify(envelope(t, d, { id })));
      return waitUntil(() => relay!.all.slice(before).find((e) => e.re === id), 3000, `reply to ${t}`);
    };
    return { f, ask };
  }
  it("closes a Herdr pane and replies with the exact result", async () => {
    const { f, ask } = await connect({
      "herdr --version": () => ({ stdout: "herdr 0.9.5" }),
      "herdr pane close": () => ({ code: 0 }),
    });
    const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId: "w1:p1" });
    expect(reply.t).toBe("host.herdr_closed");
    expect(reply.d).toEqual({ paneId: "w1:p1", ok: true, error: null });
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close").map((call) => call.args)).toEqual([["pane", "close", "w1:p1"]]);
  });
  it("returns typed unknown-pane errors and remains usable", async () => {
    const { f, ask } = await connect({
      "herdr --version": () => ({ stdout: "herdr 0.9.5" }),
      "herdr pane close": () => ({ code: 1, stderr: '{"error":{"code":"pane_not_found","message":"pane w9:p9 not found"},"id":"cli:pane:close"}' }),
    });
    const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId: "w9:p9" });
    expect(reply.t).toBe("host.herdr_closed");
    expect(reply.d).toEqual({ paneId: "w9:p9", ok: false, error: "pane_not_found" });
    const followup = await ask("host.list_dirs", { machineId: "MACH-H", path: "" });
    expect(followup.t).toBe("host.dirs");
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close").map((call) => call.args)).toEqual([["pane", "close", "w9:p9"]]);
  });
  it("uses the stable error for empty non-JSON failures", async () => {
    const { ask } = await connect({
      "herdr --version": () => ({ stdout: "herdr 0.9.5" }),
      "herdr pane close": () => ({ code: 1 }),
    });
    const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId: "w1:p2" });
    expect(reply.t).toBe("host.herdr_closed");
    expect(reply.d).toEqual({ paneId: "w1:p2", ok: false, error: "herdr_close_failed" });
  });
  it("rejects malformed pane ids without invoking Herdr close", async () => {
    const { f, ask } = await connect({ "herdr --version": () => ({ stdout: "herdr 0.9.5" }) });
    for (const paneId of ["../etc", ""]) {
      const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId });
      expect(reply.t).toBe("error");
      expect(reply.d).toEqual({ code: "bad_request", message: "invalid paneId" });
    }
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close")).toHaveLength(0);
  });
  it("rejects non-string pane ids without invoking Herdr close", async () => {
    const { f, ask } = await connect({ "herdr --version": () => ({ stdout: "herdr 0.9.5" }) });
    for (const paneId of [undefined, 123, "-x"]) {
      const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId });
      expect(reply.t).toBe("error");
      expect(reply.d).toEqual({ code: "bad_request", message: "invalid paneId" });
    }
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close")).toHaveLength(0);
  });
  it("rejects a mismatched machine id without invoking Herdr close", async () => {
    const { f, ask } = await connect({ "herdr --version": () => ({ stdout: "herdr 0.9.5" }) });
    const reply = await ask("host.herdr_close", { machineId: "OTHER", paneId: "w1:p1" });
    expect(reply.t).toBe("error");
    expect(reply.d).toEqual({ code: "bad_request", message: "machineId mismatch" });
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close")).toHaveLength(0);
  });
  it("reports Herdr unavailable without trying to close a pane", async () => {
    const { f, ask } = await connect({});
    const reply = await ask("host.herdr_close", { machineId: "MACH-H", paneId: "w1:p1" });
    expect(reply.t).toBe("host.herdr_closed");
    expect(reply.d).toEqual({ paneId: "w1:p1", ok: false, error: "herdr_unavailable" });
    expect(f.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "close")).toHaveLength(0);
  });
  it("host.hello, list_dirs, spawn → host.spawned, errors, kill", async () => {
    relay = await new FakeRelay().start();
    const root = tmp();
    fs.mkdirSync(path.join(root, "alpha"));
    const cfg = normalizeHostConfig({ roots: [root] });
    const f = fakeRun({ "tmux -V": () => ({ stdout: "tmux 3.4" }), "tmux new-session": () => ({}), "tmux kill-session": () => ({}) });
    const manager = new HostManager(cfg, { run: f.run, platform: "linux", storeFile: path.join(tmp(), "s.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId: "MACH1", token: "tok", cfg, manager, backoff: () => 20 });
    hc.start();
    const hello = await waitUntil(() => relay.of("host.hello")[0]);
    expect(relay.conns[0]!.path).toBe("/ws/host");
    expect(relay.conns[0]!.headers.authorization).toBe("Bearer tok");
    expect(hello.d).toMatchObject({ machineId: "MACH1", roots: [root], backends: { tmux: "3.4", herdr: null, wt: false, console: false }, defaultBackend: "tmux", launchers: ["gentle-shell", "pi", "agy", "claude", "codex"], defaultLauncher: "gentle-shell" });

    const ask = async (t: string, d: any) => {
      const before = relay.all.length;
      const id = `REQ${Math.random()}`;
      relay.conns[0]!.ws.send(JSON.stringify(envelope(t, d, { id })));
      return waitUntil(() => relay.all.slice(before).find((e) => e.re === id), 3000, `reply to ${t}`);
    };
    expect((await ask("host.list_dirs", { machineId: "MACH1", path: root })).d).toEqual({ path: fs.realpathSync(root), dirs: ["alpha"] });
    const bad = await ask("host.list_dirs", { machineId: "MACH1", path: "/etc" });
    expect(bad.t).toBe("error");
    expect(bad.d.code).toBe("bad_request");
    const sp = await ask("host.spawn", { machineId: "MACH1", cwd: path.join(root, "alpha"), name: "alpha", launcher: "pi", sessionId: "sess-resumed", initialPrompt: "hola" });
    expect(sp.t).toBe("host.spawned");
    expect(sp.d).toMatchObject({ backend: "tmux", herdr: null });
    expect(sp.d.tmuxSession).toMatch(/^rp-/);
    expect((await ask("host.spawn", { machineId: "OTHER", cwd: root })).t).toBe("error");
    expect((await ask("host.spawn", { machineId: "MACH1", cwd: root, launcher: "evil" })).d.message).toMatch(/unknown launcher/);
    expect((await ask("host.kill", { machineId: "MACH1", spawnId: sp.d.spawnId })).t).toBe("ack");
    expect((await ask("host.kill", { machineId: "MACH1", spawnId: sp.d.spawnId })).t).toBe("error");
    expect((await ask("host.herdr_layout", { machineId: "MACH1" })).t).toBe("error"); // herdr absent
  });
  it("reconnects and does not reconnect after 4001 or HTTP 401", async () => {
    relay = await new FakeRelay().start();
    const cfg = normalizeHostConfig({ roots: [tmp()] });
    const manager = new HostManager(cfg, { run: fakeRun({}).run, platform: "linux", storeFile: path.join(tmp(), "s.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId: "M", token: "t", cfg, manager, backoff: () => 20 });
    hc.start();
    await waitUntil(() => relay.of("host.hello").length === 1);
    relay.closeAll(1011);
    await waitUntil(() => relay.of("host.hello").length === 2);
    relay.closeAll(4001);
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.of("host.hello")).toHaveLength(2);
    hc.stop();
    relay.rejectUpgrade = 401;
    const logs: string[] = [];
    hc = new HostConnection({ relayUrl: relay.url, machineId: "M", token: "t", cfg, manager, backoff: () => 20, onLog: (m) => logs.push(m) });
    hc.start();
    await waitUntil(() => logs.some((l) => l.includes("401")));
    await new Promise((r) => setTimeout(r, 100));
    expect(logs.filter((l) => l.includes("401"))).toHaveLength(1);
  });
  it("parseTarget validates herdrTarget", () => {
    expect(parseTarget(undefined)).toBeUndefined();
    expect(parseTarget({ type: "workspace" })).toEqual({ type: "workspace" });
    expect(parseTarget({ type: "tab", workspaceId: "w" })).toEqual({ type: "tab", workspaceId: "w" });
    expect(parseTarget({ type: "split", paneId: "p", direction: "down" })).toEqual({ type: "split", paneId: "p", direction: "down" });
    expect(parseTarget({ type: "split", paneId: "p" })).toMatchObject({ direction: "right" });
    expect(() => parseTarget({ type: "tab" })).toThrow();
    expect(() => parseTarget({ type: "weird" })).toThrow();
  });
  it("includes quotas in host.hello and emits host.quotas on poll", async () => {
    relay = await new FakeRelay().start();
    const sampleOutput = {
      engine: "pi-quota",
      schemaVersion: 1,
      readOnly: true,
      generatedAt: "2026-10-15T05:43:14.794Z",
      providers: [
        {
          family: "antigravity",
          label: "Antigravity (Pi)",
          plan: null,
          windows: [
            {
              id: "gemini-5h",
              label: "Gemini · 5h",
              usedPercent: 10,
              remainingPercent: 90,
              resetsAt: "2026-10-15T15:00:00.000Z",
              resetsInSec: 3600,
              note: null,
            },
          ],
          error: null,
          ok: true,
          updatedAt: "2026-10-15T05:43:14.794Z",
          primaryWindowId: "gemini-5h",
        },
      ],
    };
    const cfg = normalizeHostConfig({ roots: [tmp()], quotaEnabled: true, quotaIntervalSec: 60 });
    const f = fakeRun({
      "piquota --json": () => ({ stdout: JSON.stringify(sampleOutput) }),
    });
    const manager = new HostManager(cfg, { run: f.run, platform: "linux", storeFile: path.join(tmp(), "s.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId: "MACH-Q", token: "tok", cfg, manager, backoff: () => 20 });
    hc.start();

    const hello = await waitUntil(() => relay.of("host.hello")[0]);
    expect(hello.d.quotas).toBeDefined();
    expect(hello.d.quotas).toHaveLength(1);
    expect(hello.d.quotas[0].family).toBe("antigravity");
    expect(validateEnvelope(hello)).toEqual([]);

    await hc.pollQuotas();
    const quotasEnv = await waitUntil(() => relay.of("host.quotas")[0]);
    expect(quotasEnv.d.quotas).toHaveLength(1);
    expect(quotasEnv.d.quotas[0].family).toBe("antigravity");
    expect(validateEnvelope(quotasEnv)).toEqual([]);
  });
  it("omits quotas when quotaEnabled is false", async () => {
    relay = await new FakeRelay().start();
    const cfg = normalizeHostConfig({ roots: [tmp()], quotaEnabled: false });
    const f = fakeRun({
      "piquota --json": () => ({ stdout: "{}" }),
    });
    const manager = new HostManager(cfg, { run: f.run, platform: "linux", storeFile: path.join(tmp(), "s.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId: "MACH-NO-Q", token: "tok", cfg, manager, backoff: () => 20 });
    hc.start();

    const hello = await waitUntil(() => relay.of("host.hello")[0]);
    expect(hello.d.quotas).toBeUndefined();
    expect(validateEnvelope(hello)).toEqual([]);
  });
});

describe("service installation", () => {
  const serviceHomes: string[] = [];
  const serviceTmp = () => {
    const home = tmp();
    serviceHomes.push(home);
    return home;
  };
  afterEach(() => {
    for (const home of serviceHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });
  const spec = { nodePath: "/usr/bin/node", scriptPath: "/opt/rp/bin/rp-host.mjs", platform: "linux" as const };
  it("resolves a non-realpath'd PATH node matching a versioned execPath", () => {
    const root = tmp();
    try {
      const versioned = path.join(root, "Cellar", "node", "26.0.0", "bin", "node");
      const stable = path.join(root, "bin", "node");
      fs.mkdirSync(path.dirname(versioned), { recursive: true });
      fs.mkdirSync(path.dirname(stable), { recursive: true });
      fs.writeFileSync(versioned, "node");
      fs.symlinkSync(versioned, stable);
      expect(resolveStableNodePath({ PATH: path.dirname(stable) }, "linux", versioned)).toBe(stable);
      expect(resolveStableNodePath({ PATH: "" }, "linux", stable)).toBe(stable);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("detects missing and Cellar node paths as stale, but accepts a valid path", () => {
    const root = tmp();
    try {
      const valid = path.join(root, "node");
      const cellar = path.join(root, "Cellar", "node", "26.0.0", "bin", "node");
      fs.writeFileSync(valid, "node");
      fs.mkdirSync(path.dirname(cellar), { recursive: true });
      fs.writeFileSync(cellar, "node");
      expect(isStaleNodePath(path.join(root, "missing"))).toBe(true);
      expect(isStaleNodePath(cellar)).toBe(true);
      expect(isStaleNodePath(valid)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("systemd user unit includes restart limits and captured PATH", () => {
    const u = systemdUnit({ ...spec, envPath: "/home/u/bin:/usr/bin" });
    expect(u).toContain("ExecStart=/usr/bin/node /opt/rp/bin/rp-host.mjs run");
    expect(u).toContain("Restart=always");
    expect(u).toContain("RestartSec=5");
    expect(u).toContain("StartLimitIntervalSec=0");
    expect(u).toContain('Environment="PATH=/home/u/bin:/usr/bin"');
    expect(u).toContain("WantedBy=default.target");
    expect(systemdUnit({ ...spec, scriptPath: "/opt/my dir/rp.mjs" })).toContain('"/opt/my dir/rp.mjs"');
    expect(systemdUnit(spec)).toContain(`Environment="PATH=${process.env.PATH ?? ""}"`);
    expect(systemdUnit({ ...spec, envPath: "" })).not.toContain('Environment="PATH=');
  });
  it("Task Scheduler at logon, without admin and with windowless conhost launcher", () => {
    const windowsSpec = { ...spec, platform: "win32" as const, nodePath: "C:\\Program Files\\nodejs\\node.exe", scriptPath: "C:\\rp\\bin\\rp-host.mjs" };
    const a = schtasksCreateArgs(windowsSpec);
    expect(a).toEqual(["/Create", "/SC", "ONLOGON", "/TN", "rp-host", "/TR", 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\rp\\bin\\rp-host.mjs" run', "/F"]);
    expect(a).not.toContain("/RU");
    expect(schtasksCreateArgs(windowsSpec, "C:\\Temp\\task.xml")).toEqual(["/Create", "/XML", "C:\\Temp\\task.xml", "/TN", "rp-host", "/F"]);
    expect(schtasksCreateXmlArgs("C:\\Temp\\task.xml")).toEqual(["/Create", "/XML", "C:\\Temp\\task.xml", "/TN", "rp-host", "/F"]);
  });
  it("generates Task Scheduler XML with required policies, conhost headless launcher, and UTF-16 declaration", () => {
    const xml = schtasksXml({
      ...spec,
      platform: "win32",
      nodePath: "C:\\Program Files\\RP & Co\\node.exe",
      scriptPath: "C:\\RP <Host>\\rp&host.mjs",
    });
    for (const element of [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "<Description>RP host (create Pi agents from the phone)</Description>",
      "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<StartWhenAvailable>true</StartWhenAvailable>",
      "<LogonType>InteractiveToken</LogonType>",
      "<RunLevel>LeastPrivilege</RunLevel>",
      "<Hidden>true</Hidden>",
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "<Interval>PT1M</Interval>",
      "<Count>999</Count>",
      "<Command>conhost.exe</Command>",
      '<Arguments>--headless "C:\\Program Files\\RP &amp; Co\\node.exe" "C:\\RP &lt;Host&gt;\\rp&amp;host.mjs" run</Arguments>',
    ]) expect(xml).toContain(element);
  });
  it("installs Windows Task Scheduler from a temporary XML file encoded in UTF-16LE with BOM and cleans it up", async () => {
    const home = tmp();
    let xmlPath = "";
    let xmlRawBytes: Buffer | null = null;
    const f = fakeRun({
      schtasks: (args) => {
        if (args[0] === "/Create") {
          expect(args.slice(0, 2)).toEqual(["/Create", "/XML"]);
          xmlPath = args[2]!;
          expect(args.slice(3)).toEqual(["/TN", "rp-host", "/F"]);
          expect(fs.existsSync(xmlPath)).toBe(true);
          xmlRawBytes = fs.readFileSync(xmlPath);
        }
        return {};
      },
    });
    try {
      const message = await installService({
        ...spec,
        platform: "win32",
        home,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        scriptPath: "C:\\rp\\bin\\rp-host.mjs",
      }, f.run);
      expect(message).toContain("scheduled task rp-host created");
      expect(xmlRawBytes).not.toBeNull();
      // Byte order mark (BOM) for UTF-16LE is 0xFF 0xFE
      expect(xmlRawBytes![0]).toBe(0xff);
      expect(xmlRawBytes![1]).toBe(0xfe);
      // Decode content without BOM
      const decodedXml = xmlRawBytes!.subarray(2).toString("utf16le");
      expect(decodedXml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
      expect(decodedXml).toContain("<Task version=\"1.2\"");
      expect(decodedXml).toContain("<Command>conhost.exe</Command>");
      expect(decodedXml).toContain('--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\rp\\bin\\rp-host.mjs" run');
      expect(fs.existsSync(xmlPath)).toBe(false);
      expect(f.calls.map((call) => [call.cmd, call.args])).toEqual([
        ["schtasks", ["/Create", "/XML", xmlPath, "/TN", "rp-host", "/F"]],
        ["schtasks", ["/Run", "/TN", "rp-host"]],
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it("launchd plist escapes XML and includes runtime environment and logs", () => {
    const home = "/Users/alice";
    const p = launchdPlist({ ...spec, platform: "darwin", home, envPath: "/opt/bin:/usr/bin", scriptPath: "/a&b/rp.mjs" });
    expect(p).toContain("<string>/a&amp;b/rp.mjs</string>");
    expect(p).toContain("<key>KeepAlive</key>");
    expect(p).toContain("<key>EnvironmentVariables</key>");
    expect(p).toContain("<key>PATH</key>");
    expect(p).toContain("<string>/opt/bin:/usr/bin</string>");
    expect(p).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
    expect(p).toContain(`<key>StandardOutPath</key>\n  <string>${home}/Library/Logs/rp-host.log</string>`);
    expect(p).toContain(`<key>StandardErrorPath</key>\n  <string>${home}/Library/Logs/rp-host.log</string>`);
  });
  it("checks and enables login linger through the injected runner", async () => {
    const yes = fakeRun({ "loginctl show-user alice -p Linger": () => ({ stdout: "Linger=yes\n" }) });
    await expect(checkLinger("alice", yes.run)).resolves.toEqual({ lingering: true });
    expect(yes.calls).toEqual([{ cmd: "loginctl", args: ["show-user", "alice", "-p", "Linger"], env: undefined, cwd: undefined }]);
    const no = fakeRun({ "loginctl show-user alice -p Linger": () => ({ stdout: "Linger=no\n" }) });
    await expect(checkLinger("alice", no.run)).resolves.toEqual({ lingering: false });
    const failedCheck = fakeRun({ "loginctl show-user alice -p Linger": () => ({ code: 1, stderr: "denied" }) });
    await expect(checkLinger("alice", failedCheck.run)).resolves.toEqual({ lingering: false, error: "denied" });
    const enabled = fakeRun({ "loginctl enable-linger alice": () => ({}) });
    await expect(enableLinger("alice", enabled.run)).resolves.toEqual({ ok: true, message: "Linger enabled for alice" });
    const failedEnable = fakeRun({ "loginctl enable-linger alice": () => ({ code: 1, stderr: "access denied" }) });
    await expect(enableLinger("alice", failedEnable.run)).resolves.toEqual({ ok: false, message: expect.stringContaining("access denied") });
    expect((await enableLinger("alice", failedEnable.run)).message).toContain("privileges");
  });
  it("inspects a Linux systemd service and linger status", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const linuxSpec = { ...spec, home, nodePath, scriptPath };
    const unitPath = path.join(home, ".config", "systemd", "user", "rp-host.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, systemdUnit({ ...linuxSpec, envPath: "/usr/bin" }));
    const f = fakeRun({
      "systemctl --user is-enabled rp-host": () => ({ stdout: "enabled\n" }),
      "systemctl --user is-active rp-host": () => ({ code: 3, stdout: "active\n" }),
      "loginctl show-user": () => ({ stdout: "Linger=yes\n" }),
    });
    const inspection = await inspectService(linuxSpec, f.run);
    expect(inspection).toMatchObject({ platform: "linux", installed: true, enabled: true, running: true, nodePath, nodePathValid: true, scriptPath, scriptPathValid: true, stale: false, details: { linger: true } });
    expect(f.calls.map(({ cmd, args }) => `${cmd} ${args.join(" ")}`)).toEqual([
      "systemctl --user is-enabled rp-host",
      "systemctl --user is-active rp-host",
      `loginctl show-user ${process.env.USER ?? os.userInfo().username} -p Linger`,
    ]);
  });
  it("marks missing Linux services uninstalled and stale service contents for repair", async () => {
    const home = serviceTmp();
    const missing = await inspectService({ ...spec, home }, fakeRun({ "loginctl show-user": () => ({ stdout: "Linger=no\n" }) }).run);
    expect(missing).toMatchObject({ installed: false, running: false, stale: false, details: { linger: false } });
    const unit = path.join(home, ".config/systemd/user/rp-host.service");
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\n[Service]\nExecStart=/missing/node /missing/rp-host.mjs run\n`);
    const stale = await inspectService({ ...spec, home }, fakeRun({ "loginctl show-user": () => ({ stdout: "Linger=yes\n" }) }).run);
    expect(stale).toMatchObject({ installed: true, stale: true, nodePath: "/missing/node", nodePathValid: false, scriptPath: "/missing/rp-host.mjs", scriptPathValid: false });
    expect(stale.staleReason).toMatch(/node|script|StartLimit|PATH/i);
  });
  it("inspects a Darwin launchd agent and detects stale or incomplete plists", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const plist = path.join(home, "Library/LaunchAgents/dev.j3pf.rp-host.plist");
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, launchdPlist({ ...spec, platform: "darwin", home, nodePath, scriptPath, envPath: "/usr/bin" }));
    const f = fakeRun({ "launchctl list dev.j3pf.rp-host": () => ({}) });
    await expect(inspectService({ ...spec, platform: "darwin", home, nodePath, scriptPath }, f.run)).resolves.toMatchObject({ installed: true, running: true, stale: false, nodePath, nodePathValid: true, scriptPath, scriptPathValid: true });
    const loadedNoPid = fakeRun({
      "launchctl list dev.j3pf.rp-host": () => ({
        code: 0,
        stdout: '{\n\t"Label" = "dev.j3pf.rp-host";\n\t"LastExitStatus" = 0;\n};\n',
      }),
    });
    await expect(inspectService({ ...spec, platform: "darwin", home, nodePath, scriptPath }, loadedNoPid.run)).resolves.toMatchObject({ installed: true, running: false, stale: false });
    const loadedWithPid = fakeRun({
      "launchctl list dev.j3pf.rp-host": () => ({
        code: 0,
        stdout: '{\n\t"Label" = "dev.j3pf.rp-host";\n\t"PID" = 4321;\n};\n',
      }),
    });
    await expect(inspectService({ ...spec, platform: "darwin", home, nodePath, scriptPath }, loadedWithPid.run)).resolves.toMatchObject({ installed: true, running: true, stale: false });
    fs.writeFileSync(plist, `<dict><key>ProgramArguments</key><array><string>/missing/node</string><string>/missing/script</string></array></dict>`);
    await expect(inspectService({ ...spec, platform: "darwin", home }, fakeRun({ "launchctl list": () => ({ code: 1 }) }).run)).resolves.toMatchObject({ installed: true, running: false, stale: true, nodePathValid: false, scriptPathValid: false });
  });
  it("inspects Windows task status, paths and required recovery policies", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node.exe");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const xml = schtasksXml({ ...spec, platform: "win32", nodePath, scriptPath });
    const f = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName 'rp-host').State": () => ({ stdout: "Running\r\n" }),
    });
    await expect(inspectService({ ...spec, platform: "win32", home }, f.run)).resolves.toMatchObject({
      installed: true,
      running: true,
      stale: false,
      nodePath,
      nodePathValid: true,
      scriptPath,
      scriptPathValid: true,
      enabled: true,
      details: { executionTimeLimit: "PT0S", disallowStartIfOnBatteries: false, stopIfGoingOnBatteries: false, enabled: true, taskState: "Running" },
    });
    const missing = await inspectService({ ...spec, platform: "win32", home }, fakeRun({ "schtasks /Query": () => ({ code: 1 }) }).run);
    expect(missing).toMatchObject({ installed: false, running: false, stale: false });
    expect(f.calls.map(({ cmd, args }) => `${cmd} ${args.join(" ")}`)).toEqual([
      "schtasks /Query /TN rp-host /XML",
      "powershell -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName 'rp-host').State",
    ]);
  });
  it("inspects Windows task state using locale-independent powershell or localized schtasks fallback", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node.exe");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const xml = schtasksXml({ ...spec, platform: "win32", nodePath, scriptPath });

    // 1. PowerShell returns "Ready" (stopped, not running)
    const psReady = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName 'rp-host').State": () => ({ stdout: "Ready\r\n" }),
    });
    const readyResult = await inspectService({ ...spec, platform: "win32", home }, psReady.run);
    expect(readyResult.running).toBe(false);
    expect(readyResult.details?.taskState).toBe("Ready");

    // 2. PowerShell fails, English schtasks fixture ("Status: Running")
    const englishFixture = `Folder: \\
HostName: TEST-PC
TaskName: \\rp-host
Next Run Time: N/A
Status: Running
Logon Mode: Interactive/Background
`;
    const fallbackEnglish = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell": () => ({ code: 1, stderr: "powershell not available" }),
      "schtasks /Query /TN rp-host /V /FO LIST": () => ({ stdout: englishFixture }),
    });
    const enResult = await inspectService({ ...spec, platform: "win32", home }, fallbackEnglish.run);
    expect(enResult.running).toBe(true);
    expect(enResult.details?.taskState).toBe("Running");

    // 3. PowerShell fails, Spanish schtasks fixture ("Estado: En ejecución")
    const spanishRunningFixture = `Carpeta: \\
Nombre de host: TEST-PC
Nombre de tarea: \\rp-host
Hora próxima ejecución: N/A
Estado: En ejecución
Modo de inicio de sesión: Interactivo/Fondo
`;
    const fallbackSpanish = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell": () => ({ code: 1, stderr: "powershell not available" }),
      "schtasks /Query /TN rp-host /V /FO LIST": () => ({ stdout: spanishRunningFixture }),
    });
    const esResult = await inspectService({ ...spec, platform: "win32", home }, fallbackSpanish.run);
    expect(esResult.running).toBe(true);
    expect(esResult.details?.taskState).toBe("Running");

    // 4. PowerShell fails, Spanish schtasks fixture ("Estado: Listo")
    const spanishReadyFixture = `Carpeta: \\
Nombre de tarea: \\rp-host
Estado: Listo
`;
    const fallbackSpanishReady = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell": () => ({ code: 1, stderr: "powershell not available" }),
      "schtasks /Query /TN rp-host /V /FO LIST": () => ({ stdout: spanishReadyFixture }),
    });
    const esReadyResult = await inspectService({ ...spec, platform: "win32", home }, fallbackSpanishReady.run);
    expect(esReadyResult.running).toBe(false);
    expect(esReadyResult.details?.taskState).toBe("Ready");

    // 5. PowerShell fails, unknown localized label ("Statut: Inconnu") -> treated as unknown, not "not running"
    const unknownFixture = `Folder: \\
TaskName: \\rp-host
Statut: Inconnu
`;
    const fallbackUnknown = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: xml }),
      "powershell": () => ({ code: 1, stderr: "powershell not available" }),
      "schtasks /Query /TN rp-host /V /FO LIST": () => ({ stdout: unknownFixture }),
    });
    const unknownResult = await inspectService({ ...spec, platform: "win32", home }, fallbackUnknown.run);
    expect(unknownResult.running).toBe(true);
    expect(unknownResult.details?.taskState).toBe("Unknown");
  });
  it("tolerates UTF-16 encoded XML with BOM and NUL bytes from schtasks /Query /XML", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node.exe");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const xml = schtasksXml({ ...spec, platform: "win32", nodePath, scriptPath });
    // Simulate schtasks outputting UTF-16LE with BOM decoded as UTF-8 string containing NUL bytes
    const utf16Buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    const utf16Stdout = utf16Buffer.toString("utf8");

    const f = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: utf16Stdout }),
      "powershell -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName 'rp-host').State": () => ({ stdout: "Running\r\n" }),
    });
    const inspection = await inspectService({ ...spec, platform: "win32", home }, f.run);
    expect(inspection.installed).toBe(true);
    expect(inspection.stale).toBe(false);
    expect(inspection.nodePathValid).toBe(true);
    expect(inspection.scriptPathValid).toBe(true);
    expect(inspection.nodePath).toBe(nodePath);
    expect(inspection.scriptPath).toBe(scriptPath);
  });
  it("detects legacy Windows tasks running node.exe directly as stale and self-heals them", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node.exe");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const legacyXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Settings>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>"${scriptPath}" run</Arguments>
    </Exec>
  </Actions>
</Task>`;
    const f = fakeRun({
      "schtasks /Query /TN rp-host /XML": () => ({ stdout: legacyXml }),
      "schtasks /Query /TN rp-host /V /FO LIST": () => ({ stdout: "Status: Running\n" }),
      "schtasks /Create": () => ({}),
      "schtasks /Run": () => ({}),
    });
    const inspection = await inspectService({ ...spec, platform: "win32", home, nodePath, scriptPath }, f.run);
    expect(inspection.installed).toBe(true);
    expect(inspection.stale).toBe(true);
    expect(inspection.staleReason).toContain("windowless conhost launcher");

    const healed = await ensureHostService({ ...spec, platform: "win32", home, nodePath, scriptPath }, f.run);
    expect(healed.action).toBe("reinstalled");
    expect(f.calls.some(({ cmd, args }) => cmd === "schtasks" && args.includes("/Create"))).toBe(true);
  });
  it("self-heals services according to installed, stale, running and healthy state", async () => {
    const home = serviceTmp();
    const nodePath = path.join(home, "node");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const linuxSpec = { ...spec, home, nodePath, scriptPath };
    const handlers = (active: boolean) => ({
      "systemctl --user is-enabled rp-host": () => ({ stdout: "enabled\n" }),
      "systemctl --user is-active rp-host": () => active ? ({ stdout: "active\n" }) : ({ code: 3, stdout: "inactive\n" }),
      "loginctl show-user": () => ({ stdout: "Linger=yes\n" }),
      "systemctl --user daemon-reload": () => ({}),
      "systemctl --user enable --now rp-host": () => ({}),
      "systemctl --user start rp-host": () => ({}),
    });
    const absent = await ensureHostService(linuxSpec, fakeRun(handlers(false)).run);
    expect(absent.action).toBe("installed");
    const unit = systemdUnit({ ...linuxSpec, envPath: process.env.PATH });
    const unitPath = path.join(home, ".config", "systemd", "user", "rp-host.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unit.replace(nodePath, "/missing/old-node"));
    const stale = await ensureHostService(linuxSpec, fakeRun(handlers(false)).run);
    expect(stale.action).toBe("reinstalled");
    fs.writeFileSync(unitPath, unit);
    const stopped = fakeRun(handlers(false));
    expect((await ensureHostService(linuxSpec, stopped.run)).action).toBe("started");
    expect(stopped.calls.some(({ cmd, args }) => cmd === "systemctl" && args.includes("start"))).toBe(true);
    const healthy = fakeRun(handlers(true));
    expect((await ensureHostService(linuxSpec, healthy.run)).action).toBe("none");
    expect(healthy.calls.some(({ args }) => args.includes("start"))).toBe(false);
  });
  it("install/uninstall run the right commands per OS", async () => {
    const home = tmp();
    try {
      const f = fakeRun({
        "loginctl show-user": () => ({ stdout: "Linger=no\n" }),
        "loginctl enable-linger": () => ({ code: 1, stderr: "access denied" }),
        systemctl: () => ({}), schtasks: () => ({}), launchctl: () => ({}),
      });
      const linuxResult = await installService({ ...spec, home, envPath: "/captured/path" }, f.run);
      expect(linuxResult).toContain("warning");
      expect(linuxResult).toContain("privileges");
      const unitPath = path.join(home, ".config", "systemd", "user", "rp-host.service");
      expect(fs.existsSync(unitPath)).toBe(true);
      expect(fs.readFileSync(unitPath, "utf8")).toContain('Environment="PATH=/captured/path"');
      expect(f.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
        `loginctl show-user ${process.env.USER ?? os.userInfo().username} -p Linger`,
        `loginctl enable-linger ${process.env.USER ?? os.userInfo().username}`,
        "systemctl --user daemon-reload",
        "systemctl --user enable --now rp-host",
      ]);
      await uninstallService("linux", f.run, home);
      expect(fs.existsSync(unitPath)).toBe(false);
      const w = fakeRun({ schtasks: () => ({}) });
      await installService({ ...spec, platform: "win32", home }, w.run);
      expect(w.calls[0]!.args.slice(0, 2)).toEqual(["/Create", "/XML"]);
      expect(w.calls[0]!.args.slice(3)).toEqual(["/TN", "rp-host", "/F"]);
      expect(fs.existsSync(w.calls[0]!.args[2]!)).toBe(false);
      await uninstallService("win32", w.run, home);
      expect(w.calls.some((c) => c.args[0] === "/Delete")).toBe(true);
      const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
      const m = fakeRun({ launchctl: () => ({}) });
      await installService({ ...spec, platform: "darwin", home }, m.run);
      const plist = path.join(home, "Library", "LaunchAgents", "dev.j3pf.rp-host.plist");
      expect(fs.existsSync(plist)).toBe(true);
      expect(fs.existsSync(path.join(home, "Library", "Logs"))).toBe(true);
      expect(m.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
        `launchctl bootstrap gui/${uid} ${plist}`,
        `launchctl kickstart -k gui/${uid}/dev.j3pf.rp-host`,
      ]);
      await uninstallService("darwin", m.run, home);
      expect(m.calls.slice(-1)[0]!.args).toEqual(["bootout", `gui/${uid}/dev.j3pf.rp-host`]);
      expect(fs.existsSync(plist)).toBe(false);
      const fallback = fakeRun({
        "launchctl bootstrap": () => ({ code: 1, stderr: "already loaded" }),
        "launchctl load": () => ({}),
        "launchctl kickstart": () => ({}),
      });
      await installService({ ...spec, platform: "darwin", home }, fallback.run);
      expect(fallback.calls.map((c) => c.args[0])).toEqual(["bootstrap", "load", "kickstart"]);
      const unloadFallback = fakeRun({ "launchctl bootout": () => ({ code: 1, stderr: "not loaded" }), "launchctl unload": () => ({}) });
      await uninstallService("darwin", unloadFallback.run, home);
      expect(unloadFallback.calls.map((c) => c.args[0])).toEqual(["bootout", "unload"]);
      await expect(installService({ ...spec, home }, fakeRun({ systemctl: () => ({ code: 1, stderr: "no bus" }) }).run)).rejects.toThrow(/no bus/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("computes diff and discards changes cleanly", async () => {
    const dir = tmp();
    try {
      execSync("git init", { cwd: dir });
      execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: dir });
      fs.writeFileSync(path.join(dir, "file.txt"), "hello\nworld\n");
      execSync("git add file.txt && git commit -m initial", { cwd: dir });

      const cfg = normalizeHostConfig({ roots: [dir] });

      // Clean status
      const diff1 = await gitDiff(cfg, dir);
      expect(diff1.files.length).toBe(0);

      // Modify tracked file
      fs.writeFileSync(path.join(dir, "file.txt"), "hello\nnew world\n");
      // Add untracked file
      fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");

      const diff2 = await gitDiff(cfg, dir);
      expect(diff2.files.length).toBe(2);
      const mod = diff2.files.find((f) => f.path === "file.txt");
      expect(mod?.status).toBe("modified");
      expect(mod?.patch).toContain("+new world");
      const added = diff2.files.find((f) => f.path === "new.txt");
      expect(added?.status).toBe("added");
      expect(added?.patch).toContain("+fresh");

      // Discard untracked
      const disc1 = await gitDiscard(cfg, dir, "new.txt");
      expect(disc1).toEqual({ cwd: fs.realpathSync(dir), ok: true, path: "new.txt" });
      expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false);

      // Discard modified
      await gitDiscard(cfg, dir, "file.txt");
      expect(fs.readFileSync(path.join(dir, "file.txt"), "utf8")).toBe("hello\nworld\n");

      // Filenames with leading/internal spaces and untracked nested directories
      fs.mkdirSync(path.join(dir, "sub dir"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub dir", " spaced.txt"), "space content\n");
      const diffSpace = await gitDiff(cfg, dir);
      expect(diffSpace.cwd).toBe(fs.realpathSync(dir));
      const spaceFile = diffSpace.files.find((f) => f.path === "sub dir/ spaced.txt");
      expect(spaceFile).toBeDefined();
      expect(spaceFile?.binary).toBe(false);
      expect(spaceFile?.truncated).toBe(false);
      expect(spaceFile?.patch).toContain("+space content");
      await gitDiscard(cfg, dir, "sub dir/ spaced.txt");
      expect(fs.existsSync(path.join(dir, "sub dir", " spaced.txt"))).toBe(false);

      // Rejects traversal, '.' / '..', option flags, and pathspec magic
      await expect(gitDiscard(cfg, dir, ".")).rejects.toThrow(/invalid relative path/);
      await expect(gitDiscard(cfg, dir, "sub/../..")).rejects.toThrow(/invalid relative path/);
      await expect(gitDiscard(cfg, dir, ":(icase)file.txt")).rejects.toThrow(/invalid relative path/);
      await expect(gitDiscard(cfg, dir, "-f")).rejects.toThrow(/invalid relative path/);

      const cleanDiff = await gitDiff(cfg, dir);
      expect(cleanDiff.files.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withDetectedRoots", () => {
  const home = () => tmp();
  it("keeps the default when it exists", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "proyectos"));
    fs.mkdirSync(path.join(h, "Projects"));
    expect(withDetectedRoots(normalizeHostConfig({}, h), h).roots).toEqual([path.join(h, "proyectos")]);
  });
  it("falls back to the first usual project folder that exists", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "code"));
    fs.mkdirSync(path.join(h, "Projects"));
    expect(withDetectedRoots(normalizeHostConfig({ roots: ["~/proyectos"] }, h), h).roots).toEqual([path.join(h, "Projects")]);
  });
  it("keeps the default when nothing exists", () => {
    const h = home();
    expect(withDetectedRoots(normalizeHostConfig({}, h), h).roots).toEqual([path.join(h, "proyectos")]);
  });
  it("never replaces roots chosen by the user", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "Projects"));
    const cfg = normalizeHostConfig({ roots: ["~/mine"] }, h);
    expect(withDetectedRoots(cfg, h).roots).toEqual([path.join(h, "mine")]);
  });
});
