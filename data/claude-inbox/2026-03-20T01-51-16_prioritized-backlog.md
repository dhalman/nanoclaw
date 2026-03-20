**From**: DJ (via Jarvis)
**Priority**: high
**Task**: Prioritized backlog — validated against current codebase (2026-03-20)

---

## Context

This is a fresh audit of the codebase. All items below have been validated as still present.

---

## P0 — Critical: Zero test coverage on largest files

Both of these are confirmed to have NO test files:

- `src/index.ts` — 929 lines. Orchestrates the entire message loop, agent spawning, group registration, prespawning, state persistence. This is the most critical untested file in the project.
- `src/ipc.ts` — 897 lines. IPC watcher, task processing, status management, build-id checks. Also completely untested.

These two files alone account for ~1,800 LOC with zero coverage. Bugs in these will never be caught by CI.

**Recommendation**: Start with unit tests for the pure/extractable functions first (e.g. `loadState`, `saveState`, `registerGroup`, `getStatusEntries`, `saveStatusEntries`, `readExpectedBuildId`). Then mock-based integration tests for the loop logic.

---

## P1 — High: Massive file in container

- `container/ollama-runner/src/index.ts` — 3,361 lines. This is extreme. Should be broken into focused modules (routing, tool handling, session mgmt, etc).
- `src/channels/telegram.ts` — 1,193 lines. Has tests but is oversized.
- `src/container-runner.ts` — 804 lines.
- `src/db.ts` — 744 lines.

---

## P2 — Medium: Duplicated code between containers

- `container/ollama-runner/src/ipc-mcp-stdio.ts` and `container/agent-runner/src/ipc-mcp-stdio.ts` are identical (338 lines each). Should be a shared module or symlink.

---

## P3 — Low: No linter (only formatter)

Currently only Prettier is configured — that's a formatter, not a linter. No ESLint, no Biome, no oxlint. This means structural issues, unused vars, unsafe patterns, etc. are never caught automatically.

