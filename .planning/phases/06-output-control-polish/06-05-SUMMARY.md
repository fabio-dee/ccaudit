---
phase: 06-output-control-polish
plan: 05
subsystem: testing
tags: [vitest, coverage-v8, ci, github-actions, pnpm, in-source-tests, gap-closure]

requires:
  - phase: 06-output-control-polish
    provides: Plan 06-06 restored apps/ccaudit/package.json scripts + devDependencies (incl. @vitest/coverage-v8 catalog ref) so the coverage provider is installed and reachable via pnpm exec
provides:
  - Root vitest.config.ts now owns the coverage configuration (provider v8, text + text-summary + json-summary reporters, include globs, documented exclude list, thresholds) so coverage enforcement is independent of invocation path
  - CI workflow invokes coverage via `pnpm exec vitest --run --coverage` (no `--` delimiter), unblocking the threshold gate that was a silent no-op for the entire Plan 06-03 + 06-04 window
  - 14 new in-source branch tests across 3 terminal table renderers (mcp-table.ts, ghost-table.ts, inventory-table.ts) lifting their branch coverage from 50-64% into the 85-100% range
  - Empirical negative test proof that the threshold gate fails with non-zero exit when coverage drops below the declared floor (no longer a silent pass)
  - Test count: 283 → 297 (+14); overall coverage stmts 90.55→93.22, branches 79.66→83.61, lines 91.61→93.79

affects:
  - Phase 06 verifier re-run (Gap #1 now closed; ROADMAP SC-6 genuinely enforced in CI)
  - Any future plan adding source files below threshold: CI will now actually fail the job instead of silently passing
  - Terminal renderer tests serve as the branch-coverage template for future table helpers

tech-stack:
  added: []
  patterns:
    - "Config-as-source-of-truth for coverage thresholds: move them out of CLI flags and into vitest.config.ts so they hold regardless of how vitest is invoked (direct, via script, via pnpm exec, via CI shell)"
    - "Private-helper branch coverage via public render entry points: exercise module-private format helpers (formatTier, formatRecommendation, formatLastUsed, formatTokenShort) by passing fixture rows through the exported render* functions rather than by exporting the helpers themselves"
    - "Documented exclude-with-justification pattern: every entry in coverage.exclude carries an inline comment explaining why (integration test scope, type-only, barrel, etc.) so the exclude list is auditable"

key-files:
  created:
    - .planning/phases/06-output-control-polish/06-05-SUMMARY.md
  modified:
    - vitest.config.ts
    - .github/workflows/ci.yaml
    - packages/terminal/src/tables/mcp-table.ts
    - packages/terminal/src/tables/ghost-table.ts
    - packages/terminal/src/tables/inventory-table.ts

key-decisions:
  - "Coverage config lives on the root vitest.config.ts, not per-project — vitest projects mode inherits coverage config from root, so there is exactly one source of truth and zero duplication"
  - "branches: 70 is a documented, deliberate compromise with inline rationale pointing to this plan; defensive error paths (ENOENT, .mcp.json parse errors, picocolors fallback, stderr diagnostics) are legitimately hard to trigger without elaborate fixtures. Raising to 80 is tracked as Phase 7+ tech debt."
  - "Added json-summary to the reporter list specifically so `test -d coverage` succeeds in CI. text and text-summary write only to stdout, which would leave no filesystem footprint — a problem for CI assertions that the coverage step actually ran."
  - "Lines 52 and 65 in inventory-table.ts / mcp-table.ts (switch default fallthroughs for invalid enum values) are accepted as uncovered dead code — the TypeScript union types make them unreachable in practice and covering them would require intentional type casts that defeat type safety"
  - "Did NOT modify the root `test` script (still `TZ=UTC vitest`) — the fix lives in the CI invocation, not the package script, so local `pnpm test` behavior is undisturbed"

patterns-established:
  - "Gap-closure plan structure: each task maps to exactly one atomic commit (Task 4 verification-only, no commit); verification commands embedded in the plan body with specific exit-code / grep / stat assertions"
  - "Negative-test pattern for CI gates: before declaring a gate 'working', temporarily make it fail (bump threshold to unachievable) and confirm the non-zero exit; then revert and confirm green. Prevents silent no-ops of the kind that caused Gap #1 originally."

requirements-completed: [OUTP-06, OUTP-07]

duration: ~30min
completed: 2026-04-04
---

# Phase 06 Plan 05: Gap #1 Closure — CI Coverage Enforcement Summary

**Moved coverage config into vitest.config.ts with documented exclusions + branches-70 rationale, fixed the CI workflow to invoke `pnpm exec vitest --run --coverage` (no `--` delimiter), and added 14 in-source branch tests to lift terminal-table renderer coverage from 50-64% branches to 85-100%.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-04-04T17:45:00Z (approximate, after resuming from Plan 06-06)
- **Completed:** 2026-04-04T18:15:00Z
- **Tasks:** 4 (3 code tasks with atomic commits + 1 verification-only negative test)
- **Files modified:** 5 tracked files (1 config + 1 CI + 3 test files)
- **Test delta:** +14 (283 → 297)

## Accomplishments

- **Coverage config centralized**: vitest.config.ts now owns provider (v8), reporters (text + text-summary + json-summary), include globs (apps/\*/src, packages/\*/src), a 15-line exclude list with inline justification for every entry, and the four thresholds (lines 80, statements 80, functions 80, branches 70). Zero duplication across per-project configs.
- **CI invocation fixed**: `.github/workflows/ci.yaml` line 48 replaced `pnpm test -- --run --coverage --coverage.thresholds.lines=80 ...` with `pnpm exec vitest --run --coverage`. The old pattern was a silent no-op because pnpm passed `--` through to vitest, which treats it as the positional-argument separator — so `--run`, `--coverage`, and every threshold flag became positional file filters instead of options. The new pattern invokes the vitest binary directly through pnpm's workspace `.bin` resolution, and thresholds come from the config.
- **Terminal-table branch tests added** (+14 tests, +5 describe blocks):
  - **mcp-table.ts** (+6 tests): LIKELY tier label, monitor recommendation, Keep/ACTIVE/today combo, 1d ago, Nd ago (5d), never/GHOST/Archive combo. 2 → 8 `it(...)` blocks.
  - **ghost-table.ts** (+5 tests across 2 new describe blocks): `formatLastUsed branches (via renderTopGhosts)` covering today / 1d ago / Nd ago through real Date fixtures, and `formatTokenShort branches (via renderGhostSummary)` covering mid-range (~X.Yk) and small (~N no-k-suffix) formatting paths. 15 → 20 `it(...)` blocks.
  - **inventory-table.ts** (+3 tests): today with new Date(), 1d ago, Nd ago (7d). 4 → 7 `it(...)` blocks.
- **Coverage numbers after the plan**:

  | Metric     | Before (HEAD pre-05) | After (post-05) | Threshold | Margin |
  | ---------- | -------------------- | --------------- | --------- | ------ |
  | Statements | 90.55%               | **93.22%**      | 80        | +13.22 |
  | Branches   | 79.66%               | **83.61%**      | 70        | +13.61 |
  | Functions  | 95.18%               | **95.18%**      | 80        | +15.18 |
  | Lines      | 91.61%               | **93.79%**      | 80        | +13.79 |

  Per-file improvements on the three touched renderers:

  | File               | Branch Before | Branch After | Lines Before | Lines After |
  | ------------------ | ------------- | ------------ | ------------ | ----------- |
  | mcp-table.ts       | 50%           | **85.71%**   | 76.92%       | **92.30%**  |
  | ghost-table.ts     | 64%           | **88%**      | 85.10%       | **100%**    |
  | inventory-table.ts | 64.28%        | **85.71%**   | 84.61%       | **92.30%**  |

- **Negative-test proof the gate is wired**: Temporarily bumped `lines: 80 → 99` in vitest.config.ts. Vitest emitted "ERROR: Coverage for lines (93.79%) does not meet global threshold (99%)" and exited with code 1. Reverted to 80; final run exited 0 with the coverage directory created and no threshold errors. `git diff --exit-code vitest.config.ts` confirms zero residual changes.
- **Non-coverage regression path verified green**: `pnpm -r test -- --run` exits 0 with 297 tests across 38 files (207 internal + 64 terminal + 26 ccaudit). No regression in the default invocation path.

## Task Commits

Each task with tracked file changes was committed atomically:

1. **Task 1: Move coverage config into vitest.config.ts with provider, thresholds, and exclude list** — `6fd80d4` (feat)
2. **Task 2: Fix CI YAML to invoke coverage via `pnpm exec vitest --run --coverage`** — `08879b5` (fix)
3. **Task 3: Add branch tests to mcp-table.ts, ghost-table.ts, inventory-table.ts** — `26b80c4` (test)
4. **Task 4: Negative-test the threshold enforcement (verification-only, no persistent changes)** — no commit (pure verification with self-reverting temporary edit; `git diff --exit-code` clean after the negative/positive cycle)

**Plan metadata:** will be captured in the final `docs(06-05): complete plan 06-05 gap closure` commit bundling SUMMARY.md + STATE.md + ROADMAP.md + REQUIREMENTS.md.

## Files Created/Modified

- `vitest.config.ts` — added the entire `test.coverage` block: provider v8, 3 reporters (text, text-summary, json-summary), reportsDirectory, include globs, 15-entry exclude list with per-entry justification comments, 4-metric thresholds block with inline rationale for the branches: 70 compromise. +53 lines. Per-project configs (apps/ccaudit, packages/terminal, packages/internal) intentionally untouched — vitest projects mode inherits coverage from root.
- `.github/workflows/ci.yaml` — line 48 only: replaced the broken `pnpm test -- --run --coverage ...` with `pnpm exec vitest --run --coverage`. 1-line change. OS matrix and build-job dependencies unchanged.
- `packages/terminal/src/tables/mcp-table.ts` — appended 6 `it(...)` cases to the existing `describe('renderMcpTable', ...)` in-source block. +74 lines.
- `packages/terminal/src/tables/ghost-table.ts` — appended 2 new describe blocks (`formatLastUsed branches` and `formatTokenShort branches`) with a total of 5 `it(...)` cases covering the previously-unreachable today/1d/Nd and mid-range/small token formatting paths. +61 lines.
- `packages/terminal/src/tables/inventory-table.ts` — appended 3 `it(...)` cases to the existing `describe('renderInventoryTable', ...)` block covering today / 1d ago / Nd ago branches. +40 lines.
- `.planning/phases/06-output-control-polish/06-05-SUMMARY.md` — this file.

## Decisions Made

- **Config over CLI flags for thresholds**: Plan 06-03 had put thresholds on the CI command line (`--coverage.thresholds.lines=80 ...`). That approach is brittle (any invocation that doesn't echo the flags skips enforcement) and was the root cause of Gap #1 when combined with pnpm's `--` delimiter behavior. Moving thresholds into vitest.config.ts makes them unconditional: any invocation that activates coverage enforces them.
- **Reporters include json-summary even though CI only reads stdout**: `reporter: ['text', 'text-summary']` alone produces no filesystem footprint. CI can't assert that coverage actually ran via `test -d coverage`, and acceptance criteria in the plan explicitly require the directory to exist. Adding `json-summary` costs <1 KB on disk and gives CI a real artifact to point at.
- **Excluded CLI command runners with written justification**: apps/ccaudit/src/cli/commands/\*.ts are end-to-end tested via the subprocess-based integration test (`ghost-command.test.ts` spawns `node dist/index.js`). v8 coverage only instruments code loaded into the vitest worker process — it cannot see child-process code at all. Reproducing the integration test as unit tests would require mocking gunshi context, initColor, resolveOutputMode, every @ccaudit/terminal renderer, and every @ccaudit/internal scanner. Zero added signal, maximum friction. Excluded with an inline comment explaining why.
- **branches: 70, not 80, with rationale inline**: Current branch coverage sits at 83.61% (well above 70), but several files contain defensive error branches (ENOENT handling in discover.ts, .mcp.json parse errors in scan-mcp.ts, picocolors fallback in color.ts, stderr diagnostics in mcp-live-client.ts) that require elaborate fixtures to trigger. Setting the floor at 80 would force artificial fixture machinery for negligible safety gain. 70 enforces a meaningful floor while leaving room for incremental improvement. The inline comment in vitest.config.ts references this plan for auditability.
- **Negative test mandatory, not optional**: The original Gap #1 existed because no one ever verified the gate actually fails. Adding Task 4 as a verification-only step (temporary threshold bump → confirm exit 1 → revert → confirm exit 0 → confirm no diff) institutionalizes this check. Future plans touching coverage should repeat the pattern.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking/operational] reporter: ['text', 'text-summary'] produced no filesystem footprint, breaking Task 1's own acceptance criterion**

- **Found during:** Task 1, verify step (`test -d coverage` after running vitest with the plan-specified reporters)
- **Issue:** The plan prescribed `reporter: ['text', 'text-summary']` for the coverage config. Both reporters write exclusively to stdout — they do not materialize any files in the `reportsDirectory`. Result: `rm -rf coverage && pnpm exec vitest --run --coverage` printed a full coverage report to stdout, thresholds were evaluated, all metrics were met, exit 0 — but no `coverage/` directory existed on disk afterward. This directly violates Task 1's `<done>` criterion ("Running `pnpm exec vitest --run --coverage` creates a `coverage/` directory") and the acceptance criterion (`test -d coverage` exits 0). It would also mean any future CI assertion of the form "coverage ran" would have no artifact to point at.
- **Fix:** Added `'json-summary'` as a third reporter. `json-summary` writes a tiny (~1 KB) `coverage-summary.json` file to `./coverage/`, materializing the directory without inflating disk footprint or committing noise (`coverage/` is already in `.gitignore`). Updated the inline comment to document why: "`'text'` and `'text-summary'` print to stdout; `'json-summary'` materializes `coverage/coverage-summary.json` so `test -d coverage` succeeds in CI."
- **Files modified:** `vitest.config.ts` (2 lines changed within the reporter array + adjacent comment)
- **Verification:** `rm -rf coverage && pnpm exec vitest --run --coverage` now creates `coverage/` containing `coverage-summary.json`. `test -d coverage` exits 0. Coverage report still prints to stdout unchanged.
- **Committed in:** `6fd80d4` (bundled into Task 1's commit — the json-summary addition was part of the same single edit before commit, so the commit already reflects the corrected form)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking: plan-specified config would have violated the plan's own acceptance criteria)
**Impact on plan:** Zero — the fix was a 2-line additive change to the reporter array within the same single Task 1 edit, committed atomically as part of the Task 1 commit. No scope creep, no architectural change, no extra commits. Happens to also make CI nicer (tiny structured summary artifact available for future parsing).

## Issues Encountered

- **Bash `$? after pipe` captures wrong exit code (investigation tangent, not a blocker):** During Task 4's negative test, `rm -rf coverage && pnpm exec vitest --run --coverage 2>&1 | tail -20; echo "EXIT_CODE=$?"` reported EXIT_CODE=0 even though the coverage threshold error was clearly printed. This is because `$?` after a pipeline captures the exit code of the last command in the pipe (`tail`), not `vitest`. Resolved by rerunning without a pipe: `pnpm exec vitest --run --coverage > /tmp/ccaudit-neg.log 2>&1; echo "VITEST_EXIT=$?"` correctly reported VITEST_EXIT=1. This is a bash pipeline quirk, not a coverage-config bug. Noting it here so future executors running negative tests know to avoid pipes when capturing exit codes.

## User Setup Required

None — no external service configuration required. All changes are config files, CI YAML, and test files.

## Next Phase Readiness

- **Gap #1 is closed empirically**, not just on paper. ROADMAP SC-6 ("CI test job enforces 80% coverage threshold via vitest --coverage; fails if coverage drops") is now actually true: the negative test proves the gate fails with non-zero exit when any threshold is violated, and the current coverage comfortably exceeds all four thresholds with double-digit margin.
- **Phase 6 verifier re-run is ready**: Both Gap #1 (this plan) and Gap #2 (Plan 06-06) are now closed. Re-running the verifier should return `status: verified` with all 7 truths passing.
- **No new blockers or concerns introduced.** The 2 files with remaining uncovered lines inside the tables folder (52, 65 in both inventory-table.ts and mcp-table.ts) are TypeScript-unreachable switch default branches — accepted as dead code per the decision above.
- **Pattern documented for future plans**: the private-helper-via-public-render testing pattern in ghost-table.ts is a clean template for any future table helpers added in v1.1/v1.2.

## Self-Check: PASSED

- File existence:
  - `vitest.config.ts` present, contains `provider: 'v8'`, `thresholds:`, all 4 metrics at correct values, and the exclude list with `apps/ccaudit/src/cli/commands`
  - `.github/workflows/ci.yaml` line 48 contains `pnpm exec vitest --run --coverage`; the old `pnpm test -- --run --coverage` pattern is absent
  - `packages/terminal/src/tables/mcp-table.ts` contains 8 `it(...)` blocks including the new `formats likely-ghost` and `formats monitor recommendation` tests
  - `packages/terminal/src/tables/ghost-table.ts` contains 20 `it(...)` blocks across 5 describe blocks
  - `packages/terminal/src/tables/inventory-table.ts` contains 7 `it(...)` blocks
  - `.planning/phases/06-output-control-polish/06-05-SUMMARY.md` present (this file)
- Commit existence:
  - `git log --oneline | grep 6fd80d4` — FOUND (Task 1: feat)
  - `git log --oneline | grep 08879b5` — FOUND (Task 2: fix)
  - `git log --oneline | grep 26b80c4` — FOUND (Task 3: test)
- Functional verification:
  - `rm -rf coverage && pnpm exec vitest --run --coverage` exits 0; `test -d coverage` exits 0; no "does not meet" messages
  - `pnpm -r test -- --run` exits 0 with 297 tests passing (non-coverage regression path clean)
  - Negative test performed successfully: lines: 99 → VITEST_EXIT=1 with explicit threshold error; reverted to 80 → VITEST_EXIT=0; `git diff --exit-code vitest.config.ts` clean

---

*Phase: 06-output-control-polish*
*Plan: 05 (Gap #1 closure)*
*Completed: 2026-04-04*
