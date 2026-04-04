# Phase 5: Report & CLI Commands - Context

**Gathered:** 2026-04-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can run `ccaudit ghost`, `ccaudit inventory`, `ccaudit mcp`, and `ccaudit trend` to see ghost tables with Defined/Used/Ghost/Token-cost columns, a health score, per-item recommendations, and the `--since` window prominently displayed. This phase delivers all four subcommands, the health score calculator, the recommendation classifier, and the `@ccaudit/terminal` rendering layer.

</domain>

<decisions>
## Implementation Decisions

### Ghost table layout
- **D-01:** Default ghost command shows a **summary-row layout** (one row per category) followed by a **top-5 ghosts** section below — "best of both worlds" approach
- **D-02:** Summary rows follow the handoff doc format exactly: `Category  Defined: N  Used: N  Ghost: N  ~Xk tokens` with column-aligned plain text (not cli-table3 borders for the summary)
- **D-03:** Top-5 section is a numbered plain-text list sorted by token cost descending. Format: `  1. name       ~Xk tokens  (category, last-used)` — no cli-table3 borders
- **D-04:** Memory files use domain-specific labels: **Loaded/Active/Stale** (not Defined/Used/Ghost). All other categories use Defined/Used/Ghost
- **D-05:** Per-item detail view is available via `ccaudit inventory` (separate subcommand, not in default ghost output)

### Report headers & branding
- **D-06:** All commands use consistent branding pattern: **emoji + title + --since window** on line 1, **`━━━━` heavy box-drawing dividers** on line 2
- **D-07:** Command emoji mapping (locked):
  - `👻` ghost (default command)
  - `📦` inventory
  - `🔌` mcp
  - `📈` trend
- **D-08:** Header format: `👻 Ghost Inventory — Last 7 days` (em dash, human-readable window)
- **D-09:** Footer CTA for v1.0 (before dry-run exists): health score line + two hints:
  ```
  Health: 42/100 (Poor)

  See per-item details: ccaudit inventory
  Dry-run coming in v1.1: npx ccaudit@latest --dry-run
  ```
- **D-10:** The `🚨` emoji marks the top-5 ghosts section header: `🚨 Top ghosts by token cost:`

### Health score & recommendations
- **D-11:** Health score algorithm, grade labels, and thresholds follow research recommendations (weighted formula: ghost count penalty + token overhead penalty, grades Healthy/Fair/Poor/Critical)
- **D-12:** Recommendation classifier uses the simple mapping: definite-ghost -> archive, likely-ghost -> monitor, used -> keep

### Claude's Discretion
- Health score exact penalty weights and cap values (research proposes: definite 3pts capped 60, likely 1pt capped 20, token ratio capped 20)
- Health score grade thresholds (research proposes: >=80 Healthy, >=50 Fair, >=20 Poor, <20 Critical)
- Trend view granularity auto-selection logic (research recommends: daily for <=7d, weekly for >7d)
- cli-table3 configuration in `@ccaudit/terminal` (wordWrap, style options, column widths)
- Exact spacing and alignment in summary rows and top-5 list
- Inventory and trend table column choices (detail views)
- Color choices for health score grades (using picocolors)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Branding & visual design
- `docs/ccaudit-handoff-v6.md` lines 227-242 — Ghost Inventory mockup with exact layout, emoji, dividers, column labels, and token format. This is the authoritative visual spec.
- `docs/ccaudit-handoff-v6.md` lines 35-41 — Ghost concept in UX: emoji conventions, viral asset framing

### Requirements
- `.planning/REQUIREMENTS.md` — REPT-01 through REPT-07 (report requirements), OUTP-01 through OUTP-07 (output control, Phase 6)
- `.planning/ROADMAP.md` Phase 5 section — success criteria, requirement mapping

### Research
- `.planning/phases/05-report-cli-commands/05-RESEARCH.md` — Architecture patterns, module placement, health score algorithm, recommendation classifier, cli-table3 usage, pitfalls

### Existing code (integration points)
- `apps/ccaudit/src/cli/commands/ghost.ts` — Current ghost command to refactor (uses manual console.log)
- `apps/ccaudit/src/cli/commands/mcp.ts` — Current mcp command to refactor (uses manual console.log)
- `apps/ccaudit/src/cli/index.ts` — gunshi CLI entry point with subCommands map
- `packages/internal/src/types.ts` — `Recommendation` type already defined as `'archive' | 'monitor' | 'keep'`
- `packages/terminal/src/index.ts` — Stub package waiting for implementation
- `packages/internal/src/token/format.ts` — `formatTokenEstimate()`, `formatTotalOverhead()` functions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `enrichScanResults()` in `@ccaudit/internal`: provides all token-enriched data needed for display
- `calculateTotalOverhead()`: aggregates token costs across items
- `formatTokenEstimate()` / `formatTotalOverhead()`: token display formatting already established
- `Recommendation` type in `packages/internal/src/types.ts`: already defined as `'archive' | 'monitor' | 'keep'`
- `parseDuration()`: already handles `--since` flag parsing
- `discoverSessionFiles()` / `parseSession()` / `scanAll()`: full pipeline already wired

### Established Patterns
- gunshi `define()` pattern for subcommands (see ghost.ts, mcp.ts)
- `cli()` with `subCommands` map in `apps/ccaudit/src/cli/index.ts`
- In-source vitest testing via `if (import.meta.vitest)` blocks
- TypeScript composite project references between packages/ and apps/
- Zero runtime deps — all deps as devDependencies, bundled by tsdown

### Integration Points
- `apps/ccaudit/src/cli/index.ts`: register `inventory` and `trend` subcommands in the `subCommands` map
- `packages/terminal/src/index.ts`: replace stub with real rendering layer
- `packages/internal/src/index.ts`: add barrel exports for new `report/` modules (health-score, recommendation, trend)
- ghost.ts and mcp.ts: refactor to use `@ccaudit/terminal` render functions instead of manual console.log

</code_context>

<specifics>
## Specific Ideas

- The handoff doc (lines 228-239) is the authoritative visual mockup — match it as closely as possible for the summary section
- Ghost concept lives in UX, not tool name — "👻 Ghost Inventory", "ghost agents", "👻 ghost overhead" are intentional branding, not decoration
- The `--dangerously-bust-ghosts` flag name appearing in screenshots is the viral asset — the summary view is what gets screenshot-shared
- Before/after token numbers (108k -> 12k) are the hook — total overhead display must be prominent and clear
- The summary + top-5 layout keeps the screenshot compact while showing actionable detail

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-report-cli-commands*
*Context gathered: 2026-04-04*
