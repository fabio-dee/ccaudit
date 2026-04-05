---
status: complete
phase: 08-remediation-core
source: [08-01-SUMMARY.md, 08-02-SUMMARY.md, 08-03-SUMMARY.md, 08-04-SUMMARY.md, 08-05-SUMMARY.md, 08-06-SUMMARY.md, 08-07-SUMMARY.md, 08-08-SUMMARY.md]
started: 2026-04-05T19:35:00Z
updated: 2026-04-05T19:55:00Z
---

## Current Test

[testing complete]

## Tests

### 1. --dangerously-bust-ghosts flag appears in --help
expected: Running `node apps/ccaudit/dist/index.js ghost --help` shows `--dangerously-bust-ghosts` and `--yes-proceed-busting` in the flag list.
result: pass

### 2. Non-TTY without bypass → exit 4 (ceremony enforced)
expected: Running bust without `--yes-proceed-busting` in a non-TTY context exits 4, confirming the confirmation ceremony enforces interactive consent before the checkpoint gate is reached.
result: pass

### 3. Checkpoint gate fires after TTY bypass
expected: With `--yes-proceed-busting` (TTY check bypassed) and no checkpoint, bust exits 1 with a "no checkpoint found" message. Flag is parsed correctly (no unknown-flag error).
result: pass

### 4. Running process detection (exit 3)
expected: bust exits 3 when a Claude Code process is detected. Verified via integration test fake-ps shim.
result: pass
note: manually verified — detected pids 6929, 10269 (live Claude Code windows), exited 3

### 5. Ghost agents archived to _archived/ (not deleted)
expected: Integration suite confirms ghost agent files archived to `~/.claude/agents/_archived/`; originals removed.
result: pass

### 6. MCP servers disabled via key-rename (dual-schema)
expected: Integration suite confirms keys renamed to `ccaudit-disabled:<name>` in both `~/.claude.json` and `.mcp.json` flat-schema.
result: pass

### 7. Memory files flagged with ccaudit-stale frontmatter
expected: Integration suite confirms `ccaudit-stale: true` injected into memory file frontmatter; refresh path updates timestamp only.
result: pass

### 8. Restore manifest written as JSONL
expected: Integration suite confirms JSONL manifest written to `~/.claude/ccaudit/manifests/bust-<timestamp>.jsonl` with header, ops, and footer.
result: pass

### 9. Exit codes: 0 success, 1 partial, 3 running-process, 4 non-TTY
expected: All 11 integration tests in bust-command.test.ts pass, covering the full exit code ladder.
result: pass

### 10. README documents bust command
expected: README contains `--dangerously-bust-ghosts` section with exit code ladder, --ci footgun warning, and "proceed busting" phrase.
result: pass

### 11. JSON-SCHEMA.md has bust envelope shape
expected: docs/JSON-SCHEMA.md documents all 10 BustResult variants and exit code mappings.
result: pass

### 12. Handoff doc uses two-prompt ceremony (not obsolete three-prompt)
expected: docs/ccaudit-handoff-v6.md shows [1/2]/[2/2] ceremony; "I accept full responsibility" absent.
result: pass

## Summary

total: 12
passed: 12
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none]
