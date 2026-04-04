---
phase: 04-token-cost-attribution
plan: 03
subsystem: token, cli
tags: [token-estimation, enrichment-pipeline, mcp-live, gunshi, cli-table3]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Token types, MCP estimates data, file-size estimator, format utilities"
  - phase: 04-02
    provides: "MCP live client (listMcpTools, measureMcpTokens)"
  - phase: 03
    provides: "scanAll, readClaudeConfig, ScanResult, ghost command"
provides:
  - "enrichScanResults pipeline combining all estimation strategies"
  - "calculateTotalOverhead aggregation function"
  - "Ghost command with token cost display per item and total overhead"
  - "ccaudit mcp subcommand with --live measurement"
  - "Updated barrel exports at token and package level"
affects: [05-health-score, 06-output-formatting, 07-cli-flags, 10-distribution]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-category estimation strategy dispatch in enrichScanResults"
    - "Skill token cap at 500 (only SKILL.md description loaded)"
    - "Live measurement fallback: try stdio -> catch -> keep estimate"

key-files:
  created:
    - packages/internal/src/token/estimate.ts
    - apps/ccaudit/src/cli/commands/mcp.ts
  modified:
    - packages/internal/src/token/index.ts
    - packages/internal/src/index.ts
    - apps/ccaudit/src/cli/commands/ghost.ts
    - apps/ccaudit/src/cli/index.ts

key-decisions:
  - "enrichScanResults uses Promise.all for parallel estimation across items"
  - "Skill token cap at 500 with source annotation 'capped at ~2KB'"
  - "MCP --live replaces enriched estimate with measured value on success, keeps estimate on failure"

patterns-established:
  - "CLI command enrichment pattern: scanAll -> enrichScanResults -> filter -> display"
  - "Graceful degradation for non-stdio MCP transport (log warning, keep estimate)"

requirements-completed: [TOKN-01, TOKN-02, TOKN-03, TOKN-04, TOKN-05]

# Metrics
duration: 5min
completed: 2026-04-04
---

# Phase 04 Plan 03: CLI Integration Summary

**Enrichment pipeline wiring all four categories into ghost command with token cost columns, plus new ccaudit mcp --live subcommand for measured token counts**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-04T08:20:27Z
- **Completed:** 2026-04-04T08:25:34Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- enrichScanResults pipeline applies per-category estimation: MCP lookup for servers, file-size for agents/memory, capped file-size for skills (500 token cap)
- Ghost command now displays ~token-cost with confidence tier per item and total overhead as tokens + % of 200k context window
- JSON output includes tokenEstimate fields on each ghost item and totalOverhead root field
- New `ccaudit mcp` subcommand with --live flag for stdio MCP server measurement, graceful fallback for errors and non-stdio transport

## Task Commits

Each task was committed atomically:

1. **Task 1: Enrichment pipeline and barrel export updates** - `fe2bc22` (feat)
2. **Task 2: Ghost command token display and mcp subcommand with --live** - `93fd542` (feat)

## Files Created/Modified
- `packages/internal/src/token/estimate.ts` - enrichScanResults + calculateTotalOverhead with 8 in-source tests
- `packages/internal/src/token/index.ts` - Barrel re-exports for estimate and mcp-live-client modules
- `packages/internal/src/index.ts` - Package-level barrel with all token module exports and types
- `apps/ccaudit/src/cli/commands/ghost.ts` - Token enrichment integration, per-item token display, total overhead summary, JSON tokenEstimate fields
- `apps/ccaudit/src/cli/commands/mcp.ts` - New gunshi command for MCP server token costs with --live, --timeout, --json, --since flags
- `apps/ccaudit/src/cli/index.ts` - mcpCommand registered in CLI subCommands

## Decisions Made
- enrichScanResults uses Promise.all for parallel estimation (non-blocking across items)
- Skill token cap at 500 with descriptive source annotation when capped
- MCP --live replaces enriched estimate with measured value on success; keeps original estimate on failure/timeout
- MCP --live verbose output logs non-stdio transport and measurement failures

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- TypeScript project references required `tsc -b` to regenerate declaration files before apps/ccaudit could see new exports from packages/internal. This is expected behavior with composite TypeScript projects and does not affect runtime or build.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All TOKN requirements (TOKN-01 through TOKN-05) are now complete
- Phase 04 fully complete: token types, estimates data, file-size estimator, formatters, MCP live client, enrichment pipeline, ghost command integration, mcp subcommand
- Ready for Phase 05 (health-score) which will consume enrichScanResults and calculateTotalOverhead
- Ready for Phase 06 (output-formatting) which will use formatTokenEstimate and formatTotalOverhead

## Self-Check: PASSED

All 6 files verified present. Both commit hashes (fe2bc22, 93fd542) verified in git log.

---
*Phase: 04-token-cost-attribution*
*Completed: 2026-04-04*
