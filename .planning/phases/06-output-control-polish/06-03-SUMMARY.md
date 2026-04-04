---
phase: 06-output-control-polish
plan: 03
subsystem: infra
tags: [vitest, coverage-v8, github-actions, ci, cross-platform]

# Dependency graph
requires:
  - phase: 01-foundation-scaffold
    provides: CI workflow with lint, typecheck, test, build jobs
provides:
  - CI OS matrix running tests on ubuntu-latest and macos-latest
  - 80% coverage threshold enforcement via @vitest/coverage-v8
  - Coverage dependency available in all workspace packages
affects: []

# Tech tracking
tech-stack:
  added: ['@vitest/coverage-v8 ^4.1.2']
  patterns: [pnpm catalog coverage dependency, CI matrix strategy for cross-platform testing]

key-files:
  modified:
    - .github/workflows/ci.yaml
    - pnpm-workspace.yaml
    - apps/ccaudit/package.json
    - packages/terminal/package.json
    - packages/internal/package.json

key-decisions:
  - "Coverage-v8 version pinned to match vitest (^4.1.2) since it is a peer dependency"
  - "Coverage thresholds passed as CLI flags rather than vitest config to keep CI explicit"

patterns-established:
  - "CI coverage thresholds: 80% lines/functions/branches/statements"
  - "CI OS matrix: ubuntu-latest + macos-latest for test job only"

requirements-completed: [OUTP-06, OUTP-07]

# Metrics
duration: 2min
completed: 2026-04-04
---

# Phase 06 Plan 03: CI Coverage & Cross-Platform Matrix Summary

**@vitest/coverage-v8 installed across monorepo with CI enforcing 80% thresholds on ubuntu + macOS matrix**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-04T15:03:46Z
- **Completed:** 2026-04-04T15:06:09Z
- **Tasks:** 2
- **Files modified:** 6 (including pnpm-lock.yaml)

## Accomplishments
- Added @vitest/coverage-v8 to pnpm catalog and all 3 workspace packages (ccaudit, terminal, internal)
- Updated CI test job to run on ubuntu-latest + macos-latest OS matrix
- CI now enforces 80% coverage thresholds on lines, functions, branches, and statements

## Task Commits

Each task was committed atomically:

1. **Task 1: Add @vitest/coverage-v8 to catalog and install** - `cb0932f` (chore)
2. **Task 2: Update CI workflow with OS matrix and coverage thresholds** - `bd832cd` (feat)

## Files Created/Modified
- `pnpm-workspace.yaml` - Added @vitest/coverage-v8 ^4.1.2 to catalog Build section
- `apps/ccaudit/package.json` - Added @vitest/coverage-v8 catalog reference to devDependencies
- `packages/terminal/package.json` - Added @vitest/coverage-v8 catalog reference to devDependencies
- `packages/internal/package.json` - Added @vitest/coverage-v8 catalog reference to devDependencies
- `pnpm-lock.yaml` - Updated lockfile with 19 new packages for coverage-v8
- `.github/workflows/ci.yaml` - Test job: OS matrix + coverage thresholds

## Decisions Made
- Coverage-v8 version pinned to ^4.1.2 matching vitest version since coverage-v8 is a vitest peer dependency
- Coverage thresholds passed as CLI flags (--coverage.thresholds.lines=80) rather than adding vitest config -- keeps CI enforcement explicit and visible in workflow file

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CI pipeline is production-ready with cross-platform testing and coverage enforcement
- All 269 tests pass across the monorepo
- Coverage provider confirmed functional with `pnpm -F ccaudit test -- --run --coverage`

## Self-Check: PASSED

- All files verified present on disk
- All commit hashes verified in git log (cb0932f, bd832cd)

---
*Phase: 06-output-control-polish*
*Completed: 2026-04-04*
