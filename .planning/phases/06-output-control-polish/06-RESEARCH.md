# Phase 6: Output Control & Polish - Research

**Researched:** 2026-04-04
**Domain:** CLI output control, CI integration, color management, structured export (JSON/CSV)
**Confidence:** HIGH

## Summary

Phase 6 transforms ccaudit from a human-readable reporting tool into a CI-ready, script-friendly utility. The codebase already has `--json` and `--verbose` flags on all four subcommands, plus `process.exitCode = 1` for parse errors. This phase standardizes those patterns and adds `--no-color`, `--quiet`, `--ci`, and `--csv` flags, with exit code semantics for ghost detection.

The primary technical challenges are: (1) picocolors auto-detects `NO_COLOR` env but cli-table3 uses `@colors/colors` which does NOT auto-detect `NO_COLOR` -- both need explicit disabling; (2) gunshi has no built-in global args mechanism, so shared flags must use a `_shared-args.ts` pattern (following ccusage's proven approach); (3) CSV export requires RFC 4180 compliance without adding any dependency (trivial to hand-roll correctly); (4) vitest coverage with `@vitest/coverage-v8` is not yet installed and needs adding to the catalog.

**Primary recommendation:** Follow ccusage's `_shared-args.ts` pattern for global flags. Centralize color detection in `@ccaudit/terminal` with `createColors(false)` for picocolors and `style: {}` for cli-table3 when color is disabled. CSV formatter goes in `@ccaudit/terminal` alongside table renderers.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `ghost`, `inventory`, and `mcp` commands exit 1 when ghosts are found (any item with tier !== 'used'). `trend` always exits 0 -- it's informational time-series data with no "problem found" semantics.
- **D-02:** Exit code 1 is set via `process.exitCode = 1` (not `process.exit(1)`) to allow cleanup. This pattern is already established in all 4 commands for parse errors.
- **D-03:** Exit code check happens after all output is written -- never exit before rendering completes.
- **D-04:** `NO_COLOR` environment variable and `--no-color` flag both respected per the NO_COLOR spec. Either one disables all ANSI escape sequences.
- **D-05:** Color detection lives in `@ccaudit/terminal` package -- centralized, not per-command. All renderers check a shared `isColorEnabled()` function.
- **D-06:** When color is disabled, emoji remain (they're Unicode, not ANSI). Only ANSI color codes are stripped.
- **D-07:** `--no-color` flag added to the root command (gunshi `cli()` level) so it applies to all subcommands without per-command duplication.
- **D-08:** `--quiet` / `-q` suppresses all decorative output: headers, dividers, emoji, footer CTA, health score prose, "scanning..." messages. Shows only data rows (table body without borders) or raw JSON/CSV.
- **D-09:** `--quiet` alone (no --json/--csv) outputs machine-parseable plain text: tab-separated values, one row per item. This makes `ccaudit ghost --quiet | wc -l` count ghosts.
- **D-10:** `--quiet` with `--json` outputs compact JSON (no pretty-print, no newlines between fields).
- **D-11:** `--quiet` with `--csv` outputs CSV with no header row (data rows only -- header can be suppressed for append workflows).
- **D-12:** `--verbose` / `-v` already exists in all 4 commands. Phase 6 standardizes it: verbose shows files scanned, files skipped (and why), parse decisions, scan progress, and timing information.
- **D-13:** Verbose messages go to stderr, not stdout -- this preserves stdout for data (pipe-friendly). Use `console.error()` for verbose output.
- **D-14:** `--ci` is syntactic sugar: it enables `--json`, `--quiet`, and ensures exit code semantics. Not a separate implementation -- the command handler sets the other flags internally when `--ci` is present.
- **D-15:** `--ci` output is a single JSON object on stdout with exit code reflecting ghost status. Perfect for `npx ccaudit --ci | jq .healthScore.score`.
- **D-16:** `--json` already exists in all 4 commands (Phase 5). Phase 6 standardizes the schema: every command's JSON output includes a `meta` envelope with `{ command, version, since, timestamp, exitCode }` alongside the command-specific data.
- **D-17:** JSON output always goes to stdout, never mixed with decorative text. When `--json` is active, no non-JSON output is written to stdout.
- **D-18:** `--csv` flag added to all 4 commands. Universal column schema: `name,category,tier,lastUsed,tokens,recommendation,confidence`. One row per inventory item.
- **D-19:** CSV uses standard RFC 4180 format: comma-separated, quoted strings when containing commas, header row by default (suppressed with `--quiet`).
- **D-20:** `trend` command CSV has a different schema: `date,bucket,agents,skills,mcp,total` -- one row per time bucket. This matches the time-series nature of trend data.

### Claude's Discretion
- Exact stderr formatting for verbose messages (timestamps, prefixes)
- Whether `--no-color` also strips emoji (spec says no -- emoji are Unicode, not ANSI)
- JSON meta envelope field ordering
- CSV column ordering (within the defined schema)
- Whether `--verbose --quiet` is an error or quiet wins (recommend: quiet wins -- explicit silence)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OUTP-01 | Exit codes: 0 = no ghosts found, 1 = ghosts found | Exit code pattern already established (process.exitCode = 1 for parse errors). D-01 defines per-command semantics. Ghost detection: `enriched.filter(r => r.tier !== 'used').length > 0`. |
| OUTP-02 | NO_COLOR env var respected; --no-color flag available | picocolors auto-detects NO_COLOR. cli-table3's @colors/colors does NOT. Centralized isColorEnabled() in @ccaudit/terminal controls both. See "Color Control Architecture" pattern. |
| OUTP-03 | --quiet / -q flag: machine-readable data only | _shared-args.ts pattern for global flag. Quiet suppresses all render functions; outputs TSV (plain text), compact JSON, or headerless CSV. |
| OUTP-04 | --verbose / -v: show files scanned, skipped, parsing decisions | Already exists in all 4 commands. Phase 6 moves all verbose console.log to console.error (stderr). Add timing info. |
| OUTP-05 | --ci flag: combines exit-code + quiet + JSON | Syntactic sugar: `if (ci) { json = true; quiet = true; }` at start of each command handler. |
| OUTP-06 | --json export on all read commands | Already implemented in Phase 5. Phase 6 adds meta envelope wrapper. |
| OUTP-07 | --csv export on all read commands | New CSV formatter in @ccaudit/terminal. RFC 4180 compliance (hand-rolled, ~30 lines). Two schemas: inventory items and trend buckets. |
</phase_requirements>

## Standard Stack

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| picocolors | ^1.1.1 | Terminal colors | Already in catalog. Auto-detects NO_COLOR env var at import time. Has `createColors(false)` for programmatic disable. |
| cli-table3 | ^0.6.5 | Table rendering | Already in catalog. Uses `@colors/colors` for header styling (optional dep). Pass `style: {}` to disable header colors. |
| gunshi | ^0.29.3 | CLI framework | Already in catalog. Supports `args` in `define()`. No native global args -- use _shared-args.ts pattern per ccusage. |

### New Dependencies Required
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @vitest/coverage-v8 | ^4.1.2 | Code coverage | CI pipeline: `vitest --coverage`. Must match vitest version. Add to catalog. |

### No New Runtime Dependencies
CSV formatting, TSV formatting, and ANSI stripping are trivial to implement without libraries. The zero-runtime-deps constraint (DIST-02) is maintained.

**Installation:**
```bash
pnpm add -Dw @vitest/coverage-v8@^4.1.2
```

Then add to `pnpm-workspace.yaml` catalog:
```yaml
'@vitest/coverage-v8': ^4.1.2
```

## Architecture Patterns

### Recommended File Structure
```
apps/ccaudit/src/cli/
  _shared-args.ts          # NEW: shared flag definitions (--no-color, --quiet, --ci, --csv)
  index.ts                 # MODIFY: pass shared args context
  commands/
    ghost.ts               # MODIFY: add exit code, csv, quiet, shared args
    mcp.ts                 # MODIFY: add exit code, csv, quiet, shared args
    inventory.ts           # MODIFY: add exit code, csv, quiet, shared args
    trend.ts               # MODIFY: add csv, quiet, shared args (no exit code change)

packages/terminal/src/
  color.ts                 # NEW: isColorEnabled(), initColor(), stripAnsi()
  csv.ts                   # NEW: formatCsvRow(), formatCsvTable()
  quiet.ts                 # NEW: formatTsvRow() for quiet mode plain text
  tables/
    header.ts              # MODIFY: respect color state
    score.ts               # MODIFY: respect color state
    ghost-table.ts         # MODIFY: respect color state
    inventory-table.ts     # MODIFY: respect color state + add quiet TSV
    mcp-table.ts           # MODIFY: respect color state + add quiet TSV
    trend-table.ts         # MODIFY: respect color state + add quiet TSV

.github/workflows/ci.yaml # MODIFY: add coverage threshold + macOS matrix
```

### Pattern 1: Shared Args Object (ccusage pattern)
**What:** Define shared CLI flags once, spread into each command's `args`.
**When to use:** Any flag that appears on 3+ subcommands.
**Example:**
```typescript
// apps/ccaudit/src/cli/_shared-args.ts
// Source: ccusage pattern from apps/ccusage/src/_shared-args.ts

export const outputArgs = {
  quiet: {
    type: 'boolean' as const,
    short: 'q',
    description: 'Machine-readable output only (suppress decorative text)',
    default: false,
  },
  csv: {
    type: 'boolean' as const,
    description: 'Output as CSV (RFC 4180)',
    default: false,
  },
  ci: {
    type: 'boolean' as const,
    description: 'CI mode: --json --quiet with exit codes',
    default: false,
  },
  'no-color': {
    type: 'boolean' as const,
    description: 'Disable ANSI colors',
    default: false,
  },
} as const;

// In each command: args: { ...outputArgs, since: {...}, ...commandSpecificArgs }
```

### Pattern 2: Centralized Color Control
**What:** Single source of truth for color state in `@ccaudit/terminal`.
**When to use:** All rendering code that uses picocolors or cli-table3 styles.

**CRITICAL FINDING:** picocolors auto-detects `NO_COLOR` at import time (line 3 of picocolors.js). But `@colors/colors` (used internally by cli-table3 for header styling) does NOT auto-detect `NO_COLOR`. Both need explicit handling.

**Example:**
```typescript
// packages/terminal/src/color.ts
import pc from 'picocolors';

let colorEnabled: boolean | undefined;

/**
 * Initialize color state. Must be called once before any rendering.
 * Checks NO_COLOR env var and --no-color flag.
 */
export function initColor(noColorFlag: boolean): void {
  // NO_COLOR spec: present AND non-empty disables color
  const noColorEnv = typeof process.env.NO_COLOR === 'string'
    && process.env.NO_COLOR !== '';
  colorEnabled = !(noColorFlag || noColorEnv);
}

/**
 * Whether color output is enabled.
 * Falls back to picocolors auto-detection if initColor() not called.
 */
export function isColorEnabled(): boolean {
  if (colorEnabled !== undefined) return colorEnabled;
  return pc.isColorSupported;
}

/**
 * Get cli-table3 style config. Returns empty object when color disabled
 * to prevent @colors/colors from applying ANSI codes.
 */
export function getTableStyle(): Record<string, unknown> {
  return isColorEnabled() ? { head: ['cyan'] } : {};
}
```

### Pattern 3: JSON Meta Envelope
**What:** Standardized JSON wrapper for all commands per D-16.
**When to use:** Every `--json` output path.
**Example:**
```typescript
// Envelope structure for all JSON output
interface JsonEnvelope<T> {
  meta: {
    command: string;      // 'ghost' | 'inventory' | 'mcp' | 'trend'
    version: string;      // from package.json
    since: string;        // the --since window value
    timestamp: string;    // ISO 8601 when the command ran
    exitCode: number;     // 0 or 1
  };
  data: T;                // command-specific payload
}
```

### Pattern 4: Output Mode Resolution
**What:** Resolve the effective output mode from flag combinations.
**When to use:** Start of every command handler.
**Example:**
```typescript
// Resolve flags at command entry (D-14: --ci is sugar)
function resolveOutputMode(values: {
  ci?: boolean; json?: boolean; csv?: boolean; quiet?: boolean;
  'no-color'?: boolean; verbose?: boolean;
}): OutputMode {
  let json = values.json ?? false;
  let quiet = values.quiet ?? false;
  const csv = values.csv ?? false;
  const verbose = values.verbose ?? false;
  const noColor = values['no-color'] ?? false;

  // D-14: --ci sets json + quiet
  if (values.ci) {
    json = true;
    quiet = true;
  }

  // Discretion: --verbose --quiet => quiet wins
  const effectiveVerbose = verbose && !quiet;

  return { json, csv, quiet, verbose: effectiveVerbose, noColor };
}
```

### Pattern 5: CSV Formatter (RFC 4180)
**What:** Zero-dependency RFC 4180 CSV formatter.
**When to use:** All `--csv` output paths.
**Example:**
```typescript
// packages/terminal/src/csv.ts

/** Escape a value for RFC 4180 CSV. Quotes if contains comma, quote, or newline. */
export function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Format a row as RFC 4180 CSV. */
export function csvRow(fields: string[]): string {
  return fields.map(csvEscape).join(',');
}

/** Format a table with optional header row. */
export function csvTable(
  headers: string[],
  rows: string[][],
  includeHeader: boolean = true,
): string {
  const lines: string[] = [];
  if (includeHeader) lines.push(csvRow(headers));
  for (const row of rows) lines.push(csvRow(row));
  return lines.join('\n');
}
```

### Pattern 6: Quiet TSV Output
**What:** Tab-separated plain text for `--quiet` without `--json`/`--csv` (D-09).
**When to use:** `ccaudit ghost --quiet | wc -l` workflow.
**Example:**
```typescript
// One line per ghost item, tab-separated
// name\tcategory\ttier\tlastUsed\ttokens\trecommendation
export function tsvRow(fields: string[]): string {
  return fields.join('\t');
}
```

### Anti-Patterns to Avoid
- **Calling `process.exit(1)` instead of `process.exitCode = 1`:** Prevents cleanup, causes broken pipes. The `process.exitCode` pattern is already established in parse error paths.
- **Mixing stdout and stderr in JSON mode:** D-17 says when `--json` is active, stdout must contain ONLY valid JSON. All verbose/progress messages MUST go to stderr.
- **Checking color per-command instead of centrally:** D-05 mandates `@ccaudit/terminal` owns color detection. Commands pass the `--no-color` flag value to `initColor()` once; renderers call `isColorEnabled()`.
- **Using `import pc from 'picocolors'` directly in renderers when color is disabled:** picocolors evaluates `NO_COLOR` at import time. For `--no-color` flag (parsed later by gunshi), you need `picocolors.createColors(false)` or conditional application. The `isColorEnabled()` + conditional wrapper pattern avoids this.
- **Adding a CSV library:** Zero-runtime-deps constraint. RFC 4180 CSV is 30 lines of code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Terminal color detection | Custom tty/env checks | `picocolors.isColorSupported` + `picocolors.createColors()` | picocolors already handles all edge cases (NO_COLOR, FORCE_COLOR, CI, TTY, Windows) |
| Code coverage | Custom coverage scripts | `@vitest/coverage-v8` with `thresholds` config | Built-in to vitest, threshold enforcement, CI-ready |
| ANSI stripping | Regex from scratch | `stripAnsi()` already exists in `header.ts` | Already implemented for width measurement |

**Key insight:** Almost everything in this phase is wiring (connecting existing flags to existing rendering paths). The only truly new code is the CSV formatter (~30 lines) and the color control module (~40 lines). The rest is refactoring existing command handlers to use shared flag resolution and output routing.

## Common Pitfalls

### Pitfall 1: cli-table3 Header Colors Ignore NO_COLOR
**What goes wrong:** cli-table3 applies header colors via `@colors/colors` which does NOT respect `NO_COLOR` env var. Setting `NO_COLOR=1` disables picocolors colors but cli-table3 table headers still contain ANSI escape codes.
**Why it happens:** cli-table3 uses `@colors/colors/safe` (an optional peer dep). `@colors/colors` v1.5.0 does not check `NO_COLOR` -- it has `colors.enable()` / `colors.disable()` API but no auto-detection.
**How to avoid:** When color is disabled, pass `style: {}` (empty object) to cli-table3 constructor instead of `style: { head: ['cyan'] }`. This prevents cli-table3 from even attempting to apply color. Use the `getTableStyle()` helper from the color module.
**Warning signs:** CI logs showing ANSI escape codes in table headers even with `NO_COLOR=1`.
**Verified:** Tested locally. `@colors/colors` v1.5.0 `enabled` property stays `true` when `NO_COLOR=1`. `picocolors` correctly returns `isColorSupported: false`.

### Pitfall 2: picocolors Import-Time Evaluation
**What goes wrong:** picocolors evaluates `NO_COLOR` at import time (module initialization). The `--no-color` flag is parsed by gunshi AFTER imports. So `import pc from 'picocolors'` creates a colors object that already decided whether to colorize.
**Why it happens:** picocolors line 3: `let isColorSupported = !(!!env.NO_COLOR || argv.includes("--no-color"))...` evaluated at require/import time.
**How to avoid:** For `NO_COLOR` env var -- works automatically (env is set before import). For `--no-color` flag -- picocolors already checks `process.argv` for `--no-color` at import time (it reads `argv.includes("--no-color")`), so the flag works IF it appears literally as `--no-color` in argv. However, if gunshi transforms the flag name (e.g., to `noColor`), we need `createColors(false)` to create a no-op color instance. The safest approach: always use `isColorEnabled()` wrapper that checks both sources.
**Warning signs:** Colors appearing in output despite `--no-color` flag being passed.
**Verified:** picocolors source line 3: `argv.includes("--no-color")` -- this DOES check process.argv directly. As long as the user passes `--no-color` literally, picocolors detects it. But since we also want `NO_COLOR=1` to work via initColor(), the wrapper is still needed for cli-table3.

### Pitfall 3: Verbose Output on stdout Corrupts JSON Pipes
**What goes wrong:** `ccaudit ghost --json --verbose` produces invalid JSON because verbose messages (`console.log(...)`) interleave with JSON output on stdout.
**Why it happens:** Phase 5 uses `console.log()` for verbose messages. In Phase 6, verbose + JSON would mix plain text with JSON on stdout.
**How to avoid:** D-13 mandates all verbose output goes to `console.error()` (stderr). Change every `if (ctx.values.verbose) console.log(...)` to `console.error(...)`.
**Warning signs:** `ccaudit ghost --json 2>/dev/null | jq .` fails with parse error.

### Pitfall 4: Exit Code Set Before Output Completes
**What goes wrong:** Setting `process.exitCode = 1` before async rendering finishes could trigger premature exit on some Node versions or in CI environments with aggressive cleanup.
**Why it happens:** D-03 requires exit code set AFTER all output is written. If set before `console.log(JSON.stringify(...))`, a race condition is possible.
**How to avoid:** Set `process.exitCode` as the very last statement in the command handler, after all rendering and output is complete.
**Warning signs:** Truncated output in CI logs.

### Pitfall 5: CSV Field Escaping Edge Cases
**What goes wrong:** Item names or paths containing commas, double quotes, or newlines produce malformed CSV that breaks when pasted into Google Sheets.
**Why it happens:** RFC 4180 requires special handling: fields with commas/quotes/newlines must be quoted, and internal quotes doubled.
**How to avoid:** Always use the `csvEscape()` helper for every field. Test with fixture data containing commas and quotes (e.g., MCP server names like `mcp__server,v2` or paths with spaces).
**Warning signs:** Google Sheets splits a single field into two columns.

### Pitfall 6: --ci Flag Interaction with --csv
**What goes wrong:** User passes `--ci --csv` expecting CI mode with CSV output, but D-14 says `--ci` sets `--json`.
**Why it happens:** `--ci` is sugar for `--json --quiet`. If user also passes `--csv`, there's a conflict.
**How to avoid:** `--json` and `--csv` are mutually exclusive. When `--ci` is active, `--csv` should be an error or `--json` wins (since `--ci` explicitly means JSON). Document this in `--ci` flag description.
**Warning signs:** Getting JSON when expecting CSV.

## Code Examples

### Exit Code Logic (per D-01, D-02, D-03)
```typescript
// At the END of ghost/inventory/mcp command handler:
// After ALL output is written
const hasGhosts = enriched.some(r => r.tier !== 'used');
if (hasGhosts) {
  process.exitCode = 1;
}
// trend command: never sets exit code (always 0)
```

### Color-Aware Renderer Pattern
```typescript
// packages/terminal/src/tables/header.ts (modified)
import pc from 'picocolors';
import { createColors } from 'picocolors';
import { isColorEnabled } from '../color.ts';

export function renderHeader(emoji: string, title: string, sinceWindow: string): string {
  const colors = isColorEnabled() ? pc : createColors(false);
  const headerText = `${emoji} ${title} \u2014 Last ${sinceWindow}`;
  const visualWidth = stripAnsi(headerText).length;
  const dividerWidth = Math.max(32, visualWidth);
  const divider = isColorEnabled()
    ? colors.cyan('\u2501'.repeat(dividerWidth))
    : '\u2501'.repeat(dividerWidth);
  return `${colors.bold(headerText)}\n${divider}`;
}
```

### CLI Table with Color Control
```typescript
// packages/terminal/src/tables/inventory-table.ts (modified)
import { getTableStyle } from '../color.ts';

export function renderInventoryTable(results: TokenCostResult[]): string {
  const table = new Table({
    head: ['Name', 'Category', 'Scope', 'Tier', 'Last Used', '~Token Cost', 'Action'],
    colAligns: ['left', 'left', 'left', 'center', 'right', 'right', 'center'],
    style: getTableStyle(),  // Returns {} when color disabled
    wordWrap: true,
  });
  // ... rest unchanged
}
```

### Verbose to stderr Pattern
```typescript
// Change from Phase 5 pattern:
// BEFORE: if (ctx.values.verbose) console.log(`Found ${files.length} files`);
// AFTER:
if (mode.verbose) console.error(`[ccaudit] Found ${files.length} session file(s)`);
```

### JSON Meta Envelope
```typescript
// Wrapping existing JSON output
const output = {
  meta: {
    command: 'ghost',
    version: '0.0.1',  // TODO: read from package.json or inject at build time
    since: sinceStr,
    timestamp: new Date().toISOString(),
    exitCode: hasGhosts ? 1 : 0,
  },
  ...existingJsonPayload,
};
console.log(JSON.stringify(output, null, mode.quiet ? 0 : 2));
```

### CI Workflow Coverage + Matrix
```yaml
# .github/workflows/ci.yaml (test job replacement)
test:
  strategy:
    matrix:
      os: [ubuntu-latest, macos-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm
    - run: pnpm install --frozen-lockfile
    - run: pnpm test -- --coverage --coverage.thresholds.lines=80 --coverage.thresholds.functions=80 --coverage.thresholds.branches=80 --coverage.thresholds.statements=80
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `process.exit(1)` for exit codes | `process.exitCode = 1` | Node.js best practice since ~2018 | Allows cleanup, prevents EPIPE |
| chalk for terminal colors | picocolors (0.6KB) | 2022+ | 14x smaller, auto-detects NO_COLOR |
| csv-writer/papaparse for CSV | Hand-rolled RFC 4180 (~30 LOC) | Always for zero-dep CLIs | No dep needed for simple tabular output |
| Custom color detection | picocolors `isColorSupported` + `createColors()` | picocolors 1.1.x | Built-in NO_COLOR + FORCE_COLOR + TTY detection |

**Deprecated/outdated:**
- `chalk`: Still works but 14x heavier than picocolors. Not in ccaudit stack.
- `@colors/colors` auto-NO_COLOR: Does NOT exist. v1.5.0 has no NO_COLOR auto-detection -- must call `.disable()` or avoid using it.

## Open Questions

1. **Version string in meta envelope**
   - What we know: Currently hardcoded as `'0.0.1'` in `cli/index.ts`
   - What's unclear: Best approach to inject version at build time vs read from package.json at runtime
   - Recommendation: Use a build-time define in tsdown config (`define: { __VERSION__: JSON.stringify(pkg.version) }`) -- this is the standard pattern for bundled CLIs and avoids runtime fs reads. Alternatively, `import pkg from '../package.json' with { type: 'json' }` works since the project already uses this pattern (Phase 4).

2. **--ci + --csv conflict resolution**
   - What we know: D-14 says `--ci` sets `--json`. D-18 adds `--csv`. Both are output format flags.
   - What's unclear: Should `--ci --csv` error, or should `--ci` always win?
   - Recommendation: `--ci` always produces JSON (it's defined as sugar for `--json --quiet`). If `--csv` is also passed, ignore it or warn on stderr. Document in `--ci` description: "Implies --json --quiet".

3. **Quiet mode for ghost command summary rows**
   - What we know: D-09 says quiet outputs tab-separated values, one row per item
   - What's unclear: Ghost command shows summary (4 category rows) vs item-level detail. Which does quiet mode output?
   - Recommendation: Quiet mode on `ghost` command outputs ghost items (same data as `--json` items array), not the category summary. This matches `wc -l` semantics -- count actual ghosts, not categories.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 |
| Config file | `vitest.config.ts` (root workspace) + per-package configs |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test -- --coverage --coverage.thresholds.lines=80` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OUTP-01 | Exit code 0/1 based on ghost detection | unit + integration | `pnpm -F ccaudit test -- --run` | Partial (ghost-command.test.ts exists, needs exit code tests) |
| OUTP-02 | NO_COLOR env + --no-color flag strip ANSI | unit | `pnpm -F @ccaudit/terminal test -- --run` | Wave 0 (color.test.ts) |
| OUTP-03 | --quiet outputs TSV/compact JSON/headerless CSV | unit + integration | `pnpm -F ccaudit test -- --run` | Wave 0 |
| OUTP-04 | --verbose outputs to stderr | unit | `pnpm -F ccaudit test -- --run` | Wave 0 |
| OUTP-05 | --ci sets json+quiet+exit code | unit | `pnpm -F ccaudit test -- --run` | Wave 0 |
| OUTP-06 | --json has meta envelope | unit | `pnpm -F ccaudit test -- --run` | Partial (JSON output tested, envelope not) |
| OUTP-07 | --csv produces RFC 4180 output | unit | `pnpm -F @ccaudit/terminal test -- --run` | Wave 0 (csv.test.ts) |

### Sampling Rate
- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test -- --coverage`
- **Phase gate:** Full suite green + coverage >= 80% before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/terminal/src/color.ts` -- color detection module with in-source tests
- [ ] `packages/terminal/src/csv.ts` -- CSV formatter with in-source tests
- [ ] `packages/terminal/src/quiet.ts` -- TSV formatter with in-source tests
- [ ] Exit code integration tests in `apps/ccaudit/src/__tests__/`
- [ ] `@vitest/coverage-v8` added to catalog and devDependencies
- [ ] Coverage thresholds configured in vitest workspace config

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.20.0 | -- |
| pnpm | Package manager | Yes | 10.33.0 | -- |
| vitest | Testing | Yes | 4.1.2 | -- |
| @vitest/coverage-v8 | OUTP-06 (CI coverage) | No (not installed) | 4.1.2 (registry) | Must install before CI coverage works |
| GitHub Actions | OUTP-06, OUTP-07 (CI matrix) | Yes (workflow exists) | -- | -- |

**Missing dependencies with no fallback:**
- `@vitest/coverage-v8` -- must be added to pnpm catalog and installed before coverage thresholds work

**Missing dependencies with fallback:**
- None

## Sources

### Primary (HIGH confidence)
- picocolors source code (node_modules/.pnpm/picocolors@1.1.1) -- verified NO_COLOR detection at import time, `createColors(false)` API, `isColorSupported` property
- cli-table3 source code (node_modules/.pnpm/cli-table3@0.6.5) -- verified `@colors/colors/safe` usage for header styling, try/catch fallback pattern
- @colors/colors runtime behavior -- verified `NO_COLOR=1` does NOT disable colors (enabled stays true, cyan still produces ANSI)
- gunshi source code (node_modules/.pnpm/gunshi@0.29.3) -- verified `addGlobalOption()` plugin API, `resolveArguments()` merge behavior
- ccusage code study (`CCUSAGE.md`) -- `_shared-args.ts` pattern for global CLI flags

### Secondary (MEDIUM confidence)
- [NO_COLOR spec](https://no-color.org/) -- verified: "when present and not an empty string, prevents the addition of ANSI color"
- [Vitest coverage config](https://vitest.dev/config/coverage) -- thresholds configuration structure
- [RFC 4180](https://datatracker.ietf.org/doc/html/rfc4180) -- CSV format rules: quote fields containing commas/quotes/newlines, double-quote escaping

### Tertiary (LOW confidence)
- None -- all findings verified against installed source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already installed and source-code-verified
- Architecture: HIGH -- patterns proven in ccusage reference implementation, adapted for ccaudit
- Pitfalls: HIGH -- each pitfall verified by reading actual library source code and testing runtime behavior
- Color control: HIGH -- tested picocolors and @colors/colors behavior with NO_COLOR=1 in local terminal

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (30 days -- all libraries are stable, patterns are well-established)
