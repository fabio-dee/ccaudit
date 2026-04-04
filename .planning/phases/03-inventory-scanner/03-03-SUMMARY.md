---
phase: 03-inventory-scanner
plan: 03
subsystem: scanner
tags: [typescript, coordinator, ghost-classification, skill-usage, barrel-export, cli-integration]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    plan: 01
    provides: classifyGhost, buildInvocationMaps, InventoryItem/ScanResult/InvocationSummary types
  - phase: 03-inventory-scanner
    plan: 02
    provides: scanAgents, scanSkills, scanMcpServers, scanMemoryFiles, readClaudeConfig
  - phase: 02-jsonl-parser
    provides: InvocationRecord, discoverSessionFiles, parseSession, parseDuration
provides:
  - scanAll coordinator running all four scanners in parallel with classification
  - matchInventory function matching items against invocation ledger with skillUsage fallback
  - groupByProject function for per-project breakdown
  - Scanner barrel (index.ts) re-exporting all scanner modules
  - Package barrel (@ccaudit/internal) re-exporting scanner functions and types
  - Ghost CLI command producing real ghost detection output with tier and lastUsed
affects: [04-token-estimates (adds token cost to ghost items), 05-table-renderer (renders ghost results in cli-table3)]

# Tech tracking
tech-stack:
  added: []
  patterns: [coordinator pattern with Promise.all parallel scanning, skillUsage fallback matching, barrel re-export chain (scanner/index -> internal/index -> CLI)]

key-files:
  created:
    - packages/internal/src/scanner/scan-all.ts
    - packages/internal/src/scanner/index.ts
  modified:
    - packages/internal/src/index.ts
    - apps/ccaudit/src/cli/commands/ghost.ts

key-decisions:
  - "Skill matching uses invocation map first (by both directory name and resolved name), then skillUsage from ~/.claude.json as fallback"
  - "Memory files classified directly by mtimeMs -- no invocation matching needed"
  - "scanAll extracts unique projectPaths from invocations when not explicitly provided"

patterns-established:
  - "Coordinator pattern: scanAll runs all scanners via Promise.all, then matchInventory classifies, then groupByProject groups"
  - "Barrel re-export chain: scanner/index.ts -> internal/index.ts -> CLI imports from @ccaudit/internal"
  - "Ghost output format: [GHOST/LIKELY] name -- last used Nd ago (scope)"

requirements-completed: [SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, SCAN-06, SCAN-07]

# Metrics
duration: 4min
completed: 2026-04-04
---

# Phase 03 Plan 03: Scan Coordinator & CLI Integration Summary

**scanAll coordinator wiring all four inventory scanners with invocation-ledger matching, skillUsage fallback, per-project breakdown, and ghost CLI command producing real tier/lastUsed output**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-04T06:56:48Z
- **Completed:** 2026-04-04T07:01:00Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 2

## Accomplishments
- Implemented scanAll coordinator running all four scanners (agents, skills, MCP, memory) in parallel via Promise.all
- Implemented matchInventory with invocation-map matching for agents/skills/MCP, skillUsage fallback for skills, and mtimeMs-based classification for memory files
- Implemented groupByProject separating scan results by projectPath (global items under 'global' key)
- Created scanner barrel (index.ts) and updated package barrel re-exporting all scanner functions, types, and constants
- Updated ghost CLI command to produce real ghost detection output with tier labels and lastUsed dates
- 11 in-source tests covering all matching scenarios (agent/skill/MCP/memory + groupByProject)

## Task Commits

Each task was committed atomically:

1. **Task 1: scan-all coordinator with inventory matching and per-project breakdown** - `69b1501` (feat)
2. **Task 2: Wire scanner into ghost CLI command and update package barrel** - `4d2eef2` (feat)

_TDD RED phase committed separately: `b077c22` (test)_

## Files Created/Modified
- `packages/internal/src/scanner/scan-all.ts` - scanAll coordinator, matchInventory, groupByProject with 11 in-source tests
- `packages/internal/src/scanner/index.ts` - Barrel re-export of all scanner modules, types, and constants
- `packages/internal/src/index.ts` - Updated package barrel with scanner exports
- `apps/ccaudit/src/cli/commands/ghost.ts` - Ghost CLI command with real inventory scanning, tier/lastUsed display

## Decisions Made
- Skill matching uses invocation map first (checking both directory name and resolveSkillName result), then falls back to skillUsage from ~/.claude.json, including partial key matching. This covers both JSONL-recorded skill invocations and ~/.claude.json-tracked skill usage.
- Memory files use mtimeMs directly for classification (no invocation matching). This is correct because memory files have no tool_use signal -- mtime is the only freshness indicator.
- scanAll extracts unique projectPaths from invocations when the caller doesn't provide them explicitly, ensuring auto-discovery works for the CLI.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all functions are fully implemented with production logic. The Phase 3 stub message in ghost.ts has been replaced with real scanner output.

## Next Phase Readiness
- All SCAN-01 through SCAN-07 requirements satisfied by the scanner module
- Ghost CLI command produces end-to-end ghost detection output
- Ready for Phase 4 (token cost estimates) to add token attribution to ghost items
- Ready for Phase 5 (table renderer) to replace console.log output with cli-table3 tables
- All 148 tests pass, TypeScript compiles cleanly, CLI builds successfully

## Self-Check: PASSED

- [x] packages/internal/src/scanner/scan-all.ts - FOUND
- [x] packages/internal/src/scanner/index.ts - FOUND
- [x] packages/internal/src/index.ts - scanner exports present
- [x] apps/ccaudit/src/cli/commands/ghost.ts - scanAll import present
- [x] Commit b077c22 (TDD RED) - FOUND
- [x] Commit 69b1501 (Task 1) - FOUND
- [x] Commit 4d2eef2 (Task 2) - FOUND
- [x] All 148 tests pass (11 new + 137 existing)
- [x] TypeScript typecheck clean
- [x] CLI builds successfully

---
*Phase: 03-inventory-scanner*
*Completed: 2026-04-04*
