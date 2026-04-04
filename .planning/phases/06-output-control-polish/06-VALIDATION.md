---
phase: 06
slug: output-control-polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-04
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.x |
| **Config file** | `apps/ccaudit/vitest.config.ts`, `packages/internal/vitest.config.ts`, `packages/terminal/vitest.config.ts` |
| **Quick run command** | `pnpm -F ccaudit test` |
| **Full suite command** | `pnpm -r test` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -F ccaudit test`
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | OUTP-02 | unit | `pnpm -F @ccaudit/terminal test` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | OUTP-03,04 | unit | `pnpm -F ccaudit test` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | OUTP-01 | unit | `pnpm -F ccaudit test` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 2 | OUTP-05 | unit | `pnpm -F ccaudit test` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 2 | OUTP-06 | unit | `pnpm -F ccaudit test` | ✅ partial | ⬜ pending |
| 06-03-02 | 03 | 2 | OUTP-07 | unit | `pnpm -F ccaudit test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test stubs for NO_COLOR / --no-color color stripping
- [ ] Test stubs for --quiet output suppression
- [ ] Test stubs for exit code semantics
- [ ] Test stubs for --ci flag composition
- [ ] Test stubs for --csv export format

*Existing --json and --verbose tests partially exist from Phase 5.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| NO_COLOR terminal rendering | OUTP-02 | Requires visual inspection | Run `NO_COLOR=1 npx ccaudit ghost` and verify no ANSI codes in output |
| README publication quality | SC-5 | Subjective quality check | Review README.md for completeness and accuracy |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
