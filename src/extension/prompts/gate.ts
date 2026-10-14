// Own authorizations (PLAN §8.4). Disabled when gentle-pi already asks for confirmations.
import { promptContext } from "./classify.ts";
import type { RpConfig, GateMode } from "../config.ts";
import type { Danger } from "../../shared/protocol.ts";
import { truncateBytes } from "../../shared/util.ts";

export type EffectiveGateMode = Exclude<GateMode, "auto-detect">;

export const ALLOW = "Permitir";
export const ALLOW_SESSION = "Permitir siempre en esta sesión";
export const DENY = "Denegar";
export const DENY_REASON = "Denegar con motivo…";

export function effectiveMode(cfgMode: GateMode, gentlePresent: boolean): EffectiveGateMode {
  if (cfgMode !== "auto-detect") return cfgMode;
  return gentlePresent ? "off" : "dangerous";
}

export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* ignore invalid pattern */
    }
  }
  return out;
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export interface GateToolInfo {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface GateDecision {
  ask: boolean;
  danger: Danger;
  summary: string;
  key: string;
}

export function summarize(toolName: string, input: any): string {
  if (SHELL_TOOLS.has(toolName) && typeof input?.command === "string") return input.command;
  if (typeof input?.path === "string") return input.path;
  if (typeof input?.file_path === "string") return input.file_path;
  let s: string;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    s = String(input);
  }
  return truncateBytes(s, 300).text;
}

/** Session allow key: tool name, or "bash:<first token>" for shells so one approved `ls` never allows `rm`.
 * When a command contains chaining, redirection, or substitution operators (;, &&, ||, |, <, >, `, $, \n), the whole command is keyed.
 */
export function allowKey(toolName: string, input: any): string {
  if (SHELL_TOOLS.has(toolName) && typeof input?.command === "string") {
    const cmd = input.command.trim();
    if (/([;&|<>`$]|\n)/.test(cmd)) {
      return `${toolName}:${cmd}`;
    }
    const first = cmd.split(/\s+/)[0] ?? "";
    return `${toolName}:${first}`;
  }
  return toolName;
}

export function decide(
  mode: EffectiveGateMode,
  cfg: RpConfig["gate"],
  patterns: RegExp[],
  toolName: string,
  input: any,
  info?: GateToolInfo,
): GateDecision {
  const key = allowKey(toolName, input);
  const no = (): GateDecision => ({ ask: false, danger: "low", summary: "", key });
  if (mode === "off") return no();
  if (cfg.alwaysAllowTools.includes(toolName)) return no();
  const dangerousCmd = SHELL_TOOLS.has(toolName) && typeof input?.command === "string" && patterns.some((r) => r.test(input.command));
  const annotatedDestructive = cfg.useAnnotations && info?.annotations?.destructiveHint === true && info?.annotations?.readOnlyHint !== true;
  const highDangerKey = SHELL_TOOLS.has(toolName) && typeof input?.command === "string" ? `${toolName}:${input.command.trim()}` : key;
  if (dangerousCmd) return { ask: true, danger: "high", summary: summarize(toolName, input), key: highDangerKey };
  if (annotatedDestructive) return { ask: true, danger: "high", summary: summarize(toolName, input), key: highDangerKey };
  if (mode === "dangerous") return no();
  const readOnly = cfg.useAnnotations && info?.annotations?.readOnlyHint === true;
  if (mode === "writes") {
    if (SHELL_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) return { ask: true, danger: "medium", summary: summarize(toolName, input), key };
    if (cfg.useAnnotations && info?.annotations?.readOnlyHint === false) return { ask: true, danger: "medium", summary: summarize(toolName, input), key };
    return no();
  }
  // mode === "all"
  const summary = summarize(toolName, input);
  if (readOnly) return { ask: true, danger: "low", summary, key };
  return { ask: true, danger: SHELL_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) ? "medium" : "low", summary, key };
}

export interface GateDeps {
  mode(): EffectiveGateMode;
  cfg(): RpConfig["gate"];
  /** True when someone (terminal UI or connected phone) can answer. */
  hasApprover(): boolean | Promise<boolean>;
  askSelect(title: string, options: string[]): Promise<string | undefined>;
  askInput(title: string, placeholder?: string): Promise<string | undefined>;
  toolInfo(name: string): GateToolInfo | undefined;
  persistAllow(key: string): void;
  allowed: Set<string>;
}

export class Gate {
  private patterns: RegExp[] | null = null;
  private patternList: readonly string[] | null = null;

  constructor(private d: GateDeps) {}

  private getPatterns(): RegExp[] {
    const list = this.d.cfg().dangerousPatterns;
    if (
      !this.patterns ||
      !this.patternList ||
      list.length !== this.patternList.length ||
      (list !== this.patternList && list.some((p, i) => p !== this.patternList![i]))
    ) {
      this.patterns = compilePatterns(list);
      this.patternList = list.slice();
    }
    return this.patterns;
  }

  async onToolCall(ev: { toolName: string; input: any }): Promise<{ block: true; reason: string } | undefined> {
    const mode = this.d.mode();
    if (mode === "off") return undefined;
    const dec = decide(mode, this.d.cfg(), this.getPatterns(), ev.toolName, ev.input, this.d.toolInfo(ev.toolName));
    if (!dec.ask) return undefined;
    if (this.d.allowed.has(dec.key)) return undefined;
    if (!(await this.d.hasApprover())) return { block: true, reason: "RP: no hay nadie que pueda autorizar (sin UI local ni relay); bloqueado por seguridad" };

    const title = `⚠ ${ev.toolName}: ${dec.summary.length > 120 ? dec.summary.slice(0, 119) + "…" : dec.summary}`;
    const choice = await promptContext.run(
      { category: "permission", danger: dec.danger, tool: { name: ev.toolName, args: ev.input }, message: dec.summary, source: { extension: "rp", tool: "gate" } },
      () => this.d.askSelect(title, [ALLOW, ALLOW_SESSION, DENY, DENY_REASON]),
    );
    if (choice === ALLOW) return undefined;
    if (choice === ALLOW_SESSION) {
      this.d.allowed.add(dec.key);
      this.d.persistAllow(dec.key);
      return undefined;
    }
    if (choice === DENY_REASON) {
      const reason = await promptContext.run(
        { category: "question", danger: "low", source: { extension: "rp", tool: "gate" } },
        () => this.d.askInput("Motivo de la denegación", "Explica por qué se deniega"),
      );
      return { block: true, reason: reason?.trim() ? `Denegado por el usuario: ${reason.trim()}` : "Denegado por el usuario" };
    }
    return { block: true, reason: "Denegado por el usuario" };
  }
}

/** Rebuild "allow always" keys from the session branch (custom entries written with pi.appendEntry). */
export function allowedFromBranch(branch: any[]): Set<string> {
  const out = new Set<string>();
  for (const e of branch) {
    if (e?.type === "custom" && e.customType === "rp.allow" && typeof e.data?.key === "string") out.add(e.data.key);
  }
  return out;
}
