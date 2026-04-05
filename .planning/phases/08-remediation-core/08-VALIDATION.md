---
phase: 8
slug: remediation-core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-05
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `08-RESEARCH.md § Validation Architecture`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.x (in-source tests via `if (import.meta.vitest)`) |
| **Config file** | `vitest.config.ts` (root projects mode) + per-workspace configs (`packages/internal/vitest.config.ts`, `packages/terminal/vitest.config.ts`, `apps/ccaudit/vitest.config.ts`) |
| **Quick run command** | `pnpm exec vitest --run packages/internal/src/remediation/` |
| **Full suite command** | `pnpm exec vitest --run --coverage` |
| **Estimated runtime** | ~5 seconds (quick, module-scoped) / ~25 seconds (full suite with coverage) |
| **CI matrix** | `ubuntu-latest`, `macos-latest` — SC-9 adds `windows-latest` |

---

## Sampling Rate

- **After every task commit:** Run `pnpm exec vitest --run packages/internal/src/remediation/` (remediation-module-scoped, sub-5s)
- **After every plan wave:** Run `pnpm exec vitest --run --coverage` (full workspace, covers regression against Phase 7 checkpoint/change-plan/savings)
- **Before `/gsd:verify-work`:** Full suite must be green on ubuntu + macos + windows (OS matrix all pass)
- **Max feedback latency:** 5 seconds for quick run, 25 seconds for full suite

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 8-WAVE0-01 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/atomic-write.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-02 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/collisions.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-03 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/processes.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-04 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-05 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/manifest.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-06 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-07 | (Wave 0) | 0 | REQ-infra | fixture | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ W0 | ⬜ pending |
| 8-WAVE0-08 | (Wave 0) | 0 | SC-9 | CI | `grep -q 'windows-latest' .github/workflows/ci.yaml` | ❌ W0 | ⬜ pending |
| 8-WAVE0-09 | (Wave 0) | 0 | RMED-02 | docs | `grep -q 'checkpoint is recent' .planning/REQUIREMENTS.md && exit 1 \|\| exit 0` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED01 | (TBD by planner) | TBD | RMED-01 | integration (subprocess) | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED02 | (TBD by planner) | TBD | RMED-02 | unit | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED03 | (TBD by planner) | TBD | RMED-03 | unit + mocked-spawn | `pnpm exec vitest --run packages/internal/src/remediation/processes.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED03-D04 | (TBD by planner) | TBD | RMED-03 (D-04) | unit with mocked ps | `pnpm exec vitest --run packages/internal/src/remediation/processes.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED04 | (TBD by planner) | TBD | RMED-04 | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED05 | (TBD by planner) | TBD | RMED-05 | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED06 | (TBD by planner) | TBD | RMED-06 | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED07 | (TBD by planner) | TBD | RMED-07 | unit (10 fixtures) | `pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED07-D07 | (TBD by planner) | TBD | RMED-07 (D-07) | unit | `pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED08 | (TBD by planner) | TBD | RMED-08 | integration with tmpdir | `pnpm exec vitest --run packages/internal/src/remediation/manifest.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED09 | (TBD by planner) | TBD | RMED-09 | unit with mocked rename | `pnpm exec vitest --run packages/internal/src/remediation/atomic-write.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED09-SC9 | (TBD by planner) | TBD | RMED-09 / SC-9 | integration on windows-latest | `pnpm exec vitest --run` (OS matrix job) | ❌ W0 | ⬜ pending |
| 8-TASK-RMED09-REG | (TBD by planner) | TBD | RMED-09 (regression) | unit | `pnpm exec vitest --run packages/internal/src/remediation/checkpoint.ts` | ✅ Exists | ⬜ pending |
| 8-TASK-RMED10-D15 | (TBD by planner) | TBD | RMED-10 (D-15) | unit with mocked stdin | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED10-D16 | (TBD by planner) | TBD | RMED-10 (D-16) | integration (subprocess) | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-RMED10-D17 | (TBD by planner) | TBD | RMED-10 (D-17) | integration (piped stdin) | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-EXIT-CODES | (TBD by planner) | TBD | Exit code ladder | integration (subprocess, all 5 codes) | `pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts` | ❌ W0 | ⬜ pending |
| 8-TASK-D14-HYBRID | (TBD by planner) | TBD | D-14 failure policy | unit + integration | `pnpm exec vitest --run packages/internal/src/remediation/bust.ts` + subprocess test | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

> Planner MUST replace the `(TBD by planner)` Plan column entries with concrete plan IDs (e.g., `8-01`, `8-02`) once plans are created, and reassign Wave numbers matching the plan frontmatter.

---

## Wave 0 Requirements

These test-infrastructure files MUST exist (or their in-source test blocks MUST be stubbed) before Wave 1 begins. Every Wave 0 item maps to at least one RMED requirement.

- [ ] `packages/internal/src/remediation/atomic-write.ts` + in-source tests — extract Phase 7 atomic-write pattern + add EPERM retry loop with mocked `fs.rename` (graceful-fs schedule: 10ms initial, +10ms/retry capped at 100ms, 10s total). **Covers RMED-09.**
- [ ] `packages/internal/src/remediation/collisions.ts` + in-source tests — `appendIsoTimestampSuffix(name: string, suffix: 'filename' | 'jsonKey'): string` + companion resolver. **Covers D-05, D-06.**
- [ ] `packages/internal/src/remediation/processes.ts` + in-source tests — `ps`/`tasklist` parsing with mocked `child_process.spawn` output, self-pid + parent-chain walk with mocked `process.ppid`. **Covers RMED-03, D-02, D-04.**
- [ ] `packages/internal/src/remediation/frontmatter.ts` + in-source tests — 10-fixture set covering: no frontmatter, empty frontmatter, flat key:value, existing ccaudit-stale key, existing ccaudit-flagged key, nested YAML (skip), multi-doc YAML (skip), CRLF line endings, BOM, unicode content. **Covers RMED-07, D-07, D-08.**
- [ ] `packages/internal/src/remediation/manifest.ts` + in-source tests — JSONL append with `fs.open('a') + fd.write + fd.sync()`, header/footer records, schema types + runtime validators, crash-tolerant reader (skip truncated final line). **Covers RMED-08, D-09 through D-12.**
- [ ] `packages/internal/src/remediation/bust.ts` + in-source tests — orchestrator with injected dependencies (`checkpointReader`, `processDetector`, `confirmationPrompt`, `manifestWriter`) so unit tests assert the full pipeline without real `fs`/`child_process`. **Covers RMED-01, RMED-02, D-13, D-14, D-15.**
- [ ] `apps/ccaudit/src/__tests__/bust-command.test.ts` — subprocess integration test spawning `dist/index.js --dangerously-bust-ghosts` with `tmpdir` HOME override, asserts exit codes 0/1/2/3/4 across scenarios, asserts piped-stdin non-TTY exit 4, asserts `--yes-proceed-busting` bypass, asserts `--ci` implication. **Covers RMED-01, RMED-10, D-15, D-16, D-17.**
- [ ] `.github/workflows/ci.yaml` — add `windows-latest` to the OS matrix test job. **Covers SC-9.**
- [ ] `.planning/REQUIREMENTS.md` RMED-02 amendment — drop "checkpoint is recent" gate wording, replace with "two-stage gate: (1) checkpoint exists, (2) hash matches current inventory". **Covers D-01 amendment.**

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Confirmation prompt UX reads correctly at a real terminal (line wrapping, emoji, color) | RMED-10 (D-15) | TTY rendering depends on terminal emulator; automated stdin mock cannot verify visual appearance | Run `dist/index.js --dangerously-bust-ghosts` in Terminal/iTerm/Windows Terminal after a successful `--dry-run`. Visually verify: change-plan display is readable, `[1/2] Proceed busting? [y/N]:` fits on one line, `[2/2] Type exactly: proceed busting` is unambiguous. |
| `ccaudit --dangerously-bust-ghosts` from inside a Claude Code session produces the D-04 custom "open a standalone terminal" error | RMED-03 (D-04) | Requires a live Claude Code session as the parent process; automated test can mock `process.ppid` but the end-to-end UX footgun must be verified in real conditions | From inside a Claude Code Bash tool: `npx ccaudit@latest --dangerously-bust-ghosts` — verify exit 3 with message naming self-invocation and pointing at a standalone terminal. |
| Windows `tasklist`/`wmic` parent-pid lookup works on Windows 11 (wmic may be deprecated) | RMED-03 | Researcher has no Windows machine; CI matrix catches regression but developer experience on Win 11 needs a spike | On first `windows-latest` CI run, inspect log output for `processes.ts` test diagnostics. If `wmic` command not found, add PowerShell `Get-CimInstance Win32_Process` fallback. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (all commands use `--run`)
- [ ] Feedback latency < 5s for quick, < 25s for full
- [ ] `nyquist_compliant: true` set in frontmatter once all Wave 0 items complete and plan task IDs are backfilled

**Approval:** pending
