import { execFile } from "node:child_process";
export const run = (cmd, args, opts = {}) => new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let settled = false;
    const child = execFile(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(killTimer);
        if (err) {
            const code = typeof err.code === "number" ? err.code : -1;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || err.message) });
        }
        else {
            resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        }
    });
    const killTimer = setTimeout(() => {
        if (settled)
            return;
        settled = true;
        try {
            child.kill("SIGKILL");
        }
        catch {
            /* ignore */
        }
        resolve({ code: -1, stdout: "", stderr: "command timed out (SIGKILL)" });
    }, timeoutMs + 2_000);
    killTimer.unref?.();
});
