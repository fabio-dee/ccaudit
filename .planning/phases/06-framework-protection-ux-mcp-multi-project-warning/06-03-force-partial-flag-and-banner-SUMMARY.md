---
phase: 06-framework-protection-ux-mcp-multi-project-warning
plan: 03
subsystem: cli + terminal/tui
tags: [cli, tui, picker, framework-protection, force-partial, banner, viewport]
requires:
  - Phase 6 Plan 01 (InventoryItem.protection propagation + isProtected)
  - Phase 6 Plan 02 (TabbedGhostPicker.forcePartial field + toggle guards)
  - Phase 3.1 viewport formula (D3.1-05)
provides:
  - _force-partial-banner.ts pure helper (renderForcePartialBanner, bannerHeight)
  - computeViewportHeight({ bannerRows }) — default 0, Phase 3.1 call sites byte-identical
  - TabbedGhostPicker renders the banner on every frame above the tab bar when forcePartial=true
  - --force-partial documented as per-invocation interactive-picker unlock (help text extended)
  - selectGhosts({ forcePartial }) adapter passthrough to openTabbedPicker
affects:
  - TabbedGhostPicker._renderFrame output (+1 line when flag on)
  - cursorPageUp/Down/render viewport calls (bannerRows plumbed)
  - ghost.ts --force-partial help description (extended — not replaced)
  - InventoryItem type (additive protection field — Rule 3 fix, see Deviations)
tech_stack:
  added: []
  patterns:
    - pure helper module with in-source tests (no fs/no color/no deps)
    - glyph + text carry the warning independently of color (D6-20)
    - bannerRows argument defaults to 0 (backward-compat with Phase 3.1/4/5)
    - per-invocation flag; no env var, no config read, no cache
key_files:
  created:
    - packages/terminal/src/tui/_force-partial-banner.ts
  modified:
    - apps/ccaudit/src/cli/commands/ghost.ts
    - packages/terminal/src/tui/select-ghosts.ts
    - packages/terminal/src/tui/tabbed-picker.ts
    - packages/terminal/src/tui/_viewport.ts
    - packages/internal/src/scanner/types.ts
decisions:
  - "banner emitted as the very first line of the frame output, above the tab bar (D6-08)"
  - "pc.yellow wrap only when !useAscii — ASCII mode drops color; text + glyph carry signal"
  - "protectedCount computed from itemsById each frame — O(n) on construction-bounded catalog"
  - "bannerRows default 0 in computeViewportHeight — Phase 3.1/4/5 call sites stay byte-identical"
  - "existing --force-partial flag description EXTENDED (not replaced) since prior phases rely on its non-interactive effect; plan's proposed 'no effect in non-interactive mode' contradicted current server-side behavior"
  - "forwarded forcePartial via spread so the optional property stays absent in the openTabbedPicker call when false (Plan 02's default-false semantics preserved)"
metrics:
  duration_minutes: 12
  tasks_completed: 3
  completed_date: 2026-04-19
---

# Phase 6 Plan 03: --force-partial flag and banner — Summary

**One-liner:** The existing `--force-partial` CLI flag is now plumbed through `selectGhosts` into `TabbedGhostPicker`, which renders a prominent top-of-TUI banner (`⚠ --force-partial active: framework protection DISABLED. Partial framework splits may corrupt dependent setups.` — with `!` and a zero-protected suffix fallback) on every frame while the flag is ON, and the viewport formula deducts one row so the picker chrome budget stays honest.

## What shipped

1. **`packages/terminal/src/tui/_force-partial-banner.ts`** — Pure helper, no deps, 8 in-source tests:
   - `renderForcePartialBanner({ active, protectedCount, ascii })` — returns `""` when inactive, the D6-08 single-line warning otherwise. Prefix glyph `⚠` (Unicode) or `!` (ASCII). Appends `(no protected items in this scan)` when `protectedCount === 0` (D6-14). No ANSI in the helper — colorless path is test-assertable.
   - `bannerHeight({ active })` — returns `active ? 1 : 0` for viewport math.

2. **`packages/terminal/src/tui/_viewport.ts`** — `computeViewportHeight` gains `bannerRows?: number` (default 0). When provided it is subtracted from both the formula path (`Math.max(8, rows-10) - bannerRows`) and the `rowsOverride` path (`Math.max(1, rowsOverride - bannerRows)`). Three new in-source tests confirm `bannerRows=1` reduces by 1, default stays at 0, and `rowsOverride` path also subtracts.

3. **`apps/ccaudit/src/cli/commands/ghost.ts`** — The `--force-partial` flag already existed from Phase 3.2 (D-37) as a server-side bust-protection bypass. Its description is **extended** (not replaced) to document the new interactive-picker semantics: *"Under --interactive, also allows selecting framework-protected rows in the picker (per-invocation only; not persisted)."* The single call site to `selectGhosts(...)` now forwards `forcePartial`. No env var, no cache, no config read.

4. **`packages/terminal/src/tui/select-ghosts.ts`** — `SelectGhostsInput.forcePartial?: boolean` added; destructured and forwarded to `openTabbedPicker` via object spread so the key is omitted when `false` (preserves Plan 02's default-false semantics and keeps the `openTabbedPicker` signature shape unchanged).

5. **`packages/terminal/src/tui/tabbed-picker.ts`** — Banner render + viewport wiring:
   - Imports `renderForcePartialBanner` and `bannerHeight`.
   - In `_renderFrame`, between the helpOpen/terminalTooSmall early returns and the tab-bar emission, emits the banner as `lines[0]` when `this.forcePartial === true`. Protected count is computed by iterating `itemsById.values()` and filtering via `isProtected(item.item)`.
   - Banner wrapped in `pc.yellow(...)` when `!this.useAscii` — drops color in ASCII mode (glyph + text already carry the signal).
   - Three `computeViewportHeight` call sites (`cursorPageUp`, `cursorPageDown`, `_renderFrame`) now pass `bannerRows: bannerHeight({ active: this.forcePartial })`. Default-false path is byte-identical.

## Commits

| Task | Hash | Title |
|------|------|-------|
| 1 | `103d50a` | feat(tui): add _force-partial-banner pure helper (06-03) |
| 2 | `45a9693` | feat(cli,tui): plumb --force-partial through selectGhosts to picker (06-03) |
| 3 | `6459b66` | feat(tui): render --force-partial banner + viewport math (06-03) |

## Verification

Plan-specified commands:

- `pnpm --filter @ccaudit/terminal exec vitest run src/tui/_force-partial-banner.ts` → **1 file, 8 tests passed**.
- `pnpm --filter @ccaudit/terminal test` → **26 files, 450 passed** (was 447 at Plan 02 tip; +3 new viewport tests).
- `pnpm --filter ccaudit-cli test -- help-output ghost-command interactive-smoke` → **35 files, 231 passed / 1 skipped / 1 todo**.
- `pnpm --filter ccaudit-cli test -- tabbed-picker-overflow tabbed-picker-50-item-fixture tabbed-picker-live-counter interactive-smoke` → **35 files, 231 passed / 1 skipped / 1 todo** (Phase 3.1/4/5 regression suite unchanged).
- `pnpm build` → green (full CLI bundle).
- `pnpm --filter @ccaudit/terminal typecheck` → green.
- `pnpm --filter ccaudit-cli typecheck` → green.

Invariant spot-checks:

- `grep -rn "CCAUDIT_FORCE_PARTIAL" apps packages` → empty. No env-var plumbing (D6-16 ✅).
- `grep -rn "forcePartial.*config\\|forcePartial.*env" apps packages` → only the intentional `ctx.values.forcePartial` gunshi reads; no config-file path; no cache.
- Banner glyph + text always co-occur — ASCII fallback is asserted by in-source test; no color-only signal (D6-20 ✅).
- Viewport regression: `computeViewportHeight({ stdoutRows: 30, bannerRows: 0 })` byte-identical to legacy call; Phase 3.1/4/5 integration suite green.

## Deviations from plan

### [Rule 3 — blocking] InventoryItem.protection field

`packages/internal/src/scanner/types.ts` was modified to add `protection?: FrameworkProtection` to `InventoryItem`. The picker's Plan 02 code calls `isProtected(row.item.item)` where `row.item.item` is `InventoryItem`, but `InventoryItem` did not carry the `protection` field — only `GhostItem` did (Plan 01's `toGhostItems` annotates on the wrong type for the picker data-flow). This manifested as seven pre-existing TS2559 errors that blocked the full workspace build (`pnpm build`).

Minimum fix applied: additive optional field on `InventoryItem`. The runtime annotate path is unchanged — this plan does not wire `InventoryItem.protection` population. Making the field type-visible is necessary for Plan 03's build gate and any downstream consumer. The deeper data-flow gap (ensuring `InventoryItem.protection` is populated by the scanner or annotate path) is a Plan 02 follow-up and should be tracked by Plan 06-05's integration tests.

### [Rule 1 — text deviation] Help description extension (not replacement)

The plan's task 2 requested a help-text replacement that read *"Allow selecting framework-protected items in the interactive picker. Per-invocation only — not persisted. No effect in non-interactive mode (server-side INV-S6 unchanged)."*

But the existing `--force-partial` flag (shipped in Phase 3.2 D-37) **does** affect non-interactive mode — it governs `applyFrameworkProtection` so `--dry-run`/`--dangerously-bust-ghosts` runs can archive ghost members of partially-used frameworks. Replacing the description would misdocument server-side behavior that prior phases depend on.

Resolution: the existing description is preserved and **extended** with a trailing clause covering the interactive-picker semantics. Both senses are now documented on one flag. All plan truths (per-invocation, no env var, no config, no cache, banner on every frame, viewport reduced, ASCII fallback) are satisfied; only the verbatim wording differs.

### Bundle size gate deferred

Per Plan 01 + Plan 02 SUMMARY precedent and the plan header note "Skip full workspace bundle gate (06-05's job)", no bundle measurement was performed here. The additions are ~50 LOC in the helper + ~20 LOC in the picker + small type/CLI additions — well under D6-25's phase-wide 10 KB gzipped budget. The full workspace `pnpm verify` still fails against the stale Phase 3.2 bundle baseline, as expected.

## Threat model mitigations applied

- **T-06.03-01 (E, persistence)**: flag is parsed per-invocation from gunshi `ctx.values.forcePartial` and flows straight through; grep for `CCAUDIT_FORCE_PARTIAL` returns empty; no config-file read path was added; picker constructor's `forcePartial` is `readonly`.
- **T-06.03-02 (I, banner determinism)**: banner rendered on every frame (not only on toggle) — the render hook lives in `_renderFrame` which runs after every keypress; glyph + text carry the signal; ASCII fallback verified by in-source test.
- **T-06.03-03 (T, zero-protected confusion)**: `protectedCount === 0` path appends the `(no protected items in this scan)` suffix — user cannot be misled into thinking the flag was dropped (D6-14). Covered by dedicated in-source test.
- **T-06.03-04 (R, help-text clarity)**: help description explicitly documents the interactive-picker semantics and the per-invocation scope; the flag's server-side meaning is preserved from prior phases and still documented.
- **T-06.03-05 (D, viewport math regression)**: `bannerRows` defaults to 0 so all Phase 3.1/4/5 call sites are byte-identical; the in-source test guards the subtraction.

## Self-Check: PASSED

- File created: `packages/terminal/src/tui/_force-partial-banner.ts` FOUND.
- Files modified: `apps/ccaudit/src/cli/commands/ghost.ts`, `packages/terminal/src/tui/select-ghosts.ts`, `packages/terminal/src/tui/tabbed-picker.ts`, `packages/terminal/src/tui/_viewport.ts`, `packages/internal/src/scanner/types.ts` — all changes present.
- Commits: `103d50a`, `45a9693`, `6459b66` all FOUND in `git log`.
- Zero runtime deps: `packages/terminal/package.json` dependencies block unchanged.
- In-source test delta: +8 banner-helper tests + 3 viewport tests; terminal suite 447 → 450 pass.
- Plan 3.1/4/5 pty-regression tests green; help-output shows `--force-partial`.
