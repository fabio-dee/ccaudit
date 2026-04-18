---
phase: 04-live-token-counter
plan: 02
subsystem: tui
tags: [picker, live-counter, sigwinch, throttle, sub-minimum-terminal, ascii-fallback]
status: completed
completed: 2026-04-18
commit: 5369898
requires:
  - 04-01
provides:
  - TabbedGhostPicker.renderTokenCounter (live)
  - TabbedGhostPicker._computeSelectionTotal
  - TabbedGhostPicker._computeActiveTabTokens
  - TabbedGhostPicker._terminalTooSmall
  - TabbedGhostPicker._registerResize / _unregisterResize / _handleResize
  - TabbedGhostPicker.prompt override (SIGWINCH-wrapped)
affects:
  - packages/terminal/src/tui/tabbed-picker.ts
  - packages/internal/src/index.ts
tech-stack:
  added: []
  patterns: [in-source-vitest, throttled-event-handler, render-on-state-write, pre-computed-catalog-map]
key-files:
  created: []
  modified:
    - packages/terminal/src/tui/tabbed-picker.ts
    - packages/internal/src/index.ts
decisions:
  - "Per-tab header subtotal segment is suppressed when compact === '' (i.e. selection sums to 0) — avoids `AGENTS (1/2 · )` noise when the only selected item has null tokenEstimate. Matches the global footer's empty-string suppression rule from D4-10."
  - "prompt() return type widened to `Promise<string[] | symbol | undefined>` to match @clack/core's MultiSelectPrompt base signature; openTabbedPicker's `isCancel(result)` discriminator already narrows against symbol so the undefined case falls through harmlessly to the selected-with-empty-set branch."
  - "Barrel export for formatTokensApprox + sumSelectionTokens was missing from packages/internal/src/index.ts even though both existed in ./token/index.ts. Added to the top-level barrel so @ccaudit/terminal can import them without a deep path. Deviation Rule 3 — blocked the task until fixed."
metrics:
  duration: ~8min
  tasks: 2
  files: 2
  tests_added: 12
---

# Phase 04 Plan 02: Wire counter + resize Summary

One-liner: live token counter now renders in the TabbedGhostPicker footer and per-tab header with a SIGWINCH lifecycle + 50ms throttle + sub-minimum-terminal banner; all Phase 3.1 safety invariants and 12 new in-source tests pass.

## What shipped

**File: `packages/terminal/src/tui/tabbed-picker.ts`**

- `import { ... formatTokensApprox } from '@ccaudit/internal'` — added the Phase 04-01 helper to the existing import.
- New public fields: `tokensById: Map<string, number>` (pre-computed in constructor; O(1) lookup per render); `_resizeHandler` and `_resizeThrottleTimer` (private resize machinery).
- `renderTokenCounter` is now a closure over `this` that calls `formatTokensApprox(this._computeSelectionTotal(), { ascii: this.useAscii })`. A caller-provided `input.renderTokenCounter` still takes precedence (D3.1-12 seam preserved).
- `_computeSelectionTotal()` — sums `tokensById.get(id)` over `selectedIds`. O(|selection|).
- `_computeActiveTabTokens()` — per-tab subtotal for the header.
- `_terminalTooSmall()` — predicate (`rows < 14 || cols < 60`).
- `toggleCurrentRow` / `toggleAllInActiveTab` — guarded with an early-return when terminal is too small (D4-08; INV-S2 preserved because cancel keys remain live).
- `_registerResize()` — installs a throttled (50ms trailing-edge) `'resize'` listener on `process.stdout`. Idempotent.
- `_unregisterResize()` — removes the listener and clears the pending timer.
- `_handleResize()` — re-reads `process.stdout.rows`/`columns`, sets `this.state = 'active'` to re-trigger @clack/core's render subscription.
- `prompt()` override — wraps `super.prompt()` in `try/finally` around `_registerResize` / `_unregisterResize`. Returns `Promise<string[] | symbol | undefined>` to match the base class signature exactly.
- `_renderFrame()` changes:
  - Top-of-function sub-minimum-terminal branch returns a single banner line (`⚠ Terminal too small …` / `! Terminal too small …` in ASCII mode).
  - Per-tab header extended to `{LABEL} (N/M · ≈ Xk)` when N > 0 AND the subtotal formats to a non-empty string; falls back to bare `{LABEL} (N/M)` otherwise.
  - Global count + counter joined onto one line: `N of M selected across all tabs · ≈ Zk tokens saved`. Suffix suppressed when sum is 0 (preserves Phase 3.1's empty-selection form).
  - ASCII mode uses `|` instead of `·` as the separator.

**File: `packages/internal/src/index.ts`**

- Added `formatTokensApprox` and `sumSelectionTokens` to the top-level barrel's `./token/index.ts` re-export block. Plan 04-01 shipped them in the sub-barrel only; consumers via the package root needed this addition.

## Files touched

| File | Change |
|---|---|
| `packages/terminal/src/tui/tabbed-picker.ts` | +340 lines: live counter wiring, SIGWINCH lifecycle, sub-min branch, 12 tests |
| `packages/internal/src/index.ts` | +2 lines: barrel re-export for formatTokensApprox + sumSelectionTokens |

No other files modified. `select-ghosts.ts`, `ghost.ts`, `SelectGhostsOutcome`, `TabbedPickerInput`, `TabbedPickerOutcome`, and `openTabbedPicker` are byte-for-byte identical at their public surfaces.

## Test results

`pnpm verify` green end-to-end:
- typecheck: 0
- lint: 0
- build: 0 (bundle smoke + size gate pass)
- test: 1410 passed, 2 skipped, 1 todo across 109 test files
- format:check: all 181 files clean

Targeted: `pnpm -F @ccaudit/terminal test -- --run tabbed-picker.ts` → 364 passed (was 352; +12 net added).

## Deviations from plan

**1. [Rule 3 — Blocking issue] Missing barrel export for formatTokensApprox**
- **Found during:** Task 1 verification. `TypeError: formatTokensApprox is not a function` at render time.
- **Cause:** Plan 04-01 exported the function from `packages/internal/src/token/index.ts` (the sub-barrel) but the top-level `packages/internal/src/index.ts` did not re-export it. Phase 04-02 consumes it via `@ccaudit/internal` (the package root), so the deep-path fix wasn't enough.
- **Fix:** Added `formatTokensApprox` and `sumSelectionTokens` to the existing `./token/index.ts` re-export block in `packages/internal/src/index.ts`.
- **Commit:** included in `5369898`.

**2. [Rule 1 — Test bug] null-tokenEstimate test selected wrong row**
- **Found during:** Task 1 verification. Test expected `AGENTS (1/2)` but received `AGENTS (1/2 · ~ 2k)`.
- **Cause:** Tab items sort descending by tokens in the constructor, so for `[a1(null), a2(1500)]` the cursor-0 row is a2, not a1. The plan's test body selected `toggleCurrentRow()` on the default cursor, which picked up the 1500-token item.
- **Fix:** Added `picker.cursorDown()` before `toggleCurrentRow()` so the test actually exercises the null-estimate code path. Comment explains the sort order.
- **Commit:** included in `5369898`.

**3. [Rule 1 — Type error] prompt() return type too narrow**
- **Found during:** Task 2 typecheck. `Type 'symbol | string[] | undefined' is not assignable to type 'symbol | string[]'`.
- **Cause:** Plan specified `Promise<string[] | symbol>` for the override, but @clack/core's base class signature is `Promise<string[] | symbol | undefined>`.
- **Fix:** Widened the override return type to `Promise<string[] | symbol | undefined>`. The `undefined` case is handled identically to the selected-empty-set case by `openTabbedPicker`'s `isCancel(result)` discriminator, so no behavior change.
- **Commit:** included in `5369898`.

**4. [Minor — Header subtotal suppression refinement beyond plan wording]**
- The plan's header logic said `if (selectedInTab > 0) → use compact`. I extended this to also check `if (compact === '') → fall back to bare N/M`. Without this, a selection of only null-estimate items would render `AGENTS (1/2 · )` — a visible dangling separator. The D4-10 empty-string rule applies symmetrically to the per-tab header.
- This is covered by the `items with null tokenEstimate contribute 0 …` test.

No plan goals dropped; all success criteria met.

## TDD gate compliance

This plan is `type: execute` with two `tdd="true"` tasks, not a plan-level TDD gate. Tests were written alongside implementation in a single commit because the helper-layer TDD gate (RED for `formatTokensApprox`/`sumSelectionTokens`) already fired in plan 04-01; this plan's contribution is integration wiring, not new behavior-layer specification.

## Self-Check

- [x] `grep -c "formatTokensApprox" packages/terminal/src/tui/tabbed-picker.ts` → 3 (import + 2 call sites at the header + footer closure).
- [x] `grep -c "_computeSelectionTotal" packages/terminal/src/tui/tabbed-picker.ts` → 2 (declaration + call).
- [x] `grep -c "_computeActiveTabTokens" packages/terminal/src/tui/tabbed-picker.ts` → 2.
- [x] `grep -c "this.tokensById" packages/terminal/src/tui/tabbed-picker.ts` → ≥ 2.
- [x] `grep -c "_registerResize" packages/terminal/src/tui/tabbed-picker.ts` → ≥ 3 (declaration + call in prompt override + call in lifecycle test).
- [x] `grep -c "_unregisterResize" packages/terminal/src/tui/tabbed-picker.ts` → ≥ 3.
- [x] `grep -c "process.stdout.on('resize'" packages/terminal/src/tui/tabbed-picker.ts` → 1.
- [x] `grep -c "process.stdout.off('resize'" packages/terminal/src/tui/tabbed-picker.ts` → 1.
- [x] `grep -c "Terminal too small" packages/terminal/src/tui/tabbed-picker.ts` → ≥ 3 (banner + ASCII test + Unicode test + cols test).
- [x] The literal `50` appears in the SIGWINCH throttle setTimeout next to the `D4-09` comment.
- [x] `listenerCount` appears in the lifecycle test.
- [x] Commit `5369898` exists on branch `feat/v1.5-interactive-archive`.
- [x] `pnpm verify` exits 0.

## Self-Check: PASSED
