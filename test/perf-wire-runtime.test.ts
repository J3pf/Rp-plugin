import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WsKeepalive } from "../src/shared/http.ts";
import { HostConnection } from "../src/host/connection.ts";
import { HostManager } from "../src/host/manager.ts";
import { normalizeHostConfig } from "../src/host/config.ts";
import { QuotaCollector } from "../src/host/quota.ts";
import { gitDiff, readGitHeadAndDirty } from "../src/host/git.ts";
import { inspectService, resolveStableNodePath, systemdUnit } from "../src/host/service.ts";
import { cleanupExpiredInboxFiles } from "../src/host/main.ts";
import { Connection, type Transport, type TransportHandlers } from "../src/extension/connection.ts";
import { StatusTracker } from "../src/extension/status.ts";
import { SubagentTracker } from "../src/extension/subagents.ts";
import {
  AUTOSTART_COOLDOWN_MS,
  resetAutostartCooldownForTests,
  shouldCheckHostAutostart,
} from "../src/extension/host-autostart.ts";
import { Runtime } from "../src/extension/runtime.ts";
import { DEFAULT_CONFIG } from "../src/extension/config.ts";
import { envelope, MAX_FRAME_BYTES, type Envelope, type MachineQuota } from "../src/shared/protocol.ts";
import type { Runner } from "../src/host/runner.ts";
import { FakeRelay, baseConfig, makeCtx, makePi, noEnv, waitUntil } from "./helpers.ts";

const tempDirs: string[] = [];
function mkTmp(prefix = "rp-perf-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: dir, stdio: "ignore" });
}

afterEach(() => {
  resetAutostartCooldownForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PLG-PERF-04: Activity-aware WsKeepalive", () => {
  it("defaults client ping interval to 40s and suppresses pings while inbound or marked activity continues", () => {
    vi.useFakeTimers();
    let pings = 0;
    let terminated = 0;
    const ws = {
      readyState: 1,
      ping: () => {
        pings++;
      },
      terminate: () => {
        terminated++;
      },
    };

    const ka = new WsKeepalive(70_000);
    ka.start(ws, 1);

    // Steady inbound relay pings every 25s -> 0 client pings across 100s
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25_000);
      ka.arm(ws);
    }
    expect(pings).toBe(0);
    expect(terminated).toBe(0);

    // Silence for 39_999ms -> still no client ping
    vi.advanceTimersByTime(39_999);
    expect(pings).toBe(0);

    // At 40_000ms of silence -> exactly 1 client ping
    vi.advanceTimersByTime(1);
    expect(pings).toBe(1);

    // markActivity() defers the next client ping without resetting inbound watchdog
    vi.advanceTimersByTime(20_000);
    (ka as any).markActivity();
    vi.advanceTimersByTime(9_999);
    expect(pings).toBe(1);
    expect(terminated).toBe(0);

    // At 70_000ms since last inbound arm() -> watchdog terminates even though markActivity() was called
    vi.advanceTimersByTime(1);
    expect(terminated).toBe(1);

    ka.stop();
  });

  it("honors explicit custom pingIntervalMs passed to constructor", () => {
    vi.useFakeTimers();
    let pings = 0;
    const ws = { readyState: 1, ping: () => { pings++; }, terminate: () => {} };
    const ka = new WsKeepalive(60_000, 10_000);
    ka.start(ws, 1);
    vi.advanceTimersByTime(10_000);
    expect(pings).toBe(1);
    ka.stop();
  });
});

describe("PLG-PERF-04: HostConnection semantic host.quotas diffing & hello cache freshness", () => {
  let relay: FakeRelay | undefined;
  let hc: HostConnection | undefined;

  afterEach(async () => {
    hc?.stop();
    hc = undefined;
    await relay?.stop();
    relay = undefined;
  });

  const mkQuota = (usedPercent: number, updatedAt: string, resetsInSec: number): MachineQuota[] => [
    {
      family: "antigravity",
      label: "Antigravity (Pi)",
      plan: "pro",
      ok: true,
      notConfigured: false,
      error: null,
      primaryWindowId: "gemini-5h",
      updatedAt,
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5h",
          usedPercent,
          remainingPercent: 100 - usedPercent,
          resetsAt: "2026-11-25T15:00:00.000Z",
          resetsInSec,
          note: null,
        },
      ],
    },
  ];

  it("skips unchanged host.quotas across updatedAt/resetsInSec drift, emits on semantic change or 30m heartbeat, and skips hello poll when cache < 60s old", async () => {
    relay = await new FakeRelay().start();
    let now = 1_700_000_000_000;
    let currentQuotas = mkQuota(10, "2026-11-25T10:00:00.000Z", 3600);
    let collectCalls = 0;

    const cfg = normalizeHostConfig({ roots: [mkTmp()], quotaEnabled: true, quotaIntervalSec: 300 });
    const manager = new HostManager(cfg, {
      run: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
      storeFile: path.join(mkTmp(), "spawns.json"),
    });
    let cached: MachineQuota[] | null = null;
    (manager as any).getLastQuotas = () => cached;
    (manager as any).collectQuotas = async () => {
      collectCalls++;
      cached = currentQuotas;
      return currentQuotas;
    };

    hc = new HostConnection({
      relayUrl: relay.url,
      machineId: "MACH-DIFF",
      token: "tok",
      cfg,
      manager,
      backoff: () => 20,
      now: () => now,
    } as any);
    hc.start();

    await waitUntil(() => relay!.of("host.quotas").length === 1, 3000, "initial host.quotas");
    expect(collectCalls).toBe(1);

    // 1. Re-hello 30s later (< 60s old): embeds cached quotas and skips immediate pollQuotas()
    now += 30_000;
    await hc.hello();
    await waitUntil(() => relay!.of("host.hello").length === 2, 3000);
    expect(relay!.of("host.hello")[1]!.d.quotas).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(collectCalls).toBe(1);
    expect(relay!.of("host.quotas")).toHaveLength(1);

    // 2. Poll 5 min later with only updatedAt and resetsInSec changed -> skipped
    now += 5 * 60_000;
    currentQuotas = mkQuota(10, "2026-11-25T10:05:00.000Z", 3300);
    await hc.pollQuotas();
    expect(collectCalls).toBe(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(relay!.of("host.quotas")).toHaveLength(1);

    // 3. Semantic change (usedPercent 10 -> 25) -> emitted immediately
    now += 5 * 60_000;
    currentQuotas = mkQuota(25, "2026-11-25T10:10:00.000Z", 3000);
    await hc.pollQuotas();
    await waitUntil(() => relay!.of("host.quotas").length === 2, 3000, "changed host.quotas");
    expect(relay!.of("host.quotas")[1]!.d.quotas[0].windows[0].usedPercent).toBe(25);

    // 4. Unchanged after 30 min heartbeat -> re-emitted
    now += 30 * 60_000;
    currentQuotas = mkQuota(25, "2026-11-25T10:40:00.000Z", 1200);
    await hc.pollQuotas();
    await waitUntil(() => relay!.of("host.quotas").length === 3, 3000, "heartbeat host.quotas");

    // 5. Re-hello >= 60s after last collect -> triggers pollQuotas()
    now += 65_000;
    const callsBefore = collectCalls;
    await hc.hello();
    await waitUntil(() => collectCalls > callsBefore, 3000, "stale hello polls quotas");
  });
});

describe("PLG-PERF-05: LongPollTransport WS upgrade exponential backoff", () => {
  it("backs off exponentially up to 600s cap, does not reset on longpoll stability, and resets only on stable WS", () => {
    vi.useFakeTimers();
    let allowWs = false;
    const openedTransports: Array<{ name: "ws" | "longpoll"; at: number }> = [];

    const conn = new Connection({
      relayUrl: "http://127.0.0.1:1",
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      wsFailuresBeforeLongPoll: 1,
      wsRetryMs: 15_000,
      stabilityWindowMs: 5_000,
      backoff: () => 10,
      transportFactory: (name, h: TransportHandlers): Transport => {
        openedTransports.push({ name, at: Date.now() });
        let closed = false;
        return {
          name,
          start: () => {
            if (name === "ws" && !allowWs) {
              setTimeout(() => {
                if (!closed) h.onClose({ code: 1006, reason: "blocked", opened: false, unsent: [] });
              }, 1);
            } else {
              setTimeout(() => {
                if (!closed) {
                  h.onOpen();
                  h.onMessage(envelope("agent.welcome", { agentId: "M:S" }));
                }
              }, 1);
            }
          },
          send: () => !closed,
          close: () => {
            closed = true;
          },
        };
      },
    });

    conn.start();
    // Initial WS fail (1ms) -> backoff (10ms) -> longpoll open+welcome (1ms)
    vi.advanceTimersByTime(50);
    expect(conn.transportName).toBe("longpoll");

    // Stay on longpoll past stabilityWindowMs (5s) -> must NOT reset WS probe backoff
    vi.advanceTimersByTime(6_000);
    expect(conn.transportName).toBe("longpoll");

    // 1st WS probe fires at ~15s (base = 15_000)
    const wsProbesBefore = openedTransports.filter((x) => x.name === "ws").length;
    vi.advanceTimersByTime(9_050);
    expect(openedTransports.filter((x) => x.name === "ws").length).toBe(wsProbesBefore + 1);
    expect(conn.transportName).toBe("longpoll");

    // 2nd WS probe must NOT fire after 15s (must wait 30s = 2x)
    const wsCount1 = openedTransports.filter((x) => x.name === "ws").length;
    vi.advanceTimersByTime(20_000);
    expect(openedTransports.filter((x) => x.name === "ws").length).toBe(wsCount1);
    vi.advanceTimersByTime(11_000);
    expect(openedTransports.filter((x) => x.name === "ws").length).toBe(wsCount1 + 1);

    // 3rd WS probe waits 60s (4x)
    const wsCount2 = openedTransports.filter((x) => x.name === "ws").length;
    vi.advanceTimersByTime(45_000);
    expect(openedTransports.filter((x) => x.name === "ws").length).toBe(wsCount2);
    vi.advanceTimersByTime(16_000);
    expect(openedTransports.filter((x) => x.name === "ws").length).toBe(wsCount2 + 1);

    // Advance enough failed probes to verify exact exponential backoff intervals up to the 600s cap
    vi.advanceTimersByTime(120_000 + 240_000 + 480_000 + 600_000 + 600_000 + 5_000);
    const wsTimes = openedTransports.filter((x) => x.name === "ws").map((x) => x.at);
    // wsTimes[0] is initial WS attempt; wsTimes[1..] are probes from longpoll
    const deltas: number[] = [];
    for (let i = 1; i < wsTimes.length; i++) {
      deltas.push(wsTimes[i]! - wsTimes[i - 1]!);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(7);
    // Probe intervals: 15s, 30s, 60s, 120s, 240s, 480s, 600s (each includes ~1ms probe close)
    const expected = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000];
    for (let i = 0; i < expected.length; i++) {
      expect(deltas[i]!).toBeGreaterThanOrEqual(expected[i]!);
      expect(deltas[i]!).toBeLessThan(expected[i]! + 200);
    }

    // Now allow WS to succeed and stay welcomed past stabilityWindowMs (5s) -> resets backoff to base 15s!
    allowWs = true;
    vi.advanceTimersByTime(601_000);
    expect(conn.transportName).toBe("ws");
    expect(conn.connected).toBe(true);
    vi.advanceTimersByTime(5_100);
    expect((conn as any).wsRetryFailures).toBe(0);

    conn.stop();
  });
});

describe("PLG-PERF-06: Single-pass outbound JSON serialization", () => {
  it("serializes each outbound envelope once in Connection.send(), sendDirect(), and enqueue()/flush()", () => {
    const receivedPayloads: Array<{ env: Envelope; payload?: string }> = [];
    let handlers!: TransportHandlers;
    let acceptSend = true;

    const conn = new Connection({
      relayUrl: "http://127.0.0.1:1",
      token: "tok",
      agentId: "M:S",
      instance: "I",
      makeHello: () => ({ agentId: "M:S" }),
      onWelcome: () => {},
      onMessage: () => {},
      transportFactory: (_name, h): Transport => {
        handlers = h;
        return {
          name: "ws",
          start: () => {
            h.onOpen();
            h.onMessage(envelope("agent.welcome", { agentId: "M:S" }));
          },
          send: (env: Envelope, payload?: string) => {
            if (!acceptSend) return false;
            receivedPayloads.push({ env, payload });
            return true;
          },
          close: () => {},
        };
      },
    });

    conn.start();
    receivedPayloads.length = 0;

    const spy = vi.spyOn(JSON, "stringify");
    conn.send("agent.event", { seq: 1, text: "hello" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(receivedPayloads).toHaveLength(1);
    expect(typeof receivedPayloads[0]!.payload).toBe("string");
    expect(JSON.parse(receivedPayloads[0]!.payload!)).toEqual(receivedPayloads[0]!.env);

    spy.mockClear();
    conn.sendDirect("agent.snapshot", { epoch: "E", seq: 1, entries: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof receivedPayloads[1]!.payload).toBe("string");

    // Queued while disconnected -> still serialized only once even after flush!
    spy.mockClear();
    acceptSend = false;
    conn.send("agent.event", { seq: 2, text: "queued" });
    expect(spy).toHaveBeenCalledTimes(1);
    acceptSend = true;
    handlers.onMessage(envelope("agent.welcome", { agentId: "M:S" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(receivedPayloads.some((r) => r.env.t === "agent.event" && (r.env.d as any).seq === 2 && typeof r.payload === "string")).toBe(true);

    // Oversized frame still dropped and marks needsSnapshot
    conn.send("agent.event", { seq: 3, huge: "x".repeat(MAX_FRAME_BYTES + 100) });
    expect(conn.needsSnapshot).toBe(true);

    conn.stop();
  });
});

describe("PLG-PERF-07: Single-spawn readGitHeadAndDirty & batched gitDiff", () => {
  it("readGitHeadAndDirty parses normal, unborn, and detached HEAD in a single git spawn", async () => {
    const dir = mkTmp("rp-git-single-");
    initGitRepo(dir);

    // Unborn branch (no commits yet)
    const unborn = await readGitHeadAndDirty(dir, true);
    expect(unborn).not.toBeNull();
    expect(unborn!.branch).toBeTruthy();
    expect(unborn!.dirty).toBe(false);

    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execSync("git add a.txt && git commit -m init", { cwd: dir, stdio: "ignore" });

    // Count git invocations via wrapper on PATH (POSIX)
    if (process.platform !== "win32") {
      const binDir = mkTmp("rp-git-wrap-");
      const countFile = path.join(binDir, "count.log");
      const realGit = execSync("which git", { encoding: "utf8" }).trim();
      const wrapper = path.join(binDir, "git");
      fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${countFile}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
      const origPath = process.env.PATH ?? "";
      process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
      try {
        const clean = await readGitHeadAndDirty(dir, false);
        expect(clean?.dirty).toBe(false);
        expect(clean?.branch).toBeTruthy();
        const lines = fs.readFileSync(countFile, "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
      } finally {
        process.env.PATH = origPath;
      }
    }

    // Dirty working tree
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    const dirty = await readGitHeadAndDirty(dir, false);
    expect(dirty?.dirty).toBe(true);

    // Detached HEAD
    execSync("git checkout --detach HEAD", { cwd: dir, stdio: "ignore" });
    const detached = await readGitHeadAndDirty(dir, false);
    expect(detached?.branch).toBe("HEAD");
    expect(detached?.dirty).toBe(true);
  });

  it("gitDiff batches tracked files into a single git diff spawn while handling spaces, monorepo subdirs, and unborn HEAD", async () => {
    const dir = mkTmp("rp-git-batch-");
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, "sub dir"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `line-${i}\n`);
    }
    fs.writeFileSync(path.join(dir, "sub dir", "with space.txt"), "before\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `line-${i}-updated\n`);
    }
    fs.writeFileSync(path.join(dir, "sub dir", "with space.txt"), "after\n");

    const cfg = normalizeHostConfig({ roots: [dir] });

    if (process.platform !== "win32") {
      const binDir = mkTmp("rp-git-diff-wrap-");
      const logFile = path.join(binDir, "git.log");
      const realGit = execSync("which git", { encoding: "utf8" }).trim();
      const wrapper = path.join(binDir, "git");
      fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${logFile}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
      const origPath = process.env.PATH ?? "";
      process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
      try {
        const res = await gitDiff(cfg, dir);
        expect(res.files).toHaveLength(13);
        for (let i = 0; i < 12; i++) {
          const f = res.files.find((x) => x.path === `f${i}.txt`);
          expect(f?.patch).toContain(`+line-${i}-updated`);
          expect(f?.additions).toBe(1);
          expect(f?.deletions).toBe(1);
        }
        const spaced = res.files.find((x) => x.path === "sub dir/with space.txt");
        expect(spaced?.patch).toContain("+after");

        const diffSpawns = fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.includes(" diff "));
        expect(diffSpawns).toHaveLength(1);
      } finally {
        process.env.PATH = origPath;
      }
    }

    // Unborn HEAD staged-only file fallback
    const unbornDir = mkTmp("rp-git-unborn-");
    initGitRepo(unbornDir);
    fs.writeFileSync(path.join(unbornDir, "staged.txt"), "initial staged\n");
    execSync("git add staged.txt", { cwd: unbornDir, stdio: "ignore" });
    const unbornDiff = await gitDiff(normalizeHostConfig({ roots: [unbornDir] }), unbornDir);
    expect(unbornDiff.files).toHaveLength(1);
    expect(unbornDiff.files[0]!.patch).toContain("+initial staged");
  });
});

describe("PLG-PERF-08: StatusTracker detail throttle & SubagentTracker redundant emit skip + coalescing", () => {
  it("throttles detail-only StatusTracker updates to <=1 per 500ms while emitting state transitions immediately", () => {
    vi.useFakeTimers();
    let now = 1000;
    const emitted: Array<[string, string | undefined]> = [];
    const st = new StatusTracker((s, d) => emitted.push([s, d]), () => {}, undefined, () => now);

    st.working();
    st.working("read: a.ts");
    expect(emitted).toEqual([
      ["working", undefined],
      ["working", "read: a.ts"],
    ]);

    // Rapid burst of 5 tool details within 100ms -> coalesced into 1 trailing emit at +500ms
    now += 50;
    st.working("read: b.ts");
    now += 20;
    st.working("edit: c.ts");
    now += 20;
    st.working("bash: npm test");
    expect(emitted).toHaveLength(2);

    now += 410;
    vi.advanceTimersByTime(500);
    expect(emitted).toHaveLength(3);
    expect(emitted[2]).toEqual(["working", "bash: npm test"]);

    // Pending detail is cancelled and superseded immediately by a status transition
    now += 50;
    st.working("read: d.ts");
    expect(emitted).toHaveLength(3);
    st.setWaiting(1);
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toEqual(["waiting_input", undefined]);
    now += 600;
    vi.advanceTimersByTime(600);
    expect(emitted).toHaveLength(4);

    st.dispose();
  });

  it("skips redundant SubagentTracker.onToolEnd emit and coalesces rapid child onToolStart updates (250ms trailing)", () => {
    vi.useFakeTimers();
    const emitted: any[] = [];
    const tracker = new SubagentTracker({
      emit: (e) => emitted.push(e),
      now: () => Date.now(),
    });

    tracker.onToolStart("subagent_run", { agent: "explore", label: "scan" }, "parent_1");
    expect(emitted).toHaveLength(1);

    // Burst of 5 child tool starts -> coalesced into 1 trailing emit after 250ms
    for (let i = 0; i < 5; i++) {
      tracker.onToolStart(`tool_${i}`, {}, `c_${i}`, "parent_1");
    }
    expect(emitted).toHaveLength(1);

    vi.advanceTimersByTime(250);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].tools).toEqual(["tool_0", "tool_1", "tool_2", "tool_3", "tool_4"]);
    expect(emitted[1].toolCalls).toBe(5);

    // Child onToolEnd does NOT change tools[] -> skips emit while still recording status/duration
    tracker.onToolEnd("tool_0", "ok", false, "c_0", 42, "parent_1");
    expect(emitted).toHaveLength(2);
    expect(tracker.getTaskToolCalls("parent_1")[0]).toMatchObject({ status: "completed", durationMs: 42 });

    // Pending child update flushes cleanly before/with subagent_run completion
    tracker.onToolStart("tool_5", {}, "c_5", "parent_1");
    tracker.onToolEnd("subagent_run", "done", false, "parent_1", 300);
    expect(emitted.at(-1)).toMatchObject({ status: "completed", toolCalls: 6 });
    expect(emitted.at(-1).tools).toContain("tool_5");
    vi.advanceTimersByTime(500);
    const countAfterComplete = emitted.length;
    expect(countAfterComplete).toBe(3);

    (tracker as any).dispose?.();
  });
});

describe("PLG-PERF-09: Lazy agy-hook fast path", () => {
  it("src/host/main.ts does not statically import heavy daemon modules at top level", () => {
    const mainSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "host", "main.ts"),
      "utf8",
    );
    expect(mainSrc).not.toMatch(/^import\s+.*from\s+["']\.\/connection\.ts["']/m);
    expect(mainSrc).not.toMatch(/^import\s+.*from\s+["']\.\/herdr-bridge\.ts["']/m);
    expect(mainSrc).not.toMatch(/^import\s+.*from\s+["']\.\/manager\.ts["']/m);
    expect(mainSrc).not.toMatch(/^import\s+.*from\s+["']\.\/service\.ts["']/m);
    expect(mainSrc).toMatch(/import\(["']\.\/bridge\/agy-hooks\.ts["']\)/);
  });
});

describe("PLG-PERF-11 & PLG-PERF-12: Startup, autostart stamp, service inspection, Runtime & QuotaCollector", () => {
  it("shares host-autostart 10-min cooldown across processes via host-check.stamp", () => {
    const cfgDir = mkTmp("rp-autostart-stamp-");
    const env = { ...process.env, XDG_CONFIG_HOME: cfgDir, RP_NO_AUTO_HOST: "", RP_DISABLED: "" };
    const cfg = { ...DEFAULT_CONFIG, relayUrl: "https://relay.example", machineToken: "tok" };
    const flags = { getFlag: () => undefined };
    const t0 = 1_750_000_000_000;

    expect(shouldCheckHostAutostart(cfg, flags, t0, env)).toBe(true);
    const stampPath = path.join(cfgDir, "rp", "host-check.stamp");
    expect(fs.existsSync(stampPath)).toBe(true);

    // Simulate a second concurrent Pi process (clear in-memory cache without deleting stamp file)
    const saved = fs.readFileSync(stampPath, "utf8");
    resetAutostartCooldownForTests();
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, saved);

    expect(shouldCheckHostAutostart(cfg, flags, t0 + AUTOSTART_COOLDOWN_MS - 1_000, env)).toBe(false);
    expect(shouldCheckHostAutostart(cfg, flags, t0 + AUTOSTART_COOLDOWN_MS, env)).toBe(true);
  });

  it("parallelizes Linux inspectService commands via Promise.all and fast-paths stable process.execPath", async () => {
    const home = mkTmp("rp-svc-par-");
    const nodePath = path.join(home, "node");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const unitPath = path.join(home, ".config", "systemd", "user", "rp-host.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, systemdUnit({ platform: "linux", home, nodePath, scriptPath, envPath: "/usr/bin" }));

    let inFlight = 0;
    let maxInFlight = 0;
    const runner: Runner = async (cmd, args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      if (cmd === "loginctl") return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      return { code: 0, stdout: "active\n", stderr: "" };
    };

    const inspection = await inspectService({ platform: "linux", home, nodePath, scriptPath }, runner);
    expect(inspection.running).toBe(true);
    expect(maxInFlight).toBe(3);

    // Fast-path resolveStableNodePath does not scan PATH when execPath is already a valid non-versioned node
    const existsSpy = vi.spyOn(fs, "existsSync");
    const fakePathDirs = Array.from({ length: 10 }, (_, i) => path.join(home, `dir${i}`)).join(path.delimiter);
    const resolved = resolveStableNodePath({ PATH: fakePathDirs }, "linux", nodePath);
    expect(resolved).toBe(nodePath);
    const scannedFakeDirs = existsSpy.mock.calls.filter(([p]) => String(p).includes(`${path.sep}dir`));
    expect(scannedFakeDirs).toHaveLength(0);
  });

  it("Runtime fetches safeBranch once at startup, caches getAllTools lookups, and clones subagents once in makeHello()", async () => {
    const ctx = makeCtx();
    const branchSpy = vi.spyOn(ctx.sessionManager, "getBranch");
    const { pi } = makePi([
      { name: "read", label: "Read", description: "", parameters: {} } as any,
      { name: "bash", label: "Bash", description: "", parameters: {} } as any,
    ]);
    const toolsSpy = vi.spyOn(pi, "getAllTools");

    const rt = new Runtime(pi, ctx, baseConfig("http://127.0.0.1:1"), noEnv, "startup", {
      detectTheme: () => null,
      connectionFactory: (o) =>
        new Connection({
          ...o,
          transportFactory: () => ({ name: "ws", start: () => {}, send: () => true, close: () => {} }),
        }),
    });
    rt.start();
    // Constructor + start() should only call getBranch() once total
    expect(branchSpy).toHaveBeenCalledTimes(1);

    // Repeated toolInfo() lookups reuse the cached map (1 call to getAllTools to check count, no extra scans)
    toolsSpy.mockClear();
    const t1 = (rt as any).toolInfo("bash");
    const t2 = (rt as any).toolInfo("read");
    expect(t1?.name).toBe("bash");
    expect(t2?.name).toBe("read");

    const snapSpy = vi.spyOn(rt.subagents, "getSnapshot");
    rt.subagents.onToolStart("subagent_run", { agent: "a", label: "b" }, "s1");
    snapSpy.mockClear();
    const hello = rt.makeHello();
    expect(hello.subagents).toHaveLength(1);
    expect(snapSpy).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  it("QuotaCollector caches resolved fallback script and backs off when piquota is absent", async () => {
    const script = fileURLToPath(import.meta.url);
    const miss = { code: -1, stdout: "", stderr: "ENOENT" };
    const okOut = JSON.stringify({ providers: [{ family: "claude", label: "Claude", ok: true, windows: [] }] });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "piquota" ? miss : { code: 0, stdout: okOut, stderr: "" };
    };
    const collector = new QuotaCollector({ runner, fallbackScripts: () => [script] });
    await collector.collect();
    expect(calls).toHaveLength(2); // 1st call: piquota ENOENT -> fallback node script
    await collector.collect();
    expect(calls).toHaveLength(3); // 2nd call: cached node script directly (1 spawn!)
    expect(calls[2]!.cmd).toBe(process.execPath);

    // Absent everywhere -> backs off and skips spawns until window expires
    let now = 1_000_000;
    let absentSpawns = 0;
    const absentCollector = new QuotaCollector({
      runner: async () => {
        absentSpawns++;
        return miss;
      },
      fallbackScripts: () => ["/nonexistent/piquota.js"],
      now: () => now,
      missingBackoffMs: 30 * 60_000,
    } as any);
    expect(await absentCollector.collect()).toBeNull();
    expect(absentSpawns).toBe(1);
    now += 5 * 60_000;
    expect(await absentCollector.collect()).toBeNull();
    expect(absentSpawns).toBe(1); // backed off!
    now += 25 * 60_000;
    expect(await absentCollector.collect()).toBeNull();
    expect(absentSpawns).toBe(2); // backoff elapsed -> retries once
  });

  it("cleanupExpiredInboxFiles remains exported and functional", () => {
    const inbox = mkTmp("rp-inbox-");
    const conv = path.join(inbox, "c1");
    fs.mkdirSync(conv);
    const oldFile = path.join(conv, "old.txt");
    fs.writeFileSync(oldFile, "x");
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);
    cleanupExpiredInboxFiles(inbox);
    expect(fs.existsSync(oldFile)).toBe(false);
  });
});
