# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-04-27

Polish release - documentation accuracy, test reliability, and edge-case
observability. No user-visible behavior changes.

### Changed

- README Roadmap copy refreshed: clearer framing of the v1.6 stable
  CLI/JSON API contract section (abstract guarantees only - concrete
  subcommand naming defers to the v1.6 release notes). Domain-folder
  negative list updated.
- `_glyphs.ts` doc clarified: `NO_COLOR` is honored when set to a
  non-empty value, per the no-color.org spec (code was already
  spec-correct; only the doc was stale).

### Fixed

- `purge.ts` audit-trail invariant documented: a `manifest_write_failed:`
  failure (disk mutation succeeded, journal-write failed) is treated as a
  full failure by the all-failed gate. The "if it isn't journaled, it
  didn't happen" contract is now part of the file's docstring and locked
  by an in-source test.
- `docs/JSON-SCHEMA.md`: fixed an MD028 markdownlint violation (adjacent
  blockquotes separated by a blank line) and verified the rest of the
  file for similar instances.
- `change-plan.ts`: replaced hard-coded canonical-ID literal strings with
  calls to the exported `canonicalItemId(...)` helper, eliminating drift
  risk if the format string changes.
- `scan-memory.ts`: added Windows path-normalization regression coverage
  (in-source test). The normalization itself was already correct; the
  test locks it.

### Tests

- Test-helper polish: replaced a dead `void killed` no-op with a real
  `if (killed) return;` guard; synced the `graceMs` parameter doc; synced
  the `restore --json` envelope test header docstring with the actual
  envelope shape; removed a redundant `stripAnsi(raw)` call in the tmux
  e2e fixture; replaced a non-null assertion with explicit narrowing in
  the corrupt-manifest test; normalized the force-partial banner string
  concatenation and added a tightening assertion that the joining space
  is exactly one character. Aligned the `commands` row arrow with the
  `agents`/`skills` rows via `padEnd(8)`. Added a `formatBytes()` helper
  to the bundle-size check and replaced the hard-coded budget string
  with the formatted value. Updated the `pagination-500.test.ts` file-
  header comment to enumerate the actual tests in the file.

## [1.5.0] - 2026-04-26

### Changed

- README headline reframed around the Opus 4.7 1M-token context window
  (Phase 10 SC3): the same ~108k token ghost inventory is now expressed as
  ~11% of 1M (was 54% of 200k), with the absolute number kept inline so
  readers on smaller-context models retain a figure that matches their
  reality. New "Native alternatives" section (Phase 10 SC4) compares
  `/skills t-sort`, `/usage`, and `claude plugin disable` against
  ccaudit's cross-component scope, regime-aware token math, and
  archive-with-rollback differentiator. Docs only — no code change.

### Added

- `ccaudit purge-archive` command (Phase 9 SC6) — drains
  `~/.claude/ccaudit/archived/` via a classifier over the manifest union.
  Default is `--dry-run`; real purge requires explicit `--yes` (no prompt
  fallback). Classification: reclaim-if-free → archive moved back to source,
  drop-if-occupied → archive unlinked (source never overwritten),
  drop-if-stale → already-gone archive's manifest entry retired, skip-if-
  both-missing → preserved for diagnosis. Scope is archive ops only; flag
  (memory) and disable (MCP) ops are untouched. Each executed mutation
  appends a new `archive_purge` op to a fresh `purge-<ts>-<rand>.jsonl`
  manifest — originals are never rewritten. JSON envelope:
  `purge.summary.{purgedCount, reclaimedCount, skippedOccupiedCount,
staleFilteredCount}` + `purge.failures[]` + additive `purge.manifestPath`
  and `purge.manifestErrors[]`. See
  [docs/JSON-SCHEMA.md § Purge](./docs/JSON-SCHEMA.md).
- Empty-inventory short-circuit (Phase 9 SC1): `ghost` and
  `ghost --interactive` exit 0 with a clean single-line message on an empty
  inventory; the TUI is never opened.
- `CCAUDIT_NO_INTERACTIVE=1` env escape hatch (Phase 9 SC2) — truthy
  (`1` / `true`, case-insensitive) gates every interactive entry point.
  Silent suppression of auto-open; hard refusal on explicit `--interactive`
  with exit code 2 and `refusing: CCAUDIT_NO_INTERACTIVE is set`.
- Tabbed-picker pagination (Phase 9 SC3): viewports bounded by terminal
  rows; 500+ item tabs scroll cleanly without layout breakage; scroll
  position preserved across `/` filter, `s` sort cycle, and framework
  group toggle.
- Color-blind-friendly glyph set (Phase 9 SC4): every selectable picker
  state carries a distinct ASCII-safe glyph in column 1 independent of
  color — selected `◉`, unselected `◯`, protected `🔒`, multi-config MCP
  `⚠`, stale memory `⌛` — with ASCII fallback under `NO_COLOR` / `TERM=dumb`
  / `--no-color`. Legend in the `?` help overlay.
- SIGWINCH-robust picker rendering (Phase 9 SC5): the custom
  `@clack/core.MultiSelectPrompt` subclass now registers a `SIGWINCH`
  handler that recomputes viewport dimensions and issues a full re-render.
  Debounced via `setImmediate` and torn down on picker exit.
- `restore --interactive` / `-i`: open a mirror of the archive picker
  listing every archived item across all manifests (deduplicated,
  newer-wins); select a subset to restore.
- `restore --name <pattern>`: fuzzy single-match restore (case-insensitive
  substring). Ambiguous patterns error with a candidate list — never
  auto-resolve.
- `restore --all-matching <pattern>`: bulk restore of every item matching
  the fuzzy pattern.
- JSON envelope: restore success/partial-success results now include
  additive `selectionFilter` (`null | { mode: "subset", ids: string[] }`)
  and `skipped[]` (source_exists skips with `canonicalId`) fields. See
  `docs/JSON-SCHEMA.md`.
- `restore.filteredStaleCount` JSON field — additive non-negative
  integer on success / partial-success / list envelopes counting
  archive ops suppressed from the restore listing because
  `archive_path` is missing AND `source_path` exists
  (already-restored / test-residue hygiene, Phase 8.2). Applies to
  `restore --list`, `restore --interactive`, and full `restore`.

### Fixed

- `restore --interactive` now executes selected MEMORY items in the subset
  restore path instead of dropping them after picker confirmation. Selected
  memory files have their `ccaudit-stale` / `ccaudit-flagged` frontmatter
  cleaned as expected, and `selectionFilter.ids` now reflects only the
  ids that actually resolved/executed.
- `restore --help` and `ghost --help` no longer leak gunshi's raw
  negatable-placeholder lines (`Negatable of --color`,
  `Negatable of --group-frameworks`). The public `--no-color` and
  `--no-group-frameworks` flags now render as clean user-facing help rows.

## [1.5.0-beta.0] - 2026-04-19

v1.5 "Interactive Archive" — response to Reddit feedback asking for a surgical
alternative to the full-inventory bust. Threads an optional subset filter
through the existing `runBust` pipeline, adds a `@clack/core`-based TUI
picker, and locks down six new safety invariants (INV-S1…S6) before polish.
Restore gains `--interactive` / `--name` / `--all-matching` in a companion
phase (not shipped in this entry — see Phase 8 tracking in `.planning/`).

### Added

- `ghost --interactive` / `-i`: tabbed TUI picker for selective archival.
  Five category tabs (agents / skills / MCP / memory / commands) with
  bounded viewport, cross-tab selection persistence, and an inline
  confirmation screen that replaces the 3-prompt readline ceremony. Requires
  a TTY; non-TTY sessions fall back to `--dry-run`. `--interactive` combined
  with `--json` is a hard error. Hook archival is deferred to a future
  phase.
- Keyboard model: `/` filter (case-insensitive substring), `s` sort cycle
  (staleness → tokens → name), `?` help overlay, `Space` toggle, `a`
  toggle-all-within-tab, `Tab` / `Shift-Tab` / `←` / `→` tab navigation,
  `1`–`6` direct-jump to visible tabs, `Enter` confirm global selection,
  `Esc` / `Ctrl+C` / `q` cancel with "No changes made." and exit 0.
- Live token counter in the picker footer: `X of Y · ≈ Zk tokens saved`
  recomputes on every toggle and re-renders on `SIGWINCH`.
- Framework protection UX: partially-used-framework members render dimmed
  with a `[🔒]` glyph and inline reason
  `"Part of <framework> (N used, M ghost). --force-partial to override."`
  Space is a no-op on protected rows. `--force-partial` surfaces a banner
  warning at the top of the TUI and unlocks the rows for the current run.
- MCP multi-project warning: MCP server rows whose key appears in more than
  one config file render with a `⚠` glyph and a focused-row "Also in:" hint
  listing the referenced config paths.
- JSON envelope fields (additive — see `docs/JSON-SCHEMA.md`):
  `bust.summary.totalPlannedTokens` (full-plan figure preserved across
  subset busts) and `manifest.header.selection_filter` (`{ mode: 'full' }`
  or `{ mode: 'subset', ids: string[] }`).
- Auto-open prompt: after a regular `ccaudit ghost` scan on a TTY, users
  see `Open interactive picker? [y/N]`. Suppressed by `--json`, `--csv`,
  `--quiet`, `--ci`, and non-TTY.
- `CCAUDIT_SELECT_IDS` environment variable: non-interactive subset hook
  (primarily for integration tests and scripted automation). Threads the
  same filter the TUI uses through `runBust`.
- Six new safety invariants (INV-S1…S6) documented in `CLAUDE.md` and
  locked by fixture-based integration tests.

### Changed

- `bust.summary.freedTokens` is now **subset-accurate** when
  `manifest.header.selection_filter.mode === 'subset'`. For full-inventory
  busts (the default non-interactive path) the value is unchanged —
  `freedTokens === totalPlannedTokens` and the v1.4 contract is preserved.
  **Migration note**: consumers that compared `freedTokens` across runs
  must now consult `manifest.header.selection_filter.mode` to distinguish subset vs full
  busts. Dashboards that want "what was the full opportunity?" should read
  `totalPlannedTokens`.

### Fixed

- TUI picker long-list viewport overflow (Phase 3.1): `@clack/prompts.groupMultiselect`
  renders all options inline with no windowing, so long inventories auto-
  anchored to the bottom of the terminal and the highlighted cursor
  disappeared above the viewport. Replaced with a custom
  `@clack/core.MultiSelectPrompt` subclass backed by a bounded viewport
  (`max(8, rows − 10)`) with `↑ N more` / `↓ N more` scroll indicators.
- `@clack/core` Esc → cancel / Enter → submit alias defect (Phase 5 gap
  closure): `@clack/core`'s base `Prompt.onKeypress` unconditionally
  aliased `escape` → cancel and `return` → submit after subclass handlers
  ran, breaking `Esc`-clears-filter, `Enter`-keeps-query, and `Esc`-closes-
  help-overlay contracts. Fixed by wrapping `onKeypress` on the subclass
  and conditionally suppressing the base aliases when `filterMode` or
  `helpOpen` is true. Normal picker-state Ctrl+C / Esc / Enter behavior
  is unchanged.

---

## [1.4.0] - 2026-04-13

Token estimation methodology rewrite. All six Claude Code inventory categories now
use evidence-based formulas derived from Anthropic's published loading documentation
and measured session logs, replacing the old blanket `file-size / 4` wave.

This release also ships the `reclaim` subcommand for recovering orphaned archive
files, an append-only `history.jsonl` audit trail, and four reliability fixes
covering bust accounting, multi-manifest restore, memory-file mtime preservation,
and MCP regime drift between dry-run and bust.

---

### Token Math Methodology Rewrite — Migration Guide

#### Why totals will change

The v1.3.x estimator applied a single `file_size_bytes / 4` heuristic across all
categories. That over-counted skills and agents whose descriptions are shorter than
the full file, and under-counted (or entirely missed) commands and hooks.

Evidence for the new formulas is drawn from:

- Anthropic's published documentation on how Claude Code loads agents, skills, and
  commands into context at session start
- Community-measured session log analysis (GitHub issues #4973, #8997, #14882,
  #31002) confirming per-category loading behaviour
- Live `tool_use` token counts extracted from real Claude Code session JSONL logs
  for MCP server overhead

#### Before vs. after per-category

| Category     | v1.3.x formula        | v1.4.0 formula                                                                                | Typical delta                                     |
| ------------ | --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Skills**   | `file_size_bytes / 4` | `15 + ceil(description_chars / 4)`, cap 250 chars                                             | Lower (often −40–70%)                             |
| **Agents**   | `file_size_bytes / 4` | `30 + ceil(description_chars / 4)`, no cap                                                    | Lower for short desc; higher for long-desc agents |
| **MCP**      | `file_size_bytes / 4` | Measured per-server (eager) or single ToolSearch ~8.7k (deferred)                             | Varies; deferred mode is usually lower            |
| **Memory**   | `file_size_bytes / 4` | File-size heuristic + recursive `@`-import resolution (depth ≤ 5); auto-memory capped at 25KB | Higher (import chains now surfaced)               |
| **Commands** | Not counted           | `min(60 + description_chars / 4, 90)` or `file-size / 4` fallback                             | New category; adds modest tokens                  |
| **Hooks**    | Not counted           | Upper-bound 2,500 tok/fire for inject-capable hooks; advisory by default                      | New category; advisory unless `--include-hooks`   |

#### New CLI flags

| Flag                       | Description                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--regime eager\|deferred` | Override MCP regime detection. `eager` = per-server measured costs. `deferred` = single ToolSearch overhead (~8.7k tokens). Default: `auto`. |
| `--include-hooks`          | Add hook upper-bound token costs to the reported grand total. Without this flag hooks appear as advisory only.                               |

#### New categories

- **`command`** — Slash commands in `~/.claude/commands/` and `.claude/commands/`. Commands
  installed by frameworks (GSD, SuperClaude, etc.) are grouped under the same framework
  detection logic that already groups agents and skills, so bulk-installed commands don't
  inflate the ungrouped list.
- **`hook`** — `PreToolUse`, `PostToolUse`, and `SessionStart` hooks from
  `.claude/settings.json`. Hook token costs are upper-bounds; the actual cost depends on
  the hook script's injected output.

#### Hook advisory policy (Phase 4.1)

Hooks are excluded from the default grand total. The rationale: a pessimistic
upper-bound of 2,500 tokens per inject-capable hook dominates the total and masks
the signal from agents, skills, and memory (the categories where the
bust pipeline can actually take action), so they are advisory unless you pass the flag.

Pass `--include-hooks` to see the pessimistic total. The advisory upper-bound is
always shown in the summary regardless.

```bash
# Default: hooks advisory, not in total
ccaudit ghost --json | jq '.meta.hooksAggregated'       # false
ccaudit ghost --json | jq '.totalOverhead.hooksUpperBound'  # advisory tokens

# Pessimistic mode: hooks included in total
ccaudit ghost --include-hooks --json | jq '.meta.hooksAggregated'  # true
```

#### Auto-memory and import chains (Phase 5)

ccaudit now resolves `@`-import directives in CLAUDE.md files recursively (depth ≤ 5).
Each imported file appears as a separate `memory` row in the inventory with `importDepth`
set (`0` = root, `1+` = imported). The `importRoot` field records which root CLAUDE.md
triggered the import.

Auto-memory files at `~/.claude/projects/<slug>/memory/MEMORY.md` are surfaced
automatically and capped at 25KB (6,250 tokens) to match Claude Code's own
truncation limit.

#### Pointer to README

See README.md § "Upgrading from 1.3.x" for a condensed summary of all changes.

---

### Added

- **Phase 2** — MCP regime detection: auto-detects whether Claude Code is running in
  eager or deferred tool-load mode and applies the appropriate cost model.
  `--regime eager|deferred` flag for manual override.
- **Phase 3** — Slash commands scanned as a first-class inventory category (`command`).
  Framework detection groups bulk-installed commands alongside their sibling agents.
- **Phase 4** — Hook scanner: surfaces `PreToolUse`, `PostToolUse`, and `SessionStart`
  hooks from `.claude/settings.json` as `hook` items with inject-capable detection.
  Category-weighted health score: each category contributes proportionally to the
  ghost and token penalty bands.
- **Phase 4.1** — Hooks are advisory by default (`hooksAggregated: false`).
  `--include-hooks` flag promotes hooks into the grand total.
- **Phase 5** — Auto-memory discovery: `~/.claude/projects/<slug>/memory/MEMORY.md`
  files are found automatically. Recursive `@`-import resolution (depth ≤ 5) with
  per-item `importDepth` and `importRoot` fields in JSON output.
- New `meta` JSON fields: `mcpRegime`, `toolSearchOverhead`, `hooksAggregated`.
- New `totalOverhead` JSON field: `hooksUpperBound`.
- New per-item JSON fields: `hookEvent`, `injectCapable` (hooks); `importDepth`,
  `importRoot` (memory).
- Formula tags in `tokenEstimate.source` for all six categories.
- `ccaudit reclaim [--dry-run]` subcommand recovers orphan files from `~/.claude/ccaudit/archived/` that no manifest references. Safety invariant: never overwrites an existing source path (skips with warning).
- Append-only audit trail at `~/.claude/ccaudit/history.jsonl` (mode `0o600`, parent `0o700`). Records every invocation with structured per-command `result`. Opt-out: `CCAUDIT_NO_HISTORY=1`. Schema version: `history_version: 1`. Stderr advisory at >10 MB.
- Bust summary `Before` line now carries provenance: `Before (from dry-run <ISO timestamp>): ~Xk tokens loaded per session`.
- Bust summary now splits `Archived: N agents, M skills` into independent counters.
- Restore output now reports `moved` and `already-at-source` separately: `N agents/skills restored to their original locations (M were already at source)`.
- `CLAUDE.md` project memory file added for AI coding assistants working in this repo.

### Changed

- Token estimation formulas updated for all categories. See migration guide above.
- `ghost` summary table gains a **Commands** row (always shown) and a **Hooks** row
  (shown only when `--include-hooks` is set; advisory line shown in both modes).
- Health score is now category-weighted. The penalty bands changed — expect small
  score shifts even with identical ghost counts.
- `docs/JSON-SCHEMA.md` updated with new fields, category enum, and formula tags table.
- README updated with v1.4.0 methodology section and "Upgrading from 1.3.x" guide.
- `restore` (full mode) now walks **all** manifests in `~/.claude/ccaudit/manifests/` newest-first, deduplicated by `archive_path`. Previously read only the newest manifest, leaving prior busts' items as orphans.
- `restore` JSON envelope: `counts.unarchived.completed` is replaced by `counts.unarchived.moved` and `counts.unarchived.alreadyAtSource`. **Breaking change for automation consuming this field.**
- Restore quiet TSV output gains an `alreadyAtSource` column between `moved` and `reenabled`.
- Bust JSON envelope: `counts.archive` reshaped from `{ completed, failed }` to `{ agents, skills, failed }`. The serialized manifest footer (`ManifestFooter.actual_ops`) keeps the old `{ completed, failed }` shape via internal mapping for backward compatibility.
- Dry-run checkpoint (`~/.claude/ccaudit/.last-dry-run`) gains `mcp_regime` and `cc_version` fields, captured at dry-run time and pinned through the subsequent bust to eliminate Before/After token-count drift. Old checkpoints without these fields remain valid (defaults: `'unknown'` and `null`).

### Fixed

- Regression: `ghost --include-hooks` delta math preserved — `totalOverhead.tokens`
  (with hooks) minus `totalOverhead.tokens` (default) equals `totalOverhead.hooksUpperBound`.
- Lint cleanup: removed `phase-fanout` scaffold comment from
  `packages/internal/src/report/recommendation.ts`. The `dormant` → `monitor` mapping
  is now documented as final rationale (hooks cannot be archived via the bust pipeline;
  `monitor` is the correct action).
- Bust summary panel showed `0 skills` even when skills were archived, because `BustCounts.archive` merged categories. Counts are now independent.
- Full-mode `restore` only consulted the newest manifest, leaving items archived by prior busts as unreachable orphans on disk. Now walks all manifests.
- `restore` falsely incremented the success counter when the source already existed at the destination (no actual rename happened). Now classified as `already-at-source`.
- Memory-file flag/unflag operations destroyed the file's `mtime` because `writeFile` was used without `utimes`. Staleness detection (mtime-based) silently lost old timestamps after any bust+restore cycle. Fixed via `writeFilePreservingMtime` helper.
- MCP regime detection (subprocess `claude --version` with 500 ms timeout) flipped non-deterministically between dry-run and bust, causing 10-20× swings in token estimates. The regime is now pinned in the dry-run checkpoint and consumed by bust.

### Known issues

**D1** — `tokenPenalty` is identical in default and `--include-hooks` modes despite a
~17.5k token difference in the grand total. Both values fall in the same health-score
penalty band, so the score is unchanged. `ghostPenalty` and `dormantPenalty` are
correctly identical. This is by-design for v1.4.0; consider widening band resolution
in v1.5.

**G1** — `ghost --include-hooks invalid-arg` exits 1 with full output and no error
message. yargs silently ignores extra positional arguments for `ghost`. This is
pre-existing behaviour inherited from v1.3.x. A small targeted fix is tracked for
v1.4.1.

---

## [1.3.1] - 2026-04-13

Metadata-only release to unblock npm publish with provenance. No functional changes.

### Fixed

- Add `repository`, `homepage`, and `bugs` fields to `apps/ccaudit/package.json`.
  npm's provenance verifier requires `package.json#repository.url` to match the
  GitHub repo signed in the OIDC claim; the missing field caused the v1.3.0
  publish to fail with `422 Unprocessable Entity`.

## [1.3.0] - 2026-04-11

Framework-aware ghost grouping. Users that install GSD, SuperClaude, n-wave, or
any of the other 10 curated frameworks now see related agents grouped into a
single row with framework-level totals, and the `--dangerously-bust-ghosts`
pipeline protects partially-used frameworks from being half-archived.

### Added

- Framework-aware ghost grouping via a 3-tier detection algorithm
  (curated registry + heuristic prefix clustering + ungrouped).
- New curated registry of 10 well-known frameworks: `gsd`, `superclaude`,
  `nwave`, `superpowers`, `ralph-loop`, `agent-council`, `greg-strategy`,
  `ideabrowser`, `gstack`, `hermes`. See
  `packages/internal/src/framework/known-frameworks.ts`.
- `--verbose` / `-v` flag on `ghost` and `inventory` commands. Expands each
  framework row into a tree of its members; used members collapse to a
  `+ N used members` line.
- `--no-group-frameworks` escape hatch on `ghost` and `inventory`. Reverts
  output to the v1.2.1 layout byte-for-byte (no Frameworks section, no
  additive JSON envelope keys, no framework column in tables).
- `--force-partial` opt-in override on `ghost --dangerously-bust-ghosts` and
  `ghost --dry-run`. Bypasses framework-as-unit protection and archives ghost
  members of partially-used frameworks.
- Additive JSON envelope fields: top-level `.frameworks[]` array (with `id`,
  `displayName`, `source_type`, `status`, `totals`, `memberCount`) and
  per-item `.items[].framework` (string or `null`). Both keys are entirely
  absent when `--no-group-frameworks` is set.
- New `packages/internal/src/framework/` sub-module: types, valibot-validated
  curated registry, `STOP_PREFIXES` and `DOMAIN_STOP_FOLDERS` stop-lists,
  `detectFramework()`, `groupByFramework()`, and `computeFrameworkStatus()`.
- New `packages/internal/src/remediation/framework-bust.ts` pure helper that
  applies framework-as-unit protection to a bust target list without
  touching the existing `bust.ts` orchestrator.
- New `packages/terminal/src/tables/framework-section.ts` renderer used by
  both the ghost and inventory tables.
- Yellow warning block + `PROTECTED` section in the change plan output
  whenever framework protection is active.

### Changed

- `ccaudit ghost` prepends a "Frameworks" section above the ungrouped list
  when any frameworks are detected. Per-category ghost counts annotate with
  `(X in frameworks above)` so totals stay arithmetically sound.
- `ccaudit inventory` groups rows by framework in default mode; verbose mode
  adds a `Framework` column and sorts rows by framework then urgency.
- `ghost --help` and `inventory --help` now list the three new flags with
  descriptions.
- CSV and TSV output in verbose mode gains a trailing `framework` column
  (default-mode CSV/TSV is unchanged for backward compatibility).

### Fixed

- _(none)_

### Backward Compatibility

This release is strictly additive — every existing consumer continues to work
without changes.

- **v1.2.1 jq paths unchanged.** `ccaudit ghost --json | jq '.items[].name'`,
  `.items[].tier`, `.items[].tokenEstimate`, `.meta.timestamp`,
  `.ghosts.total`, and all other v1.2.1 JSON paths continue to resolve.
- **Byte-for-byte escape hatch.** `ccaudit ghost --json --no-group-frameworks`
  produces output byte-for-byte identical to v1.2.1 (after normalizing
  `meta.timestamp` and `meta.version`). No `frameworks` key, no per-item
  `framework` key, no framework column in CSV/TSV, no Frameworks section in
  the terminal output.
- **Restore reads v1.2.1 manifests unchanged.** `ccaudit restore` against a
  v1.2.1 bust manifest completes without modification or error.
- **`bust.ts` untouched.** `packages/internal/src/remediation/bust.ts` is 1,483
  lines, identical to v1.2.1. All new bust logic lives in new files.
- **`restore.ts` manifest contract preserved.** `packages/internal/src/remediation/restore.ts`
  keeps its v1.2.1 manifest shape and on-disk behavior, so every v1.2.1 bust
  manifest restores without modification. The only change this release is an
  internal process-gate fix on the parent-chain self-invocation path — no
  consumer-visible surface moves.
- **Exit code ladder unchanged.** `0` success, `1` ghosts found / soft error,
  `2` checkpoint write failure, `3` running Claude Code process detected,
  `4` non-TTY without `--yes-proceed-busting`. Framework-level bust and
  restore reuse this ladder — no new exit codes.

## [1.2.1] - 2026-04-09

Baseline release prior to framework-aware ghost grouping. See the git history
for details.
