import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpConfig } from "./config.ts";
import { ensureHostService, resolveStableNodePath, type ServiceSpec } from "../host/service.ts";
import { run as realRun, type Runner } from "../host/runner.ts";

export const AUTOSTART_COOLDOWN_MS = 10 * 60 * 1000;

type AutostartConfig = Pick<RpConfig, "hostAutostart" | "machineToken" | "relayUrl"> & { enabled?: boolean };
type FlagReader = { getFlag(name: string): boolean | string | undefined };

let lastAutostartCheckAt: number | undefined;

function logError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Logging must never affect the Pi session.
  }
}

export function shouldCheckHostAutostart(
  cfg: AutostartConfig,
  pi: FlagReader,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (cfg.enabled === false) return false;
  if (cfg.hostAutostart === false) return false;
  if (pi.getFlag("rp-no-auto-host") || pi.getFlag("rp-off")) return false;
  if (!Boolean(cfg.machineToken && cfg.relayUrl)) return false;
  if (env.RP_NO_AUTO_HOST === "1" || env.RP_DISABLED === "1") return false;
  if (lastAutostartCheckAt !== undefined && now - lastAutostartCheckAt < AUTOSTART_COOLDOWN_MS) return false;

  // Reserve the cooldown before starting asynchronous work so concurrent sessions cannot race.
  lastAutostartCheckAt = now;
  return true;
}

export interface EnsureHostAutostartOptions {
  cfg: AutostartConfig;
  pi: FlagReader;
  runner?: Runner;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides are useful for controlled tests; normal extension runs resolve these automatically. */
  nodePath?: string;
  scriptPath?: string;
}

/** Check and repair the paired host service without allowing any failure to escape into Pi. */
export async function ensureHostAutostart(options: EnsureHostAutostartOptions): Promise<void> {
  try {
    const { cfg, pi } = options;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (!shouldCheckHostAutostart(cfg, pi, Date.now(), env)) return;

    const spec: ServiceSpec = {
      nodePath: options.nodePath ?? resolveStableNodePath(env, platform),
      scriptPath: options.scriptPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "rp-host.mjs"),
      platform,
      ...(options.home ? { home: options.home } : {}),
      envPath: env.PATH ?? env.Path ?? "",
    };
    const result = await ensureHostService(spec, options.runner ?? realRun);
    if (result.action !== "none" || result.warning) {
      const details = [
        `installed=${result.inspection.installed}`,
        `running=${result.inspection.running}`,
        ...(result.inspection.stale ? [`stale=${result.inspection.staleReason ?? "yes"}`] : []),
        ...(result.warning ? [result.warning] : []),
      ].join(", ");
      logError(`[rp] Host self-heal: ${result.action} (${details})`);
    }
  } catch (error) {
    logError("[rp] Host self-heal check failed:", error instanceof Error ? error.message : String(error));
  }
}

export function resetAutostartCooldownForTests(): void {
  lastAutostartCheckAt = undefined;
}
