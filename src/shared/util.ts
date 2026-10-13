import { createHash } from "node:crypto";

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Truncate a string to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= max) return { text: s, truncated: false };
  let buf = Buffer.from(s, "utf8").subarray(0, max);
  // drop a possibly split trailing code point
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && buf[end - 1]! >= 0xc0) end--;
  buf = buf.subarray(0, end);
  return { text: buf.toString("utf8"), truncated: true };
}

/** Saneado de nombres de archivo para el inbox: sin separadores ni caracteres de control, longitud acotada. */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  let out = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "_").trim();
  if (!out) out = "file";
  if (out.length > 120) {
    const dot = out.lastIndexOf(".");
    const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : "";
    out = out.slice(0, 120 - ext.length) + ext;
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = "_" + out;
  return out;
}

export function timestampName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function jitter(ms: number, ratio = 0.2, rnd: () => number = Math.random): number {
  return Math.round(ms * (1 + (rnd() * 2 - 1) * ratio));
}

export function backoffDelay(attempt: number, rnd: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return jitter(base, 0.2, rnd);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function preview(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Bounded set remembering the last N keys (insertion order). */
export class LruSet {
  private set = new Set<string>();
  constructor(private max: number) {}
  has(k: string): boolean {
    return this.set.has(k);
  }
  add(k: string): void {
    this.set.delete(k);
    this.set.add(k);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value as string);
  }
  get size(): number {
    return this.set.size;
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
