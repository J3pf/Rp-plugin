import { execFile } from "node:child_process";
import path from "node:path";
import type { HostConfig } from "./config.ts";
import { HostError, resolveWithinRoots } from "./validate.ts";

export interface GitDiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitDiffResult {
  branch: string | null;
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

function execGit(cwd: string, args: string[], timeout = 5000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
      resolve({ stdout: stdout || "", code });
    });
  });
}

export async function gitDiff(cfg: HostConfig, requestedCwd: string, requestedPath?: string): Promise<GitDiffResult> {
  const cwd = resolveWithinRoots(cfg, requestedCwd);

  const branchRes = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;

  const statusArgs = ["status", "--porcelain", "-u"];
  if (requestedPath) statusArgs.push("--", requestedPath);
  const statusRes = await execGit(cwd, statusArgs);
  if (statusRes.code !== 0 && !statusRes.stdout) {
    return { branch, files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const lines = statusRes.stdout.split("\n").filter((l) => l.trim().length > 0);
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of lines) {
    const code = line.substring(0, 2);
    let relPath = line.substring(3).trim();
    if (relPath.includes(" -> ")) {
      relPath = relPath.split(" -> ")[1].trim();
    }
    if (relPath.startsWith('"') && relPath.endsWith('"')) {
      relPath = relPath.slice(1, -1);
    }

    let status: "modified" | "added" | "deleted" | "renamed" = "modified";
    if (code.includes("A") || code === "??") status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("R")) status = "renamed";

    let patch = "";
    if (status === "added" && code === "??") {
      const diffRes = await execGit(cwd, ["diff", "--no-color", "-U2", "--no-index", "/dev/null", relPath]);
      patch = diffRes.stdout;
    } else {
      const diffRes = await execGit(cwd, ["diff", "--no-color", "-U2", "HEAD", "--", relPath]);
      patch = diffRes.stdout;
      if (!patch) {
        const diffIndex = await execGit(cwd, ["diff", "--no-color", "-U2", "--", relPath]);
        patch = diffIndex.stdout;
      }
    }

    let adds = 0;
    let dels = 0;
    for (const pLine of patch.split("\n")) {
      if (pLine.startsWith("+") && !pLine.startsWith("+++")) adds++;
      else if (pLine.startsWith("-") && !pLine.startsWith("---")) dels++;
    }

    if (patch.length > 64 * 1024) {
      patch = patch.slice(0, 64 * 1024) + "\n... [diff truncado a 64KB]";
    }

    files.push({
      path: relPath,
      status,
      additions: adds,
      deletions: dels,
      patch,
    });
    totalAdditions += adds;
    totalDeletions += dels;
  }

  return {
    branch,
    files,
    totalAdditions,
    totalDeletions,
  };
}

export async function gitDiscard(cfg: HostConfig, requestedCwd: string, relPath: string): Promise<{ ok: boolean; path: string }> {
  const cwd = resolveWithinRoots(cfg, requestedCwd);
  if (!relPath || relPath.includes("\0") || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new HostError("bad_request", "invalid relative path");
  }

  const statusRes = await execGit(cwd, ["status", "--porcelain", "-u", "--", relPath]);
  const isUntracked = statusRes.stdout.trim().startsWith("??");

  if (isUntracked) {
    const cleanRes = await execGit(cwd, ["clean", "-f", "--", relPath]);
    if (cleanRes.code !== 0) throw new HostError("internal", "failed to clean untracked file");
  } else {
    const checkoutRes = await execGit(cwd, ["checkout", "HEAD", "--", relPath]);
    if (checkoutRes.code !== 0) throw new HostError("internal", "failed to checkout file from HEAD");
  }

  return { ok: true, path: relPath };
}
