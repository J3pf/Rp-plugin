// Every access to non-public Pi internals or to the shape of gentle-pi goes through this module (risk R1/R5/R6).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GENTLE_ASK_TOOLS } from "./environment.ts";

/** Tested range of gentle-pi (PLAN §8.5). */
export const GENTLE_RANGE = { min: [4, 0, 0], maxExclusive: [5, 0, 0] } as const;

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function gentleVersionSupported(version: string | null): boolean {
  if (!version) return false;
  const v = parseVersion(version);
  if (!v) return false;
  return cmp(v, GENTLE_RANGE.min) >= 0 && cmp(v, GENTLE_RANGE.maxExclusive) < 0;
}

const warned = new Set<string>();
export function warnOnce(ctx: ExtensionContext | undefined, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    ctx?.ui?.notify?.(message, "warning");
  } catch {
    /* ignore */
  }
}
export function resetWarnings(): void {
  warned.clear();
}

export function toolNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getAllTools().map((t) => t.name);
  } catch {
    return [];
  }
}

export function hasGentleAskTools(pi: ExtensionAPI): boolean {
  const names = toolNames(pi);
  return GENTLE_ASK_TOOLS.some((n) => names.includes(n));
}

/** Walk upwards from a path to find the owning package.json (used to read the gentle-pi version). */
export function findPackageJson(startPath: string, name?: string): { dir: string; json: any } | null {
  let dir = startPath;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 8; i++) {
    const f = path.join(dir, "package.json");
    try {
      const json = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!name || json.name === name) return { dir, json };
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** gentle-pi version, read from the package that registers `ask_user_*` (ToolInfo.sourceInfo). */
export function detectGentleVersion(pi: ExtensionAPI): string | null {
  try {
    const tool = pi.getAllTools().find((t) => (GENTLE_ASK_TOOLS as readonly string[]).includes(t.name));
    const si: any = tool?.sourceInfo;
    const start = si?.baseDir || si?.path;
    if (!start || !path.isAbsolute(start)) return null;
    // the npm package is "gentle-pi" (same code as the gentle-shell repo); never trust an unrelated package.json
    const pkg = findPackageJson(start, "gentle-pi");
    return typeof pkg?.json?.version === "string" ? pkg.json.version : null;
  } catch {
    return null;
  }
}

export function detectPiVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const main = req.resolve("@earendil-works/pi-coding-agent");
    const pkg = findPackageJson(main, "@earendil-works/pi-coding-agent");
    if (typeof pkg?.json?.version === "string") return pkg.json.version;
  } catch {
    /* fall through */
  }
  return process.env.PI_VERSION || "unknown";
}

/** The UI object is shared by all extensions (runner.ts:572-591); patching it in place is not public API (R1). */
export function getSharedUi(ctx: ExtensionContext): any {
  return ctx.ui as any;
}

/** Verify the wrapper really took effect on the shared object. */
export function mirrorTookEffect(ctx: ExtensionContext, wrapper: unknown): boolean {
  return (ctx.ui as any)?.select === wrapper;
}

/** Process stdin used by the TUI of the same process (pi-tui/src/terminal.ts). */
export function terminalStdin(): NodeJS.ReadStream | null {
  return process.stdin && typeof process.stdin.emit === "function" ? process.stdin : null;
}

export function readEditorText(ctx: ExtensionContext): string {
  try {
    return ctx.ui.getEditorText();
  } catch {
    return "";
  }
}

export function writeEditorText(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.setEditorText(text);
  } catch {
    /* ignore */
  }
}
