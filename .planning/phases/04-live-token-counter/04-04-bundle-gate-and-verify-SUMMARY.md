---
phase: 04-live-token-counter
plan: 04
subsystem: bundle-gate-and-verify
tags: [bundle-gate, pnpm-verify, zero-deps, human-verify, inv-s2, smoke-test]
status: completed
completed: 2026-04-18
commits:
  - f07eda6
requires:
  - 04-03
provides:
  - .planning/phases/04-live-token-counter/BUNDLE-BASELINE.txt (173046 bytes — Phase 3.1 post copied in)
  - .planning/phases/04-live-token-counter/BUNDLE-POST.txt (177038 bytes — Phase 4 post)
affects:
  - apps/ccaudit/scripts/bundle-baseline.txt (read only — aggregate gate source)
tech-stack:
  added: []
  patterns: [phase-local-bundle-gate, aggregate-bundle-gate, human-verify-checkpoint]
key-files:
  created:
    - .planning/phases/04-live-token-counter/BUNDLE-BASELINE.txt
    - .planning/phases/04-live-token-counter/BUNDLE-POST.txt
  modified: []
decisions:
  - "Phase-local delta measured against Phase 3.1 post (173046B). Phase 4 post = 177038B → delta = 3992B (39% of 10240B budget). Well inside the D4-16 gate."
  - "Aggregate v1.5 delta measured against apps/ccaudit/scripts/bundle-baseline.txt (170619B, rebased during Phase 3.1 Plan 05). Phase 4 post = 177038B → aggregate delta = 6419B (42% of 15360B budget). SC6 holds under the rolling-baseline interpretation locked in Phase 3.1."
  - "Human-verify checkpoint approved on 2026-04-18 by the user on a real terminal. All 10 smoke-test steps behaved per plan. No gap-closure plan needed."
metrics:
  duration: ~20min autonomous gates + human smoke test
  tasks: 2 (1 auto gate task + 1 human-verify checkpoint)
  files: 2
  tests_added: 0
---

# Phase 04 Plan 04: Bundle gate and verify — Summary

One-liner: Phase 4 ships within both bundle gates (+3992B phase-local, +6419B aggregate), zero-runtime-deps invariant intact, `pnpm verify` green with 1417 tests, and a human has confirmed the live-counter / resize / sub-minimum banner / ASCII fallback / INV-S2 behavior on a real terminal.

## What shipped

### Autonomous gates (Task 1)

| Gate | Measurement | Budget | Status |
|------|-------------|--------|--------|
| Phase-local bundle delta (vs Phase 3.1 post 173046B) | +3992B | <10240B (D4-16) | PASS (39% used) |
| Aggregate v1.5 bundle delta (vs `bundle-baseline.txt` 170619B) | +6419B | <15360B (SC6) | PASS (42% used) |
| `pnpm verify` | typecheck + lint + build + test + format:check | exit 0 | PASS — 1417 tests green |
| Zero-runtime-deps invariant | `jq '.dependencies // {} \| length' apps/ccaudit/package.json` | `0` | PASS |
| `oxfmt --check .` | formatting | clean | PASS |
| Phase 3 INV-S1..S6 + Phase 3.1 regressions | re-run inside `pnpm verify` | all green | PASS |

Artifacts:
- `.planning/phases/04-live-token-counter/BUNDLE-BASELINE.txt` → `173046\n` (verbatim copy of Phase 3.1 post)
- `.planning/phases/04-live-token-counter/BUNDLE-POST.txt` → `177038\n` (Phase 4 gzipped `dist/index.js`)

Commit: `f07eda6 chore(04-04): capture Phase 4 bundle-size artifacts and verify gates`.

### Human-verify checkpoint (Task 2)

The user ran the 10-step smoke test on their real terminal emulator on 2026-04-18 and returned **approved**. Every step behaved per the plan:

1. Fresh `pnpm -F ccaudit build` — clean.
2. `node apps/ccaudit/dist/index.js ghost --interactive` opened the tabbed picker.
3. Initial footer read `0 of M selected across all tabs` (no `tokens saved` suffix at zero selection).
4. Single `Space` → footer updated to `1 of M selected across all tabs · ≈ Xk tokens saved`; active tab header picked up `{LABEL} (1/M · ≈ Xk)`.
5. `a` → all rows in active tab selected; global count and tab subtotal both jumped consistently.
6. `Tab` to another non-empty category → header shows its own `(N/M)`; global footer correctly sums across tabs.
7. Resize narrower/shorter above the 14r × 60c floor → clean re-render within ~100ms; selection / active tab / cursor preserved.
8. Resize below 14 rows → collapsed to the `⚠ Terminal too small (need ≥14r × 60c). Resize to continue or press q.` banner; Space and `a` were no-ops.
9. Resize back up → full picker returned with state preserved.
10. `q` → exit 0, no new file under `~/.claude/ccaudit/manifests/` (INV-S2 preserved on the live path).
11. `CCAUDIT_ASCII_ONLY=1` rerun → `≈` rendered as `~` in both footer and per-tab header.

Outcome: all live-UX D4-08/D4-11/D4-12/D4-14/D4-16 behaviors confirmed. No mismatches, no gap-closure plan required.

## Verification (success criteria for this plan)

- [x] `pnpm verify` exits 0. (Confirmed inside Task 1; 1417 tests pass.)
- [x] `node apps/ccaudit/scripts/bundle-size-check.mjs` exits 0 (aggregate gate green at +6419B < 15360B).
- [x] Phase-local bundle delta < 10240 bytes (+3992B).
- [x] `jq '.dependencies // {} | length' apps/ccaudit/package.json` returns `0`.
- [x] Human-verify checkpoint returned **approved** on a real terminal (2026-04-18).

## Deviations from Plan

None — plan executed exactly as written. Phase-local and aggregate gates both green on first measurement; no retry / rebuild loop needed. Human-verify checkpoint approved without mismatches.

## Self-Check: PASSED

- `.planning/phases/04-live-token-counter/BUNDLE-BASELINE.txt` — FOUND (contents `173046`).
- `.planning/phases/04-live-token-counter/BUNDLE-POST.txt` — FOUND (contents `177038`).
- Commit `f07eda6 chore(04-04): capture Phase 4 bundle-size artifacts and verify gates` — FOUND in `git log`.
