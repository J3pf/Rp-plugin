# Changelog

All notable changes to `@j3pf/pi-rp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] - 2026-10-21

Special thanks to **Luis Eduardo Chacón Wilches** ([@lchaconw](https://github.com/lchaconw)) for core architecture and implementation of the Herdr agent bridge, Antigravity CLI transcript bridge, PreToolUse permission gate, and Claude/Codex launcher integrations.

### Added
- **Herdr non-Pi agent bridge (`src/host/herdr-bridge.ts`)**:
  - Automatically discovers non-Pi agents (`agy`, `claude`, `codex`) running inside Herdr terminal panes and bridges them to Rp-relay.
  - Proxies messages, prompts, and aborts (Escape + Ctrl-C) to Herdr panes without stealing focus.
  - Periodic polling of Herdr pane output with ANSI escape code stripping, extracting recent command output and settling agent status when terminal slash commands complete.
- **Antigravity CLI (`agy`) transcript reader (`src/host/agy-transcript.ts`)**:
  - Real-time incremental streaming reader for Antigravity `transcript.jsonl` and `transcript_full.jsonl`.
  - Normalizes protojson tool calls (`run_command` -> `bash`, `view_file` -> `read`, `write_to_file` -> `write`, `replace_file_content` -> `edit`, `invoke_subagent` -> `subagent_run`) to canonical Rp-app tool cards.
  - File watcher (`fs.watch`) on transcript directories with debouncing for immediate change notification.
  - Extracts conversation topics from user requests and appends them to session display titles.
  - Preserves exact transcript activity timestamps (`lastActivityAt`) to keep mobile last seen times synchronized without fake timestamps.
- **PreToolUse permission gate (`rp-host agy-hook PreToolUse`)**:
  - Antigravity CLI PreToolUse hook integration via local IPC (Unix domain socket / Windows named pipe).
  - Evaluates bash command safety against dangerous pattern filters; routes dangerous commands to mobile for approval (`ALLOW`, `ALLOW_SESSION`, `DENY`, `DENY_REASON`).
  - Automated hook registration in `~/.gemini/config/hooks.json` via `rp-host install`.
- **Expanded launchers**:
  - Added `agy`, `claude`, and `codex` to default launchers in `host.json`, allowing the mobile app to launch non-Pi agents.

### Fixed
- **PreToolUse security hardening**:
  - Enforced fail-closed behavior across all gate endpoints: malformed JSON, unparseable arguments, missing session IDs, or socket errors reject/prompt in terminal (`decision: "ask"`), eliminating fail-open auto-approve bypasses.
  - Cross-OS path quoting in `installAgyHooks` for Windows (`win32`), using double quotes to handle paths with spaces.
  - Bounded `readStdinText` in `rp-host agy-hook` to 2MB to prevent memory exhaustion DoS.
- **Resource lifecycle and leak prevention**:
  - Tracked and cleanly destroyed active client sockets connected to `gateServer` upon `bridge.stop()`.
  - Cleared slash command fallback timers and unref'd timeout handles upon session disposal.
  - Avoided synthetic `Date.now()` timestamps on initial terminal snapshot, deferring `message_end` until actual command execution.

### Installation
```bash
# Standard Pi (~/.pi/agent)
pi install git:github.com/J3pf/Rp-plugin@v0.2.8

# gentle-shell (~/.gentle-shell/agent)
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.2.8
```

---

## [0.2.7] - 2026-10-19

> **Note on v0.2.6:** Tag `v0.2.6` was created on git commit `d11ff11` without an associated GitHub release. Release `v0.2.7` encompasses all improvements from `v0.2.6` along with subsequent stability, performance, and security enhancements.

Special thanks to **Luis Eduardo Chacón Wilches** ([@lchaconw](https://github.com/lchaconw)) for core contributions to mobile slash commands, delivery queue concurrency, branch replay performance, and subagent memory bounding.

### Added
- **Mobile `/model` and `/thinking` slash commands**:
  - Support setting model directly via `/model <provider/modelId>` or `/model <modelId>` using `pi.setModel`.
  - Interactive model picker via `ctx.ui.select` when `/model` is invoked without arguments.
  - Support setting thinking level via `/thinking <level>` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) using `pi.setThinkingLevel`.
  - Interactive thinking level picker via `ctx.ui.select` when `/thinking` is invoked without arguments.
  - Slash commands are acknowledged immediately with `disposition: "command"` and recorded in telemetry.
- **Thinking telemetry synchronization**:
  - Emit `thinking_level_select` event over the relay when mobile updates the thinking level, broadcasting `{ level, previousLevel }` to maintain client-session parity.
- **Regression test suite expansion**:
  - Comprehensive unit and integration test coverage for thinking level telemetry propagation, interactive select non-blocking behavior, subagent tool bounding, and backward branch replay.

### Changed
- **Delivery queue concurrency**:
  - Detached interactive `/model` and `/thinking` selectors from the sequential delivery queue, allowing subsequent messages and commands to be processed without blocking on open user dialogs.
- **Subagent memory bounding**:
  - Bounded `SubagentTracker` tool execution history to `MAX_SUBAGENT_TOOLS = 100`, preventing unbounded memory growth in long-running agent workflows while preserving the accurate cumulative `toolCalls` counter.
- **Todo branch replay performance**:
  - Optimized `replayTodoBranch` to scan backward from the branch tip, returning the active todo list in $O(1)$ time rather than traversing the entire session history.
- **Type safety hardening**:
  - Replaced `any` types in slash command handlers and delivery interfaces with strict TypeScript types (`PiModel`, `ThinkingLevelParam`, `ValidThinkingLevel`, and `unknown` error narrowing).

### Security & Dependencies
- **Security patch**:
  - Overrode transitive dependency `basic-ftp` to `^6.2.3` via npm overrides, resolving high-severity advisory GHSA-c475-qrg2-pj4r (CPU denial of service in Unix directory-listing parser).
  - Verified clean production audit: `npm audit --omit=dev` reports 0 vulnerabilities.
- **Dependency upgrades**:
  - Upgraded toolchain: `typescript` to `^7.0.2` and `vitest` to `^5.0.5` (aligned with Rp-relay toolchain).
  - Upgraded Pi SDK devDependencies: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to `^1.3.0` (validated against unit and serial E2E test suites), keeping `peerDependencies` as `*` for broad runtime compatibility.
  - Upgraded `gentle-pi` to `^4.3.0`.
  - Upgraded `typebox` to `^1.4.2`.
  - Maintained `@types/node` on `^22.20.5` strictly aligned with the package engine constraint (`node >= 22.19`).

### Installation
```bash
# Standard Pi (~/.pi/agent)
pi install git:github.com/J3pf/Rp-plugin@v0.2.7

# gentle-shell (~/.gentle-shell/agent)
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.2.7
```

---

## [0.2.5] - 2026-10-17

### Added
- Service self-healing and lifecycle hardening across Linux (`systemd --user`), macOS (`launchd`), and Windows (`Task Scheduler`).
- Telemetry redaction support for subagent tasks, todos, and session snapshots.
- Subagent timestamp normalization to epoch milliseconds.
- Prompt adapters for `pi-ask-user` and gentle-pi custom dialogs.
