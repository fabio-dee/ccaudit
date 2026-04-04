# Phase 6: Output Control & Polish - Context

**Gathered:** 2026-04-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Make ccaudit CI-ready and script-friendly: exit codes for ghost detection, NO_COLOR / --no-color support, --quiet and --verbose modes, --ci shortcut, and --json / --csv export on all read commands. This is the final phase before v1.0 release — it polishes all four subcommands into production-quality outputs suitable for CI pipelines, shell scripting, and human consumption.

</domain>

<decisions>
## Implementation Decisions

### Exit code semantics
- **D-01:** `ghost`, `inventory`, and `mcp` commands exit 1 when ghosts are found (any item with tier !== 'used'). `trend` always exits 0 — it's informational time-series data with no "problem found" semantics.
- **D-02:** Exit code 1 is set via `process.exitCode = 1` (not `process.exit(1)`) to allow cleanup. This pattern is already established in all 4 commands for parse errors.
- **D-03:** Exit code check happens after all output is written — never exit before rendering completes.

### Color control
- **D-04:** `NO_COLOR` environment variable and `--no-color` flag both respected per the [NO_COLOR spec](https://no-color.org/). Either one disables all ANSI escape sequences.
- **D-05:** Color detection lives in `@ccaudit/terminal` package — centralized, not per-command. All renderers check a shared `isColorEnabled()` function.
- **D-06:** When color is disabled, emoji remain (they're Unicode, not ANSI). Only ANSI color codes are stripped.
- **D-07:** `--no-color` flag added to the root command (gunshi `cli()` level) so it applies to all subcommands without per-command duplication.

### Quiet mode
- **D-08:** `--quiet` / `-q` suppresses all decorative output: headers, dividers, emoji, footer CTA, health score prose, "scanning..." messages. Shows only data rows (table body without borders) or raw JSON/CSV.
- **D-09:** `--quiet` alone (no --json/--csv) outputs machine-parseable plain text: tab-separated values, one row per item. This makes `ccaudit ghost --quiet | wc -l` count ghosts.
- **D-10:** `--quiet` with `--json` outputs compact JSON (no pretty-print, no newlines between fields).
- **D-11:** `--quiet` with `--csv` outputs CSV with no header row (data rows only — header can be suppressed for append workflows).

### Verbose mode
- **D-12:** `--verbose` / `-v` already exists in all 4 commands. Phase 6 standardizes it: verbose shows files scanned, files skipped (and why), parse decisions, scan progress, and timing information.
- **D-13:** Verbose messages go to stderr, not stdout — this preserves stdout for data (pipe-friendly). Use `console.error()` for verbose output.

### CI flag
- **D-14:** `--ci` is syntactic sugar: it enables `--json`, `--quiet`, and ensures exit code semantics. Not a separate implementation — the command handler sets the other flags internally when `--ci` is present.
- **D-15:** `--ci` output is a single JSON object on stdout with exit code reflecting ghost status. Perfect for `npx ccaudit --ci | jq .healthScore.score`.

### JSON export
- **D-16:** `--json` already exists in all 4 commands (Phase 5). Phase 6 standardizes the schema: every command's JSON output includes a `meta` envelope with `{ command, version, since, timestamp, exitCode }` alongside the command-specific data.
- **D-17:** JSON output always goes to stdout, never mixed with decorative text. When `--json` is active, no non-JSON output is written to stdout.

### CSV export
- **D-18:** `--csv` flag added to all 4 commands. Universal column schema: `name,category,tier,lastUsed,tokens,recommendation,confidence`. One row per inventory item.
- **D-19:** CSV uses standard RFC 4180 format: comma-separated, quoted strings when containing commas, header row by default (suppressed with `--quiet`).
- **D-20:** `trend` command CSV has a different schema: `date,bucket,agents,skills,mcp,total` — one row per time bucket. This matches the time-series nature of trend data.

### Claude's Discretion
- Exact stderr formatting for verbose messages (timestamps, prefixes)
- Whether `--no-color` also strips emoji (spec says no — emoji are Unicode, not ANSI)
- JSON meta envelope field ordering
- CSV column ordering (within the defined schema)
- Whether `--verbose --quiet` is an error or quiet wins (recommend: quiet wins — explicit silence)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — OUTP-01 through OUTP-07 (output control requirements)
- `.planning/ROADMAP.md` Phase 6 section — success criteria, requirement mapping

### Existing implementation (all 4 commands have json + verbose already)
- `apps/ccaudit/src/cli/commands/ghost.ts` — Reference for exit code + json + verbose pattern
- `apps/ccaudit/src/cli/commands/mcp.ts` — Has --live flag interaction with output modes
- `apps/ccaudit/src/cli/commands/inventory.ts` — Standard pattern
- `apps/ccaudit/src/cli/commands/trend.ts` — Time-series data, different CSV schema
- `apps/ccaudit/src/cli/index.ts` — gunshi CLI entry point; root-level flags go here

### Rendering layer
- `packages/terminal/src/` — All renderers; color detection centralizes here
- `packages/terminal/src/tables/` — Table builders that need color-aware output

### NO_COLOR spec
- https://no-color.org/ — External standard for NO_COLOR env var behavior

### Prior context
- `.planning/phases/05-report-cli-commands/05-CONTEXT.md` — Branding decisions D-06 through D-10 that affect header/footer rendering in quiet mode

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `--json` flag: Already in all 4 commands with JSON output paths — Phase 6 standardizes the schema
- `--verbose` flag: Already in all 4 commands with `console.log` verbose messages — Phase 6 moves to stderr
- `process.exitCode = 1`: Already used for parse errors — Phase 6 extends to ghost-found semantics
- `renderHeader()`, `renderGhostFooter()`: Terminal renderers that need quiet-mode suppression
- `renderHealthScore()`: Score renderer that needs to work in JSON/CSV contexts too

### Established Patterns
- gunshi `define()` with `args` object for flag definitions
- gunshi `cli()` with root options for global flags
- `@ccaudit/terminal` package as the centralized rendering layer
- `if (ctx.values.json)` branching pattern in all commands
- `if (ctx.values.verbose) console.log(...)` pattern in all commands

### Integration Points
- `apps/ccaudit/src/cli/index.ts`: Add root-level `--no-color`, `--quiet`, `--ci` flags
- `packages/terminal/src/`: Add `isColorEnabled()` utility, CSV formatters
- All 4 command files: Add exit code logic after rendering, update verbose to stderr, add CSV path

</code_context>

<specifics>
## Specific Ideas

- The `--ci` flag is the release gate for v1.0 — GitHub Actions users need `npx ccaudit --ci` to work on day one
- Tab-separated quiet output enables `ccaudit ghost --quiet | awk '{print $1}'` for scripting
- Verbose stderr means `ccaudit ghost --json 2>/dev/null` gives clean JSON while `ccaudit ghost --json --verbose` shows progress on stderr alongside JSON on stdout
- CSV export enables "paste into Google Sheets" workflow for sharing ghost reports with team leads

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-output-control-polish*
*Context gathered: 2026-04-04*
