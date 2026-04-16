# Roadmap: ccaudit v1.5 — Interactive Selective Archive

## Overview

v1.5 is the "interactive archive" response to Reddit feedback (*"takes a fire-axe to your agents… just stay in the tool"* / *"ccaudit --restore pencil-dev"*). The journey threads an optional selection filter through the existing `runBust` pipeline (Approach A — filter after verify), builds a `@clack/prompts`-based TUI over that plumbing, locks down six new safety invariants (S1–S6) before any polish ships, then mirrors the picker UX onto `restore`. Source of truth: `INTERACTIVE-ARCHIVE-DESIGN.md` §8 (decisions D1–D8 locked 2026-04-15). Ship gate for v1.5 core: Phases 1+2+3+8.

## Milestones

- 🚧 **v1.5 Interactive Archive** — Phases 1–9 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Selection plumbing** — Thread optional selection filter through `runBust` without UI; byte-identical hash refactor (completed 2026-04-15)
- [x] **Phase 2: TUI picker v0.5** — First working `ccaudit ghost --interactive` with `@clack/prompts.groupMultiselect` + auto-open prompt (D7) (completed 2026-04-16)
- [ ] **Phase 3: Safety-invariant integration tests** — Fixture-based tests for INV-S1…S6 locking the contract before polish (v1.5-beta ship gate)
- [ ] **Phase 4: Live token counter** — Footer updates on every Space press via `@clack/core.MultiSelectPrompt` subclass
- [ ] **Phase 5: Keyboard model completeness** — Group collapse, filter, sort cycle, help overlay, framework-group toggle
- [ ] **Phase 6: Framework protection UX + MCP multi-project warning** — Surface existing protection in the picker; warn on multi-config MCPs
- [ ] **Phase 7: JSON envelope contract + docs** — Document additive fields, CHANGELOG entries, README section, CLAUDE.md invariants
- [ ] **Phase 8: `restore --interactive` (v1.5 core ship gate)** — Mirror picker UX for restore; `--name` fuzzy match; `--all-matching` bulk
- [ ] **Phase 9: Polish & edge cases** — Terminal resize, pagination, empty-state, env escape hatch, color-blind indicators

**Parallelization note:** Phases 4, 5, 6, 7 are parallel-eligible after Phase 3 completes. Phase 8 must follow Phase 3 (it mirrors the picker pattern and depends on the plumbing locked in Phases 1+3). Phase 9 runs last.

## Phase Details

### Phase 1: Selection plumbing
**Goal**: Thread an optional `selectedItems` filter through `runBust` so a subset bust produces a filtered manifest, subset-accurate `freedTokens`, and a full-inventory hash gate — all without any UI. Ship the plumbing validated by unit tests before touching the TUI.
**Depends on**: Nothing (first phase)
**Requirements**: SAFETY-04, SAFETY-05
**Success Criteria** (what must be TRUE):
  1. `runBust({ selectedItems })` with a subset produces a manifest whose `header.planned_ops.{archive,disable,flag}` counts sum to exactly the selection size (INV-S4 observable via JSON envelope).
  2. `bust.summary.freedTokens` reflects only the archived subset's token estimate; `bust.summary.totalPlannedTokens` preserves the full-plan figure as an additive field (INV-S5 observable via JSON envelope).
  3. `computeGhostHash` output is byte-identical before and after the `canonicalItemId` refactor (golden-fixture test protects against drift).
  4. Subset bust end-to-end works at the subprocess level via `CCAUDIT_SELECT_IDS` env (integration test).
  5. `pnpm verify` is green; no TUI, no new runtime dependency, bundle size unchanged.
**Plans**: 3 plans
- [x] 01-01-canonical-item-id-PLAN.md — Extract `canonicalItemId` from `computeGhostHash`; add golden-fixture test that freezes hash bytes against refactor drift
- [x] 01-02-thread-selected-items-PLAN.md — Thread optional `selectedItems` through `runBust`; apply filter after hash verify; add `totalPlannedTokens` summary field and `selection_filter` manifest header
- [x] 01-03-cli-env-hook-PLAN.md — Parse `CCAUDIT_SELECT_IDS` at CLI boundary; subprocess integration test asserts INV-S4 + INV-S5 end-to-end

### Phase 2: TUI picker v0.5
**Goal**: First working `ccaudit ghost --interactive` / `-i`. A `@clack/prompts.groupMultiselect` picker opens on a TTY, groups ghosts by category then framework, shows a static confirmation screen, and executes `runBust({ selectedItems })` on the chosen subset. Includes the D7 auto-open prompt after a regular `ghost` scan. Zero-runtime-deps invariant holds: `@clack/prompts` is devDep + bundled.
**Depends on**: Phase 1
**Requirements**: TUI-01, TUI-03, TUI-04, TUI-06, TUI-07
**Success Criteria** (what must be TRUE):
  1. User runs `ccaudit ghost --interactive` on a TTY and a grouped multi-select picker opens; Space toggles, Enter confirms, Ctrl+C / `q` cancels with "No changes made." exit 0.
  2. After confirmation, bust executes on the selected subset only; unselected items are untouched on disk.
  3. `--interactive` combined with `--json` produces a hard error; non-TTY invocation falls back to `--dry-run` predictably.
  4. After a regular `ccaudit ghost` scan on a TTY, user sees `Open interactive picker? [y/N]` prompt; the prompt is suppressed under `--json`, `--csv`, `--quiet`, `--ci`, or non-TTY.
  5. Memory file rows render with `[~]` / `[≈]` glyph (or ASCII fallback when `CCAUDIT_ASCII_ONLY=1` or auto-detected); confirmation screen replaces the 3-prompt readline ceremony in the interactive path.
  6. Published package's `dependencies` field stays empty (verified via `pnpm publish --dry-run`); `dist/index.js` gzipped size grew by less than 15 KB.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Safety-invariant integration tests
**Goal**: Lock down the 6 new safety invariants (INV-S1 through INV-S6) with fixture-based integration tests before any polish ships. This phase is the v1.5.0-beta gate.
**Depends on**: Phase 2
**Requirements**: SAFETY-01, SAFETY-02, SAFETY-03, SAFETY-06
**Success Criteria** (what must be TRUE):
  1. Fixture test: two MCP servers A and B in shared `~/.claude.json`; subset-bust A; B's key is byte-identical post-bust (INV-S1).
  2. Subprocess test: spawn TUI, send SIGINT (or `CCAUDIT_TUI_ABORT=1`); exit is 0 and `~/.claude/ccaudit/manifests/` contains no new file (INV-S2).
  3. Round-trip test: subset bust {A, B} + full bust {C} → `ccaudit restore` restores all three items to their source paths (INV-S3).
  4. Fixture test: partial-framework scenario shows protected items locked and unselectable in default mode; `--force-partial` unlocks them (INV-S6).
  5. `pnpm verify` + new interactive tests green; manual QA on at least 3 terminal emulators (iTerm2, kitty, Gnome Terminal).
**Plans**: 4 plans
- [x] 03-01-test-infra-PLAN.md — Add CCAUDIT_FORCE_TTY=1 test hook to ghost.ts + extend _test-helpers.ts with shared helpers (buildFakePs, runCcauditGhost, createMcpFixture, createFrameworkFixture, listManifestsDir, readMcpConfigBytes, agentItemId, mcpItemId)
- [ ] 03-02-mcp-byte-preservation-PLAN.md — INV-S1 byte-preservation of unselected MCP keys + INV-S4/S5 cross-path equivalence (3 tests)
- [ ] 03-03-tui-abort-restore-roundtrip-PLAN.md — INV-S2 SIGINT-during-picker = zero disk writes + INV-S3 subset+full manifest restore round-trip (2 tests in 2 files)
- [ ] 03-04-framework-protection-PLAN.md — INV-S6 framework-protected items not selectable without --force-partial (2 tests + 1 it.todo Phase 6 pointer) + 03-QA-CHECKLIST.md manual QA matrix

### Phase 4: Live token counter
**Goal**: Footer on the picker updates on every Space press, showing `X of Y · ≈ Zk tokens saved` in real time. Switches from `groupMultiselect` to a custom `@clack/core.MultiSelectPrompt` subclass; all existing keybinds preserved.
**Depends on**: Phase 3
**Requirements**: (polish on TUI behavior — no new REQ; live counter is a refinement of TUI-01/TUI-04's user experience)
**Success Criteria** (what must be TRUE):
  1. Footer value updates correctly on single-item toggle, `a` (select all), `n` (select none), `i` (invert), and framework-group toggle.
  2. Footer re-renders on terminal resize (`SIGWINCH`) at the new width without losing cursor position.
  3. All Phase 2 keybinds continue to work (no regression); Phase 3 safety-invariant tests still pass.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Keyboard model completeness
**Goal**: Deliver the full keyboard model from design doc §5.4 — group collapse, filter, sort cycle, help overlay, framework-group toggle. Completes TUI-02.
**Depends on**: Phase 3
**Requirements**: TUI-02
**Success Criteria** (what must be TRUE):
  1. User presses `g` on a focused group to collapse it; collapsed header shows "(N selected of M)". `G` collapses all groups.
  2. User presses `/` to open a filter; typing narrows visible items by case-insensitive substring; footer shows "Filtered: M of N visible · X selected (incl. hidden)"; selection state is preserved across filter on/off.
  3. User presses `s` to cycle sort order: staleness desc → tokens desc → name asc; order is stable on subsequent cycles.
  4. User presses `?` to open the help overlay listing every keybind; `Esc` closes the overlay.
  5. User presses Space on a framework sub-group header and every item within the framework toggles as a unit.
  6. All keybinds work end-to-end on a 50-item fixture without layout breakage.
**Plans**: TBD
**UI hint**: yes

### Phase 6: Framework protection UX + MCP multi-project warning
**Goal**: Surface the existing framework-as-unit protection in the TUI as a dimmed/locked row with inline reason; `--force-partial` unlocks with a banner warning. Add scanner enhancement to detect MCP server keys referenced in multiple config files and warn via `⚠` glyph.
**Depends on**: Phase 3
**Requirements**: TUI-05
**Success Criteria** (what must be TRUE):
  1. User sees framework-protected items dimmed with `[🔒]` glyph and inline reason `"Part of <framework> (N used, M ghost). --force-partial to override."`; Space on a protected row does nothing.
  2. User runs `--interactive --force-partial` and sees a prominent top-of-TUI banner warning; previously locked rows become selectable.
  3. MCP server rows whose key appears in more than one config file render with `⚠` glyph and a focused-row inline hint naming the referenced configs.
  4. INV-S6 test is strengthened with a multi-framework fixture; a multi-config MCP fixture test is added and green.
**Plans**: TBD
**UI hint**: yes

### Phase 7: JSON envelope contract + docs
**Goal**: Document the additive JSON envelope fields, flag the behavioral change to `freedTokens`, update user-facing docs and the project's safety-invariants memory.
**Depends on**: Phase 3
**Requirements**: DOCS-01, DOCS-02, DOCS-03, DOCS-04
**Success Criteria** (what must be TRUE):
  1. `docs/JSON-SCHEMA.md` describes `bust.summary.totalPlannedTokens` and `manifest.header.selection_filter` as additive fields with type, example, and semantics (DOCS-01).
  2. `CHANGELOG.md` `[Unreleased]` section has entries under "Added" (new fields, `--interactive`, `restore --name`) and "Changed" flagging `bust.summary.freedTokens` subset-accurate semantics (DOCS-02).
  3. `README.md` has a new `--interactive` section with an ASCII screenshot of the picker, confirmation, and restore flow (DOCS-03).
  4. `CLAUDE.md` safety-invariants section lists Approach A + INV-S1 through INV-S6 with one-line user-visible guarantee per invariant (DOCS-04).
  5. `ccaudit --help` / subcommand help text reflects the new flags; `pnpm verify` is green.
**Plans**: TBD

### Phase 8: `restore --interactive` (v1.5 core ship gate)
**Goal**: Mirror the archive picker UX onto `restore`. Reads from manifest union (deduplicated newer-wins), offers the same grouped multi-select, and executes subset restore. Adds `--name <pattern>` fuzzy match with ambiguity error and `--all-matching <pattern>` bulk. This is the **v1.5 core ship gate** per design doc §8 — completes the Reddit user's ask.
**Depends on**: Phase 3
**Requirements**: RESTORE-01, RESTORE-02, RESTORE-03
**Success Criteria** (what must be TRUE):
  1. User runs `ccaudit restore --interactive` on a TTY and sees a mirror picker (same layout, same keybinds as archive) listing every archived item from all manifests, deduplicated.
  2. User selects a subset and confirms; only the chosen items are restored to their source paths; items whose source path already exists are skipped with a warning (existing `reclaim`/`restore` invariant preserved).
  3. User runs `ccaudit restore --name pencil-dev`; unambiguous matches restore; ambiguous matches error with a candidate list (no "most recent wins" behavior) (RESTORE-02).
  4. User runs `ccaudit restore --all-matching pencil-` and every candidate for the fuzzy pattern is restored (RESTORE-03).
  5. Round-trip invariants INV-S3 and subset-restore parity tests (mirror of Phase 3 structure) are green.
**Plans**: TBD
**UI hint**: yes

### Phase 9: Polish & edge cases
**Goal**: Close known edge cases and accessibility gaps that do not block v1.5 core ship: terminal resize robustness on macOS Terminal.app, pagination for 500+ items, empty-state messaging, env escape hatch, color-blind-friendly indicators (every state has a glyph, not just a color).
**Depends on**: Phase 8
**Requirements**: (polish — no new REQ; closes edge cases for TUI behaviors already shipped in earlier phases)
**Success Criteria** (what must be TRUE):
  1. When the inventory has zero ghosts, the TUI is skipped and the user sees a "clean inventory" message with exit 0.
  2. `CCAUDIT_NO_INTERACTIVE=1` in the environment disables the `--interactive` auto-open prompt and hard-errors on explicit `--interactive` with a clear message.
  3. A 500+ item fixture paginates without layout breakage; scroll position is preserved across filter/sort operations.
  4. Every selectable state (selected / unselected / protected / multi-config MCP / stale memory) is distinguishable without relying on color alone — a distinct glyph exists for each.
  5. Terminal resize during picker interaction does not corrupt the display on macOS Terminal.app (SIGWINCH handled defensively).
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order. Phases 4, 5, 6, 7 may run in parallel after Phase 3 (parallelization is enabled in config). Phase 8 is the v1.5 core ship gate and must complete before Phase 9.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Selection plumbing | 3/3 | Complete   | 2026-04-15 |
| 2. TUI picker v0.5 | 4/4 | Complete   | 2026-04-16 |
| 3. Safety-invariant integration tests | 1/4 | In Progress|  |
| 4. Live token counter | 0/TBD | Not started | - |
| 5. Keyboard model completeness | 0/TBD | Not started | - |
| 6. Framework protection UX + MCP multi-project | 0/TBD | Not started | - |
| 7. JSON envelope contract + docs | 0/TBD | Not started | - |
| 8. restore --interactive (ship gate) | 0/TBD | Not started | - |
| 9. Polish & edge cases | 0/TBD | Not started | - |

---
*Roadmap created: 2026-04-15 from `INTERACTIVE-ARCHIVE-DESIGN.md` §8 (decisions D1–D8 locked 2026-04-15)*
