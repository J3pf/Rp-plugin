import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { truncateBytes, sanitizeFileName, backoffDelay, jitter, LruSet, preview } from "../src/shared/util.ts";
import { configDir, configPath, defaultInboxDir, hostConfigPath, expandHome } from "../src/shared/platform.ts";
import { envelope, parseEnvelope } from "../src/shared/protocol.ts";
import { normalizeConfig, saveConfig, loadConfig, updateConfigFile, DEFAULT_CONFIG } from "../src/extension/config.ts";
import { detectStaticEnv, parseGentleMode, isAskLikeTool } from "../src/extension/environment.ts";
import { detectActiveTheme, gentleVersionSupported, parseVersion } from "../src/extension/compat.ts";

describe("util", () => {
  it("truncates by UTF-8 bytes without splitting code points", () => {
    const s = "a".repeat(10) + "ñ".repeat(10);
    const t = truncateBytes(s, 11);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(11);
    expect(t.text.includes("\ufffd")).toBe(false);
    expect(truncateBytes("hola", 100)).toEqual({ text: "hola", truncated: false });
  });
  it("sanitizes file names (traversal, control chars, reserved names)", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\win.ini")).toBe("win.ini");
    expect(sanitizeFileName("a:b*c?.txt")).toBe("a_b_c_.txt");
    expect(sanitizeFileName("   ")).toBe("file");
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName(".hidden")).toBe("_hidden");
    expect(sanitizeFileName(`${"x".repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
  });
  it("backoff grows 1s→30s with ±20% jitter", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(20, () => 0.5)).toBe(30000);
    expect(jitter(1000, 0.2, () => 0)).toBe(800);
    expect(jitter(1000, 0.2, () => 1)).toBe(1200);
  });
  it("LruSet keeps the most recent N", () => {
    const s = new LruSet(3);
    for (const k of ["a", "b", "c", "d"]) s.add(k);
    expect(s.has("a")).toBe(false);
    expect(s.has("d")).toBe(true);
    s.add("b");
    s.add("e");
    expect(s.has("c")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.size).toBe(3);
  });
  it("preview flattens and clips", () => {
    expect(preview("a\n b   c", 140)).toBe("a b c");
    expect(preview("x".repeat(200), 10).length).toBe(10);
  });
});

describe("platform paths", () => {
  it("linux uses XDG_CONFIG_HOME or ~/.config", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/rp");
    expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/rp");
    expect(configPath({}, "linux", "/home/u")).toBe("/home/u/.config/rp/config.json");
    expect(defaultInboxDir({}, "linux", "/home/u")).toBe("/home/u/.config/rp/inbox");
    expect(hostConfigPath({}, "linux", "/home/u")).toBe("/home/u/.config/rp/host.json");
  });
  it("windows uses %APPDATA% and %LOCALAPPDATA%", () => {
    const env = { APPDATA: "C:\\Users\\j\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local" };
    expect(configPath(env, "win32", "C:\\Users\\j")).toBe("C:\\Users\\j\\AppData\\Roaming\\rp\\config.json");
    expect(defaultInboxDir(env, "win32", "C:\\Users\\j")).toBe("C:\\Users\\j\\AppData\\Local\\rp\\inbox");
  });
  it("RP_CONFIG overrides and ~ expands", () => {
    expect(configPath({ RP_CONFIG: "/tmp/c.json" }, "linux", "/h")).toBe("/tmp/c.json");
    expect(expandHome("~/p", "/home/u")).toBe(path.join("/home/u", "p"));
  });
});

describe("protocol envelope", () => {
  it("builds and parses", () => {
    const e = envelope("agent.event", { a: 1 }, { id: "X", re: "Y" });
    expect(e).toMatchObject({ v: 1, t: "agent.event", id: "X", re: "Y", d: { a: 1 } });
    expect(parseEnvelope(JSON.stringify(e))?.t).toBe("agent.event");
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope('{"t":1}')).toBeNull();
    expect(parseEnvelope('{"v":1}')).toBeNull();
  });
});

describe("config", () => {
  it("normalizes with defaults and rejects bad values", () => {
    const c = normalizeConfig({ gate: { mode: "bogus", alwaysAllowTools: [1] }, delivery: { method: "x" }, subagents: "connect", enabled: "yes" });
    expect(c.gate.mode).toBe("auto-detect");
    expect(c.gate.alwaysAllowTools).toEqual(DEFAULT_CONFIG.gate.alwaysAllowTools);
    expect(c.delivery.method).toBe("auto");
    expect(c.subagents).toBe("connect");
    expect(c.enabled).toBe(true);
    expect(normalizeConfig(null).relayUrl).toBeNull();
  });
  it("saves with 0600, applies env overrides on load, persists without them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpcfg-"));
    const p = path.join(dir, "sub", "config.json");
    saveConfig(p, { ...DEFAULT_CONFIG, relayUrl: "https://r", machineToken: "t" });
    if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    const l = loadConfig({ RP_CONFIG: p, RP_RELAY_URL: "https://override", RP_DISABLED: "1" });
    expect(l.cfg.relayUrl).toBe("https://override");
    expect(l.cfg.enabled).toBe(false);
    updateConfigFile(p, (c) => {
      c.redactContent = true;
    });
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.relayUrl).toBe("https://r");
    expect(raw.enabled).toBe(true);
    expect(raw.redactContent).toBe(true);
  });
  it("missing or corrupt file yields defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpcfg-"));
    const p = path.join(dir, "c.json");
    expect(loadConfig({ RP_CONFIG: p }).cfg.machineToken).toBeNull();
    fs.writeFileSync(p, "{oops");
    expect(loadConfig({ RP_CONFIG: p }).cfg.enabled).toBe(true);
  });
});

describe("environment detection", () => {
  it("detects gentle child, launcher, herdr, spawn id", () => {
    const e = detectStaticEnv({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_SHELL_USER_PI_HOME: "/h/.pi/agent", HERDR_ENV: "1", HERDR_PANE_ID: "p3", HERDR_TAB_ID: "t1", HERDR_WORKSPACE_ID: "w2", RP_SPAWN_ID: "SP" }, "linux");
    expect(e).toMatchObject({ isGentleChild: true, launcher: "gentle-shell", spawnId: "SP", herdr: { paneId: "p3", tabId: "t1", workspaceId: "w2", session: null } });
  });
  it("plain pi", () => {
    const e = detectStaticEnv({}, "win32");
    expect(e).toMatchObject({ isGentleChild: false, launcher: "pi", herdr: null, spawnId: null, platform: "win32" });
  });
  it("launcher from PI_CODING_AGENT_DIR", () => {
    expect(detectStaticEnv({ PI_CODING_AGENT_DIR: "/home/u/.gentle-shell/agent" }).launcher).toBe("gentle-shell");
    expect(detectStaticEnv({ PI_CODING_AGENT_DIR: "C:\\Users\\u\\.gentle-shell\\agent" }).launcher).toBe("gentle-shell");
    expect(detectStaticEnv({ PI_CODING_AGENT_DIR: "/home/u/.pi/agent" }).launcher).toBe("pi");
  });
  it("herdr needs both HERDR_ENV and pane id", () => {
    expect(detectStaticEnv({ HERDR_ENV: "1" }).herdr).toBeNull();
    expect(detectStaticEnv({ HERDR_PANE_ID: "p" }).herdr).toBeNull();
  });
  it("parses gentle mode statuses", () => {
    expect(parseGentleMode("Permissions: AUTO")).toBe("auto");
    expect(parseGentleMode("Permissions: NORMAL")).toBe("normal");
    expect(parseGentleMode("Permissions: YOLO")).toBe("yolo");
    expect(parseGentleMode("whatever")).toBe("unknown");
    expect(parseGentleMode(undefined)).toBe("unknown");
  });
  it("ask-like tool names", () => {
    expect(isAskLikeTool("ask_user_choice")).toBe(true);
    expect(isAskLikeTool("question")).toBe(true);
    expect(isAskLikeTool("rp_ask_user")).toBe(false);
    expect(isAskLikeTool("bash")).toBe(false);
  });
});

describe("gentle version range", () => {
  it("accepts 4.x only", () => {
    expect(parseVersion("4.1.0")).toEqual([4, 1, 0]);
    expect(gentleVersionSupported("4.0.0")).toBe(true);
    expect(gentleVersionSupported("4.9.3")).toBe(true);
    expect(gentleVersionSupported("3.9.9")).toBe(false);
    expect(gentleVersionSupported("5.0.0")).toBe(false);
    expect(gentleVersionSupported(null)).toBe(false);
    expect(gentleVersionSupported("nonsense")).toBe(false);
  });
});

describe("detectActiveTheme", () => {
  it("prefers --use-theme from argv", () => {
    expect(detectActiveTheme({ argv: ["node", "pi", "--use-theme", "Gentleman-Cute"] })).toBe("Gentleman-Cute");
    expect(detectActiveTheme({ argv: ["node", "pi", "--use-theme", "  dark  "] })).toBe("dark");
  });

  it("prefers PI_THEME when --use-theme is absent", () => {
    expect(detectActiveTheme({ argv: [], env: { PI_THEME: "omarchy-system" } })).toBe("omarchy-system");
  });

  it("reads theme from candidate settings.json files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-theme-test-"));
    try {
      const piAgent = path.join(tmp, ".pi", "agent");
      fs.mkdirSync(piAgent, { recursive: true });
      fs.writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ theme: "Gentleman-Sexy" }));
      expect(detectActiveTheme({ argv: [], env: {}, home: tmp })).toBe("Gentleman-Sexy");

      // PI_CODING_AGENT_DIR takes precedence over ~/.pi/agent
      const customDir = path.join(tmp, "custom-agent");
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, "settings.json"), JSON.stringify({ theme: "Gentleman-Cute" }));
      expect(detectActiveTheme({ argv: [], env: { PI_CODING_AGENT_DIR: customDir }, home: tmp })).toBe("Gentleman-Cute");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when no theme is configured", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-theme-none-"));
    try {
      expect(detectActiveTheme({ argv: [], env: {}, home: tmp })).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

