import type { AgentStatus, GentleMode } from "../shared/protocol.ts";
import { parseGentleMode } from "./environment.ts";

const DETAIL_THROTTLE_MS = 500;

/** Derives agent.status and tracks setStatus() texts of every extension (agent.statuses, ≤1/s). */
export class StatusTracker {
  private base: AgentStatus = "idle";
  private detail: string | undefined;
  private waiting = 0;
  private compacting = false;
  private last: { status: AgentStatus; detail?: string } | null = null;
  private detailTimer: NodeJS.Timeout | null = null;
  private lastDetailEmitAt = -Infinity;
  private pendingDetail: string | undefined;
  private hasPendingDetail = false;
  private items: Record<string, string> = {};
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  gentleMode: GentleMode | null = null;
  sawGentleStatus = false;

  constructor(
    private emitStatus: (status: AgentStatus, detail?: string) => void,
    private emitStatuses: (items: Record<string, string>) => void,
    private onGentleMode?: (m: GentleMode) => void,
    private now: () => number = Date.now,
  ) {}

  get current(): AgentStatus {
    if (this.waiting > 0) return "waiting_input";
    if (this.compacting) return "compacting";
    return this.base;
  }

  private clearDetailTimer(): void {
    if (this.detailTimer) {
      clearTimeout(this.detailTimer);
      this.detailTimer = null;
    }
    this.hasPendingDetail = false;
  }

  private push(): void {
    const status = this.current;
    const detail = status === "working" ? this.detail : undefined;
    if (this.last && this.last.status === status && this.last.detail === detail) {
      this.clearDetailTimer();
      return;
    }
    const isDetailOnlyChange = this.last !== null && this.last.status === status && status === "working";
    if (isDetailOnlyChange) {
      const elapsed = this.now() - this.lastDetailEmitAt;
      if (elapsed < DETAIL_THROTTLE_MS) {
        this.pendingDetail = detail;
        this.hasPendingDetail = true;
        if (!this.detailTimer) {
          const wait = Math.max(1, DETAIL_THROTTLE_MS - elapsed);
          this.detailTimer = setTimeout(() => {
            this.detailTimer = null;
            if (!this.hasPendingDetail) return;
            this.hasPendingDetail = false;
            const curStatus = this.current;
            const curDetail = curStatus === "working" ? this.pendingDetail : undefined;
            if (curStatus === "working" && (!this.last || this.last.status !== curStatus || this.last.detail !== curDetail)) {
              this.last = { status: curStatus, detail: curDetail };
              this.lastDetailEmitAt = this.now();
              this.emitStatus(curStatus, curDetail);
            }
          }, wait);
          this.detailTimer.unref?.();
        }
        return;
      }
      this.clearDetailTimer();
      this.last = { status, detail };
      this.lastDetailEmitAt = this.now();
      this.emitStatus(status, detail);
      return;
    }
    this.clearDetailTimer();
    this.last = { status, detail };
    this.emitStatus(status, detail);
  }

  working(detail?: string): void {
    this.compacting = false;
    this.base = "working";
    this.detail = detail;
    this.push();
  }
  idle(): void {
    this.compacting = false;
    this.base = "idle";
    this.detail = undefined;
    this.push();
  }
  setCompacting(v: boolean): void {
    this.compacting = v;
    this.push();
  }
  setWaiting(count: number): void {
    this.waiting = Math.max(0, count);
    this.push();
  }

  /** Called by the ctx.ui.setStatus wrapper (mirror). */
  observe(key: string, text: string | undefined): void {
    if (text === undefined) {
      if (!(key in this.items)) return;
      delete this.items[key];
    } else {
      if (this.items[key] === text) return;
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

  snapshot(): Record<string, string> {
    return { ...this.items };
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, 1000 - (this.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlush = this.now();
    this.emitStatuses({ ...this.items });
  }

  dispose(): void {
    this.clearDetailTimer();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
