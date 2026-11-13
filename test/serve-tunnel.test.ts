import { describe, expect, it } from "vitest";
import { funnelUrlFromDnsName, parseCloudflaredUrl, parseTailscaleDnsName, startTunnel } from "../src/host/serve/tunnel.ts";

const BANNER = "console.error('|  https://fake-tunnel.trycloudflare.com  |'); setInterval(() => {}, 1000);";

describe("tunnel URL parsing", () => {
  it("reads the assigned quick-tunnel host from a cloudflared banner line", () => {
    expect(parseCloudflaredUrl("|  https://fake-tunnel.trycloudflare.com  |")).toBe("https://fake-tunnel.trycloudflare.com");
    expect(parseCloudflaredUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
    expect(parseCloudflaredUrl("https://example.com")).toBeNull();
  });

  it("builds the funnel URL from the tailscale DNS name", () => {
    expect(parseTailscaleDnsName('{"Self":{"DNSName":"pc.tail1234.ts.net."}}')).toBe("pc.tail1234.ts.net.");
    expect(parseTailscaleDnsName("not json")).toBeNull();
    expect(parseTailscaleDnsName('{"Self":{}}')).toBeNull();
    expect(funnelUrlFromDnsName("pc.tail1234.ts.net.")).toBe("https://pc.tail1234.ts.net");
    expect(funnelUrlFromDnsName("")).toBeNull();
  });
});

describe("startTunnel", () => {
  it("returns the loopback URL for the none provider", async () => {
    const handle = await startTunnel({ provider: "none", localPort: 4321, onLog: () => {} });
    expect(handle.publicUrl).toBe("http://127.0.0.1:4321");
    await handle.stop();
  });

  it("waits for the cloudflared banner and stops the child afterwards", async () => {
    const lines: string[] = [];
    const handle = await startTunnel({
      provider: "cloudflared",
      localPort: 4321,
      onLog: (l) => lines.push(l),
      command: [process.execPath, "-e", BANNER],
    });

    expect(handle.publicUrl).toBe("https://fake-tunnel.trycloudflare.com");
    expect(lines.some((l) => l.includes("trycloudflare"))).toBe(true);
    await handle.stop();
    expect(handle.stopped()).toBe(true);
  });

  it("fails with an actionable message when cloudflared never prints a URL", async () => {
    await expect(
      startTunnel({
        provider: "cloudflared",
        localPort: 4321,
        onLog: () => {},
        timeoutMs: 200,
        command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      }),
    ).rejects.toThrow(/cloudflared did not report a public URL/);
  });

  it("runs tailscale funnel and reads the DNS name from status", async () => {
    const calls: string[][] = [];
    const handle = await startTunnel({
      provider: "tailscale",
      localPort: 4321,
      onLog: () => {},
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "status") return { code: 0, stdout: '{"Self":{"DNSName":"pc.tail1234.ts.net."}}', stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(handle.publicUrl).toBe("https://pc.tail1234.ts.net");
    expect(calls[0]).toEqual(["tailscale", "funnel", "--bg", "4321"]);
    await handle.stop();
    expect(calls.at(-1)).toEqual(["tailscale", "funnel", "reset"]);
  });

  it("surfaces the tailscale error when funnel is not enabled on the tailnet", async () => {
    await expect(
      startTunnel({
        provider: "tailscale",
        localPort: 4321,
        onLog: () => {},
        run: async () => ({ code: 1, stdout: "", stderr: "funnel is not enabled for this tailnet" }),
      }),
    ).rejects.toThrow(/funnel is not enabled for this tailnet/);
  });
});
