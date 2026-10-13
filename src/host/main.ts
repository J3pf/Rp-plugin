// rp-host CLI: run | install | uninstall | status | init
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../extension/config.ts";
import { loadHostConfig, writeDefaultHostConfig } from "./config.ts";
import { HostConnection } from "./connection.ts";
import { HostManager } from "./manager.ts";
import { installService, uninstallService } from "./service.ts";

const HELP = `rp-host — create Pi agents from the RP phone app

Usage: rp-host <command>
  run         Connect to the relay and serve spawn requests (default)
  install     Install as a service (systemd --user / Task Scheduler at logon / launchd)
  uninstall   Remove the service
  status      Show config, available backends and spawned agents
  init        Write a default ~/.config/rp/host.json if missing

Requires the PC to be paired first (/rp pair inside Pi). Config: host.json next to RP's config.json.`;

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "run";
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "rp-host.mjs");
  switch (cmd) {
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    case "init": {
      const { path: p, exists } = loadHostConfig();
      if (exists) console.log(`already exists: ${p}`);
      else {
        writeDefaultHostConfig(p);
        console.log(`written: ${p}`);
      }
      return;
    }
    case "install":
      console.log(await installService({ nodePath: process.execPath, scriptPath, platform: process.platform }));
      return;
    case "uninstall":
      console.log(await uninstallService(process.platform));
      return;
    case "status": {
      const { cfg: host, path: hp, exists } = loadHostConfig();
      const mgr = new HostManager(host);
      const rep = await mgr.detect(true);
      console.log(JSON.stringify({ hostConfig: hp, exists, roots: host.roots, launchers: host.launchers, backends: rep, default: await mgr.defaultBackend(), spawned: mgr.list() }, null, 2));
      return;
    }
    case "run": {
      const { cfg } = loadConfig();
      if (!cfg.relayUrl || !cfg.machineId || !cfg.machineToken) throw new Error("this PC is not paired: run `/rp pair <url> <code>` inside Pi first");
      const { cfg: host, path: hp, exists } = loadHostConfig();
      if (!exists) {
        try {
          writeDefaultHostConfig(hp);
          fs.chmodSync(hp, 0o600);
        } catch {
          /* ignore */
        }
      }
      const manager = new HostManager(host);
      const conn = new HostConnection({
        relayUrl: cfg.relayUrl,
        machineId: cfg.machineId,
        token: cfg.machineToken,
        cfg: host,
        manager,
        onLog: (m) => console.error(`[rp-host] ${m}`),
      });
      conn.start();
      console.error(`[rp-host] running (roots: ${host.roots.join(", ")})`);
      const stop = () => {
        conn.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {});
      return;
    }
    default:
      console.error(HELP);
      throw new Error(`unknown command "${cmd}"`);
  }
}
