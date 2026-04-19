---
gsd_state_version: 1.0
milestone: v1.5
milestone_name: Interactive Archive
status: verifying
stopped_at: Completed 06-01-PLAN.md
last_updated: "2026-04-19T09:37:31.612Z"
last_activity: 2026-04-18
progress:
  total_phases: 10
  completed_phases: 6
  total_plans: 30
  completed_plans: 27
  percent: 90
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-15)

**Core value:** Quantify and reversibly cull Claude Code's ghost inventory without ever destroying user data. Nothing deletes; everything restores.
**Current focus:** Phase 4 — Live token counter (complete; verification passed 2026-04-18)

## Current Position

Phase: 4
Plan: Complete (4/4)
Status: Phase complete — VERIFICATION passed (3/3 SC + 5/5 must-haves). Human-verify approved on real terminal.
Last activity: 2026-04-18

Progress: [██████████] 100% (Phase 4)

Next: Phase 5 (Keyboard model completeness) — depends on Phase 3.1 (satisfied).

## Performance Metrics

**Velocity:**

- Total plans completed: 5
- Average duration: —
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 03.2 | 5 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 02-tui-picker-v0.5 P03 | 240 | 3 tasks | 3 files |
| Phase 02-tui-picker-v0.5 P04 | 75 | 4 tasks | 4 files |
| Phase 03 P01 | 10 | 2 tasks | 2 files |
| Phase 03 P02 | 35 | 1 tasks | 6 files |
| Phase 03.1-tabbed-category-view P01-dep-posture-and-baseline | 2 | 2 tasks | 4 files |
| Phase 03.1-tabbed-category-view P02-tabbed-picker-subclass | 11 | 3 tasks | 3 files |
| Phase 03.1-tabbed-category-view P03-adapter-and-cli-wiring | 4 min | 3 tasks | 3 files |
| Phase 03.1-tabbed-category-view P04-regression-and-invariant-tests | 16 min | 6 tasks tasks | 6 files files |
| Phase 03.2 P04 | 7min | 1 tasks | 3 files |
| Phase 03.2 P05 | 27 min | 5 tasks | 6 files |
| Phase 04 P03 | 15min | 3 tasks | 3 files |
| Phase 05 P02 | 25min | 2 tasks | 1 files |
| Phase 05 P03 | ~20min | 2 tasks | 2 files |
| Phase 05 P04 | 10min | 2 tasks | 1 files |
| Phase 06 P01 | 15 | 3 tasks | 8 files |

## Accumulated Context

### Roadmap Evolution

- 2026-04-16: Phase 3.1 inserted after Phase 3 — Tabbed category view (URGENT). Phase 2 manual QA surfaced a long-list viewport-overflow bug: `@clack/prompts.groupMultiselect` renders all options inline with no windowing; cursor disappears above viewport when the list exceeds terminal rows. Root cause verified via clack source inspection — `GroupMultiSelectOptions` does not accept `maxItems`. Fix requires a custom `@clack/core.MultiSelectPrompt` subclass (which Phase 4 already planned). Phase 3.1 pulls that subclass forward and adds a tabbed category view on top. Phase 4 scope reduced to ~0.5d (just add live-counter hook). Phase 5 scope trimmed ~25% (group-collapse `g`/`G` obsoleted by tabs). Net milestone cost: roughly neutral.

### Decisions

Decisions are logged in PROJECT.md Key Decisions table (D1–D8 + H1–H4).
Recent decisions affecting current work:

- D1 (Phase 1): Safety architecture = Approach A (filter after verify). Smallest delta; reuses full-set hash; preserves v1.4.0 provenance.
- D2 (Phase 2): TUI library = `@clack/prompts` as devDep + bundled. Zero-runtime-deps invariant holds.
- D3 (Phase 8): v1.5 ships both archive TUI and restore TUI. Phase 8 is the core ship gate.
- D7 (Phase 2): Auto-open picker prompt after `ghost` scan on TTY, +0.5 ED scope adjustment.
- [Phase 02-tui-picker-v0.5]: D-20: skipCeremony=true on runBust bypasses readline ceremony when TUI confirmation already obtained
- [Phase 02-tui-picker-v0.5]: D-26: hash-mismatch during interactive bust is terminal in v0.5 — stderr + exit 0, no re-scan prompt
- [Phase 02-tui-picker-v0.5]: D-21: back-to-picker (ConfirmationOutcome 'back') deferred to Phase 5; v0.5 ConfirmationOutcome is proceed|cancel only
- [Phase 02-tui-picker-v0.5]: D-22: promptAutoOpen uses exactly 'Open interactive picker?' as confirm message; [y/N] rendered by clack
- [Phase 02-tui-picker-v0.5]: D-23: full 6-flag suppression matrix passed to checkTuiGuards(isExplicitInteractive=false)
- [Phase 02-tui-picker-v0.5]: D-24: 'open' outcome calls runInteractiveGhostFlow as 2nd call site; 'decline' exits 0 normally
- [Phase 02-tui-picker-v0.5]: D-31: smoke tests cover only non-TTY guards; full picker E2E deferred to Phase 3
- [Phase 03]: CCAUDIT_FORCE_TTY is env-only test hook at two isTty sites in ghost.ts; absent from --help; runCcauditGhost returns live ChildProcess for SIGINT tests
- [Phase 03]: Rule 1 (auto-fix): disableMcpTransactional used atomicWriteJson (JSON.stringify) which reformatted all bytes including unselected server values. Fixed with surgical text patcher (patchMcpConfigText) that preserves byte identity for flat-schema and global-scope mutations.
- [Phase 03]: atomicWriteText added as a required dep to BustDeps; makeDeps test helper updated accordingly. Project-scope mutations still fall back to atomicWriteJson (text surgery for nested paths deferred as out-of-scope for this plan).
- [Phase 03]: patchMcpConfigText exported from bust.ts for in-source unit testing. It returns null on malformed input, triggering atomicWriteJson fallback.
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P01]: Baseline captured AFTER @clack/core pin — delta gate in Plan 05 measures only TabbedGhostPicker growth, not dep-posture bump itself.
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P01]: @clack/core pinned as catalog devDep (D3.1-13). Zero-runtime-deps invariant holds: apps/ccaudit dependencies still empty.
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P02]: TabbedGhostPicker extends @clack/core.MultiSelectPrompt with pure _viewport.ts and _tab-bar.ts helpers; viewport formula lives once in _viewport.ts; action methods extracted public (nextTab, toggleAllInActiveTab, etc.) for in-source unit testing; key-handler base class auto-renders so no explicit render calls needed.
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P02]: 'a' scoped to active tab only (D3.1-15); cross-tab selection as single Set<string>; renderTokenCounter: () => string stub slotted for Phase 4 handshake with zero layout churn.
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P03]: select-ghosts.ts is a thin adapter over openTabbedPicker; ghost.ts byte-unchanged; CATEGORY_ORDER/CATEGORY_LABEL/formatRowLabel consolidated to select-ghosts.ts single source
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P03]: D3.1-16 terminal-too-short gate implemented as process.exit(1) at adapter entry; integration coverage deferred to Plan 04 per plan design
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P03]: _clack test injection replaced by _picker: PickerDep seam; no production caller used _clack (grep-verified); tests rewritten atomically
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P04]: CCAUDIT_TEST_STDOUT_ROWS env-only seam wired into select-ghosts.ts's D3.1-16 gate because Node does NOT honour LINES for non-TTY stdout; regex-guarded to numeric input, mirrors Phase 3 CCAUDIT_FORCE_TTY pattern
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P04]: After interactive bust completes, tests MUST call child.stdin.end() — @clack/prompts leaves a keypress listener registered that pins the event loop; without end() the subprocess hangs indefinitely until SIGKILL
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P04]: Cross-tab persistence test placed in-source (tabbed-picker.ts) not in apps/ccaudit/__tests__/ — plan explicitly preferred in-source; the class's public action methods (nextTab, prevTab, toggleCurrentRow, cursorDown) are the natural seam, no __testDispatchKey seam was required
- [Phase 03.1-tabbed-category-view]: [Phase 03.1 P04]: Phase 3 INV-S2 + Phase 2 interactive-smoke tests byte-unchanged under the new TabbedGhostPicker class — the safety contract survives the Phase 3.1 rewrite
- [Phase 03.2]: Surface detectClaudeProcesses + walkParentChain at @ccaudit/internal barrel — Rule 3 prereq for plan 04 entry preflight wiring
- [Phase 03.2]: SC5b selectedItems identity preservation via single const + while-loop wrapping runBust — no picker re-open, no selection loss across retries
- [Phase 03.2]: Phase 3.1 tabbed-picker-terminal-too-short.test.ts now requires buildFakePs + skipIf(win32) because entry preflight runs ps BEFORE the D3.1-16 height gate inside selectGhosts
- [Phase 03.2]: Plan 05: Module-scope buildWrappedProcessDeps helper with per-layer counters (entry vs bust) — deviation from plan text's single-counter design, required to exercise both retry layers in SC5b integration test
- [Phase 03.2]: Plan 05: @clack/prompts.confirm resolves on 'y'/'n' character alone — NEVER send '\r' afterward (leaks Enter to next prompt, commits default value); drive subprocess integration tests with marker-counting on ◆ active-prompt glyph, not full-line phrase regex (clack repaints on every key input)
- [Phase 05]: Plan 04 Outcome A: InventoryItem.framework field is live; implemented PickerRow sub-headers + Space group-toggle (D5-17..D5-20)
- [Phase 06]: configRefs length >= 1 on every MCP item (D6-02): avoids tri-state; protection annotation attached to ALL members of partially-used frameworks (not just ghosts) so picker dims whole group; canonical reason string emitted by scanner (single source of truth) for picker verbatim read.

### Pending Todos

None yet.

### Blockers/Concerns

None yet. Phase 1's primary risk (`computeGhostHash` refactor drift) is mitigated by a checked-in golden fixture per design doc §8 Phase 1.

## Session Continuity

Last session: 2026-04-19T09:30:19.179Z
Stopped at: Completed 06-01-PLAN.md
Resume file: None
