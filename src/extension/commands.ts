// /rp pair|status|doctor|on|off|gate|test|unpair  (PLAN §11)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { httpRequest, toHttpUrl, toWsUrl } from "../shared/http.ts";
import { piHomes } from "../shared/platform.ts";
import { errMsg } from "../shared/util.ts";
import { updateConfigFile, type GateMode, type RpConfig } from "./config.ts";
import { GENTLE_RANGE, detectGentleVersion, gentleVersionSupported, hasGentleAskTools } from "./compat.ts";
import type { Runtime } from "./runtime.ts";
import { promptContext } from "./prompts/classify.ts";
import WebSocket from "ws";
import { getProxyAgent } from "../shared/http.ts";

export interface CommandHooks {
  cfg: RpConfig;
  cfgPath: string;
  getRuntime(): Runtime | undefined;
  startRuntime(ctx: ExtensionCommandContext): void;
  stopRuntime(): Promise<void>;
}

export const PLUGIN_PACKAGE = "@j3pf/pi-rp";
const SUBCOMMANDS = ["pair", "status", "doctor", "on", "off", "gate", "test", "unpair"];
const GATE_MODES: GateMode[] = ["auto-detect", "off", "dangerous", "writes", "all"];

/** Split a command line honoring single/double quotes. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export function parseFlags(tokens: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0) flags[t.slice(2, eq)] = t.slice(eq + 1);
      else if (tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith("--") && ["name", "context"].includes(t.slice(2))) flags[t.slice(2)] = tokens[++i]!;
      else flags[t.slice(2)] = true;
    } else positional.push(t);
  }
  return { positional, flags };
}

export function registerCommands(pi: ExtensionAPI, hooks: CommandHooks): void {
  pi.registerCommand("rp", {
    description: "RP: pair|status|doctor|on|off|gate|test|unpair",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = tokenize(args ?? "");
      const sub = tokens.shift() ?? "status";
      try {
        switch (sub) {
          case "pair":
            return await cmdPair(hooks, tokens, ctx);
          case "status":
            return cmdStatus(hooks, ctx);
          case "doctor":
            return await cmdDoctor(pi, hooks, ctx);
          case "on":
            return await cmdOn(hooks, ctx);
          case "off":
            return await cmdOff(hooks, tokens, ctx);
          case "gate":
            return cmdGate(hooks, tokens, ctx);
          case "test":
            return await cmdTest(hooks, ctx);
          case "unpair":
            return await cmdUnpair(hooks, ctx);
          default:
            ctx.ui.notify(`RP: subcomando desconocido "${sub}". Usa: ${SUBCOMMANDS.join(" | ")}`, "warning");
        }
      } catch (e) {
        ctx.ui.notify(`RP ${sub}: ${errMsg(e)}`, "error");
      }
    },
  });
}

// ---------- pair ----------

export async function pairMachine(relayUrl: string, code: string, body: { hostname: string; name?: string; context?: string }) {
  const res = await httpRequest(toHttpUrl(relayUrl, "/v1/pair/machine"), { method: "POST", body: { code, ...body }, timeoutMs: 15_000 });
  if (res.status !== 200 || !res.json?.machineId || !res.json?.machineToken) {
    const reason = res.json?.message || res.json?.error?.message || `http ${res.status}`;
    throw new Error(`el relay rechazó el emparejamiento (${reason})`);
  }
  return { machineId: String(res.json.machineId), machineToken: String(res.json.machineToken) };
}

async function cmdPair(h: CommandHooks, tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
  const { positional, flags } = parseFlags(tokens);
  let url: string | undefined = positional[0];
  let code: string | undefined = positional[1];
  if (!url && ctx.hasUI) url = (await ctx.ui.input("URL del relay", "https://relay.midominio.com")) ?? undefined;
  if (!code && ctx.hasUI) code = (await ctx.ui.input("Código de emparejamiento", "ABCD2345")) ?? undefined;
  if (!url || !code) {
    ctx.ui.notify("Uso: /rp pair <url> <código> [--name N] [--context personal|work|…]", "warning");
    return;
  }
  let name = typeof flags.name === "string" ? flags.name : undefined;
  let context = typeof flags.context === "string" ? flags.context : undefined;
  if (!name && ctx.hasUI) name = (await ctx.ui.input("Nombre de esta PC", os.hostname())) || os.hostname();
  if (!context && ctx.hasUI) context = (await ctx.ui.select("Contexto de esta PC", ["personal", "work", "otro…"])) ?? "personal";
  if (context === "otro…" && ctx.hasUI) context = (await ctx.ui.input("Contexto", "p. ej. cliente-x")) || "personal";
  const r = await pairMachine(url, code.trim().toUpperCase(), { hostname: os.hostname(), name, context });
  const saved = updateConfigFile(h.cfgPath, (c) => {
    c.relayUrl = url!.replace(/\/+$/, "");
    c.machineId = r.machineId;
    c.machineToken = r.machineToken;
    c.machine = { name, context };
    c.enabled = true;
  });
  Object.assign(h.cfg, { relayUrl: saved.relayUrl, machineId: saved.machineId, machineToken: saved.machineToken, machine: saved.machine, enabled: true });
  ctx.ui.notify(`RP: PC emparejada como "${name ?? os.hostname()}" (${context ?? "personal"}). Conectando…`, "info");
  await h.stopRuntime();
  h.startRuntime(ctx);
}

// ---------- status ----------

export function formatStatus(h: CommandHooks, rt: Runtime | undefined): string {
  const lines: string[] = [];
  lines.push(`Relay: ${h.cfg.relayUrl ?? "(sin configurar)"}`);
  lines.push(`PC: ${h.cfg.machine.name ?? "?"} · contexto ${h.cfg.machine.context ?? "?"} · ${h.cfg.machineToken ? "emparejada" : "SIN emparejar (/rp pair)"}`);
  lines.push(`Habilitado: ${h.cfg.enabled ? "sí" : "no"} · redactContent: ${h.cfg.redactContent}`);
  if (!rt) {
    lines.push("Runtime: inactivo en esta sesión");
    return lines.join("\n");
  }
  const d = rt.describe();
  lines.push(`Conexión: ${d.connected ? "conectado" : d.state} · transporte ${d.transport} · cola ${d.queued}`);
  lines.push(`agentId: ${d.agentId}`);
  lines.push(`Launcher: ${d.launcher} · herdr: ${d.herdr ? `pane ${d.herdr.paneId}` : "no"}`);
  lines.push(`gentle-pi: ${d.gentle ? `${d.gentle.version ?? "?"} (modo ${d.gentle.mode})` : "no"}`);
  lines.push(`Gate: ${d.gateMode} · prompts abiertos: ${d.openPrompts}`);
  lines.push(`Funciones: ${d.features.join(", ")}`);
  if (d.fatal) lines.push(`Desconectado por el relay: ${d.fatal.code} ${d.fatal.reason}`);
  return lines.join("\n");
}

function cmdStatus(h: CommandHooks, ctx: ExtensionCommandContext): void {
  ctx.ui.notify(formatStatus(h, h.getRuntime()), "info");
}

// ---------- doctor ----------

export interface Check {
  level: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
}

/** Does the Pi home's settings.json declare the plugin? Accepts string or {source} entries. */
export function pluginDeclaredIn(home: string): { found: boolean; file: string; error?: string } {
  const file = path.join(home, "settings.json");
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const pkgs: unknown[] = Array.isArray(json?.packages) ? json.packages : [];
    const found = pkgs.some((p) => {
      const src = typeof p === "string" ? p : (p as any)?.source;
      return typeof src === "string" && src.includes(PLUGIN_PACKAGE) && !src.startsWith("git:");
    });
    return { found, file };
  } catch (e) {
    return { found: false, file, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "no existe" : errMsg(e) };
  }
}

export function checkDeclared(env = process.env): Check[] {
  const homes = piHomes(env);
  const out: Check[] = [];
  for (const [label, dir, hint] of [
    ["Pi", homes.pi, `pi install npm:${PLUGIN_PACKAGE}`],
    ["gentle-shell", homes.gentleShell, `gentle-shell install npm:${PLUGIN_PACKAGE}`],
  ] as const) {
    const r = pluginDeclaredIn(dir);
    if (r.found) out.push({ level: "ok", label: `Plugin declarado en ${label}`, detail: r.file });
    else out.push({ level: label === "Pi" ? "warn" : "warn", label: `Plugin NO declarado en ${label}`, detail: `${r.file}${r.error ? ` (${r.error})` : ""} → ejecuta: ${hint}` });
  }
  return out;
}

async function probeWs(url: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const agent = await getProxyAgent();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve({ ok, detail });
    };
    const t0 = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(url, "/ws/agent"), { headers: { Authorization: `Bearer ${token}` }, agent, handshakeTimeout: 8000 });
    } catch (e) {
      resolve({ ok: false, detail: errMsg(e) });
      return;
    }
    ws.on("open", () => finish(true, `${Date.now() - t0} ms`));
    ws.on("unexpected-response", (_r, res) => {
      res.resume();
      finish(false, res.statusCode === 401 || res.statusCode === 403 ? `token rechazado (http ${res.statusCode})` : `http ${res.statusCode}`);
    });
    ws.on("error", (e) => finish(false, errMsg(e)));
    ws.on("close", (code) => finish(false, code === 4001 ? "token rechazado (4001)" : `cerrado ${code}`));
    setTimeout(() => finish(false, "timeout"), 10_000).unref?.();
  });
}

export async function runDoctor(pi: ExtensionAPI | null, cfg: RpConfig, env = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  if (!cfg.relayUrl) {
    checks.push({ level: "fail", label: "Relay no configurado", detail: "usa /rp pair <url> <código>" });
  } else {
    let url: URL | null = null;
    try {
      url = new URL(cfg.relayUrl);
    } catch (e) {
      checks.push({ level: "fail", label: "URL del relay inválida", detail: `${cfg.relayUrl} (${errMsg(e)})` });
    }
    if (url) {
      try {
        const r = await dns.lookup(url.hostname);
        checks.push({ level: "ok", label: "DNS", detail: `${url.hostname} → ${r.address}` });
      } catch (e) {
        checks.push({ level: "fail", label: "DNS", detail: errMsg(e) });
      }
      const t0 = Date.now();
      try {
        const r = await httpRequest(toHttpUrl(cfg.relayUrl, "/healthz"), { timeoutMs: 10_000 });
        const ms = Date.now() - t0;
        if (r.status === 200) checks.push({ level: "ok", label: `${url.protocol === "https:" ? "TLS/HTTP" : "HTTP"} /healthz`, detail: `${ms} ms · relay ${r.json?.version ?? "?"}` });
        else checks.push({ level: "fail", label: "HTTP /healthz", detail: `http ${r.status}` });
        const date = r.headers.date ? Date.parse(String(r.headers.date)) : NaN;
        if (!Number.isNaN(date)) {
          const skew = Math.abs(Date.now() - date);
          checks.push({ level: skew > 30_000 ? "warn" : "ok", label: "Reloj", detail: `desfase ${Math.round(skew / 1000)} s respecto al relay` });
        }
      } catch (e) {
        checks.push({ level: "fail", label: "TLS/HTTP", detail: errMsg(e) });
      }
      if (cfg.machineToken) {
        const w = await probeWs(cfg.relayUrl, cfg.machineToken);
        const rejected = w.detail.startsWith("token rechazado");
        checks.push({
          level: w.ok ? "ok" : rejected ? "fail" : "warn",
          label: "WebSocket",
          detail: w.ok ? w.detail : rejected ? `${w.detail} → vuelve a emparejar con /rp pair` : `${w.detail} → se usará long-poll si persiste`,
        });
      } else checks.push({ level: "warn", label: "WebSocket", detail: "PC sin emparejar" });
    }
  }
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  checks.push({
    level: "ok",
    label: "Proxy",
    detail: proxy ? `HTTPS_PROXY detectado${env.NO_PROXY ? `, NO_PROXY=${env.NO_PROXY}` : ""}` : "sin proxy configurado",
  });
  checks.push({ level: "ok", label: "CA corporativa", detail: env.NODE_EXTRA_CA_CERTS ? `NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS}` : "NODE_EXTRA_CA_CERTS no definido" });
  checks.push(...checkDeclared(env));
  if (pi) {
    try {
      const r = await pi.exec("herdr", ["--version"], { timeout: 5000 });
      checks.push({ level: r.code === 0 ? "ok" : "warn", label: "herdr en PATH", detail: r.code === 0 ? r.stdout.trim() : "no disponible (opcional)" });
    } catch {
      checks.push({ level: "warn", label: "herdr en PATH", detail: "no disponible (opcional)" });
    }
    if (hasGentleAskTools(pi)) {
      const v = detectGentleVersion(pi);
      const ok = gentleVersionSupported(v);
      checks.push({
        level: v === null ? "warn" : ok ? "ok" : "warn",
        label: "gentle-pi",
        detail: v === null ? "versión desconocida" : ok ? `${v} (soportada)` : `${v} fuera del rango >=${GENTLE_RANGE.min.join(".")} <${GENTLE_RANGE.maxExclusive[0]}`,
      });
    }
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  return checks.map((c) => `${icon[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
}

async function cmdDoctor(pi: ExtensionAPI, h: CommandHooks, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify("RP doctor: comprobando…", "info");
  const checks = await runDoctor(pi, h.cfg);
  const bad = checks.some((c) => c.level === "fail");
  ctx.ui.notify(formatChecks(checks), bad ? "error" : checks.some((c) => c.level === "warn") ? "warning" : "info");
}

// ---------- on / off / gate / test / unpair ----------

async function cmdOn(h: CommandHooks, ctx: ExtensionCommandContext): Promise<void> {
  updateConfigFile(h.cfgPath, (c) => void (c.enabled = true));
  h.cfg.enabled = true;
  if (!h.cfg.machineToken) {
    ctx.ui.notify("RP habilitado, pero la PC no está emparejada: /rp pair <url> <código>", "warning");
    return;
  }
  await h.stopRuntime();
  h.startRuntime(ctx);
  ctx.ui.notify("RP habilitado.", "info");
}

async function cmdOff(h: CommandHooks, tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
  const { flags } = parseFlags(tokens);
  await h.stopRuntime();
  h.cfg.enabled = false;
  if (flags.persist) updateConfigFile(h.cfgPath, (c) => void (c.enabled = false));
  ctx.ui.notify(flags.persist ? "RP deshabilitado de forma persistente (/rp on para volver)." : "RP deshabilitado en esta sesión.", "info");
}

function cmdGate(h: CommandHooks, tokens: string[], ctx: ExtensionCommandContext): void {
  const mode = tokens[0] as GateMode | undefined;
  if (!mode || !GATE_MODES.includes(mode)) {
    ctx.ui.notify(`Uso: /rp gate <${GATE_MODES.join("|")}> (actual: ${h.cfg.gate.mode})`, "warning");
    return;
  }
  h.cfg.gate.mode = mode;
  updateConfigFile(h.cfgPath, (c) => void (c.gate.mode = mode));
  ctx.ui.notify(`RP gate: ${mode}`, "info");
}

async function cmdTest(h: CommandHooks, ctx: ExtensionCommandContext): Promise<void> {
  const rt = h.getRuntime();
  if (!rt) return void ctx.ui.notify("RP no está activo en esta sesión (¿emparejada? /rp status).", "warning");
  if (!rt.conn.connected) return void ctx.ui.notify("RP no está conectado al relay todavía; reintenta en unos segundos.", "warning");
  const t0 = Date.now();
  ctx.ui.notify("RP test: responde la pregunta en la terminal o desde el móvil.", "info");
  const answer = await promptContext.run({ category: "question", danger: "low", source: { extension: "rp", tool: "test" } }, () =>
    ctx.ui.select("RP test — ¿te llegó al móvil?", ["Sí, llegó", "No llegó"]),
  );
  ctx.ui.notify(answer === undefined ? "RP test cancelado." : `RP test: "${answer}" (${((Date.now() - t0) / 1000).toFixed(1)} s).`, "info");
}

async function cmdUnpair(h: CommandHooks, ctx: ExtensionCommandContext): Promise<void> {
  await h.stopRuntime();
  updateConfigFile(h.cfgPath, (c) => {
    c.machineId = null;
    c.machineToken = null;
    c.machine = {};
  });
  h.cfg.machineId = null;
  h.cfg.machineToken = null;
  h.cfg.machine = {};
  ctx.ui.notify("RP: credenciales locales borradas. Revoca la PC también desde la app si quieres cerrar el acceso en el relay.", "info");
}
