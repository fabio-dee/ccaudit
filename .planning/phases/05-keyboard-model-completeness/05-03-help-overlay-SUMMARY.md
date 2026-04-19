---
phase: 05-keyboard-model-completeness
plan: 03
subsystem: terminal/tui
tags: [help-overlay, keyboard-model, tabbed-picker, phase-5, accessibility]
requires:
  - "packages/terminal/src/tui/tabbed-picker.ts (Plan 02 filter + sort)"
provides:
  - "Modal `?` help overlay on TabbedGhostPicker"
  - "`renderHelpOverlay(input)` pure render function + grouped binding catalog"
  - "`helpOpen: boolean` public field on TabbedGhostPicker"
  - "ASCII fallback for overlay (D5-21)"
  - "Sub-minimum compact overlay fallback (D5-15)"
affects:
  - "packages/terminal/src/tui/tabbed-picker.ts"
tech-stack:
  added: []
  patterns:
    - "pure render function with deterministic output (snapshot-friendly)"
    - "priority-ordered key gate: help > filter > base bindings"
    - "cursor handler `cancel` exemption preserves INV-S2"
key-files:
  created:
    - packages/terminal/src/tui/_help-overlay.ts
  modified:
    - packages/terminal/src/tui/tabbed-picker.ts
decisions:
  - "D5-13: `?` toggles overlay; while open, swallow every key except `?` (toggle off) and `Esc` (close); Ctrl+C still cancels"
  - "D5-14: 4-group catalog (Navigation / Selection / View / Exit), each with one-line descriptions"
  - "D5-15: rows < 14 triggers one-column compact layout ending with `(Press ? to close and resize terminal)`"
  - "D5-21: ASCII mode uses `# Navigation` headings and `^ v <- ->` arrow stand-ins"
  - "Claude-Discretion: `?` is always routed to help even from filter mode — filter state is preserved through the overlay and resumes on close"
  - "T-05-02: cursor handler explicitly exempts `action === 'cancel'` from the help-open swallow"
metrics:
  duration: ~20min
  completed: 2026-04-19
  tasks: 2
  files: 2
---

# Phase 05 Plan 03: Help Overlay Summary

Shipped the modal `?` help overlay per D5-13..D5-16 and D5-21 on top of the
Plan 02 filter+sort substrate. Pure render function lives in a new
`_help-overlay.ts`; picker carries a single new `helpOpen` boolean. State
(selection, cursor, active tab, filter query, filter active flag, per-tab
sort) is fully preserved across open+close cycles. Ctrl+C still cancels
while the overlay is up (INV-S2 / T-05-02 guard). Full `pnpm verify` green.

## What Shipped

### New pure render module: `_help-overlay.ts`

- `renderHelpOverlay({ useAscii, rows, cols })` — deterministic, never throws.
- Binding catalog built at call time from a `buildGroups(useAscii)` helper
  so glyphs are swapped inline (no branchy formatting at the caller). Groups:
  - **Navigation**: ↑ ↓ / PgUp PgDn / Home End / Tab Shift-Tab / ← → / 1..6
  - **Selection**: Space / a / n / i
  - **View**: / / s / ?
  - **Exit**: Enter / Esc / Ctrl+C
- Normal mode (`rows >= 14`): two-column-style layout with key column
  right-padded to align descriptions; heading framed by `── Navigation ──`.
- Compact mode (`rows < 14`): one-column list terminated by
  `(Press ? to close and resize terminal)` per D5-15.
- ASCII mode (`useAscii: true`) per D5-21: `# Navigation` heading prefix,
  `^ v` for up/down, `<- ->` for left/right. No Unicode box-drawing, no
  arrow glyphs, no ANSI (pure string).
- Every line hard-truncated to `cols` via plain `slice`; `cols <= 0`
  clamps to 1 so degenerate inputs never crash.
- 7 in-source tests: group-content sanity, ASCII swap, Unicode framing,
  compact fallback, determinism (x2 identical inputs ⇒ identical output),
  truncation width, degenerate-input tolerance.

### TabbedGhostPicker wiring

- New public field: `helpOpen: boolean = false`.
- `on('key', ...)` top-of-dispatch gate:
  ```ts
  if (this.helpOpen) {
    if (char === '?' || info?.name === 'escape') {
      this.helpOpen = false;
      this.state = 'active';
    }
    return;
  }
  if (char === '?') {
    this.helpOpen = true;
    this.state = 'active';
    return;
  }
  ```
  Placed BEFORE the filter-mode branch per CONTEXT "Claude's Discretion"
  recommendation — `?` is always routed to help, even from filter mode.
- `on('cursor', ...)` gate:
  ```ts
  if (this.helpOpen && action !== 'cancel') return;
  ```
  The `action !== 'cancel'` exemption preserves INV-S2: Ctrl+C (mapped to
  cursor action `cancel` by the base class) must still cancel the picker
  even while help is shown. T-05-02 mitigation.
- `_renderFrame()` early return at the top (before the sub-minimum banner
  and all layout work):
  ```ts
  if (this.helpOpen) {
    return renderHelpOverlay({
      useAscii: this.useAscii,
      rows: this.stdoutRows ?? 24,
      cols: this.terminalCols,
    });
  }
  ```
  The overlay replaces the entire frame (tab bar, header, viewport, footer)
  while open. No render cost paid for the hidden picker content.

### In-source tests added (7)

Grouped under `describe('Phase 5 help overlay — Plan 03 (D5-13..D5-16)')`:

1. `'?'` toggles `helpOpen` true/false.
2. `Esc` closes overlay without mutating filter query (query + active flag
   both intact after close).
3. While help is open, printable keys (`/`, `s`, `a`, `2`, `x`) and cursor
   actions (`down`, `space`, `right`) are all swallowed — cursor, tab,
   sort, selection, filterMode all unchanged.
4. Open+close preserves selectedIds, activeTabIndex, per-tab cursor, and
   per-tab sort across a full state-building sequence.
5. Cursor `cancel` action is still honored while help is open — the gate
   does not swallow it. Test stubs the picker's `cancel()` method and
   confirms it ran.
6. `_renderFrame()` returns overlay content (contains every group heading
   and does NOT contain the `AGENTS (0/1)` tab header) when `helpOpen`.
7. `?` opens help from inside filter mode; `filterMode` remains `true`
   (preserved for resume on close).

## Verification

- `pnpm -F @ccaudit/terminal test -- _help-overlay` → 24/24 files, 407/407 tests (the 7 new in-source tests).
- `pnpm -F @ccaudit/terminal test -- tabbed-picker` → 24/24 files, 414/414 tests (previous 400 + 7 overlay-module + 7 picker-integration).
- `pnpm verify` → green end-to-end: typecheck, lint, build, bundle smoke, bundle-size gate, 1467 tests across monorepo, format:check.
- `grep -n "action !== 'cancel'" packages/terminal/src/tui/tabbed-picker.ts` → line 387, confirming T-05-02 mitigation present.
- No new dependencies (zero-runtime-dep invariant holds).
- Phase 3.1, Phase 4, Phase 5 Plans 01/02 regression tests all green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Test robustness] Cursor-cancel test avoids racing the real `cancel()` flow**

- **Found during:** Authoring the T-05-02 cancel-exemption test.
- **Issue:** Calling the real `picker.cancel()` during a unit test transitions
  the base class state and can interact with @clack/core's prompt lifecycle,
  which is not fully mounted in the in-source test environment.
- **Fix:** The test stubs `picker.cancel` with a spy that only records it was
  invoked, asserts the stub ran, and never flips the picker state. This is
  consistent with existing in-source test patterns in the file that drive
  handlers via `emit(...)` without mounting the full prompt.
- **Files modified:** `packages/terminal/src/tui/tabbed-picker.ts` (test only)
- **Commit:** `40b840f`

**2. [Rule 2 — Render-branch placement] Render early-return goes ABOVE the sub-minimum banner**

- **Found during:** Writing the `_renderFrame` branch.
- **Issue:** The plan action said "add an early return at the very top (before
  sub-minimum banner)". The sub-minimum banner at line 657 gates on
  `_terminalTooSmall()` and — if triggered — returns before normal rendering.
  Placing help AFTER that gate would mean a user who opens help while in a
  sub-minimum viewport would still see only the sub-minimum banner, violating
  D5-15 (compact overlay must still render).
- **Fix:** Help branch is the very first return in `_renderFrame()`, BEFORE
  the sub-minimum check. `renderHelpOverlay` itself handles the sub-minimum
  case via its `rows < 14` compact-mode path.
- **Files modified:** `packages/terminal/src/tui/tabbed-picker.ts`
- **Commit:** `40b840f`

### Scope note — `n` and `i` in the catalog

The help catalog lists `n` (clear selections) and `i` (invert selection) in
the Selection group per D5-14. These bindings are not implemented in the
current picker (Phase 3.1 / 5 only wires `a`, `Space`). The catalog
documents the *intended* keyboard model from INTERACTIVE-ARCHIVE-DESIGN §5.4;
users who press `n`/`i` today hit a no-op in the key dispatcher. This
matches D5-14's explicit scope ("static grouped keybind list") and is
consistent with the phase objective (model completeness, not feature
completeness across all bindings). Not flagged as a deviation.

### Format Auto-fix

`oxfmt --check` passed on first run (formatting stayed within bounds).
No semantic change.

## Threat Flags

None. Overlay text is fully static (no user-input interpolation — T-05-03
`accept` disposition holds). T-05-02 mitigation is in place and covered
by the cursor-cancel-exemption test.

## Self-Check: PASSED

- FOUND: packages/terminal/src/tui/_help-overlay.ts
- FOUND: packages/terminal/src/tui/tabbed-picker.ts (modified)
- FOUND: commit eaad629 (Task 1: renderHelpOverlay + tests)
- FOUND: commit 40b840f (Task 2: helpOpen + gate + render branch + tests)
- FOUND: `grep action !== 'cancel' tabbed-picker.ts` → line 387 (INV-S2 guard)
- FOUND: pnpm verify green (1467 tests, typecheck/lint/build/bundle/format all pass)
- FOUND: 414 in-source tests pass in the terminal package (up from 400 — 14 new across help-overlay module + picker integration)

## Next Plan

Plan 04 (`05-04-framework-group-toggle-PLAN.md`) adds the framework-group
toggle on `Space` when the cursor sits on a rendered framework sub-header.
Current picker has no sub-header rendering, so the planner will need to
decide whether this plan introduces sub-headers or gates the binding
behind existing rendering. The help-overlay catalog already lists `Space`
under Selection, so no catalog update will be needed when Plan 04 lands.
