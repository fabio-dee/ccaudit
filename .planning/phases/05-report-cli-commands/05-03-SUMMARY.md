---
phase: 05-report-cli-commands
plan: 03
subsystem: cli
tags: [gunshi, cli-table3, terminal-rendering, subcommands]

# Dependency graph
requires:
  - phase: 05-01
    provides: report logic (calculateHealthScore, classifyRecommendation, buildTrendData, CategorySummary types)
  - phase: 05-02
    provides: terminal renderers (renderHeader, renderGhostSummary, renderTopGhosts, renderInventoryTable, renderMcpTable, renderTrendTable, renderHealthScore, renderGhostFooter)
provides:
  - Refactored ghost.ts using @ccaudit/terminal renderers with branded output
  - Refactored mcp.ts using @ccaudit/terminal renderers with branded output
  - New inventory subcommand with full item detail table
  - New trend subcommand with invocation frequency buckets
  - All 4 subcommands registered in CLI entry point
  - Integration tests for rendered output columns and content
  - In-source mcp.ts tests for command wiring
affects: [06-output-flags, 07-dry-run, 08-remediation]

# Tech tracking
tech-stack:
  added: []
  patterns: [subcommand-creation-via-gunshi-define, render-function-delegation-pattern, category-summary-aggregation]

key-files:
  created:
    - apps/ccaudit/src/cli/commands/inventory.ts
    - apps/ccaudit/src/cli/commands/trend.ts
  modified:
    - apps/ccaudit/src/cli/commands/ghost.ts
    - apps/ccaudit/src/cli/commands/mcp.ts
    - apps/ccaudit/src/cli/index.ts
    - apps/ccaudit/src/__tests__/ghost-command.test.ts

key-decisions:
  - "ghost.ts builds CategorySummary[] inline from enriched results rather than a separate function"
  - "Empty-state for no session files shows path guidance in ghost command"
  - "mcp.ts in-source tests verify structural wiring (command name, args, render function callability) not full pipeline"

patterns-established:
  - "Subcommand pattern: gunshi define() with since/json/verbose args, discover->parse->scan->enrich pipeline, terminal render delegation"
  - "JSON output pattern: healthScore object + per-item recommendation field on all commands"

requirements-completed: [REPT-01, REPT-02, REPT-03, REPT-04, REPT-05, REPT-06, REPT-07]

# Metrics
duration: 5min
completed: 2026-04-04
---

# Phase 05 Plan 03: CLI Command Wiring Summary

**All 4 CLI subcommands (ghost, mcp, inventory, trend) wired to @ccaudit/terminal renderers with branded output, health scores, recommendations, and full integration test coverage**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-04T10:58:14Z
- **Completed:** 2026-04-04T11:04:00Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Refactored ghost.ts and mcp.ts to use @ccaudit/terminal render functions, replacing all manual console.log formatting
- Created inventory.ts and trend.ts subcommands following the established gunshi define() pattern
- Registered all 4 subcommands in CLI index (ghost, mcp, inventory, trend)
- Added healthScore and per-item recommendation fields to JSON output for all commands
- Filled in all 7 integration test stubs with real render-level assertions (zero it.todo() remaining)
- Added 3 in-source tests to mcp.ts for command wiring verification

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor ghost and mcp commands to use terminal renderers** - `c2dbb16` (feat)
2. **Task 2: Create inventory and trend commands, register all subcommands** - `3f35be5` (feat)
3. **Task 3: Fill in integration test stubs from Plan 01 scaffold** - `b9817c8` (test)

## Files Created/Modified
- `apps/ccaudit/src/cli/commands/ghost.ts` - Refactored to use renderHeader, renderGhostSummary, renderTopGhosts, renderHealthScore, renderGhostFooter from @ccaudit/terminal
- `apps/ccaudit/src/cli/commands/mcp.ts` - Refactored to use renderHeader, renderMcpTable, renderHealthScore from @ccaudit/terminal; added in-source tests
- `apps/ccaudit/src/cli/commands/inventory.ts` - New subcommand showing full item detail table with renderInventoryTable
- `apps/ccaudit/src/cli/commands/trend.ts` - New subcommand showing invocation frequency buckets with renderTrendTable
- `apps/ccaudit/src/cli/index.ts` - Updated to register ghost, mcp, inventory, trend subcommands
- `apps/ccaudit/src/__tests__/ghost-command.test.ts` - All 7 it.todo() stubs replaced with real test implementations

## Decisions Made
- ghost.ts builds CategorySummary[] inline from enriched results -- simpler than a separate aggregation function for 4 categories
- Empty-state for no session files in ghost.ts shows path guidance per UI-SPEC copywriting contract
- mcp.ts in-source tests verify structural wiring (name, args, function callability) rather than full pipeline to avoid brittle tests

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all render functions are wired to real data pipelines, all test stubs are filled in.

## Issues Encountered
- Terminal package declaration files needed to be built (`tsc --build`) before ccaudit typecheck could resolve @ccaudit/terminal imports -- this is expected behavior with TypeScript composite projects and project references.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 05 (report-cli-commands) is complete with all 3 plans executed
- All REPT requirements (REPT-01 through REPT-07) are satisfied
- Ready for Phase 06 (output-flags) which adds --no-color, --quiet, --ci, --csv flags

## Self-Check: PASSED

All 6 created/modified files verified on disk. All 3 task commits (c2dbb16, 3f35be5, b9817c8) found in git log.

---
*Phase: 05-report-cli-commands*
*Completed: 2026-04-04*
