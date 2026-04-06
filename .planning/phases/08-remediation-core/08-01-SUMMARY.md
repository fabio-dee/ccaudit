---
phase: 08-remediation-core
plan: 01
subsystem: remediation-infrastructure
tags: [atomic-write, windows-eperm, checkpoint-refactor, ci-matrix, requirements-amendment]
dependency_graph:
  requires:
    - Phase 7 checkpoint.ts (source of the extraction)
    - Phase 7 regression tests (must remain green unchanged)
  provides:
    - packages/internal/src/remediation/atomic-write.ts (atomicWriteJson, renameWithRetry)
    - Shared Windows EPERM/EACCES/EBUSY retry loop (win32-only)
    - windows-latest CI matrix slot (SC-9)
    - Corrected RMED-02 two-gate wording (D-01)
  affects:
    - packages/internal/src/remediation/checkpoint.ts (thin wrapper)
    - packages/internal/src/remediation/index.ts (barrel exports)
    - .github/workflows/ci.yaml (OS matrix)
    - .planning/REQUIREMENTS.md (RMED-02 wording)
tech_stack:
  added:
    - graceful-fs-style rename retry loop (hand-rolled, zero runtime deps)
  patterns:
    - Dependency injection for deterministic retry-loop tests (RenameInternals)
    - stat-before-retry gate (rethrow original error if destination exists)
    - CLI-appropriate retry budget (10s total; graceful-fs uses 60s)
key_files:
  created:
    - packages/internal/src/remediation/atomic-write.ts
    - .planning/phases/08-remediation-core/08-01-SUMMARY.md
  modified:
    - packages/internal/src/remediation/checkpoint.ts
    - packages/internal/src/remediation/index.ts
    - .github/workflows/ci.yaml
    - .planning/REQUIREMENTS.md
decisions:
  - D-18 extraction: writeCheckpoint refactored as a thin wrapper calling atomicWriteJson — behavior-preserving
  - EPERM retry schedule: 10ms initial, +10ms per retry, capped 100ms, 10s total, win32-only
  - stat-before-retry gate: graceful-fs canonical behavior preserved
  - RenameInternals DI: retry logic exercised deterministically on any platform via injected rename/stat/setTimeout/now/platform
  - D-01 two-gate wording: RMED-02 aligned with PROJECT.md "Hash-based checkpoint expiry" Key Decision
metrics:
  duration: ~12 minutes
  completed_date: 2026-04-05
  tasks_completed: 3
  tests_added: 14 (in atomic-write.ts)
  tests_preserved: 21 (Phase 7 checkpoint.ts — all still passing unchanged)
  total_remediation_tests: 52 passing + 1 skipped (Windows-only smoke)
  full_workspace_tests: 382 passing + 1 skipped
---

# Phase 8 Plan 01: Wave 0 Shared Infrastructure Summary

Extracted Phase 7's atomic-write pattern from `checkpoint.ts` into a reusable `atomic-write.ts` helper with a graceful-fs-style Windows EPERM retry loop; refactored `writeCheckpoint` as a thin wrapper (Phase 7 regression tests all still pass unchanged); added `windows-latest` to the CI matrix per SC-9; amended `REQUIREMENTS.md` RMED-02 to the two-stage hash-only gate wording per D-01.

## Tasks Completed

| # | Task                                                                            | Commit    |
| - | ------------------------------------------------------------------------------- | --------- |
| 1 | Create `atomic-write.ts` with EPERM retry loop + in-source tests                | `0352d1f` |
| 2 | Refactor `checkpoint.ts` → thin wrapper; update `index.ts` barrel exports       | `1b437f5` |
| 3 | Add `windows-latest` to CI matrix; amend `REQUIREMENTS.md` RMED-02 wording      | `ffa8cdc` |

## Extraction Diff

**New module** `packages/internal/src/remediation/atomic-write.ts`: 486 lines (includes full in-source test block).

**`checkpoint.ts` refactor** (`1b437f5`):
- 29 lines removed from `writeCheckpoint` implementation (tmp path generation, mkdir, writeFile, rename, error-path unlink — all now inside `atomicWriteJson`).
- 8 lines added (new `atomic-write.ts` import, updated JSDoc, thin wrapper body).
- Imports pruned: `mkdir`, `writeFile`, `rename`, `unlink` removed from the `node:fs/promises` import (unused after the delegation).
- Net: `13 insertions(+)`, `20 deletions(-)` across `checkpoint.ts` + `index.ts`.

**`index.ts`** gained 4 lines re-exporting `atomicWriteJson`, `renameWithRetry`, and the `AtomicWriteOptions` type.

## Retry Schedule (Canonical Constants)

| Constant         | Value      | Rationale                                                                 |
| ---------------- | ---------- | ------------------------------------------------------------------------- |
| `retryTotalMs`   | `10_000`   | CLI-appropriate budget. graceful-fs uses 60s; refuse to hang users that long. |
| `retryInitialMs` | `10`       | Matches graceful-fs initial polling interval.                             |
| `retryMaxMs`     | `100`      | Capped so worst-case wakeups are bounded.                                 |
| Retryable codes  | `EPERM`, `EACCES`, `EBUSY` | Windows AV / Defender / Search Indexer transient locks. |
| Platform guard   | `win32` only | Unix platforms throw on first attempt (no retry loop engages).          |
| Stat-before-retry | Enabled   | If destination exists after a rename failure, the original error is real — rethrow. |
| Backoff sequence | `10, 20, 30, 40, ...` capped at `retryMaxMs` | Additive +10ms per retry, not exponential (graceful-fs parity). |

## Phase 7 Regression Test Count

**Pre-extraction:** 21 tests passing in `packages/internal/src/remediation/checkpoint.ts`.

**Post-extraction:** 21 tests passing in the same file — zero modifications to the in-source test block. Specifically, these Phase 7 tests continue to pass because `atomicWriteJson` propagates errors identically to the old inline implementation:

- `writeCheckpoint creates parent dir recursively`
- `writeCheckpoint writes file with mode 0o600 on Unix` (Unix only)
- `writeCheckpoint tmp-rename pattern: crashed write does not corrupt existing checkpoint`
- `writeCheckpoint propagates errors on read-only parent directory` (Unix only)
- `round-trip: writeCheckpoint then readCheckpoint returns identical checkpoint`
- `written JSON on disk matches D-17 schema exactly (7 top-level fields)`

Plus 15 `computeGhostHash` tests, plus 4 `readCheckpoint` tests, plus 1 `resolveCheckpointPath` test.

**New atomic-write.ts tests:** 14 passing + 1 skipped (Windows-only smoke). Broken down by describe block:

- `atomicWriteJson` (5 tests): round-trip, recursive parent creation, 0o600 mode, same-dir tmp, read-only parent failure path
- `renameWithRetry` (2 tests, 1 skipped on non-Windows): first-try smoke, Windows smoke
- `_renameWithRetryInternal` (8 tests with injected `RenameInternals`): EPERM N-retry, EACCES+EBUSY+EPERM cycling, ENOENT no-retry, EINVAL no-retry, non-win32 no-retry, stat-before-retry gate, retryTotalMs budget exhaustion, backoff schedule verification (`[10, 20, 30, 30, 30]` when capped at 30)

## CI Matrix Update

`.github/workflows/ci.yaml` line 38:

```diff
-        os: [ubuntu-latest, macos-latest]
+        os: [ubuntu-latest, macos-latest, windows-latest]
```

The existing `pnpm exec vitest --run --coverage` step now runs the full test suite on Windows, which exercises:

1. The new `atomic-write.ts` deterministic retry tests (all platforms — uses injected deps).
2. The Windows-only `renameWithRetry` smoke test (`it.skipIf(process.platform !== 'win32')`).
3. All existing Phase 7 regression tests on NTFS.

The `build` job was intentionally left on `ubuntu-latest` only — dist verification is OS-independent.

## RMED-02 Wording Change

`.planning/REQUIREMENTS.md` line 73:

**Before:**
> Three-stage checkpoint gate before triple confirmation: (1) checkpoint exists, (2) hash matches current inventory, (3) checkpoint is recent

**After:**
> Two-stage checkpoint gate before confirmation ceremony: (1) checkpoint file exists at ~/.claude/ccaudit/.last-dry-run, (2) `computeGhostHash(current_inventory)` matches `checkpoint.ghost_hash`. The previously-worded time-based recency gate was dropped per Phase 8 D-01 in favor of hash-only invalidation, matching the PROJECT.md Key Decision "Hash-based checkpoint expiry" (time-based is wrong because it cannot capture "inventory changed").

This resolves the Phase 7 / Phase 8 wording conflict flagged in `08-CONTEXT.md` D-01 and `08-VALIDATION.md` Wave 0 Requirements.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Wording constraint on "checkpoint is recent" phrase**
- **Found during:** Task 3 verification
- **Issue:** The initial rewrite of RMED-02 quoted the legacy phrase "checkpoint is recent" inside the historical explanation (`The "checkpoint is recent" time-based gate was dropped...`). The plan's acceptance criterion `grep -q "checkpoint is recent" ... exits 1` failed because the literal phrase still appeared in quoted form.
- **Fix:** Rephrased as `The previously-worded time-based recency gate was dropped...`. Intent is preserved (historical reference) while the literal three-word string is eliminated from the file.
- **Files modified:** `.planning/REQUIREMENTS.md`
- **Commit:** `ffa8cdc` (included in Task 3 commit — caught before commit landed)

No other deviations. The three tasks executed exactly as planned.

## Verification Results

**Post-extraction test matrix:**

```
$ pnpm exec vitest --run packages/internal/src/remediation/
 ✓ src/remediation/savings.ts       (5 tests)
 ✓ src/remediation/change-plan.ts   (12 tests)
 ✓ src/remediation/atomic-write.ts  (15 tests | 1 skipped)
 ✓ src/remediation/checkpoint.ts    (21 tests)
 Test Files  4 passed (4)
      Tests  52 passed | 1 skipped (53)
```

**Full workspace:**

```
$ pnpm exec vitest --run
 Test Files  46 passed (46)
      Tests  382 passed | 1 skipped (383)
```

**Typecheck:**

```
$ pnpm -F @ccaudit/internal typecheck
> tsc
(exit 0, no output)
```

## Self-Check: PASSED

**Created files:**
- `packages/internal/src/remediation/atomic-write.ts` — FOUND (486 lines)
- `.planning/phases/08-remediation-core/08-01-SUMMARY.md` — FOUND (this file)

**Modified files:**
- `packages/internal/src/remediation/checkpoint.ts` — FOUND (import pruned, writeCheckpoint refactored)
- `packages/internal/src/remediation/index.ts` — FOUND (atomicWriteJson + renameWithRetry + AtomicWriteOptions re-exported)
- `.github/workflows/ci.yaml` — FOUND (windows-latest in matrix)
- `.planning/REQUIREMENTS.md` — FOUND (RMED-02 two-stage wording)

**Commits:**
- `0352d1f` — FOUND (Task 1: feat — extract atomic write helper)
- `1b437f5` — FOUND (Task 2: refactor — writeCheckpoint delegates)
- `ffa8cdc` — FOUND (Task 3: chore — CI matrix + RMED-02 amendment)

**Acceptance criteria (plan success criteria):**
- atomic-write.ts module exists with atomicWriteJson, renameWithRetry, _renameWithRetryInternal, AtomicWriteOptions — PASS
- EPERM retry schedule: 10ms initial, +10ms per retry, capped at 100ms, 10s total timeout, stat-before-retry, win32-only — PASS
- checkpoint.ts writeCheckpoint is a thin wrapper; Phase 7 in-source tests unchanged and passing — PASS (21/21 tests pass)
- index.ts barrel re-exports atomicWriteJson, renameWithRetry, AtomicWriteOptions — PASS
- CI yaml has [ubuntu-latest, macos-latest, windows-latest] matrix — PASS
- REQUIREMENTS.md RMED-02 wording corrected per D-01 — PASS
