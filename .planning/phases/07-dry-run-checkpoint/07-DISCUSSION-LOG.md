# Phase 7: Dry-Run & Checkpoint - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-04
**Phase:** 07-dry-run-checkpoint
**Areas discussed:** Change-plan layout & content, Checkpoint file schema, Hash input scope, --dry-run flag mechanics & output modes

---

## Area 1: --dry-run flag mechanics & output modes

### Q1.1: Where does --dry-run live in the CLI?

| Option | Description | Selected |
|--------|-------------|----------|
| Flag on ghost command | `ccaudit --dry-run` routes through default ghost command. Single code path, no new subcommand. Matches handoff verbatim. | ✓ |
| Dedicated 'dry-run' subcommand | `ccaudit dry-run` as its own file. Cleaner separation but breaks `ccaudit --dry-run` unless specially handled. | |
| Both (flag + subcommand alias) | Flag on ghost + subcommand delegation. Widest UX, small duplication. | |

**User's choice:** Flag on ghost command
**Notes:** Matches handoff §84–88 and ROADMAP Phase 7 wording verbatim. Single code path keeps Phase 7 minimal.

### Q1.2: Which output modes must --dry-run support?

| Option | Description | Selected |
|--------|-------------|----------|
| --json | Structured change plan; needed for automation and --ci path. | ✓ |
| --csv | RFC 4180 change-plan export; consistent with Phase 6 D-18. | ✓ |
| --quiet | TSV rows for scripting. | ✓ |
| --ci | Combines --json + --quiet + exit codes per Phase 6 D-14/D-15. | ✓ |

**User's choice:** All four (multiSelect)
**Notes:** Full parity with Phase 6 output modes. --no-color and --verbose are inherited through the root flag / shared pattern.

### Q1.3: Exit code on successful dry-run?

| Option | Description | Selected |
|--------|-------------|----------|
| Always 0 on success | Dry-run is a preview; 0 = checkpoint written + here's what would happen. Enables `ccaudit --dry-run && ccaudit --dangerously-bust-ghosts`. | ✓ |
| 1 if any items would change | Mirrors ghost-command D-01 semantics. Breaks the && chain. | |
| Custom: 0 no-op, 1 items, 2 error | Richer semantics but novel in codebase. | |

**User's choice:** Always 0 on success
**Notes:** Chainability with Phase 8 bust command wins. Exit code 2 is still reserved for checkpoint write failure (see Q4.4 / D-20).

### Q1.4: Zero-ghost dry-run — still write checkpoint?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, always write on successful scan | Simpler Phase 8 gate: single rule ("checkpoint exists AND hash matches"), no special-case for empty inventories. | ✓ |
| Skip checkpoint when zero ghosts | No stale empty checkpoints; Phase 8 needs extra conditional logic. | |

**User's choice:** Yes, always write on successful scan
**Notes:** Locks the Phase 8 gate to one rule. Empty inventories are a valid state.

---

## Area 2: Change-plan layout & content

### Q2.1: How should the rendered dry-run output be structured?

| Option | Description | Selected |
|--------|-------------|----------|
| Grouped by action verb | Mirrors handoff §127–143. Will ARCHIVE / Will DISABLE / Will FLAG sections + estimated savings line. Screenshot-ready. | ✓ |
| Ghost-style summary + top-5 | Reuses Phase 5 layout with relabeling. Familiar but less actionable. | |
| Full per-item listing | Every affected item one row. Thorough but wall-of-text. | |

**User's choice:** Grouped by action verb
**Notes:** Mirrors viral-asset UX from handoff. Reuses Phase 5 header + divider branding.

### Q2.2: Which items appear in the change plan?

| Option | Description | Selected |
|--------|-------------|----------|
| Only items that WOULD change | definite-ghost agents/skills/mcp + stale memory. likely-ghost excluded (noise in a change plan). | ✓ |
| All ghosts, with likely-ghost marked 'no change' | More transparent but dilutes the 'what will happen' message. | |
| Everything (definite + likely + used) | Duplicates ccaudit inventory. | |

**User's choice:** Only items that WOULD change
**Notes:** Keeps the action list crisp. MCP widens to include likely-ghost per D-11a (decided in Area 3 below).

### Q2.3: How should 'estimated savings' be calculated?

| Option | Description | Selected |
|--------|-------------|----------|
| Definite-ghost agents+skills+MCP only | Honest savings — memory excluded (flagged-not-moved). Distinct from totalOverhead. | ✓ |
| Same as ghost command (totalOverhead) | Easier but overstates — includes likely-ghost + memory. | |
| Both numbers, labeled | Most honest but adds debatable line. | |

**User's choice:** Definite-ghost agents+skills+MCP only
**Notes:** Inflated savings at v1.1 launch would turn into "ccaudit lied" tweets at v1.2 launch. Accuracy >> marketing.

### Q2.4: Should --verbose add a per-item breakdown?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — verbose adds per-item listing | Default = grouped summary, --verbose appends full list. Phase 6 D-13 diagnostics still go to stderr. | ✓ |
| No — verbose only adds stderr diagnostics | Per-item needs a new --list flag. | |

**User's choice:** Yes — verbose adds per-item listing
**Notes:** Power users get the full picture without polluting default screenshots.

---

## Area 3: Hash input scope (DRYR-02/03 contract)

### Q3.1: What exactly goes into sha256() for ghost_hash?

| Option | Description | Selected |
|--------|-------------|----------|
| Archive-eligible items only | Records for items Phase 8 will actually mutate. Matches ROADMAP wording "agent file paths + mtimes + MCP configs". | ✓ |
| Full ScanResult list (all items, all tiers) | Broader — invalidates on any usage shift. Noisy. | |
| Full scan + --since window | Most conservative. Forces --since consistency between phases. | |

**User's choice:** Archive-eligible items only
**Notes:** Hash changes iff the bust list changes. Narrow and stable.

### Q3.2: Canonical form for hash inputs?

| Option | Description | Selected |
|--------|-------------|----------|
| JSON.stringify with sorted keys + sorted item array | Deterministic, human-debuggable, zero new deps. | ✓ |
| Newline-delimited tuple strings | Marginally smaller; fragile on delimiter edge cases. | |

**User's choice:** JSON.stringify with sorted keys + sorted item array
**Notes:** We already use JSON everywhere. Debuggable means faster bug triage when users report hash mismatches.

### Q3.3: mtime normalization?

| Option | Description | Selected |
|--------|-------------|----------|
| Integer milliseconds | Direct mtimeMs from fs.stat. Stable, no precision loss. | ✓ |
| Integer seconds (truncate ms) | Avoids sub-second noise but loses resolution. | |
| Ignore mtimes — hash contents | Most correct; much slower. Overkill for v1.1. | |

**User's choice:** Integer milliseconds
**Notes:** Scanner already uses mtimeMs for memory files; consistent with existing pattern.

### Q3.4: MCP server 'mtime'?

| Option | Description | Selected |
|--------|-------------|----------|
| Use MCP config file mtime once per source | configMtimeMs from the declaring ~/.claude.json or .mcp.json. Catches rename/edit. | ✓ |
| No mtime for MCP — identity only | Simpler but could miss 'renamed context7 to context7-old'. | |

**User's choice:** Use MCP config file mtime once per source
**Notes:** Single stat() per unique source path, cached in a Map for the hash build.

---

## Area 4: Checkpoint file schema

### Q4.1: Fields beyond handoff baseline {timestamp, ghost_hash, item_count}?

| Option | Description | Selected |
|--------|-------------|----------|
| checkpoint_version | Integer schema version for forward compatibility. | ✓ |
| ccaudit_version | Tool version for debugging / block messages. | ✓ |
| since_window | The --since value active during dry-run. Not hashed, but displayed by Phase 8 gate. | ✓ |
| savings | Reclaimable token count. Phase 8 restates it in triple-confirm without re-scanning. | ✓ |

**User's choice:** All four (multiSelect)
**Notes:** Also adds `item_count.memory` (beyond handoff baseline) because change plan includes flagged memory files.

### Q4.2: Checkpoint file path and format?

| Option | Description | Selected |
|--------|-------------|----------|
| ~/.claude/ccaudit/.last-dry-run (JSON, dotfile, legacy) | Exact path from handoff §102. Single global checkpoint. 0o600 perms. | ✓ |
| Dual path: ~/.claude/ccaudit/ AND ~/.config/claude/ccaudit/ | Symmetric with scanning but introduces 'which wins?' edge case. | |
| ~/.claude/ccaudit/last-dry-run.json (visible) | More discoverable, contradicts handoff wording. | |

**User's choice:** ~/.claude/ccaudit/.last-dry-run (JSON, dotfile, legacy path only)
**Notes:** One global ghost inventory → one global checkpoint. Dual-path is scan-only.

### Q4.3: When checkpoint directory doesn't exist?

| Option | Description | Selected |
|--------|-------------|----------|
| mkdir recursive, mode 0o700 | Zero friction. Matches ccusage conventions. | ✓ |
| Fail if ~/.claude/ doesn't exist | Stricter, annoys first-time CI. | |

**User's choice:** mkdir recursive
**Notes:** Directory is ccaudit-owned.

### Q4.4: Atomic write pattern?

| Option | Description | Selected |
|--------|-------------|----------|
| Write to temp, then fs.rename | Prevents half-written checkpoint. Establishes Phase 8 RMED-09 pattern early. | ✓ |
| Direct fs.writeFile | Simpler; corruption unlikely for sub-1KB file. | |

**User's choice:** Write to temp, then fs.rename
**Notes:** Low-stakes target (checkpoint) is where we prove the pattern before Phase 8 applies it to ~/.claude.json.

---

## Claude's Discretion

Areas where implementation details are left to the planner / executor:

- Exact wording of footer CTA line after checkpoint write
- Module placement inside `@ccaudit/internal` (recommend `remediation/` directory)
- Human-relative last-used formatting in verbose listing
- Column widths and spacing in grouped summary
- Where `ccaudit_version` is injected at build time (tsdown define vs generated version.ts)
- In-source test fixture layout
- CSV column schema for `--dry-run --csv`
- JSON envelope field ordering
- Whether JSON dry-run output includes full canonical hash input list (recommend: no)

## Deferred Ideas

- Per-item plan inspection via `--list` subcommand
- Checkpoint history / multiple past checkpoints
- Per-project scoped checkpoints
- SHA-3 / BLAKE3 hash upgrade
- Dry-run TUI / interactive selection
- Checkpoint TTL in addition to hash (explicitly rejected)
- Writing checkpoint to XDG path when XDG_CONFIG_HOME is set
