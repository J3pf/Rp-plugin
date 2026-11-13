import { afterEach, describe, expect, it } from "vitest";
import { ChildSupervisor, type ChildSupervisorSpec } from "../src/host/serve/supervisor.ts";

/** Long-lived child that prints one line and then idles. */
const IDLE = "console.log('ready'); setInterval(() => {}, 1000);";
/** Child that prints a line and exits with a non-zero code. */
const CRASH = "console.log('starting'); process.exit(3);";

const live: ChildSupervisor[] = [];

function make(overrides: Partial<ChildSupervisorSpec> = {}) {
  const lines: string[] = [];
  const fatal: string[] = [];
  const sup = new ChildSupervisor({
    name: "fake",
    command: process.execPath,
    args: ["-e", IDLE],
    onLog: (l) => lines.push(l),
    onFatal: (r) => fatal.push(r),
    restart: { enabled: false, initialDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 },
    ...overrides,
  });
  live.push(sup);
  return { sup, lines, fatal };
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
});

describe("ChildSupervisor", () => {
  it("forwards stdout and stderr lines under the process name and waitForLine resolves them", async () => {
    const { sup, lines } = make({ args: ["-e", "console.log('one'); console.error('two'); setInterval(() => {}, 1000);"] });
    await sup.start();

    expect(await sup.waitForLine((l) => l.includes("two"), 5000)).toBe("two");
    expect(lines).toContain("fake: one");
    expect(lines).toContain("fake: two");
    expect(sup.isRunning()).toBe(true);
  });

  it("gives up after the configured restart attempts and reports the exit code", async () => {
    const { sup, fatal } = make({
      args: ["-e", CRASH],
      restart: { enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
    });
    await sup.start();
    await sup.waitForExit(5000);

    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("exited with code 3");
    expect(fatal[0]).toContain("3 attempts");
    expect(sup.isRunning()).toBe(false);
  });

  it("keeps restarting a crashing child while attempts remain", async () => {
    const { sup } = make({
      args: ["-e", "console.log('tick'); setTimeout(() => process.exit(1), 5);"],
      restart: { enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 5 },
    });
    // One process prints exactly one tick, so a second tick proves the child was respawned.
    let ticks = 0;
    const secondTick = sup.waitForLine((l) => l.includes("tick") && ++ticks >= 2, 10_000);
    await sup.start();
    await secondTick;

    expect(sup.isRunning()).toBe(true);
  });

  it("reports a missing executable as fatal without retrying", async () => {
    const { sup, fatal } = make({
      command: "rp-definitely-missing-binary",
      args: [],
      restart: { enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 },
    });
    await sup.start();
    await sup.waitForExit(5000);

    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain("could not be started");
    expect(fatal[0]).toContain("rp-definitely-missing-binary");
  });

  it("stop is intentional: no restart, no fatal, child no longer running", async () => {
    const { sup, fatal } = make({
      restart: { enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 },
    });
    await sup.start();
    await sup.waitForLine((l) => l.includes("ready"), 5000);
    await sup.stop();

    expect(fatal).toEqual([]);
    expect(sup.isRunning()).toBe(false);
  });

  it("waitForLine rejects when the needle never shows up", async () => {
    const { sup } = make();
    await sup.start();
    await expect(sup.waitForLine((l) => l.includes("never"), 100)).rejects.toThrow(/no matching output within 100ms/);
  });
});
