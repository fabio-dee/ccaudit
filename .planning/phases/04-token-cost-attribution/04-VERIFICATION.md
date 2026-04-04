---
phase: 04-token-cost-attribution
verified: 2026-04-04T10:30:00Z
status: passed
score: 7/7 must-haves verified
gaps: []
human_verification:
  - test: "ccaudit mcp --live with a real running MCP server"
    expected: "Reports confidence 'measured' instead of 'estimated'; token count reflects actual tool definitions"
    why_human: "Requires a live MCP server process to spawn — cannot test without external service"
---

# Phase 4: Token Cost Attribution Verification Report

**Phase Goal:** Every ghost item has an estimated token cost from the bundled `mcp-token-estimates.json`, with clear confidence labeling and a `--live` path for exact MCP server measurements
**Verified:** 2026-04-04T10:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Per-item token estimates looked up from bundled `mcp-token-estimates.json` and displayed with `~` prefix | VERIFIED | `ghost` output: `~1.5k tokens (estimated)` per item. JSON output contains `tokenEstimate.tokens` field per item. |
| 2 | Confidence tier shown per estimate: "estimated" / "measured" / "community-reported" | VERIFIED | `formatTokenEstimate` appends `(${confidence})` on every non-null estimate. Live output confirms format: `~1.5k tokens (estimated)` |
| 3 | `ccaudit mcp --live` subcommand exists and connects to stdio MCP servers | VERIFIED | `mcp.ts` registers with `--live` flag; `listMcpTools` spawns via `node:child_process`, performs JSON-RPC initialize + tools/list handshake |
| 4 | Total ghost overhead displayed as absolute token count and percentage of 200k context window | VERIFIED | Live output: `~916k tokens (~458.1% of 200k context window)`. JSON output: `totalOverhead.tokens`, `totalOverhead.percentage`, `totalOverhead.contextWindow: 200000` |
| 5 | Token types and data layer fully wired | VERIFIED | All 44 in-source vitest tests pass; both TypeScript packages compile without errors |
| 6 | Ghost command JSON output includes tokenEstimate and totalOverhead fields | VERIFIED | JSON output confirmed: `tokenEstimate: { tokens, confidence, source }` per item; `totalOverhead: { tokens, percentage, contextWindow }` at root |
| 7 | enrichScanResults applies per-category estimation for all four categories | VERIFIED | `estimate.ts` switches on category: MCP server uses lookup, agent/memory use file-size, skill uses capped file-size (500 token cap) |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/internal/src/token/types.ts` | TokenEstimate, TokenCostResult, McpTokenEntry interfaces | VERIFIED | All three interfaces exported, with in-source tests |
| `packages/internal/src/data/mcp-token-estimates.json` | Community MCP token estimate data with 10+ entries | VERIFIED | 10 entries, contextWindowSize: 200000, valibot-validated at load |
| `packages/internal/src/token/mcp-estimates-data.ts` | JSON import, valibot validation, lookup functions | VERIFIED | Imports JSON with `with { type: 'json' }`, safeParse validates at module load, exports lookupMcpEstimate, getMcpEstimatesMap, CONTEXT_WINDOW_SIZE |
| `packages/internal/src/token/file-size-estimator.ts` | File-size-based token estimation | VERIFIED | `estimateFromFileSize` uses `Math.ceil(bytes/4)`, confidence='estimated', BYTES_PER_TOKEN=4 |
| `packages/internal/src/token/format.ts` | Token formatting with ~ prefix and confidence tier | VERIFIED | `formatTokenEstimate` always uses ~ prefix; `formatTotalOverhead` shows tokens + % of 200k window |
| `packages/internal/src/token/mcp-live-client.ts` | MCP JSON-RPC live client | VERIFIED | Spawns via child_process, JSON-RPC initialize + tools/list handshake, timeout with kill, non-stdio transport rejected |
| `packages/internal/src/token/estimate.ts` | enrichScanResults pipeline | VERIFIED | Per-category dispatch: mcp-server uses lookupMcpEstimate, agent/memory use estimateFromFileSize, skill uses capped estimateFromFileSize |
| `packages/internal/src/token/index.ts` | Barrel re-export of all token module symbols | VERIFIED | Exports types, lookup, estimator, formatters, enrichment, and live client |
| `packages/internal/src/index.ts` | Package barrel with token module exports | VERIFIED | Exports all token module symbols and types under `// Token module (Phase 4)` block |
| `apps/ccaudit/src/cli/commands/ghost.ts` | Ghost command with token cost display | VERIFIED | Imports enrichScanResults, formatTokenEstimate, formatTotalOverhead, CONTEXT_WINDOW_SIZE; displays per-item token cost and total overhead summary |
| `apps/ccaudit/src/cli/commands/mcp.ts` | MCP subcommand with --live | VERIFIED | `define()`-based gunshi command; --live flag triggers measureMcpTokens per server; graceful fallback for errors and non-stdio transport |
| `apps/ccaudit/src/cli/index.ts` | CLI with mcp subcommand registered | VERIFIED | `mcpCommand` imported and registered in `subCommands` map |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `mcp-estimates-data.ts` | `mcp-token-estimates.json` | `import rawEstimates from '../data/mcp-token-estimates.json' with { type: 'json' }` | WIRED | Static bundled import with NodeNext JSON attribute |
| `mcp-estimates-data.ts` | valibot | `v.safeParse(EstimatesFileSchema, rawEstimates)` | WIRED | Validates at module load; throws if data malformed |
| `format.ts` | `types.ts` | `import type { TokenEstimate } from './types.ts'` | WIRED | Type import used in function signature |
| `estimate.ts` | `mcp-estimates-data.ts` | `import { lookupMcpEstimate }` | WIRED | Called in switch case for 'mcp-server' category |
| `estimate.ts` | `file-size-estimator.ts` | `import { estimateFromFileSize }` | WIRED | Called in switch cases for 'agent', 'memory', 'skill' categories |
| `ghost.ts` | `@ccaudit/internal` | `import { enrichScanResults, calculateTotalOverhead, formatTokenEstimate, formatTotalOverhead, CONTEXT_WINDOW_SIZE }` | WIRED | All functions called in run() body; output confirmed in live execution |
| `cli/index.ts` | `commands/mcp.ts` | `import { mcpCommand }` + `subCommands: { mcp: mcpCommand }` | WIRED | Command accessible as `ccaudit mcp` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `ghost.ts` | `enriched` (TokenCostResult[]) | `enrichScanResults(results)` calls `lookupMcpEstimate` and `estimateFromFileSize` | Yes — live execution returned 376 ghost items with token estimates | FLOWING |
| `ghost.ts` | `totalOverhead` (number) | `calculateTotalOverhead(ghosts)` sums `r.tokenEstimate?.tokens` | Yes — output showed `~916k tokens (~458.1%)` | FLOWING |
| `mcp.ts` | `enriched` (TokenCostResult[]) | `enrichScanResults(mcpResults)` using lookup from bundled JSON | Yes — live execution returned 4 MCP servers with estimates | FLOWING |
| `mcp-estimates-data.ts` | `estimatesMap` (Map) | Validated JSON from bundled `mcp-token-estimates.json` at module load | Yes — 10 entries confirmed by test suite | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| CLI shows `mcp` subcommand | `node dist/index.js --help` | Output includes `mcp <OPTIONS>` | PASS |
| `mcp` subcommand has `--live` flag | `node dist/index.js mcp --help` | Output includes `-l, --live` flag | PASS |
| Ghost text output has `~` prefix and confidence | `node dist/index.js ghost --since 30d` | `~1.1k tokens (estimated)` per item | PASS |
| Ghost text output shows total overhead with percentage | `node dist/index.js ghost --since 30d` (tail) | `~916k tokens (~458.1% of 200k context window)` | PASS |
| MCP subcommand shows token costs | `node dist/index.js mcp --since 30d` | `~1.5k tokens (estimated)` per MCP server + total overhead | PASS |
| All 44 token module tests pass | `pnpm vitest --run packages/internal/src/token/` | 6 test files, 44 tests, all passed | PASS |
| TypeScript compiles without errors | `pnpm tsc --noEmit` (both packages) | EXIT:0 for both internal and ccaudit | PASS |
| Build succeeds | `pnpm -F ccaudit build` | `Build complete in 26ms`, 205KB bundle | PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|----------|
| TOKN-01 | 04-01-PLAN, 04-03-PLAN | Per-item token cost estimated from embedded `mcp-token-estimates.json` | SATISFIED | `enrichScanResults` dispatches to `lookupMcpEstimate` for MCP servers; file-size estimator for agents/memory/skills |
| TOKN-02 | 04-01-PLAN, 04-03-PLAN | All estimates labeled with `~` prefix everywhere | SATISFIED | `formatTokenEstimate` always returns `~${...} tokens (${confidence})`; null returns "unknown"; live output confirmed |
| TOKN-03 | 04-01-PLAN, 04-03-PLAN | Confidence tier shown per estimate: "estimated" / "measured" / "community-reported" | SATISFIED | `formatTokenEstimate` includes confidence tier in parentheses; live output shows `(estimated)` |
| TOKN-04 | 04-02-PLAN, 04-03-PLAN | `ccaudit mcp --live` connects to running MCP servers for exact token count | SATISFIED | `listMcpTools` spawns via child_process + JSON-RPC handshake; `measureMcpTokens` returns confidence='measured'; fallback to estimate on failure |
| TOKN-05 | 04-01-PLAN, 04-03-PLAN | Total ghost overhead as token count and percentage of 200k context window | SATISFIED | `formatTotalOverhead` produces `~Xk tokens (~Y.Z% of 200k context window)`; live output confirmed |

All 5 TOKN requirements are marked `[x]` in REQUIREMENTS.md. No orphaned requirements detected.

### Anti-Patterns Found

No blockers or warnings found.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `file-size-estimator.ts` | 22 | `return null` | Info | Intentional — error path when file does not exist; documented in JSDoc |

The `return null` in `file-size-estimator.ts` is the explicit error-path contract (file not found), not a stub. No TODO/FIXME/placeholder comments found in any Phase 4 file.

### Human Verification Required

#### 1. ccaudit mcp --live with a real running MCP server

**Test:** Start a real MCP server (e.g., `context7` or `sequential-thinking`) and run `ccaudit mcp --live`
**Expected:** Token estimate for that server changes from confidence `"estimated"` to `"measured"`; token count reflects actual JSON-serialized tool definitions divided by 4
**Why human:** Requires a live MCP server process. The mock server test validates the mechanism; this confirms end-to-end behavior with a production server.

### Gaps Summary

No gaps. All phase goal truths are verified, all artifacts are substantive and wired, all data flows to real output. The `--live` path is mechanically verified (spawn + JSON-RPC handshake tested with mock server); the human verification item is an integration test with an external service, not a gap.

---

_Verified: 2026-04-04T10:30:00Z_
_Verifier: Claude (gsd-verifier)_
