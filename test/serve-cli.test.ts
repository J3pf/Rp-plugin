import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/host/main.ts";
import { resolveServeSettings, startServe } from "../src/host/serve/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpservemain-"));
  dirs.push(d);
  return d;
}

const backup = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("RP_SERVE_")) delete process.env[k];
});
afterEach(() => {
  Object.assign(process.env, backup);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Fake relay: answers /healthz on the port taken from the config file passed with --config. */
const FAKE_RELAY = `
const fs = require("node:fs");
const http = require("node:http");
const i = process.argv.indexOf("--config");
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("{}"); return; }
  res.writeHead(404); res.end();
}).listen(cfg.listen.port, cfg.listen.host, () => console.log("ready"));
setInterval(() => {}, 1000);
`;
/** Writes a fake relay module and returns its path, used through serve.relayPath. */
function fakeRelay(dir: string, source = FAKE_RELAY): string {
  const file = path.join(dir, "fake-relay.cjs");
  fs.writeFileSync(file, source);
  return file;
}
/** Fake tunnel binary: prints a banner, and records a clean SIGTERM shutdown. */
const fakeTunnel = (marker: string): string[] => [
  process.execPath,
  "-e",
  `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bye'); process.exit(0); });
   console.error('|  https://fake-direct.trycloudflare.com  |');
   setInterval(() => {}, 1000);`,
];

describe("resolveServeSettings", () => {
  it("defaults to cloudflared, the rp-relay command and a data dir under the RP config dir", () => {
    const settings = resolveServeSettings({ serve: {} }, { XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv, "linux");
    expect(settings.tunnel).toBe("cloudflared");
    expect(settings.relayCommand).toBeNull();
    expect(settings.dataDir).toBe("/tmp/xdg/rp/direct");
  });

  it("lets the environment override tunnel, relay command and data dir", () => {
    const settings = resolveServeSettings(
      { serve: { tunnel: "cloudflared", relayCommand: "rp-relay", dataDir: "/from/config" } },
      {
        RP_SERVE_TUNNEL: "none",
        RP_SERVE_RELAY_COMMAND: "node /opt/rp/cli.js",
        RP_SERVE_DATA_DIR: "/from/env",
      } as NodeJS.ProcessEnv,
      "linux",
    );
    expect(settings.tunnel).toBe("none");
    expect(settings.relayCommand).toBe("node /opt/rp/cli.js");
    expect(settings.dataDir).toBe("/from/env");
  });

  it("rejects an unknown tunnel provider instead of silently going direct", () => {
    expect(() => resolveServeSettings({ serve: {} }, { RP_SERVE_TUNNEL: "ngrok" } as NodeJS.ProcessEnv, "linux")).toThrow(
      /unknown serve.tunnel "ngrok"/,
    );
  });
});

describe("startServe", () => {
  it("starts tunnel first, wires its URL into the relay config, and waits for health", async () => {
    const dataDir = tmp();
    const lines: string[] = [];
    const serve = await startServe({
      tunnel: "cloudflared",
      relayPath: fakeRelay(dataDir),
      dataDir,
      onLog: (l) => lines.push(l),
      tunnelCommand: fakeTunnel(path.join(dataDir, "tunnel.stopped")),
      healthTimeoutMs: 10_000,
    });

    expect(serve.publicUrl).toBe("https://fake-direct.trycloudflare.com");
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "relay.json"), "utf8"));
    expect(cfg.publicUrl).toBe("https://fake-direct.trycloudflare.com");
    expect(cfg.listen.port).toBe(serve.port);
    expect(fs.statSync(path.join(dataDir, "relay.json")).mode & 0o777).toBe(0o600);

    await serve.stop();
    expect(serve.stopped()).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "tunnel.stopped"), "utf8")).toBe("bye");
  });

  it("uses the loopback URL when the tunnel is disabled", async () => {
    const dataDir = tmp();
    const serve = await startServe({
      tunnel: "none",
      relayPath: fakeRelay(dataDir),
      dataDir,
      onLog: () => {},
      healthTimeoutMs: 10_000,
    });
    expect(serve.publicUrl).toBe(`http://127.0.0.1:${serve.port}`);
    await serve.stop();
  });

  it("stops the tunnel when the relay never becomes healthy, leaving no orphan process", async () => {
    const dataDir = tmp();
    const marker = path.join(dataDir, "tunnel.stopped");
    await expect(
      startServe({
        tunnel: "cloudflared",
        relayPath: fakeRelay(dataDir, "console.error('boom: cannot open database'); setInterval(() => {}, 1000);"),
        dataDir,
        onLog: () => {},
        tunnelCommand: fakeTunnel(marker),
        healthTimeoutMs: 600,
      }),
    ).rejects.toThrow(/boom: cannot open database/);
    expect(fs.readFileSync(marker, "utf8")).toBe("bye");
  });
});

describe("rp-host serve CLI", () => {
  it("prints the public URL as JSON and stops the stack on the stop signal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = vi.fn(async () => {});
    const dataDir = tmp();
    await main(["serve", "--data-dir", dataDir, "--tunnel", "none"], {
      startServe: async (o) => {
        expect(o.tunnel).toBe("none");
        expect(o.dataDir).toBe(dataDir);
        return {
          publicUrl: "https://fake.example",
          port: 4321,
          dataDir,
          relayConfigPath: "",
          provider: "none" as const,
          stopped: () => true,
          stop,
        };
      },
      waitForStop: async () => {},
    });

    const ready = JSON.parse(String(log.mock.calls[0]![0]));
    expect(ready).toMatchObject({ publicUrl: "https://fake.example", port: 4321, dataDir });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects an unknown --tunnel value with the accepted list", async () => {
    await expect(main(["serve", "--tunnel", "ngrok"], { startServe: vi.fn(), waitForStop: async () => {} })).rejects.toThrow(
      /cloudflared, tailscale, none/,
    );
  });
});
