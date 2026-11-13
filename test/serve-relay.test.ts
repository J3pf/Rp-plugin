import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRelayConfig,
  pickFreePort,
  resolveRelayCommand,
  startRelayProcess,
  waitForHealth,
} from "../src/host/serve/relay.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpserve-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Fake relay: reads `--config <path>` and answers /healthz on the configured port. */
const FAKE_RELAY = `
const fs = require("node:fs");
const http = require("node:http");
const i = process.argv.indexOf("--config");
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
if (cfg.profile !== "single-host") { console.error("wrong profile"); process.exit(9); }
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, {"content-type": "application/json"}); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
server.listen(cfg.listen.port, cfg.listen.host, () => console.log("listening " + cfg.listen.port));
setInterval(() => {}, 1000);
`;

describe("relay config for the embedded single-host profile", () => {
  it("writes a single-host config with backup disabled and the tunnel URL as publicUrl", () => {
    const cfg = buildRelayConfig({ publicUrl: "https://x.trycloudflare.com", port: 4321, dataDir: "/tmp/rp" });
    expect(cfg.profile).toBe("single-host");
    expect(cfg.listen).toEqual({ host: "127.0.0.1", port: 4321 });
    expect(cfg.publicUrl).toBe("https://x.trycloudflare.com");
    expect(cfg.dataDir).toBe("/tmp/rp");
    expect(cfg.backup).toEqual({ enabled: false, intervalMinutes: 1440, keepDays: 1 });
  });

  it("picks a free loopback port", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    const probe = await pickFreePort();
    expect(probe).toBeGreaterThan(0);
  });

  it("resolves the relay command from an explicit path, the config, or the PATH default", () => {
    const script = path.join(tmp(), "dist", "cli", "index.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "// fake");
    expect(resolveRelayCommand({ relayPath: script }, process.execPath)).toEqual([process.execPath, script]);
    expect(resolveRelayCommand({ relayCommand: "node /x/cli.js" }, process.execPath)).toEqual(["node", "/x/cli.js"]);
    expect(resolveRelayCommand({ relayCommand: 'my-relay --flag "a b"' }, process.execPath)).toEqual(["my-relay", "--flag", "a b"]);
    expect(resolveRelayCommand({}, process.execPath)).toEqual(["rp-relay"]);
  });
});

describe("relay readiness", () => {
  it("resolves once /healthz answers and rejects after the timeout", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await expect(waitForHealth({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs: 2_000 })).resolves.toBeUndefined();
    await new Promise<void>((r) => server.close(() => r()));

    await expect(waitForHealth({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs: 300, intervalMs: 50 })).rejects.toThrow(
      /relay did not become healthy/,
    );
  });
});

describe("startRelayProcess", () => {
  it("spawns the relay with --config, waits for health and stops it", async () => {
    const dir = tmp();
    const port = await pickFreePort();
    const configPath = path.join(dir, "relay.json");
    fs.writeFileSync(configPath, JSON.stringify(buildRelayConfig({ publicUrl: "http://127.0.0.1:1", port, dataDir: dir })));
    const lines: string[] = [];

    const relay = await startRelayProcess({
      command: [process.execPath, "-e", FAKE_RELAY],
      configPath,
      healthUrl: `http://127.0.0.1:${port}/healthz`,
      onLog: (l) => lines.push(l),
      timeoutMs: 10_000,
    });

    expect(relay.port).toBe(port);
    expect(relay.stopped()).toBe(false);
    expect(lines.some((l) => l.includes(`listening ${port}`))).toBe(true);
    await relay.stop();
    expect(relay.stopped()).toBe(true);
  });

  it("fails with an install hint when the relay command is missing", async () => {
    const dir = tmp();
    const configPath = path.join(dir, "relay.json");
    fs.writeFileSync(configPath, JSON.stringify(buildRelayConfig({ publicUrl: "http://127.0.0.1:1", port: 1, dataDir: dir })));

    await expect(
      startRelayProcess({
        command: ["rp-relay-definitely-missing"],
        configPath,
        healthUrl: "http://127.0.0.1:1/healthz",
        onLog: () => {},
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/npm i -g @j3pf\/rp-relay/);
  });

  it("fails with the relay output when it never becomes healthy", async () => {
    const dir = tmp();
    const configPath = path.join(dir, "relay.json");
    fs.writeFileSync(configPath, JSON.stringify(buildRelayConfig({ publicUrl: "http://127.0.0.1:1", port: 1, dataDir: dir })));

    await expect(
      startRelayProcess({
        command: [process.execPath, "-e", "console.error('boom: cannot open database'); setInterval(() => {}, 1000);"],
        configPath,
        healthUrl: `http://127.0.0.1:${await pickFreePort()}/healthz`,
        onLog: () => {},
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/boom: cannot open database/);
  });
});
