# Phase 5: Report & CLI Commands - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-04
**Phase:** 05-report-cli-commands
**Areas discussed:** Ghost table layout, Report headers & branding

---

## Ghost Table Layout

### Q1: Summary vs per-item vs both?

| Option | Description | Selected |
|--------|-------------|----------|
| Summary rows (Recommended) | 4 rows per category with Defined/Used/Ghost/~Token columns. Clean, viral screenshot. | |
| Per-item detail table | One row per ghost item via cli-table3. Verbose, 50+ rows. | |
| Both: summary + top ghosts | Summary rows first, then top 5 ghosts by token cost below. Best of both worlds. | ✓ |

**User's choice:** Both: summary + top ghosts
**Notes:** User selected the combined layout for the "best of both worlds" effect — compact summary for the screenshot, plus actionable top-5 detail.

### Q2: Top-N count and rendering style?

| Option | Description | Selected |
|--------|-------------|----------|
| Top 5, plain text (Recommended) | Numbered list, no borders. Compact, matches handoff doc tone. | ✓ |
| Top 5, cli-table3 | Bordered table for the top-N section. More structured but heavier. | |
| Top 3, plain text | Shorter list, full list via ccaudit inventory. | |

**User's choice:** Top 5, plain text
**Notes:** None

### Q3: Category-specific labels for Memory?

| Option | Description | Selected |
|--------|-------------|----------|
| Memory-specific only (Recommended) | Agents/Skills/MCP use Defined/Used/Ghost. Memory uses Loaded/Active/Stale. | ✓ |
| Uniform labels | All categories use Defined/Used/Ghost for consistency. | |

**User's choice:** Memory-specific only
**Notes:** Matches handoff doc exactly. Each category gets domain-appropriate labels.

---

## Report Headers & Branding

### Q4: Branding consistency across commands?

| Option | Description | Selected |
|--------|-------------|----------|
| Consistent branding (Recommended) | All commands: emoji + title + --since window, ━━━ divider. Each gets its own emoji. | ✓ |
| Ghost-only emoji | Only 👻 ghost gets emoji. Other commands use plain text titles. | |

**User's choice:** Consistent branding
**Notes:** Emoji mapping locked: 👻 ghost, 📦 inventory, 🔌 mcp, 📈 trend

### Q5: Footer CTA for v1.0?

| Option | Description | Selected |
|--------|-------------|----------|
| Health score + hint (Recommended) | Score + two hints (inventory detail + dry-run coming v1.1). | ✓ |
| Health score only | Clean footer, no forward-looking CTA. | |
| Score + inventory hint | Point to inventory, no mention of future versions. | |

**User's choice:** Health score + hint
**Notes:** Builds anticipation for v1.1 dry-run. Footer format: health score line, then "See per-item details: ccaudit inventory" and "Dry-run coming in v1.1: npx ccaudit@latest --dry-run"

---

## Claude's Discretion

- Health score algorithm details (penalty weights, caps, grade thresholds)
- Trend view granularity auto-selection
- cli-table3 configuration (wordWrap, style, column widths)
- Color choices for health score grades
- Inventory and trend table column structure
- Exact spacing/alignment in summary rows

## Deferred Ideas

None — discussion stayed within phase scope
