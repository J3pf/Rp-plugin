// rp-host CLI: run | install | uninstall | status | init | agy-hook
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../extension/config.js";
import { expandHome } from "../shared/platform.js";
import { addRoot, loadHostConfig, missingRoots, NO_ROOTS_HINT, removeRoot, writeDefaultHostConfig } from "./config.js";
import { HostConnection } from "./connection.js";
import { HerdrAgentBridge, installAgyHooks, runAgyHook } from "./herdr-bridge.js";
import { HostManager } from "./manager.js";
import { inspectService, installService, resolveStableNodePath, uninstallService } from "./service.js";
const HELP = `rp-host — create Pi agents from the RP phone app

Usage: rp-host <command>
  run         Connect to the relay and serve spawn requests (default)
  install     Install as a service (systemd --user / Task Scheduler at logon / launchd)
  uninstall   Remove the service
  status      Show config, available backends and spawned agents
  doctor      Check service status and diagnose autostart / health
  roots       List / add <path> / remove <path> project folders the phone may browse
  init        Write a default ~/.config/rp/host.json if missing
  agy-hook    Antigravity CLI PreToolUse hook entrypoint

Requires the PC to be paired first (/rp pair inside Pi). Config: host.json next to RP's config.json.`;
async function readStdinText(maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += buf.length;
        chunks.push(buf);
        if (total >= maxBytes)
            break;
    }
    return Buffer.concat(chunks).toString("utf8");
}
export async function main(argv) {
    const cmd = argv[0] ?? "run";
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "rp-host.mjs");
    switch (cmd) {
        case "-h":
        case "--help":
        case "help":
            console.log(HELP);
            return;
        case "agy-hook": {
            const stdinText = await readStdinText();
            const { cfg } = loadConfig();
            const decision = await runAgyHook(cfg, stdinText);
            process.stdout.write(JSON.stringify(decision) + "\n");
            return;
        }
        case "init": {
            const { path: p, exists } = loadHostConfig();
            if (exists)
                console.log(`already exists: ${p}`);
            else {
                writeDefaultHostConfig(p);
                console.log(`written: ${p}`);
            }
            return;
        }
        case "roots": {
            const { cfg, path: hp } = loadHostConfig();
            const [sub, target] = [argv[1] ?? "list", argv[2]];
            if (sub === "list") {
                for (const r of cfg.roots)
                    console.log(`${fs.existsSync(r) ? "ok     " : "missing"} ${r}`);
                if (missingRoots(cfg))
                    console.log(NO_ROOTS_HINT);
                process.exitCode = missingRoots(cfg) ? 1 : 0;
                return;
            }
            if ((sub === "add" || sub === "remove") && target) {
                const roots = sub === "add" ? addRoot(hp, target) : removeRoot(hp, target);
                console.log(`${sub === "add" ? "added" : "removed"}: ${path.resolve(expandHome(target))}`);
                console.log(`roots: ${roots.length ? roots.join(", ") : "(default / autodetect)"}`);
                console.log("restart rp-host to apply: `rp-host install` (or restart the service)");
                return;
            }
            throw new Error("usage: rp-host roots [list | add <path> | remove <path>]");
        }
        case "install": {
            const stableNode = resolveStableNodePath(process.env, process.platform);
            try {
                installAgyHooks(stableNode, scriptPath);
            }
            catch {
                /* best effort */
            }
            console.log(await installService({ nodePath: process.execPath, scriptPath, platform: process.platform }));
            return;
        }
        case "uninstall":
            console.log(await uninstallService(process.platform));
            return;
        case "doctor": {
            const spec = {
                nodePath: resolveStableNodePath(process.env, process.platform),
                scriptPath,
                platform: process.platform,
            };
            const inspection = await inspectService(spec);
            const healthy = inspection.installed && inspection.enabled !== false && inspection.running && !inspection.stale && inspection.nodePathValid && inspection.scriptPathValid &&
                (inspection.platform !== "linux" || inspection.details?.linger === true) && !missingRoots(loadHostConfig().cfg);
            const status = healthy ? "OK" : "PROBLEM";
            if (argv.includes("--json")) {
                console.log(JSON.stringify({ status, healthy, ...inspection }, null, 2));
            }
            else {
                console.log(`Platform: ${inspection.platform}`);
                console.log(`Installed: ${inspection.installed ? "yes" : "no"}`);
                if (inspection.enabled !== undefined)
                    console.log(`Enabled: ${inspection.enabled ? "yes" : "no"}`);
                console.log(`Running: ${inspection.running ? "yes" : "no"}`);
                console.log(`Node Path: ${inspection.nodePath ?? "not reported"} (${inspection.nodePathValid ? "valid" : "invalid/stale"})`);
                console.log(`Script Path: ${inspection.scriptPath ?? "not reported"} (${inspection.scriptPathValid ? "valid" : "missing"})`);
                console.log(`Stale: ${inspection.stale ? "yes" : "no"}`);
                if (inspection.staleReason)
                    console.log(`Stale Reason: ${inspection.staleReason}`);
                if (inspection.platform === "linux") {
                    console.log(`Linger: ${inspection.details?.linger === true ? "enabled" : "disabled"}`);
                    if (inspection.details?.lingerError)
                        console.log(`Linger Error: ${inspection.details.lingerError}`);
                }
                if (inspection.details && Object.keys(inspection.details).length > 0)
                    console.log(`Details: ${JSON.stringify(inspection.details)}`);
                console.log(`Status: ${status}`);
                if (!healthy) {
                    const problems = [];
                    if (!inspection.installed)
                        problems.push("service is not installed");
                    if (inspection.enabled === false)
                        problems.push("service is disabled");
                    if (!inspection.running)
                        problems.push("service is not running");
                    if (inspection.stale)
                        problems.push(inspection.staleReason ?? "service configuration is stale");
                    if (!inspection.nodePathValid)
                        problems.push("node path is invalid or stale");
                    if (!inspection.scriptPathValid)
                        problems.push("host script path is missing");
                    if (inspection.platform === "linux" && inspection.details?.linger !== true)
                        problems.push("systemd user lingering is disabled");
                    if (missingRoots(loadHostConfig().cfg))
                        problems.push(NO_ROOTS_HINT);
                    for (const problem of problems)
                        console.log(`Problem: ${problem}`);
                }
            }
            process.exitCode = healthy ? 0 : 1;
            return;
        }
        case "status": {
            const { cfg: host, path: hp, exists } = loadHostConfig();
            const mgr = new HostManager(host);
            const rep = await mgr.detect(true);
            console.log(JSON.stringify({ hostConfig: hp, exists, roots: host.roots, launchers: host.launchers, backends: rep, default: await mgr.defaultBackend(), spawned: mgr.list() }, null, 2));
            return;
        }
        case "run": {
            const { cfg } = loadConfig();
            if (!cfg.relayUrl || !cfg.machineId || !cfg.machineToken)
                throw new Error("this PC is not paired: run `/rp pair <url> <code>` inside Pi first");
            const { cfg: host, path: hp, exists } = loadHostConfig();
            if (!exists) {
                try {
                    writeDefaultHostConfig(hp);
                    fs.chmodSync(hp, 0o600);
                }
                catch {
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
            const bridge = new HerdrAgentBridge({
                relayUrl: cfg.relayUrl,
                machineId: cfg.machineId,
                token: cfg.machineToken,
                cfg,
                herdrSession: host.herdrSession,
                onLog: (m) => console.error(`[rp-host] ${m}`),
            });
            conn.start();
            bridge.start();
            console.error(`[rp-host] running (roots: ${host.roots.join(", ")})`);
            const stop = () => {
                bridge.stop();
                conn.stop();
                process.exit(0);
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
            await new Promise(() => { });
            return;
        }
        default:
            console.error(HELP);
            throw new Error(`unknown command "${cmd}"`);
    }
}
