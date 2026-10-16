import { newId, type CommEvent, type CommPeer } from "../shared/protocol.ts";
export type { CommEvent, CommPeer } from "../shared/protocol.ts";

export interface CommTrackerDeps {
  emit: (event: CommEvent) => void;
  isRedacted: () => boolean;
  now?: () => number;
}

export interface InboundCommFrom {
  id?: string | null;
  name?: string | null;
  cwd?: string | null;
}

export interface InboundCommMessage {
  id?: string | null;
  expectsReply?: boolean;
  replyTo?: string | null;
}

const INTERCOM_ACTIONS = new Set(["send", "ask", "reply", "handover"]);
const MAX_TEXT_LENGTH = 2000;
const DEFAULT_CAPACITY = 500;

/** Map with an LRU eviction bound, refreshing entries on access and update. */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly capacity: number;

  constructor(maxCapacity = DEFAULT_CAPACITY) {
    super();
    this.capacity = Number.isFinite(maxCapacity) ? Math.max(0, Math.floor(maxCapacity)) : DEFAULT_CAPACITY;
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override has(key: K): boolean {
    if (!super.has(key)) return false;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return true;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.capacity) {
      const oldest = this.keys().next();
      if (!oldest.done) super.delete(oldest.value);
    }
    return this;
  }
}

/** Set with an LRU eviction bound, refreshing entries on access and update. */
export class BoundedSet<T> extends Set<T> {
  private readonly capacity: number;

  constructor(maxCapacity = DEFAULT_CAPACITY) {
    super();
    this.capacity = Number.isFinite(maxCapacity) ? Math.max(0, Math.floor(maxCapacity)) : DEFAULT_CAPACITY;
  }

  override has(value: T): boolean {
    if (!super.has(value)) return false;
    super.delete(value);
    super.add(value);
    return true;
  }

  override add(value: T): this {
    super.delete(value);
    super.add(value);
    if (this.size > this.capacity) {
      const oldest = this.values().next();
      if (!oldest.done) super.delete(oldest.value);
    }
    return this;
  }
}

/** Correlates inter-agent tool calls into outgoing CommEvents. */
export class CommTracker {
  private readonly activeCalls = new BoundedMap<string, CommEvent>();
  private readonly inboundMessages = new BoundedMap<string, CommPeer>();
  private readonly seenInboundMessageIds = new BoundedSet<string>();
  private readonly knownPeers = new BoundedMap<string, CommPeer>();
  private readonly now: () => number;

  constructor(private readonly deps: CommTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  onAgentSettled(aborted?: boolean): void {
    if (aborted) this.activeCalls.clear();
  }

  reset(): void {
    this.activeCalls.clear();
    this.inboundMessages.clear();
    this.knownPeers.clear();
    this.seenInboundMessageIds.clear();
  }

  onMessage(message: unknown): void {
    try {
      const inbound = this.parseInbound(message);
      if (!inbound || this.seenInboundMessageIds.has(inbound.messageId)) return;
      this.seenInboundMessageIds.add(inbound.messageId);
      this.recordInbound(inbound.from, inbound.message);

      const content = this.content(inbound.bodyText);
      const event: CommEvent = {
        type: "comm",
        commId: newId(),
        direction: "in",
        channel: "intercom",
        action: resolveInboundAction(inbound.message),
        peer: {
          sessionId: nonEmptyString(inbound.from.id),
          name: nonEmptyString(inbound.from.name),
          cwd: nonEmptyString(inbound.from.cwd),
          ref: null,
        },
        messageId: inbound.messageId,
        replyTo: nonEmptyString(inbound.message.replyTo),
        expectsReply: Boolean(inbound.message.expectsReply),
        text: content.text,
        truncated: content.truncated,
        at: this.now(),
      };
      this.deps.emit(copyEvent(event));
    } catch {
      // Message hooks are observational and must never break Pi execution.
    }
  }

  /** Seed messages already present in the session branch without emitting them. */
  seedSeen(branch: any[]): void {
    try {
      if (!Array.isArray(branch)) return;
      for (const entry of branch) {
        try {
          const message = entry?.message ?? entry;
          const inbound = this.parseInbound(message);
          if (!inbound) continue;
          this.seenInboundMessageIds.add(inbound.messageId);
          this.recordInbound(inbound.from, inbound.message);
        } catch {
          // Ignore malformed historical branch entries.
        }
      }
    } catch {
      // Branch seeding must never disrupt session startup.
    }
  }

  private parseInbound(message: unknown): {
    from: InboundCommFrom;
    message: InboundCommMessage;
    messageId: string;
    bodyText: unknown;
  } | null {
    const raw = message as any;
    if (raw?.customType !== "intercom_message") return null;
    const details = raw?.details;
    const from = details?.from ?? {};
    const inboundMessage = details?.message ?? {};
    const messageId = inboundMessage?.id ?? details?.id;
    if (typeof messageId !== "string" || !messageId) return null;
    const bodyText = details?.bodyText ?? (typeof raw?.content === "string" ? raw.content : "");
    return { from, message: inboundMessage, messageId, bodyText };
  }

  /** Remember an inbound message so a subsequent reply can be attributed to its sender. */
  recordInbound(from: InboundCommFrom, message: InboundCommMessage): void {
    try {
      const peer: CommPeer = {
        sessionId: nonEmptyString(from?.id),
        name: nonEmptyString(from?.name),
        cwd: nonEmptyString(from?.cwd),
        ref: null,
      };
      if (peer.sessionId) this.knownPeers.set(peer.sessionId, peer);
      if (peer.name) this.knownPeers.set(peer.name, peer);
      if (typeof message?.id !== "string" || !message.id) return;
      this.inboundMessages.set(message.id, peer);
    } catch {
      // Inbound observation must never disrupt the extension hook.
    }
  }

  onToolStart(toolName: string, args: unknown, toolCallId?: string): void {
    try {
      const input = asRecord(args);
      let event: CommEvent | null = null;

      if (toolName === "intercom") {
        const action = input?.action;
        if (typeof action !== "string" || !INTERCOM_ACTIONS.has(action)) return;
        if (action === "reply" && !input?.message) return;

        const peer: CommPeer = {
          sessionId: null,
          name: null,
          cwd: null,
          ref: typeof input?.to === "string" ? input.to : null,
        };
        if (action === "reply") this.fillReplyPeer(peer, input?.replyTo);
        const text = this.content(input?.message);
        event = {
          type: "comm",
          commId: newId(),
          direction: "out",
          channel: "intercom",
          action: action as CommEvent["action"],
          peer,
          messageId: null,
          replyTo: typeof input?.replyTo === "string" ? input.replyTo : null,
          expectsReply: action === "ask",
          text: text.text,
          truncated: text.truncated,
          delivered: null,
          at: this.now(),
        };
      } else if (toolName === "orchestrator_send_message") {
        const ref = typeof input?.recipient_session_id === "string" ? input.recipient_session_id : null;
        const text = this.content(input?.message);
        event = {
          type: "comm",
          commId: newId(),
          direction: "out",
          channel: "orchestrator",
          action: "message",
          peer: { sessionId: ref, name: null, cwd: null, ref },
          messageId: null,
          replyTo: null,
          expectsReply: false,
          text: text.text,
          truncated: text.truncated,
          delivered: null,
          at: this.now(),
        };
      }

      if (!event) return;
      if (toolCallId) this.activeCalls.set(toolCallId, event);
      this.deps.emit(copyEvent(event));
    } catch {
      // Tool hooks are observational and must never break Pi execution.
    }
  }

  onToolEnd(_toolName: string, result: unknown, isError: boolean, toolCallId?: string): void {
    try {
      if (!toolCallId) return;
      const call = this.activeCalls.get(toolCallId);
      if (!call) return;

      const resultRecord = asRecord(result);
      const rawDetails = resultRecord?.details ?? result;
      const details = asRecord(rawDetails);
      const messageId = typeof details?.messageId === "string" ? details.messageId : null;
      if (typeof details?.replyTo === "string" && details.replyTo && !call.replyTo) call.replyTo = details.replyTo;
      if (call.action === "reply" && !call.peer.sessionId && typeof details?.replyTo === "string") {
        this.fillReplyPeer(call.peer, details.replyTo);
      }
      call.messageId = messageId;
      call.delivered = typeof details?.delivered === "boolean" ? details.delivered : !isError && !details?.error;
      this.activeCalls.delete(toolCallId);
      this.deps.emit(copyEvent(call));
    } catch {
      // Tool hooks are observational and must never break Pi execution.
    }
  }

  private fillReplyPeer(peer: CommPeer, replyTo: unknown): void {
    const key = typeof replyTo === "string" ? replyTo : null;
    const fromReply = key ? this.inboundMessages.get(key) : undefined;
    const fromRef = peer.ref ? this.knownPeers.get(peer.ref) : undefined;
    const from = fromReply ?? fromRef;
    if (!from) return;
    peer.sessionId = from.sessionId;
    peer.name = from.name;
    peer.cwd = from.cwd;
  }

  private content(value: unknown): { text: string | null; truncated: boolean } {
    if (this.deps.isRedacted()) return { text: null, truncated: false };
    if (typeof value !== "string") return { text: null, truncated: false };
    return value.length > MAX_TEXT_LENGTH
      ? { text: value.slice(0, MAX_TEXT_LENGTH), truncated: true }
      : { text: value, truncated: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function resolveInboundAction(message: InboundCommMessage): CommEvent["action"] {
  if (message.expectsReply) return "ask";
  if (message.replyTo) return "reply";
  return "send";
}

function copyEvent(event: CommEvent): CommEvent {
  const out = { ...event, peer: { ...event.peer } };
  if (out.delivered === undefined) delete out.delivered;
  return out;
}
