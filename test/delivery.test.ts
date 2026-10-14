import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { methodChain, Deliverer } from "../src/extension/delivery/index.ts";
import { deliverApi } from "../src/extension/delivery/api.ts";
import { deliverHerdr } from "../src/extension/delivery/herdr.ts";
import { deliverInteractive, editorAcceptsText, normalizeText, BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "../src/extension/delivery/interactive.ts";
import { resolveAttachments, formatSize, sessionDirName } from "../src/extension/attachments.ts";
import { sha256 } from "../src/shared/util.ts";
import { baseConfig, makeCtx, makePi } from "./helpers.ts";

const chainOpts = { gentleAuto: false, interactiveEnabled: true, hasHerdr: false, isTui: true, asCommand: false };

describe("methodChain", () => {
  it("auto without gentle AUTO → api only", () => {
    expect(methodChain("auto", "auto", chainOpts)).toEqual(["api"]);
  });
  it("auto with gentle AUTO → interactive → herdr → api", () => {
    expect(methodChain("auto", "auto", { ...chainOpts, gentleAuto: true, hasHerdr: true })).toEqual(["interactive", "herdr", "api"]);
    expect(methodChain(undefined, "auto", { ...chainOpts, gentleAuto: true })).toEqual(["interactive", "api"]);
  });
  it("interactive disabled or non-tui skips it", () => {
    expect(methodChain("auto", "auto", { ...chainOpts, gentleAuto: true, interactiveEnabled: false, hasHerdr: true })).toEqual(["herdr", "api"]);
    expect(methodChain("auto", "auto", { ...chainOpts, gentleAuto: true, isTui: false })).toEqual(["api"]);
  });
  it("explicit methods keep a fallback chain; commands always use api", () => {
    expect(methodChain("interactive", "auto", { ...chainOpts, hasHerdr: true })).toEqual(["interactive", "herdr", "api"]);
    expect(methodChain("herdr", "auto", chainOpts)).toEqual(["api"]);
    expect(methodChain("api", "auto", { ...chainOpts, gentleAuto: true })).toEqual(["api"]);
    expect(methodChain("auto", "api", { ...chainOpts, gentleAuto: true })).toEqual(["api"]);
    expect(methodChain("interactive", "auto", { ...chainOpts, asCommand: true })).toEqual(["api"]);
  });
});

describe("deliverApi", () => {
  it("idle → plain send; busy → deliverAs; images become content blocks; commands expand templates", () => {
    const { pi, sent } = makePi();
    expect(deliverApi(pi, { text: "hi", images: [], delivery: "auto", asCommand: false, idle: true })).toEqual({ disposition: "sent" });
    expect(sent[0]).toEqual({ content: "hi", opts: undefined });
    expect(deliverApi(pi, { text: "hi", images: [], delivery: "auto", asCommand: false, idle: false }).disposition).toBe("queued_followup");
    expect(sent[1].opts).toEqual({ deliverAs: "followUp" });
    expect(deliverApi(pi, { text: "hi", images: [], delivery: "steer", asCommand: false, idle: false }).disposition).toBe("queued_steer");
    deliverApi(pi, { text: "look", images: [{ type: "image", data: "AA", mimeType: "image/png" }], delivery: "auto", asCommand: false, idle: true });
    expect(sent[3].content).toEqual([{ type: "text", text: "look" }, { type: "image", data: "AA", mimeType: "image/png" }]);
    expect(deliverApi(pi, { text: "/gentle:mode normal", images: [], delivery: "auto", asCommand: true, idle: true })).toEqual({ disposition: "command" });
    expect(sent[4]).toEqual({ content: "/gentle:mode normal", opts: { expandPromptTemplates: true } });
    deliverApi(pi, { text: "/x", images: [], delivery: "auto", asCommand: true, idle: false });
    expect(sent[5].opts).toEqual({ deliverAs: "followUp", expandPromptTemplates: true });
  });
});

describe("deliverHerdr", () => {
  it("runs `herdr agent prompt <pane> <text>` without a shell; maps errors", async () => {
    const { pi } = makePi();
    expect(await deliverHerdr(pi, "p3", "hola; rm -rf /")).toEqual({ ok: true });
    expect(pi.exec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "p3", "hola; rm -rf /"], expect.any(Object));
    pi.exec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "error: agent_blocked", killed: false });
    expect(await deliverHerdr(pi, "p3", "x")).toEqual({ ok: false, error: "agent_blocked" });
    pi.exec.mockResolvedValueOnce({ code: 2, stdout: "", stderr: "boom", killed: false });
    expect(await deliverHerdr(pi, "p3", "x")).toEqual({ ok: false, error: "herdr_unavailable" });
    pi.exec.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await deliverHerdr(pi, "p3", "x")).toEqual({ ok: false, error: "herdr_unavailable" });
    expect(await deliverHerdr(pi, null, "x")).toEqual({ ok: false, error: "herdr_unavailable" });
  });
});

describe("deliverInteractive", () => {
  function mk(over: any = {}) {
    const ctx = makeCtx({ mode: "tui" });
    const emitted: string[] = [];
    let editor = over.draft ?? "";
    ctx.ui.getEditorText = vi.fn(() => editor);
    ctx.ui.setEditorText = vi.fn((t: string) => (editor = t));
    const deps = {
      ctx: () => ctx,
      stdin: () => ({ emit: (_e: string, d: string) => (emitted.push(d), true) }),
      dialogOpen: () => false,
      waitNoDialog: async () => true,
      waitSettled: async () => {},
      expectInput: vi.fn(async () => true),
      statuses: () => ({}),
      enabled: () => true,
      confirmMs: 50,
      ...over.deps,
    };
    return { ctx, emitted, deps, editor: () => editor };
  }
  it("types the text as a bracketed paste + Enter, confirmed by the input event, and restores the draft", async () => {
    const m = mk({ draft: "my draft" });
    const r = await deliverInteractive(m.deps, "haz esto\nlinea 2", "auto");
    expect(r).toEqual({ ok: true, afterDialog: false });
    expect(m.emitted).toEqual([BRACKETED_PASTE_START + "haz esto\nlinea 2" + BRACKETED_PASTE_END, "\r"]);
    expect(m.editor()).toBe("my draft");
    expect(m.ctx.ui.setEditorText).toHaveBeenNthCalledWith(1, "");
  });
  it("no confirmation within the window → reverts the editor and reports interactive_unavailable", async () => {
    const m = mk({ draft: "keep", deps: { expectInput: async () => false } });
    const r = await deliverInteractive(m.deps, "x", "auto");
    expect(r).toMatchObject({ ok: false, error: "interactive_unavailable" });
    expect(m.editor()).toBe("keep");
  });
  it("waits for an open dialog and says so; gives up if it never closes", async () => {
    const waited = vi.fn(async () => true);
    const m = mk({ deps: { dialogOpen: () => true, waitNoDialog: waited } });
    expect(await deliverInteractive(m.deps, "x", "auto")).toEqual({ ok: true, afterDialog: true });
    expect(waited).toHaveBeenCalled();
    const m2 = mk({ deps: { dialogOpen: () => true, waitNoDialog: async () => false } });
    expect(await deliverInteractive(m2.deps, "x", "auto")).toMatchObject({ ok: false });
    expect(m2.emitted).toHaveLength(0);
  });
  it("follow-up while working waits for agent_settled; steer types immediately", async () => {
    const settled = vi.fn(async () => {});
    const m = mk({ deps: { waitSettled: settled } });
    m.ctx.setIdle(false);
    await deliverInteractive(m.deps, "x", "followUp");
    expect(settled).toHaveBeenCalledTimes(1);
    await deliverInteractive(m.deps, "y", "steer");
    expect(settled).toHaveBeenCalledTimes(1);
  });
  it("refuses outside the TUI, when disabled, or without stdin", async () => {
    const m = mk();
    m.ctx.mode = "rpc";
    expect(await deliverInteractive(m.deps, "x", "auto")).toMatchObject({ ok: false });
    const m2 = mk({ deps: { enabled: () => false } });
    expect(await deliverInteractive(m2.deps, "x", "auto")).toMatchObject({ ok: false });
    const m3 = mk({ deps: { stdin: () => null } });
    expect(await deliverInteractive(m3.deps, "x", "auto")).toMatchObject({ ok: false });
  });
  it("Vim safeguard: not in insert mode → does not type", async () => {
    const m = mk({ deps: { statuses: () => ({ "gentle:vim": "-- NORMAL --" }) } });
    const r = await deliverInteractive(m.deps, "dd", "auto");
    expect(r).toMatchObject({ ok: false, error: "interactive_unavailable" });
    expect(m.emitted).toHaveLength(0);
    expect(editorAcceptsText(m.ctx, { vim: "-- INSERT --" }).ok).toBe(true);
    expect(editorAcceptsText(m.ctx, {}).ok).toBe(true);
  });
  it("normalizeText ignores CRLF and surrounding whitespace", () => {
    expect(normalizeText("a\r\nb \n")).toBe("a\nb");
  });
});

describe("Deliverer", () => {
  function mk(over: { cfg?: any; gentle?: string | null; herdr?: any; interactive?: any; idle?: boolean; fetchBlob?: any } = {}) {
    const { pi, sent, entries } = makePi();
    const ctx = makeCtx({ idle: over.idle ?? true });
    const acks: any[] = [];
    const notes: string[] = [];
    const d = new Deliverer({
      pi,
      ctx: () => ctx,
      cfg: () => over.cfg ?? baseConfig("http://x"),
      herdr: over.herdr ?? null,
      gentleMode: () => over.gentle ?? null,
      fetchBlob: over.fetchBlob ?? null,
      inboxDir: () => os.tmpdir(),
      sessionId: () => "s1",
      interactive: () => over.interactive ?? ({} as any),
      sendAck: (a) => acks.push(a),
      notify: (m) => notes.push(m),
    });
    return { d, pi, sent, entries, acks, notes, ctx };
  }
  it("api delivery acks 'sent' and records the origin entry", async () => {
    const m = mk();
    await m.d.handle({ clientMsgId: "c1", deviceId: "dev", text: "hola" });
    expect(m.sent[0].content).toBe("hola");
    expect(m.acks).toEqual([{ clientMsgId: "c1", disposition: "sent", method: "api", error: null }]);
    expect(m.entries[0]).toMatchObject({ customType: "rp.origin", data: { clientMsgId: "c1", deviceId: "dev", method: "api" } });
  });
  it("idempotent on clientMsgId (last 500)", async () => {
    const m = mk();
    await m.d.handle({ clientMsgId: "c1", text: "a" });
    await m.d.handle({ clientMsgId: "c1", text: "a" });
    expect(m.sent).toHaveLength(1);
    expect(m.acks[1]).toMatchObject({ clientMsgId: "c1", disposition: "duplicate" });
    for (let i = 0; i < 600; i++) await m.d.handle({ clientMsgId: "n" + i, text: "x" });
    await m.d.handle({ clientMsgId: "c1", text: "a" }); // evicted → delivered again
    expect(m.sent.length).toBe(1 + 600 + 1);
  });
  it("busy agent: queued_followup / queued_steer", async () => {
    const m = mk({ idle: false });
    await m.d.handle({ clientMsgId: "a", text: "x", delivery: "steer" });
    await m.d.handle({ clientMsgId: "b", text: "y" });
    expect(m.acks.map((a) => a.disposition)).toEqual(["queued_steer", "queued_followup"]);
  });
  it("gentle AUTO: uses interactive (typed) and warns when it has to fall back to api", async () => {
    const m = mk({ gentle: "auto", interactive: { ctx: () => makeCtx({ mode: "tui" }), enabled: () => true, stdin: () => ({ emit: () => true }), dialogOpen: () => false, waitNoDialog: async () => true, waitSettled: async () => {}, expectInput: async () => true, statuses: () => ({}) } });
    await m.d.handle({ clientMsgId: "t1", text: "go" });
    expect(m.acks[0]).toEqual({ clientMsgId: "t1", disposition: "typed", method: "interactive", error: null });
    expect(m.sent).toHaveLength(0);
    const m2 = mk({ gentle: "auto", interactive: { ctx: () => makeCtx({ mode: "tui" }), enabled: () => true, stdin: () => ({ emit: () => true }), dialogOpen: () => false, waitNoDialog: async () => true, waitSettled: async () => {}, expectInput: async () => false, statuses: () => ({}), confirmMs: 10 } });
    await m2.d.handle({ clientMsgId: "t2", text: "go" });
    expect(m2.acks[0]).toMatchObject({ disposition: "sent", method: "api" });
    expect(m2.notes.join()).toMatch(/modo Auto/);
  });
  it("gentle-pi present but mode not published yet → still types (it may be AUTO)", async () => {
    const typed: string[] = [];
    const { pi, sent } = makePi();
    const ctx = makeCtx({ mode: "tui" });
    const acks: any[] = [];
    const d = new Deliverer({
      pi, ctx: () => ctx, cfg: () => baseConfig("http://x"), herdr: null, gentleMode: () => null, gentlePresent: () => true,
      fetchBlob: null, inboxDir: () => os.tmpdir(), sessionId: () => "s", sendAck: (a) => acks.push(a), notify: () => {},
      interactive: () => ({ ctx: () => ctx, enabled: () => true, stdin: () => ({ emit: (_e: string, x: string) => (typed.push(x), true) }), dialogOpen: () => false, waitNoDialog: async () => true, waitSettled: async () => {}, expectInput: async () => true, statuses: () => ({}) }) as any,
    });
    await d.handle({ clientMsgId: "u1", text: "go" });
    expect(acks[0]).toMatchObject({ disposition: "typed", method: "interactive" });
    expect(sent).toHaveLength(0);
    acks.length = 0;
    const d2 = new Deliverer({ ...(d as any).d, gentleMode: () => "normal" });
    await d2.handle({ clientMsgId: "u2", text: "go" });
    expect(acks[0]).toMatchObject({ disposition: "sent", method: "api" }); // known NORMAL → plain API
  });
  it("typed_after_dialog when a dialog was open", async () => {
    const m = mk({ gentle: "auto", interactive: { ctx: () => makeCtx({ mode: "tui" }), enabled: () => true, stdin: () => ({ emit: () => true }), dialogOpen: () => true, waitNoDialog: async () => true, waitSettled: async () => {}, expectInput: async () => true, statuses: () => ({}) } });
    await m.d.handle({ clientMsgId: "t3", text: "go" });
    expect(m.acks[0].disposition).toBe("typed_after_dialog");
  });
  it("herdr: agent_blocked is reported, not silently re-routed", async () => {
    const m = mk({ herdr: { paneId: "p3" } });
    m.pi.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "agent_blocked", killed: false });
    await m.d.handle({ clientMsgId: "h1", text: "x", method: "herdr" });
    expect(m.acks[0]).toEqual({ clientMsgId: "h1", disposition: "rejected", method: "herdr", error: "agent_blocked" });
    expect(m.sent).toHaveLength(0);
  });
  it("herdr unavailable falls back to api", async () => {
    const m = mk({ herdr: { paneId: "p3" } });
    m.pi.exec.mockRejectedValue(new Error("nope"));
    await m.d.handle({ clientMsgId: "h2", text: "x", method: "herdr" });
    expect(m.acks[0]).toMatchObject({ disposition: "sent", method: "api" });
  });
  it("asCommand → sendUserMessage with template expansion", async () => {
    const m = mk({ gentle: "auto" });
    await m.d.handle({ clientMsgId: "k1", text: "/gentle:mode normal", asCommand: true });
    expect(m.sent[0]).toEqual({ content: "/gentle:mode normal", opts: { expandPromptTemplates: true } });
    expect(m.acks[0]).toMatchObject({ disposition: "command", method: "api" });
  });
  it("intercepts /quit or /exit and calls ctx.shutdown()", async () => {
    const m = mk({ gentle: "auto" });
    await m.d.handle({ clientMsgId: "q1", text: "/quit" });
    expect(m.sent).toHaveLength(0);
    expect(m.acks[0]).toMatchObject({ clientMsgId: "q1", disposition: "command", method: "api" });
    expect(m.ctx.shutdown).toHaveBeenCalledTimes(1);

    await m.d.handle({ clientMsgId: "q2", text: "  /exit  " });
    expect(m.sent).toHaveLength(0);
    expect(m.acks[1]).toMatchObject({ clientMsgId: "q2", disposition: "command", method: "api" });
    expect(m.ctx.shutdown).toHaveBeenCalledTimes(2);
  });
  it("deliveries are serialized in arrival order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mk({ gentle: "auto", interactive: { ctx: () => makeCtx({ mode: "tui" }), enabled: () => true, stdin: () => ({ emit: () => true }), dialogOpen: () => false, waitNoDialog: async () => true, waitSettled: async () => {}, expectInput: async (t: string) => { order.push("start:" + t); await gate; order.push("end:" + t); return true; }, statuses: () => ({}) } });
    const p1 = m.d.handle({ clientMsgId: "o1", text: "one" });
    const p2 = m.d.handle({ clientMsgId: "o2", text: "two" });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:one"]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });
  it("images are inlined only for api; interactive cites files by path", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const fetchBlob = vi.fn(async () => ({ status: 200, body: png, headers: {} }));
    const m = mk({ fetchBlob });
    await m.d.handle({ clientMsgId: "i1", text: "look", attachments: [{ blobId: "B1", name: "a.png", mime: "image/png", size: png.length }] });
    expect(m.sent[0].content).toEqual([{ type: "text", text: "look" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  });
});

describe("attachments", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rpinbox-"));
  const fetchOf = (body: Buffer, status = 200, headers: any = {}) => async () => ({ status, body, headers });
  it("saves non-image files in <inbox>/<session>/<ts>-<name> and cites the path", async () => {
    const inbox = dir();
    const body = Buffer.from("%PDF-1.4 hello");
    const r = await resolveAttachments([{ blobId: "B", name: "informe final.pdf", mime: "application/pdf", size: body.length }], {
      fetchBlob: fetchOf(body),
      inboxDir: inbox,
      sessionId: "sess-1",
      inlineImages: true,
      now: new Date(2026, 9, 13, 5, 6, 7),
    });
    expect(r.failures).toEqual([]);
    const file = path.join(inbox, "sess-1", "20261013-050607-informe final.pdf");
    expect(fs.readFileSync(file)).toEqual(body);
    expect(r.lines).toEqual([`[Archivo adjunto desde el móvil: ${file} (application/pdf, ${formatSize(body.length)})]`]);
  });
  it("neutralizes path traversal in names and session ids", async () => {
    const inbox = dir();
    const body = Buffer.from("x");
    const r = await resolveAttachments([{ blobId: "B", name: "../../../etc/cron.d/evil", mime: "text/plain", size: 1 }], { fetchBlob: fetchOf(body), inboxDir: inbox, sessionId: "../../x", inlineImages: false });
    const m = /: (.+) \(text\/plain/.exec(r.lines[0]!)!;
    expect(path.resolve(m[1]!).startsWith(path.resolve(inbox) + path.sep)).toBe(true);
    expect(sessionDirName("../../x")).not.toContain("/");
  });
  it("verifies size and sha256 (from the ref or response headers) and reports failures without throwing", async () => {
    const body = Buffer.from("data");
    const ok = await resolveAttachments([{ blobId: "B", name: "a.txt", mime: "text/plain", size: 4, sha256: sha256(body) }], { fetchBlob: fetchOf(body), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(ok.failures).toEqual([]);
    const badSha = await resolveAttachments([{ blobId: "B", name: "a.txt", mime: "text/plain", size: 4 }], { fetchBlob: fetchOf(body, 200, { "x-rp-sha256": "00" }), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(badSha.failures[0]).toMatch(/sha256/);
    expect(badSha.lines[0]).toMatch(/no disponible/);
    const badSize = await resolveAttachments([{ blobId: "B", name: "a.txt", mime: "text/plain", size: 99 }], { fetchBlob: fetchOf(body), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(badSize.failures[0]).toMatch(/size/);
    const http404 = await resolveAttachments([{ blobId: "B", name: "a.txt", mime: "text/plain", size: 4 }], { fetchBlob: fetchOf(body, 404), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(http404.failures[0]).toMatch(/404/);
  });
  it("images ≤10 MB inline as base64 only when allowed; bigger ones go to disk", async () => {
    const small = Buffer.from("png");
    const r = await resolveAttachments([{ blobId: "B", name: "a.png", mime: "image/png", size: 3 }], { fetchBlob: fetchOf(small), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(r.images).toEqual([{ type: "image", data: small.toString("base64"), mimeType: "image/png" }]);
    expect(r.lines).toEqual([]);
    const asFile = await resolveAttachments([{ blobId: "B", name: "a.png", mime: "image/png", size: 3 }], { fetchBlob: fetchOf(small), inboxDir: dir(), sessionId: "s", inlineImages: false });
    expect(asFile.images).toEqual([]);
    expect(asFile.lines[0]).toMatch(/a\.png/);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const bigR = await resolveAttachments([{ blobId: "B", name: "big.png", mime: "image/png", size: big.length }], { fetchBlob: fetchOf(big), inboxDir: dir(), sessionId: "s", inlineImages: true });
    expect(bigR.images).toEqual([]);
    expect(bigR.lines[0]).toMatch(/big\.png/);
  });
  it("name collisions do not overwrite", async () => {
    const inbox = dir();
    const opts = { fetchBlob: fetchOf(Buffer.from("1")), inboxDir: inbox, sessionId: "s", inlineImages: false, now: new Date(2026, 0, 1) };
    const ref = { blobId: "B", name: "a.txt", mime: "text/plain", size: 1 };
    await resolveAttachments([ref], opts);
    await resolveAttachments([ref], opts);
    expect(fs.readdirSync(path.join(inbox, "s"))).toHaveLength(2);
  });
  it("formatSize", () => {
    expect(formatSize(10)).toBe("10 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
