import type { MachineQuota, QuotaWindow } from "../shared/protocol.ts";
import { run as realRun, type Runner } from "./runner.ts";
import { splitCommand } from "./validate.ts";

export interface QuotaCollectorOptions {
  runner?: Runner;
  command?: string;
  timeoutMs?: number;
  onLog?: (msg: string) => void;
}

function parseNum(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseOptInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = parseNum(val, NaN);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function parseOptStr(val: unknown): string | null {
  return typeof val === "string" ? val : null;
}

/**
 * Maps raw JSON output from `piquota --json` to MachineQuota[].
 * Returns an empty array if raw is malformed or has no valid providers.
 */
export function mapPiquotaJsonToMachineQuotas(raw: unknown): MachineQuota[] {
  let data: any = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object") return [];

  const providers = Array.isArray(data.providers) ? data.providers : [];
  const result: MachineQuota[] = [];

  for (const p of providers) {
    if (!p || typeof p !== "object" || typeof p.family !== "string" || !p.family) continue;

    const windows: QuotaWindow[] = [];
    if (Array.isArray(p.windows)) {
      for (const w of p.windows) {
        if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) continue;
        windows.push({
          id: String(w.id),
          label: parseOptStr(w.label),
          usedPercent: parseNum(w.usedPercent, 0),
          remainingPercent: parseNum(w.remainingPercent, 100),
          resetsAt: parseOptStr(w.resetsAt),
          resetsInSec: parseOptInt(w.resetsInSec),
          note: parseOptStr(w.note),
        });
      }
    }

    result.push({
      family: String(p.family),
      label: typeof p.label === "string" && p.label ? p.label : String(p.family),
      plan: parseOptStr(p.plan),
      ok: typeof p.ok === "boolean" ? p.ok : true,
      notConfigured: typeof p.notConfigured === "boolean" ? p.notConfigured : false,
      error: parseOptStr(p.error),
      primaryWindowId: parseOptStr(p.primaryWindowId),
      windows,
      updatedAt: parseOptStr(p.updatedAt) ?? parseOptStr(data.generatedAt) ?? null,
    });
  }

  return result;
}

export class QuotaCollector {
  private runner: Runner;
  private command: string;
  private timeoutMs: number;
  private onLog?: (msg: string) => void;
  private lastQuotas: MachineQuota[] | null = null;
  private lastCollectedAt = 0;

  constructor(opts: QuotaCollectorOptions = {}) {
    this.runner = opts.runner ?? realRun;
    this.command = opts.command ?? "piquota --json";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.onLog = opts.onLog;
  }

  getLastQuotas(): MachineQuota[] | null {
    return this.lastQuotas;
  }

  getLastCollectedAt(): number {
    return this.lastCollectedAt;
  }

  async collect(): Promise<MachineQuota[] | null> {
    const parts = splitCommand(this.command);
    if (!parts.length) {
      this.onLog?.("empty quota command");
      return this.lastQuotas;
    }
    const [bin, ...args] = parts;

    try {
      const res = await this.runner(bin!, args, { timeoutMs: this.timeoutMs });
      if (res.code !== 0) {
        const errSnippet = (res.stderr || res.stdout || "").trim().slice(0, 200);
        this.onLog?.(`quota command "${this.command}" failed (exit ${res.code}): ${errSnippet}`);
        return this.lastQuotas;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.stdout);
      } catch (e) {
        this.onLog?.(`quota command returned invalid JSON: ${(e as Error).message}`);
        return this.lastQuotas;
      }

      const quotas = mapPiquotaJsonToMachineQuotas(parsed);
      this.lastQuotas = quotas;
      this.lastCollectedAt = Date.now();
      return quotas;
    } catch (e) {
      this.onLog?.(`quota collection exception: ${(e as Error).message}`);
      return this.lastQuotas;
    }
  }
}
