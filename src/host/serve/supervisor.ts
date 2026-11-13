import { type ChildProcess, spawn } from "node:child_process";

export interface RestartPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Consecutive restart attempts before the supervisor gives up and reports a fatal. */
  maxAttempts: number;
  /** A child that stayed alive this long resets the attempt counter. */
  resetAfterMs: number;
}

export interface ChildSupervisorSpec {
  /** Short label used both in log lines and in the fatal reason. */
  name: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onLog: (line: string) => void;
  onFatal?: (reason: string) => void;
  restart?: Partial<RestartPolicy>;
  /** Grace period before escalating SIGTERM to SIGKILL. */
  stopTimeoutMs?: number;
}

const DEFAULT_RESTART: RestartPolicy = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  resetAfterMs: 30_000,
};

interface Waiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Supervises one long-lived child process: line-oriented logging, restart with exponential backoff,
 * a hard attempt limit, and deterministic shutdown. Used for the embedded relay and the tunnel.
 */
export class ChildSupervisor {
  private readonly restart: RestartPolicy;
  private readonly stopTimeoutMs: number;
  private child: ChildProcess | null = null;
  private stopped = false;
  private exited = false;
  private attempts = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private exitWaiters: Array<() => void> = [];
  private lineWaiters: Waiter[] = [];
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(private readonly spec: ChildSupervisorSpec) {
    this.restart = { ...DEFAULT_RESTART, ...spec.restart };
    this.stopTimeoutMs = spec.stopTimeoutMs ?? 5_000;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Spawns the child. Resolves once the process has been handed to the OS (not once it is ready). */
  async start(): Promise<void> {
    if (this.stopped) throw new Error(`${this.spec.name}: cannot start after stop`);
    if (this.child) return;
    this.spawnOnce();
    return Promise.resolve();
  }

  isRunning(): boolean {
    return this.child !== null && !this.exited && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Resolves when the supervisor has permanently given up (or stop was called). */
  waitForExit(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.spec.name}: still running after ${timeoutMs}ms`)), timeoutMs);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Resolves with the first output line (stdout or stderr) accepted by `match`. */
  waitForLine(match: (line: string) => boolean, timeoutMs = 30_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (line) => {
          clearTimeout(waiter.timer);
          this.lineWaiters = this.lineWaiters.filter((w) => w !== waiter);
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          this.lineWaiters = this.lineWaiters.filter((w) => w !== waiter);
          reject(err);
        },
        timer: setTimeout(() => waiter.reject(new Error(`${this.spec.name}: no matching output within ${timeoutMs}ms`)), timeoutMs),
      };
      this.lineWaiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectLineWaiters(new Error(`${this.spec.name}: stopped`));
    const child = this.child;
    if (!child || this.exited || child.exitCode !== null) {
      this.resolveExitOnce();
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        done();
      }, this.stopTimeoutMs);
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
    this.resolveExitOnce();
  }

  private spawnOnce(): void {
    this.exited = false;
    this.startedAt = Date.now();
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd,
      env: this.spec.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.pipe(child.stdout);
    this.pipe(child.stderr);

    child.once("error", (err) => {
      // ENOENT and friends are permanent: retrying cannot fix a missing binary.
      this.reportFatal(`could not be started (${this.spec.command}): ${err.message}`);
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      const ranFor = Date.now() - this.startedAt;
      this.spec.onLog(`${this.spec.name}: exited (${signal ?? `code ${code}`})`);
      if (!this.stopped) this.scheduleRestart(code, signal, ranFor);
      this.flushExitWaiters();
    });
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null, ranFor: number): void {
    if (!this.restart.enabled) {
      this.rejectLineWaiters(new Error(`${this.spec.name}: exited (${signal ?? `code ${code}`})`));
      this.resolveExitOnce();
      return;
    }
    if (ranFor >= this.restart.resetAfterMs) this.attempts = 0;
    this.attempts += 1;
    if (this.attempts > this.restart.maxAttempts) {
      const total = this.attempts;
      this.reportFatal(
        `exited with ${signal ? `signal ${signal}` : `code ${code}`} and did not recover after ${total} attempts`,
      );
      return;
    }
    const delay = Math.min(this.restart.initialDelayMs * 2 ** (this.attempts - 1), this.restart.maxDelayMs);
    this.spec.onLog(`${this.spec.name}: restarting in ${delay}ms (attempt ${this.attempts}/${this.restart.maxAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnOnce();
    }, delay);
  }

  private pipe(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.search(/\r?\n/);
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
        this.emitLine(raw);
        index = buffer.search(/\r?\n/);
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) this.emitLine(buffer);
      buffer = "";
    });
  }

  private emitLine(raw: string): void {
    const line = raw.replace(/\s+$/, "");
    if (!line) return;
    this.spec.onLog(`${this.spec.name}: ${line}`);
    for (const waiter of [...this.lineWaiters]) if (waiter.match(line)) waiter.resolve(line);
  }

  private reportFatal(reason: string): void {
    const text = `${this.spec.name}: ${reason}`;
    this.spec.onLog(text);
    this.rejectLineWaiters(new Error(text));
    this.resolveExitOnce();
    this.spec.onFatal?.(text);
  }

  private rejectLineWaiters(err: Error): void {
    for (const waiter of [...this.lineWaiters]) waiter.reject(err);
    this.lineWaiters = [];
  }

  private flushExitWaiters(): void {
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  private resolveExitOnce(): void {
    this.exitWaiters = [];
    this.resolveExit();
  }
}
