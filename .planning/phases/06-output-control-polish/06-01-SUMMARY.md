---
phase: 06-output-control-polish
plan: 01
subsystem: terminal
tags: [picocolors, cli-table3, csv, tsv, no-color, color-detection]

# Dependency graph
requires:
  - phase: 05-report-cli-commands
    provides: "Table renderers (header, score, ghost-table, inventory-table, mcp-table, trend-table)"
provides:
  - "Centralized color control module (initColor, isColorEnabled, getTableStyle, colorize)"
  - "RFC 4180 CSV formatter (csvEscape, csvRow, csvTable)"
  - "TSV quiet-mode formatter (tsvRow)"
  - "All renderers using centralized color control instead of bare picocolors"
affects: [06-02-command-wiring, 06-03-csv-export]

# Tech tracking
tech-stack:
  added: [picocolors.createColors]
  patterns: [centralized-color-detection, color-aware-wrappers, rfc-4180-csv]

key-files:
  created:
    - packages/terminal/src/color.ts
    - packages/terminal/src/csv.ts
    - packages/terminal/src/quiet.ts
  modified:
    - packages/terminal/src/tables/header.ts
    - packages/terminal/src/tables/score.ts
    - packages/terminal/src/tables/ghost-table.ts
    - packages/terminal/src/tables/inventory-table.ts
    - packages/terminal/src/tables/mcp-table.ts
    - packages/terminal/src/tables/trend-table.ts
    - packages/terminal/src/index.ts

key-decisions:
  - "picocolors.createColors(false) used for no-color identity functions instead of manual passthrough"
  - "initColor() takes no arguments -- detects --no-color from process.argv directly (per D-07)"
  - "getTableStyle() returns {} when color disabled to prevent cli-table3's @colors/colors from applying ANSI"

patterns-established:
  - "Centralized color: import { colorize, getTableStyle } from '../color.ts' replaces bare picocolors"
  - "Table style: all cli-table3 tables use getTableStyle() not hardcoded { head: ['cyan'] }"
  - "CSV export: csvEscape/csvRow/csvTable for RFC 4180 compliant output"
  - "TSV export: tsvRow for machine-parseable quiet mode"

requirements-completed: [OUTP-02, OUTP-07, OUTP-03]

# Metrics
duration: 4min
completed: 2026-04-04
---

# Phase 06 Plan 01: Terminal Output Primitives Summary

**Centralized color detection with picocolors.createColors, RFC 4180 CSV formatter, and TSV quiet-mode formatter -- all renderers migrated to color-aware wrappers**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-04T15:03:38Z
- **Completed:** 2026-04-04T15:08:19Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Created color.ts with initColor() that detects --no-color from process.argv and NO_COLOR env, getTableStyle() for cli-table3, and colorize wrappers using picocolors.createColors(false)
- Created csv.ts with RFC 4180 compliant csvEscape/csvRow/csvTable with proper quoting for commas, quotes, and newlines
- Created quiet.ts with tsvRow for tab-separated quiet mode output
- Migrated all 6 table renderers from bare picocolors to centralized colorize/getTableStyle
- All 269 tests pass across all packages (50 terminal, 207 internal, 12 ccaudit) with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create color control, CSV, and TSV modules with in-source tests** - `c44a16f` (feat)
2. **Task 2: Update all renderers to use centralized color control and export new modules** - `70f731c` (refactor)

## Files Created/Modified
- `packages/terminal/src/color.ts` - Centralized color detection and picocolors wrapper (initColor, isColorEnabled, getTableStyle, colorize)
- `packages/terminal/src/csv.ts` - RFC 4180 CSV formatter (csvEscape, csvRow, csvTable)
- `packages/terminal/src/quiet.ts` - TSV formatter for quiet mode (tsvRow)
- `packages/terminal/src/tables/header.ts` - Replaced pc.bold/pc.cyan with colorize.bold/colorize.cyan
- `packages/terminal/src/tables/score.ts` - Replaced pc.green/pc.yellow/pc.red with colorize equivalents
- `packages/terminal/src/tables/ghost-table.ts` - Replaced pc.bold/pc.dim with colorize equivalents
- `packages/terminal/src/tables/inventory-table.ts` - Replaced pc imports with colorize/getTableStyle
- `packages/terminal/src/tables/mcp-table.ts` - Replaced pc imports with colorize/getTableStyle
- `packages/terminal/src/tables/trend-table.ts` - Added getTableStyle() import, replaced hardcoded style
- `packages/terminal/src/index.ts` - Added exports for color, csv, quiet modules

## Decisions Made
- Used picocolors.createColors(false) for no-color identity functions -- avoids manual identity function creation, leverages picocolors' built-in support
- initColor() takes no arguments and reads process.argv directly -- per D-07, --no-color is a root-level flag, no per-command gunshi option duplication needed
- getTableStyle() returns empty object {} when color disabled -- this prevents cli-table3's internal @colors/colors dependency from applying ANSI escape codes (Pitfall 1 from phase research)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all modules are fully implemented with working tests.

## Next Phase Readiness
- Color control primitives ready for Plan 02 (command wiring) to call initColor() at command entry
- CSV and TSV formatters ready for Plan 02/03 to wire into --csv and --quiet flags
- All renderers already color-aware, so --no-color flag will work end-to-end once initColor() is called

## Self-Check: PASSED

- All 3 created files exist on disk
- Both task commits (c44a16f, 70f731c) found in git log

---
*Phase: 06-output-control-polish*
*Completed: 2026-04-04*
