---
phase: 7
slug: dry-run-checkpoint
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-04
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `.planning/phases/07-dry-run-checkpoint/07-RESEARCH.md` §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.2 (from catalog, already in devDependencies) |
| **Config file** | `vitest.config.ts` at repo root (projects mode; inherits coverage from root) |
| **Quick run command** | `pnpm --filter @ccaudit/internal test` (isolated, <10s) |
| **Full suite command** | `pnpm -w test --coverage` |
| **Estimated runtime** | ~30–45 seconds full suite; <10s per-package |

---

## Sampling Rate

- **After every task commit:** `pnpm --filter @ccaudit/internal test` (package under change)
- **After every plan wave:** `pnpm -w test --coverage` (enforces 80 lines / 80 functions / 80 statements / 70 branches — `vitest.config.ts:49-62`)
- **Before `/gsd:verify-work`:** Full suite must be green on both `ubuntu-latest` and `macos-latest` (Phase 6 CI matrix)
- **Max feedback latency:** 45 seconds

---

## Per-Task Verification Map

Populated by `gsd-planner` during plan generation. Each row below is derived from the RESEARCH.md §Validation Architecture test matrix (lines 1055+). `gsd-planner` MUST wire each DRYR-01/02/03 entry to a concrete task ID in the PLAN files and set the Automated Command column verbatim.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-PP-TT | PP | W | DRYR-01 | unit (in-source) | `pnpm --filter @ccaudit/internal test -- change-plan` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-01 | unit (in-source) | `pnpm --filter @ccaudit/internal test -- savings` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-01 | unit (in-source) | `pnpm --filter @ccaudit/terminal test -- change-plan` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-01 | integration | `pnpm --filter ccaudit test -- dry-run-command` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-02 | unit (in-source) | `pnpm --filter @ccaudit/internal test -- checkpoint` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-02 | unit (in-source, tmpdir) | `pnpm --filter @ccaudit/internal test -- checkpoint` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-02 | property (in-source) | `pnpm --filter @ccaudit/internal test -- checkpoint` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-03 | unit (in-source, tmpdir) | `pnpm --filter @ccaudit/internal test -- checkpoint` | ❌ W0 | ⬜ pending |
| 07-PP-TT | PP | W | DRYR-03 | unit (in-source) | `pnpm --filter @ccaudit/internal test -- checkpoint` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Full RESEARCH.md test matrix (30+ rows) is the authoritative source.** gsd-planner expands every row in RESEARCH.md §Validation Architecture into a concrete `<automated>` block under its owning task. No row from RESEARCH.md may be dropped.

---

## Wave 0 Requirements

All files below MUST be created in Wave 0 (before implementation tasks run). They are stubs — failing tests for every DRYR-01/02/03 behavior — so the suite exercises red-green during the phase.

- [ ] `packages/internal/src/remediation/change-plan.ts` — in-source vitest stubs for `buildChangePlan`, `ChangePlan`, `ChangePlanItem`
- [ ] `packages/internal/src/remediation/savings.ts` — in-source vitest stubs for `calculateDryRunSavings`
- [ ] `packages/internal/src/remediation/checkpoint.ts` — in-source vitest stubs for `computeGhostHash`, `readCheckpoint`, `writeCheckpoint`, `Checkpoint` types
- [ ] `packages/internal/src/remediation/index.ts` — barrel exports
- [ ] `packages/internal/src/index.ts` — add `export * from './remediation/index.ts'`
- [ ] `packages/terminal/src/tables/change-plan.ts` — in-source vitest stubs for `renderChangePlan`, `renderChangePlanVerbose`
- [ ] `packages/terminal/src/index.ts` — add renderer exports
- [ ] `apps/ccaudit/src/__tests__/dry-run-command.test.ts` — integration test scaffold against a tmpdir fixture home (new file; Phase 5 used `os.tmpdir()` for similar integration fixtures)
- [ ] `apps/ccaudit/src/_version.ts` — generated version constant (prebuild script populates; gitignored per RESEARCH.md §ccaudit_version Injection)
- [ ] `apps/ccaudit/scripts/gen-version.mjs` — prebuild script that writes `_version.ts` from `apps/ccaudit/package.json`
- [ ] `apps/ccaudit/package.json` — add `"prebuild": "node scripts/gen-version.mjs"` to `scripts`

**Framework is already installed** (vitest 4.1.2 from Phase 1 catalog). No new dev dependencies.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Windows `fs.rename` EPERM retry on atomic checkpoint write | DRYR-02 | Phase 7 scoped to Unix; Windows retry deferred per `STATE.md` blocker "Phase 8: Windows fs.rename EPERM handling untested". Phase 7 CI is `ubuntu-latest` + `macos-latest` only. | On a Windows VM: run `npx ccaudit --dry-run` twice back-to-back with an external process holding an open handle to `.last-dry-run` between runs; verify graceful error or success. Log findings for Phase 8. |
| Real ccaudit-self-audit smoke test | DRYR-01 | Requires a real `~/.claude/` with ≥1 ghost to produce a meaningful screenshot-worthy output. | On developer workstation: `node apps/ccaudit/dist/index.js --dry-run`; verify header, grouped sections, and footer match D-06 visual spec. Capture screenshot for README. |
| File mode `0o600` enforcement | DRYR-02 (D-18) | Windows ignores POSIX file modes. Unix CI covers it automatically. | Covered by unit test on `process.platform !== 'win32'`; Windows run is a skip, not a fail. |

*All other phase behaviors have automated verification.*

---

## Coverage Targets

Inherited from Phase 6 (`vitest.config.ts:49-62`):

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Lines | ≥ 80% | Phase 6 baseline; Phase 7 must not regress |
| Functions | ≥ 80% | Phase 6 baseline |
| Statements | ≥ 80% | Phase 6 baseline |
| Branches | ≥ 70% | Phase 6 compromise for defensive error paths (Phase 6 inline rationale in vitest.config.ts); new Phase 7 code should target 75%+ but inherits 70% gate |

Phase 7 new code files (`remediation/*.ts`, `tables/change-plan.ts`, `dry-run-command.test.ts`) should individually exceed these thresholds at green-wave time. The CI coverage gate from Phase 6 (gap closure `06-05`) remains the enforcement point.

---

## Property-Based Tests

Per RESEARCH.md §Validation Architecture, two property tests are MANDATORY:

1. **Hash determinism under reordering** — shuffling the input `TokenCostResult[]` before `computeGhostHash` must yield the same hex digest. Asserts that the sort step in canonicalization is order-insensitive on input.
2. **Hash stability across 10 iterations** — calling `computeGhostHash` with the same input 10 times returns the same digest. Asserts that no wall-clock, random, or locale-dependent byte enters the canonical form.

Property tests live in-source in `packages/internal/src/remediation/checkpoint.ts` alongside unit tests. No new property-testing library — use a simple `for` loop with `Math.random()`-seeded shuffle (deterministic seed for reproducibility).

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify blocks pointing to a RESEARCH.md test row
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify (gsd-planner enforces)
- [ ] Wave 0 covers all MISSING references (all 11 files above)
- [ ] No watch-mode flags (CI uses `vitest --run`)
- [ ] Feedback latency < 45s
- [ ] Coverage thresholds (lines 80, functions 80, statements 80, branches 70) hold after Phase 7 merge
- [ ] `nyquist_compliant: true` set in frontmatter after plan-checker verifies every RESEARCH.md test row has a corresponding task

**Approval:** pending (gsd-planner to populate Per-Task Verification Map; gsd-plan-checker to verify Nyquist compliance)
