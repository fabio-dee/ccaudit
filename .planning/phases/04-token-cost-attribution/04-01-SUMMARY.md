---
phase: 04-token-cost-attribution
plan: 01
subsystem: token-estimation
tags: [valibot, vitest, json-import, token-estimation, mcp]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    provides: ScanResult and InventoryItem interfaces for token enrichment
provides:
  - TokenEstimate, TokenCostResult, McpTokenEntry type contracts
  - Bundled mcp-token-estimates.json with 10 MCP server entries
  - lookupMcpEstimate and getMcpEstimatesMap validated lookup functions
  - estimateFromFileSize file-size-based token estimation
  - formatTokenEstimate and formatTotalOverhead display formatting
  - CONTEXT_WINDOW_SIZE (200k) and BYTES_PER_TOKEN (4) constants
  - Barrel index re-exporting all token module symbols
affects: [04-02-token-live-client, 04-03-enrichment-pipeline, 05-report-rendering]

# Tech tracking
tech-stack:
  added: []
  patterns: [valibot-json-validation-at-load, json-import-with-type-attribute, file-size-token-heuristic]

key-files:
  created:
    - packages/internal/src/token/types.ts
    - packages/internal/src/data/mcp-token-estimates.json
    - packages/internal/src/token/mcp-estimates-data.ts
    - packages/internal/src/token/file-size-estimator.ts
    - packages/internal/src/token/format.ts
    - packages/internal/src/token/index.ts
  modified:
    - packages/internal/tsconfig.json

key-decisions:
  - "JSON import requires 'with { type: json }' attribute for NodeNext module resolution"
  - "tsconfig include needs src/**/*.json for JSON files to be part of TypeScript project"

patterns-established:
  - "JSON data import with valibot safeParse validation at module load time"
  - "Token formatting always uses ~ prefix with confidence tier in parentheses"
  - "File-size estimation uses ceil(bytes/4) heuristic for English text"

requirements-completed: [TOKN-01, TOKN-02, TOKN-03, TOKN-05]

# Metrics
duration: 4min
completed: 2026-04-04
---

# Phase 4 Plan 1: Token Data Layer Summary

**Token estimation types, bundled MCP estimates JSON with valibot validation, file-size heuristic estimator, and ~-prefixed formatting functions**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-04T08:13:23Z
- **Completed:** 2026-04-04T08:16:53Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- TokenEstimate, TokenCostResult, McpTokenEntry interfaces established as type contracts for the token estimation pipeline
- Bundled mcp-token-estimates.json with 10 popular MCP servers validated at load time via valibot safeParse
- File-size estimator (ceil bytes/4) and display formatting (~ prefix + confidence tier) functions ready for enrichment pipeline
- 29 in-source vitest tests covering all token module code (types, lookup, estimation, formatting)

## Task Commits

Each task was committed atomically:

1. **Task 1: Token types, bundled JSON data file, and valibot-validated lookup** - `bc92153` (feat)
2. **Task 2: File-size estimator and token formatting functions** - `c56f186` (feat)
3. **Fix: JSON import attribute for TypeScript NodeNext** - `9df53f9` (fix)

## Files Created/Modified
- `packages/internal/src/token/types.ts` - TokenEstimate, TokenCostResult, McpTokenEntry interfaces
- `packages/internal/src/data/mcp-token-estimates.json` - Bundled MCP token estimates (10 servers)
- `packages/internal/src/token/mcp-estimates-data.ts` - Valibot-validated JSON import + lookup functions
- `packages/internal/src/token/file-size-estimator.ts` - File-size-based token estimation (bytes/4 heuristic)
- `packages/internal/src/token/format.ts` - formatTokenEstimate and formatTotalOverhead display functions
- `packages/internal/src/token/index.ts` - Barrel re-export of all token module symbols
- `packages/internal/tsconfig.json` - Added src/**/*.json to include pattern

## Decisions Made
- JSON imports in NodeNext require `with { type: 'json' }` import attribute (TypeScript 5.7+ enforcement)
- tsconfig include pattern extended to `src/**/*.json` so JSON data files are part of the project

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript NodeNext JSON import attribute**
- **Found during:** Overall verification (post-Task 2)
- **Issue:** TypeScript with `module: NodeNext` requires `with { type: 'json' }` on JSON imports, and JSON files must be in tsconfig include
- **Fix:** Added import attribute to mcp-estimates-data.ts and `src/**/*.json` to tsconfig include pattern
- **Files modified:** packages/internal/src/token/mcp-estimates-data.ts, packages/internal/tsconfig.json
- **Verification:** `pnpm tsc --noEmit -p packages/internal/tsconfig.json` exits 0
- **Committed in:** 9df53f9

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix for TypeScript compilation. No scope creep.

## Issues Encountered
None beyond the auto-fixed JSON import attribute issue.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all data is wired and functional.

## Next Phase Readiness
- Token types and data layer complete, ready for Plan 02 (MCP live client) and Plan 03 (enrichment pipeline)
- lookupMcpEstimate and estimateFromFileSize are the two estimation sources that enrichScanResults will consume
- formatTokenEstimate and formatTotalOverhead are ready for report rendering (Phase 5)

## Self-Check: PASSED

All 6 created files verified on disk. All 3 commits (bc92153, c56f186, 9df53f9) verified in git log.

---
*Phase: 04-token-cost-attribution*
*Completed: 2026-04-04*
