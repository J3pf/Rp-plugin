import { execFile } from "node:child_process";
import { ChildSupervisor } from "./supervisor.ts";

export type TunnelProviderName = "cloudflared" | "tailscale" | "none";

export interface TunnelRunner {
  (command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface TunnelOptions {
  provider: TunnelProviderName;
  /** Port the embedded relay listens on, on loopback. */
  localPort: number;
  onLog: (line: string) => void;
  /** Argv prefix for cloudflared instead of `["cloudflared"]`; tests point it at a fake. */
  command?: string[];
  /** How long to wait for the tunnel to report its public URL. */
  timeoutMs?: number;
  /** Injected command runner for the `tailscale` provider. */
  run?: TunnelRunner;
}

export interface TunnelHandle {
  provider: TunnelProviderName;
  publicUrl: string;
  stopped: () => boolean;
  stop: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Public host of a Cloudflare quick tunnel, as printed inside its ASCII banner. */
export function parseCloudflaredUrl(line: string): string | null {
  const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/i.exec(line);
  return match ? `https://${match[1]!.toLowerCase()}` : null;
}

export function parseTailscaleDnsName(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { Self?: { DNSName?: unknown } };
    const dns = parsed?.Self?.DNSName;
    return typeof dns === "string" && dns.trim() ? dns.trim() : null;
  } catch {
    return null;
  }
}

export function funnelUrlFromDnsName(dnsName: string): string | null {
  const host = dnsName.trim().replace(/\.$/, "");
  return host ? `https://${host}` : null;
}

/**
 * Cloudflare quick tunnel: a supervised child process whose banner carries the assigned hostname.
 * No Cloudflare account, no domain and no DNS record are required.
 */
async function startCloudflared(opts: TunnelOptions): Promise<TunnelHandle> {
  const prefix = opts.command?.length ? opts.command : ["cloudflared"];
  const supervisor = new ChildSupervisor({
    name: "cloudflared",
    command: prefix[0]!,
    args: [
      ...prefix.slice(1),
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${opts.localPort}`,
    ],
    onLog: opts.onLog,
    restart: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, resetAfterMs: 60_000 },
  });

  await supervisor.start();
  let found: string | null = null;
  while (!found) {
    const line = await supervisor.waitForLine((l) => parseCloudflaredUrl(l) !== null, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS).catch(
      async () => {
        await supervisor.stop();
        throw new Error(`cloudflared did not report a public URL within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      },
    );
    found = parseCloudflaredUrl(line);
  }

  return {
    provider: "cloudflared",
    publicUrl: found,
    stopped: () => !supervisor.isRunning(),
    stop: () => supervisor.stop(),
  };
}

/**
 * Tailscale funnel: `tailscaled` keeps serving, so the child we supervise is the CLI itself.
 * The public hostname is the node's own tailnet DNS name.
 */
async function startTailscale(opts: TunnelOptions): Promise<TunnelHandle> {
  const run = opts.run ?? defaultRunner;
  const enable = await run("tailscale", ["funnel", "--bg", String(opts.localPort)]);
  if (enable.code !== 0) {
    throw new Error(`tailscale funnel failed: ${(enable.stderr || enable.stdout).trim() || `exit ${enable.code}`}`);
  }
  const status = await run("tailscale", ["status", "--json"]);
  const dns = parseTailscaleDnsName(status.stdout);
  const publicUrl = dns ? funnelUrlFromDnsName(dns) : null;
  if (!publicUrl) {
    await run("tailscale", ["funnel", "reset"]);
    throw new Error("tailscale funnel is up but `tailscale status --json` reported no DNS name");
  }

  let stopped = false;
  return {
    provider: "tailscale",
    publicUrl,
    stopped: () => stopped,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const off = await run("tailscale", ["funnel", "reset"]);
      if (off.code !== 0) opts.onLog(`tailscale: funnel reset failed (${(off.stderr || off.stdout).trim() || `exit ${off.code}`})`);
    },
  };
}

export async function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  switch (opts.provider) {
    case "cloudflared":
      return startCloudflared(opts);
    case "tailscale":
      return startTailscale(opts);
    case "none": {
      const publicUrl = `http://127.0.0.1:${opts.localPort}`;
      return { provider: "none", publicUrl, stopped: () => true, stop: async () => {} };
    }
    default:
      throw new Error(`unknown tunnel provider "${String(opts.provider)}" (expected cloudflared, tailscale or none)`);
  }
}

function defaultRunner(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code?: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
