import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { truncateBytes } from "../shared/util.ts";
import type { HostConfig } from "./config.ts";
import { HostError, isInside, resolveWithinRoots } from "./validate.ts";

export interface GitDiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
}

export interface GitDiffResult {
  cwd: string;
  branch: string | null;
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitDiscardResult {
  cwd: string;
  path: string;
  ok: boolean;
}

const MAX_DIFF_FILES = 100;
const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_TOTAL_PATCH_BYTES = 512 * 1024;
const DIFF_DEADLINE_MS = 10_000;

function execGit(cwd: string, args: string[], timeout = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", ...args],
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: stdout || "", stderr: stderr || "", code });
      },
    );
  });
}

/** Lightweight branch and tracked/untracked dirty status poll using GIT_OPTIONAL_LOCKS=0. */
export async function readGitHeadAndDirty(cwd: string, untracked = false): Promise<{ branch: string | null; dirty: boolean } | null> {
  const head = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], 2000);
  if (head.code !== 0) return null;
  const branch = head.stdout.trim() || null;
  const st = await execGit(cwd, ["status", "--porcelain", untracked ? "-u" : "-uno"], 2000);
  return { branch, dirty: st.code === 0 && st.stdout.trim().length > 0 };
}

function validateRepoRelativePath(
  cwd: string,
  relPath: string,
): { relPath: string; absPath: string; isSymlink: boolean; isDirectory: boolean } {
  const clean = relPath.replace(/\r$/, "");
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    clean.includes("\0") ||
    clean.startsWith("-") ||
    clean.startsWith(":(") ||
    path.isAbsolute(clean) ||
    path.win32.isAbsolute(clean)
  ) {
    throw new HostError("bad_request", "invalid relative path");
  }
  const absPath = path.resolve(cwd, clean);
  if (absPath === cwd || !isInside(cwd, absPath)) {
    throw new HostError("bad_request", "invalid relative path");
  }

  // Verify closest existing ancestor does not escape cwd via symlink
  let cur = path.dirname(absPath);
  while (cur !== cwd && isInside(cwd, cur)) {
    if (fs.existsSync(cur)) {
      let realCur: string;
      try {
        realCur = fs.realpathSync(cur);
      } catch {
        throw new HostError("bad_request", "invalid relative path");
      }
      if (!isInside(cwd, realCur)) {
        throw new HostError("bad_request", "path escapes repository via symlink");
      }
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  let isSymlink = false;
  let isDirectory = false;
  try {
    const lst = fs.lstatSync(absPath);
    if (lst.isSymbolicLink()) {
      isSymlink = true;
    } else if (lst.isDirectory()) {
      isDirectory = true;
    } else {
      const realTarget = fs.realpathSync(absPath);
      if (!isInside(cwd, realTarget)) {
        throw new HostError("bad_request", "path escapes repository via symlink");
      }
    }
  } catch (e) {
    if (e instanceof HostError) throw e;
    // File may be deleted in working tree; ancestor check above is sufficient
  }

  return { relPath: clean, absPath, isSymlink, isDirectory };
}

interface PorcelainEntry {
  code: string;
  path: string;
}

/** Parse `git status --porcelain -z` output into status code + target relative path records. */
function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const rel = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      // Porcelain -z emits target path first, then NUL + original path
      i++;
    }
    if (rel) entries.push({ code, path: rel });
  }
  return entries;
}

export interface GitDiffOptions {
  redactContent?: boolean;
}

export async function gitDiff(
  cfg: HostConfig,
  requestedCwd: string,
  requestedPath?: string,
  opts: GitDiffOptions = {},
): Promise<GitDiffResult> {
  const cwd = resolveWithinRoots(cfg, requestedCwd);
  const startedAt = Date.now();
  const redact = !!opts.redactContent;

  let validatedFilterPath: string | undefined;
  if (requestedPath !== undefined && requestedPath !== "") {
    validatedFilterPath = validateRepoRelativePath(cwd, requestedPath).relPath;
  }

  const branchRes = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;

  const statusArgs = ["status", "--porcelain", "-z", "-u"];
  if (validatedFilterPath) statusArgs.push("--", validatedFilterPath);
  const statusRes = await execGit(cwd, statusArgs);
  if (statusRes.code !== 0) {
    const msg = statusRes.stderr.trim() || "git status failed";
    if (/not a git repository/i.test(msg)) {
      return { cwd, branch, files: [], totalAdditions: 0, totalDeletions: 0 };
    }
    throw new HostError("internal", msg);
  }

  const entries = parsePorcelainZ(statusRes.stdout);
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalPatchBytes = 0;

  for (const entry of entries) {
    if (files.length >= MAX_DIFF_FILES) break;
    const code = entry.code;

    let validated: { relPath: string; absPath: string; isSymlink: boolean; isDirectory: boolean };
    try {
      validated = validateRepoRelativePath(cwd, entry.path);
    } catch {
      continue;
    }
    const { relPath, isSymlink, isDirectory } = validated;

    let status: GitDiffFile["status"] = "modified";
    if (code.includes("A") || code === "??") status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("R")) status = "renamed";

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = DIFF_DEADLINE_MS - elapsedMs;
    const overBudget = totalPatchBytes >= MAX_TOTAL_PATCH_BYTES || remainingMs <= 0;

    let rawPatch = "";
    if (!redact && !overBudget && !isSymlink && !isDirectory) {
      const timeoutMs = Math.max(500, Math.min(5000, remainingMs));
      if (status === "added" && code === "??") {
        const diffRes = await execGit(
          cwd,
          ["diff", "--no-color", "--no-ext-diff", "-U2", "--no-index", "--", "/dev/null", relPath],
          timeoutMs,
        );
        rawPatch = diffRes.stdout;
      } else {
        const diffRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "HEAD", "--", relPath], timeoutMs);
        rawPatch = diffRes.stdout;
        if (!rawPatch) {
          const diffIndex = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "--", relPath], timeoutMs);
          rawPatch = diffIndex.stdout;
          if (!rawPatch) {
            const diffStaged = await execGit(
              cwd,
              ["diff", "--no-color", "--no-ext-diff", "-U2", "--cached", "--", relPath],
              timeoutMs,
            );
            rawPatch = diffStaged.stdout;
          }
        }
      }
    }

    const binary = !redact && (rawPatch.includes("Binary files ") || rawPatch.includes("GIT binary patch"));
    let adds = 0;
    let dels = 0;
    if (!redact) {
      for (const pLine of rawPatch.split("\n")) {
        if (pLine.startsWith("+") && !pLine.startsWith("+++")) adds++;
        else if (pLine.startsWith("-") && !pLine.startsWith("---")) dels++;
      }
    }

    const remainingBudget = Math.max(0, MAX_TOTAL_PATCH_BYTES - totalPatchBytes);
    const maxFileBytes = Math.min(MAX_FILE_PATCH_BYTES, remainingBudget);
    let patch = redact ? "" : rawPatch;
    let truncated = redact || overBudget;
    if (!redact && maxFileBytes === 0 && rawPatch.length > 0) {
      patch = "";
      truncated = true;
    } else if (!redact && Buffer.byteLength(rawPatch, "utf8") > maxFileBytes) {
      const t = truncateBytes(rawPatch, maxFileBytes);
      patch = t.text + "\n... [diff truncado a 64KB]";
      truncated = true;
    }
    totalPatchBytes += Buffer.byteLength(patch, "utf8");

    files.push({
      path: relPath,
      status,
      additions: adds,
      deletions: dels,
      binary,
      patch,
      truncated,
    });
    totalAdditions += adds;
    totalDeletions += dels;
  }

  return {
    cwd,
    branch,
    files,
    totalAdditions,
    totalDeletions,
  };
}

export async function gitDiscard(cfg: HostConfig, requestedCwd: string, rawRelPath: string): Promise<GitDiscardResult> {
  const cwd = resolveWithinRoots(cfg, requestedCwd);
  const { relPath, absPath, isSymlink, isDirectory } = validateRepoRelativePath(cwd, rawRelPath);
  if (isDirectory || isSymlink) {
    throw new HostError("bad_request", "path must be a file, not a directory or symlink");
  }

  const statusRes = await execGit(cwd, ["status", "--porcelain", "-z", "-u", "--", relPath]);
  if (statusRes.code !== 0) {
    throw new HostError("internal", statusRes.stderr.trim() || "git status failed");
  }
  const matched = parsePorcelainZ(statusRes.stdout).find((e) => e.path === relPath);
  const code = matched?.code ?? "";
  const isUntracked = code === "??";

  if (isUntracked) {
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(absPath);
    } catch {
      return { cwd, ok: true, path: relPath };
    }
    if (lst.isDirectory() || lst.isSymbolicLink()) {
      throw new HostError("bad_request", "path must be a file, not a directory or symlink");
    }
    fs.unlinkSync(absPath);
  } else {
    const checkoutRes = await execGit(cwd, ["checkout", "HEAD", "--", relPath]);
    if (checkoutRes.code !== 0) {
      // Fallback for unborn HEAD or staged newly-added files
      if (code.includes("A")) {
        const rmRes = await execGit(cwd, ["rm", "-f", "--", relPath]);
        if (rmRes.code !== 0) throw new HostError("internal", "failed to discard added file");
      } else {
        const fallbackRes = await execGit(cwd, ["checkout", "--", relPath]);
        if (fallbackRes.code !== 0) throw new HostError("internal", "failed to checkout file from HEAD");
      }
    }
  }

  return { cwd, ok: true, path: relPath };
}
