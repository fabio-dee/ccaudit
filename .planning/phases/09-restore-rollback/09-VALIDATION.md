---
phase: 9
slug: restore-rollback
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-05
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (in-source + integration) |
| **Config file** | `vitest.config.ts` (workspace root) |
| **Quick run command** | `pnpm -F @ccaudit/internal test run` |
| **Full suite command** | `pnpm test run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -F @ccaudit/internal test run`
- **After every plan wave:** Run `pnpm test run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 9-01-01 | 01 | 1 | RMED-11 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-01-02 | 01 | 1 | RMED-11 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-01-03 | 01 | 1 | RMED-11 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-02-01 | 02 | 1 | RMED-12 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-02-02 | 02 | 1 | RMED-12 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-03-01 | 03 | 2 | RMED-13 | — | N/A | unit | `pnpm -F @ccaudit/internal test run` | ❌ W0 | ⬜ pending |
| 9-04-01 | 04 | 2 | RMED-11,12 | — | N/A | integration | `pnpm -F ccaudit test run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Plans use the in-source vitest testing pattern (`if (import.meta.vitest)` blocks embedded at the bottom of implementation files). No separate stub files are required before execution begins.

- [x] `packages/internal/src/remediation/manifest.ts` — tests embedded in-source (Plan 01 Task 1)
- [x] `packages/internal/src/remediation/restore.ts` — tests embedded in-source (Plan 01 Task 2, Plan 02 Task 2)
- [x] `packages/internal/src/remediation/frontmatter.ts` — tests embedded in-source (Plan 02 Task 1)
- [x] `apps/ccaudit/src/__tests__/restore-command.test.ts` — integration test file created by Plan 04 Task 1

*The in-source vitest pattern (`if (import.meta.vitest)`) is the established project convention from Phase 7/8. Test code is stripped from production builds via `define: { 'import.meta.vitest': 'undefined' }` in tsdown config. No external stub files are needed to satisfy Wave 0.*

*Existing `vitest.config.ts` infrastructure covers all phase requirements — no new framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Running-process gate blocks restore when Claude is running | RMED-11 | Requires live process detection | Start Claude Code, run `ccaudit restore`, verify exit 3 + message |
| `--list` output renders correctly in terminal | RMED-13 | Visual rendering | Run `ccaudit restore --list` after a bust, verify grouped output format |
| `--no-color` / `NO_COLOR` env honored | RMED-13 | ANSI stripping | Run `NO_COLOR=1 ccaudit restore --list`, verify no ANSI escape codes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
