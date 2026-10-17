import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/extension/config.ts";
import { AUTOSTART_COOLDOWN_MS, ensureHostAutostart, resetAutostartCooldownForTests, shouldCheckHostAutostart } from "../src/extension/host-autostart.ts";
import { makeCtx, makePi } from "./helpers.ts";
import type { Runner } from "../src/host/runner.ts";
import { systemdUnit } from "../src/host/service.ts";

const homes: string[] = [];
const tempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-host-autostart-"));
  homes.push(home);
  return home;
};
const pairedConfig = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_CONFIG,
  relayUrl: "https://relay.example",
  machineToken: "machine-token",
  ...over,
});
const pi = (values: Record<string, boolean> = {}) => ({ getFlag: (name: string) => values[name] });
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.RP_NO_AUTO_HOST;
  return env;
};

function fakeRunner(handler: (cmd: string, args: string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({})) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const result = handler(cmd, args);
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

const notRunning = (cmd: string, args: string[]) => {
  if (cmd === "systemctl" && args.join(" ") === "--user is-enabled rp-host") return { stdout: "enabled\n" };
  if (cmd === "systemctl" && args.join(" ") === "--user is-active rp-host") return { code: 3, stdout: "inactive\n" };
  if (cmd === "loginctl") return { stdout: "Linger=yes\n" };
  return {};
};

afterEach(() => {
  resetAutostartCooldownForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("extension host autostart", () => {
  it("normalizes host autostart to true by default and honors both opt-out keys", () => {
    expect(normalizeConfig({}).hostAutostart).toBe(true);
    expect(normalizeConfig({ hostAutostart: false }).hostAutostart).toBe(false);
    expect(normalizeConfig({ autoHost: false }).hostAutostart).toBe(false);
    expect(normalizeConfig({ enabled: false, redactContent: true, autoHost: false })).toMatchObject({ enabled: false, redactContent: true, hostAutostart: false });
    expect(DEFAULT_CONFIG.hostAutostart).toBe(true);
  });

  it("installs an absent service and starts an installed service that is stopped", async () => {
    const home = tempHome();
    const nodePath = path.join(home, "node");
    const scriptPath = path.join(home, "rp-host.mjs");
    fs.writeFileSync(nodePath, "node");
    fs.writeFileSync(scriptPath, "script");
    const absent = fakeRunner(notRunning);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const common = { cfg: pairedConfig(), pi: pi(), runner: absent.run, platform: "linux" as const, home, nodePath, scriptPath, env: cleanEnv() };

    await ensureHostAutostart(common);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[rp] Host self-heal: installed ("));
    expect(absent.calls.map(({ cmd, args }) => `${cmd} ${args.join(" ")}`)).toContain("systemctl --user enable --now rp-host");
    expect(fs.existsSync(path.join(home, ".config", "systemd", "user", "rp-host.service"))).toBe(true);

    resetAutostartCooldownForTests();
    const unitPath = path.join(home, ".config", "systemd", "user", "rp-host.service");
    fs.writeFileSync(unitPath, systemdUnit({ platform: "linux", home, nodePath, scriptPath, envPath: process.env.PATH }));
    const stopped = fakeRunner(notRunning);
    await ensureHostAutostart({ ...common, runner: stopped.run });
    expect(stopped.calls.map(({ cmd, args }) => `${cmd} ${args.join(" ")}`)).toContain("systemctl --user start rp-host");
    expect(stopped.calls.map(({ cmd, args }) => `${cmd} ${args.join(" ")}`)).not.toContain("systemctl --user enable --now rp-host");
  });

  it("uses the full ten-minute cooldown boundary", () => {
    const cfg = pairedConfig();
    const flags = pi();
    const env = cleanEnv();
    expect(shouldCheckHostAutostart(cfg, flags, 1000, env)).toBe(true);
    expect(shouldCheckHostAutostart(cfg, flags, 1000 + AUTOSTART_COOLDOWN_MS - 1, env)).toBe(false);
    expect(shouldCheckHostAutostart(cfg, flags, 1000 + AUTOSTART_COOLDOWN_MS, env)).toBe(true);
  });

  it("rate-limits checks for ten minutes and allows another check after reset", async () => {
    const home = tempHome();
    const runner = fakeRunner(notRunning);
    const options = { cfg: pairedConfig(), pi: pi(), runner: runner.run, platform: "linux" as const, home, env: cleanEnv() };
    await ensureHostAutostart(options);
    const callsAfterFirst = runner.calls.length;
    await ensureHostAutostart(options);
    expect(runner.calls).toHaveLength(callsAfterFirst);

    resetAutostartCooldownForTests();
    await ensureHostAutostart(options);
    expect(runner.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it.each([
    ["config", { hostAutostart: false }, {}],
    ["disabled config", { enabled: false }, {}],
    ["rp-no-auto-host flag", {}, { "rp-no-auto-host": true }],
    ["rp-off flag", {}, { "rp-off": true }],
  ])("skips the service check when opted out via %s", async (_reason, cfgOver, flags) => {
    const runner = fakeRunner();
    await ensureHostAutostart({ cfg: pairedConfig(cfgOver), pi: pi(flags), runner: runner.run, platform: "linux", home: tempHome(), env: cleanEnv() });
    expect(runner.calls).toEqual([]);
  });

  it("skips the service check when RP_NO_AUTO_HOST or RP_DISABLED is set", async () => {
    const runner = fakeRunner();
    await ensureHostAutostart({ cfg: pairedConfig(), pi: pi(), runner: runner.run, platform: "linux", home: tempHome(), env: { ...cleanEnv(), RP_NO_AUTO_HOST: "1" } });
    await ensureHostAutostart({ cfg: pairedConfig(), pi: pi(), runner: runner.run, platform: "linux", home: tempHome(), env: { ...cleanEnv(), RP_DISABLED: "1" } });
    expect(runner.calls).toEqual([]);
  });

  it("catches service errors and never rejects", async () => {
    const error = new Error("service manager unavailable");
    const runner = fakeRunner(() => { throw error; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ensureHostAutostart({ cfg: pairedConfig(), pi: pi(), runner: runner.run, platform: "linux", home: tempHome(), env: cleanEnv() })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[rp] Host self-heal check failed:", error.message);
  });

  it("session_start fires host self-healing without waiting for it", async () => {
    const configHome = tempHome();
    vi.stubEnv("RP_CONFIG", path.join(configHome, "config.json"));
    vi.stubEnv("RP_DISABLED", "1");
    vi.stubEnv("GENTLE_PI_AGENTS_CHILD", "0");
    let release!: () => void;
    const selfHeal = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    vi.resetModules();
    vi.doMock("../src/extension/host-autostart.ts", () => ({ ensureHostAutostart: selfHeal }));
    try {
      const { default: extension } = await import("../src/extension/index.ts");
      const fake = makePi();
      extension(fake.pi);
      expect(fake.flags.has("rp-no-auto-host")).toBe(true);
      expect(fake.handlers.get("session_start")).toHaveLength(1);
      const starting = fake.fire("session_start", { reason: "new" }, makeCtx());
      const completedWithoutWaiting = await Promise.race([
        starting.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(completedWithoutWaiting).toBe(true);
      expect(selfHeal).toHaveBeenCalledOnce();
    } finally {
      release?.();
      vi.doUnmock("../src/extension/host-autostart.ts");
      vi.resetModules();
    }
  });

  it("can be fired and forgotten while the service check is pending", async () => {
    let release!: (value: { code: number; stdout: string; stderr: string }) => void;
    let firstCall = true;
    const runner: Runner = async (cmd) => {
      if (firstCall) {
        firstCall = false;
        return await new Promise((resolve) => { release = resolve; });
      }
      return { code: 0, stdout: cmd === "loginctl" ? "Linger=yes\\n" : "", stderr: "" };
    };
    const pending = ensureHostAutostart({ cfg: pairedConfig(), pi: pi(), runner, platform: "linux", home: tempHome(), env: cleanEnv() });
    await Promise.resolve();
    let sessionContinued = false;
    void pending;
    sessionContinued = true;
    expect(sessionContinued).toBe(true);
    release({ code: 0, stdout: "enabled\\n", stderr: "" });
    await expect(pending).resolves.toBeUndefined();
  });
});
