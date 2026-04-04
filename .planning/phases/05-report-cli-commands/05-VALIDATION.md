---
phase: 5
slug: report-cli-commands
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-04
---

# Phase 5 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (in-source testing + dedicated test files) |
| **Config file** | `apps/ccaudit/vitest.config.ts` |
| **Quick run command** | `pnpm -F ccaudit test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -F @ccaudit/internal test` or `pnpm -F @ccaudit/terminal test` (as appropriate)
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | REPT-05 | unit | `pnpm -F @ccaudit/internal test` | W0 (in-source) | pending |
| 05-01-02 | 01 | 1 | REPT-06 | unit | `pnpm -F @ccaudit/internal test` | W0 (in-source) | pending |
| 05-01-03 | 01 | 1 | REPT-04 | scaffold | `pnpm -F ccaudit test` | W0 (creates scaffold) | pending |
| 05-02-01 | 02 | 2 | REPT-01 | unit | `pnpm -F @ccaudit/terminal test` | W0 (in-source) | pending |
| 05-02-02 | 02 | 2 | REPT-07 | unit | `pnpm -F @ccaudit/terminal test` | W0 (in-source) | pending |
| 05-03-01 | 03 | 3 | REPT-01, REPT-03 | unit | `pnpm -F ccaudit test` | W0 (in-source mcp.ts) | pending |
| 05-03-02 | 03 | 3 | REPT-02, REPT-06 | typecheck | `pnpm -F ccaudit typecheck` | N/A | pending |
| 05-03-03 | 03 | 3 | REPT-05, REPT-06, REPT-07 | integration | `pnpm -F ccaudit test` | scaffold from 05-01-03 | pending |

*Status: pending | green | red | flaky*

---

## Wave 0 Requirements

- [x] `packages/internal/src/report/health-score.ts` -- in-source tests for health score algorithm (REPT-05) -- created by Plan 01 Task 1
- [x] `packages/internal/src/report/recommendation.ts` -- in-source tests for recommendation classifier (REPT-06) -- created by Plan 01 Task 2
- [x] `packages/terminal/src/tables/ghost-table.ts` -- in-source tests for table rendering (REPT-01) -- created by Plan 02 Task 1
- [x] `apps/ccaudit/src/__tests__/ghost-command.test.ts` -- integration test scaffold with fixture JSONL and assertion stubs (REPT-05, REPT-06, REPT-07) -- created by Plan 01 Task 3, filled in by Plan 03 Task 3
- [x] `apps/ccaudit/src/cli/commands/mcp.ts` -- in-source tests for mcp command wiring (REPT-03) -- created by Plan 03 Task 1

*All Wave 0 files are created by plan tasks before their consumers need them.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Terminal table visual alignment | REPT-01 | ANSI column widths depend on terminal width | Run `npx ccaudit` in 80-col and 120-col terminal; verify columns don't wrap |
| Health score badge rendering | REPT-03 | Badge visual output is subjective | Run `npx ccaudit` and verify score appears with grade label |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
