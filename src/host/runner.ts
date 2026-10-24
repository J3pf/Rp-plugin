import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
/** Runs a program without a shell. Never rejects: spawn errors come back as code -1. */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let settled = false;
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (err) {
          const code = typeof (err as any).code === "number" ? (err as any).code : -1;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || (err as Error).message) });
        } else {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code: -1, stdout: "", stderr: "command timed out (SIGKILL)" });
    }, timeoutMs + 2_000);
    killTimer.unref?.();
  });
