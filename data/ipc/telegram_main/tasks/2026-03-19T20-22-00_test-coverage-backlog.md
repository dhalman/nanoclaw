**From**: Andy (AI assistant)
**Priority**: high
**Task**: Prioritized backlog — test coverage gaps & bug risk (audit 2026-03-19)
**Context**: DJ flagged recurring bugs and asked for a full test coverage + test plan audit. Below is the prioritized backlog based on a codebase-wide analysis.

---

# Prioritized Backlog: Test Coverage & Bug Fixes

## 🔴 P0 — Critical (address immediately)

### 1. Add tests for `src/index.ts` (848 LOC — main orchestrator, ZERO tests)
- This is the heart of the system: message loop, state management, agent invocation, session lifecycle
- No tests means regressions are invisible until they hit production
- Suggested coverage:
  - Message receive → route → agent dispatch cycle
  - State transitions (idle, processing, queued)
  - Error handling / crash recovery in the main loop
  - Group queue draining behavior

### 2. Add tests for `src/ipc.ts` (848 LOC — IPC watcher, ZERO tests)
- Handles file-based IPC for task injection and container communication
- No tests for: file watching, message parsing, auth validation, error paths
- Suggested coverage:
  - File watcher detects new task files correctly
  - Malformed/unauthorized task files are rejected safely
  - Task execution lifecycle (queued → running → done)
  - Concurrent task handling

---

## 🟠 P1 — High (next sprint)

### 3. Add tests for `src/config.ts` (101 LOC — config loading, ZERO tests)
- Config parsing failures can silently misconfigure the whole system
- Suggested coverage:
  - Required env vars missing → clear error thrown
  - YAML config file parsing edge cases
  - Config merging / override precedence

### 4. Increase test coverage for `src/task-scheduler.ts` (264 LOC, only 129 LOC of tests)
- Previous double-execution bug (issues #138, #669) was fixed but indicates fragile timing logic
- Tests are thin relative to complexity
- Suggested coverage:
  - Task fires exactly once even if container runtime exceeds poll interval
  - Cron expression edge cases (DST transitions, leap years)
  - Paused / cancelled task does not fire
  - `once` tasks auto-delete after firing

### 5. Increase test coverage for `src/container-runner.ts` (795 LOC, only 353 LOC of tests — ~44%)
- Largest module with relatively thin coverage
- Suggested coverage:
  - Mount security validation paths
  - Container spawn failure → graceful error propagation
  - Credential injection correctness
  - Cleanup on crash / SIGTERM

---

## 🟡 P2 — Medium (backlog)

### 6. Add integration test: full message → agent → response cycle
- Unit tests cover modules in isolation but there's no end-to-end test
- A single happy-path integration test would catch wiring regressions
- Could use a mock Telegram update + stub container runner

### 7. Audit `src/channels/telegram.ts` edge case coverage (1,123 LOC)
- Test file exists (1,173 LOC) but at this size there are likely many untested branches
- Focus areas: media handling (video cancel, transcription), rate limiting, webhook validation

### 8. Fix and document container build cache invalidation
- `--no-cache` does NOT invalidate COPY steps in buildkit
- No test or CI check catches stale container images
- Add a pre-build step or CI check to run `docker buildx prune` when source changes

### 9. Audit `src/group-queue.ts` for race conditions (443 LOC)
- Queue draining is concurrency-sensitive; current tests may not cover concurrent group messages
- Add tests for: two groups processing simultaneously, queue overflow behavior

---

## 🟢 P3 — Low / housekeeping

### 10. Add tests for `src/logger.ts` and `src/channels/index.ts`
- Tiny files (16 and 13 LOC) but currently untested

### 11. Enforce coverage thresholds in CI
- `@vitest/coverage-v8` is installed but no minimum threshold is enforced
- Add `--coverage` to test script with a minimum threshold (e.g. 80%) to prevent future regressions

### 12. WhatsApp migration test
- v1.2.0 moved WhatsApp to a separate skill requiring `/add-whatsapp`
- No automated test verifies the migration path works correctly for existing users

---

## Summary Table

| Priority | Item | Untested LOC |
|----------|------|-------------|
| P0 | index.ts tests | 848 |
| P0 | ipc.ts tests | 848 |
| P1 | config.ts tests | 101 |
| P1 | task-scheduler.ts coverage boost | ~135 |
| P1 | container-runner.ts coverage boost | ~442 |
| P2 | Integration test | — |
| P2 | Telegram edge cases | — |
| P2 | Build cache / queue audits | — |
| P3 | Logger, CI coverage enforcement, WhatsApp | — |

**Total untested production code: ~1,798 LOC (35% of codebase), concentrated in the orchestration (index.ts) and IPC layers.**
