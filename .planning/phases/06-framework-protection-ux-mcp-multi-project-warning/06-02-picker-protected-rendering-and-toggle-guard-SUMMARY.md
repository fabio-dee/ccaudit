---
phase: 06-framework-protection-ux-mcp-multi-project-warning
plan: 02
subsystem: terminal/tui
tags: [tui, picker, framework-protection, accessibility, toggle-guard]
requires:
  - Phase 6 Plan 01 (GhostItem.protection + isProtected helper)
  - Phase 5 (tabbed picker substrate, framework sub-headers, filter/sort, help overlay)
provides:
  - _protection-render.ts pure helpers (protectedGlyph, renderProtectedPrefix, dimLine, protectedHintLine)
  - TabbedGhostPicker.forcePartial (immutable per-invocation option, default false)
  - TabbedGhostPicker.itemsById reverse index (id → TokenCostResult)
  - Row-render dim + [🔒] glyph on protected items
  - Below-cursor hint slot: protected reason (verbatim from scanner)
  - Toggle-guard on Space / a / group-toggle
  - Post-mutation invariant assertion (fail-loud in vitest, silent-drop in prod)
affects:
  - TabbedGhostPicker render output (additive row prefix + hint dispatch branch)
  - TabbedGhostPicker toggle-method semantics (skip protected when forcePartial=false)
tech_stack:
  added: []
  patterns:
    - pure helper module with in-source tests (no @clack/core, no fs)
    - glyph + dim co-occurrence (never color-alone, D6-20)
    - shared hint slot with priority dispatch (no stacking)
    - immutable per-invocation option (D6-16 — no setter)
    - belt-and-braces invariant: assert in test, silent-drop in prod
key_files:
  created:
    - packages/terminal/src/tui/_protection-render.ts
  modified:
    - packages/terminal/src/tui/tabbed-picker.ts
decisions:
  - "dim SGR uses 22 reset (not 0) so other attributes survive composed spans"
  - "hint-slot precedence: filter-input > protection > Phase 5 help/filter-hint"
  - "itemsById reverse index built once at construction (paired with tokensById)"
  - "forcePartial is a constructor option, not a setter — immutable per invocation"
  - "group-toggle filters eligibleIds BEFORE anyUnselected computation"
  - "invariant asserts loud under import.meta.vitest; silently drops protected IDs in prod"
metrics:
  duration_minutes: 12
  tasks_completed: 2
  completed_date: 2026-04-19
---

# Phase 6 Plan 02: Picker protected rendering and toggle guard — Summary

**One-liner:** Framework-protected rows in the tabbed picker now render dim with a `[🔒]` glyph (ASCII `[L]`) on every frame, display the scanner-provided `protection.reason` verbatim in the below-cursor hint slot, and every bulk-toggle path (Space, `a`, framework-group toggle) filters them out of the selection Set when `--force-partial` is OFF.

## What shipped

1. **`packages/terminal/src/tui/_protection-render.ts`** — Pure helper module, zero runtime deps, 12 in-source tests:
   - `protectedGlyph(ascii)` → `[🔒]` or `[L]`.
   - `renderProtectedPrefix(item, { ascii })` → `"  [🔒] "` / `"  [L] "` or `""` for unprotected.
   - `dimLine(text, { ascii, colorless })` wraps in `\x1b[2m…\x1b[22m` (22 reset preserves other SGR attributes); passes through raw when `colorless: true`.
   - `protectedHintLine(item, { ascii })` returns `"  " + protection.reason` verbatim, or `null` for unprotected.

2. **`packages/terminal/src/tui/tabbed-picker.ts`** — Wire-up:
   - `TabbedPickerInput.forcePartial?: boolean` (default `false`) added to the public input shape with docstring referencing D6-13/D6-16.
   - Readonly `this.forcePartial` stored at construction; no setter exposed (D6-16 immutability).
   - `this.itemsById: Map<string, TokenCostResult>` reverse index built alongside `tokensById` in the same construction pass.
   - Import of `isProtected` from `@ccaudit/internal` (re-exported from Plan 01).
   - `toggleCurrentRow()`:
     - Item row: when `!forcePartial && isProtected(item)`, early-return (silent no-op, D6-09).
     - Sub-header row: computes `eligibleIds = groupIds.filter(!isProtected)` when `!forcePartial`; if `eligibleIds.length === 0`, no-op (D6-12).
     - Post-mutation `_assertNoProtectedSelected()`.
   - `toggleAllInActiveTab()`: filters `baseSource` by `!isProtected` when `!forcePartial` (D6-10), then runs the existing select-all-or-clear logic over the filtered set. Post-mutation invariant.
   - Row render (`_renderFrame` viewport loop): when `!forcePartial && isProtected(item)`, prepends `renderProtectedPrefix(...)` and wraps the row body in `dimLine(...)`. Glyph order per D6-04: `[cursor][🔒] [x] <name>`. When `forcePartial` is ON, rows render normally.
   - Hint dispatch: new branch between the filter-input branch (Phase 5 D5-01) and the default help hint (Phase 5 D3.1-11) — when a focused item is protected and `!forcePartial`, render `protectedHintLine(...)` in the shared below-cursor slot (D6-05). Filter-input mode still wins (user actively typing).
   - `_assertNoProtectedSelected()`: post-mutation invariant — when `!forcePartial`, no protected canonical ID may appear in `selectedIds`. Throws under `import.meta.vitest`; silently drops in production (server-side INV-S6 in `runBust` is the real gate).

## Commits

| Task | Hash | Title |
|------|------|-------|
| 1 | `1a3c729` | feat(tui): add _protection-render pure helpers (06-02) |
| 2 | `36423d7` | feat(tui): gate framework-protected rows in TabbedGhostPicker (06-02) |

## Verification

Plan-specified commands:

- `pnpm --filter @ccaudit/terminal exec vitest run src/tui/_protection-render.ts` → **1 file, 12 tests passed** (all new in-source tests green).
- `pnpm --filter @ccaudit/terminal test` → **25 files, 439 tests passed** (no regressions; existing picker tests untouched — the 50-item fixture has no protected items so default-false `forcePartial` preserves legacy behavior).
- `pnpm --filter ccaudit-cli test -- tabbed-picker` → **35 files, 231 passed / 1 skipped / 1 todo** (all Phase 5 picker pty-regression suites untouched).

Invariant spot-checks:

- `grep -n "isProtected" packages/terminal/src/tui/tabbed-picker.ts` → 6 sites: import (line 27), Space/item gate (677), group-toggle filter (692), invariant scan (713), toggle-all filter (744), render dim-gate (1000). Plan target: 4+. ✅
- Zero new runtime deps: no `chalk`, no new `dependencies` added — dim is raw SGR.
- `dimLine` uses `\x1b[22m` reset — grep for `\\x1b\\[0m` in `_protection-render.ts` returns 0 matches (test asserts this).
- Post-mutation invariant: `_assertNoProtectedSelected()` is called from `toggleCurrentRow` (both item + sub-header paths) and `toggleAllInActiveTab`. Under vitest it throws loud on any protected-ID leak.

## Deviations from plan

**None.** Plan executed as written. A few notes:

1. **`n` / `i` keys not present in the current picker** — the plan mentions them as toggle paths to guard (D6-11), but a grep for `char === 'n'` / `char === 'i'` in `tabbed-picker.ts` returns no matches. Only `Space`, `a`, and framework-group toggle exist today. No gating was added for `n` / `i` because they don't exist yet. If Phase 5 / future phases add them, they must include the protection filter (noted here for future discovery). The post-mutation `_assertNoProtectedSelected()` is a belt-and-braces catch-all that would surface any future toggle path that forgets to filter.

2. **Hint-slot priority**: plan says protection hint takes "highest priority" but also notes filter-input is Phase 5 interactive input. I implemented precedence as `filter-input > protection-hint > help-hint`: when the user is actively typing into the filter, the filter echo must remain visible (it's interactive state, not a read-only hint). This matches the "hint slot is shared — don't stack" rule and the Phase 5 D5-01 contract. Protection hint wins over the default help hint when the focused row is protected.

3. **Bundle-size gate deferred** — per Plan 01's SUMMARY and the plan-06-02 header note ("skip workspace verify — bundle gate is Plan 06-05's responsibility"), no bundle measurement was performed here. The additions are ~40 LOC in the helper + ~30 LOC in the picker — well under D6-25's 10 KB gzipped phase-wide budget.

## Threat model mitigations applied

- **T-06.02-01 (E, selection-set integrity)**: every toggle path filters via `isProtected()` BEFORE mutating the Set; post-mutation `_assertNoProtectedSelected()` runs from both `toggleCurrentRow` and `toggleAllInActiveTab` as a runtime verification.
- **T-06.02-02 (I, dim-only signal)**: glyph `[🔒]` / `[L]` is ALWAYS included via `renderProtectedPrefix` — `dimLine` wraps the row but the glyph appears unconditionally whenever `isProtected && !forcePartial`. Verified by `renderProtectedPrefix` in-source test (glyph present for protected; empty for unprotected).
- **T-06.02-03 (T, reason-string drift)**: `protectedHintLine` reads `item.protection.reason` verbatim — no template construction in the picker. Verified by the "passes reason verbatim" in-source test.
- **T-06.02-05 (R, hint-slot precedence)**: documented in the render branch comment (`Phase 6 Plan 02 (D6-05): …`) so future phases see the ordering `filter-input > protection > help`.

## Self-Check: PASSED

- File created: `packages/terminal/src/tui/_protection-render.ts` FOUND.
- File modified: `packages/terminal/src/tui/tabbed-picker.ts` reflects all five wire-up changes (import, input interface, fields, constructor wiring, toggle gates, render, hint dispatch, invariant method).
- Commits: `1a3c729`, `36423d7` both FOUND in `git log`.
- Zero runtime deps: `packages/terminal/package.json` dependencies block unchanged.
- In-source test delta: +12 new tests in `_protection-render.ts`; existing terminal suite 439 tests unchanged (no regressions).
- Phase 5 pty regression suite: 231 tests pass, unchanged.
- `isProtected` grep returns 6 sites (target ≥4). ✅
