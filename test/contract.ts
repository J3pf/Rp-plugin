// Validators written straight from rp-relay/docs/PROTOCOLO.md (v1). They stand in for @j3pf/rp-protocol until it is published.
const isStr = (v: unknown) => typeof v === "string" && v.length > 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown) => typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = (...vals: unknown[]) => (v: unknown) => vals.includes(v);
const nullable = (f: (v: unknown) => boolean) => (v: unknown) => v === null || f(v);
const arrayOf = (f: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(f);

type Rule = (v: unknown) => boolean;
type Shape = Record<string, Rule | undefined>;

export function check(value: unknown, shape: Shape, where: string, optional: string[] = []): string[] {
  const errs: string[] = [];
  if (!isObj(value)) return [`${where}: not an object`];
  for (const [k, rule] of Object.entries(shape)) {
    if (rule === undefined) continue;
    if (!(k in value)) {
      if (!optional.includes(k)) errs.push(`${where}.${k}: missing`);
      continue;
    }
    if (!rule(value[k])) errs.push(`${where}.${k}: invalid (${JSON.stringify(value[k])?.slice(0, 80)})`);
  }
  return errs;
}

const status = oneOf("idle", "working", "waiting_input", "compacting", "error");
const promptKind = oneOf("confirm", "select", "input", "questionnaire");
const category = oneOf("permission", "question", "dialog");
const danger = oneOf("low", "medium", "high");

export const isQuotaWindow = (w: unknown) =>
  isObj(w) &&
  isStr(w.id) &&
  nullable((v) => typeof v === "string")(w.label) &&
  isNum(w.usedPercent) &&
  isNum(w.remainingPercent) &&
  nullable((v) => typeof v === "string")(w.resetsAt) &&
  nullable((v) => typeof v === "number")(w.resetsInSec) &&
  nullable((v) => typeof v === "string")(w.note);

export const isMachineQuota = (q: unknown) =>
  isObj(q) &&
  isStr(q.family) &&
  isStr(q.label) &&
  nullable((v) => typeof v === "string")(q.plan) &&
  isBool(q.ok) &&
  nullable((v) => typeof v === "string")(q.error) &&
  nullable((v) => typeof v === "string")(q.primaryWindowId) &&
  Array.isArray(q.windows) &&
  q.windows.every(isQuotaWindow) &&
  nullable((v) => typeof v === "string")(q.updatedAt);

export const isCommEvent = (v: unknown) =>
  isObj(v) &&
  v.type === "comm" &&
  typeof v.commId === "string" &&
  oneOf("out", "in")(v.direction) &&
  oneOf("intercom", "orchestrator")(v.channel) &&
  (v.channel !== "orchestrator" || v.action === "message") &&
  oneOf("send", "ask", "reply", "handover", "message")(v.action) &&
  isObj(v.peer) &&
  nullable((x) => typeof x === "string")(v.peer.sessionId) &&
  nullable((x) => typeof x === "string")(v.peer.name) &&
  nullable((x) => typeof x === "string")(v.peer.cwd) &&
  nullable((x) => typeof x === "string")(v.peer.ref) &&
  nullable((x) => typeof x === "string")(v.messageId) &&
  nullable((x) => typeof x === "string")(v.replyTo) &&
  isBool(v.expectsReply) &&
  nullable((x) => typeof x === "string")(v.text) &&
  isBool(v.truncated) &&
  (v.direction === "in"
    ? !("delivered" in v) || v.delivered === undefined
    : "delivered" in v && (v.delivered === null || typeof v.delivered === "boolean")) &&
  isNum(v.at);

export const isSubagentUpdateEvent = (v: unknown) =>
  isObj(v) &&
  v.type === "subagent_update" &&
  isStr(v.taskId) &&
  isStr(v.agent) &&
  typeof v.label === "string" &&
  isStr(v.status) &&
  (!("tokens" in v) ||
    v.tokens === undefined ||
    v.tokens === null ||
    (isObj(v.tokens) && Object.values(v.tokens).every((x) => x === undefined || isNum(x)))) &&
  (!("tools" in v) ||
    v.tools === undefined ||
    v.tools === null ||
    arrayOf((t) => typeof t === "string")(v.tools));

export const isTodoUpdateEvent = (v: unknown) =>
  isObj(v) &&
  v.type === "todo_update" &&
  arrayOf((t) => isObj(t) && (isNum(t.id) || isStr(t.id)) && typeof t.title === "string" && isStr(t.status))(v.tasks);

export const promptOpenShape: Shape = {
  promptId: isStr,
  agentId: (v) => isStr(v) && String(v).includes(":"),
  kind: promptKind,
  category,
  title: isStr,
  message: (v) => typeof v === "string",
  options: arrayOf((o) => isObj(o) && isStr(o.id) && typeof o.label === "string"),
  allowFreeText: isBool,
  placeholder: nullable((v) => typeof v === "string"),
  questions: nullable(arrayOf((q) => isObj(q) && isStr(q.question) && Array.isArray(q.options) && q.options.every((o: any) => isStr(o.id) && isStr(o.label)))),
  source: (v) => isObj(v),
  tool: (v) => isObj(v) && isStr(v.name),
  danger,
  expiresAt: nullable(isNum),
};

const answerOk = (v: unknown) =>
  isObj(v) && (Array.isArray(v.optionIds) || isBool(v.confirmed) || typeof v.text === "string" || v.cancelled === true || Array.isArray(v.answers));

export const validators: Record<string, (d: any) => string[]> = {
  "agent.hello": (d) => [
    ...check(
      d,
      {
        agentId: (v) => isStr(v) && String(v).includes(":"),
        kind: oneOf("pi", "agy", "codex", "claude", "opencode", "gemini", "qwen", "copilot", "cursor", "shell"),
        instance: isStr,
        epoch: isStr,
        pi: (v) => isObj(v) && isStr(v.version) && oneOf("tui", "rpc", "json", "print")(v.mode),
        plugin: (v) => isObj(v) && isStr(v.version) && arrayOf(isStr)(v.features),
        session: (v) => isObj(v) && isStr(v.id) && nullable((x) => typeof x === "string")(v.file ?? null) && nullable((x) => typeof x === "string")(v.name ?? null),
        host: (v) => isObj(v) && isStr(v.hostname) && typeof v.user === "string" && isNum(v.pid) && isStr(v.os),
        launcher: isStr,
        herdr: nullable((v) => isObj(v) && isStr(v.paneId)),
        gentle: nullable((v) => isObj(v) && oneOf("normal", "auto", "yolo", "unknown")(v.mode)),
        transport: oneOf("ws", "longpoll"),
        redacted: isBool,
        cwd: isStr,
        spawnId: nullable(isStr),
        git: (v) => isObj(v) && isBool(v.dirty) && nullable((x) => typeof x === "string")(v.branch),
        model: nullable((v) => isObj(v) && isStr(v.provider) && isStr(v.id)),
        thinking: nullable(isStr),
        status,
        openPrompts: arrayOf((p) => check(p, promptOpenShape, "openPrompts[]", ["message", "tool", "source", "options", "placeholder", "questions"]).length === 0),
        todos: nullable((v) => isObj(v) && Array.isArray(v.tasks)),
        subagents: arrayOf(isSubagentUpdateEvent),
      },
      "hello",
      ["todos", "subagents"],
    ),
  ],
  "agent.snapshot": (d) =>
    check(
      d,
      {
        epoch: isStr,
        seq: (v) => isNum(v) && (v as number) >= 0,
        entries: arrayOf((e: any) => isObj(e) && isStr(e.eid) && oneOf("user", "assistant", "tool_result", "bash", "custom", "compaction", "branch_summary", "model_change")(e.kind) && isNum(e.at) && "msg" in e),
        truncated: isBool,
      },
      "snapshot",
    ),
  "agent.event": (d) =>
    check(
      d,
      {
        epoch: isStr,
        seq: (v) => Number.isInteger(v) && (v as number) >= 1,
        e: (v) =>
          isObj(v) &&
          isStr(v.type) &&
          (v.type !== "comm" || isCommEvent(v)) &&
          (v.type !== "subagent_update" || isSubagentUpdateEvent(v)) &&
          (v.type !== "todo_update" || isTodoUpdateEvent(v)),
      },
      "event",
    ),
  "agent.closed": (d) => check(d, { reason: oneOf("pane_closed") }, "agent.closed"),
  "agent.status": (d) => check(d, { status, detail: (v) => typeof v === "string" }, "status", ["detail"]),
  "agent.statuses": (d) => check(d, { items: (v) => isObj(v) && Object.values(v).every((x) => typeof x === "string") }, "statuses"),
  "prompt.open": (d) => check(d, promptOpenShape, "prompt.open", ["message", "tool", "source", "options", "placeholder", "questions"]),
  "prompt.resolved": (d) => check(d, { promptId: isStr, by: oneOf("local", "remote", "timeout", "cancelled"), answer: nullable(answerOk) }, "prompt.resolved"),
  "prompt.ack": (d) => check(d, { promptId: isStr, accepted: isBool }, "prompt.ack"),
  "user.message.ack": (d) =>
    check(
      d,
      {
        clientMsgId: isStr,
        disposition: oneOf("sent", "queued_steer", "queued_followup", "typed", "typed_after_dialog", "command", "duplicate", "rejected"),
        method: oneOf("api", "interactive", "herdr"),
        error: nullable(oneOf("agent_blocked", "herdr_unavailable", "interactive_unavailable")),
      },
      "user.message.ack",
    ),
  "host.hello": (d) =>
    check(
      d,
      {
        machineId: isStr,
        hostname: isStr,
        roots: arrayOf(isStr),
        backends: (v) => isObj(v) && "herdr" in v && "tmux" in v && isBool(v.wt) && isBool(v.console),
        defaultBackend: oneOf("herdr", "tmux", "wt", "console"),
        launchers: arrayOf(isStr),
        defaultLauncher: isStr,
        quotas: arrayOf(isMachineQuota),
      },
      "host.hello",
      ["quotas", "defaultBackend"],
    ),
  "host.quotas": (d) =>
    check(
      d,
      {
        quotas: arrayOf(isMachineQuota),
      },
      "host.quotas",
    ),
  "host.dirs": (d) => check(d, { path: (v) => typeof v === "string", dirs: arrayOf(isStr) }, "host.dirs"),
  "host.spawned": (d) =>
    check(
      d,
      {
        spawnId: isStr,
        backend: oneOf("herdr", "tmux", "wt", "console"),
        herdr: nullable((v) => isObj(v) && typeof v.workspaceId === "string" && isStr(v.paneId)),
        tmuxSession: nullable(isStr),
      },
      "host.spawned",
    ),
  "host.git_diff.result": (d) =>
    check(
      d,
      {
        cwd: isStr,
        branch: nullable((v) => typeof v === "string"),
        files: arrayOf(
          (f) =>
            isObj(f) &&
            isStr(f.path) &&
            oneOf("modified", "added", "deleted", "untracked", "renamed")(f.status) &&
            isNum(f.additions) &&
            isNum(f.deletions) &&
            isBool(f.binary) &&
            typeof f.patch === "string" &&
            isBool(f.truncated),
        ),
        totalAdditions: isNum,
        totalDeletions: isNum,
      },
      "host.git_diff.result",
    ),
  "host.git_discard.result": (d) =>
    check(
      d,
      {
        cwd: isStr,
        path: isStr,
        ok: isBool,
      },
      "host.git_discard.result",
    ),
  "host.herdr_layout.result": (d) =>
    check(
      d,
      {
        available: isBool,
        workspaces: arrayOf((w) => isObj(w) && isStr(w.id) && typeof w.name === "string" && Array.isArray(w.panes)),
      },
      "host.herdr_layout.result",
    ),
};

export function validateEnvelope(e: any): string[] {
  const errs = check(e, { v: (v) => v === 1, t: isStr, ts: isNum, d: isObj }, "envelope", []);
  if (errs.length) return errs;
  const v = validators[e.t];
  return v ? v(e.d) : [];
}
