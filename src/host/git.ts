import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_FRAME_BYTES, type GitDiffFile, type GitDiffResult, type GitDiscardResult } from "../shared/protocol.ts";
import { truncateBytes } from "../shared/util.ts";
import type { HostConfig } from "./config.ts";
import { HostError, isInside, resolveWithinRoots } from "./validate.ts";

export type { GitDiffFile, GitDiffResult, GitDiscardResult };

const MAX_DIFF_FILES = 100;
const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_TOTAL_PATCH_BYTES = 512 * 1024;
const MAX_DIFF_JSON_BYTES = Math.min(MAX_TOTAL_PATCH_BYTES + 64 * 1024, MAX_FRAME_BYTES - 64 * 1024);
const DIFF_DEADLINE_MS = 10_000;

export function execGit(
  cwd: string,
  args: string[],
  timeout = 5000,
  ceilingDirs?: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (ceilingDirs && ceilingDirs.length > 0) {
      env.GIT_CEILING_DIRECTORIES = ceilingDirs.join(path.delimiter);
    }
    const child = execFile(
      "git",
      ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", ...args],
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: stdout || "", stderr: stderr || "", code });
      },
    );
    const sigkillGraceMs = Math.min(1_000, Math.max(200, timeout));
    killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ stdout: "", stderr: "git command timed out (SIGKILL)", code: -1 });
    }, timeout + sigkillGraceMs);
    killTimer.unref?.();
  });
}

function canonicalRootsFor(cfg: HostConfig): string[] {
  return cfg.roots.map((r) => {
    const abs = path.resolve(r);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  });
}

function ceilingDirsFor(cfg: HostConfig, canonicalRoots: string[]): string[] {
  const allRoots = new Set<string>();
  for (const r of cfg.roots) allRoots.add(path.resolve(r));
  for (const r of canonicalRoots) allRoots.add(r);
  const rootList = [...allRoots];

  const ceilings = new Set<string>();
  for (const root of rootList) {
    const parent = path.dirname(root);
    if (!parent || parent === root) continue;
    // Do not set a ceiling on a directory that is itself inside another configured root.
    if (rootList.some((other) => isInside(other, parent))) continue;
    ceilings.add(parent);
  }
  return [...ceilings];
}

type RepoRootResolution =
  | { ok: true; repoRoot: string; cwdPrefix: string }
  | { ok: false; outsideRoots: boolean; notRepo: boolean; stderr: string };

async function resolveGitRepoRoot(
  cwd: string,
  canonicalRoots: string[],
  ceilingDirs: string[],
  timeoutMs = 5000,
): Promise<RepoRootResolution> {
  const topRes = await execGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs, ceilingDirs);
  if (topRes.code !== 0) {
    const stderr = topRes.stderr.trim();
    return {
      ok: false,
      outsideRoots: false,
      notRepo: /not a git repository/i.test(stderr),
      stderr: stderr || "git rev-parse failed",
    };
  }
  const rawTop = topRes.stdout.trim();
  if (!rawTop) {
    return { ok: false, outsideRoots: false, notRepo: true, stderr: "not a git repository" };
  }
  let realRepoRoot: string;
  try {
    realRepoRoot = fs.realpathSync(rawTop);
  } catch {
    return { ok: false, outsideRoots: true, notRepo: false, stderr: "git repository is outside allowed roots" };
  }
  if (!canonicalRoots.some((r) => isInside(r, realRepoRoot)) || !isInside(realRepoRoot, cwd)) {
    return { ok: false, outsideRoots: true, notRepo: false, stderr: "git repository is outside allowed roots" };
  }
  const rel = path.relative(realRepoRoot, cwd);
  const cwdPrefix = rel ? rel.split(path.sep).join("/") : "";
  return { ok: true, repoRoot: realRepoRoot, cwdPrefix };
}

function toCwdRelativePath(repoRelPath: string, cwdPrefix: string): string | null {
  const normalized = repoRelPath.replace(/\\/g, "/");
  if (!cwdPrefix) return normalized;
  const prefix = `${cwdPrefix}/`;
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
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
    clean.includes("\0") ||
    clean.startsWith("-") ||
    clean.startsWith(":(") ||
    path.isAbsolute(clean) ||
    path.win32.isAbsolute(clean)
  ) {
    throw new HostError("bad_request", "invalid relative path");
  }
  const normalized = path.posix.normalize(clean.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.startsWith("-") ||
    normalized.startsWith(":(")
  ) {
    throw new HostError("bad_request", "invalid relative path");
  }
  const absPath = path.resolve(cwd, normalized);
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

  return { relPath: normalized, absPath, isSymlink, isDirectory };
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

function formatByteLimit(bytes: number): string {
  if (bytes >= 1024) return `${Math.max(1, Math.floor(bytes / 1024))}KB`;
  return `${Math.max(0, bytes)}B`;
}

function truncatePatchToJsonBytes(rawPatch: string, maxJsonBytes: number): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(rawPatch), "utf8") <= maxJsonBytes) {
    return { patch: rawPatch, truncated: false };
  }
  if (maxJsonBytes <= 0) {
    return { patch: "", truncated: true };
  }
  const notice = `\n... [diff truncated at ${formatByteLimit(maxJsonBytes)}]`;
  if (Buffer.byteLength(JSON.stringify(notice), "utf8") > maxJsonBytes) {
    return { patch: "", truncated: true };
  }
  let lo = 0;
  let hi = Math.min(Buffer.byteLength(rawPatch, "utf8"), maxJsonBytes);
  let best = notice;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = truncateBytes(rawPatch, mid).text + notice;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxJsonBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { patch: best, truncated: true };
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
  const canonicalRoots = canonicalRootsFor(cfg);
  const ceilingDirs = ceilingDirsFor(cfg, canonicalRoots);

  let validatedFilterPath: string | undefined;
  if (requestedPath !== undefined && requestedPath !== "") {
    validatedFilterPath = validateRepoRelativePath(cwd, requestedPath).relPath;
  }

  const repo = await resolveGitRepoRoot(cwd, canonicalRoots, ceilingDirs, 5000);
  if (!repo.ok) {
    if (repo.outsideRoots || repo.notRepo) {
      return { cwd, branch: null, files: [], totalAdditions: 0, totalDeletions: 0 };
    }
    throw new HostError("internal", repo.stderr);
  }

  const remainingMs = () => DIFF_DEADLINE_MS - (Date.now() - startedAt);
  const branchTimeout = Math.max(100, Math.min(5000, remainingMs()));
  const branchRes = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], branchTimeout, ceilingDirs);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;

  const statusArgs = ["status", "--porcelain", "-z", "-u", "--", validatedFilterPath ?? "."];
  const statusTimeout = Math.max(100, Math.min(5000, remainingMs()));
  const statusRes = await execGit(cwd, statusArgs, statusTimeout, ceilingDirs);
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
  let totalPatchJsonBytes = 0;
  let usedJsonBytes =
    Buffer.byteLength(JSON.stringify({ cwd, branch, files: [], totalAdditions: 0, totalDeletions: 0 }), "utf8") + 64;

  for (const entry of entries) {
    if (files.length >= MAX_DIFF_FILES) break;
    const code = entry.code;
    const cwdRel = toCwdRelativePath(entry.path, repo.cwdPrefix);
    if (!cwdRel) continue;

    let validated: { relPath: string; absPath: string; isSymlink: boolean; isDirectory: boolean };
    try {
      validated = validateRepoRelativePath(cwd, cwdRel);
    } catch {
      continue;
    }
    const { relPath, isSymlink, isDirectory } = validated;

    let status: GitDiffFile["status"] = "modified";
    if (code.includes("A") || code === "??") status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("R")) status = "renamed";

    const currentRemaining = remainingMs();
    let overBudget =
      totalPatchJsonBytes >= MAX_TOTAL_PATCH_BYTES ||
      usedJsonBytes >= MAX_DIFF_JSON_BYTES ||
      currentRemaining <= 0;

    let rawPatch = "";
    if (!redact && !overBudget && !isSymlink && !isDirectory) {
      if (status === "added" && code === "??") {
        const rem = remainingMs();
        if (rem <= 0) {
          overBudget = true;
        } else {
          const diffRes = await execGit(
            cwd,
            ["diff", "--no-color", "--no-ext-diff", "-U2", "--no-index", "--", "/dev/null", relPath],
            Math.max(100, Math.min(5000, rem)),
            ceilingDirs,
          );
          rawPatch = diffRes.stdout;
        }
      } else {
        const remHead = remainingMs();
        if (remHead <= 0) {
          overBudget = true;
        } else {
          const diffRes = await execGit(
            cwd,
            ["diff", "--no-color", "--no-ext-diff", "-U2", "HEAD", "--", relPath],
            Math.max(100, Math.min(5000, remHead)),
            ceilingDirs,
          );
          rawPatch = diffRes.stdout;
          if (!rawPatch) {
            const remIndex = remainingMs();
            if (remIndex <= 0) {
              overBudget = true;
            } else {
              const diffIndex = await execGit(
                cwd,
                ["diff", "--no-color", "--no-ext-diff", "-U2", "--", relPath],
                Math.max(100, Math.min(5000, remIndex)),
                ceilingDirs,
              );
              rawPatch = diffIndex.stdout;
              if (!rawPatch) {
                const remStaged = remainingMs();
                if (remStaged <= 0) {
                  overBudget = true;
                } else {
                  const diffStaged = await execGit(
                    cwd,
                    ["diff", "--no-color", "--no-ext-diff", "-U2", "--cached", "--", relPath],
                    Math.max(100, Math.min(5000, remStaged)),
                    ceilingDirs,
                  );
                  rawPatch = diffStaged.stdout;
                }
              }
            }
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

    const metaStubBytes =
      Buffer.byteLength(
        JSON.stringify({
          path: relPath,
          status,
          additions: adds,
          deletions: dels,
          binary,
          patch: "",
          truncated: true,
        }),
        "utf8",
      ) + 1;
    if (usedJsonBytes + metaStubBytes > MAX_DIFF_JSON_BYTES) break;

    const remainingTotalJson = Math.max(0, MAX_DIFF_JSON_BYTES - usedJsonBytes - metaStubBytes);
    const remainingPatchJson = Math.max(0, MAX_TOTAL_PATCH_BYTES - totalPatchJsonBytes);
    const maxFileJsonBytes = Math.min(MAX_FILE_PATCH_BYTES, remainingTotalJson, remainingPatchJson);

    let patch = "";
    let truncated = redact || overBudget;
    if (!redact && !overBudget) {
      const res = truncatePatchToJsonBytes(rawPatch, maxFileJsonBytes);
      patch = res.patch;
      truncated = res.truncated;
    }

    const fileEntry: GitDiffFile = {
      path: relPath,
      status,
      additions: adds,
      deletions: dels,
      binary,
      patch,
      truncated,
    };
    totalPatchJsonBytes += Buffer.byteLength(JSON.stringify(patch), "utf8");
    usedJsonBytes += Buffer.byteLength(JSON.stringify(fileEntry), "utf8") + 1;

    files.push(fileEntry);
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
  const canonicalRoots = canonicalRootsFor(cfg);
  const ceilingDirs = ceilingDirsFor(cfg, canonicalRoots);

  const repo = await resolveGitRepoRoot(cwd, canonicalRoots, ceilingDirs, 5000);
  if (!repo.ok) {
    if (repo.outsideRoots) {
      throw new HostError("bad_request", "git repository is outside allowed roots");
    }
    if (repo.notRepo) {
      throw new HostError("bad_request", "not a git repository");
    }
    throw new HostError("internal", repo.stderr);
  }

  const { relPath, absPath, isSymlink, isDirectory } = validateRepoRelativePath(cwd, rawRelPath);
  if (isDirectory || isSymlink) {
    throw new HostError("bad_request", "path must be a file, not a directory or symlink");
  }

  const statusRes = await execGit(cwd, ["status", "--porcelain", "-z", "-u", "--", relPath], 5000, ceilingDirs);
  if (statusRes.code !== 0) {
    throw new HostError("internal", statusRes.stderr.trim() || "git status failed");
  }
  const matched = parsePorcelainZ(statusRes.stdout).find((e) => toCwdRelativePath(e.path, repo.cwdPrefix) === relPath);
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
    const checkoutRes = await execGit(cwd, ["checkout", "HEAD", "--", relPath], 5000, ceilingDirs);
    if (checkoutRes.code !== 0) {
      // Fallback for unborn HEAD or staged newly-added files
      if (code.includes("A")) {
        const rmRes = await execGit(cwd, ["rm", "-f", "--", relPath], 5000, ceilingDirs);
        if (rmRes.code !== 0) throw new HostError("internal", "failed to discard added file");
      } else {
        const fallbackRes = await execGit(cwd, ["checkout", "--", relPath], 5000, ceilingDirs);
        if (fallbackRes.code !== 0) throw new HostError("internal", "failed to checkout file from HEAD");
      }
    }
  }

  return { cwd, ok: true, path: relPath };
}
