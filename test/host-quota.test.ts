import { describe, expect, it } from "vitest";
import { mapPiquotaJsonToMachineQuotas, QuotaCollector } from "../src/host/quota.ts";
import type { Runner } from "../src/host/runner.ts";

const SAMPLE_PIQUOTA_OUTPUT = {
  engine: "pi-quota",
  schemaVersion: 1,
  readOnly: true,
  generatedAt: "2026-10-15T05:43:14.794Z",
  providers: [
    {
      family: "antigravity",
      label: "Antigravity (Pi)",
      account: "user@example.com",
      plan: null,
      windows: [
        {
          id: "gemini-weekly",
          label: "Gemini · weekly",
          usedPercent: 31.10427,
          remainingPercent: 68.89573,
          resetsAt: "2026-10-20T20:27:33.000Z",
          resetsInSec: 485020,
          note: "Weekly limit note",
        },
        {
          id: "gemini-5h",
          label: "Gemini · 5h",
          usedPercent: 8.78,
          remainingPercent: 91.22,
          resetsAt: "2026-10-15T09:45:22.000Z",
          resetsInSec: 14489,
          note: null,
        },
      ],
      error: null,
      ok: true,
      notConfigured: false,
      updatedAt: "2026-10-15T05:43:14.794Z",
      primaryWindowId: "gemini-5h",
    },
    {
      family: "claude",
      label: "Claude (Pi)",
      plan: "pro",
      windows: [],
      error: "Token expired",
      ok: false,
      notConfigured: false,
      updatedAt: "2026-10-15T05:43:17.733Z",
      primaryWindowId: null,
    },
  ],
};

function fakeRunner(result: { code?: number; stdout?: string; stderr?: string }): { runner: Runner; calls: any[] } {
  const calls: any[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      code: result.code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  return { runner, calls };
}

describe("mapPiquotaJsonToMachineQuotas", () => {
  it("maps valid piquota JSON output to MachineQuota[] matching protocol", () => {
    const quotas = mapPiquotaJsonToMachineQuotas(SAMPLE_PIQUOTA_OUTPUT);
    expect(quotas).toHaveLength(2);

    const antigravity = quotas[0]!;
    expect(antigravity.family).toBe("antigravity");
    expect(antigravity.label).toBe("Antigravity (Pi)");
    expect(antigravity.plan).toBeNull();
    expect(antigravity.ok).toBe(true);
    expect(antigravity.notConfigured).toBe(false);
    expect(antigravity.error).toBeNull();
    expect(antigravity.primaryWindowId).toBe("gemini-5h");
    expect(antigravity.updatedAt).toBe("2026-10-15T05:43:14.794Z");
    expect(antigravity.windows).toHaveLength(2);

    const w1 = antigravity.windows[0]!;
    expect(w1.id).toBe("gemini-weekly");
    expect(w1.label).toBe("Gemini · weekly");
    expect(w1.usedPercent).toBe(31.10427);
    expect(w1.remainingPercent).toBe(68.89573);
    expect(w1.resetsAt).toBe("2026-10-20T20:27:33.000Z");
    expect(w1.resetsInSec).toBe(485020);
    expect(w1.note).toBe("Weekly limit note");

    const claude = quotas[1]!;
    expect(claude.family).toBe("claude");
    expect(claude.ok).toBe(false);
    expect(claude.error).toBe("Token expired");
    expect(claude.plan).toBe("pro");
    expect(claude.windows).toEqual([]);
  });

  it("handles string input and parses JSON", () => {
    const quotas = mapPiquotaJsonToMachineQuotas(JSON.stringify(SAMPLE_PIQUOTA_OUTPUT));
    expect(quotas).toHaveLength(2);
  });

  it("handles empty or malformed inputs without throwing", () => {
    expect(mapPiquotaJsonToMachineQuotas(null)).toEqual([]);
    expect(mapPiquotaJsonToMachineQuotas({})).toEqual([]);
    expect(mapPiquotaJsonToMachineQuotas("not json")).toEqual([]);
    expect(mapPiquotaJsonToMachineQuotas({ providers: "not array" })).toEqual([]);
    expect(mapPiquotaJsonToMachineQuotas({ providers: [{ notAProvider: 1 }] })).toEqual([]);
  });

  it("defensively sanitizes window values (numbers, nulls)", () => {
    const raw = {
      providers: [
        {
          family: "test",
          label: "Test Provider",
          windows: [
            {
              id: "w1",
              label: "W1",
              usedPercent: "invalid",
              remainingPercent: NaN,
              resetsInSec: 12.34,
            },
            {
              id: "w2",
              label: "Only usedPercent",
              usedPercent: 75,
            },
            {
              id: "w3",
              label: "Only remainingPercent clamped",
              remainingPercent: 120,
            },
          ],
        },
      ],
    };
    const quotas = mapPiquotaJsonToMachineQuotas(raw);
    expect(quotas).toHaveLength(1);
    expect(quotas[0]!.windows[0]!.usedPercent).toBe(0);
    expect(quotas[0]!.windows[0]!.remainingPercent).toBe(100);
    expect(quotas[0]!.windows[0]!.resetsInSec).toBe(12);
    expect(quotas[0]!.windows[1]!.usedPercent).toBe(75);
    expect(quotas[0]!.windows[1]!.remainingPercent).toBe(25);
    expect(quotas[0]!.windows[2]!.remainingPercent).toBe(100);
    expect(quotas[0]!.windows[2]!.usedPercent).toBe(0);
  });
});

describe("QuotaCollector", () => {
  it("collects and maps quotas successfully", async () => {
    const { runner, calls } = fakeRunner({
      code: 0,
      stdout: JSON.stringify(SAMPLE_PIQUOTA_OUTPUT),
    });
    const logs: string[] = [];
    const collector = new QuotaCollector({
      runner,
      command: "piquota --json",
      timeoutMs: 5000,
      onLog: (m: string) => logs.push(m),
    });

    const quotas = await collector.collect();
    expect(quotas).toHaveLength(2);
    expect(collector.getLastQuotas()).toEqual(quotas);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("piquota");
    expect(calls[0].args).toEqual(["--json"]);
  });

  it("returns null and preserves cache when runner fails with non-zero exit code", async () => {
    const { runner } = fakeRunner({
      code: 127,
      stderr: "command not found: piquota",
    });
    const logs: string[] = [];
    const collector = new QuotaCollector({
      runner,
      command: "piquota --json",
      onLog: (m: string) => logs.push(m),
    });

    const quotas = await collector.collect();
    expect(quotas).toBeNull();
    expect(collector.getLastQuotas()).toBeNull();
    expect(logs.some((l) => l.includes("exit 127"))).toBe(true);
  });

  it("falls back to previous cached quotas when a refresh fails", async () => {
    let callCount = 0;
    const runner: Runner = async () => {
      callCount++;
      if (callCount === 1) {
        return { code: 0, stdout: JSON.stringify(SAMPLE_PIQUOTA_OUTPUT), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "network timeout" };
    };

    const collector = new QuotaCollector({ runner });
    const first = await collector.collect();
    expect(first).toHaveLength(2);

    const second = await collector.collect();
    expect(second).toEqual(first); // returns cached quotas on error
    expect(collector.getLastQuotas()).toEqual(first);
  });

  it("handles malformed stdout gracefully", async () => {
    const { runner } = fakeRunner({ code: 0, stdout: "error: unable to connect to daemon" });
    const logs: string[] = [];
    const collector = new QuotaCollector({ runner, onLog: (m: string) => logs.push(m) });

    const quotas = await collector.collect();
    expect(quotas).toBeNull();
    expect(logs.some((l) => l.includes("invalid JSON"))).toBe(true);
  });
});
