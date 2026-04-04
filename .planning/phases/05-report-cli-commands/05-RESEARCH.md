# Phase 5: Report & CLI Commands - Research

**Researched:** 2026-04-04
**Domain:** CLI report rendering, table formatting, health scoring, recommendation engine
**Confidence:** HIGH

## Summary

Phase 5 transforms ccaudit's raw ghost detection data into polished, user-facing CLI reports. The foundation is solid: Phase 4 delivered `enrichScanResults()` and `calculateTotalOverhead()`, the `Recommendation` type already exists in `packages/internal/src/types.ts`, and `@ccaudit/terminal` is a stub waiting for implementation. The work splits into three concerns: (1) the `@ccaudit/terminal` package becomes a real rendering layer wrapping `cli-table3` with column definitions for each report view, (2) three new gunshi subcommands (`inventory`, `trend`, plus refactoring `ghost` to use the new tables), and (3) two new pure-logic modules -- a health score calculator and a recommendation classifier -- that live in `@ccaudit/internal`.

The project already follows the pattern `scanAll -> enrichScanResults -> filter -> display` established in Phase 4. Phase 5 inserts two steps after enrichment: `classifyRecommendation()` (per-item Archive/Monitor/Keep) and `calculateHealthScore()` (aggregate 0-100). The terminal package then renders the annotated results through category-specific table builders using `cli-table3`. The `--since` window is already plumbed through all commands and just needs to be surfaced in output headers.

**Primary recommendation:** Build the health score and recommendation engine as pure functions in `@ccaudit/internal` (testable without terminal), then build `@ccaudit/terminal` as a thin rendering layer over `cli-table3`, and finally wire the three new subcommands in `apps/ccaudit`. Integration tests use fixture JSONL files in a tmp directory, asserting on the string output of `table.toString()`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REPT-01 | Default command shows ghost inventory table: Defined / Used / Ghost / ~Token-cost columns per category | cli-table3 table builder pattern in `@ccaudit/terminal`; existing `enrichScanResults` provides all data |
| REPT-02 | `ccaudit inventory` shows full inventory with all usage stats | New gunshi subcommand; full scan results (not just ghosts) with Defined/Used/Ghost counts and token costs |
| REPT-03 | `ccaudit mcp` shows MCP-specific detail view (token cost + frequency) | Already exists from Phase 4; needs table formatting upgrade via `@ccaudit/terminal` |
| REPT-04 | `ccaudit trend` shows invocation frequency over time | New gunshi subcommand; aggregates invocations by day/week from parsed session data |
| REPT-05 | Health score (0-100) displayed in all report views; README badge-ready; CI gate semantics | Pure function `calculateHealthScore()` in `@ccaudit/internal`; weighted formula based on ghost ratio + token overhead |
| REPT-06 | Per-item recommendations shown: Archive / Monitor / Keep | Pure function `classifyRecommendation()` mapping GhostTier -> Recommendation; `Recommendation` type already defined |
| REPT-07 | `--since` window displayed prominently in output headers | Already plumbed; just needs prominent header rendering in table output |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Runtime deps**: Zero -- all deps as devDependencies, bundler owns the payload
- **Distribution**: `npx ccaudit@latest` -- zero-install
- **Tech stack**: TypeScript/Node, gunshi CLI, tinyglobby, valibot safeParse, cli-table3, tsdown, vitest in-source tests, pnpm workspaces
- **Monorepo layout**: `apps/ccaudit/` (main CLI), `packages/internal/` (shared types/utils), `packages/terminal/` (table rendering)
- **GSD Workflow**: Use Edit, Write, or other file-changing tools only through a GSD workflow
- **Testing**: vitest in-source testing with `if (import.meta.vitest)` blocks; TZ=UTC in test scripts
- **Colors**: cli-table3 handles ANSI in tables; `picocolors` for non-table color (already in catalog at ^1.1.1)
- **NO_COLOR**: picocolors auto-detects NO_COLOR/FORCE_COLOR (Phase 6 handles this formally, but be aware)

## Standard Stack

### Core (already installed -- catalog versions)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| cli-table3 | ^0.6.5 | Terminal table rendering | Already in @ccaudit/terminal devDeps; built-in TS types; column spanning, word wrap, ANSI colors |
| gunshi | ^0.29.3 | CLI framework | Already used; `define()` for subcommands, `cli()` with `subCommands` map |
| picocolors | ^1.1.1 | Non-table terminal colors | Already in catalog; auto-detects NO_COLOR; used for headers, score display |
| vitest | ^4.1.2 | Test runner | In-source testing via `import.meta.vitest` blocks |

### No new dependencies needed

Phase 5 requires zero new packages. Everything needed is already in the catalog and installed. The `@ccaudit/terminal` package already lists `cli-table3` as a devDependency.

## Architecture Patterns

### Current Data Flow (Phase 4)
```
discoverSessionFiles -> parseSession -> scanAll -> enrichScanResults -> filter -> console.log
```

### Target Data Flow (Phase 5)
```
discoverSessionFiles -> parseSession -> scanAll -> enrichScanResults
  -> classifyRecommendation (per item)
  -> calculateHealthScore (aggregate)
  -> renderGhostTable / renderInventoryTable / renderMcpTable / renderTrendTable
  -> console.log(table.toString())
```

### Module Placement

```
packages/internal/src/
  report/
    health-score.ts      # calculateHealthScore() -- pure function
    recommendation.ts    # classifyRecommendation() -- pure function
    trend.ts             # buildTrendData() -- aggregates invocations by time bucket
    types.ts             # ReportData, HealthScore, TrendBucket types
    index.ts             # barrel export

packages/terminal/src/
  tables/
    ghost-table.ts       # renderGhostTable() -- cli-table3 for default/ghost view
    inventory-table.ts   # renderInventoryTable() -- full inventory view
    mcp-table.ts         # renderMcpTable() -- MCP-specific detail view
    trend-table.ts       # renderTrendTable() -- invocation frequency view
    header.ts            # renderHeader() -- common header with --since window
    score.ts             # renderHealthScore() -- colored score display
    index.ts             # barrel export
  index.ts               # re-export from tables/

apps/ccaudit/src/cli/commands/
  ghost.ts               # REFACTOR: use @ccaudit/terminal tables
  mcp.ts                 # REFACTOR: use @ccaudit/terminal tables
  inventory.ts           # NEW: full inventory view
  trend.ts               # NEW: invocation frequency view
```

### Pattern 1: cli-table3 Table Builder

**What:** Each view has a dedicated table builder function that accepts typed data and returns a formatted string.

**Example:**
```typescript
// packages/terminal/src/tables/ghost-table.ts
import Table from 'cli-table3';
import type { TokenCostResult } from '@ccaudit/internal';

export interface GhostTableOptions {
  sinceWindow: string;
  showRecommendation: boolean;
}

export function renderGhostTable(
  results: TokenCostResult[],
  options: GhostTableOptions,
): string {
  const table = new Table({
    head: ['Category', 'Name', 'Scope', 'Tier', 'Last Used', '~Token Cost', 'Action'],
    style: { head: ['cyan'] },
    wordWrap: true,
  });

  for (const r of results) {
    table.push([
      r.item.category,
      r.item.name,
      r.item.scope,
      r.tier === 'definite-ghost' ? 'GHOST' : 'LIKELY',
      formatLastUsed(r.lastUsed),
      formatTokenEstimate(r.tokenEstimate),
      recommendation, // Archive / Monitor / Keep
    ]);
  }

  return table.toString();
}
```

### Pattern 2: Health Score Pure Function

**What:** A pure function that takes enriched scan results and returns a 0-100 score with grade breakdown.

**When to use:** Called once per report render, result embedded in header and JSON output.

**Algorithm Design (recommended):**

```
healthScore = 100 - ghostPenalty - tokenPenalty

ghostPenalty:
  - Each definite-ghost:  3 points (capped at 60 total)
  - Each likely-ghost:    1 point  (capped at 20 total)

tokenPenalty:
  - (ghostTokens / contextWindow) * 100, capped at 20

Score bounds: min 0, max 100
```

**Rationale:** The score should be:
- 100 = clean inventory, zero ghosts
- 80-99 = a few likely-ghosts, minimal token waste (healthy)
- 50-79 = multiple ghosts, noticeable token waste (needs attention)
- 0-49 = heavy ghost load, significant context window waste (critical)

The cap structure prevents a single category from dominating. Token overhead matters but is secondary to ghost count because even zero-token ghosts (like memory files) still cause cognitive overhead.

**CI Gate Semantics:**
- Exit code 0: score >= threshold (default 70)
- Exit code 1: score < threshold
- Threshold configurable via `--threshold` flag (Phase 6) or `.ccauditrc` (v2)

**Badge rendering:**
```
Score: 85/100 (Healthy)
```
The numeric score and grade label are badge-ready: `https://img.shields.io/badge/ccaudit-85%2F100-green`

### Pattern 3: Recommendation Classifier

**What:** Maps `GhostTier` + `ItemCategory` to `Recommendation`.

**Logic:**
```
definite-ghost -> archive    (all categories)
likely-ghost   -> monitor    (all categories)
used           -> keep       (all categories)
```

This is deliberately simple. The `Recommendation` type (`'archive' | 'monitor' | 'keep'`) is already defined in `packages/internal/src/types.ts`. The function signature:

```typescript
export function classifyRecommendation(tier: GhostTier): Recommendation {
  switch (tier) {
    case 'definite-ghost': return 'archive';
    case 'likely-ghost': return 'monitor';
    case 'used': return 'keep';
  }
}
```

### Pattern 4: Trend Data Builder

**What:** Aggregates `InvocationRecord[]` into time-bucketed frequency data.

**Logic:**
```typescript
interface TrendBucket {
  period: string;       // ISO date (day) or "Week of YYYY-MM-DD"
  agents: number;
  skills: number;
  mcp: number;
  total: number;
}
```

The trend command groups invocations by day (default) or week, showing how activity changes over the `--since` window. This is useful for identifying items that were active but are now declining.

### Pattern 5: gunshi Subcommand Registration

**What:** Each subcommand is a `define()` call registered in the `subCommands` map.

**Current pattern (from `apps/ccaudit/src/cli/index.ts`):**
```typescript
import { cli } from 'gunshi';
import { ghostCommand } from './commands/ghost.ts';
import { mcpCommand } from './commands/mcp.ts';

await cli(args, ghostCommand, {
  name: 'ccaudit',
  version: '0.0.1',
  description: '...',
  subCommands: {
    ghost: ghostCommand,
    mcp: mcpCommand,
    // Add: inventory, trend
  },
});
```

New commands follow the exact same `define()` pattern. The first positional arg to `cli()` is the default command (ghost), so `npx ccaudit` without a subcommand runs `ghost`.

### Anti-Patterns to Avoid

- **Mixing rendering with logic:** Health score and recommendation MUST be pure functions in `@ccaudit/internal`, not embedded in CLI commands. Planner: enforce separate modules.
- **Hardcoded column widths:** Let cli-table3 auto-size. Only set `colWidths` if content overflows. `wordWrap: true` handles long names.
- **ANSI in JSON output:** When `--json` is active, skip all table rendering and emit raw JSON. Never mix ANSI escape codes with JSON output.
- **Reimplementing table rendering per command:** Each command file should call a single render function from `@ccaudit/terminal`, not construct its own Table instance.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Terminal tables | Manual string padding and column alignment | cli-table3 | Unicode width, word wrap, column spanning, ANSI color support -- all edge cases handled |
| ANSI colors | Raw escape codes | picocolors | Auto-detects NO_COLOR, FORCE_COLOR; tiny bundle |
| Health score normalization | Custom scaling functions | Math.min/Math.max with cap constants | Simple arithmetic with guard rails; overengineering the normalization adds complexity without value |

**Key insight:** The rendering layer in `@ccaudit/terminal` is thin by design. cli-table3 does the heavy lifting. The terminal package is a configuration layer (column definitions, header templates, color choices) not a rendering engine.

## Common Pitfalls

### Pitfall 1: cli-table3 import in ESM context
**What goes wrong:** `import Table from 'cli-table3'` may fail because cli-table3 is CommonJS.
**Why it happens:** cli-table3 publishes CJS only. ESM interop can vary.
**How to avoid:** Use `import Table from 'cli-table3'` with tsdown's `nodeProtocol: true`. tsdown handles CJS->ESM interop in the bundle. If import fails at dev time, use `import { default as Table } from 'cli-table3'` or check that `@types/cli-table3` is not needed (cli-table3 0.6.5 includes its own `.d.ts`).
**Warning signs:** "default is not a function" or "Table is not a constructor" errors.

### Pitfall 2: Terminal width assumptions
**What goes wrong:** Tables overflow on narrow terminals, breaking formatting.
**Why it happens:** cli-table3 does not auto-truncate by default.
**How to avoid:** Enable `wordWrap: true` on tables. Consider responsive column hiding for terminals < 80 chars (optional for v1, pattern established by ccusage's ResponsiveTable). For v1, word wrap is sufficient.
**Warning signs:** Garbled output in CI logs or narrow terminal windows.

### Pitfall 3: Health score instability
**What goes wrong:** Score changes wildly between runs due to time-sensitive ghost classification.
**Why it happens:** Items right at the 7-day or 30-day boundary flip between tiers.
**How to avoid:** Accept this as inherent behavior. The score reflects the current state. Document that the score is a point-in-time snapshot. The `--since` window makes the time sensitivity explicit.
**Warning signs:** Users reporting "score changed but nothing happened."

### Pitfall 4: Trend data with empty windows
**What goes wrong:** Trend view shows gaps or empty buckets when no sessions exist for certain days.
**Why it happens:** Not all days have session activity.
**How to avoid:** Fill empty buckets with zero counts. Show the full range from (now - sinceMs) to now with zero-filled gaps. This makes the decline pattern visible.
**Warning signs:** Sparse/confusing trend output.

### Pitfall 5: TypeScript project references stale declarations
**What goes wrong:** Changes to `@ccaudit/internal` or `@ccaudit/terminal` types are not visible from `apps/ccaudit`.
**Why it happens:** Composite TypeScript projects require `tsc -b` to regenerate `.d.ts` files.
**How to avoid:** Run `tsc -b` after modifying types in packages/. This was already noted in Phase 4's summary. The developer workflow is: edit package -> `tsc -b` -> edit app.
**Warning signs:** "Cannot find module" or stale type errors in apps/ccaudit.

### Pitfall 6: Ghost command refactoring breaks existing behavior
**What goes wrong:** Refactoring ghost.ts to use the new table renderer changes the output format in ways that break expectations.
**Why it happens:** Moving from manual console.log to cli-table3 changes the exact string output.
**How to avoid:** The JSON output (`--json`) is the stable contract. Text output is allowed to change between versions. Write integration tests against row counts and column presence, not exact string matching.
**Warning signs:** Brittle tests that break on formatting changes.

## Code Examples

### cli-table3 Basic Usage (verified from npm docs)
```typescript
// Source: https://www.npmjs.com/package/cli-table3
import Table from 'cli-table3';

const table = new Table({
  head: ['Name', 'Tier', 'Last Used', '~Token Cost', 'Action'],
  style: { head: ['cyan'] },
  wordWrap: true,
});

table.push(
  ['context7', 'GHOST', 'never', '~1.5k tokens (estimated)', 'Archive'],
  ['playwright', 'LIKELY', '12d ago', '~14k tokens (community-reported)', 'Monitor'],
);

console.log(table.toString());
```

### Category Summary Table (for REPT-01 default view)
```typescript
// Defined/Used/Ghost columns per category
const summaryTable = new Table({
  head: ['Category', 'Defined', 'Used', 'Ghost', '~Token Cost'],
  style: { head: ['cyan'] },
});

const categories = ['agent', 'skill', 'mcp-server', 'memory'] as const;
for (const cat of categories) {
  const catItems = enriched.filter(r => r.item.category === cat);
  const used = catItems.filter(r => r.tier === 'used').length;
  const ghosts = catItems.filter(r => r.tier !== 'used').length;
  const tokens = calculateTotalOverhead(catItems.filter(r => r.tier !== 'used'));
  summaryTable.push([cat, catItems.length, used, ghosts, formatTokenEstimate(/* ... */)]);
}
```

### gunshi Subcommand Definition
```typescript
// Source: existing ghost.ts + mcp.ts pattern
import { define } from 'gunshi';

export const inventoryCommand = define({
  name: 'inventory',
  description: 'Show full inventory with usage statistics',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for analysis (e.g., 7d, 30d, 2w)',
      default: '7d',
    },
    json: { type: 'boolean', short: 'j', description: 'Output as JSON', default: false },
    verbose: { type: 'boolean', short: 'v', description: 'Show scan details', default: false },
  },
  async run(ctx) {
    // Follow same pattern: discover -> parse -> scan -> enrich -> render
  },
});
```

### Health Score with Badge Output
```typescript
// packages/internal/src/report/health-score.ts
import type { TokenCostResult } from '../token/types.ts';
import { CONTEXT_WINDOW_SIZE } from '../token/mcp-estimates-data.ts';

export interface HealthScore {
  score: number;           // 0-100
  grade: string;           // 'Healthy' | 'Fair' | 'Poor' | 'Critical'
  ghostPenalty: number;    // points deducted for ghosts
  tokenPenalty: number;    // points deducted for token overhead
}

export function calculateHealthScore(results: TokenCostResult[]): HealthScore {
  const definiteGhosts = results.filter(r => r.tier === 'definite-ghost').length;
  const likelyGhosts = results.filter(r => r.tier === 'likely-ghost').length;

  const ghostPenalty = Math.min(definiteGhosts * 3, 60) + Math.min(likelyGhosts * 1, 20);

  const ghostTokens = results
    .filter(r => r.tier !== 'used')
    .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
  const tokenPenalty = Math.min(
    Math.round((ghostTokens / CONTEXT_WINDOW_SIZE) * 100),
    20,
  );

  const score = Math.max(0, 100 - ghostPenalty - tokenPenalty);

  let grade: string;
  if (score >= 80) grade = 'Healthy';
  else if (score >= 50) grade = 'Fair';
  else if (score >= 20) grade = 'Poor';
  else grade = 'Critical';

  return { score, grade, ghostPenalty, tokenPenalty };
}
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `packages/internal/vitest.config.ts`, `packages/terminal/vitest.config.ts`, `apps/ccaudit/vitest.config.ts` |
| Quick run command | `pnpm -F @ccaudit/internal test` or `pnpm -F @ccaudit/terminal test` |
| Full suite command | `pnpm -r test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REPT-01 | Default ghost table with Defined/Used/Ghost/Token-cost columns | integration | `pnpm -F ccaudit test` (in-source in ghost.ts or dedicated test) | Wave 0 |
| REPT-02 | `ccaudit inventory` produces full inventory view | integration | `pnpm -F ccaudit test` (in-source in inventory.ts) | Wave 0 |
| REPT-03 | `ccaudit mcp` produces MCP detail view with table | integration | `pnpm -F ccaudit test` (in-source in mcp.ts) | Wave 0 |
| REPT-04 | `ccaudit trend` produces invocation frequency view | integration | `pnpm -F ccaudit test` (in-source in trend.ts) | Wave 0 |
| REPT-05 | Health score (0-100) in all views, badge-ready | unit | `pnpm -F @ccaudit/internal test` (in-source in health-score.ts) | Wave 0 |
| REPT-06 | Per-item recommendations (Archive/Monitor/Keep) | unit | `pnpm -F @ccaudit/internal test` (in-source in recommendation.ts) | Wave 0 |
| REPT-07 | `--since` window in output headers | unit | `pnpm -F @ccaudit/terminal test` (in-source in header.ts) | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm -F @ccaudit/internal test && pnpm -F @ccaudit/terminal test`
- **Per wave merge:** `pnpm -r test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/internal/src/report/health-score.ts` -- covers REPT-05 (in-source tests for score calculation)
- [ ] `packages/internal/src/report/recommendation.ts` -- covers REPT-06 (in-source tests for tier -> recommendation mapping)
- [ ] `packages/internal/src/report/trend.ts` -- covers REPT-04 (in-source tests for time bucketing)
- [ ] `packages/terminal/src/tables/ghost-table.ts` -- covers REPT-01 (in-source tests for table output)
- [ ] `packages/terminal/src/tables/header.ts` -- covers REPT-07 (in-source tests for header rendering)
- [ ] Integration test fixtures: JSONL fixture files + mock filesystem setup for full-path tests

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual console.log per item | cli-table3 table rendering | Phase 5 | Structured, aligned, professional output |
| No health metric | Health score 0-100 | Phase 5 | CI gate semantics, README badges, shareable metric |
| No per-item guidance | Archive/Monitor/Keep recommendation | Phase 5 | Actionable output -- users know what to do next |
| Ghost-only view | Four subcommands (ghost, inventory, mcp, trend) | Phase 5 | Different views for different user needs |

## Open Questions

1. **Trend granularity**
   - What we know: Invocations have ISO timestamps. We can bucket by day or week.
   - What's unclear: Should `ccaudit trend` default to daily or weekly? How many buckets are useful?
   - Recommendation: Default to daily for `--since 7d`, weekly for `--since 30d` or longer. Auto-select based on window size.

2. **Health score threshold for CI**
   - What we know: REPT-05 says "CI gate semantics." Phase 6 handles exit codes (OUTP-01).
   - What's unclear: Should Phase 5 compute the score only, or also set exit codes?
   - Recommendation: Phase 5 computes and displays the score. Phase 6 adds `--threshold` and exit code logic. Keep phases orthogonal.

3. **Inventory view: what counts as "Defined"?**
   - What we know: REPT-01 says "Defined / Used / Ghost" columns. "Defined" = total items found by scanner. "Used" = tier === 'used'. "Ghost" = tier !== 'used'.
   - What's unclear: Is "Defined" the raw scanner count, or should it match Defined = Used + Ghost?
   - Recommendation: Defined = total items. Used + Ghost should equal Defined. Display as a summary row per category.

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `apps/ccaudit/src/cli/commands/ghost.ts`, `mcp.ts`, `packages/internal/src/` -- current implementation patterns
- Codebase inspection: `packages/internal/src/types.ts` -- `Recommendation` type already defined as `'archive' | 'monitor' | 'keep'`
- cli-table3 npm: https://www.npmjs.com/package/cli-table3 -- API, constructor options
- cli-table3 GitHub README: https://github.com/cli-table/cli-table3 -- column spanning, style, wordWrap
- gunshi docs: https://gunshi.dev/guide/advanced/advanced-lazy-loading -- subcommand registration pattern
- Phase 4 Summary (04-03-SUMMARY.md) -- enrichment pipeline and handoff notes

### Secondary (MEDIUM confidence)
- ccusage DeepWiki: https://deepwiki.com/ryoppippi/ccusage -- terminal package architecture, ResponsiveTable pattern
- CodeScene code health: https://codescene.com/product/code-health -- weighted scoring methodology inspiration

### Tertiary (LOW confidence)
- Health score algorithm design is ccaudit's own -- no direct precedent found in npm CLI tools. The weighted formula (ghost count + token overhead) is a reasonable first cut but may need tuning after real-world usage.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already installed and used in project
- Architecture: HIGH - follows established patterns from Phases 1-4, module placement is clear
- Health score algorithm: MEDIUM - no precedent in this exact domain; formula is reasonable but untested against real inventories
- Pitfalls: HIGH - TypeScript composite project issues and cli-table3 ESM interop are documented from prior phases

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (30 days -- stable domain, no fast-moving dependencies)
