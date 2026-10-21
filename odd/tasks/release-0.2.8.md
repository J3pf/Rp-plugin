# Release v0.2.8 — Herdr Bridge, Launchers, PreToolUse Permission Gate & Quality Gates
Consolidation of Luis's 6 commits (11433e1, 8cf410a, f433be5, d4d13b9, 8ac2d06, bedba6d), audits, fixes, missing tests, protocol compatibility check, quality gates, and release preparation for v0.2.8.
Branch: `main` | Status: in_progress

## Specs
- S1 (Review Luis's Commits & Fix Defects): Critically review Luis's 6 commits (11433e1, 8cf410a, f433be5, d4d13b9, 8ac2d06, bedba6d): correctness, security of the PreToolUse permission gate (no auto-approve, no bypass, fail-closed), fs.watch resource leaks/handles closed on shutdown, polling intervals bounded, cross-OS (Linux/macOS/Windows) path handling, error handling of herdr/agy/codex/claude subprocesses (timeouts, no zombie processes, no shell injection — args arrays, never string concatenation into a shell). Report findings with path:line; fix real defects test-first (RED→GREEN) in separate commits and tell me what you changed in his code.
- S2 (Missing Tests for New Behavior): Add missing tests for the new behavior (launchers, transcript activity timestamp, slash command output capture, no fake timestamps on initial poll).
- S3 (Protocol Compatibility): Protocol compatibility: confirm the messages the host now emits are accepted by relay main (e161067) and consumed by Rp-app main; list any field the app/relay must know about.
- S4 (Quality Gate): Quality gate: lint, typecheck, build, unit tests, e2e serially (`npx vitest run --no-file-parallelism test/rpc-e2e.test.ts test/tui-e2e.test.ts test/gentle-shell-e2e.test.ts`), `npm outdated` (latest stable only, no alpha/beta/rc; upgrade what is outdated), `npm audit --omit=dev`.
- S5 (Version Bump & Release Packaging): Bump 0.2.8 everywhere, English CHANGELOG + release notes crediting Luis, verify the documented install command (`pi install git:github.com/J3pf/Rp-plugin@v0.2.8` style) in an isolated scratch HOME, never the real ~/.pi.

## Review Findings & Fixes in Luis's Code (Commit `bc56d5a`)
1. **PreToolUse Fail-Closed Security Gate**:
   - `src/host/herdr-bridge.ts:844` (`handleGateSocketRequest`): `JSON.parse` failure returned `{ decision: "allow" }`. Fixed to fail-closed returning `{ decision: "ask", reason: "RP: solicitud de autorización inválida (JSON malformado)" }`.
   - `src/host/herdr-bridge.ts:848` (`handleGateSocketRequest`): Missing `conversationId` or `command` returned `{ decision: "allow" }`. Fixed to fail-closed returning `{ decision: "ask", reason: "RP: solicitud de autorización incompleta" }`.
   - `src/host/herdr-bridge.ts:904` (`runAgyHook`): Malformed stdin JSON returned `{ decision: "allow" }`. Fixed to fail-closed returning `{ decision: "ask", reason: "RP: entrada de hook inválida (JSON malformado)" }`.
   - `src/host/herdr-bridge.ts:915` (`runAgyHook`): `run_command` tool with unparseable or empty command returned `{ decision: "allow" }`. Fixed to fail-closed returning `{ decision: "ask", reason: "RP: comando no identificado; confirmar en terminal" }`.
   - `src/host/herdr-bridge.ts:581` (`requestGateApproval`): If session was already disposed, check was missing. Added immediate fail-closed return. Wrapped broker race in try/catch to return `{ decision: "ask" }` on connection teardown instead of unhandled rejection.
   - *RED test*: `it("fails closed on malformed input, missing command, or broken socket request")` in `test/herdr-bridge.test.ts` proved both malformed stdin and socket malformed payloads failed closed.
2. **Resource & Handle Leaks Closed on Shutdown**:
   - `src/host/herdr-bridge.ts:810, 730` (`startGateServer` / `stop`): Active client sockets connected to `gateServer` were untracked and leaked on shutdown. Added `clientSockets = new Set<net.Socket>()`, tracked on connection, and cleanly destroyed in `bridge.stop()`.
   - `src/host/herdr-bridge.ts:549, 661` (`handleUserMessage` / `stop`): Untracked `setTimeout(..., 800)` for slash command pane fallback kept the event loop alive. Stored in `this.commandTimer`, unref'd, and cleared in `BridgedAgentSession.stop()`.
3. **Cross-OS Quoting & Path Handling**:
   - `src/host/herdr-bridge.ts:1030` (`installAgyHooks`): On Windows (`win32`), single-quote command strings fail in cmd.exe when node or script paths contain spaces. Added platform check: uses double quotes on Windows (`"${nodePath}" "${scriptPath}" agy-hook PreToolUse`) and single quotes on POSIX.
   - *RED test*: `it("installs rp-gate in ~/.gemini/config/hooks.json while preserving existing hooks")` in `test/herdr-bridge.test.ts` verified Windows double-quoting.
4. **Subprocess & Hook Stdin Bounding**:
   - `src/host/main.ts:25` (`readStdinText`): Added 2MB limit on stdin chunk buffering to prevent memory exhaustion DoS.

## Missing Behavior Tests Added (Commit `123e95d`)
1. **Launchers**: `it("resolves and spawns agy, claude, and codex launchers")` in `test/host.test.ts` verifying `HostManager.spawn` properly handles `DEFAULT_HOST_CONFIG` launchers.
2. **Transcript Activity Timestamp**: `it("computes getLastActivityAt from entries or mtime and attaches to snapshot")` in `test/herdr-bridge.test.ts`.
3. **Slash Command Output Capture**: `it("captures slash command output via pane fallback and settles without infinite thinking")` in `test/herdr-bridge.test.ts`.
4. **No Fake Timestamps on Initial Poll**: `it("avoids fake timestamps on initial terminal snapshot and defers message_end on initial poll")` in `test/herdr-bridge.test.ts`.

## Protocol Compatibility Check (S3)
- Checked against `Rp-relay` main (`e161067`):
  - `AgentSnapshot.lastActivityAt` is accepted (`packages/protocol/src/agent.ts:60`) and used in `onSnapshot` to touch `lastSeenAt` cleanly without fake timestamps.
  - `AgentHello.launcher`, `AgentHello.herdr`, and `AgentHello.kind` are accepted and persisted in DB (`src/db/repos/agents.ts:98`).
  - `HostHello.launchers` is accepted and propagated to app.
- Checked against `Rp-app` main (`1a19981`):
  - `NewAgentScreen.kt:209`: renders `host.launchers` chips dynamically.
  - `SlashCommandCatalog.kt:154`: catalogs `/usage`, `/goal`, `/plan` for `agy`, `/review`, `/compact` for `claude`, `/review`, `/model`, `/diff` for `codex`, `/help` for `pi`.
  - `ChatScreen.kt:907`: non-pi agents route commands through Herdr bridge with `asCommand: true`.

## Tasks
- T1 (S1) [inline] Critically review Luis's 6 commits, report path:line findings, and fix real defects test-first in separate commits: done (bc56d5a)
- T2 (S2) [inline] Add missing tests for new behavior (launchers, transcript activity timestamp, slash command output capture, no fake timestamps on initial poll): done (123e95d)
- T3 (S3) [inline] Protocol compatibility: verify messages emitted by host with relay main (e161067) and Rp-app main: done
- T4 (S4) [inline] Quality gate: lint, typecheck, build, unit tests, serial e2e, npm outdated, npm audit --omit=dev: done (d516764)
- T5 (S5) [inline] Bump 0.2.8 everywhere, author English CHANGELOG and release notes crediting Luis, test isolated scratch HOME install: done (12e2421)
- T6 (S1-S5) [inline] Final verification and report "[PLUGIN 0.2.8 — READY FOR REVIEW]": done (235e4db)
- T7 (S6) [inline] Eliminate fixed wall-clock sleeps in test/herdr-bridge.test.ts (vi.waitFor), verify gentle-ai-sync test, run unit tests 10x under load (0 failures), and re-run serial e2e: done (d4255a1)

## Log
- L1: "si nada puede quedar fuera de la release"
- L2: Orchestrator feedback: guard scratch HOME install with `set -euo pipefail; SCRATCH_HOME=$(mktemp -d -p "$HOME/.cache/rp-verify"); : "${SCRATCH_HOME:?}"` and `rm -rf -- "${SCRATCH_HOME:?}"`. Gitignore `.vitest/` cache in separate commit. Keep tasks and Engram mirror synchronized.
- L3: Quality gate evidence:
  - `npm run typecheck`: clean exit 0 (`tsc --noEmit`).
  - `npm run build`: cleanly transpiled with `tsc -p tsconfig.build.json`.
  - Unit tests: 17 passed, 1 skipped (363 passed, 0 failed) in 11.91s.
  - Serial E2E tests: 3 test files passed, 21 passed (0 failed) in 157.57s (rpc: 3/3, tui: 13/13, gentle-shell: 5/5).
  - `npm audit --omit=dev`: 0 vulnerabilities.
  - `npm outdated`: only `@types/node` reported (pinned to 22.x LTS aligned with engines `>=22.19`).
- L4: Orchestrator review feedback: independent gate on git-archive failed 1 of 3 runs at test/herdr-bridge.test.ts:384 due to fixed sleeps (setTimeout). Required: eliminate all 6 fixed sleeps in test/herdr-bridge.test.ts using vi.waitFor / await session.pollTranscriptNow(), run unit tests 10x under load (0 failures), run test/gentle-ai-sync.test.ts with GENTLE_AI_BIN, re-run serial e2e, and commit in separate test: commit.
- L5: Flakiness elimination and load gate evidence:
  - Replaced all 6 fixed `setTimeout` sleeps in `test/herdr-bridge.test.ts` with `vi.waitFor` and `await session.pollTranscriptNow()`.
  - Tested `test/gentle-ai-sync.test.ts` with `GENTLE_AI_BIN=/home/linuxbrew/.linuxbrew/bin/gentle-ai`: 1/1 passed (47.91s).
  - 10× unit suite runs under concurrent vitest load (Job 5): 10/10 runs passed with 0 failures (363 tests passed per run).
  - Serial E2E tests (Job 6): 3/3 test files passed, 21 passed (0 failed) in 176.96s.
  - Separate test commit: `d4255a1`.
- L6: Orchestrator review feedback on d4255a1:
  - Fixed production antipattern: `pollTranscriptNow()` wrapped in `try/catch` logging to `this.d.onLog`, returning a Promise that never rejects. All 5 internal callers explicitly use `void this.pollTranscriptNow();` to eliminate floating promises and prevent unhandled rejections if `pollNewEvents` throws. Added RED test `it("does not produce an unhandled rejection if transcript reader throws during polling")` in `test/herdr-bridge.test.ts`. Commit `4d53a31`.
  - Justified `connection.test.ts` 5s→10s bump: purely load tolerance under CPU starvation; reconnect backoff is 20ms, but added `mk({ wsFailuresBeforeLongPoll: 10 })` to prevent premature fallback to long-poll during the 60ms restart gap, and added `this.server.closeAllConnections?.()` in `FakeRelay.stop()` to eliminate lingering keep-alive sockets.
  - 10× unit suite runs (Job 12): 10/10 consecutive runs passed with 0 failures (364 tests passed per run).
