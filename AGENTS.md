# AGENTS.md — Rp-plugin

Extension for the [Pi](https://github.com/earendil-works/pi) coding agent and companion cross-platform desktop daemon (`rp-host`). Enables mobile interaction, command execution, live terminal streaming, and local git diff review.

## Tech Stack & Architecture

- **Runtime**: Node.js >= 20, TypeScript (`tsc -p tsconfig.build.json`).
- **Target OS**: Linux (systemd `--user`), macOS (`launchd`), Windows (Task Scheduler with `conhost.exe --headless`).
- **Core Components**:
  - `src/extension/`: Pi extension hooking into `session_start`, `ui_prompt_start`, questions, and tool execution events.
  - `src/host/`: The `rp-host` daemon process that maintains WebSocket communication with the relay, executes host tools (`git.ts`, `quota.ts`, `herdr-bridge.ts`, `agy-transcript.ts`), and manages background autostart (`service.ts`).
  - `src/shared/`: Shared wire protocol types, HTTP/proxy helpers, platform path discovery, and bounded LRU utilities.

## Commands

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run typecheck without emitting files
npm run typecheck

# Build extension and host daemon
npm run build
```

## Boundaries & Non-Obvious Conventions

1. **Path Traversal & Security**:
   - Host filesystem commands (like `git_diff` and `git_discard`) MUST strictly validate paths against the authorized `roots` array configured in `host.json`.
   - Prevent any directory traversal (`..`) outside authorized workspace boundaries.
2. **Daemon Resilience & Non-Blocking Execution**:
   - The Pi extension hooks must never block or crash the user's interactive Pi terminal session if the relay or `rp-host` daemon is offline.
   - Background service installation or repair checks are strictly throttled (e.g. once every 10 minutes maximum).
3. **Patch Limits**:
   - Git diff outputs must be bounded in size (e.g., maximum file count and patch byte budget) to prevent mobile client memory exhaustion and WebSocket payload bloat.
4. **Configuration & Secrets**:
   - Never commit `host.json` if it contains private tokens or specific local directory paths.

## Verification Before Turn End

Always run `npm run typecheck && npm test` and ensure all suites pass before completing changes.
