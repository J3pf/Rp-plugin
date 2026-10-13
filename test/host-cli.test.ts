import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/host/main.ts";

let dir: string;
const backup = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rphostcli-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.RP_CONFIG = path.join(dir, "rp", "config.json");
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in backup)) delete process.env[k];
  Object.assign(process.env, backup);
  vi.restoreAllMocks();
});

describe("rp-host CLI", () => {
  it("--help and init", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    expect(log.mock.calls[0]![0]).toContain("rp-host");
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
  it("run refuses to start on an unpaired PC with a clear message; unknown command errors", async () => {
    await expect(main(["run"])).rejects.toThrow(/not paired/);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["bogus"])).rejects.toThrow(/unknown command/);
  });
});
