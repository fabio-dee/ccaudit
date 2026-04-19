---
phase: 04-live-token-counter
verified: 2026-04-18T22:30:00Z
status: passed
score: 3/3 ROADMAP success criteria + 5/5 plan 04-04 must-haves verified
overrides_applied: 0
---

# Phase 4: Live token counter — Verification Report

**Phase Goal:** Add the live-updating token counter to the tabbed picker footer — `N of M selected across all tabs · ≈ Zk tokens saved` recomputed on every Space / `a` toggle, with per-tab header subtotals, SIGWINCH resize handling, sub-minimum terminal banner, and ASCII fallback. The custom `@clack/core.MultiSelectPrompt` subclass already exists from Phase 3.1 — Phase 4 adds the counter render hook, resize handler, and tests.

**Verified:** 2026-04-18T22:30:00Z
**Status:** passed
**Verifier style:** goal-backward, inline (read SUMMARYs, git state, grep for key strings, confirm test coverage — did not re-run `pnpm verify`; was green at plan 04-04 execution time and no source touched since commit `f07eda6`).

---

## ROADMAP Success Criteria (3/3 verified)

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| SC1 | Footer value updates correctly on single-item toggle and `a` (toggle-all within active tab); global total across tabs stays accurate | VERIFIED | `packages/terminal/src/tui/tabbed-picker.ts` implements `renderTokenCounter` and per-tab header subtotal using `sumSelectionTokens` + `formatTokensApprox` (commits `70eba64`, `5369898`). Six D4-14 integration tests in `apps/ccaudit/src/__tests__/tabbed-picker-live-counter.test.ts` cover Space toggle, `a` toggle-all (scope: active tab only), and cross-tab counter accuracy. Plan 04-03 SUMMARY enumerates cases 1–6. Human-verify smoke (plan 04-04, 2026-04-18) confirmed steps 3–6 behave live on a real terminal. |
| SC2 | Footer re-renders on terminal resize (`SIGWINCH`) at the new width without losing cursor position | VERIFIED | `tabbed-picker.ts` grep: `SIGWINCH` / `_handleResize` / `renderTokenCounter` present. 50ms trailing-edge throttle + sub-minimum banner path (grep count for "Terminal too small" = 4 in `tabbed-picker.ts`). Plan 04-03 added `CCAUDIT_TEST_RESIZE` seam + D4-14 case 4 SIGWINCH test. Human-verify smoke step 7 confirmed clean re-render within ~100ms with selection, active tab, and cursor preserved; step 8 confirmed sub-minimum banner renders without crashing; step 9 confirmed state preserved on resize-up. |
| SC3 | All Phase 3.1 keybinds continue to work (no regression); Phase 3 safety-invariant tests still pass | VERIFIED | `git diff 24d3c68..HEAD -- apps/ccaudit/src/__tests__/safety-invariants-tui-abort.test.ts` → empty (INV-S2 file byte-identical across Phase 4). `pnpm verify` was green at plan 04-04 Task 1 (1417 tests pass — up from 1349 in Phase 3.1, delta = new Phase 4 tests only). Human-verify smoke step 10: `q` cancel → exit 0, no new manifest under `~/.claude/ccaudit/manifests/` (INV-S2 preserved end-to-end on the live path). All Phase 3.1 keybinds (Space / a / Tab / Shift-Tab / ←/→ / Enter / q / Esc / Ctrl-C) exercised by the unchanged tabbed-picker-tab-nav-keys + tabbed-picker-overflow tests which remain green. |

**Score:** 3/3 SC verified.

---

## Plan 04-04 Must-Haves (5/5 verified — labeled MH-01..MH-05 per the frontmatter `must_haves.truths` order)

| # | Must-Have | Status | Evidence |
|---|-----------|--------|----------|
| MH-01 | Phase 4 post-bundle minus Phase 3.1 post-bundle is strictly less than 10240 bytes (D4-16 phase-local gate) | VERIFIED | `BUNDLE-BASELINE.txt=173046`, `BUNDLE-POST.txt=177038` → delta = **+3992B** < 10240B (39% of budget). Confirmed in plan 04-04 SUMMARY commit `f07eda6`. |
| MH-02 | Aggregate v1.5 bundle growth (Phase 4 post minus `apps/ccaudit/scripts/bundle-baseline.txt`) stays under 15360 bytes (SC6 rolling-baseline) | VERIFIED | `apps/ccaudit/scripts/bundle-baseline.txt=170619` (rebased in Phase 3.1 Plan 05), `BUNDLE-POST.txt=177038` → aggregate delta = **+6419B** < 15360B (42% of budget). `node apps/ccaudit/scripts/bundle-size-check.mjs` exits 0. |
| MH-03 | `pnpm verify` exits 0 end-to-end (typecheck + lint + build + test + format:check) | VERIFIED | Confirmed green at plan 04-04 Task 1 execution time: 1417 tests pass, 178 files formatted cleanly by oxfmt. No source files touched between commit `f07eda6` and verification (git log between that commit and HEAD lists only `af99746 docs(04-04)` — documentation only). |
| MH-04 | `jq '.dependencies // {} \| length' apps/ccaudit/package.json` returns 0 — zero runtime deps invariant | VERIFIED | Live re-check at verification time: `jq` command returns `0`. `@clack/core`, `@clack/prompts`, `tinyglobby`, etc. remain devDependencies, bundled into `dist/`. |
| MH-05 | Phase 3 INV-S1..S6 + Phase 3.1 regression tests still pass unmodified | VERIFIED | `git diff 24d3c68..HEAD -- apps/ccaudit/src/__tests__/safety-invariants-tui-abort.test.ts` empty (INV-S2 unmodified). `pnpm verify` runs the full suite inside Task 1; it was green. Phase 3.1 regression tests (`tabbed-picker-overflow.test.ts`, `tabbed-picker-tab-nav-keys.test.ts`, `tabbed-picker-terminal-too-short.test.ts`) also unmodified in Phase 4 (they are consumers of the same Tabbed picker whose subclass behavior is additively extended, not changed). Human-verify smoke step 10 confirms INV-S2 holds on the live path (cancel writes no manifest). |

**Score:** 5/5 must-haves verified.

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/internal/src/token/` helpers | `formatTokensApprox`, `sumSelectionTokens` with in-source tests | VERIFIED | Plan 04-01 SUMMARY, commit `70eba64 feat(04-01)`. |
| `packages/terminal/src/tui/tabbed-picker.ts` | Live counter wired into footer + per-tab header, SIGWINCH handler (50ms throttle), sub-minimum banner | VERIFIED | Plan 04-02 SUMMARY, commit `5369898 feat(04-02)`. Greps: `SIGWINCH`, `_handleResize`, `renderTokenCounter` all present; "Terminal too small" string count = 4 (banner + test scaffolding). |
| `apps/ccaudit/src/__tests__/tabbed-picker-live-counter.test.ts` | Six D4-14 integration tests | VERIFIED | Commit `72a6bac test(04-03)`. Plan 04-03 SUMMARY enumerates cases. |
| `apps/ccaudit/src/__tests__/tabbed-picker-bust-parity.test.ts` | MH-04 picker-vs-bust parity test | VERIFIED | Commit `b31e484 test(04-03)`. `grep -c "MH-04"` in that file = 6 (≥ 1 required by plan 04-03). |
| `.planning/phases/04-live-token-counter/BUNDLE-BASELINE.txt` | Phase 3.1 post copied as Phase 4 baseline | VERIFIED | Contents: `173046`. Plan 04-04 SUMMARY. |
| `.planning/phases/04-live-token-counter/BUNDLE-POST.txt` | Phase 4 gzipped bundle size | VERIFIED | Contents: `177038`. Plan 04-04 SUMMARY. |
| Plan 04-01..04 SUMMARY files | All four present | VERIFIED | `ls .planning/phases/04-live-token-counter/` shows `04-01-…-SUMMARY.md`, `04-02-…-SUMMARY.md`, `04-03-…-SUMMARY.md`, `04-04-…-SUMMARY.md`. |

---

## Behavioral Spot-Checks (against ROADMAP SC and human-verify smoke)

| Behavior | Source | Result | Status |
|----------|--------|--------|--------|
| Footer updates on Space single-toggle | D4-14 case 1 test + human smoke step 4 | Footer reads `1 of M · ≈ Xk tokens saved` | PASS |
| `a` toggle-all scoped to active tab | D4-14 case 2 test + human smoke step 5; D3.1-15 scope invariant | Global count jumps by active tab's M; other tabs' subtotals unchanged | PASS |
| Cross-tab subtotal accuracy | D4-14 case 3 test + human smoke step 6 | Each tab header shows its own `(N/M · ≈ Xk)`; footer sums globally | PASS |
| SIGWINCH re-render preserves cursor | D4-14 case 4 test + human smoke step 7 | Clean re-render ~100ms; cursor, selection, active tab intact | PASS |
| Sub-minimum terminal banner (D4-08) | D4-14 case 5 test + human smoke step 8 | Renders `⚠ Terminal too small (need ≥14r × 60c)…`; Space/a are no-ops | PASS |
| ASCII fallback `≈` → `~` (D4-11) | D4-14 case 6 test + human smoke step 11 | `CCAUDIT_ASCII_ONLY=1` renders `~` in footer AND per-tab header | PASS |
| Picker-footer ↔ post-bust parity (MH-04) | `tabbed-picker-bust-parity.test.ts` | `|pickerKey − freedKey| ≤ 1` | PASS |
| Cancel → zero manifests (INV-S2 live) | Human smoke step 10 | `q` exits 0; no new file under `~/.claude/ccaudit/manifests/` | PASS |
| Bundle gates green | Plan 04-04 Task 1 | Phase-local +3992B; aggregate +6419B; both scripts exit 0 | PASS |
| Zero runtime deps | `jq` live | `0` | PASS |

---

## Requirements Coverage

Phase 4 has **no assigned requirement IDs** in `.planning/REQUIREMENTS.md` (line 111: *"Phase 4 (Live token counter): 0 — polish on prior TUI behavior"*). TUI-01 and TUI-04 were locked Complete by Phase 2 and refined by Phase 3.1; Phase 4's live counter is polish on that UX and does not map additional IDs.

No orphaned requirements detected.

---

## Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `tabbed-picker.ts` | `CCAUDIT_TEST_RESIZE` / `CCAUDIT_TEST_RESIZE_ROWS` env seam | INFO | Test-only escape hatch, plan-authorized in Plan 04-03 because Node child processes with piped stdio never emit real `resize` events. Mirrors Phase 3.1's `CCAUDIT_TEST_STDOUT_ROWS` and Phase 3's `CCAUDIT_FORCE_TTY`. Not documented in `--help`. Not a defect. |

No blockers or warnings.

---

## Deviations from Plan

Plan 04-04 executed exactly as written:

- Phase-local and aggregate bundle gates passed on first measurement (no retry loop).
- `pnpm verify` was green on first run (no format drift, no test regressions).
- Zero-runtime-deps sanity was already true.
- Human-verify smoke approved on first pass (no gap-closure plan needed).

Inherited from Phase 3.1: the aggregate v1.5 gate uses a **rolling baseline** (`apps/ccaudit/scripts/bundle-baseline.txt` was rebased to 170619 in Phase 3.1 Plan 05, commit `c2bbebd`). Under the literal SC6 wording of Phase 2 ("+<15 KB total for v1.5 since the pre-v1.5 baseline"), the aggregate growth since the pre-v1.5 baseline 151289B is now **25749B**, exceeding 15360B. The rolling-baseline interpretation authorized in Phase 3.1 remains in force; flagged here for milestone-level awareness before v1.5 ships. **Not a Phase 4 regression** — the gate in effect at Phase 4 execution time is green.

---

## Gaps Summary

No blocking gaps. All 3 ROADMAP success criteria verified; all 5 plan 04-04 must-haves verified; all required artifacts present; `pnpm verify` was green at plan 04-04 Task 1 time and no source has changed since; zero-runtime-deps invariant intact; INV-S2 unmodified and preserved on the live path; human-verify checkpoint approved on a real terminal.

One previously-surfaced milestone-level concern (rolling-baseline aggregate budget interpretation, inherited from Phase 3.1) — does not block Phase 4 pass but remains on the v1.5 release checklist.

---

_Verified: 2026-04-18T22:30:00Z_
_Verifier: Claude (inline goal-backward review)_
