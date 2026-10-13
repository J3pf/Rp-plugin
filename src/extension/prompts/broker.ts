// "First answer wins": terminal dialog vs. phone answer (PLAN §8.2).
import { newId, type Answer, type Danger, type PromptCategory, type PromptKind, type PromptOpen, type PromptOption, type PromptQuestion, type ResolvedBy } from "../../shared/protocol.ts";
import type { Classification, Classifier } from "./classify.ts";
import type { HerdrBlocker } from "../herdr.ts";

export interface DialogOpts {
  signal?: AbortSignal;
  timeout?: number;
}

export type DialogRequest =
  | { kind: "select"; title: string; options: string[]; opts?: DialogOpts; allowFreeText?: boolean }
  | { kind: "confirm"; title: string; message: string; opts?: DialogOpts }
  | { kind: "input"; title: string; placeholder?: string; opts?: DialogOpts };

/** Request coming from an adapter (custom() dialogs): fully described already. */
export interface AdapterPromptSpec {
  kind: PromptKind;
  title: string;
  message?: string;
  options?: PromptOption[];
  allowFreeText?: boolean;
  questions?: PromptQuestion[];
  source?: { extension?: string; tool?: string; subagent?: boolean };
  category?: PromptCategory;
  danger?: Danger;
}

export interface OpenPrompt {
  id: string;
  body: PromptOpen;
  req: DialogRequest | null;
  closed: boolean;
  /** A phone answer was already accepted for this prompt. */
  answered: boolean;
  remoteAnswer: Promise<Answer>;
  resolveRemote: (a: Answer) => void;
  openedAt: number;
}

export interface BrokerDeps {
  agentId: string;
  send: (t: string, d: unknown) => void;
  hasUI: boolean;
  classifier: Classifier;
  herdr: HerdrBlocker | null;
  onChange?: (openCount: number) => void;
  now?: () => number;
}

export function withSignal<O extends DialogOpts | undefined>(opts: O, extra: AbortSignal): DialogOpts {
  const signal = opts?.signal ? AbortSignal.any([opts.signal, extra]) : extra;
  return { ...(opts ?? {}), signal };
}

export class Broker {
  private prompts = new Map<string, OpenPrompt>();
  private recentlyClosed = new Set<string>();

  constructor(private d: BrokerDeps) {}

  get openCount(): number {
    return this.prompts.size;
  }

  /** Bodies of currently open prompts, for agent.hello.openPrompts. */
  openPrompts(): PromptOpen[] {
    return [...this.prompts.values()].map((p) => p.body);
  }

  /** Whether any prompt originated from an adapter (suppresses the "waiting on terminal" notice for its custom() dialog). */
  hasAdapterPrompt(): boolean {
    for (const p of this.prompts.values()) if (p.req === null) return true;
    return false;
  }

  private build(req: DialogRequest): { body: Omit<PromptOpen, "promptId" | "agentId">; cls: Classification } {
    const message = req.kind === "confirm" ? req.message : undefined;
    const cls = this.d.classifier.classifyDialog(req.kind, req.title, message);
    let options: PromptOption[] | undefined;
    if (req.kind === "select") options = req.options.map((label, i) => ({ id: String(i), label }));
    else if (req.kind === "confirm") {
      const perm = cls.category === "permission";
      options = [
        { id: "yes", label: perm ? "Permitir" : "Sí" },
        { id: "no", label: perm ? "Denegar" : "No" },
      ];
    }
    const expiresAt = req.opts?.timeout ? (this.d.now ?? Date.now)() + req.opts.timeout : null;
    return {
      cls,
      body: {
        kind: req.kind,
        category: cls.category,
        title: req.title,
        message: cls.message ?? message,
        options,
        allowFreeText: req.kind === "input" || (req.kind === "select" && !!req.allowFreeText),
        placeholder: req.kind === "input" ? (req.placeholder ?? null) : null,
        questions: null,
        source: cls.source,
        tool: cls.tool,
        danger: cls.danger,
        expiresAt,
      },
    };
  }

  private register(body: PromptOpen, req: DialogRequest | null, herdrReported: boolean): OpenPrompt {
    let resolveRemote!: (a: Answer) => void;
    const remoteAnswer = new Promise<Answer>((r) => (resolveRemote = r));
    const p: OpenPrompt = { id: body.promptId, body, req, closed: false, answered: false, remoteAnswer, resolveRemote, openedAt: (this.d.now ?? Date.now)() };
    this.prompts.set(p.id, p);
    this.d.send("prompt.open", body);
    this.d.herdr?.block(p.id, body.title, herdrReported);
    this.d.onChange?.(this.prompts.size);
    return p;
  }

  open(req: DialogRequest): OpenPrompt {
    const { body, cls } = this.build(req);
    return this.register({ promptId: newId(), agentId: this.d.agentId, ...body }, req, cls.herdrReported);
  }

  /** Open a prompt described by an adapter (custom() dialogs). */
  openSpec(spec: AdapterPromptSpec): OpenPrompt {
    const body: PromptOpen = {
      promptId: newId(),
      agentId: this.d.agentId,
      kind: spec.kind,
      category: spec.category ?? "question",
      title: spec.title,
      message: spec.message,
      options: spec.options,
      allowFreeText: !!spec.allowFreeText,
      placeholder: null,
      questions: spec.questions ?? null,
      source: spec.source,
      danger: spec.danger ?? "low",
      expiresAt: null,
    };
    return this.register(body, null, true);
  }

  close(p: OpenPrompt): void {
    if (p.closed) return;
    p.closed = true;
    this.prompts.delete(p.id);
    this.recentlyClosed.add(p.id);
    if (this.recentlyClosed.size > 200) this.recentlyClosed.delete(this.recentlyClosed.values().next().value as string);
    this.d.herdr?.unblock(p.id);
    this.d.onChange?.(this.prompts.size);
  }

  resolved(p: OpenPrompt, by: ResolvedBy, answer: Answer | null): void {
    this.d.send("prompt.resolved", { promptId: p.id, by, answer });
  }

  ack(promptId: string, accepted: boolean): void {
    this.d.send("prompt.ack", { promptId, accepted });
  }

  /** Relay → plugin: prompt.answer. Always replies with prompt.ack. */
  handleAnswer(promptId: string, answer: Answer): boolean {
    const p = this.prompts.get(promptId);
    if (!p || p.closed || p.answered) {
      this.ack(promptId, false);
      return false;
    }
    p.answered = true;
    p.resolveRemote(answer);
    return true;
  }

  /** Relay → plugin: prompt.cancel (expired by the relay). */
  handleCancel(promptId: string): void {
    const p = this.prompts.get(promptId);
    if (p && !p.answered) {
      p.answered = true;
      p.resolveRemote({ cancelled: true });
    }
  }

  /**
   * Race the local dialog against the phone. `runLocal` is null when there is no local UI
   * (json/print modes): then only the phone can answer.
   */
  async race<T>(req: DialogRequest, runLocal: ((signal: AbortSignal) => Promise<T>) | null): Promise<T> {
    const p = this.open(req);
    const ac = new AbortController();
    const started = (this.d.now ?? Date.now)();
    const timeoutMs = req.opts?.timeout;
    const callerSignal = req.opts?.signal;

    type Outcome = { src: "local"; v: T } | { src: "remote"; a: Answer } | { src: "timeout" } | { src: "cancelled" };
    const racers: Promise<Outcome>[] = [p.remoteAnswer.then((a) => ({ src: "remote", a }) as Outcome)];
    let timer: NodeJS.Timeout | undefined;
    if (runLocal) {
      racers.push(runLocal(ac.signal).then((v) => ({ src: "local", v }) as Outcome));
    } else {
      // headless: Pi's own timeout/signal never fire for us, so honor them here
      if (timeoutMs) racers.push(new Promise<Outcome>((r) => (timer = setTimeout(() => r({ src: "timeout" }), timeoutMs))));
      if (callerSignal) {
        racers.push(
          new Promise<Outcome>((r) => {
            if (callerSignal.aborted) r({ src: "cancelled" });
            else callerSignal.addEventListener("abort", () => r({ src: "cancelled" }), { once: true });
          }),
        );
      }
    }
    let w: Outcome;
    try {
      w = await Promise.race(racers);
    } catch (e) {
      this.resolved(p, "cancelled", null);
      this.close(p);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (w.src === "remote") {
      ac.abort();
      this.ack(p.id, true);
      this.close(p);
      return toLocalValue(req, w.a) as T;
    }
    if (w.src === "timeout") {
      this.resolved(p, "timeout", null);
      this.close(p);
      return emptyValue(req) as T;
    }
    if (w.src === "cancelled") {
      this.resolved(p, "cancelled", null);
      this.close(p);
      return emptyValue(req) as T;
    }
    // local answer
    const v = w.v;
    let by: ResolvedBy = "local";
    if (callerSignal?.aborted) by = "cancelled";
    else if (timeoutMs && (v === undefined || v === false) && (this.d.now ?? Date.now)() - started >= timeoutMs - 50) by = "timeout";
    this.resolved(p, by, by === "local" ? fromLocal(req, v) : null);
    this.close(p);
    return v;
  }

  /** Close everything on shutdown: the relay cancels orphaned prompts after 2 min, but tell it now. */
  shutdown(): void {
    for (const p of [...this.prompts.values()]) {
      this.resolved(p, "cancelled", null);
      p.resolveRemote({ cancelled: true });
      this.close(p);
    }
  }
}

export function emptyValue(req: DialogRequest): unknown {
  return req.kind === "confirm" ? false : undefined;
}

/** Phone Answer → value expected by the Pi dialog caller. select returns the exact option label. */
export function toLocalValue(req: DialogRequest, a: Answer): unknown {
  const any = a as any;
  if (any.cancelled) return emptyValue(req);
  if (req.kind === "select") {
    if (Array.isArray(any.optionIds) && any.optionIds.length) {
      const idx = Number(any.optionIds[0]);
      return Number.isInteger(idx) && idx >= 0 && idx < req.options.length ? req.options[idx] : undefined;
    }
    if (typeof any.text === "string") return any.text;
    return undefined;
  }
  if (req.kind === "confirm") {
    if (typeof any.confirmed === "boolean") return any.confirmed;
    if (Array.isArray(any.optionIds)) return any.optionIds[0] === "yes";
    return false;
  }
  if (typeof any.text === "string") return any.text;
  return undefined;
}

/** Local value → Answer for prompt.resolved. */
export function fromLocal(req: DialogRequest, v: unknown): Answer | null {
  if (req.kind === "select") {
    if (v === undefined) return { cancelled: true };
    const i = req.options.indexOf(v as string);
    return i >= 0 ? { optionIds: [String(i)] } : { text: String(v) };
  }
  if (req.kind === "confirm") return { confirmed: !!v };
  return v === undefined ? { cancelled: true } : { text: String(v) };
}
