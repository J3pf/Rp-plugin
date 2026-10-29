import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineQuota, QuotaWindow } from "../shared/protocol.ts";
import { run as realRun, type Runner } from "./runner.ts";
import { splitCommand } from "./validate.ts";

export interface QuotaCollectorOptions {
  runner?: Runner;
  /** Test seam: where to look for the piquota script when it is not on PATH. */
  fallbackScripts?: () => string[];
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
      const clampPct = (n: number) => Math.min(100, Math.max(0, n));
      for (const w of p.windows) {
        if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) continue;
        const rawUsed = parseNum(w.usedPercent, NaN);
        const rawRem = parseNum(w.remainingPercent, NaN);
        const usedPercent = Number.isFinite(rawUsed)
          ? clampPct(rawUsed)
          : Number.isFinite(rawRem)
            ? clampPct(100 - rawRem)
            : 0;
        const remainingPercent = Number.isFinite(rawRem)
          ? clampPct(rawRem)
          : Number.isFinite(rawUsed)
            ? clampPct(100 - rawUsed)
            : 100;
        windows.push({
          id: String(w.id),
          label: parseOptStr(w.label),
          usedPercent,
          remainingPercent,
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

/**
 * `piquota` ships as a Pi package, so it is usually not on the PATH of a launchd/systemd
 * service. Look where Pi installs npm packages (pi and gentle-shell homes).
 */
export function piquotaScriptCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const agentDirs = [env.PI_CODING_AGENT_DIR, path.join(home, ".pi", "agent"), path.join(home, ".gentle-shell", "agent")].filter(
    (d): d is string => !!d,
  );
  return agentDirs.map((d) => path.join(d, "npm", "node_modules", "@j3pf", "piquota", "bin", "piquota.js"));
}

export class QuotaCollector {
  private runner: Runner;
  private command: string;
  private timeoutMs: number;
  private onLog?: (msg: string) => void;
  private fallbackScripts: () => string[];
  private lastQuotas: MachineQuota[] | null = null;

  constructor(opts: QuotaCollectorOptions = {}) {
    this.runner = opts.runner ?? realRun;
    this.command = opts.command ?? "piquota --json";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.onLog = opts.onLog;
    this.fallbackScripts = opts.fallbackScripts ?? (() => piquotaScriptCandidates());
  }

  getLastQuotas(): MachineQuota[] | null {
    return this.lastQuotas;
  }

  async collect(): Promise<MachineQuota[] | null> {
    const parts = splitCommand(this.command);
    if (!parts.length) {
      this.onLog?.("empty quota command");
      return this.lastQuotas;
    }
    const [bin, ...args] = parts;

    try {
      let res = await this.runner(bin!, args, { timeoutMs: this.timeoutMs });
      if (res.code === -1 && bin === "piquota") {
        // Not on PATH (typical for a service): run the Pi-installed script with this same node.
        const script = this.fallbackScripts().find((f) => fs.existsSync(f));
        if (script) res = await this.runner(process.execPath, [script, ...args], { timeoutMs: this.timeoutMs });
      }
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
      return quotas;
    } catch (e) {
      this.onLog?.(`quota collection exception: ${(e as Error).message}`);
      return this.lastQuotas;
    }
  }
}
