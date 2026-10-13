// Entry point of the Pi package. The factory only registers handlers/commands/flags: no sockets, no timers here.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { detectStaticEnv } from "./environment.ts";
import { FORWARDED_EVENTS } from "./forwarder.ts";
import { Runtime } from "./runtime.ts";
import { registerCommands } from "./commands.ts";

export default function rp(pi: ExtensionAPI): void {
  const env = detectStaticEnv(process.env);
  const { cfg, path: cfgPath } = loadConfig(process.env);

  pi.registerFlag("rp-off", { type: "boolean", description: "Disable RP for this run" });
  pi.registerFlag("rp-spawn-id", { type: "string", description: "Internal: id assigned by rp-host" });

  // Gentle Agents children are never registered as agents; their questions arrive through the parent (G4/G5).
  if (env.isGentleChild && cfg.subagents === "skip") return;

  let rt: Runtime | undefined;
  let lastReason = "startup";

  const canRun = () => cfg.enabled && !!cfg.machineToken && !!cfg.relayUrl && !pi.getFlag("rp-off");

  const start = (ctx: ExtensionContext, reason = lastReason) => {
    if (rt || !canRun()) return;
    rt = new Runtime(pi, ctx, cfg, env, reason);
    rt.start();
  };
  const stop = async () => {
    const r = rt;
    rt = undefined;
    await r?.dispose();
  };

  registerCommands(pi, {
    cfg,
    cfgPath,
    getRuntime: () => rt,
    startRuntime: (ctx: ExtensionCommandContext) => start(ctx),
    stopRuntime: stop,
  });

  pi.on("session_start", async (ev, ctx) => {
    lastReason = ev.reason;
    await stop(); // a reload leaves the previous runtime invalid
    start(ctx, ev.reason);
  });
  pi.on("session_shutdown", async () => {
    await stop();
  });

  for (const name of FORWARDED_EVENTS) pi.on(name as any, (ev: any, ctx: ExtensionContext) => rt?.forward(name, ev, ctx));
  pi.on("session_before_compact", (_ev, ctx) => {
    rt?.touch(ctx);
    rt?.onCompactStart();
  });
  pi.on("session_compact_failed", () => rt?.statuses.setCompacting(false));

  pi.on("tool_call", (ev, ctx) => rt?.onToolCall(ev, ctx));
  pi.on("tool_execution_start", (ev) => rt?.adapters.onStart(ev));
  pi.on("tool_execution_end", (ev) => rt?.adapters.onEnd(ev));
  pi.on("input", (ev, ctx) => {
    rt?.onInput(ev, ctx);
  });
  pi.on("ui_prompt_start", (ev) => rt?.terminalWait(ev, true));
  pi.on("ui_prompt_end", (ev) => rt?.terminalWait(ev, false));
  pi.events.on("pi-permission-system:permission-request", (d) => rt?.classifier.onPermissionRequest(d)); // gentle-pi P1
}
