# Phase 6: Output Control & Polish - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-04
**Phase:** 06-output-control-polish
**Areas discussed:** Exit code semantics, Color stripping architecture, Quiet mode content, CSV column design, CI flag composition
**Mode:** auto (all areas auto-selected, recommended defaults chosen)

---

## Exit Code Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| All commands exit 1 on ghosts | Every subcommand signals ghosts found | |
| ghost/inventory/mcp exit 1, trend exits 0 | Trend is informational — no problem semantics | ✓ |
| Only ghost (default) exits 1 | Other commands are detail views | |

**User's choice:** [auto] ghost, inventory, mcp exit 1; trend always 0
**Notes:** Trend shows time-series data — no "ghosts found" semantics. Inventory and mcp show ghost detail so exit code still meaningful.

---

## Color Stripping Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| Per-command color detection | Each command checks NO_COLOR independently | |
| Terminal package centralized | isColorEnabled() in @ccaudit/terminal, all renderers use it | �� |
| CLI wrapper strips ANSI post-render | Render with color, strip at output boundary | |

**User's choice:** [auto] Terminal package detects NO_COLOR env + --no-color flag; renderers strip ANSI
**Notes:** Centralized in render layer is cleanest. --no-color flag on root command propagates to all subcommands.

---

## Quiet Mode Content

| Option | Description | Selected |
|--------|-------------|----------|
| Suppress headers/footers only | Keep table borders and data formatting | |
| Data rows only (TSV) | Machine-parseable plain text, tab-separated | ✓ |
| JSON-only when quiet | --quiet without --json is an error | |

**User's choice:** [auto] Data rows only — no headers, dividers, footer, health score prose
**Notes:** Tab-separated makes piping natural. --quiet --json = compact JSON. --quiet --csv = no header row.

---

## CSV Column Design

| Option | Description | Selected |
|--------|-------------|----------|
| Per-command CSV schemas | Each command defines its own columns | |
| Universal flat schema | name,category,tier,lastUsed,tokens,recommendation for all | ✓ |
| Nested JSON-in-CSV | Complex fields as JSON strings in CSV cells | |

**User's choice:** [auto] Flat row per item: name, category, tier, lastUsed, tokens, recommendation, confidence
**Notes:** Trend gets different schema (date,bucket,agents,skills,mcp,total) matching time-series nature. RFC 4180 format.

---

## CI Flag Composition

| Option | Description | Selected |
|--------|-------------|----------|
| Separate --ci implementation | Dedicated CI output path | |
| Alias for --json --quiet + exit code | Sets other flags internally | ✓ |
| CI output as SARIF/JUnit | Standard CI reporting format | |

**User's choice:** [auto] --ci = alias for --json --quiet + exit code
**Notes:** Not a separate implementation. SARIF/JUnit would be scope creep for v1.0.

---

## Claude's Discretion

- Verbose stderr formatting, JSON meta field ordering, CSV column ordering
- --verbose --quiet conflict resolution (quiet wins)
- Whether --no-color strips emoji (no — they're Unicode)

## Deferred Ideas

None — discussion stayed within phase scope
