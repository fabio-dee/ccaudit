---
phase: 03-inventory-scanner
plan: 01
subsystem: scanner
tags: [typescript, interfaces, ghost-classification, invocation-map, vitest, in-source-testing]

# Dependency graph
requires:
  - phase: 02-jsonl-parser
    provides: InvocationRecord type and JSONL parsing pipeline
  - phase: 01-foundation-scaffold
    provides: GhostTier, ItemScope, ItemCategory base types
provides:
  - InventoryItem interface (pre-classification inventory entry)
  - ScanResult interface (post-classification with tier/lastUsed/count)
  - ScannerOptions interface (shared scanner configuration)
  - InvocationSummary interface (invocation lookup map entry)
  - classifyGhost function with 7d/30d boundary thresholds
  - buildInvocationMaps function for O(1) name-based lookup
  - LIKELY_GHOST_MS and DEFINITE_GHOST_MS constants
affects: [03-02 (individual scanners consume these types), 03-03 (coordinator uses buildInvocationMaps + classifyGhost)]

# Tech tracking
tech-stack:
  added: []
  patterns: [interface-first contract design, in-source vitest boundary testing, Map-based lookup for O(1) matching]

key-files:
  created:
    - packages/internal/src/scanner/types.ts
    - packages/internal/src/scanner/classify.ts
    - packages/internal/src/scanner/invocation-map.ts
  modified: []

key-decisions:
  - "classifyGhost uses inclusive <= boundaries: exactly 7 days is 'used', exactly 30 days is 'likely-ghost'"
  - "InvocationSummary uses Set<string> for projects to deduplicate across multiple invocations"
  - "ISO string comparison for lastTimestamp ordering (works correctly for ISO 8601 format)"

patterns-established:
  - "Interface-first: define type contracts before implementing scanners"
  - "Boundary-inclusive classification: <= for tier thresholds, not <"
  - "Map-based invocation lookup: three separate Maps for O(1) matching by kind"

requirements-completed: [SCAN-05, SCAN-06]

# Metrics
duration: 4min
completed: 2026-04-04
---

# Phase 03 Plan 01: Scanner Contracts Summary

**Interface-first scanner type contracts (InventoryItem, ScanResult, InvocationSummary) with classifyGhost boundary classifier and buildInvocationMaps O(1) lookup builder**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-04T06:35:18Z
- **Completed:** 2026-04-04T06:39:12Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- Defined all scanner type contracts (InventoryItem, ScanResult, ScannerOptions, InvocationSummary) as the interface-first foundation for Plan 02 scanners
- Implemented classifyGhost function with precise boundary handling: null -> definite-ghost, <=7d -> used, 7-30d -> likely-ghost, >30d -> definite-ghost
- Implemented buildInvocationMaps to group InvocationRecord[] into three separate Maps (agents/skills/mcpServers) for O(1) lookup by name
- 29 in-source vitest tests all passing, covering boundary cases, interface shapes, routing, and accumulation

## Task Commits

Each task was committed atomically:

1. **Task 1: Scanner type contracts and ghost classification** - `135be40` (feat)
2. **Task 2: Invocation map builder** - `c27d2ee` (feat)

## Files Created/Modified
- `packages/internal/src/scanner/types.ts` - InventoryItem, ScanResult, ScannerOptions, InvocationSummary interfaces with 20 in-source tests
- `packages/internal/src/scanner/classify.ts` - classifyGhost function with LIKELY_GHOST_MS/DEFINITE_GHOST_MS constants and 10 in-source tests
- `packages/internal/src/scanner/invocation-map.ts` - buildInvocationMaps function with 9 in-source tests

## Decisions Made
- classifyGhost uses inclusive `<=` boundaries: exactly 7 days is still 'used', exactly 30 days is still 'likely-ghost'. This matches the plan's specification and avoids off-by-one confusion.
- InvocationSummary.projects uses `Set<string>` for automatic deduplication of project paths across multiple invocations of the same item.
- ISO 8601 string comparison (`>`) works correctly for lastTimestamp ordering because ISO 8601 strings are lexicographically sortable.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all interfaces are fully defined and all functions are fully implemented with production logic.

## Next Phase Readiness
- All type contracts ready for Plan 02 (individual scanners: agent, skill, mcp, memory)
- classifyGhost and buildInvocationMaps ready for Plan 03 (scan coordinator)
- Imports verified: types.ts imports from `../types.ts`, classify.ts imports from `../types.ts`, invocation-map.ts imports from `../parser/types.ts` and `./types.ts`

## Self-Check: PASSED

- [x] packages/internal/src/scanner/types.ts - FOUND
- [x] packages/internal/src/scanner/classify.ts - FOUND
- [x] packages/internal/src/scanner/invocation-map.ts - FOUND
- [x] .planning/phases/03-inventory-scanner/03-01-SUMMARY.md - FOUND
- [x] Commit 135be40 (Task 1) - FOUND
- [x] Commit c27d2ee (Task 2) - FOUND
- [x] All 101 tests pass (29 new + 72 existing)
- [x] TypeScript typecheck clean

---
*Phase: 03-inventory-scanner*
*Completed: 2026-04-04*
