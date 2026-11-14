import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** Safe conversation/session identifier pattern preventing path traversal. */
export const SAFE_CONV_ID_RE = /^[0-9a-zA-Z_][0-9a-zA-Z_-]{0,127}$/;
/** Strip ANSI CSI/OSC escape sequences and stray ESC bytes from terminal text. */
export function stripAnsi(s) {
    return s
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b/g, "");
}
/** Write a file atomically via same-directory temp file + chmod + rename. */
export function atomicWriteFileSync(filePath, content, mode = 0o600) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, content, { mode });
    try {
        fs.chmodSync(tmp, mode);
    }
    catch {
        /* ignore on platforms without POSIX modes */
    }
    fs.renameSync(tmp, filePath);
}
export function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
/** Truncate a string to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateBytes(s, max) {
    if (s.length <= Math.floor(max / 4))
        return { text: s, truncated: false };
    if (s.length <= max && Buffer.byteLength(s, "utf8") <= max)
        return { text: s, truncated: false };
    const head = s.length > max + 1 ? s.slice(0, max + 1) : s;
    let buf = Buffer.from(head, "utf8").subarray(0, max);
    // drop a possibly split trailing code point
    let end = buf.length;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80)
        end--;
    if (end > 0 && buf[end - 1] >= 0xc0)
        end--;
    buf = buf.subarray(0, end);
    return { text: buf.toString("utf8"), truncated: true };
}
/** Saneado de nombres de archivo para el inbox: sin separadores ni caracteres de control, longitud acotada. */
export function sanitizeFileName(name) {
    const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
    let out = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "_").trim();
    if (!out)
        out = "file";
    if (out.length > 120) {
        const dot = out.lastIndexOf(".");
        const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : "";
        out = out.slice(0, 120 - ext.length) + ext;
    }
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out))
        out = "_" + out;
    return out;
}
export function timestampName(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
export function jitter(ms, ratio = 0.2, rnd = Math.random) {
    return Math.round(ms * (1 + (rnd() * 2 - 1) * ratio));
}
export function backoffDelay(attempt, rnd = Math.random) {
    const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
    return jitter(base, 0.2, rnd);
}
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}
export function preview(s, max = 140) {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
/** Bounded LRU set remembering the last N keys (refreshes recency on both `has` and `add`). */
export class LruSet {
    max;
    set = new Set();
    constructor(max = 500) {
        this.max = max;
    }
    has(k) {
        if (!this.set.has(k))
            return false;
        this.set.delete(k);
        this.set.add(k);
        return true;
    }
    add(k) {
        this.set.delete(k);
        this.set.add(k);
        if (this.set.size > this.max) {
            const oldest = this.set.values().next();
            if (!oldest.done)
                this.set.delete(oldest.value);
        }
        return this;
    }
    clear() {
        this.set.clear();
    }
    keys() {
        return this.set.keys();
    }
    [Symbol.iterator]() {
        return this.set.values();
    }
    get size() {
        return this.set.size;
    }
}
/** Bounded LRU map remembering the last N entries (refreshes recency on `get`, `has`, and `set`). */
export class LruMap extends Map {
    capacity;
    constructor(maxCapacity = 500) {
        super();
        this.capacity = Number.isFinite(maxCapacity) ? Math.max(0, Math.floor(maxCapacity)) : 500;
    }
    get(key) {
        if (!super.has(key))
            return undefined;
        const value = super.get(key);
        super.delete(key);
        super.set(key, value);
        return value;
    }
    has(key) {
        if (!super.has(key))
            return false;
        const value = super.get(key);
        super.delete(key);
        super.set(key, value);
        return true;
    }
    set(key, value) {
        super.delete(key);
        super.set(key, value);
        if (this.size > this.capacity) {
            const oldest = this.keys().next();
            if (!oldest.done)
                super.delete(oldest.value);
        }
        return this;
    }
}
export function splitCommand(command) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(command)))
        out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}
export function safeUser() {
    try {
        return os.userInfo().username;
    }
    catch {
        return process.env.USER ?? process.env.USERNAME ?? "unknown";
    }
}
export function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
export const MIN_PLAUSIBLE_EPOCH_MS = 1577836800000; // 2020-01-01T00:00:00.000Z
export const MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000; // 5 minutes
/** Validate that a candidate timestamp is a plausible epoch millisecond timestamp; otherwise fallback to now. Always rounds to integer. */
export function toEpochMs(candidate, fallbackNow = Date.now()) {
    const now = Math.round(fallbackNow);
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
        const rounded = Math.round(candidate);
        if (rounded >= MIN_PLAUSIBLE_EPOCH_MS && rounded <= now + MAX_FUTURE_DRIFT_MS) {
            return rounded;
        }
    }
    return now;
}
/** Compute a safe, non-negative integer duration in milliseconds. */
export function safeDurationMs(startedAt, endedAt, sourceDuration) {
    if (typeof sourceDuration === "number" && Number.isFinite(sourceDuration) && sourceDuration >= 0) {
        return Math.round(sourceDuration);
    }
    if (startedAt !== undefined && endedAt !== undefined) {
        return Math.max(0, Math.round(endedAt - startedAt));
    }
    return undefined;
}
