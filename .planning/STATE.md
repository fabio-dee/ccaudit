---
gsd_state_version: 1.0
milestone: v1.5
milestone_name: Interactive Archive
status: verifying
stopped_at: Completed 03-02-mcp-byte-preservation-PLAN.md
last_updated: "2026-04-16T06:22:23.623Z"
last_activity: 2026-04-16
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 0
  completed_plans: 2
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-15)

**Core value:** Quantify and reversibly cull Claude Code's ghost inventory without ever destroying user data. Nothing deletes; everything restores.
**Current focus:** Phase 1 — Selection plumbing

## Current Position

Phase: 1 (Selection plumbing) — EXECUTING
Plan: 3 of 3
Status: Phase complete — ready for verification
Last activity: 2026-04-16

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 02-tui-picker-v0.5 P03 | 240 | 3 tasks | 3 files |
| Phase 02-tui-picker-v0.5 P04 | 75 | 4 tasks | 4 files |
| Phase 03 P01 | 10 | 2 tasks | 2 files |
| Phase 03 P02 | 35 | 1 tasks | 6 files |

## Accumulated Context

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

### Pending Todos

None yet.

### Blockers/Concerns

None yet. Phase 1's primary risk (`computeGhostHash` refactor drift) is mitigated by a checked-in golden fixture per design doc §8 Phase 1.

## Session Continuity

Last session: 2026-04-16T06:22:23.621Z
Stopped at: Completed 03-02-mcp-byte-preservation-PLAN.md
Resume file: None
