import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_FRAME_BYTES } from "../shared/protocol.js";
import { truncateBytes } from "../shared/util.js";
import { HostError, isInside, resolveWithinRoots } from "./validate.js";
const MAX_DIFF_FILES = 100;
const DIFF_BATCH_SIZE = 50;
const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_TOTAL_PATCH_BYTES = 512 * 1024;
const MAX_DIFF_JSON_BYTES = Math.min(MAX_TOTAL_PATCH_BYTES + 64 * 1024, MAX_FRAME_BYTES - 64 * 1024);
const DIFF_DEADLINE_MS = 10_000;
export function execGit(cwd, args, timeout = 5000, ceilingDirs) {
    return new Promise((resolve) => {
        let settled = false;
        let killTimer;
        const env = {
            ...process.env,
            GIT_LITERAL_PATHSPECS: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
        };
        if (ceilingDirs && ceilingDirs.length > 0) {
            env.GIT_CEILING_DIRECTORIES = ceilingDirs.join(path.delimiter);
        }
        const child = execFile("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", ...args], {
            cwd,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            env,
        }, (err, stdout, stderr) => {
            if (settled)
                return;
            settled = true;
            if (killTimer)
                clearTimeout(killTimer);
            const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({ stdout: stdout || "", stderr: stderr || "", code });
        });
        const sigkillGraceMs = Math.min(1_000, Math.max(200, timeout));
        killTimer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* ignore */
            }
            resolve({ stdout: "", stderr: "git command timed out (SIGKILL)", code: -1 });
        }, timeout + sigkillGraceMs);
        killTimer.unref?.();
    });
}
function canonicalRootsFor(cfg) {
    return cfg.roots.map((r) => {
        const abs = path.resolve(r);
        try {
            return fs.realpathSync(abs);
        }
        catch {
            return abs;
        }
    });
}
function ceilingDirsFor(cfg, canonicalRoots) {
    const allRoots = new Set();
    for (const r of cfg.roots)
        allRoots.add(path.resolve(r));
    for (const r of canonicalRoots)
        allRoots.add(r);
    const rootList = [...allRoots];
    const ceilings = new Set();
    for (const root of rootList) {
        const parent = path.dirname(root);
        if (!parent || parent === root)
            continue;
        // Do not set a ceiling on a directory that is itself inside another configured root.
        if (rootList.some((other) => isInside(other, parent)))
            continue;
        ceilings.add(parent);
    }
    return [...ceilings];
}
async function resolveGitRepoRoot(cwd, canonicalRoots, ceilingDirs, timeoutMs = 5000) {
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
    let realRepoRoot;
    try {
        realRepoRoot = fs.realpathSync(rawTop);
    }
    catch {
        return { ok: false, outsideRoots: true, notRepo: false, stderr: "git repository is outside allowed roots" };
    }
    if (!canonicalRoots.some((r) => isInside(r, realRepoRoot)) || !isInside(realRepoRoot, cwd)) {
        return { ok: false, outsideRoots: true, notRepo: false, stderr: "git repository is outside allowed roots" };
    }
    const rel = path.relative(realRepoRoot, cwd);
    const cwdPrefix = rel ? rel.split(path.sep).join("/") : "";
    return { ok: true, repoRoot: realRepoRoot, cwdPrefix };
}
function toCwdRelativePath(repoRelPath, cwdPrefix) {
    const normalized = repoRelPath.replace(/\\/g, "/");
    if (!cwdPrefix)
        return normalized;
    const prefix = `${cwdPrefix}/`;
    if (!normalized.startsWith(prefix))
        return null;
    return normalized.slice(prefix.length);
}
/** Parse the `## ...` branch header line from `git status --porcelain=v1 -b`. */
export function parsePorcelainBranchHeader(headerLine) {
    const line = headerLine.replace(/\r$/, "");
    if (!line.startsWith("## "))
        return null;
    const rest = line.slice(3).trim();
    if (!rest)
        return null;
    if (rest === "HEAD (no branch)" || rest.startsWith("HEAD (no branch)"))
        return "HEAD";
    const unbornMatch = /^(?:No commits yet|Initial commit) on (.+)$/.exec(rest);
    if (unbornMatch)
        return unbornMatch[1].trim() || null;
    const dotsIdx = rest.indexOf("...");
    if (dotsIdx >= 0)
        return rest.slice(0, dotsIdx).trim() || null;
    return rest.split(/\s+\[/, 1)[0].trim() || null;
}
/** Lightweight branch and tracked/untracked dirty status poll using a single `git status` spawn. */
export async function readGitHeadAndDirty(cwd, untracked = false) {
    const st = await execGit(cwd, ["status", "--porcelain=v1", "-b", untracked ? "-u" : "-uno"], 2000);
    if (st.code !== 0)
        return null;
    const lines = st.stdout.split("\n");
    let branch = null;
    let dirty = false;
    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (!line)
            continue;
        if (line.startsWith("## ")) {
            if (branch === null)
                branch = parsePorcelainBranchHeader(line);
            continue;
        }
        if (line.trim().length > 0) {
            dirty = true;
        }
    }
    return { branch, dirty };
}
function validateRepoRelativePath(cwd, relPath) {
    const clean = relPath.replace(/\r$/, "");
    if (!clean ||
        clean.includes("\0") ||
        clean.startsWith("-") ||
        clean.startsWith(":(") ||
        path.isAbsolute(clean) ||
        path.win32.isAbsolute(clean)) {
        throw new HostError("bad_request", "invalid relative path");
    }
    const normalized = path.posix.normalize(clean.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (!normalized ||
        normalized === "." ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.startsWith("/") ||
        normalized.startsWith("-") ||
        normalized.startsWith(":(")) {
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
            let realCur;
            try {
                realCur = fs.realpathSync(cur);
            }
            catch {
                throw new HostError("bad_request", "invalid relative path");
            }
            if (!isInside(cwd, realCur)) {
                throw new HostError("bad_request", "path escapes repository via symlink");
            }
            break;
        }
        const parent = path.dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    let isSymlink = false;
    let isDirectory = false;
    try {
        const lst = fs.lstatSync(absPath);
        if (lst.isSymbolicLink()) {
            isSymlink = true;
        }
        else if (lst.isDirectory()) {
            isDirectory = true;
        }
        else {
            const realTarget = fs.realpathSync(absPath);
            if (!isInside(cwd, realTarget)) {
                throw new HostError("bad_request", "path escapes repository via symlink");
            }
        }
    }
    catch (e) {
        if (e instanceof HostError)
            throw e;
        // File may be deleted in working tree; ancestor check above is sufficient
    }
    return { relPath: normalized, absPath, isSymlink, isDirectory };
}
/** Parse `git status --porcelain -z` output into status code + target relative path records. */
function parsePorcelainZ(stdout) {
    const entries = [];
    const fields = stdout.split("\0");
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.length < 4)
            continue;
        const code = field.slice(0, 2);
        const rel = field.slice(3);
        if (code.includes("R") || code.includes("C")) {
            // Porcelain -z emits target path first, then NUL + original path
            i++;
        }
        if (rel)
            entries.push({ code, path: rel });
    }
    return entries;
}
function formatByteLimit(bytes) {
    if (bytes >= 1024)
        return `${Math.max(1, Math.floor(bytes / 1024))}KB`;
    return `${Math.max(0, bytes)}B`;
}
function truncatePatchToJsonBytes(rawPatch, maxJsonBytes) {
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
        }
        else {
            hi = mid - 1;
        }
    }
    return { patch: best, truncated: true };
}
function extractDiffChunkPath(chunk, knownRepoPaths) {
    const nl = chunk.indexOf("\n");
    const header = (nl >= 0 ? chunk.slice(0, nl) : chunk).replace(/\r$/, "");
    if (!header.startsWith("diff --git "))
        return null;
    const rest = header.slice("diff --git ".length);
    // Fast exact match for non-renamed files: `<src>/<path> <dst>/<path>` (handles spaces in paths unambiguously)
    if (rest.length >= 7 && rest[1] === "/" && (rest.length - 5) % 2 === 0) {
        const pLen = (rest.length - 5) / 2;
        if (rest[2 + pLen] === " " && rest[4 + pLen] === "/") {
            const aPath = rest.slice(2, 2 + pLen);
            const bPath = rest.slice(5 + pLen);
            if (aPath === bPath)
                return aPath;
        }
    }
    // Check rename header if present
    const renameMatch = /^rename to (.+)$/m.exec(chunk);
    if (renameMatch) {
        const target = renameMatch[1].replace(/\r$/, "");
        if (target)
            return target;
    }
    // Match against the exact known repository-relative paths requested in this batch
    let bestKnown = null;
    for (const candidate of knownRepoPaths) {
        const suffixIdx = rest.length - candidate.length;
        if (suffixIdx >= 3 &&
            rest.endsWith(candidate) &&
            rest[suffixIdx - 1] === "/" &&
            rest[suffixIdx - 3] === " " &&
            (!bestKnown || candidate.length > bestKnown.length)) {
            bestKnown = candidate;
        }
    }
    if (bestKnown)
        return bestKnown;
    // Fallback to +++ <dst>/<path> or --- <src>/<path> lines
    const plusMatch = /^\+\+\+ [a-z]\/(.+)$/m.exec(chunk);
    if (plusMatch)
        return plusMatch[1].replace(/\r$/, "");
    const minusMatch = /^--- [a-z]\/(.+)$/m.exec(chunk);
    if (minusMatch)
        return minusMatch[1].replace(/\r$/, "");
    return null;
}
function splitBatchedGitDiff(stdout, knownRepoPaths, cwdPrefix) {
    const patches = new Map();
    if (!stdout)
        return patches;
    const chunks = stdout.split(/(?=^diff --git )/m);
    for (const chunk of chunks) {
        if (!chunk.startsWith("diff --git "))
            continue;
        const repoPath = extractDiffChunkPath(chunk, knownRepoPaths);
        if (!repoPath)
            continue;
        const cwdRel = toCwdRelativePath(repoPath, cwdPrefix);
        if (!cwdRel)
            continue;
        const norm = path.posix.normalize(cwdRel.replace(/\\/g, "/")).replace(/\/+$/, "");
        if (norm)
            patches.set(norm, chunk);
    }
    return patches;
}
export async function gitDiff(cfg, requestedCwd, requestedPath, opts = {}) {
    const cwd = resolveWithinRoots(cfg, requestedCwd);
    const startedAt = Date.now();
    const redact = !!opts.redactContent;
    const canonicalRoots = canonicalRootsFor(cfg);
    const ceilingDirs = ceilingDirsFor(cfg, canonicalRoots);
    let validatedFilterPath;
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
    const validatedEntries = [];
    for (const entry of entries) {
        if (validatedEntries.length >= MAX_DIFF_FILES)
            break;
        const cwdRel = toCwdRelativePath(entry.path, repo.cwdPrefix);
        if (!cwdRel)
            continue;
        let validated;
        try {
            validated = validateRepoRelativePath(cwd, cwdRel);
        }
        catch {
            continue;
        }
        let status = "modified";
        if (entry.code.includes("A") || entry.code === "??")
            status = "added";
        else if (entry.code.includes("D"))
            status = "deleted";
        else if (entry.code.includes("R"))
            status = "renamed";
        validatedEntries.push({
            code: entry.code,
            relPath: validated.relPath,
            isSymlink: validated.isSymlink,
            isDirectory: validated.isDirectory,
            status,
        });
    }
    const trackedRelPaths = validatedEntries
        .filter((e) => !(e.status === "added" && e.code === "??") && !e.isSymlink && !e.isDirectory)
        .map((e) => e.relPath);
    const batchedPatches = new Map();
    const batchAttempted = new Set();
    let nextBatchIdx = 0;
    let headIsUnborn = branch === null && branchRes.code !== 0;
    const ensureBatchLoaded = async (relPath) => {
        if (batchAttempted.has(relPath))
            return;
        while (nextBatchIdx < trackedRelPaths.length && !batchAttempted.has(relPath)) {
            const batch = trackedRelPaths.slice(nextBatchIdx, nextBatchIdx + DIFF_BATCH_SIZE);
            nextBatchIdx += batch.length;
            for (const p of batch)
                batchAttempted.add(p);
            const rem = remainingMs();
            if (rem <= 0)
                return;
            const knownRepoPaths = new Set(batch.map((p) => (repo.cwdPrefix ? `${repo.cwdPrefix}/${p}` : p)));
            if (!headIsUnborn) {
                const diffRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U2", "HEAD", "--", ...batch], Math.max(100, Math.min(5000, rem)), ceilingDirs);
                if (diffRes.code === 0) {
                    for (const [k, v] of splitBatchedGitDiff(diffRes.stdout, knownRepoPaths, repo.cwdPrefix)) {
                        batchedPatches.set(k, v);
                    }
                    continue;
                }
                if (/unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(diffRes.stderr)) {
                    headIsUnborn = true;
                }
            }
            if (headIsUnborn) {
                const remCached = remainingMs();
                if (remCached <= 0)
                    return;
                const cachedRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U2", "--cached", "--", ...batch], Math.max(100, Math.min(5000, remCached)), ceilingDirs);
                if (cachedRes.code === 0) {
                    for (const [k, v] of splitBatchedGitDiff(cachedRes.stdout, knownRepoPaths, repo.cwdPrefix)) {
                        batchedPatches.set(k, v);
                    }
                }
            }
        }
    };
    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let totalPatchJsonBytes = 0;
    let usedJsonBytes = Buffer.byteLength(JSON.stringify({ cwd, branch, files: [], totalAdditions: 0, totalDeletions: 0 }), "utf8") + 64;
    for (const entry of validatedEntries) {
        if (files.length >= MAX_DIFF_FILES)
            break;
        const { code, relPath, isSymlink, isDirectory, status } = entry;
        const currentRemaining = remainingMs();
        let overBudget = totalPatchJsonBytes >= MAX_TOTAL_PATCH_BYTES ||
            usedJsonBytes >= MAX_DIFF_JSON_BYTES ||
            currentRemaining <= 0;
        let rawPatch = "";
        if (!redact && !overBudget && !isSymlink && !isDirectory) {
            if (status === "added" && code === "??") {
                const rem = remainingMs();
                if (rem <= 0) {
                    overBudget = true;
                }
                else {
                    const diffRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "--no-index", "--", "/dev/null", relPath], Math.max(100, Math.min(5000, rem)), ceilingDirs);
                    rawPatch = diffRes.stdout;
                }
            }
            else {
                await ensureBatchLoaded(relPath);
                rawPatch = batchedPatches.get(relPath) ?? "";
                if (!rawPatch) {
                    const remHead = remainingMs();
                    if (remHead <= 0) {
                        overBudget = true;
                    }
                    else {
                        if (!headIsUnborn) {
                            const diffRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "HEAD", "--", relPath], Math.max(100, Math.min(5000, remHead)), ceilingDirs);
                            rawPatch = diffRes.stdout;
                        }
                        if (!rawPatch) {
                            const remIndex = remainingMs();
                            if (remIndex <= 0) {
                                overBudget = true;
                            }
                            else {
                                const diffIndex = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "--", relPath], Math.max(100, Math.min(5000, remIndex)), ceilingDirs);
                                rawPatch = diffIndex.stdout;
                                if (!rawPatch) {
                                    const remStaged = remainingMs();
                                    if (remStaged <= 0) {
                                        overBudget = true;
                                    }
                                    else {
                                        const diffStaged = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "--cached", "--", relPath], Math.max(100, Math.min(5000, remStaged)), ceilingDirs);
                                        rawPatch = diffStaged.stdout;
                                    }
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
                if (pLine.startsWith("+") && !pLine.startsWith("+++"))
                    adds++;
                else if (pLine.startsWith("-") && !pLine.startsWith("---"))
                    dels++;
            }
        }
        const metaStubBytes = Buffer.byteLength(JSON.stringify({
            path: relPath,
            status,
            additions: adds,
            deletions: dels,
            binary,
            patch: "",
            truncated: true,
        }), "utf8") + 1;
        if (usedJsonBytes + metaStubBytes > MAX_DIFF_JSON_BYTES)
            break;
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
        const fileEntry = {
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
export async function gitDiscard(cfg, requestedCwd, rawRelPath) {
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
        let lst;
        try {
            lst = fs.lstatSync(absPath);
        }
        catch {
            return { cwd, ok: true, path: relPath };
        }
        if (lst.isDirectory() || lst.isSymbolicLink()) {
            throw new HostError("bad_request", "path must be a file, not a directory or symlink");
        }
        fs.unlinkSync(absPath);
    }
    else {
        const checkoutRes = await execGit(cwd, ["checkout", "HEAD", "--", relPath], 5000, ceilingDirs);
        if (checkoutRes.code !== 0) {
            // Fallback for unborn HEAD or staged newly-added files
            if (code.includes("A")) {
                const rmRes = await execGit(cwd, ["rm", "-f", "--", relPath], 5000, ceilingDirs);
                if (rmRes.code !== 0)
                    throw new HostError("internal", "failed to discard added file");
            }
            else {
                const fallbackRes = await execGit(cwd, ["checkout", "--", relPath], 5000, ceilingDirs);
                if (fallbackRes.code !== 0)
                    throw new HostError("internal", "failed to checkout file from HEAD");
            }
        }
    }
    return { cwd, ok: true, path: relPath };
}
