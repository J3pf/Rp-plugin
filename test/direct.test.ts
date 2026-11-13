import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPairUri, startDirectMode } from "../src/extension/direct.ts";

const dirs: string[] = [];
function dataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpdirect-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface CliCall {
  args: string[];
  configPath: string;
}

function harness(overrides: { cli?: (args: string[], configPath: string) => Promise<{ code: number; stdout: string; stderr: string }> } = {}) {
  const calls: CliCall[] = [];
  const paired: Array<{ url: string; code: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const stopServe = vi.fn(async () => {});
  const startServe = vi.fn(async () => ({
    publicUrl: "https://direct.example",
    port: 4321,
    dataDir: "/tmp/x",
    relayConfigPath: "/tmp/x/relay.json",
    provider: "cloudflared" as const,
    stopped: () => false,
    stop: stopServe,
  }));
  const relayCli = async (args: string[], configPath: string) => {
    calls.push({ args, configPath });
    if (overrides.cli) return overrides.cli(args, configPath);
    if (args[0] === "pair" && args[1] === "machine") {
      return { code: 0, stdout: JSON.stringify({ code: "MACH2345", expiresAt: "2026-01-01T00:10:00.000Z", relayUrl: "https://direct.example" }), stderr: "" };
    }
    if (args[0] === "pair" && args[1] === "device") {
      return { code: 0, stdout: JSON.stringify({ code: "DEVI2345", uri: "rp://pair?u=x&c=DEVI2345", expiresAt: "2026-01-01T00:10:00.000Z" }), stderr: "" };
    }
    if (args[0] === "qr") return { code: 0, stdout: "▄▀▄▀", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  const pairMachine = vi.fn(async (url: string, code: string, body: Record<string, unknown>) => {
    paired.push({ url, code, body });
    return { machineId: "mach-1", machineToken: "tok-1" };
  });
  return { calls, paired, lines, stopServe, startServe, relayCli, pairMachine };
}

async function run(h: ReturnType<typeof harness>, dir: string, extra: Record<string, unknown> = {}) {
  return startDirectMode({
    dataDir: dir,
    keyPath: path.join(dir, "machine.key"),
    tunnel: "cloudflared",
    name: "PC de Jorge",
    context: "personal",
    onLog: (l) => h.lines.push(l),
    deps: {
      startServe: h.startServe as never,
      relayCli: h.relayCli as never,
      pairMachine: h.pairMachine as never,
      hostname: "pc-jorge",
    },
    ...extra,
  });
}

describe("buildPairUri", () => {
  it("emits the v2 direct QR with endpoint kind and fingerprint", () => {
    const uri = buildPairUri({ publicUrl: "https://x.trycloudflare.com/", code: "DEVI2345", endpointKind: "direct", fingerprint: "abcdefghij0123456789_-", name: "PC de Jorge" });
    expect(uri).toBe(
      "rp://pair?u=https%3A%2F%2Fx.trycloudflare.com&c=DEVI2345&k=direct&f=abcdefghij0123456789_-&n=PC%20de%20Jorge",
    );
  });

  it("keeps the v1 shape for relay pairing and never invents a fingerprint", () => {
    expect(buildPairUri({ publicUrl: "https://relay.example", code: "ABCD2345", endpointKind: "relay" })).toBe(
      "rp://pair?u=https%3A%2F%2Frelay.example&c=ABCD2345",
    );
  });
});

describe("startDirectMode", () => {
  it("creates the machine key, pairs this PC over loopback and paints a v2 QR", async () => {
    const dir = dataDir();
    const h = harness();
    const run1 = await run(h, dir);

    expect(run1.publicUrl).toBe("https://direct.example");
    expect(fs.statSync(path.join(dir, "machine.key")).mode & 0o777).toBe(0o600);
    expect(run1.keyId).toHaveLength(22);

    // The PC pairs over loopback, never through the tunnel, and publishes its public key.
    expect(h.paired).toHaveLength(1);
    expect(h.paired[0]!.url).toBe("http://127.0.0.1:4321");
    expect(h.paired[0]!.code).toBe("MACH2345");
    expect(h.paired[0]!.body).toMatchObject({ name: "PC de Jorge", context: "personal", pubkey: run1.pubkey });
    const machine = JSON.parse(fs.readFileSync(path.join(dir, "machine.json"), "utf8"));
    expect(machine).toMatchObject({ machineId: "mach-1", machineToken: "tok-1", keyId: run1.keyId });
    expect(fs.statSync(path.join(dir, "machine.json")).mode & 0o777).toBe(0o600);

    // The CLI always works on this instance's config file, never on the user's own relay config.
    expect(h.calls.every((c) => c.configPath === path.join(dir, "relay.json"))).toBe(true);
    expect(run1.uri).toContain(`f=${run1.keyId}`);
    expect(run1.uri).toContain("k=direct");
    expect(run1.uri).toContain("c=DEVI2345");
    expect(run1.uri).toContain("u=https%3A%2F%2Fdirect.example");
    expect(h.calls.at(-1)!.args).toEqual(["qr", run1.uri]);
    expect(run1.qr).toContain("▄");

    await run1.stop();
  });

  it("reuses the stored machine pairing and key on the next run", async () => {
    const dir = dataDir();
    const first = await run(harness(), dir);
    await first.stop();

    const h = harness();
    const second = await run(h, dir);
    expect(h.paired).toHaveLength(0);
    expect(second.keyId).toBe(first.keyId);
    expect(second.machinePaired).toBe(false);
    await second.stop();
  });

  it("stops the embedded stack when the pairing CLI fails", async () => {
    const dir = dataDir();
    const h = harness({
      cli: async (args) => (args[0] === "pair" && args[1] === "device" ? { code: 1, stdout: "", stderr: "database is locked" } : { code: 0, stdout: JSON.stringify({ code: "MACH2345" }), stderr: "" }),
    });
    await expect(run(h, dir)).rejects.toThrow(/database is locked/);
    expect(h.stopServe).toHaveBeenCalledOnce();
  });
});
