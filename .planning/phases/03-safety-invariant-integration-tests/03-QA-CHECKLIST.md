# Phase 03 Manual QA Checklist

Phase 3 interactive-path manual verification. Run after `pnpm build` produces a fresh
`apps/ccaudit/dist/index.js`. Automation covers subprocess flows; this checklist covers
the visible TUI and human-observable terminal behaviors.

---

## Environment Requirements

- macOS or Linux with a graphical terminal emulator
- Node >=20 available on PATH
- `ccaudit` binary: `apps/ccaudit/dist/index.js` (run `pnpm build` first)
- `CCAUDIT_FORCE_TTY` must NOT be set during manual QA
- Fixture: at least one ghost agent at `~/.claude/agents/` (or use a throwaway tmpHome)

---

## Terminal Matrix

### iTerm2 (macOS)

| # | Check | Expected | Pass | Notes |
|---|-------|----------|------|-------|
| 1 | Run `ccaudit ghost` | Picker opens with ghost list | [ ] | Verify item rows render correctly |
| 2 | Press Space to toggle selection | Selected item shows a marker (e.g. `[x]`) | [ ] | |
| 3 | Press Enter to confirm selection | Confirmation screen renders ASCII box with item summary | [ ] | |
| 4 | Press Ctrl+C before confirming | Process exits with "No changes made." printed to stderr | [ ] | No partial writes |

### kitty (Linux / macOS)

| # | Check | Expected | Pass | Notes |
|---|-------|----------|------|-------|
| 1 | Run `ccaudit ghost` | Picker opens with ghost list | [ ] | Verify item rows render correctly |
| 2 | Press Space to toggle selection | Selected item shows a marker (e.g. `[x]`) | [ ] | |
| 3 | Press Enter to confirm selection | Confirmation screen renders ASCII box with item summary | [ ] | |
| 4 | Press Ctrl+C before confirming | Process exits with "No changes made." printed to stderr | [ ] | No partial writes |

### Gnome Terminal (Linux)

| # | Check | Expected | Pass | Notes |
|---|-------|----------|------|-------|
| 1 | Run `ccaudit ghost` | Picker opens with ghost list | [ ] | Verify item rows render correctly |
| 2 | Press Space to toggle selection | Selected item shows a marker (e.g. `[x]`) | [ ] | |
| 3 | Press Enter to confirm selection | Confirmation screen renders ASCII box with item summary | [ ] | |
| 4 | Press Ctrl+C before confirming | Process exits with "No changes made." printed to stderr | [ ] | No partial writes |

---

## ASCII Fallback Check

Run with `CCAUDIT_ASCII_ONLY=1` (or equivalent terminal without Unicode support).

| # | Check | Expected | Pass | Notes |
|---|-------|----------|------|-------|
| 1 | Run `CCAUDIT_ASCII_ONLY=1 ccaudit ghost` | Picker renders with `[r]`/`[s]` glyphs instead of Unicode symbols | [ ] | |
| 2 | Confirmation box is plain ASCII | No Unicode box-drawing characters; corners use `+`, edges use `-` and `\|` | [ ] | |

---

## Sign-off Block

| Field | Value |
|-------|-------|
| Tester name | |
| Date | |
| iTerm2 version | |
| kitty version | |
| Gnome Terminal version | |
| Node version | |
| ccaudit version | |
| OS and version | |
| All checks passed? | [ ] Yes / [ ] No — see Notes |

**Notes / Failures:**

(fill in any failures or deviations here)

---

## Acceptance Criteria

All cells in the Terminal Matrix must be checked. ASCII fallback checks must be checked.
Sign-off block must be completed and dated. If any check fails, file an issue before
merging Phase 3 feature branches.
