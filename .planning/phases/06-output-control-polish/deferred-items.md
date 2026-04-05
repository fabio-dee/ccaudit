# Deferred Items from Plan 06-07 Execution

Items discovered during Plan 06-07 execution but OUT OF SCOPE — they are pre-existing
issues in files NOT modified by this plan's 12 `files_modified` list.

## Pre-existing Lint Errors (5 total)

Discovered when running `pnpm lint` in Task 8 verification gate.

### 1. `packages/internal/src/token/estimate.ts:69`
- **Error:** `'unlink' is assigned a value but never used` (@typescript-eslint/no-unused-vars)
- **Source:** Pre-existing, last touched in Phase 4 token-estimator work
- **Why deferred:** File not in plan 06-07's `files_modified`; fix belongs in a separate cleanup task
- **Appears twice in lint output** (once per tsconfig project, same underlying error)

### 2. `packages/internal/src/scanner/scan-all.ts:5`
- **Error:** `'InvocationSummary' is defined but never used` (@typescript-eslint/no-unused-vars)
- **Source:** Pre-existing, Phase 3 scanner work
- **Why deferred:** File not in plan 06-07's `files_modified`; dead import cleanup tracked separately

### 3. `apps/ccaudit/scripts/gen-version.mjs`
- **Error:** `Parsing error: ... was not found by the project service`
- **Source:** Phase 7 build-time version injection script, committed as `b962a77 chore(07-02): add gen-version.mjs`
- **Why deferred:** ESLint flat-config tsconfig discovery issue for the scripts/ dir; fix requires eslint config change, not scope of 06-07

## Root-Cause Context

Pre-existing lint drift was not caught in Phase 6 CI because `pnpm lint` was not
part of the Phase 6 VERIFICATION gate (only typecheck, test, and coverage were).
Plan 06-07 Task 8 added `pnpm lint` to the verification gate per the approved plan,
which surfaced these pre-existing errors.

**Recommended follow-up:** A small hygiene plan (Phase 7+ or pre-v1.0) that:
1. Removes the two unused imports (trivial 2-line edits)
2. Extends eslint config to include `apps/ccaudit/scripts/**/*.mjs` in the tsconfig projectService
3. Adds `pnpm lint` to CI workflow (.github/workflows/ci.yaml) so future drift is caught automatically

These are NOT v1.0 blockers — they do not affect the binary, tests, coverage, or
any tester-visible behavior. The 06-07 gap closures are complete and independent
of the lint drift.
