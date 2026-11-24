// External agent metadata scrapers (context usage & active model detection) for Claude, Codex, and Antigravity CLI (agy).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveAgyTranscriptPath, type ContextUsageInfo } from "../agy-transcript.ts";
import { LruMap, SAFE_CONV_ID_RE } from "../../shared/util.ts";

const CLAUDE_DEFAULT_WINDOW = 200_000;
const CODEX_DEFAULT_WINDOW = 258_400;
const AGY_MODEL_CACHE_THROTTLE_MS = 10_000;
const AGY_MODEL_DB_TIMEOUT_MS = 25;

export const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to ([^\n<]+?)\.(?:\s|$)/i;

interface AgyModelCacheEntry {
  value: { model: string | null; uncertain: boolean };
  dbMtimeMs: number | null;
  transcriptMtimeMs: number | null;
  checkedAt: number;
}

const agyModelCache = new LruMap<string, AgyModelCacheEntry>(256);

function statMtimeMs(filePath: string): number | null {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.mtimeMs : null;
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
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return [];
    const readSize = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      const lines = buf.toString("utf8").split("\n");
      if (readSize < stat.size && lines.length > 0) lines.shift();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function findClaudeProjectJsonl(cwd: string, sessionId: string | null, home: string): string | null {
  try {
    const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(home, ".claude", "projects", slug);
    if (!fs.existsSync(projDir)) return null;
    if (sessionId && SAFE_CONV_ID_RE.test(sessionId)) {
      const candidate = path.join(projDir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
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
    return files[0]?.full ?? null;
  } catch {
    return null;
  }
}

function readClaudeContextUsage(cwd: string, sessionId: string | null, home: string): ContextUsageInfo | null {
  const targetFile = findClaudeProjectJsonl(cwd, sessionId, home);
  if (!targetFile) return null;
  const lines = readJsonlTailLines(targetFile);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as any;
      const usage = obj?.message?.usage ?? obj?.usage;
      if (!usage || typeof usage !== "object") continue;
      const inTok = Number(usage.input_tokens ?? 0) || 0;
      const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
      const outTok = Number(usage.output_tokens ?? 0) || 0;
      const total = Math.max(0, Math.floor(inTok + cacheCreate + cacheRead + outTok));
      if (total > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((total / CLAUDE_DEFAULT_WINDOW) * 100)));
        return { tokens: total, contextWindow: CLAUDE_DEFAULT_WINDOW, percent: pct };
      }
    } catch {
      /* ignore malformed line */
    }
  }
  return null;
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

function readCodexContextUsage(cwd: string, sessionId: string | null, home: string): ContextUsageInfo | null {
  try {
    for (const full of collectRecentCodexSessionFiles(home)) {
      if (sessionId && !path.basename(full).includes(sessionId)) continue;
      if (!sessionId && cwd && !matchesCodexCwd(full, cwd)) continue;
      const lines = readJsonlTailLines(full);
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
              return { tokens: total, contextWindow: win, percent: pct };
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
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

export function readAgySessionModel(sessionId: string | null, home = os.homedir()): { model: string | null; uncertain: boolean } {
  if (!sessionId || !SAFE_CONV_ID_RE.test(sessionId)) return { model: null, uncertain: false };

  let tPath: string | null = null;
  try {
    tPath = resolveAgyTranscriptPath(sessionId, home);
  } catch {
    tPath = null;
  }
  const dbPath = path.join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
  const transcriptMtimeMs = tPath ? statMtimeMs(tPath) : null;
  const mainDbMtime = statMtimeMs(dbPath);
  const walDbMtime = statMtimeMs(`${dbPath}-wal`);
  const dbMtimeMs =
    mainDbMtime !== null && walDbMtime !== null
      ? Math.max(mainDbMtime, walDbMtime)
      : (mainDbMtime ?? walDbMtime);

  const now = Date.now();
  const cacheKey = `${home}\0${sessionId}`;
  const cached = agyModelCache.get(cacheKey);
  if (cached) {
    const mtimeChanged =
      cached.dbMtimeMs !== dbMtimeMs || cached.transcriptMtimeMs !== transcriptMtimeMs;
    if (!mtimeChanged && now - cached.checkedAt < AGY_MODEL_CACHE_THROTTLE_MS) {
      return cached.value;
    }
  }

  let transcriptChangeModel: string | null = null;
  let lastUserInputChangeModel: string | null = null;
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
  if (lastUserInputChangeModel) {
    const value = { model: lastUserInputChangeModel, uncertain: false };
    agyModelCache.set(cacheKey, { value, dbMtimeMs, transcriptMtimeMs, checkedAt: now });
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
            agyModelCache.set(cacheKey, { value, dbMtimeMs, transcriptMtimeMs, checkedAt: now });
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
  agyModelCache.set(cacheKey, { value, dbMtimeMs, transcriptMtimeMs, checkedAt: now });
  return value;
}

export function readExternalAgentModelWithState(
  agent: string,
  cwd: string,
  sessionId: string | null,
  home = os.homedir(),
): { model: { provider: string; id: string }; uncertain: boolean } {
  if (agent === "agy") {
    const { model: sessionModel, uncertain } = readAgySessionModel(sessionId, home);
    if (sessionModel) {
      return { model: { provider: "google", id: sessionModel }, uncertain: false };
    }
    try {
      const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
      if (fs.existsSync(settingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as any;
        if (typeof parsed?.model === "string" && parsed.model.trim()) {
          return { model: { provider: "google", id: parsed.model.trim() }, uncertain };
        }
      }
    } catch {
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
          const line = lines[i]!.trim();
          if (!line.startsWith("{")) continue;
          try {
            const obj = JSON.parse(line) as any;
            const model = obj?.message?.model ?? obj?.model;
            if (typeof model === "string" && model.trim()) {
              return { model: { provider: "anthropic", id: model.trim() }, uncertain: false };
            }
          } catch {
            /* ignore */
          }
        }
      }
      const claudeSettings = path.join(home, ".claude", "settings.json");
      if (fs.existsSync(claudeSettings)) {
        const parsed = JSON.parse(fs.readFileSync(claudeSettings, "utf8")) as any;
        if (typeof parsed?.model === "string" && parsed.model.trim()) {
          return { model: { provider: "anthropic", id: parsed.model.trim() }, uncertain: false };
        }
      }
    } catch {
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
    } catch {
      /* ignore */
    }
    return { model: { provider: "openai", id: "codex" }, uncertain: false };
  }
  return { model: { provider: agent, id: "default" }, uncertain: false };
}

export function readExternalAgentModel(
  agent: string,
  cwd: string,
  sessionId: string | null,
  home = os.homedir(),
): { provider: string; id: string } {
  return readExternalAgentModelWithState(agent, cwd, sessionId, home).model;
}
