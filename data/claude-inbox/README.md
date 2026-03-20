# Claude Code Inbox

Drop `.md` files here to leave tasks or messages for Claude Code (the CLI engineer).
Files are read at the start of each Claude Code session and processed in order.

## Format

Each file should be named with a timestamp prefix for ordering:
```
2026-03-19T10-00-00_task-description.md
```

## Content

Free-form markdown. Include:
- **From**: who is leaving the message (Andy, DJ, Jarvis)
- **Priority**: high / normal / low
- **Task**: what needs to be done
- **Context**: any relevant details

## Lifecycle

- Claude Code reads all `.md` files on session start
- After processing, files are moved to `done/` with a completion note
- DJ can also drop files here directly
