---
phase: 2
slug: jsonl-parser
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-03
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.x (in-source + spec files) |
| **Config file** | `apps/ccaudit/vitest.config.ts` |
| **Quick run command** | `pnpm -r test` |
| **Full suite command** | `pnpm -r test` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -r test`
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | PARS-01 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | PARS-02 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | PARS-06 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | PARS-03 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | PARS-04 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 2 | PARS-05 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |
| 02-02-04 | 02 | 2 | PARS-07 | unit | `pnpm -r test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test fixtures: sample JSONL files (valid, malformed, mixed) in `apps/ccaudit/src/__fixtures__/`
- [ ] Test fixtures: sample subagent JSONL files
- [ ] In-source test blocks for session discovery, line parsing, and extractor modules

*Existing vitest infrastructure from Phase 1 covers framework needs. Wave 0 creates test fixtures only.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dual-path discovery on real system | PARS-01 | Requires actual `~/.claude/` directory | Run `node dist/index.js ghost --verbose` and verify both paths checked |
| Large file streaming (60MB+) | PARS-01 | Fixture files too large for repo | Create synthetic large file, run parser, verify memory stays bounded |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
