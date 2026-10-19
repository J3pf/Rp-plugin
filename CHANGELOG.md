# Changelog

All notable changes to `@j3pf/pi-rp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  - Upgraded `gentle-pi` to `^4.3.0`.
  - Upgraded `typebox` to `^1.4.2`.

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
