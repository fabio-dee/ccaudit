---
phase: 05-report-cli-commands
plan: 01
subsystem: report
tags: [health-score, recommendation, trend, vitest, pure-functions]

# Dependency graph
requires:
  - phase: 04-token-cost-attribution
    provides: TokenCostResult, CONTEXT_WINDOW_SIZE, enrichScanResults
  - phase: 03-inventory-scanner
    provides: ScanResult, InventoryItem, GhostTier types
  - phase: 02-jsonl-parser
    provides: InvocationRecord, parseSession
provides:
  - calculateHealthScore() pure function (0-100 score with grade)
  - classifyRecommendation() mapping ghost tier to archive/monitor/keep
  - buildTrendData() time-bucketed aggregation with zero-fill
  - HealthScore, HealthGrade, CategorySummary, TrendBucket types
  - Integration test scaffold with fixture JSONL and mock filesystem
affects: [05-02-terminal-rendering, 05-03-command-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [report-module-pure-functions, integration-test-scaffold-with-fixtures]

key-files:
  created:
    - packages/internal/src/report/types.ts
    - packages/internal/src/report/health-score.ts
    - packages/internal/src/report/recommendation.ts
    - packages/internal/src/report/trend.ts
    - packages/internal/src/report/index.ts
    - apps/ccaudit/src/__tests__/ghost-command.test.ts
  modified:
    - packages/internal/src/index.ts

key-decisions:
  - "Health score penalty weights match research: definite*3 cap 60, likely*1 cap 20, token ratio cap 20"
  - "Trend granularity auto-selects: daily for <=7d, weekly for >7d with Monday-aligned weeks"
  - "Integration test uses node:os tmpdir for portable fixtures, not hardcoded paths"

patterns-established:
  - "Report module pure functions: side-effect-free, in-source tested, barrel-exported"
  - "Integration test scaffold pattern: fixture builders + it.todo() stubs for later plans"

requirements-completed: [REPT-04, REPT-05, REPT-06]

# Metrics
duration: 5min
completed: 2026-04-04
---

# Phase 5 Plan 01: Report Logic Summary

**Health score calculator, recommendation classifier, and trend builder as pure functions in @ccaudit/internal with integration test scaffold for ghost command**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-04T10:43:13Z
- **Completed:** 2026-04-04T10:48:25Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- calculateHealthScore() returns 0-100 integer with grade label (Healthy/Fair/Poor/Critical) for any combination of ghost results
- classifyRecommendation() maps definite-ghost to archive, likely-ghost to monitor, used to keep
- buildTrendData() groups invocations into daily or weekly time buckets with zero-fill
- Integration test scaffold created with fixture JSONL data, mock filesystem, and 7 assertion stubs for Plan 03

## Task Commits

Each task was committed atomically:

1. **Task 1: Report types and health score calculator** - `f4a1958` (feat)
2. **Task 2: Recommendation classifier, trend builder, barrel exports** - `8261bb3` (feat)
3. **Task 3: Integration test scaffolding for ghost command** - `3366383` (test)

## Files Created/Modified
- `packages/internal/src/report/types.ts` - HealthGrade, HealthScore, CategorySummary types
- `packages/internal/src/report/health-score.ts` - calculateHealthScore() with 8 in-source tests
- `packages/internal/src/report/recommendation.ts` - classifyRecommendation() with 3 in-source tests
- `packages/internal/src/report/trend.ts` - buildTrendData() with TrendBucket type and 4 in-source tests
- `packages/internal/src/report/index.ts` - Barrel re-export (3 functions, 5 types)
- `packages/internal/src/index.ts` - Updated package-level barrel with report module exports
- `apps/ccaudit/src/__tests__/ghost-command.test.ts` - Integration test scaffold with fixture JSONL and mock filesystem

## Decisions Made
- Health score penalty weights follow research recommendations exactly: definite-ghost 3 points (cap 60), likely-ghost 1 point (cap 20), token ratio percentage (cap 20)
- Trend granularity auto-selects daily for windows <= 7 days, weekly for > 7 days, with Monday-aligned week boundaries
- Integration test uses node:os tmpdir() for portable temporary directories, with beforeAll/afterAll lifecycle

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all functions are fully implemented with complete logic. The integration test `.todo()` stubs are intentional scaffolding for Plan 03 (not missing implementations).

## Next Phase Readiness
- All report pure functions ready for Plan 02 (terminal rendering layer) to consume
- Integration test scaffold ready for Plan 03 (command wiring) to fill in assertion stubs
- Package barrel exports wired -- `@ccaudit/internal` consumers can import directly

## Self-Check: PASSED

All 7 created files exist on disk. All 3 task commits (f4a1958, 8261bb3, 3366383) found in git log.

---
*Phase: 05-report-cli-commands*
*Completed: 2026-04-04*
