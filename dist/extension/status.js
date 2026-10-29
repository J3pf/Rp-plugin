import { parseGentleMode } from "./environment.js";
/** Derives agent.status and tracks setStatus() texts of every extension (agent.statuses, ≤1/s). */
export class StatusTracker {
    emitStatus;
    emitStatuses;
    onGentleMode;
    now;
    base = "idle";
    detail;
    waiting = 0;
    compacting = false;
    last = null;
    items = {};
    dirty = false;
    timer = null;
    lastFlush = 0;
    gentleMode = null;
    sawGentleStatus = false;
    constructor(emitStatus, emitStatuses, onGentleMode, now = Date.now) {
        this.emitStatus = emitStatus;
        this.emitStatuses = emitStatuses;
        this.onGentleMode = onGentleMode;
        this.now = now;
    }
    get current() {
        if (this.waiting > 0)
            return "waiting_input";
        if (this.compacting)
            return "compacting";
        return this.base;
    }
    push() {
        const status = this.current;
        const detail = status === "working" ? this.detail : undefined;
        if (this.last && this.last.status === status && this.last.detail === detail)
            return;
        this.last = { status, detail };
        this.emitStatus(status, detail);
    }
    working(detail) {
        this.base = "working";
        this.detail = detail;
        this.push();
    }
    idle() {
        this.base = "idle";
        this.detail = undefined;
        this.push();
    }
    error() {
        this.base = "error";
        this.push();
    }
    setCompacting(v) {
        this.compacting = v;
        this.push();
    }
    setWaiting(count) {
        this.waiting = Math.max(0, count);
        this.push();
    }
    /** Called by the ctx.ui.setStatus wrapper (mirror). */
    observe(key, text) {
        if (text === undefined) {
            if (!(key in this.items))
                return;
            delete this.items[key];
        }
        else {
            if (this.items[key] === text)
                return;
            this.items[key] = text;
        }
        if (key === "gentle:mode") {
            this.sawGentleStatus = true;
            const m = parseGentleMode(text);
            if (m !== this.gentleMode) {
                this.gentleMode = m;
                this.onGentleMode?.(m);
            }
        }
        this.dirty = true;
        this.schedule();
    }
    snapshot() {
        return { ...this.items };
    }
    schedule() {
        if (this.timer)
            return;
        const wait = Math.max(0, 1000 - (this.now() - this.lastFlush));
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, wait);
        this.timer.unref?.();
    }
    flush() {
        if (!this.dirty)
            return;
        this.dirty = false;
        this.lastFlush = this.now();
        this.emitStatuses({ ...this.items });
    }
    dispose() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
}
