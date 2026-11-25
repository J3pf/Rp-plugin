// External agent metadata scrapers (context usage & active model detection) for Claude, Codex, and Antigravity CLI (agy).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MODEL_CHANGE_RE, readTailBuffer, resolveAgyTranscriptPath, type ContextUsageInfo } from "./agy-paths.ts";
import { LruMap, SAFE_CONV_ID_RE } from "../../shared/util.ts";

export { MODEL_CHANGE_RE };

const CLAUDE_DEFAULT_WINDOW = 200_000;
const CODEX_DEFAULT_WINDOW = 258_400;
const AGY_MODEL_CACHE_THROTTLE_MS = 10_000;
const AGY_MODEL_DB_TIMEOUT_MS = 25;
const EXTERNAL_DIR_SCAN_TTL_MS = 12_000;

export interface ReadAgySessionModelOptions {
  /** Model already extracted in-memory from transcript USER_SETTINGS_CHANGE by AgyTranscriptReader. */
  knownTranscriptModel?: string | null;
  /** Bypass the wall-clock throttle. */
  force?: boolean;
}

export interface ExternalAgentMetadata {
  usage: ContextUsageInfo | null;
  model: { provider: string; id: string };
  uncertain: boolean;
}

interface FileStatMeta {
  mtimeMs: number;
  size: number;
}

interface AgyModelCacheEntry {
  value: { model: string | null; uncertain: boolean };
  dbMtimeMs: number | null;
  transcriptMtimeMs: number | null;
  knownTranscriptModel: string | null;
  checkedAt: number;
}

interface ClaudeDirCacheEntry {
  filePath: string | null;
  dirMtimeMs: number | null;
  checkedAt: number;
}

interface ClaudeFileMetaCacheEntry {
  mtimeMs: number;
  size: number;
  usage: ContextUsageInfo | null;
  model: string | null;
}

interface CodexDirCacheEntry {
  filePath: string | null;
  checkedAt: number;
}

interface CodexFileMetaCacheEntry {
  mtimeMs: number;
  size: number;
  usage: ContextUsageInfo | null;
}

interface TextFileCacheEntry {
  mtimeMs: number;
  size: number;
  text: string;
}

const agyModelCache = new LruMap<string, AgyModelCacheEntry>(256);
const claudeDirCache = new LruMap<string, ClaudeDirCacheEntry>(128);
const claudeFileMetaCache = new LruMap<string, ClaudeFileMetaCacheEntry>(128);
const codexDirCache = new LruMap<string, CodexDirCacheEntry>(128);
const codexFileMetaCache = new LruMap<string, CodexFileMetaCacheEntry>(128);
const textFileCache = new LruMap<string, TextFileCacheEntry>(64);

function statFileMeta(filePath: string): FileStatMeta | null {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

function statMtimeMs(filePath: string): number | null {
  return statFileMeta(filePath)?.mtimeMs ?? null;
}

function readCachedTextFile(filePath: string): string | null {
  const st = statFileMeta(filePath);
  if (!st) {
    textFileCache.delete(filePath);
    return null;
  }
  const cached = textFileCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.text;
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    textFileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    return null;
  }
}

export function readJsonlHeadLine(filePath: string, maxBytes = 8192): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const readSize = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(readSize);
      const bytesRead = fs.readSync(fd, buf, 0, readSize, 0);
      if (bytesRead <= 0) return null;
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
      return firstLine || null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readJsonlTailLines(filePath: string, maxBytes = 64 * 1024): string[] {
  const tail = readTailBuffer(filePath, maxBytes);
  if (!tail) return [];
  const lines = tail.buf.toString("utf8").split("\n");
  if (tail.start > 0 && lines.length > 0) lines.shift();
  return lines;
}

export function findClaudeProjectJsonl(cwd: string, sessionId: string | null, home: string): string | null {
  try {
    const resolvedCwd = path.resolve(cwd);
    const cacheKey = `${home}\0${resolvedCwd}\0${sessionId ?? ""}`;
    const now = Date.now();
    const slug = resolvedCwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(home, ".claude", "projects", slug);
    const cached = claudeDirCache.get(cacheKey);
    if (cached && now - cached.checkedAt < EXTERNAL_DIR_SCAN_TTL_MS) {
      if (cached.filePath !== null) {
        if (statFileMeta(cached.filePath)) return cached.filePath;
      } else {
        const dirSt = fs.statSync(projDir, { throwIfNoEntry: false });
        const curDirMtime = dirSt?.isDirectory() ? dirSt.mtimeMs : null;
        if (curDirMtime === cached.dirMtimeMs) return null;
      }
    }

    const dirSt = fs.statSync(projDir, { throwIfNoEntry: false });
    if (!dirSt?.isDirectory()) {
      claudeDirCache.set(cacheKey, { filePath: null, dirMtimeMs: null, checkedAt: now });
      return null;
    }
    if (sessionId && SAFE_CONV_ID_RE.test(sessionId)) {
      const candidate = path.join(projDir, `${sessionId}.jsonl`);
      if (statFileMeta(candidate)) {
        claudeDirCache.set(cacheKey, { filePath: candidate, dirMtimeMs: dirSt.mtimeMs, checkedAt: now });
        return candidate;
      }
    }
    const files = fs
      .readdirSync(projDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const full = path.join(projDir, f);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return { full, mtimeMs: 0 };
        }
      })
      .filter((f) => f.mtimeMs > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const found = files[0]?.full ?? null;
    claudeDirCache.set(cacheKey, { filePath: found, dirMtimeMs: dirSt.mtimeMs, checkedAt: now });
    return found;
  } catch {
    return null;
  }
}

function readClaudeJsonlMetadata(
  cwd: string,
  sessionId: string | null,
  home: string,
): { usage: ContextUsageInfo | null; model: string | null } {
  const targetFile = findClaudeProjectJsonl(cwd, sessionId, home);
  if (!targetFile) return { usage: null, model: null };
  const st = statFileMeta(targetFile);
  if (!st) {
    claudeFileMetaCache.delete(targetFile);
    return { usage: null, model: null };
  }
  const cached = claudeFileMetaCache.get(targetFile);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { usage: cached.usage, model: cached.model };
  }
  const lines = readJsonlTailLines(targetFile);
  let usageInfo: ContextUsageInfo | null = null;
  let modelId: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as any;
      if (!usageInfo) {
        const usage = obj?.message?.usage ?? obj?.usage;
        if (usage && typeof usage === "object") {
          const inTok = Number(usage.input_tokens ?? 0) || 0;
          const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
          const outTok = Number(usage.output_tokens ?? 0) || 0;
          const total = Math.max(0, Math.floor(inTok + cacheCreate + cacheRead + outTok));
          if (total > 0) {
            const pct = Math.min(100, Math.max(0, Math.round((total / CLAUDE_DEFAULT_WINDOW) * 100)));
            usageInfo = { tokens: total, contextWindow: CLAUDE_DEFAULT_WINDOW, percent: pct };
          }
        }
      }
      if (!modelId) {
        const model = obj?.message?.model ?? obj?.model;
        if (typeof model === "string" && model.trim()) {
          modelId = model.trim();
        }
      }
      if (usageInfo && modelId) break;
    } catch {
      /* ignore malformed line */
    }
  }
  claudeFileMetaCache.set(targetFile, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    usage: usageInfo,
    model: modelId,
  });
  return { usage: usageInfo, model: modelId };
}

function readClaudeContextUsage(cwd: string, sessionId: string | null, home: string): ContextUsageInfo | null {
  return readClaudeJsonlMetadata(cwd, sessionId, home).usage;
}

function sortedRecentSubdirs(parent: string, limit: number): string[] {
  try {
    return fs
      .readdirSync(parent)
      .sort()
      .reverse()
      .map((name) => path.join(parent, name))
      .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      .slice(0, limit);
  } catch {
    return [];
  }
}

function collectRecentCodexSessionFiles(home: string): string[] {
  const sessionsRoot = path.join(home, ".codex", "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  const candidates: Array<{ full: string; mtimeMs: number }> = [];
  for (const yDir of sortedRecentSubdirs(sessionsRoot, 2)) {
    for (const mDir of sortedRecentSubdirs(yDir, 2)) {
      for (const dDir of sortedRecentSubdirs(mDir, 3)) {
        for (const f of fs.readdirSync(dDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const full = path.join(dDir, f);
          try {
            candidates.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, 8).map((c) => c.full);
}

function matchesCodexCwd(filePath: string, cwd: string): boolean {
  const firstLine = readJsonlHeadLine(filePath);
  if (!firstLine?.startsWith("{")) return true;
  try {
    const meta = JSON.parse(firstLine) as any;
    if (meta?.type === "session_meta" && meta?.payload?.cwd) {
      return path.resolve(meta.payload.cwd) === path.resolve(cwd);
    }
  } catch {
    /* ignore */
  }
  return true;
}

function readCodexFileUsage(filePath: string): ContextUsageInfo | null {
  const st = statFileMeta(filePath);
  if (!st) {
    codexFileMetaCache.delete(filePath);
    return null;
  }
  const cached = codexFileMetaCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.usage;
  }
  let usage: ContextUsageInfo | null = null;
  const lines = readJsonlTailLines(filePath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as any;
      if (obj?.payload?.type === "token_count" && obj?.payload?.info?.last_token_usage) {
        const total = Math.max(0, Math.floor(Number(obj.payload.info.last_token_usage.total_tokens ?? 0)));
        const win = Math.max(1, Math.floor(Number(obj.payload.info.model_context_window ?? CODEX_DEFAULT_WINDOW)));
        if (total > 0) {
          const pct = Math.min(100, Math.max(0, Math.round((total / win) * 100)));
          usage = { tokens: total, contextWindow: win, percent: pct };
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  codexFileMetaCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, usage });
  return usage;
}

function readCodexContextUsage(cwd: string, sessionId: string | null, home: string): ContextUsageInfo | null {
  try {
    const cacheKey = `${home}\0${cwd ? path.resolve(cwd) : ""}\0${sessionId ?? ""}`;
    const now = Date.now();
    const cachedDir = codexDirCache.get(cacheKey);
    if (cachedDir && now - cachedDir.checkedAt < EXTERNAL_DIR_SCAN_TTL_MS) {
      if (cachedDir.filePath !== null) {
        if (statFileMeta(cachedDir.filePath)) {
          return readCodexFileUsage(cachedDir.filePath);
        }
      } else {
        return null;
      }
    }

    let firstMatchedFile: string | null = null;
    for (const full of collectRecentCodexSessionFiles(home)) {
      if (sessionId && !path.basename(full).includes(sessionId)) continue;
      if (!sessionId && cwd && !matchesCodexCwd(full, cwd)) continue;
      if (!firstMatchedFile) firstMatchedFile = full;
      const usage = readCodexFileUsage(full);
      if (usage) {
        codexDirCache.set(cacheKey, { filePath: full, checkedAt: now });
        return usage;
      }
    }
    codexDirCache.set(cacheKey, { filePath: firstMatchedFile, checkedAt: now });
  } catch {
    /* ignore */
  }
  return null;
}

export function parseTerminalContextUsage(terminalText: string, defaultWindow = CLAUDE_DEFAULT_WINDOW): ContextUsageInfo | null {
  if (!terminalText) return null;
  const slashMatch = /(\d+(?:\.\d+)?)\s*k\s*\/\s*(\d+(?:\.\d+)?)\s*k/i.exec(terminalText);
  if (slashMatch) {
    const tokens = Math.round(Number.parseFloat(slashMatch[1]!) * 1000);
    const window = Math.round(Number.parseFloat(slashMatch[2]!) * 1000);
    if (tokens > 0 && window > 0 && tokens <= window * 2) {
      const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
      return { tokens, contextWindow: window, percent };
    }
  }
  const leftMatch = /(\d{1,3})%\s+context\s+left/i.exec(terminalText);
  if (leftMatch) {
    const leftPct = Number.parseInt(leftMatch[1]!, 10);
    if (leftPct >= 0 && leftPct <= 100) {
      const percent = 100 - leftPct;
      const tokens = Math.round((percent / 100) * defaultWindow);
      return { tokens, contextWindow: defaultWindow, percent };
    }
  }
  const usedMatch = /context(?:\s+used)?[:\s]+(\d{1,3})%/i.exec(terminalText);
  if (usedMatch) {
    const percent = Number.parseInt(usedMatch[1]!, 10);
    if (percent >= 0 && percent <= 100) {
      const tokens = Math.round((percent / 100) * defaultWindow);
      return { tokens, contextWindow: defaultWindow, percent };
    }
  }
  return null;
}

export function readExternalAgentContextUsage(
  agent: string,
  cwd: string,
  sessionId: string | null,
  terminalText = "",
  home = os.homedir(),
): ContextUsageInfo | null {
  if (agent === "claude") {
    return readClaudeContextUsage(cwd, sessionId, home) ?? parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW);
  }
  if (agent === "codex") {
    return readCodexContextUsage(cwd, sessionId, home) ?? parseTerminalContextUsage(terminalText, CODEX_DEFAULT_WINDOW);
  }
  return parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW);
}

function extractAgyModelFromGenMetadataBlob(buf: Buffer): string | null {
  const tail = buf.subarray(Math.max(0, buf.length - 600));
  for (const tagByte of [0xaa, 0x9a]) {
    for (let i = tail.length - 4; i >= 0; i--) {
      if (tail[i] === tagByte && tail[i + 1] === 0x01) {
        const len = tail[i + 2]!;
        if (len >= 3 && len <= 80 && i + 3 + len <= tail.length) {
          const s = tail.subarray(i + 3, i + 3 + len).toString("utf8").trim();
          if (
            /^[A-Za-z0-9][A-Za-z0-9 ._()/-]+$/.test(s) &&
            !/^[0-9a-f-]{32,}$/i.test(s) &&
            s !== "false" &&
            s !== "true"
          ) {
            return s;
          }
        }
      }
    }
  }
  return null;
}

export function readAgySessionModel(
  sessionId: string | null,
  home = os.homedir(),
  options?: ReadAgySessionModelOptions,
): { model: string | null; uncertain: boolean } {
  if (!sessionId || !SAFE_CONV_ID_RE.test(sessionId)) return { model: null, uncertain: false };

  const now = Date.now();
  const cacheKey = `${home}\0${sessionId}`;
  const cached = agyModelCache.get(cacheKey);
  const hasKnownTranscript = options !== undefined && options.knownTranscriptModel !== undefined;
  const knownModel = hasKnownTranscript ? (options.knownTranscriptModel?.trim() || null) : null;

  // Fast path: AgyTranscriptReader already parsed a new MODEL_CHANGE_RE in-memory -> avoid disk & SQLite.
  if (hasKnownTranscript && knownModel && knownModel !== cached?.knownTranscriptModel) {
    const value = { model: knownModel, uncertain: false };
    agyModelCache.set(cacheKey, {
      value,
      dbMtimeMs: cached?.dbMtimeMs ?? null,
      transcriptMtimeMs: cached?.transcriptMtimeMs ?? null,
      knownTranscriptModel: knownModel,
      checkedAt: now,
    });
    return value;
  }

  const dbPath = path.join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);

  // Enforce strict wall-clock throttle even when transcript.jsonl or DB mtime changes during streaming.
  // Only allow an immediate read within the throttle window when forced or when a DB appears for the first time.
  if (cached && !options?.force && now - cached.checkedAt < AGY_MODEL_CACHE_THROTTLE_MS) {
    if (cached.dbMtimeMs !== null) {
      return cached.value;
    }
    const appearedMain = statMtimeMs(dbPath);
    const appearedWal = statMtimeMs(`${dbPath}-wal`);
    if (appearedMain === null && appearedWal === null) {
      return cached.value;
    }
  }

  const mainDbMtime = statMtimeMs(dbPath);
  const walDbMtime = statMtimeMs(`${dbPath}-wal`);
  const dbMtimeMs =
    mainDbMtime !== null && walDbMtime !== null
      ? Math.max(mainDbMtime, walDbMtime)
      : (mainDbMtime ?? walDbMtime);

  // If a known transcript model was accepted and the DB has not been updated since, keep it without re-querying SQLite.
  if (
    hasKnownTranscript &&
    knownModel &&
    cached &&
    !options?.force &&
    cached.knownTranscriptModel === knownModel &&
    cached.dbMtimeMs !== null &&
    cached.dbMtimeMs === dbMtimeMs
  ) {
    agyModelCache.set(cacheKey, { ...cached, checkedAt: now });
    return cached.value;
  }

  let transcriptMtimeMs: number | null = cached?.transcriptMtimeMs ?? null;
  let transcriptChangeModel: string | null = hasKnownTranscript ? knownModel : null;
  let lastUserInputChangeModel: string | null = null;
  if (!hasKnownTranscript) {
    let tPath: string | null = null;
    try {
      tPath = resolveAgyTranscriptPath(sessionId, home);
    } catch {
      tPath = null;
    }
    transcriptMtimeMs = tPath ? statMtimeMs(tPath) : null;
    if (tPath && transcriptMtimeMs !== null) {
      try {
        const lines = readJsonlTailLines(tPath, 256 * 1024);
        let seenLatestUserInput = false;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!.trim();
          if (!line.startsWith("{")) continue;
          try {
            const obj = JSON.parse(line) as any;
            if (obj?.type === "USER_INPUT" && typeof obj?.content === "string") {
              const m = MODEL_CHANGE_RE.exec(obj.content);
              if (m?.[1]?.trim()) {
                const candidate = m[1].trim();
                if (!transcriptChangeModel) transcriptChangeModel = candidate;
                if (!seenLatestUserInput) lastUserInputChangeModel = candidate;
              }
              seenLatestUserInput = true;
              if (transcriptChangeModel) break;
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (lastUserInputChangeModel) {
    const value = { model: lastUserInputChangeModel, uncertain: false };
    agyModelCache.set(cacheKey, {
      value,
      dbMtimeMs,
      transcriptMtimeMs,
      knownTranscriptModel: cached?.knownTranscriptModel ?? null,
      checkedAt: now,
    });
    return value;
  }

  let dbError = false;
  if (mainDbMtime !== null) {
    try {
      const db = new DatabaseSync(dbPath, { open: true, readOnly: true, timeout: AGY_MODEL_DB_TIMEOUT_MS });
      try {
        const row = db.prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1").get() as
          | { data?: Uint8Array | Buffer }
          | undefined;
        if (row?.data) {
          const fromDb = extractAgyModelFromGenMetadataBlob(Buffer.from(row.data));
          if (fromDb) {
            const value = { model: fromDb, uncertain: false };
            agyModelCache.set(cacheKey, {
              value,
              dbMtimeMs,
              transcriptMtimeMs,
              knownTranscriptModel: hasKnownTranscript ? knownModel : (cached?.knownTranscriptModel ?? null),
              checkedAt: now,
            });
            return value;
          }
        }
      } finally {
        db.close();
      }
    } catch {
      dbError = true;
    }
  }

  const fallbackModel = transcriptChangeModel ?? (dbError ? (cached?.value.model ?? null) : null);
  const value = { model: fallbackModel, uncertain: dbError };
  agyModelCache.set(cacheKey, {
    value,
    dbMtimeMs,
    transcriptMtimeMs,
    knownTranscriptModel: hasKnownTranscript ? knownModel : (cached?.knownTranscriptModel ?? null),
    checkedAt: now,
  });
  return value;
}

function readClaudeFallbackModel(home: string): string | null {
  try {
    const text = readCachedTextFile(path.join(home, ".claude", "settings.json"));
    if (text) {
      const parsed = JSON.parse(text) as any;
      if (typeof parsed?.model === "string" && parsed.model.trim()) {
        return parsed.model.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readCodexConfigModel(home: string): string | null {
  try {
    const text = readCachedTextFile(path.join(home, ".codex", "config.toml"));
    if (text) {
      const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text);
      if (m?.[1]?.trim()) return m[1].trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readAgyFallbackModel(home: string): string | null {
  try {
    const text = readCachedTextFile(path.join(home, ".gemini", "antigravity-cli", "settings.json"));
    if (text) {
      const parsed = JSON.parse(text) as any;
      if (typeof parsed?.model === "string" && parsed.model.trim()) {
        return parsed.model.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readExternalAgentMetadata(
  agent: string,
  cwd: string,
  sessionId: string | null,
  terminalText = "",
  home = os.homedir(),
  options?: ReadAgySessionModelOptions,
): ExternalAgentMetadata {
  if (agent === "claude") {
    const { usage: fileUsage, model: fileModel } = readClaudeJsonlMetadata(cwd, sessionId, home);
    const usage = fileUsage ?? parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW);
    const modelId = fileModel ?? readClaudeFallbackModel(home) ?? "claude";
    return { usage, model: { provider: "anthropic", id: modelId }, uncertain: false };
  }
  if (agent === "codex") {
    const usage = readCodexContextUsage(cwd, sessionId, home) ?? parseTerminalContextUsage(terminalText, CODEX_DEFAULT_WINDOW);
    const modelId = readCodexConfigModel(home) ?? "codex";
    return { usage, model: { provider: "openai", id: modelId }, uncertain: false };
  }
  if (agent === "agy") {
    const { model: sessionModel, uncertain } = readAgySessionModel(sessionId, home, options);
    const modelId = sessionModel ?? readAgyFallbackModel(home) ?? "antigravity";
    return {
      usage: parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW),
      model: { provider: "google", id: modelId },
      uncertain: sessionModel ? false : uncertain,
    };
  }
  return {
    usage: parseTerminalContextUsage(terminalText, CLAUDE_DEFAULT_WINDOW),
    model: { provider: agent, id: "default" },
    uncertain: false,
  };
}

export function readExternalAgentModelWithState(
  agent: string,
  cwd: string,
  sessionId: string | null,
  home = os.homedir(),
  options?: ReadAgySessionModelOptions,
): { model: { provider: string; id: string }; uncertain: boolean } {
  if (agent === "agy") {
    const { model: sessionModel, uncertain } = readAgySessionModel(sessionId, home, options);
    if (sessionModel) {
      return { model: { provider: "google", id: sessionModel }, uncertain: false };
    }
    const fallback = readAgyFallbackModel(home);
    return { model: { provider: "google", id: fallback ?? "antigravity" }, uncertain };
  }
  if (agent === "claude") {
    const { model: fileModel } = readClaudeJsonlMetadata(cwd, sessionId, home);
    return { model: { provider: "anthropic", id: fileModel ?? readClaudeFallbackModel(home) ?? "claude" }, uncertain: false };
  }
  if (agent === "codex") {
    return { model: { provider: "openai", id: readCodexConfigModel(home) ?? "codex" }, uncertain: false };
  }
  return { model: { provider: agent, id: "default" }, uncertain: false };
}

export function readExternalAgentModel(
  agent: string,
  cwd: string,
  sessionId: string | null,
  home = os.homedir(),
  options?: ReadAgySessionModelOptions,
): { provider: string; id: string } {
  return readExternalAgentModelWithState(agent, cwd, sessionId, home, options).model;
}
