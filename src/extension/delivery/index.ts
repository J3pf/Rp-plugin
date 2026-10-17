// Chooses the delivery method and applies idempotency + fallbacks (PLAN §9.1).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeliveryError, DeliveryMethod, Disposition, UserMessageBody } from "../../shared/protocol.ts";
import { LruSet } from "../../shared/util.ts";
import type { RpConfig } from "../config.ts";
import type { HerdrLocation } from "../environment.ts";
import { resolveAttachments, type FetchBlob } from "../attachments.ts";
import { deliverApi } from "./api.ts";
import { deliverHerdr } from "./herdr.ts";
import { deliverInteractive, type InteractiveDeps } from "./interactive.ts";
import { handleModelCommand, handleThinkingCommand } from "./slash-commands.ts";

export interface AckBody {
  clientMsgId: string;
  disposition: Disposition;
  method: DeliveryMethod;
  error: DeliveryError;
}

export interface DelivererDeps {
  pi: ExtensionAPI;
  ctx: () => ExtensionContext;
  cfg: () => RpConfig;
  herdr: HerdrLocation | null;
  gentleMode: () => string | null;
  /** gentle-pi detected (tools or footer status). Its mode is only published from the first turn on. */
  gentlePresent?: () => boolean;
  fetchBlob: FetchBlob | null;
  inboxDir: () => string;
  sessionId: () => string;
  interactive: () => InteractiveDeps;
  sendAck: (ack: AckBody) => void;
  notify: (msg: string, level: "info" | "warning") => void;
  askSelect?: (title: string, options: string[]) => Promise<string | undefined>;
}

/** Order of methods to try for a message. */
export function methodChain(
  requested: UserMessageBody["method"] | undefined,
  cfgMethod: RpConfig["delivery"]["method"],
  opts: { gentleAuto: boolean; interactiveEnabled: boolean; hasHerdr: boolean; isTui: boolean; asCommand: boolean },
): DeliveryMethod[] {
  if (opts.asCommand) return ["api"];
  const want = requested && requested !== "auto" ? requested : cfgMethod;
  const chain: DeliveryMethod[] = [];
  const canInteractive = opts.interactiveEnabled && opts.isTui;
  if (want === "api") return ["api"];
  if (want === "interactive") {
    if (canInteractive) chain.push("interactive");
    if (opts.hasHerdr) chain.push("herdr");
    chain.push("api");
    return chain;
  }
  if (want === "herdr") {
    if (opts.hasHerdr) chain.push("herdr");
    chain.push("api");
    return chain;
  }
  // auto: gentle AUTO → interactive → herdr → api; otherwise api
  if (opts.gentleAuto) {
    if (canInteractive) chain.push("interactive");
    if (opts.hasHerdr) chain.push("herdr");
  }
  chain.push("api");
  return chain;
}

export class Deliverer {
  private seen = new LruSet(500);
  /** Serialize deliveries: typing into the editor must never interleave. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private d: DelivererDeps) {}

  handle(msg: UserMessageBody): Promise<void> {
    let bg: Promise<void> | null = null;
    const step = this.tail
      .then(() =>
        this.process(msg, (task) => {
          bg = task;
        }),
      )
      .catch(() => {});
    this.tail = step;
    return step.then(() => bg ?? undefined).catch(() => {});
  }

  private async process(msg: UserMessageBody, onBackground?: (task: Promise<void>) => void): Promise<void> {
    const id = msg.clientMsgId;
    if (this.seen.has(id)) {
      this.d.sendAck({ clientMsgId: id, disposition: "duplicate", method: "api", error: null });
      return;
    }
    this.seen.add(id);
    const ctx = this.d.ctx();
    const textTrimmed = msg.text.trim();
    if (textTrimmed === "/quit" || textTrimmed === "/exit") {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const shutdown = (ctx as { shutdown?: () => void }).shutdown;
      if (typeof shutdown === "function") shutdown();
      return;
    }
    const lower = textTrimmed.toLowerCase();
    if (lower === "/model" || /^\/model\s+/i.test(textTrimmed)) {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const arg = textTrimmed.replace(/^\/model\s*/i, "").trim();
      await handleModelCommand(this.d.pi, ctx, arg, { askSelect: this.d.askSelect, onBackground });
      return;
    }
    if (lower === "/thinking" || /^\/thinking\s+/i.test(textTrimmed)) {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const arg = textTrimmed.replace(/^\/thinking\s*/i, "").trim();
      await handleThinkingCommand(this.d.pi, ctx, arg, { askSelect: this.d.askSelect, onBackground });
      return;
    }
    const cfg = this.d.cfg();
    const asCommand = !!msg.asCommand || textTrimmed.startsWith("/");
    const mode = this.d.gentleMode();
    // Until gentle-pi publishes its mode (first turn) assume it could be AUTO: typing is correct in every mode.
    const gentleAuto = mode === "auto" || (!!this.d.gentlePresent?.() && (mode === null || mode === "unknown"));
    const chain = methodChain(msg.method, cfg.delivery.method, {
      gentleAuto,
      interactiveEnabled: cfg.delivery.interactive,
      hasHerdr: !!this.d.herdr,
      isTui: ctx.mode === "tui",
      asCommand,
    });

    let lastError: DeliveryError = null;
    const blobCache = new Map<string, Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>>();
    const cachedFetchBlob: FetchBlob | null = this.d.fetchBlob
      ? (id) => {
          let p = blobCache.get(id);
          if (!p) {
            p = this.d.fetchBlob!(id);
            blobCache.set(id, p);
          }
          return p;
        }
      : null;

    let resolvedTextNonInline: string | null = null;
    let resolvedApi: { text: string; images: Array<{ type: "image"; data: string; mimeType: string }> } | null = null;
    const writtenFiles = new Map<string, string>();

    for (const method of chain) {
      const inline = method === "api";
      let text = msg.text;
      let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      if (msg.attachments?.length && cachedFetchBlob) {
        if (inline) {
          if (!resolvedApi) {
            const r = await resolveAttachments(msg.attachments as any, {
              fetchBlob: cachedFetchBlob,
              inboxDir: this.d.inboxDir(),
              sessionId: this.d.sessionId(),
              inlineImages: true,
              writtenFiles,
            });
            resolvedApi = {
              text: r.lines.length ? (text ? `${text}\n\n${r.lines.join("\n")}` : r.lines.join("\n")) : text,
              images: r.images,
            };
          }
          text = resolvedApi.text;
          images = resolvedApi.images;
        } else {
          if (resolvedTextNonInline === null) {
            const r = await resolveAttachments(msg.attachments as any, {
              fetchBlob: cachedFetchBlob,
              inboxDir: this.d.inboxDir(),
              sessionId: this.d.sessionId(),
              inlineImages: false,
              writtenFiles,
            });
            resolvedTextNonInline = r.lines.length ? (text ? `${text}\n\n${r.lines.join("\n")}` : r.lines.join("\n")) : text;
          }
          text = resolvedTextNonInline;
        }
      }
      try {
        if (method === "api") {
          const res = deliverApi(this.d.pi, {
            text,
            images,
            delivery: msg.delivery ?? "auto",
            asCommand,
            idle: ctx.isIdle(),
          });
          if (mode === "auto" && !asCommand) {
            this.d.notify("RP: mensaje del móvil entregado por la API; en modo Auto de gentle-pi no autoriza acciones.", "warning");
          }
          this.record(msg, "api");
          this.d.sendAck({ clientMsgId: id, disposition: res.disposition, method: "api", error: null });
          return;
        }
        if (method === "interactive") {
          const r = await deliverInteractive(this.d.interactive(), text, msg.delivery ?? "auto");
          if (r.ok) {
            this.record(msg, "interactive");
            this.d.sendAck({ clientMsgId: id, disposition: r.afterDialog ? "typed_after_dialog" : "typed", method: "interactive", error: null });
            return;
          }
          lastError = "interactive_unavailable";
          continue;
        }
        const r = await deliverHerdr(this.d.pi, this.d.herdr?.paneId ?? null, text);
        if (r.ok) {
          this.record(msg, "herdr");
          this.d.sendAck({ clientMsgId: id, disposition: "typed", method: "herdr", error: null });
          return;
        }
        lastError = r.error;
        if (r.error === "agent_blocked") {
          // the agent waits on a dialog: typing would be ignored; report instead of falling to api
          this.d.sendAck({ clientMsgId: id, disposition: "rejected", method: "herdr", error: "agent_blocked" });
          return;
        }
      } catch {
        if (method === "herdr") lastError = "herdr_unavailable";
        else if (method === "interactive") lastError = "interactive_unavailable";
        else lastError = null;
      }
    }
    this.d.sendAck({ clientMsgId: id, disposition: "rejected", method: chain[chain.length - 1] ?? "api", error: lastError });
  }

  private record(msg: UserMessageBody, method: DeliveryMethod): void {
    try {
      this.d.pi.appendEntry("rp.origin", { clientMsgId: msg.clientMsgId, deviceId: msg.deviceId ?? null, method, delivery: method });
    } catch {
      /* auditing must never break delivery */
    }
  }
}
