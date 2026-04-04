---
phase: 04-token-cost-attribution
plan: 02
subsystem: token
tags: [mcp, json-rpc, child_process, readline, stdio, live-measurement]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    provides: MCP server config parsing from ~/.claude.json
provides:
  - listMcpTools function for spawning MCP servers and retrieving tool definitions
  - measureMcpTokens function for computing token costs from live tool definitions
  - McpServerConfig and McpToolDefinition interfaces
affects: [04-token-cost-attribution, 05-report-rendering, ccaudit-mcp-command]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Minimal JSON-RPC 2.0 client using node:child_process spawn + node:readline"
    - "Settle guard pattern for preventing double-resolve/reject in async spawn promises"
    - "State machine for JSON-RPC handshake phases (awaiting-init, awaiting-tools)"
    - "Mock MCP server via inline Node script for in-source testing"

key-files:
  created:
    - packages/internal/src/token/mcp-live-client.ts
  modified: []

key-decisions:
  - "Used settle guard pattern to prevent double-resolve/reject on concurrent events (timeout, exit, error)"
  - "Error message uses 'timeout' not 'timed out' for consistent regex matching in tests"
  - "Non-JSON stdout lines filtered via startsWith('{') check rather than try-catch only"

patterns-established:
  - "Mock MCP server pattern: inline Node script with readline interface for test isolation"
  - "Settle guard for child_process lifecycle management"

requirements-completed: [TOKN-04]

# Metrics
duration: 2min
completed: 2026-04-04
---

# Phase 4 Plan 2: MCP Live Client Summary

**Minimal MCP JSON-RPC 2.0 client using node:child_process for live token measurement via tools/list handshake**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-04T08:13:20Z
- **Completed:** 2026-04-04T08:16:19Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 1

## Accomplishments
- Implemented listMcpTools that spawns MCP server, performs JSON-RPC initialize + tools/list handshake, returns McpToolDefinition[]
- Implemented measureMcpTokens that computes token count from tool definitions using chars/4 heuristic with confidence 'measured'
- Timeout handling (default 15s, configurable) with child process kill prevents hanging
- Non-stdio transport (http/sse) rejected with descriptive error message
- All 7 in-source vitest tests pass including mock MCP server, timeout, transport rejection, and bad command scenarios

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests for MCP live client** - `bb1d43c` (test)
2. **Task 1 GREEN: Implement MCP live client** - `05093c2` (feat)

_TDD task: RED (failing tests) + GREEN (passing implementation). No refactor needed -- code was clean on first pass._

## Files Created/Modified
- `packages/internal/src/token/mcp-live-client.ts` - Minimal MCP JSON-RPC client: McpServerConfig, McpToolDefinition interfaces, listMcpTools (spawn + handshake), measureMcpTokens (chars/4 token counting), 7 in-source tests

## Decisions Made
- Used settle guard pattern (settled boolean + clearTimeout) to prevent double-resolve/reject when timeout, error, and exit events race
- Error message uses "timeout" (one word) for consistent regex matching in test assertions
- Non-JSON stdout lines filtered with startsWith('{') check before JSON.parse to handle servers that print startup messages
- No refactor phase needed -- implementation was minimal and clean on first pass

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MCP live client ready for integration with `ccaudit mcp --live` command
- listMcpTools and measureMcpTokens available for the token enrichment pipeline (Plan 03)
- Ready for 04-03 (token estimation pipeline integration)

## Self-Check: PASSED

- [x] packages/internal/src/token/mcp-live-client.ts exists
- [x] Commit bb1d43c (RED) found in history
- [x] Commit 05093c2 (GREEN) found in history
- [x] 04-02-SUMMARY.md created

---
*Phase: 04-token-cost-attribution*
*Completed: 2026-04-04*
