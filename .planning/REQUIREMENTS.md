# Requirements: ccaudit v1.5

**Defined:** 2026-04-15
**Core Value:** Quantify and reversibly cull Claude Code's ghost inventory without ever destroying user data. Nothing deletes; everything restores.

## v1.5 Requirements

Requirements for the v1.5 milestone — "interactive archive" response to Reddit feedback. Each maps to one phase in ROADMAP.md (traceability filled by roadmapper). Derived from `INTERACTIVE-ARCHIVE-DESIGN.md` (2026-04-15 research + locked decisions D1–D8).

### TUI (interactive picker surface)

- [x] **TUI-01**: User can run `ccaudit ghost --interactive` (short `-i`) to open a multi-select picker on a TTY. Non-TTY sessions fall back gracefully; `--interactive` combined with `--json` is a hard error.
- [ ] **TUI-02**: Picker groups ghosts by category (agents / skills / MCP / memory / commands / hooks) then by framework sub-group; full keyboard model per design doc §5.4 (arrows, Space, a/n/i, g/G, /, s, ?, Enter, q, Ctrl-C).
- [x] **TUI-03**: Selection flows through `runBust` via Approach A — full-inventory hash governs the gate; filter is applied after verification. Non-interactive `--dangerously-bust-ghosts` path is unchanged when `selectedItems` is undefined.
- [x] **TUI-04**: Confirmation screen replaces the 3-prompt readline ceremony in the interactive path. Confirmation shows categorized summary + estimated savings. `y + Enter` proceeds, `b` returns to picker preserving selection, `q` cancels.
- [x] **TUI-05**: Framework-protected items appear dimmed + locked with inline reason (`"Part of <framework> (N used, M ghost). --force-partial to override."`); not selectable in default mode. `--force-partial` unlocks them with a banner warning.
- [ ] **TUI-06**: Memory file glyph uses `[~]` / `[≈]` with `CCAUDIT_ASCII_ONLY=1` fallback (and auto-detection for terminals without Unicode width support).
- [x] **TUI-07**: After a regular `ccaudit ghost` scan on a TTY, prompt `Open interactive picker? [y/N]`. Suppressed by non-TTY, `--json`, `--csv`, `--quiet`, `--ci`. Opt-in required; never auto-proceeds.

### SAFETY (new invariants S1–S6)

- [x] **SAFETY-01** (INV-S1): Unselected MCP server keys are byte-preserved in `~/.claude.json` after subset bust. Verified by fixture test — serverA + serverB; select A; assert B's key is byte-identical post-bust.
- [x] **SAFETY-02** (INV-S2): Ctrl+C / SIGINT during TUI produces zero disk writes. Verified by subprocess test — spawn TUI, send SIGINT, assert exit 0 and empty `~/.claude/ccaudit/manifests/`.
- [ ] **SAFETY-03** (INV-S3): Subset manifests + full manifests round-trip through `ccaudit restore`. Verified by test — subset bust {A, B}, full bust {C}, `restore` restores all three.
- [ ] **SAFETY-04** (INV-S4): `manifest.header.planned_ops` counts reflect the filtered plan, not the full plan. Verified by test — N-of-M subset bust; assert `header.planned_ops.archive + disable + flag === N` and exactly `N+2` JSONL lines.
- [ ] **SAFETY-05** (INV-S5): `bust.summary.freedTokens` is subset-accurate; additive `bust.summary.totalPlannedTokens` preserves the full-plan figure for consumers. Verified by test — two known-cost agents, subset-bust one, assert `freedTokens` matches that agent's estimate.
- [ ] **SAFETY-06** (INV-S6): Framework-protected items are not selectable in the TUI without `--force-partial`. Verified by fixture test — partial-framework scenario shows items locked; `--force-partial` unlocks.

### RESTORE (D3 — both halves ship in v1.5)

- [ ] **RESTORE-01**: User can run `ccaudit restore --interactive` — mirror picker UX (same layout, same keybinds) reading from manifest union (deduplicated newer-wins). Selection → subset restore.
- [ ] **RESTORE-02**: User can run `ccaudit restore --name <pattern>` with fuzzy match. Ambiguity errors with a candidate list (no "most recent wins" surprise, per D8).
- [ ] **RESTORE-03**: User can run `ccaudit restore --all-matching <pattern>` for bulk restore when they explicitly want every candidate for a fuzzy pattern.

### DOCS (contract documentation)

- [ ] **DOCS-01**: `docs/JSON-SCHEMA.md` documents `bust.summary.totalPlannedTokens` and `manifest.header.selection_filter` as additive fields.
- [ ] **DOCS-02**: `CHANGELOG.md` `[Unreleased]` entry flags `bust.summary.freedTokens` behavioral change (subset-accurate semantics) under "Changed".
- [ ] **DOCS-03**: `README.md` gets a `--interactive` section with ASCII screenshot showing the picker, confirmation, and restore flow.
- [ ] **DOCS-04**: `CLAUDE.md` safety-invariants section is updated with Approach A model and INV-S1 through INV-S6.

## Future Requirements

Deferred to v1.6+. Tracked but not in v1.5 roadmap.

### Scanner enhancement (may slip if Phase 6 blocks progress)

- **MCP-MULTI-01**: Scanner detects MCP server keys that appear in multiple config files (global + project-local); exposes `referencedConfigs: string[]` on `InventoryItem` for MCP entries. TUI shows `⚠` glyph + inline hint on multi-config MCPs.

### Polish + accessibility (Phase 9 tail that may slip)

- **POLISH-01**: Pagination for 500+ items via virtualized scrolling.
- **POLISH-02**: Terminal resize robustness on macOS Terminal.app (SIGWINCH handling is flaky per R6).
- **POLISH-03**: Screen-reader accessibility hints for TUI rows.

### v2 stretch (design doc §2)

- **STRETCH-01**: `ccaudit archive <name>` one-shot non-interactive shortcut (Reddit's exact ask syntax; v1.5 covers it via `--interactive` + `restore --name`).

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| React/Ink TUI | Violates zero-runtime-deps bundle budget (~70KB+ gzipped for framework alone). Disqualified in design doc §4. |
| Approach B safety arch (second checkpoint with subset hash) | Additional file invites sync hazards; no threat-model benefit over Approach A. Rejected in design doc §6.2/App. C. |
| Approach C (merge TUI + bust, no durable checkpoint) | Regresses v1.4.0 provenance design; loses audit trail. Rejected. |
| Approach D (3-layer provenance) | Maximum complexity, marginal gain. Rejected. |
| Breaking JSON envelope changes | Envelope is public contract per CLAUDE.md; shape changes require breaking-change CHANGELOG flag. v1.5 stays additive. |
| TUI auto-proceed without confirmation | D5 locks `--interactive` as "implies bust with confirmation" — never silent execution. |
| Most-recent-wins ambiguity resolution on `restore --name` | D8 locks to "error with candidate list". Silent ambiguity = trust erosion. |
| `blessed` / `neo-blessed` TUI libraries | ~200 KB+ gzipped — ruled out on bundle budget. |

## Traceability

Which phases cover which requirements. Filled by roadmapper during ROADMAP.md creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TUI-01 | Phase 2 | Complete |
| TUI-02 | Phase 5 | Pending |
| TUI-03 | Phase 2 | Complete |
| TUI-04 | Phase 2 | Complete |
| TUI-05 | Phase 6 | Complete |
| TUI-06 | Phase 2 | Pending |
| TUI-07 | Phase 2 | Complete |
| SAFETY-01 | Phase 3 | Complete |
| SAFETY-02 | Phase 3 | Complete |
| SAFETY-03 | Phase 3 | Pending |
| SAFETY-04 | Phase 1 | Pending |
| SAFETY-05 | Phase 1 | Pending |
| SAFETY-06 | Phase 3 | Pending |
| RESTORE-01 | Phase 8 | Pending |
| RESTORE-02 | Phase 8 | Pending |
| RESTORE-03 | Phase 8 | Pending |
| DOCS-01 | Phase 7 | Pending |
| DOCS-02 | Phase 7 | Pending |
| DOCS-03 | Phase 7 | Pending |
| DOCS-04 | Phase 7 | Pending |

**Coverage:**
- v1.5 requirements: 20 total
- Mapped to phases: 20 ✓
- Unmapped: 0 ✓

**Per-phase requirement counts:**
- Phase 1 (Selection plumbing): 2 — SAFETY-04, SAFETY-05
- Phase 2 (TUI picker v0.5): 5 — TUI-01, TUI-03, TUI-04, TUI-06, TUI-07
- Phase 3 (Safety-invariant tests): 4 — SAFETY-01, SAFETY-02, SAFETY-03, SAFETY-06
- Phase 4 (Live token counter): 0 — polish on prior TUI behavior
- Phase 5 (Keyboard model completeness): 1 — TUI-02
- Phase 6 (Framework protection UX + MCP multi-project): 1 — TUI-05
- Phase 7 (JSON envelope + docs): 4 — DOCS-01, DOCS-02, DOCS-03, DOCS-04
- Phase 8 (restore --interactive ship gate): 3 — RESTORE-01, RESTORE-02, RESTORE-03
- Phase 9 (Polish & edge cases): 0 — polish; no new REQ

---
*Requirements defined: 2026-04-15*
*Last updated: 2026-04-15 after ROADMAP.md creation — traceability filled, 20/20 mapped*
