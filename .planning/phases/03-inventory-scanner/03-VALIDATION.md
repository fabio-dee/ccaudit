---
phase: 3
slug: inventory-scanner
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-04
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (in-source testing) |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `pnpm vitest run --reporter=verbose` |
| **Full suite command** | `pnpm -r test && pnpm -r typecheck` |
| **Estimated runtime** | ~8 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --reporter=verbose`
- **After every plan wave:** Run `pnpm -r test && pnpm -r typecheck`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | SCAN-01 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | SCAN-02 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | SCAN-03 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 2 | SCAN-04 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | SCAN-05 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 2 | SCAN-06 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |
| 03-02-03 | 02 | 2 | SCAN-07 | unit | `pnpm vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test fixtures for scanner modules (mock agent dirs, mock MCP config, mock skill dirs, mock memory files)
- [ ] Test fixtures for invocation ledger output from Phase 2 parser
- [ ] In-source test blocks in each scanner module

*Existing vitest infrastructure from Phase 1/2 covers framework setup.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real `~/.claude.json` parsing | SCAN-02 | Requires actual Claude Code config on machine | Run `npx ccaudit ghost` against real home dir and verify MCP servers listed |
| Git mtime interference | SCAN-03 | File mtime reset by git ops is environmental | `git checkout` a CLAUDE.md, verify scanner uses mtime not ctime |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
