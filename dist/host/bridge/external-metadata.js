// External agent metadata scrapers (context usage & active model detection) for Claude, Codex, and Antigravity CLI (agy).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveAgyTranscriptPath } from "../agy-transcript.js";
import { SAFE_CONV_ID_RE } from "../../shared/util.js";
const CLAUDE_DEFAULT_WINDOW = 200_000;
const CODEX_DEFAULT_WINDOW = 258_400;
export function readJsonlTailLines(filePath, maxBytes = 64 * 1024) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0)
            return [];
        const readSize = Math.min(stat.size, maxBytes);
        const fd = fs.openSync(filePath, "r");
        try {
            const buf = Buffer.allocUnsafe(readSize);
            fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
            const lines = buf.toString("utf8").split("\n");
            if (readSize < stat.size && lines.length > 0)
                lines.shift();
            return lines;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return [];
    }
}
export function findClaudeProjectJsonl(cwd, sessionId, home) {
    try {
        const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
        const projDir = path.join(home, ".claude", "projects", slug);
        if (!fs.existsSync(projDir))
            return null;
        if (sessionId && SAFE_CONV_ID_RE.test(sessionId)) {
            const candidate = path.join(projDir, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate))
                return candidate;
        }
        const files = fs
            .readdirSync(projDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => {
            const full = path.join(projDir, f);
            try {
                return { full, mtimeMs: fs.statSync(full).mtimeMs };
            }
            catch {
                return { full, mtimeMs: 0 };
            }
        })
            .filter((f) => f.mtimeMs > 0)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        return files[0]?.full ?? null;
    }
    catch {
        return null;
    }
}
function readClaudeContextUsage(cwd, sessionId, home) {
    const targetFile = findClaudeProjectJsonl(cwd, sessionId, home);
    if (!targetFile)
        return null;
    const lines = readJsonlTailLines(targetFile);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{"))
            continue;
        try {
            const obj = JSON.parse(line);
            const usage = obj?.message?.usage ?? obj?.usage;
            if (!usage || typeof usage !== "object")
                continue;
            const inTok = Number(usage.input_tokens ?? 0) || 0;
            const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0) || 0;
            const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
            const outTok = Number(usage.output_tokens ?? 0) || 0;
            const total = Math.max(0, Math.floor(inTok + cacheCreate + cacheRead + outTok));
            if (total > 0) {
                const pct = Math.min(100, Math.max(0, Math.round((total / CLAUDE_DEFAULT_WINDOW) * 100)));
                return { tokens: total, contextWindow: CLAUDE_DEFAULT_WINDOW, percent: pct };
            }
        }
        catch {
            /* ignore malformed line */
        }
    }
    return null;
}
function sortedRecentSubdirs(parent, limit) {
    try {
        return fs
            .readdirSync(parent)
            .sort()
            .reverse()
            .map((name) => path.join(parent, name))
            .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
            .slice(0, limit);
    }
    catch {
        return [];
    }
}
function collectRecentCodexSessionFiles(home) {
    const sessionsRoot = path.join(home, ".codex", "sessions");
    if (!fs.existsSync(sessionsRoot))
        return [];
    const candidates = [];
    for (const yDir of sortedRecentSubdirs(sessionsRoot, 2)) {
        for (const mDir of sortedRecentSubdirs(yDir, 2)) {
            for (const dDir of sortedRecentSubdirs(mDir, 3)) {
                for (const f of fs.readdirSync(dDir)) {
                    if (!f.endsWith(".jsonl"))
                        continue;
                    const full = path.join(dDir, f);
                    try {
                        candidates.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates.slice(0, 8).map((c) => c.full);
}
function matchesCodexCwd(filePath, cwd) {
    const headLines = readJsonlTailLines(filePath, 4096);
    const firstLine = headLines[0]?.trim();
    if (!firstLine?.startsWith("{"))
        return true;
    try {
        const meta = JSON.parse(firstLine);
        if (meta?.type === "session_meta" && meta?.payload?.cwd) {
            return path.resolve(meta.payload.cwd) === path.resolve(cwd);
        }
    }
    catch {
        /* ignore */
    }
    return true;
}
function readCodexContextUsage(cwd, sessionId, home) {
    try {
        for (const full of collectRecentCodexSessionFiles(home)) {
            if (sessionId && !path.basename(full).includes(sessionId))
                continue;
            if (!sessionId && cwd && !matchesCodexCwd(full, cwd))
                continue;
            const lines = readJsonlTailLines(full);
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line.startsWith("{"))
                    continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj?.payload?.type === "token_count" && obj?.payload?.info?.last_token_usage) {
                        const total = Math.max(0, Math.floor(Number(obj.payload.info.last_token_usage.total_tokens ?? 0)));
                        const win = Math.max(1, Math.floor(Number(obj.payload.info.model_context_window ?? CODEX_DEFAULT_WINDOW)));
                        if (total > 0) {
                            const pct = Math.min(100, Math.max(0, Math.round((total / win) * 100)));
                            return { tokens: total, contextWindow: win, percent: pct };
                        }
                    }
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    catch {
        /* ignore */
    }
    return null;
}
export function parseTerminalContextUsage(terminalText, defaultWindow = CLAUDE_DEFAULT_WINDOW) {
    if (!terminalText)
        return null;
    const slashMatch = /(\d+(?:\.\d+)?)\s*k\s*\/\s*(\d+(?:\.\d+)?)\s*k/i.exec(terminalText);
    if (slashMatch) {
        const tokens = Math.round(Number.parseFloat(slashMatch[1]) * 1000);
        const window = Math.round(Number.parseFloat(slashMatch[2]) * 1000);
        if (tokens > 0 && window > 0 && tokens <= window * 2) {
            const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
            return { tokens, contextWindow: window, percent };
        }
    }
    const leftMatch = /(\d{1,3})%\s+context\s+left/i.exec(terminalText);
    if (leftMatch) {
        const leftPct = Number.parseInt(leftMatch[1], 10);
        if (leftPct >= 0 && leftPct <= 100) {
            const percent = 100 - leftPct;
            const tokens = Math.round((percent / 100) * defaultWindow);
            return { tokens, contextWindow: defaultWindow, percent };
        }
    }
    const usedMatch = /context(?:\s+used)?[:\s]+(\d{1,3})%/i.exec(terminalText);
    if (usedMatch) {
        const percent = Number.parseInt(usedMatch[1], 10);
        if (percent >= 0 && percent <= 100) {
            const tokens = Math.round((percent / 100) * defaultWindow);
            return { tokens, contextWindow: defaultWindow, percent };
        }
    }
    return null;
}
export function readExternalAgentContextUsage(agent, cwd, sessionId, terminalText = "", home = os.homedir()) {
    if (agent === "claude") {
        return readClaudeContextUsage(cwd, sessionId, home) ?? parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW);
    }
    if (agent === "codex") {
        return readCodexContextUsage(cwd, sessionId, home) ?? parseTerminalContextUsage(terminalText, CODEX_DEFAULT_WINDOW);
    }
    return parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW);
}
function extractAgyModelFromGenMetadataBlob(buf) {
    const tail = buf.subarray(Math.max(0, buf.length - 600));
    for (const tagByte of [0xaa, 0x9a]) {
        for (let i = tail.length - 4; i >= 0; i--) {
            if (tail[i] === tagByte && tail[i + 1] === 0x01) {
                const len = tail[i + 2];
                if (len >= 3 && len <= 80 && i + 3 + len <= tail.length) {
                    const s = tail.subarray(i + 3, i + 3 + len).toString("utf8").trim();
                    if (/^[A-Za-z0-9][A-Za-z0-9 ._()/-]+$/.test(s) &&
                        !/^[0-9a-f-]{32,}$/i.test(s) &&
                        s !== "false" &&
                        s !== "true") {
                        return s;
                    }
                }
            }
        }
    }
    return null;
}
function readAgySessionModel(sessionId, home) {
    if (!sessionId || !SAFE_CONV_ID_RE.test(sessionId))
        return { model: null, uncertain: false };
    let transcriptChangeModel = null;
    let lastUserInputChangeModel = null;
    try {
        const tPath = resolveAgyTranscriptPath(sessionId, home);
        const lines = readJsonlTailLines(tPath, 256 * 1024);
        let seenLatestUserInput = false;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line.startsWith("{"))
                continue;
            try {
                const obj = JSON.parse(line);
                if (obj?.type === "USER_INPUT" && typeof obj?.content === "string") {
                    const m = /changed setting `Model Selection` from [^\n]+ to ([^\n.<]+)\./i.exec(obj.content);
                    if (m?.[1]?.trim()) {
                        const candidate = m[1].trim();
                        if (!transcriptChangeModel)
                            transcriptChangeModel = candidate;
                        if (!seenLatestUserInput)
                            lastUserInputChangeModel = candidate;
                    }
                    seenLatestUserInput = true;
                    if (transcriptChangeModel)
                        break;
                }
            }
            catch {
                /* ignore */
            }
        }
    }
    catch {
        /* ignore */
    }
    if (lastUserInputChangeModel)
        return { model: lastUserInputChangeModel, uncertain: false };
    let dbError = false;
    try {
        const dbPath = path.join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
        if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath, { open: true, readOnly: true, timeout: 1000 });
            try {
                const row = db.prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1").get();
                if (row?.data) {
                    const fromDb = extractAgyModelFromGenMetadataBlob(Buffer.from(row.data));
                    if (fromDb)
                        return { model: fromDb, uncertain: false };
                }
            }
            finally {
                db.close();
            }
        }
    }
    catch {
        dbError = true;
    }
    return { model: transcriptChangeModel, uncertain: dbError };
}
export function readExternalAgentModelWithState(agent, cwd, sessionId, home = os.homedir()) {
    if (agent === "agy") {
        const { model: sessionModel, uncertain } = readAgySessionModel(sessionId, home);
        if (sessionModel) {
            return { model: { provider: "google", id: sessionModel }, uncertain: false };
        }
        try {
            const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
            if (fs.existsSync(settingsPath)) {
                const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
                if (typeof parsed?.model === "string" && parsed.model.trim()) {
                    return { model: { provider: "google", id: parsed.model.trim() }, uncertain };
                }
            }
        }
        catch {
            /* ignore */
        }
        return { model: { provider: "google", id: "antigravity" }, uncertain };
    }
    if (agent === "claude") {
        try {
            const targetFile = findClaudeProjectJsonl(cwd, sessionId, home);
            if (targetFile) {
                const lines = readJsonlTailLines(targetFile);
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i].trim();
                    if (!line.startsWith("{"))
                        continue;
                    try {
                        const obj = JSON.parse(line);
                        const model = obj?.message?.model ?? obj?.model;
                        if (typeof model === "string" && model.trim()) {
                            return { model: { provider: "anthropic", id: model.trim() }, uncertain: false };
                        }
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            const claudeSettings = path.join(home, ".claude", "settings.json");
            if (fs.existsSync(claudeSettings)) {
                const parsed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
                if (typeof parsed?.model === "string" && parsed.model.trim()) {
                    return { model: { provider: "anthropic", id: parsed.model.trim() }, uncertain: false };
                }
            }
        }
        catch {
            /* ignore */
        }
        return { model: { provider: "anthropic", id: "claude" }, uncertain: false };
    }
    if (agent === "codex") {
        try {
            const cfgToml = path.join(home, ".codex", "config.toml");
            if (fs.existsSync(cfgToml)) {
                const text = fs.readFileSync(cfgToml, "utf8");
                const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text);
                if (m?.[1]?.trim()) {
                    return { model: { provider: "openai", id: m[1].trim() }, uncertain: false };
                }
            }
        }
        catch {
            /* ignore */
        }
        return { model: { provider: "openai", id: "codex" }, uncertain: false };
    }
    return { model: { provider: agent, id: "default" }, uncertain: false };
}
export function readExternalAgentModel(agent, cwd, sessionId, home = os.homedir()) {
    return readExternalAgentModelWithState(agent, cwd, sessionId, home).model;
}
