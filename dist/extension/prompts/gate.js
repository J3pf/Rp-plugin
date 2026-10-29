// Own authorizations (PLAN §8.4). Disabled when gentle-pi already asks for confirmations.
import path from "node:path";
import { promptContext } from "./classify.js";
import { LruSet, truncateBytes } from "../../shared/util.js";
export const ALLOW = "Permitir";
export const ALLOW_SESSION = "Permitir siempre en esta sesión";
export const DENY = "Denegar";
export const DENY_REASON = "Denegar con motivo…";
export function effectiveMode(cfgMode, gentlePresent) {
    if (cfgMode !== "auto-detect")
        return cfgMode;
    return gentlePresent ? "off" : "dangerous";
}
export function compilePatterns(patterns) {
    const out = [];
    for (const p of patterns) {
        try {
            out.push(new RegExp(p, "is"));
        }
        catch {
            /* ignore invalid pattern */
        }
    }
    return out;
}
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const INTERPRETER_CMDS = new Set([
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    "python",
    "python3",
    "node",
    "perl",
    "ruby",
    "php",
    "osascript",
    "powershell",
    "pwsh",
    "cmd",
    "sudo",
    "env",
    "xargs",
    "find",
]);
export function summarize(toolName, input) {
    if (SHELL_TOOLS.has(toolName) && typeof input?.command === "string")
        return input.command;
    if (typeof input?.path === "string")
        return input.path;
    if (typeof input?.file_path === "string")
        return input.file_path;
    let s;
    try {
        s = JSON.stringify(input ?? {});
    }
    catch {
        s = String(input);
    }
    return truncateBytes(s, 300).text;
}
/** Session allow key: tool name, or "bash:<first token>" for shells so one approved `ls` never allows `rm`.
 * When a command contains chaining, redirection, or substitution operators (;, &&, ||, |, <, >, `, $, \n), the whole command is keyed.
 */
export function allowKey(toolName, input) {
    if (SHELL_TOOLS.has(toolName) && typeof input?.command === "string") {
        const cmd = input.command.trim();
        if (/([;&|<>`$]|\n)/.test(cmd)) {
            return `${toolName}:${cmd}`;
        }
        const first = cmd.split(/\s+/)[0] ?? "";
        const base = path.posix.basename(first.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
        if (INTERPRETER_CMDS.has(base) && /\s/.test(cmd)) {
            return `${toolName}:${cmd}`;
        }
        return `${toolName}:${first}`;
    }
    return toolName;
}
export function decide(mode, cfg, patterns, toolName, input, info) {
    const key = allowKey(toolName, input);
    const no = () => ({ ask: false, danger: "low", summary: "", key });
    if (mode === "off")
        return no();
    if (cfg.alwaysAllowTools.includes(toolName))
        return no();
    const dangerousCmd = SHELL_TOOLS.has(toolName) && typeof input?.command === "string" && patterns.some((r) => r.test(input.command));
    const annotatedDestructive = cfg.useAnnotations && info?.annotations?.destructiveHint === true && info?.annotations?.readOnlyHint !== true;
    const highDangerKey = SHELL_TOOLS.has(toolName) && typeof input?.command === "string" ? `${toolName}:${input.command.trim()}` : key;
    if (dangerousCmd)
        return { ask: true, danger: "high", summary: summarize(toolName, input), key: highDangerKey };
    if (annotatedDestructive)
        return { ask: true, danger: "high", summary: summarize(toolName, input), key: highDangerKey };
    if (mode === "dangerous")
        return no();
    const readOnly = cfg.useAnnotations && info?.annotations?.readOnlyHint === true;
    if (mode === "writes") {
        if (SHELL_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName))
            return { ask: true, danger: "medium", summary: summarize(toolName, input), key };
        if (cfg.useAnnotations && info?.annotations?.readOnlyHint === false)
            return { ask: true, danger: "medium", summary: summarize(toolName, input), key };
        return no();
    }
    // mode === "all"
    const summary = summarize(toolName, input);
    if (readOnly)
        return { ask: true, danger: "low", summary, key };
    return { ask: true, danger: SHELL_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) ? "medium" : "low", summary, key };
}
export class Gate {
    d;
    patterns = null;
    patternList = null;
    constructor(d) {
        this.d = d;
    }
    getPatterns() {
        const list = this.d.cfg().dangerousPatterns;
        if (!this.patterns ||
            !this.patternList ||
            list.length !== this.patternList.length ||
            (list !== this.patternList && list.some((p, i) => p !== this.patternList[i]))) {
            this.patterns = compilePatterns(list);
            this.patternList = list.slice();
        }
        return this.patterns;
    }
    async onToolCall(ev) {
        const mode = this.d.mode();
        if (mode === "off")
            return undefined;
        const dec = decide(mode, this.d.cfg(), this.getPatterns(), ev.toolName, ev.input, this.d.toolInfo(ev.toolName));
        if (!dec.ask)
            return undefined;
        if (this.d.allowed.has(dec.key))
            return undefined;
        if (!(await this.d.hasApprover()))
            return { block: true, reason: "RP: no hay nadie que pueda autorizar (sin UI local ni relay); bloqueado por seguridad" };
        const title = `⚠ ${ev.toolName}: ${dec.summary.length > 120 ? dec.summary.slice(0, 119) + "…" : dec.summary}`;
        const choice = await promptContext.run({ category: "permission", danger: dec.danger, tool: { name: ev.toolName, args: ev.input }, message: dec.summary, source: { extension: "rp", tool: "gate" } }, () => this.d.askSelect(title, [ALLOW, ALLOW_SESSION, DENY, DENY_REASON]));
        if (choice === ALLOW)
            return undefined;
        if (choice === ALLOW_SESSION) {
            this.d.allowed.add(dec.key);
            this.d.persistAllow(dec.key);
            return undefined;
        }
        if (choice === DENY_REASON) {
            const reason = await promptContext.run({ category: "question", danger: "low", source: { extension: "rp", tool: "gate" } }, () => this.d.askInput("Motivo de la denegación", "Explica por qué se deniega"));
            return { block: true, reason: reason?.trim() ? `Denegado por el usuario: ${reason.trim()}` : "Denegado por el usuario" };
        }
        return { block: true, reason: "Denegado por el usuario" };
    }
}
/** Rebuild "allow always" keys from the session branch (custom entries written with pi.appendEntry). */
export function allowedFromBranch(branch) {
    const out = new LruSet(1000);
    if (!Array.isArray(branch))
        return out;
    for (const e of branch) {
        try {
            if (e?.type === "custom" && e.customType === "rp.allow" && typeof e.data?.key === "string")
                out.add(e.data.key);
        }
        catch {
            /* ignore malformed entry */
        }
    }
    return out;
}
