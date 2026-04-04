---
phase: 05-report-cli-commands
verified: 2026-04-04T12:00:00Z
status: passed
score: 7/7 success criteria verified
re_verification:
  previous_status: gaps_found
  previous_score: 5/7
  gaps_closed:
    - "Health score (0-100) appears in all four subcommand outputs — trend.ts now imports calculateHealthScore/enrichScanResults/renderHealthScore, runs the scan+enrich pipeline, and renders renderHealthScore() in both text and JSON branches"
    - "Integration tests exercise the full ghost command path — ghost-command.test.ts now calls discoverSessionFiles with custom claudePaths, follows the pipeline through parseSession -> scanAll -> enrichScanResults, and asserts ghost detection accuracy (stale-helper and unused-server as ghosts, code-reviewer as used)"
  gaps_remaining: []
  regressions: []
---

# Phase 05: Report & CLI Commands Verification Report

**Phase Goal:** Users can run `ccaudit ghost`, `ccaudit inventory`, `ccaudit mcp`, and `ccaudit trend` to see ghost tables with Defined/Used/Ghost/Token-cost columns, a health score, per-item recommendations, and the `--since` window prominently displayed
**Verified:** 2026-04-04T12:00:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure via plan 05-04

---

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `npx ccaudit` (default) renders ghost inventory table with Defined/Used/Ghost/~Token-cost columns per category | VERIFIED | `ghost.ts` line 165 calls `renderGhostSummary(summaries)`. CategorySummary[] has defined/used/ghost/tokenCost fields per category. Four categories rendered. |
| 2 | `ccaudit inventory`, `ccaudit mcp`, and `ccaudit trend` each produce their specialized views | VERIFIED | All three files exist at `apps/ccaudit/src/cli/commands/{inventory,mcp,trend}.ts`, registered in `cli/index.ts` lines 17-20, each calling `renderInventoryTable`, `renderMcpTable`, `renderTrendTable`. |
| 3 | Health score (0-100) appears in all report views | VERIFIED | `ghost.ts` line 184, `inventory.ts` line 117, `mcp.ts` line 202, and `trend.ts` line 106 all call `console.log(renderHealthScore(healthScore))`. Gap closed by plan 05-04. |
| 4 | Per-item recommendations (Archive / Monitor / Keep) shown in output | VERIFIED | `classifyRecommendation()` drives the Action column in `inventory-table.ts` and `mcp-table.ts`. `ghost.ts` and `inventory.ts` JSON outputs include `recommendation` field per item. |
| 5 | `--since` window displayed prominently in output headers | VERIFIED | All four commands call `renderHeader(emoji, title, humanizeSinceWindow(sinceStr))`: ghost.ts line 163, inventory.ts line 107, mcp.ts line 186, trend.ts line 95. |
| 6 | Integration tests exercise the full ghost command path using a mock filesystem (tmp directory) and fixture JSONL files | VERIFIED | `ghost-command.test.ts` contains test at line 387: "exercises full discover->parse->scan->enrich pipeline against mock filesystem." Calls `discoverSessionFiles({claudePaths})` pointing to tmp fixture dir, runs `parseSession`, `scanAll`, `enrichScanResults`, asserts stale-helper and unused-server are ghosts, code-reviewer is used. |
| 7 | Test assertions on rendered output columns and row counts | VERIFIED | 7 render-level integration tests plus 1 pipeline test assert on column headers, line counts, sort order, and specific field presence across renderGhostSummary, renderTopGhosts, renderHealthScore, renderHeader, renderInventoryTable, renderMcpTable. |

**Score:** 7/7 success criteria verified

---

## Required Artifacts

### Plan 01 Artifacts (packages/internal/src/report/)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/internal/src/report/health-score.ts` | calculateHealthScore() pure function | VERIFIED | Real scoring algorithm with 8 in-source tests. Imports from `../token/types.ts` and `../token/mcp-estimates-data.ts`. |
| `packages/internal/src/report/recommendation.ts` | classifyRecommendation() pure function | VERIFIED | 3-case switch over GhostTier with 3 in-source tests. |
| `packages/internal/src/report/trend.ts` | buildTrendData() aggregation function | VERIFIED | Daily/weekly bucketing with zero-fill. 4 in-source tests covering edge cases. |
| `packages/internal/src/report/types.ts` | HealthScore, HealthGrade, TrendBucket, CategorySummary types | VERIFIED | All 4 types exported and used downstream. |
| `packages/internal/src/report/index.ts` | barrel re-export for report module | VERIFIED | Re-exports all 3 functions and 4 types. |
| `packages/internal/src/index.ts` | updated barrel with report exports | VERIFIED | Lines export all report module symbols via `from './report/index.ts'`. |
| `apps/ccaudit/src/__tests__/ghost-command.test.ts` | Integration test scaffold with fixture JSONL and full pipeline test | VERIFIED | 469 lines. Full mock filesystem. 8 render-level tests + 1 full pipeline test all passing. |

### Plan 02 Artifacts (packages/terminal/src/tables/)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/terminal/src/tables/header.ts` | renderHeader() and renderDivider() | VERIFIED | Bold header with since window, heavy-box divider, humanizeSinceWindow. |
| `packages/terminal/src/tables/score.ts` | renderHealthScore() with color by grade | VERIFIED | picocolors green/Healthy, yellow/Fair, red/Poor+Critical. Imports HealthScore from @ccaudit/internal. |
| `packages/terminal/src/tables/ghost-table.ts` | renderGhostSummary() and renderTopGhosts() | VERIFIED | Column-aligned plain text (not cli-table3), per-category Defined/Used/Ghost labels and ~Xk tokens. |
| `packages/terminal/src/tables/inventory-table.ts` | renderInventoryTable() cli-table3 table | VERIFIED | Columns: Name, Category, Scope, Tier, Last Used, ~Token Cost, Action. |
| `packages/terminal/src/tables/mcp-table.ts` | renderMcpTable() cli-table3 table | VERIFIED | Columns: Server, Scope, Tier, Invocations, Last Used, ~Token Cost, Action. |
| `packages/terminal/src/tables/trend-table.ts` | renderTrendTable() cli-table3 table | VERIFIED | Columns: Period, Agents, Skills, MCP, Total. |
| `packages/terminal/src/index.ts` | barrel re-export | VERIFIED | 9 functions exported from `./tables/index.ts`. |

### Plan 03/04 Artifacts (apps/ccaudit/src/cli/)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/ccaudit/src/cli/commands/ghost.ts` | Refactored ghost with @ccaudit/terminal renderers | VERIFIED | Full pipeline, health score, category summaries, top ghosts, footer hints. JSON includes healthScore and recommendation. |
| `apps/ccaudit/src/cli/commands/mcp.ts` | Refactored mcp with renderers + in-source tests | VERIFIED | Full pipeline, live measurement support, health score, recommendations. in-source test block at lines 207-231. |
| `apps/ccaudit/src/cli/commands/inventory.ts` | New inventory subcommand | VERIFIED | Full pipeline, bordered table, health score, recommendations in JSON. |
| `apps/ccaudit/src/cli/commands/trend.ts` | Trend with health score in all output modes | VERIFIED | Trend table + health score rendered in text. healthScore field in JSON. scanAll+enrichScanResults pipeline wired. Gap closed by plan 05-04. |
| `apps/ccaudit/src/cli/index.ts` | All 4 subcommands registered | VERIFIED | Lines 17-20: ghost, mcp, inventory, trend all in subCommands map. |

---

## Key Link Verification

### Plan 01 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `report/health-score.ts` | `token/types.ts` | `import type TokenCostResult` | VERIFIED | Line 1: `import type { TokenCostResult } from '../token/types.ts'` |
| `report/recommendation.ts` | `types.ts` | `import GhostTier, Recommendation` | VERIFIED | Line 1: `import type { GhostTier, Recommendation } from '../types.ts'` |
| `report/trend.ts` | `parser/types.ts` | `import InvocationRecord` | VERIFIED | Line 1: `import type { InvocationRecord } from '../parser/types.ts'` |

### Plan 02 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `terminal/ghost-table.ts` | `@ccaudit/internal TokenCostResult` | import type | VERIFIED | `import type { CategorySummary, TokenCostResult } from '@ccaudit/internal'` |
| `terminal/ghost-table.ts` | `@ccaudit/internal CategorySummary` | import type | VERIFIED | Same line, both types imported |
| `terminal/score.ts` | `@ccaudit/internal HealthScore` | import type | VERIFIED | `import type { HealthScore } from '@ccaudit/internal'` |

### Plan 03/04 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `commands/ghost.ts` | `@ccaudit/terminal` | renderGhostSummary, renderTopGhosts, renderHeader, renderHealthScore | VERIFIED | Lines 15-21 import all required renderers |
| `commands/inventory.ts` | `@ccaudit/terminal` | renderInventoryTable, renderHeader, renderHealthScore | VERIFIED | Lines 13-17 import renderers |
| `commands/inventory.ts` | `@ccaudit/internal classifyRecommendation` | used in JSON output | VERIFIED | Line 9 import, used at line 102 |
| `commands/trend.ts` | `@ccaudit/internal calculateHealthScore` | import and call | VERIFIED | Confirmed by `grep -c calculateHealthScore trend.ts` = 2 (import + call). Gap closed. |
| `commands/trend.ts` | `@ccaudit/terminal renderHealthScore` | import and console.log | VERIFIED | Confirmed by `grep -c renderHealthScore trend.ts` = 2 (import + call). Gap closed. |
| `cli/index.ts` | `commands/inventory.ts and commands/trend.ts` | subCommands registration | VERIFIED | Lines 17-20: all four commands in subCommands map |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `ghost.ts` | `enriched` | `enrichScanResults(results)` from `scanAll()` + real FS scan | Yes | FLOWING |
| `inventory.ts` | `enriched` | Same pipeline as ghost | Yes | FLOWING |
| `mcp.ts` | `enriched` | Same pipeline, filtered to mcp-server category | Yes | FLOWING |
| `trend.ts` | `buckets` | `buildTrendData(allInvocations, sinceMs)` from real session parse | Yes | FLOWING |
| `trend.ts` | `healthScore` | `calculateHealthScore(enriched)` from `scanAll` + `enrichScanResults` | Yes | FLOWING — gap closed |

---

## Behavioral Spot-Checks

Step 7b: SKIPPED (commands require live filesystem for session discovery; no runnable entry point without real Claude session files). Integration test suite exercises the equivalent path via mock filesystem.

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| REPT-01 | 05-02, 05-03 | Default command shows ghost inventory table: Defined/Used/Ghost/~Token-cost columns per category | SATISFIED | `renderGhostSummary()` produces column-aligned rows with Defined/Used/Ghost labels and ~Xk tokens/session. Called in ghost.ts line 165. |
| REPT-02 | 05-03 | `ccaudit inventory` shows full inventory with all usage stats | SATISFIED | `renderInventoryTable()` with Name/Category/Scope/Tier/Last Used/~Token Cost/Action columns. Wired in inventory.ts line 113. |
| REPT-03 | 05-03 | `ccaudit mcp` shows MCP-specific detail view (token cost + frequency) | SATISFIED | `renderMcpTable()` with Server/Scope/Tier/Invocations/Last Used/~Token Cost/Action columns. Wired in mcp.ts line 192. |
| REPT-04 | 05-01, 05-03 | `ccaudit trend` shows invocation frequency over time | SATISFIED | `buildTrendData()` + `renderTrendTable()` called in trend.ts. Daily/weekly bucketing with zero-fill verified by 4 in-source tests. |
| REPT-05 | 05-01, 05-03, 05-04 | Health score (0-100) in all report views; badge-ready; CI gate semantics | SATISFIED | All four commands call `renderHealthScore()`: ghost.ts line 184, inventory.ts line 117, mcp.ts line 202, trend.ts line 106. JSON output in all four includes healthScore object. Gap closed by plan 05-04. |
| REPT-06 | 05-01, 05-03 | Per-item recommendations (Archive/Monitor/Keep) shown in output | SATISFIED | `classifyRecommendation()` drives Action column in inventory-table.ts and mcp-table.ts. ghost.ts and inventory.ts include recommendation in JSON output. |
| REPT-07 | 05-02, 05-03 | `--since` window displayed prominently in output headers | SATISFIED | `renderHeader(emoji, title, humanizeSinceWindow(sinceStr))` called in all four commands. Produces "Last 7 days" style string in header line. |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | — | — | All renderer functions return strings (not print to stdout). No placeholder/TODO patterns in CLI command files. No hardcoded empty data flowing to render paths. |

---

## Human Verification Required

None — all verifiable aspects have been checked programmatically.

---

## Test Suite Results

All 254 tests pass across 33 test files:

- `packages/internal` — 207 tests (25 test files): includes calculateHealthScore (8), buildTrendData (4), classifyRecommendation (3), plus all prior phases
- `packages/terminal` — 35 tests (6 test files): includes renderHealthScore (5), renderHeader (8), renderGhostSummary/Top (12), renderInventoryTable (4), renderMcpTable (2), renderTrendTable (3), plus index barrel (1)
- `apps/ccaudit` — 12 tests (2 test files): mcp wiring in-source (3), ghost-command integration (9 = 1 fixture validation + 7 renderer tests + 1 pipeline test)

---

## Re-verification: Gap Closure Summary

Both gaps identified in the initial verification (2026-04-04T11:10:00Z) have been closed by plan 05-04:

**Gap 1 CLOSED — REPT-05 health score in trend command**
`trend.ts` now imports `calculateHealthScore`, `enrichScanResults`, `scanAll`, and `renderHealthScore`. It runs the full scan+enrich pipeline after building trend buckets and calls `console.log(renderHealthScore(healthScore))` in the text branch. The JSON branch includes `healthScore: { score, grade, ghostPenalty, tokenPenalty }`. Confirmed by grep counts: calculateHealthScore=2, renderHealthScore=2, scanAll=2, enrichScanResults=2.

**Gap 2 CLOSED — Full pipeline integration test**
`ghost-command.test.ts` now contains a full pipeline test (lines 387-468) that: (1) constructs `claudePaths` pointing to the tmp fixture directory, (2) calls `discoverSessionFiles({claudePaths})` and asserts session files found, (3) parses all sessions to get invocations, (4) calls `scanAll` with fixture claude paths and config path, (5) calls `enrichScanResults`, (6) asserts stale-helper and unused-server are detected as ghosts, code-reviewer detected as used, (7) computes health score and renders ghost summary from pipeline data. Confirmed by grep counts: discoverSessionFiles=3, scanAll=2, enrichScanResults=2. All 12 ccaudit tests pass.

**No regressions detected** — full suite (254 tests) passes clean.

---

_Verified: 2026-04-04T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
