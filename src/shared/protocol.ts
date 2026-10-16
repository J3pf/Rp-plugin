// Local mirror of the RP wire protocol v1 (rp-relay/docs/PROTOCOLO.md).
// Kept dependency-free so the plugin works without @j3pf/rp-protocol being published.
import { ulid } from "ulid";

export const PROTOCOL_VERSION = 1;

export interface Envelope<D = any> {
  v: number;
  t: string;
  id?: string;
  re?: string;
  ts: number;
  d: D;
}

export function newId(): string {
  return ulid();
}

export function envelope<D>(t: string, d: D, opts: { id?: string; re?: string } = {}): Envelope<D> {
  const e: Envelope<D> = { v: PROTOCOL_VERSION, t, ts: Date.now(), d };
  if (opts.id) e.id = opts.id;
  if (opts.re) e.re = opts.re;
  return e;
}

export function parseEnvelope(raw: unknown): Envelope | null {
  let o: any = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object" || typeof o.t !== "string") return null;
  if (typeof o.v !== "number") return null;
  return { v: o.v, t: o.t, id: o.id, re: o.re, ts: typeof o.ts === "number" ? o.ts : Date.now(), d: o.d ?? {} };
}

export const CLOSE = {
  SERVICE_RESTART: 1012,
  INVALID_TOKEN: 4001,
  INCOMPATIBLE: 4002,
  REPLACED: 4003,
  BAD_FRAME: 4008,
} as const;

export const MAX_FRAME_BYTES = 1024 * 1024;

export type AgentStatus = "idle" | "working" | "waiting_input" | "compacting" | "error";
export type CommChannel = "intercom" | "orchestrator";
export type CommAction = "send" | "ask" | "reply" | "handover" | "message";
export type CommDirection = "out" | "in";

export interface CommPeer {
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  ref: string | null;
}

export interface CommEvent {
  type: "comm";
  commId: string;
  direction: CommDirection;
  channel: CommChannel;
  action: CommAction;
  peer: CommPeer;
  messageId: string | null;
  replyTo: string | null;
  expectsReply: boolean;
  text: string | null;
  truncated: boolean;
  delivered?: boolean | null;
  at: number;
}
export type AgentEventPayload = CommEvent | SubagentUpdateEvent | TodoUpdateEvent | Record<string, unknown>;
export type GentleMode = "normal" | "auto" | "yolo" | "unknown";
export type PromptKind = "confirm" | "select" | "input" | "questionnaire";
export type PromptCategory = "permission" | "question" | "dialog";
export type Danger = "low" | "medium" | "high";
export type DeliveryMethod = "api" | "interactive" | "herdr";
export type Disposition =
  | "sent"
  | "queued_steer"
  | "queued_followup"
  | "typed"
  | "typed_after_dialog"
  | "command"
  | "duplicate"
  | "rejected";
export type DeliveryError = null | "agent_blocked" | "herdr_unavailable" | "interactive_unavailable";

export type TodoStatus = "pending" | "in_progress" | "blocked" | "done" | "dropped";

export interface TodoTask {
  id: number;
  title: string;
  status: TodoStatus;
  note?: string;
}

export interface TodoUpdateEvent {
  type: "todo_update";
  tasks: TodoTask[];
}

export interface SubagentToolCall {
  toolCallId: string;
  name: string;
  status: string;
  durationMs?: number;
}

export interface SubagentUpdateEvent {
  type: "subagent_update";
  taskId: string;
  agent: string;
  label: string;
  status: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  tokens?: number;
  cost?: number;
  error?: string;
  result?: string;
  tools?: SubagentToolCall[];
}

export interface PromptOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface PromptQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  allowFreeText?: boolean;
  options: PromptOption[];
}

export interface PromptOpen {
  promptId: string;
  agentId: string;
  kind: PromptKind;
  category: PromptCategory;
  title: string;
  message?: string;
  options?: PromptOption[];
  allowFreeText?: boolean;
  placeholder?: string | null;
  questions?: PromptQuestion[] | null;
  source?: { extension?: string; tool?: string; subagent?: boolean };
  tool?: { name: string; args: unknown };
  danger: Danger;
  expiresAt: number | null;
}

export type Answer =
  | { optionIds: string[] }
  | { confirmed: boolean }
  | { text: string }
  | { cancelled: true }
  | { answers: Array<{ questionIndex: number; optionIds?: string[]; text?: string }> };

export type ResolvedBy = "local" | "remote" | "timeout" | "cancelled";

export interface UserMessageBody {
  clientMsgId: string;
  deviceId?: string;
  text: string;
  attachments?: Array<{ blobId: string; name: string; mime: string; size: number }>;
  delivery?: "auto" | "steer" | "followUp";
  method?: "auto" | "api" | "interactive" | "herdr";
  asCommand?: boolean;
}

export interface AgentHelloBody {
  agentId: string;
  kind: string;
  instance: string;
  epoch: string;
  pi: { version: string; mode: string };
  plugin: { version: string; features: string[] };
  session: { id: string; file: string | null; name: string | null };
  host: { hostname: string; user: string; pid: number; os: string };
  launcher: string;
  herdr: unknown;
  gentle: { version: string | null; mode: string } | null;
  transport: string;
  redacted: boolean;
  cwd: string;
  spawnId: string | null;
  git: { branch: string | null; dirty: boolean };
  model: { provider: string; id: string } | null;
  thinking: string | null;
  status: AgentStatus;
  openPrompts: unknown[];
  todos?: { tasks: TodoTask[] } | null;
  subagents?: SubagentUpdateEvent[];
}

export interface WelcomeBody {
  serverTime?: number;
  lastSeq?: number | null;
  pendingAnswers?: Array<{ promptId: string; answer: Answer; deviceId?: string }>;
}

export interface QuotaWindow {
  id: string;
  label: string | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetsInSec: number | null;
  note: string | null;
}

export interface MachineQuota {
  family: string;
  label: string;
  plan: string | null;
  ok: boolean;
  notConfigured?: boolean;
  error: string | null;
  primaryWindowId: string | null;
  windows: QuotaWindow[];
  updatedAt: string | null;
}

export interface HostHelloBody {
  machineId: string;
  hostname: string;
  roots: string[];
  backends: {
    herdr: string | null;
    tmux: string | null;
    wt?: boolean;
    console?: boolean;
  };
  defaultBackend?: string | null;
  launchers: string[];
  defaultLauncher?: string;
  quotas?: MachineQuota[];
}

export interface HostQuotasBody {
  quotas: MachineQuota[];
}

/** Message types the plugin sends that must never be dropped from the outbound queue. */
export const CRITICAL_TYPES = new Set([
  "agent.hello",
  "prompt.open",
  "prompt.resolved",
  "prompt.ack",
  "user.message.ack",
]);
