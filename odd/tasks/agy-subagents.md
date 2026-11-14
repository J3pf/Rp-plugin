# Feature: AGY Subagents Visibility (`Rp-plugin`)
Objective: Track full async AGY subagent lifecycle (spawn, parallel subagents, live child transcript telemetry, `SYSTEM_MESSAGE` completion, snapshot/resync emission).
Branch: `feat/agy-subagents-visibility` | Delivery: `ask-on-risk` | Test runner: `npm run typecheck && npm run build && npm run test:unit`
Engram mirror: pending (parent workspace ambiguous across subrepos)

## Specs
- S1: Multi-subagent and full-step parsing in `src/host/agy-transcript.ts`:
  - Expand all elements of `invoke_subagent` `args.Subagents` arrays (`normalizeAgyToolCalls`) while keeping `normalizeAgyToolCall` backwards-compatible for existing single-call callers and keeping a single `PendingTool` (`subagentIds[]`) per raw tool call.
  - Resolve `transcript_full.jsonl` when `truncated_fields` includes `tool_calls` (for `PLANNER_RESPONSE` with `invoke_subagent`) or `content` (for `SYSTEM_MESSAGE` and tail `PLANNER_RESPONSE`) using an efficient per-poll tail index.
- S2: Async spawn linking, live child telemetry, and completion matching in `AgyTranscriptReader`:
  - Keep spawned subagents in `status: "running"` when `GENERIC` `"Created the following subagent..."` ack arrives; parse all `(conversationId, logAbsoluteUri)` pairs cleanly (rejecting path traversal / invalid `conversationId` via `SAFE_CONV_ID_RE` and `isInside`). Mark `status: "error"` only when `GENERIC` actually fails (`step.status === "ERROR"` or no `conversationId` when non-ack).
  - Poll each running child's `transcript.jsonl` during `pollNewEvents()` / `readSnapshot()` to update `tools`, `toolCalls`, `turns`, `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`), `model`, and redacted-safe `thinking`, emitting updated `subagent_update` events cleanly.
  - Handle `step.type === "SYSTEM_MESSAGE"` (`source: "SYSTEM"`) messages matching `sender=<conversationId>`: perform a final child transcript sync, set `status: "completed"`, `endedAt`, `durationMs`, and `result` (respecting `redactContent`), clean up active child cursor, and emit `subagent_update`.
- S3: Bridge delivery & polling responsiveness in `src/host/herdr-bridge.ts`:
  - Keep fast transcript polling active while `hasRunningSubagents()` is true (`scheduleNextPoll()`).
  - Ensure `sendSnapshot(direct)` never loses `subagent_update` events cleared by `dropQueuedEventsUpTo(this.seq)` or missing after reconnect: emit deduplicated current subagents cleanly after `agent.snapshot` (so `seq > snap.seq` reaches `Rp-relay` and `Rp-app`).
- S4: Verification & regression coverage in `test/herdr-bridge.test.ts`:
  - RED -> GREEN tests for: parallel `Subagents` array expansion + `truncated_fields`, async `GENERIC` ack keeping `running`, live child transcript polling (`tools`, `toolCalls`, `turns`, `tokens`, `model`), `SYSTEM_MESSAGE` completion with real `result` & `durationMs`, `redactContent` masking, invalid `logAbsoluteUri` traversal rejection, and `sendSnapshot(true)` re-emitting subagents after an early `pollTranscriptNow()`.

## Tasks
- T1 (S1, S2, S3, S4) [delegated: odd-worker | Risk: item 3 & item 4] Implement full AGY subagent lifecycle in `agy-transcript.ts` & `herdr-bridge.ts` with comprehensive tests in `test/herdr-bridge.test.ts`: done (verified by independent verifier `dc7af241`, 0 blockers, `test/herdr-bridge.test.ts` 28/28, `npm run test:unit` 422 passed / 1 skipped)

## Log
- L1 (2026-11-14): User request: "Vne hay un tema que cuando se crean subagentes y eso en agy.... No se pueden ver desde la aplicación.... creo que para PI si hay algo no? como podemos hacer eso....." -> "SI hagamole!"
- L2 (2026-11-14): Forecast ~260 authored lines across `agy-transcript.ts`, `herdr-bridge.ts`, and `herdr-bridge.test.ts`. High risk (items 3 & 4: wire event contract compatibility + async polling/snapshot concurrency) -> independent verifier required after worker self-verification.
- L3 (2026-11-14): `T1` completed (`Rp-plugin` worker `dbb68a66` + independent verifier `dc7af241` PASS, 0 blockers, 5/5 custom probes in `/tmp/rp-verify-agy-y4EQWl` cleaned up). Parent spot check `npm run typecheck && npm run test:unit`: 19/20 files (422 passed, 1 skipped `gentle-ai-sync` without `GENTLE_AI_BIN`).
