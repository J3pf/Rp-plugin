# Feature: 4R Hardening — `Rp-plugin` (`v0.4.6`)
Branch: `fix/4r-hardening` | Delivery: `ask-on-risk` | Forecast: ~1,200 authored changed lines | Runner: `cd Rp-plugin && npm run typecheck && npm run build && npm test`
Mirror: pending (workspace root is ambiguous across sibling repos in Engram)

## Specs

### S1 — Extension transport, snapshot cap, prompts, delivery & `/rp doctor` (`B-02`, `C-02`, `C-03`, `C-09`, `W-01`, `W-05`, `W-08`, `W-10`, `W-11`, `W-12`, `W-14`, `W-15`, `S-02`, `S-03`)
- Fix `LongPollTransport` wire contract: send JSON object `{ agentId, instance, timeout: 25_000 }` on `POST /v1/agent/poll`, map HTTP `410 { closeCode }` in `fail()`, check `rejected > 0` on `/v1/agent/send`, cap `outbox` & batch byte size, and fail non-2xx/non-JSON polls with backoff. Tighten `FakeRelay` in `test/helpers.ts`.
- In `src/shared/http.ts`: handle premature incomplete `res.on("close")`, add total deadline timer, and memoize in-flight `getProxyAgent()` Promise.
- In `src/extension/connection.ts`: add jitter/backoff on `CLOSE.SERVICE_RESTART` (`1012`), `.unref()` `reconnectTimer`, flush `connectedWaiters`/`queue` & clear timers on fatal closes (`4001`/`4002`/`4003`), guard `ws.on("open")` against `closed`/`stopped`, and only reset `attempt`/`wsFailures` after a connection stability window.
- Enforce a serialized byte budget (~220 KB) in `buildSnapshotEntries` (`src/extension/snapshot.ts`), truncate `thinking`/`toolCall.args`/`tool_execution_start.args`/summaries (`src/extension/forwarder.ts`), and guard outgoing frames against `MAX_FRAME_BYTES`.
- Strict `parseOptionIndex` (`/^\d+$/`) across `broker.ts` & all prompt adapters + `Array.isArray(optionIds)` in `review-consent.ts` + deduplicate `questionIndex` in `gentle-ask-user-question.ts`.
- Harden `Gate.allowKey()` against env prefixes (`KEY=VAL`), unlisted shell wrappers (`eval`, `exec`, `command`, `source`, `.`, `timeout`, `nohup`, `nice`, `time`, `setsid`, `stdbuf`, `awk`, `ssh`, `docker`), quoted binaries, and `\r`.
- Fix `AdapterRegistry.customMirror` async factory handling and add `.catch()` on `remoteAnswer.then(...)`.
- Add bounded timeouts on `waitSettled()` and `activeSelectPromises` + `.catch(() => {})` on `task.finally(...)`; pass `onLog` from `Runtime` to `Connection`.
- Fix `updateConfigFile()` to only fall back to `{}` on `ENOENT`; clean up `.tmp` on error in `atomicWriteFileSync`; fix `truncateBytes` UTF-8 multi-byte boundary.
- Fix `/rp doctor` (`src/extension/commands.ts` & `test/commands.test.ts`) to accept `git:` plugin installs (`Rp-plugin`) and recommend GitHub release install ref.

### S2 — Host backends, git confinement/monorepo, validation, `HostConnection` & config/inbox (`B-01`, `C-08`, `C-09`, `W-03`, `W-04`, `W-07`, `W-11`, `W-12`, `W-13`, `W-14`, `S-01`, `S-04`)
- Eliminate Windows `ConsoleBackend` `cmd.exe /c start` quote-escaping command injection (`src/host/backends/windows.ts`) by spawning the allowlisted launcher directly (or never passing `req.name` into `cmd.exe`).
- Fix `gitDiff` & `gitDiscard` (`src/host/git.ts`): verify `realpathSync(--show-toplevel)` is within `cfg.roots` and set `GIT_CEILING_DIRECTORIES`, scope `git status -- <filter ?? ".">`, translate repo-root-relative porcelain paths to `cwd`-relative for monorepo subdirs, normalize POSIX `./`/`\` paths, add `SIGKILL` escalation to `execGit()`, recompute remaining deadline per diff call, and budget JSON-serialized patch bytes below `MAX_FRAME_BYTES`.
- Fix `resolveWithinRoots` (`src/host/validate.ts`) filesystem existence/file-type oracle by checking lexical containment first and realpath containment before `isDirectory()`; sanitize `fallback` and strip leading `-` in `sanitizeLabel`; reuse `SAFE_CONV_ID_RE`.
- Fix `HerdrBackend.ensureServer()` (`src/host/backends/herdr.ts`): clear `lastServerStartAt` cooldown only on success, abort 20-iteration loop on child error/exit, escalate to `SIGKILL` on timeout.
- In `src/host/connection.ts`: add jitter/backoff on `1012`, guard `ws.on("open")` against `stopped`/`this.ws !== ws`, cap concurrent in-flight host RPCs, and log WS errors/reconnect transitions.
- Switch `writeRawHostConfig` (`src/host/config.ts`) & `HostManager.save` (`src/host/manager.ts`) to `atomicWriteFileSync`; run `cleanupExpiredInboxFiles()` periodically in `rp-host run` (`src/host/main.ts`) and hoist single `loadHostConfig()` in `doctor`.

### S3 — `herdr-bridge`, `agy-hooks`, `agy-transcript` & `external-metadata` hardening (`C-01`, `C-04`, `C-05`, `C-06`, `C-07`, `C-10`, `W-02`, `W-06`, `W-08`, `W-09`, `W-14`, `S-01`, `S-04`)
- In `src/host/bridge/agy-hooks.ts`: fail closed in `verifyGateSignature` (`if (!expected) return false;`) and require `cfg.enabled && cfg.machineToken` in `runAgyHook`.
- In `src/host/agy-transcript.ts`: guard `openSync`/`readSync` with `try/catch` returning `null`, isolate child/bg cursor polling, enforce non-symlink `lstatSync` + `realpathSync` containment in `resolveTaskLogPath` (strictly inside `tasks/`) & `resolveChildTranscriptPath`, cap & expire stale `bgTasks` cursors when Herdr reports `idle`/`done`, and fix misplaced JSDoc.
- In `src/host/herdr-bridge.ts`: track `ownsGateSocket` + inode before unlinking `agy-gate.sock` in `stop()`, always send `sendSnapshot(true)` on welcome unless `w.lastSeq >= this.seq` with empty queue, guard `commandTimer` and `sendSnapshot()` against transcript read errors, pass `onSessionClosedByCommand` to gate-created sessions, harden `gateServer` (`maxConnections`, single-request guard, `.catch()`, `writableEnded`, unsigned `"ask"` on failed HMAC, `validatePaneId`), use `atomicWriteFileSync` for persisted sessions, use `stripAnsi` in `handleTermCommand`, remove unused `randomBytes` import, and log `herdr agent list` error/recovery transitions.
- In `src/host/bridge/external-metadata.ts`: add `readJsonlHeadLine` from offset `0` for `matchesCodexCwd`, fix `readAgySessionModel` regex to allow `.` in versioned model names, and cache `readAgySessionModel` by `(sessionId, dbMtimeMs, transcriptMtimeMs)` with >=10s throttle & `timeout <= 25ms`.

### S4 — Protocol/contract alignment, CI security & `dist/` parity (`C-11`, `W-16`)
- Align `src/shared/protocol.ts` & `test/contract.ts` (`host.herdr_layout.result` + `host.*` response coverage + `QuotaCollector` tests) with canonical `Rp-relay` protocol schemas.
- Add `permissions: { contents: read }`, full Windows unit test run, and `git diff --exit-code -- dist` parity check to `.github/workflows/ci.yml`.
- Rebuild `dist/` (`npm run build`) and verify `npm run typecheck && npm test`.

## Tasks

- [x] **T1** (`S1`) — Extension transport, snapshot cap, prompts, delivery & `/rp doctor` | Route: delegated (`odd-writer`, parallel with T2, T3) | Status: done | Commit: `cfee6b5` (493/493 unit tests green)
- [x] **T2** (`S2`) — Host backends, git confinement/monorepo, validation, `HostConnection` & config/inbox | Route: delegated (`odd-writer`, parallel with T1, T3) | Status: done | Commit: `de3680e` (493/493 unit tests green)
- [x] **T3** (`S3`) — `herdr-bridge`, `agy-hooks`, `agy-transcript` & `external-metadata` hardening | Route: delegated (`odd-writer`, parallel with T1, T2) | Status: done | Commit: `21be13e` (493/493 unit tests green)
- [x] **T4** (`S4`) — Protocol/contract alignment, CI security & `dist/` rebuild | Route: delegated (`odd-writer`) | Status: done | Commit: committed-below (25 passed / 516 tests green, `dist/` synced)

## Log

- **L1 (2026-11-24)**: User request verbatim: `"OK si hagamole, hasta suggestion o warnings si son reales"` (Stage 2 of `Rp-relay` -> `Rp-plugin` -> `Rp-app`).
- **L2 (2026-11-24)**: Created feature branch `fix/4r-hardening` from `main` (`703e6ce`) in `Rp-plugin`. Launching Wave 1 (`T1`, `T2`, `T3` with strictly disjoint edit surfaces) in parallel with `Rp-relay`'s read-only independent verifier.
- **L3 (2026-11-24)**: `Rp-relay` independent verifier returned PASS on S1–S5 (0 blockers). `Rp-plugin` Wave 1 verified (`npm run typecheck && npm run test:unit`: 22 passed / 493 tests passed). Committed `T1` (`cfee6b5`), `T2` (`de3680e`), and `T3` (`21be13e`). Launching final unit `T4` (protocol/contract alignment, QuotaCollector tests, CI security & `dist/` rebuild).
- **L4 (2026-11-24)**: `T4` verified (`npm run typecheck && npm run build && npm test`: 25 passed / 516 passed tests, `dist/` synced, `node bin/rp-host.mjs --help` OK). Launching independent feature-end verifier on `703e6ce..HEAD`.
