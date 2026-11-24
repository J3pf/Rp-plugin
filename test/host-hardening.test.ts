import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addRoot, normalizeHostConfig, removeRoot } from "../src/host/config.ts";
import { HostConnection } from "../src/host/connection.ts";
import { execGit, gitDiff, gitDiscard } from "../src/host/git.ts";
import { cleanupExpiredInboxFiles, main, scheduleInboxCleanup } from "../src/host/main.ts";
import { HostManager } from "../src/host/manager.ts";
import { HostError, resolveWithinRoots, sanitizeLabel, validateSessionId } from "../src/host/validate.ts";
import { HerdrBackend, type HerdrServerProcess } from "../src/host/backends/herdr.ts";
import { ConsoleBackend, consoleArgs, type ConsoleSpawnOptions } from "../src/host/backends/windows.ts";
import type { Runner } from "../src/host/runner.ts";
import { CLOSE, MAX_FRAME_BYTES, envelope } from "../src/shared/protocol.ts";
import { FakeRelay, waitUntil } from "./helpers.ts";

const tempDirs: string[] = [];
function mkTmp(prefix = "rp-harden-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeRun(handlers: Record<string, (args: string[]) => { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd });
    const key = Object.keys(handlers).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    const r = key ? handlers[key]!(args) : { code: 127, stderr: "not found" };
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: dir, stdio: "ignore" });
}

class FakeChildProcess extends EventEmitter implements HerdrServerProcess {
  unreffed = false;
  signals: Array<NodeJS.Signals | number | undefined> = [];
  unref(): void {
    this.unreffed = true;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("B-01: Windows ConsoleBackend command injection hardening", () => {
  const baseReq = {
    cwd: "C:\\proyectos\\api",
    name: 'evil" calc.exe /k whoami',
    launcherCommand: "gentle-shell --link",
    spawnId: "SPAWNID12345",
  };

  it("consoleArgs uses a constant empty title and never interpolates req.name", () => {
    const args = consoleArgs(baseReq);
    expect(args).toEqual(["/c", "start", "", "/D", "C:\\proyectos\\api", "gentle-shell", "--link", "--rp-spawn-id", "SPAWNID12345"]);
    expect(args.join(" ")).not.toContain("evil");
    expect(args.join(" ")).not.toContain("calc.exe");
    expect(args.join(" ")).not.toContain("whoami");
  });

  it("ConsoleBackend.spawn invokes the allowlisted launcher directly without cmd.exe", async () => {
    const f = fakeRun({});
    const spawned: Array<{ cmd: string; args: string[]; opts: ConsoleSpawnOptions }> = [];
    const con = new ConsoleBackend(
      { run: f.run, platform: "win32", herdrSession: null },
      async (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
      },
    );

    const rec = await con.spawn(baseReq);
    expect(rec.backend).toBe("console");
    expect(f.calls).toHaveLength(0);
    expect(spawned).toEqual([
      {
        cmd: "gentle-shell",
        args: ["--link", "--rp-spawn-id", "SPAWNID12345"],
        opts: { cwd: "C:\\proyectos\\api", detached: true, stdio: "ignore", windowsHide: false },
      },
    ]);
  });

  it("ConsoleBackend.spawn omits --rp-spawn-id for external CLI launchers", async () => {
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const con = new ConsoleBackend(
      { run: fakeRun({}).run, platform: "win32", herdrSession: null },
      async (cmd, args) => {
        spawned.push({ cmd, args });
      },
    );
    await con.spawn({ ...baseReq, launcherCommand: "claude --continue" });
    expect(spawned).toEqual([{ cmd: "claude", args: ["--continue"] }]);
  });

  it("ConsoleBackend.spawn surfaces direct spawn errors as HostError(internal)", async () => {
    const con = new ConsoleBackend({ run: fakeRun({}).run, platform: "win32", herdrSession: null });
    await expect(
      con.spawn({
        cwd: mkTmp(),
        name: "bad",
        launcherCommand: "nonexistent-rp-binary-xyz-999999",
        spawnId: "SPAWNID12345",
      }),
    ).rejects.toThrow(/console spawn failed/);
  });
});

describe("W-03 & S-01: validation root oracle & label/sessionId hardening", () => {
  it("resolveWithinRoots gives the same outside-roots error for existing dir, existing file, and missing path outside roots", () => {
    const base = mkTmp();
    const root = path.join(base, "allowed");
    const outsideDir = path.join(base, "outside-dir");
    const outsideFile = path.join(base, "outside-file.txt");
    const outsideMissing = path.join(base, "outside-missing");
    fs.mkdirSync(root);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsideFile, "secret");

    const cfg = normalizeHostConfig({ roots: [root] });
    for (const target of [outsideDir, outsideFile, outsideMissing, path.join(root, "..", "outside-file.txt")]) {
      let caught: unknown;
      try {
        resolveWithinRoots(cfg, target);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HostError);
      expect((caught as HostError).code).toBe("bad_request");
      expect((caught as HostError).message).toBe("path is outside the allowed roots");
    }
  });

  it("resolveWithinRoots rejects symlink inside root pointing to an outside file as outside-roots before isDirectory", () => {
    if (process.platform === "win32") return;
    const base = mkTmp();
    const root = path.join(base, "allowed");
    const outsideFile = path.join(base, "secret.txt");
    fs.mkdirSync(root);
    fs.writeFileSync(outsideFile, "secret");
    const link = path.join(root, "escape-link");
    fs.symlinkSync(outsideFile, link);

    const cfg = normalizeHostConfig({ roots: [root] });
    expect(() => resolveWithinRoots(cfg, link)).toThrow("path is outside the allowed roots");
  });

  it("sanitizeLabel sanitizes both name and fallback, strips leading dashes, and falls back to 'agent'", () => {
    expect(sanitizeLabel("--exec=evil", "ok")).toBe("exec=evil");
    expect(sanitizeLabel("- --flag", "ok")).toBe("flag");
    expect(sanitizeLabel("   ", "--bad;fallback")).toBe("bad fallback");
    expect(sanitizeLabel("---", '---;"`')).toBe("agent");
    expect(sanitizeLabel(undefined, "- -")).toBe("agent");
    expect(sanitizeLabel("my-project", "fallback")).toBe("my-project");
  });

  it("validateSessionId enforces SAFE_CONV_ID_RE", () => {
    expect(validateSessionId("abc_123-XYZ")).toBe("abc_123-XYZ");
    expect(() => validateSessionId("-leading-dash")).toThrow(HostError);
    expect(() => validateSessionId("a".repeat(129))).toThrow(HostError);
    expect(() => validateSessionId("../escape")).toThrow(HostError);
  });
});

describe("C-08, W-04 & W-13: git confinement, monorepo subdirs, budgeting & SIGKILL", () => {
  it("W-04: git discovery never escapes above cfg.roots into an ancestor .git repo", async () => {
    const parent = mkTmp();
    initGitRepo(parent);
    fs.writeFileSync(path.join(parent, "secret-outside.txt"), "top-secret\n");
    execSync("git add secret-outside.txt && git commit -m init", { cwd: parent, stdio: "ignore" });
    fs.writeFileSync(path.join(parent, "secret-outside.txt"), "top-secret-modified\n");

    const allowed = path.join(parent, "allowed-root");
    fs.mkdirSync(allowed);
    fs.writeFileSync(path.join(allowed, "inside.txt"), "hello\n");
    const cfg = normalizeHostConfig({ roots: [allowed] });

    const diff = await gitDiff(cfg, allowed);
    expect(diff.files).toEqual([]);
    expect(diff.branch).toBeNull();

    await expect(gitDiscard(cfg, allowed, "inside.txt")).rejects.toThrow(HostError);
    expect(fs.readFileSync(path.join(allowed, "inside.txt"), "utf8")).toBe("hello\n");
  });

  it("W-04: rejects a .git file whose gitdir points to a repo outside cfg.roots", async () => {
    const base = mkTmp();
    const externalRepo = path.join(base, "external-repo");
    fs.mkdirSync(externalRepo);
    initGitRepo(externalRepo);
    fs.writeFileSync(path.join(externalRepo, "tracked.txt"), "v1\n");
    execSync("git add tracked.txt && git commit -m init", { cwd: externalRepo, stdio: "ignore" });

    const allowed = path.join(base, "allowed");
    fs.mkdirSync(allowed);
    fs.writeFileSync(path.join(allowed, "dummy.txt"), "hi\n");
    // Point allowed/.git at externalRepo/.git (worktree-like gitfile)
    fs.writeFileSync(path.join(allowed, ".git"), `gitdir: ${path.join(externalRepo, ".git")}\n`);
    // Make externalRepo the core.worktree so rev-parse --show-toplevel resolves outside allowed
    execSync(`git config core.worktree "${externalRepo}"`, { cwd: externalRepo, stdio: "ignore" });

    const cfg = normalizeHostConfig({ roots: [allowed] });
    const diff = await gitDiff(cfg, allowed);
    expect(diff.files).toEqual([]);
    await expect(gitDiscard(cfg, allowed, "dummy.txt")).rejects.toThrow(/outside allowed roots/);
  });

  it("C-08: gitDiff and gitDiscard work inside monorepo subdirectories and normalize ./ and backslash paths", async () => {
    const root = mkTmp();
    initGitRepo(root);
    const appDir = path.join(root, "packages", "app");
    const otherDir = path.join(root, "packages", "other");
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });

    fs.writeFileSync(path.join(appDir, "src", "index.ts"), "export const v = 1;\n");
    fs.writeFileSync(path.join(otherDir, "other.ts"), "export const o = 1;\n");
    execSync("git add . && git commit -m init", { cwd: root, stdio: "ignore" });

    // Modify files in both packages + add untracked in app
    fs.writeFileSync(path.join(appDir, "src", "index.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(appDir, "untracked.txt"), "new-file\n");
    fs.writeFileSync(path.join(otherDir, "other.ts"), "export const o = 2;\n");

    const cfg = normalizeHostConfig({ roots: [root] });
    const diff = await gitDiff(cfg, appDir);

    // Must only contain appDir files, with paths relative to appDir (not repoRoot)
    const paths = diff.files.map((f) => f.path).sort();
    expect(paths).toEqual(["src/index.ts", "untracked.txt"]);
    const tracked = diff.files.find((f) => f.path === "src/index.ts")!;
    expect(tracked.status).toBe("modified");
    expect(tracked.patch).toContain("+export const v = 2;");
    const untracked = diff.files.find((f) => f.path === "untracked.txt")!;
    expect(untracked.status).toBe("added");
    expect(untracked.patch).toContain("+new-file");

    // Filter path with ./ and Windows-style backslash
    const filteredDot = await gitDiff(cfg, appDir, "./src/index.ts");
    expect(filteredDot.files.map((f) => f.path)).toEqual(["src/index.ts"]);
    const filteredSlash = await gitDiff(cfg, appDir, "src\\index.ts");
    expect(filteredSlash.files.map((f) => f.path)).toEqual(["src/index.ts"]);

    // Discard untracked via ./ prefix in subdirectory
    const discUntracked = await gitDiscard(cfg, appDir, "./untracked.txt");
    expect(discUntracked).toEqual({ cwd: fs.realpathSync(appDir), ok: true, path: "untracked.txt" });
    expect(fs.existsSync(path.join(appDir, "untracked.txt"))).toBe(false);

    // Discard tracked via backslash path in subdirectory
    const discTracked = await gitDiscard(cfg, appDir, "src\\index.ts");
    expect(discTracked).toEqual({ cwd: fs.realpathSync(appDir), ok: true, path: "src/index.ts" });
    expect(fs.readFileSync(path.join(appDir, "src", "index.ts"), "utf8")).toBe("export const v = 1;\n");

    // Other package remains untouched
    expect(fs.readFileSync(path.join(otherDir, "other.ts"), "utf8")).toBe("export const o = 2;\n");
  });

  it("W-13: gitDiff budgets JSON-serialized bytes below MAX_FRAME_BYTES and reports actual truncation limit", async () => {
    const dir = mkTmp();
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
    execSync("git add seed.txt && git commit -m init", { cwd: dir, stdio: "ignore" });

    // Create 12 files each containing heavy JSON-escaped characters (`"` and `\` expand 2x in JSON)
    const heavyLine = '"\\'.repeat(400) + "\n";
    const heavyBody = heavyLine.repeat(100); // ~80 KB raw, ~160 KB JSON-escaped per file
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `heavy-${String(i).padStart(2, "0")}.txt`), heavyBody);
    }

    const cfg = normalizeHostConfig({ roots: [dir] });
    const diff = await gitDiff(cfg, dir);
    const jsonBytes = Buffer.byteLength(JSON.stringify(diff), "utf8");
    expect(jsonBytes).toBeLessThan(MAX_FRAME_BYTES);
    expect(diff.files.some((f) => f.truncated)).toBe(true);
    // Truncated files must not falsely claim 64KB when truncated below 64KB, and never exceed MAX_FRAME_BYTES
    for (const f of diff.files) {
      if (f.truncated && f.patch) {
        expect(f.patch).not.toContain("truncado a 64KB");
        expect(f.patch).toMatch(/truncated at \d+(?:KB|B)/);
      }
    }
  });

  it("W-13: execGit escalates SIGTERM to SIGKILL on hung git processes", async () => {
    if (process.platform === "win32") return;
    const binDir = mkTmp("rp-fakegit-");
    const fakeGit = path.join(binDir, "git");
    fs.writeFileSync(fakeGit, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });

    const origPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
    try {
      const start = Date.now();
      const res = await execGit(binDir, ["status"], 150);
      const elapsed = Date.now() - start;
      expect(res.code).toBe(-1);
      expect(res.stderr).toMatch(/SIGKILL/i);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("W-07: HerdrBackend.ensureServer cooldown, fast abort & SIGKILL", () => {
  it("aborts immediately on child error/exit and enforces cooldown on subsequent calls", async () => {
    let statusCalls = 0;
    let spawnCalls = 0;
    const f = fakeRun({
      "herdr status server": () => {
        statusCalls++;
        return { code: 1 };
      },
    });
    const b = new HerdrBackend(
      { run: f.run, platform: "linux", herdrSession: null },
      {
        pollIntervalMs: 500,
        pollAttempts: 20,
        cooldownMs: 10_000,
        spawnServer: () => {
          spawnCalls++;
          const child = new FakeChildProcess();
          setTimeout(() => child.emit("error", new Error("ENOENT")), 10);
          return child;
        },
      },
    );

    const t0 = Date.now();
    await expect(b.ensureServer()).rejects.toThrow(/did not start/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(400);
    expect(spawnCalls).toBe(1);
    expect(statusCalls).toBeLessThanOrEqual(2);

    // Cooldown must still be active -> no second spawn!
    await expect(b.ensureServer()).rejects.toThrow(/not running/);
    expect(spawnCalls).toBe(1);
  });

  it("escalates SIGTERM to SIGKILL on timeout and preserves cooldown", async () => {
    let spawnCalls = 0;
    const children: FakeChildProcess[] = [];
    const f = fakeRun({ "herdr status server": () => ({ code: 1 }) });
    const b = new HerdrBackend(
      { run: f.run, platform: "linux", herdrSession: null },
      {
        pollIntervalMs: 15,
        pollAttempts: 2,
        sigkillGraceMs: 40,
        cooldownMs: 10_000,
        spawnServer: () => {
          spawnCalls++;
          const child = new FakeChildProcess();
          children.push(child);
          return child;
        },
      },
    );

    await expect(b.ensureServer()).rejects.toThrow(/did not start/);
    expect(children[0]!.signals).toContain("SIGTERM");
    await waitUntil(() => children[0]!.signals.includes("SIGKILL"), 1000, "SIGKILL escalation");
    expect(children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);

    // Cooldown prevents immediate respawn after timeout
    await expect(b.ensureServer()).rejects.toThrow(/not running/);
    expect(spawnCalls).toBe(1);
  });

  it("clears cooldown only when server starts successfully", async () => {
    let up = false;
    let spawnCalls = 0;
    const f = fakeRun({ "herdr status server": () => ({ code: up ? 0 : 1 }) });
    const b = new HerdrBackend(
      { run: f.run, platform: "linux", herdrSession: null },
      {
        pollIntervalMs: 20,
        pollAttempts: 10,
        cooldownMs: 10_000,
        spawnServer: () => {
          spawnCalls++;
          const child = new FakeChildProcess();
          setTimeout(() => {
            up = true;
          }, 30);
          return child;
        },
      },
    );

    await expect(b.ensureServer()).resolves.toBeUndefined();
    expect(spawnCalls).toBe(1);

    // If server later goes down, cooldown was cleared on success so it can immediately attempt restart
    up = false;
    await expect(b.ensureServer()).resolves.toBeUndefined();
    expect(spawnCalls).toBe(2);
  });
});

describe("C-09, W-11, W-13 & W-14: HostConnection hardening", () => {
  let relay: FakeRelay | undefined;
  let hc: HostConnection | undefined;

  afterEach(async () => {
    hc?.stop();
    hc = undefined;
    await relay?.stop();
    relay = undefined;
  });

  it("C-09: adds 250-1500ms jitter and escalates backoff on consecutive 1012 closes", async () => {
    const root = mkTmp();
    const cfg = normalizeHostConfig({ roots: [root], quotaEnabled: false });
    const manager = new HostManager(cfg, { run: fakeRun({}).run, platform: "linux", storeFile: path.join(mkTmp(), "s.json") });
    const logs: string[] = [];
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(() => {}, 60_000);
    }) as any);

    try {
      hc = new HostConnection({
        relayUrl: "http://127.0.0.1:1",
        machineId: "M1",
        token: "tok",
        cfg,
        manager,
        random: () => 0.5, // deterministic midpoint: 250 + 0.5 * 1250 = 875ms
        onLog: (m) => logs.push(m),
      });

      (hc as any).scheduleReconnect(CLOSE.SERVICE_RESTART);
      (hc as any).scheduleReconnect(CLOSE.SERVICE_RESTART);
      (hc as any).scheduleReconnect(CLOSE.SERVICE_RESTART);

      expect(delays[0]).toBeGreaterThanOrEqual(250);
      expect(delays[0]).toBeLessThanOrEqual(1500);
      expect(delays[0]).toBe(875);
      expect(delays[1]).toBe(1750);
      expect(delays[2]).toBe(3500);
    } finally {
      hc?.stop();
      hc = undefined;
      spy.mockRestore();
    }
  });

  it("W-11: ws.on('open') terminates stale sockets if stopped before open", async () => {
    relay = await new FakeRelay().start();
    const root = mkTmp();
    const cfg = normalizeHostConfig({ roots: [root], quotaEnabled: false });
    const manager = new HostManager(cfg, { run: fakeRun({}).run, platform: "linux", storeFile: path.join(mkTmp(), "s.json") });
    hc = new HostConnection({ relayUrl: relay.url, machineId: "M-RACE", token: "tok", cfg, manager });

    // Start connect and immediately stop before open fires
    hc.start();
    hc.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.of("host.hello")).toHaveLength(0);
  });

  it("W-13: caps concurrent in-flight handle(env) RPC executions and queues/rejects excess", async () => {
    const root = mkTmp();
    const cfg = normalizeHostConfig({ roots: [root], quotaEnabled: false });
    const manager = new HostManager(cfg, { run: fakeRun({}).run, platform: "linux", storeFile: path.join(mkTmp(), "s.json") });

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    (manager as any).herdrLayout = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { workspaces: [] };
    };

    const sent: any[] = [];
    hc = new HostConnection({
      relayUrl: "http://127.0.0.1:1",
      machineId: "M-CAP",
      token: "tok",
      cfg,
      manager,
      maxConcurrentRpcs: 2,
      maxQueuedRpcs: 2,
    });
    (hc as any).sendEnv = (e: any) => sent.push(e);

    // Launch 5 concurrent RPCs: 2 active + 2 queued + 1 overflow rejected immediately
    const promises = Array.from({ length: 5 }, (_, i) =>
      hc!.handle(envelope("host.herdr_layout", { machineId: "M-CAP" }, { id: `REQ-${i}` })),
    );

    await waitUntil(() => releases.length === 2, 1000, "2 active RPCs");
    expect(maxActive).toBe(2);
    // 5th request should already have been rejected due to queue limit
    expect(sent.some((e) => e.re === "REQ-4" && e.t === "error")).toBe(true);

    // Release all queued work one by one
    while (releases.length > 0 || sent.length < 5) {
      const r = releases.shift();
      if (r) r();
      else await new Promise((res) => setTimeout(res, 10));
    }
    await Promise.all(promises);

    expect(maxActive).toBe(2);
    expect(sent.filter((e) => e.t === "host.herdr_layout.result")).toHaveLength(4);
  });

  it("W-14: logs ws errors and close/reconnect transitions via onLog", async () => {
    const root = mkTmp();
    const cfg = normalizeHostConfig({ roots: [root], quotaEnabled: false });
    const manager = new HostManager(cfg, { run: fakeRun({}).run, platform: "linux", storeFile: path.join(mkTmp(), "s.json") });
    const logs: string[] = [];

    // Connect to an unused port so ws emits an error (ECONNREFUSED) and closes
    hc = new HostConnection({
      relayUrl: "http://127.0.0.1:1",
      machineId: "M-LOG",
      token: "tok",
      cfg,
      manager,
      backoff: () => 5_000,
      onLog: (m) => logs.push(m),
    });
    hc.start();

    await waitUntil(() => logs.some((l) => l.includes("ws error:")), 3000, "ws error log");
    await waitUntil(() => logs.some((l) => l.includes("ws closed")), 3000, "ws closed log");
  });
});

describe("W-12 & S-04: atomic config/store writes, periodic inbox cleanup & single doctor loadHostConfig", () => {
  it("W-12: addRoot/removeRoot and HostManager.save leave no leftover .tmp files and enforce 0600 permissions", async () => {
    const dir = mkTmp();
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj);
    const hostJson = path.join(dir, "host.json");

    addRoot(hostJson, proj, dir);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(fs.statSync(hostJson).mode & 0o777).toBe(0o600);

    removeRoot(hostJson, proj, dir);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const storeDir = mkTmp();
    const storeFile = path.join(storeDir, "spawns.json");
    const cfg = normalizeHostConfig({ roots: [dir] });
    const f = fakeRun({ "tmux -V": () => ({ stdout: "tmux 3.4" }), "tmux new-session": () => ({}) });
    const mgr = new HostManager(cfg, { run: f.run, platform: "linux", storeFile });
    await mgr.spawn({ cwd: proj });
    expect(fs.existsSync(storeFile)).toBe(true);
    expect(fs.readdirSync(storeDir).filter((x) => x.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
  });

  it("W-12: cleanupExpiredInboxFiles & scheduleInboxCleanup prune expired files periodically", () => {
    const inbox = mkTmp();
    const oldConv = path.join(inbox, "conv-old");
    const freshConv = path.join(inbox, "conv-fresh");
    fs.mkdirSync(oldConv);
    fs.mkdirSync(freshConv);
    const oldFile = path.join(oldConv, "old.txt");
    const freshFile = path.join(freshConv, "fresh.txt");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);

    vi.useFakeTimers();
    const timer = scheduleInboxCleanup(inbox, 1_000);
    try {
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(oldConv)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);

      // Age freshFile and advance timer to verify periodic execution
      fs.utimesSync(freshFile, past, past);
      vi.advanceTimersByTime(1_000);
      expect(fs.existsSync(freshFile)).toBe(false);
    } finally {
      clearInterval(timer);
      vi.useRealTimers();
    }
  });

  it("S-04: doctor reads host.json only once instead of 3 times", async () => {
    const dir = mkTmp();
    const projects = path.join(dir, "projects");
    fs.mkdirSync(projects);
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevRpConfig = process.env.RP_CONFIG;
    const prevExit = process.exitCode;
    const hostJsonPath = path.join(dir, "rp", "host.json");
    fs.mkdirSync(path.dirname(hostJsonPath), { recursive: true });
    fs.writeFileSync(hostJsonPath, JSON.stringify({ roots: [projects] }));

    process.env.XDG_CONFIG_HOME = dir;
    process.env.RP_CONFIG = path.join(dir, "rp", "config.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      await main(["doctor"]);
      const hostJsonReads = readSpy.mock.calls.filter(([p]) => String(p) === hostJsonPath);
      expect(hostJsonReads).toHaveLength(1);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevRpConfig === undefined) delete process.env.RP_CONFIG;
      else process.env.RP_CONFIG = prevRpConfig;
      process.exitCode = prevExit;
    }
  });
});
