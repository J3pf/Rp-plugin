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
import { handleModelCommand, handleThinkingCommand, type ValidThinkingLevel } from "./slash-commands.ts";

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
  onThinkingSelected?: (level: ValidThinkingLevel) => void;
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

const ACTIVE_SELECT_WAIT_TIMEOUT_MS = 60_000;

interface ResolvedPayload {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}

interface AttachmentCache {
  resolveFor(method: DeliveryMethod): Promise<ResolvedPayload>;
}

function appendAttachmentLines(baseText: string, lines: string[]): string {
  if (lines.length === 0) return baseText;
  return baseText ? `${baseText}\n\n${lines.join("\n")}` : lines.join("\n");
}

function createAttachmentCache(msg: UserMessageBody, deps: DelivererDeps): AttachmentCache {
  const blobCache = new Map<string, Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>>();
  const cachedFetchBlob: FetchBlob | null = deps.fetchBlob
    ? (blobId) => {
        let p = blobCache.get(blobId);
        if (!p) {
          p = deps.fetchBlob!(blobId);
          blobCache.set(blobId, p);
        }
        return p;
      }
    : null;
  const writtenFiles = new Map<string, string>();
  let resolvedApi: ResolvedPayload | null = null;
  let resolvedTextNonInline: string | null = null;

  return {
    async resolveFor(method: DeliveryMethod): Promise<ResolvedPayload> {
      if (!msg.attachments?.length || !cachedFetchBlob) {
        return { text: msg.text, images: [] };
      }
      if (method === "api") {
        if (!resolvedApi) {
          const r = await resolveAttachments(msg.attachments, {
            fetchBlob: cachedFetchBlob,
            inboxDir: deps.inboxDir(),
            sessionId: deps.sessionId(),
            inlineImages: true,
            writtenFiles,
          });
          resolvedApi = {
            text: appendAttachmentLines(msg.text, r.lines),
            images: r.images,
          };
        }
        return resolvedApi;
      }
      if (resolvedTextNonInline === null) {
        const r = await resolveAttachments(msg.attachments, {
          fetchBlob: cachedFetchBlob,
          inboxDir: deps.inboxDir(),
          sessionId: deps.sessionId(),
          inlineImages: false,
          writtenFiles,
        });
        resolvedTextNonInline = appendAttachmentLines(msg.text, r.lines);
      }
      return { text: resolvedTextNonInline, images: [] };
    },
  };
}

export class Deliverer {
  private seen = new LruSet(500);
  /** Serialize deliveries: typing into the editor must never interleave. */
  private tail: Promise<unknown> = Promise.resolve();
  private activeSelectPromises = new Set<Promise<void>>();

  constructor(private d: DelivererDeps) {}

  handle(msg: UserMessageBody): Promise<void> {
    let bg: Promise<void> | null = null;
    const step = this.tail
      .then(() =>
        this.process(msg, (task) => {
          bg = task;
          this.activeSelectPromises.add(task);
          void task.finally(() => this.activeSelectPromises.delete(task)).catch(() => {});
        }),
      )
      .catch(() => {});
    this.tail = step;
    return step.then(() => bg ?? undefined).catch(() => {});
  }

  private async tryHandleSlashCommand(
    msg: UserMessageBody,
    ctx: ExtensionContext,
    textTrimmed: string,
    onBackground?: (task: Promise<void>) => void,
  ): Promise<boolean> {
    const id = msg.clientMsgId;
    if (textTrimmed === "/quit" || textTrimmed === "/exit") {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const shutdown = (ctx as { shutdown?: () => void }).shutdown;
      if (typeof shutdown === "function") shutdown();
      return true;
    }
    const lower = textTrimmed.toLowerCase();
    if (lower === "/model" || /^\/model\s+/i.test(textTrimmed)) {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const arg = textTrimmed.replace(/^\/model\s*/i, "").trim();
      await handleModelCommand(this.d.pi, ctx, arg, { askSelect: this.d.askSelect, onBackground });
      return true;
    }
    if (lower === "/thinking" || /^\/thinking\s+/i.test(textTrimmed)) {
      this.record(msg, "api");
      this.d.sendAck({ clientMsgId: id, disposition: "command", method: "api", error: null });
      const arg = textTrimmed.replace(/^\/thinking\s*/i, "").trim();
      await handleThinkingCommand(this.d.pi, ctx, arg, {
        askSelect: this.d.askSelect,
        onBackground,
        onThinkingSelected: this.d.onThinkingSelected,
      });
      return true;
    }
    return false;
  }

  private async waitForActiveSelects(): Promise<void> {
    if (this.activeSelectPromises.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.activeSelectPromises]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ACTIVE_SELECT_WAIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
    if (await this.tryHandleSlashCommand(msg, ctx, textTrimmed, onBackground)) {
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
    const attachments = createAttachmentCache(msg, this.d);

    for (const method of chain) {
      const { text, images } = await attachments.resolveFor(method);
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
          await this.waitForActiveSelects();
          const r = await deliverInteractive(this.d.interactive(), text, msg.delivery ?? "auto");
          if (r.ok) {
            this.record(msg, "interactive");
            this.d.sendAck({ clientMsgId: id, disposition: r.afterDialog ? "typed_after_dialog" : "typed", method: "interactive", error: null });
            return;
          }
          lastError = "interactive_unavailable";
          continue;
        }
        const draftUi = ctx.hasUI
          ? {
              getText: () => ctx.ui.getEditorText(),
              setText: (t: string) => ctx.ui.setEditorText(t),
            }
          : undefined;
        const r = await deliverHerdr(this.d.pi, this.d.herdr?.paneId ?? null, text, draftUi);
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
