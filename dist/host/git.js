import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { truncateBytes } from "../shared/util.js";
import { HostError, isInside, resolveWithinRoots } from "./validate.js";
const MAX_DIFF_FILES = 100;
const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_TOTAL_PATCH_BYTES = 512 * 1024;
const DIFF_DEADLINE_MS = 10_000;
function execGit(cwd, args, timeout = 5000) {
    return new Promise((resolve) => {
        execFile("git", ["--literal-pathspecs", "-c", "core.quotePath=false", ...args], {
            cwd,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
        }, (err, stdout) => {
            const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({ stdout: stdout || "", code });
        });
    });
}
function validateRepoRelativePath(cwd, relPath) {
    const clean = relPath.replace(/\r$/, "");
    if (!clean ||
        clean === "." ||
        clean === ".." ||
        clean.includes("\0") ||
        clean.startsWith("-") ||
        clean.startsWith(":(") ||
        path.isAbsolute(clean) ||
        path.win32.isAbsolute(clean)) {
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
    try {
        const lst = fs.lstatSync(absPath);
        if (lst.isSymbolicLink()) {
            isSymlink = true;
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
    return { relPath: clean, absPath, isSymlink };
}
function unquotePorcelainPath(raw) {
    const s = raw.replace(/\r$/, "");
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    return s;
}
export async function gitDiff(cfg, requestedCwd, requestedPath) {
    const cwd = resolveWithinRoots(cfg, requestedCwd);
    const startedAt = Date.now();
    let validatedFilterPath;
    if (requestedPath !== undefined && requestedPath !== "") {
        validatedFilterPath = validateRepoRelativePath(cwd, requestedPath).relPath;
    }
    const branchRes = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
    const statusArgs = ["status", "--porcelain", "-u"];
    if (validatedFilterPath)
        statusArgs.push("--", validatedFilterPath);
    const statusRes = await execGit(cwd, statusArgs);
    if (statusRes.code !== 0 && !statusRes.stdout) {
        return { cwd, branch, files: [], totalAdditions: 0, totalDeletions: 0 };
    }
    const lines = statusRes.stdout.split("\n").filter((l) => l.replace(/\r$/, "").length > 3);
    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let totalPatchBytes = 0;
    for (const rawLine of lines) {
        if (files.length >= MAX_DIFF_FILES)
            break;
        const line = rawLine.replace(/\r$/, "");
        const code = line.slice(0, 2);
        let rawRel = line.slice(3);
        if (code.includes("R") && rawRel.includes(" -> ")) {
            rawRel = rawRel.split(" -> ").pop();
        }
        const candidatePath = unquotePorcelainPath(rawRel);
        let validated;
        try {
            validated = validateRepoRelativePath(cwd, candidatePath);
        }
        catch {
            continue;
        }
        const { relPath, isSymlink } = validated;
        let status = "modified";
        if (code.includes("A") || code === "??")
            status = "added";
        else if (code.includes("D"))
            status = "deleted";
        else if (code.includes("R"))
            status = "renamed";
        const overBudget = totalPatchBytes >= MAX_TOTAL_PATCH_BYTES || Date.now() - startedAt >= DIFF_DEADLINE_MS;
        let rawPatch = "";
        if (!overBudget && !isSymlink) {
            if (status === "added" && code === "??") {
                const diffRes = await execGit(cwd, [
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "-U2",
                    "--no-index",
                    "--",
                    "/dev/null",
                    relPath,
                ]);
                rawPatch = diffRes.stdout;
            }
            else {
                const diffRes = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "HEAD", "--", relPath]);
                rawPatch = diffRes.stdout;
                if (!rawPatch) {
                    const diffIndex = await execGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", "--", relPath]);
                    rawPatch = diffIndex.stdout;
                    if (!rawPatch) {
                        const diffStaged = await execGit(cwd, [
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            "-U2",
                            "--cached",
                            "--",
                            relPath,
                        ]);
                        rawPatch = diffStaged.stdout;
                    }
                }
            }
        }
        const binary = rawPatch.includes("Binary files ") || rawPatch.includes("GIT binary patch");
        let adds = 0;
        let dels = 0;
        for (const pLine of rawPatch.split("\n")) {
            if (pLine.startsWith("+") && !pLine.startsWith("+++"))
                adds++;
            else if (pLine.startsWith("-") && !pLine.startsWith("---"))
                dels++;
        }
        const remainingBudget = Math.max(0, MAX_TOTAL_PATCH_BYTES - totalPatchBytes);
        const maxFileBytes = Math.min(MAX_FILE_PATCH_BYTES, remainingBudget);
        let patch = rawPatch;
        let truncated = overBudget;
        if (maxFileBytes === 0 && rawPatch.length > 0) {
            patch = "";
            truncated = true;
        }
        else if (Buffer.byteLength(rawPatch, "utf8") > maxFileBytes) {
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
export async function gitDiscard(cfg, requestedCwd, rawRelPath) {
    const cwd = resolveWithinRoots(cfg, requestedCwd);
    const { relPath } = validateRepoRelativePath(cwd, rawRelPath);
    const statusRes = await execGit(cwd, ["status", "--porcelain", "-u", "--", relPath]);
    const statusLine = statusRes.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    const code = statusLine.slice(0, 2);
    const isUntracked = code === "??";
    if (isUntracked) {
        const cleanRes = await execGit(cwd, ["clean", "-fd", "--", relPath]);
        if (cleanRes.code !== 0)
            throw new HostError("internal", "failed to clean untracked file");
    }
    else {
        const checkoutRes = await execGit(cwd, ["checkout", "HEAD", "--", relPath]);
        if (checkoutRes.code !== 0) {
            // Fallback for unborn HEAD or staged newly-added files
            if (code.includes("A")) {
                const rmRes = await execGit(cwd, ["rm", "-f", "--", relPath]);
                if (rmRes.code !== 0)
                    throw new HostError("internal", "failed to discard added file");
            }
            else {
                const fallbackRes = await execGit(cwd, ["checkout", "--", relPath]);
                if (fallbackRes.code !== 0)
                    throw new HostError("internal", "failed to checkout file from HEAD");
            }
        }
    }
    return { cwd, ok: true, path: relPath };
}
