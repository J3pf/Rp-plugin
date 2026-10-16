import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectService, type ServiceInspection } from "../src/host/service.ts";
import { main } from "../src/host/main.ts";

vi.mock("../src/host/service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/service.ts")>();
  return { ...actual, inspectService: vi.fn() };
});

let dir: string;
let previousExitCode: number | undefined;
const backup = { ...process.env };
beforeEach(() => {
  previousExitCode = process.exitCode;
  vi.mocked(inspectService).mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rphostcli-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.RP_CONFIG = path.join(dir, "rp", "config.json");
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in backup)) delete process.env[k];
  Object.assign(process.env, backup);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe("rp-host CLI", () => {
  it("--help and init", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    expect(log.mock.calls[0]![0]).toContain("rp-host");
    expect(log.mock.calls[0]![0]).toContain("doctor      Check service status and diagnose autostart / health");
    await main(["init"]);
    const hostJson = path.join(dir, "rp", "host.json");
    expect(JSON.parse(fs.readFileSync(hostJson, "utf8")).defaultLauncher).toBe("gentle-shell");
    await main(["init"]);
    expect(log.mock.calls.at(-1)![0]).toContain("already exists");
  });
  it("status prints config and backends as JSON", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["status"]);
    const out = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(out).toHaveProperty("backends");
    expect(out.launchers).toHaveProperty("pi");
    expect(out.spawned).toEqual([]);
  });
  it("doctor reports healthy services as OK with exit code zero", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(inspectService).mockResolvedValue({
      platform: process.platform,
      installed: true,
      enabled: true,
      running: true,
      nodePath: "/stable/node",
      nodePathValid: true,
      scriptPath: "/rp-host.mjs",
      scriptPathValid: true,
      stale: false,
      details: process.platform === "linux" ? { linger: true } : {},
    });
    await main(["doctor"]);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("Status: OK");
    expect(process.exitCode).toBe(0);
    expect(vi.mocked(inspectService)).toHaveBeenCalledWith(expect.objectContaining({ platform: process.platform, scriptPath: expect.stringContaining("rp-host.mjs") }));
  });
  it("doctor reports unhealthy services with a nonzero exit code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(inspectService).mockResolvedValue({
      platform: process.platform,
      installed: false,
      running: false,
      nodePathValid: false,
      scriptPathValid: false,
      stale: false,
    });
    await main(["doctor"]);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("Status: PROBLEM");
    expect(process.exitCode).toBe(1);
  });
  it("doctor supports structured JSON output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const inspection: ServiceInspection = {
      platform: "linux",
      installed: true,
      enabled: false,
      running: false,
      nodePath: "/node",
      nodePathValid: true,
      scriptPath: "/rp-host.mjs",
      scriptPathValid: true,
      stale: false,
      details: { linger: false },
    };
    vi.mocked(inspectService).mockResolvedValue(inspection);
    await main(["doctor", "--json"]);
    const output = JSON.parse(String(log.mock.calls[0]![0]));
    expect(output).toMatchObject({ status: "PROBLEM", healthy: false, ...inspection });
    expect(process.exitCode).toBe(1);
  });
  it("run refuses to start on an unpaired PC with a clear message; unknown command errors", async () => {
    await expect(main(["run"])).rejects.toThrow(/not paired/);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["bogus"])).rejects.toThrow(/unknown command/);
  });
});
