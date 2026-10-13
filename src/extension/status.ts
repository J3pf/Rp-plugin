import type { AgentStatus } from "../shared/protocol.ts";
import { parseGentleMode, type GentleModeName } from "./environment.ts";

/** Derives agent.status and tracks setStatus() texts of every extension (agent.statuses, ≤1/s). */
export class StatusTracker {
  private base: AgentStatus = "idle";
  private detail: string | undefined;
  private waiting = 0;
  private compacting = false;
  private last: { status: AgentStatus; detail?: string } | null = null;
  private items: Record<string, string> = {};
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  gentleMode: GentleModeName | null = null;
  sawGentleStatus = false;

  constructor(
    private emitStatus: (status: AgentStatus, detail?: string) => void,
    private emitStatuses: (items: Record<string, string>) => void,
    private onGentleMode?: (m: GentleModeName) => void,
    private now: () => number = Date.now,
  ) {}

  get current(): AgentStatus {
    if (this.waiting > 0) return "waiting_input";
    if (this.compacting) return "compacting";
    return this.base;
  }

  private push(): void {
    const status = this.current;
    const detail = status === "working" ? this.detail : undefined;
    if (this.last && this.last.status === status && this.last.detail === detail) return;
    this.last = { status, detail };
    this.emitStatus(status, detail);
  }

  working(detail?: string): void {
    this.base = "working";
    this.detail = detail;
    this.push();
  }
  idle(): void {
    this.base = "idle";
    this.detail = undefined;
    this.push();
  }
  error(): void {
    this.base = "error";
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
