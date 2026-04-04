# Phase 4: Token Cost Attribution - Validation Strategy

**Phase:** 4
**Slug:** token-cost-attribution
**Created:** 2026-04-04
**Source:** Extracted from 04-RESEARCH.md Validation Architecture

## Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x |
| Config file | `packages/internal/vitest.config.ts` (in-source), `vitest.config.ts` (root workspace) |
| Quick run command | `pnpm vitest --run` |
| Full suite command | `pnpm vitest --run` |

## Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOKN-01 | MCP token lookup from bundled JSON | unit | `pnpm vitest --run -- src/token/mcp-estimates-data.ts` | Wave 0 |
| TOKN-01 | enrichScanResults returns token estimates for all categories | unit | `pnpm vitest --run -- src/token/estimate.ts` | Wave 0 |
| TOKN-02 | formatTokenEstimate always includes ~ prefix | unit | `pnpm vitest --run -- src/token/format.ts` | Wave 0 |
| TOKN-03 | Confidence tier present on every TokenEstimate | unit | `pnpm vitest --run -- src/token/types.ts` | Wave 0 |
| TOKN-04 | MCP live client sends initialize + tools/list, parses response | unit | `pnpm vitest --run -- src/token/mcp-live-client.ts` | Wave 0 |
| TOKN-04 | Live client handles timeout + bad server gracefully | unit | `pnpm vitest --run -- src/token/mcp-live-client.ts` | Wave 0 |
| TOKN-05 | formatTotalOverhead shows absolute + percentage | unit | `pnpm vitest --run -- src/token/format.ts` | Wave 0 |
| TOKN-05 | Total ghost overhead sums correctly across categories | unit | `pnpm vitest --run -- src/token/estimate.ts` | Wave 0 |

## Sampling Rate

- **Per task commit:** `pnpm vitest --run`
- **Per wave merge:** `pnpm vitest --run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

## Wave 0 Gaps

- [ ] `packages/internal/src/token/types.ts` -- TokenEstimate, TokenCostResult interfaces + type tests
- [ ] `packages/internal/src/token/mcp-estimates-data.ts` -- JSON import, valibot validation, lookup function
- [ ] `packages/internal/src/token/file-size-estimator.ts` -- estimateFromFileSize with fs.stat
- [ ] `packages/internal/src/token/estimate.ts` -- enrichScanResults pipeline
- [ ] `packages/internal/src/token/format.ts` -- formatTokenEstimate, formatTotalOverhead
- [ ] `packages/internal/src/token/mcp-live-client.ts` -- minimal JSON-RPC client
- [ ] `packages/internal/src/data/mcp-token-estimates.json` -- initial community data file
