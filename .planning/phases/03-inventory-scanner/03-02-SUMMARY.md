---
phase: 03-inventory-scanner
plan: 02
subsystem: scanner
tags: [typescript, tinyglobby, filesystem, mcp-config, vitest, in-source-testing]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    plan: 01
    provides: InventoryItem, ScannerOptions, ClaudePaths interfaces
  - phase: 01-foundation-scaffold
    provides: tinyglobby, vitest, monorepo workspace with @ccaudit/internal package
provides:
  - scanAgents function discovering agent .md files recursively via tinyglobby
  - scanSkills function discovering skill directories/symlinks with resolveSkillName helper
  - scanMcpServers function reading 3 config sources with deduplication
  - readClaudeConfig exported helper for Plan 03 coordinator access
  - scanMemoryFiles function discovering CLAUDE.md and rules/*.md with mtime
affects: [03-03 (coordinator imports all 4 scanners and readClaudeConfig)]

# Tech tracking
tech-stack:
  added: []
  patterns: [tinyglobby posix-path glob for cross-platform agent discovery, readdir withFileTypes for skill directory/symlink detection, dedup-by-Set for MCP server sources, stat mtime for memory file freshness]

key-files:
  created:
    - packages/internal/src/scanner/scan-agents.ts
    - packages/internal/src/scanner/scan-skills.ts
    - packages/internal/src/scanner/scan-mcp.ts
    - packages/internal/src/scanner/scan-memory.ts
  modified: []

key-decisions:
  - "readClaudeConfig exported separately for Plan 03 coordinator to access skillUsage and disabledMcpServers"
  - "MCP deduplication uses Set with composite key (projectPath::serverName) to prevent double-counting across claude.json and .mcp.json"
  - "Memory scanner stat() each file individually with try/catch to handle file disappearance between readdir and stat"

patterns-established:
  - "Scanner function signature: (claudePaths: ClaudePaths, projectPaths: string[]) for agents/skills/memory; (configPath, projectPaths) for MCP"
  - "Silent error handling: all scanners catch and continue on missing dirs/files, never throw"
  - "Posix path conversion for tinyglobby: base.replace(/\\\\/g, '/') before glob patterns"

requirements-completed: [SCAN-01, SCAN-02, SCAN-03, SCAN-04]

# Metrics
duration: 10min
completed: 2026-04-04
---

# Phase 03 Plan 02: Individual Scanners Summary

**Four inventory scanner modules (agents, skills, MCP servers, memory files) discovering installed items from filesystem and config files with 36 in-source vitest tests**

## Performance

- **Duration:** 10 min
- **Started:** 2026-04-04T06:42:21Z
- **Completed:** 2026-04-04T06:53:21Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- Implemented scanAgents with recursive tinyglobby glob for global and project-local .md file discovery
- Implemented scanSkills with readdir+withFileTypes for directory/symlink detection, plus resolveSkillName SKILL.md parser
- Implemented scanMcpServers reading three sources (global claude.json, per-project claude.json, .mcp.json) with composite-key deduplication
- Implemented scanMemoryFiles discovering CLAUDE.md and rules/*.md with mtime population from stat()
- 36 new in-source vitest tests all passing (137 total, up from 101)

## Task Commits

Each task was committed atomically:

1. **Task 1: Agent scanner and skill scanner** - `fbd81fb` (feat)
2. **Task 2: MCP server scanner and memory file scanner** - `ac2695b` (feat)

_TDD RED phases committed separately: `c14ac7d` (test) and `f9d4205` (test)_

## Files Created/Modified
- `packages/internal/src/scanner/scan-agents.ts` - scanAgents function with tinyglobby glob for recursive .md discovery
- `packages/internal/src/scanner/scan-skills.ts` - scanSkills function with readdir/symlink detection, resolveSkillName SKILL.md parser
- `packages/internal/src/scanner/scan-mcp.ts` - scanMcpServers with 3-source discovery, readClaudeConfig exported helper, ClaudeConfig interface
- `packages/internal/src/scanner/scan-memory.ts` - scanMemoryFiles with CLAUDE.md and rules/*.md discovery, mtime population

## Decisions Made
- readClaudeConfig is exported separately (not just internal to scanMcpServers) because Plan 03 coordinator needs direct access to skillUsage and disabledMcpServers fields for classification.
- MCP server deduplication uses a Set with composite key format `${projectPath}::${serverName}` to prevent the same server from being counted twice when it appears in both claude.json per-project config and .mcp.json.
- Memory scanner wraps each individual stat() call in try/catch rather than batching, to handle the edge case where a file disappears between readdir enumeration and stat call.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all scanner functions are fully implemented with production logic.

## Next Phase Readiness
- All four scanners ready for Plan 03 (scan coordinator) to import and orchestrate
- readClaudeConfig available for coordinator to access skillUsage and disabledMcpServers
- Scanner function signatures consistent: agents/skills/memory take (claudePaths, projectPaths), MCP takes (configPath, projectPaths)
- All scanners return InventoryItem[] compatible with classifyGhost from Plan 01

## Self-Check: PASSED

- [x] packages/internal/src/scanner/scan-agents.ts - FOUND
- [x] packages/internal/src/scanner/scan-skills.ts - FOUND
- [x] packages/internal/src/scanner/scan-mcp.ts - FOUND
- [x] packages/internal/src/scanner/scan-memory.ts - FOUND
- [x] .planning/phases/03-inventory-scanner/03-02-SUMMARY.md - FOUND
- [x] Commit fbd81fb (Task 1) - FOUND
- [x] Commit ac2695b (Task 2) - FOUND
- [x] All 137 tests pass (36 new + 101 existing)
- [x] TypeScript typecheck clean

---
*Phase: 03-inventory-scanner*
*Completed: 2026-04-04*
