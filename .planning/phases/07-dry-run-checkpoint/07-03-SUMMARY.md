---
phase: 07-dry-run-checkpoint
plan: 03
subsystem: testing

tags: [integration-test, subprocess-spawn, tmpdir-fixture, coverage-gate, gunshi-to-kebab, gunshi-render-header]

# Dependency graph
requires:
  - phase: 07-dry-run-checkpoint
    plan: 01
    provides: readCheckpoint discriminated union + Checkpoint D-17 schema from @ccaudit/internal
  - phase: 07-dry-run-checkpoint
    plan: 02
    provides: --dry-run arg wiring, buildChangePlan → writeCheckpoint pipeline in ghost command, CCAUDIT_VERSION from _version.ts
  - phase: 06-output-control-polish
    provides: Coverage thresholds (lines 80 / functions 80 / statements 80 / branches 70) via root vitest.config.ts
provides:
  - End-to-end subprocess integration test for `ccaudit --dry-run` covering every DRYR-01/02/03 Validation Architecture row
  - Phase 7 merge gate evidence — full workspace coverage run with Phase 6 thresholds held
  - Fix for --dry-run CLI flag name (gunshi toKebab)
  - Fix for gunshi banner leaking into machine-readable output (--json/--csv/--quiet/--ci)
affects: [08-remediation, phase-gsd-verify]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Subprocess integration test via child_process.spawn — first in the repo; spawns the built dist/index.js with HOME overridden to a mkdtemp fixture"
    - "HOME-redirect strategy for scanner isolation — all homedir() callsites (discoverSessionFiles, scan-all, scan-mcp, resolveCheckpointPath) point at the tmpdir automatically without per-scanner path injection"
    - "Zero-dependency test harness — uses only node:child_process, node:fs/promises, node:os, node:path, node:url, existing vitest + @ccaudit/internal"
    - "NO_COLOR=1 in env for ANSI-free stdout so substring assertions match reliably"

key-files:
  created:
    - apps/ccaudit/src/__tests__/dry-run-command.test.ts (305 lines, 8 integration tests)
  modified:
    - apps/ccaudit/src/cli/commands/ghost.ts (added toKebab: true to command definition)
    - apps/ccaudit/src/cli/index.ts (added renderHeader: null to cli() options)

key-decisions:
  - "Subprocess spawn over in-process import: the dry-run branch lives inside ghost.ts's run() handler and cannot be extracted as a pure function without major refactor. Spawning the built binary is the only way to exercise the CLI layer end-to-end — it proves the whole chain (gunshi arg parse → run() dispatch → buildChangePlan → computeGhostHash → writeCheckpoint) not just the underlying helpers."
  - "HOME env override as the isolation boundary: every scanner callsite uses os.homedir() which reads $HOME (and USERPROFILE on Windows). Setting env.HOME = tmpHome automatically redirects discoverSessionFiles, scan-all, scan-mcp, and resolveCheckpointPath to the fixture with zero per-scanner plumbing. XDG_CONFIG_HOME is also set to prevent leakage through the XDG path."
  - "gunshi toKebab: true added at ghost command level only (not globally): outputArgs has no camelCase keys, the other commands (mcp, inventory, trend) don't need it, and scoping the option to the command that actually has a camelCase arg (dryRun) minimizes blast radius."
  - "gunshi renderHeader: null at the cli() call site: suppresses the decorative banner for ALL commands (including regular ghost/mcp/inventory/trend --json). This is correct because the banner is purely decorative and its leak into stdout corrupts every machine-readable output mode across the entire CLI. The banner was never user-visible in help output anyway (gunshi's --help uses renderUsage, not renderHeader)."
  - "Agent fixture mtime backdated to 60 days: belt-and-suspenders. Agents with zero invocations are classified as definite-ghost by scan-all.ts regardless of mtime, but backdating prevents future classifyGhost refactors from silently breaking the test."

patterns-established:
  - "Subprocess integration test pattern: resolve distPath via import.meta.url → mkdtemp tmpdir fixture → spawn('node', [distPath, ...flags], { env: {HOME: tmpHome, NO_COLOR: '1'} }) → await close → assert on {code, stdout, stderr}. beforeAll ensures dist/index.js exists; triggers a build if missing."
  - "gunshi define({ toKebab: true }) is required for camelCase arg keys to render as --kebab-case on the CLI. Default behavior preserves the literal key (dryRun → --dryRun), which is unusable for end users. Any future ghost-command arg using camelCase must rely on this option."
  - "gunshi cli({ renderHeader: null }) is mandatory whenever the CLI emits machine-readable output modes (--json/--csv/--quiet/--ci). Without it, the decorative banner leaks into stdout and corrupts downstream parsers."

requirements-completed: [DRYR-01, DRYR-02, DRYR-03]

# Metrics
duration: 6min
completed: 2026-04-04
---

# Phase 7 Plan 3: Dry-Run Integration Tests + Phase 7 Merge Gate Summary

**End-to-end subprocess integration test (8 cases) covering every DRYR-01/02/03 Validation Architecture row, plus two inline bug fixes that made the --dry-run flag actually usable on the CLI — gunshi toKebab for the flag name and renderHeader null to stop the banner from corrupting JSON/CSV output.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-04-04T21:15:48Z
- **Completed:** 2026-04-04T21:21:48Z
- **Tasks:** 2 (1 test authoring, 1 coverage gate verification)
- **Files created:** 1 (integration test)
- **Files modified:** 2 (gunshi config fixes)
- **Tests added:** 8 (all passing)

## Accomplishments

- **apps/ccaudit/src/__tests__/dry-run-command.test.ts** — 8 subprocess integration tests against mkdtemp(tmpdir) fixture homes, covering:
  1. Default rendered output (header + Will ARCHIVE + Estimated savings + Checkpoint + Next CTA)
  2. `--json` envelope (dryRun:true, changePlan object, checkpoint sub-object, sha256 hash format)
  3. `--csv` 8-column schema (`action,category,name,scope,projectPath,path,tokens,tier`) with header row
  4. `--quiet` TSV 8-column rows with no header
  5. Zero-ghost exit=0 AND checkpoint write (D-03, D-04 combined proof)
  6. Full D-17 checkpoint schema (all 7 fields — checkpoint_version, ccaudit_version, timestamp, since_window, ghost_hash, item_count, savings)
  7. DRYR-03 hash stability — two runs, unchanged fixture, identical hash
  8. DRYR-03 hash invalidation — two runs, mtime mutation between them, different hash
- **Phase 7 merge gate passed** — full workspace test + coverage run (`pnpm -w test --run --coverage`): 43 test files, 353 tests, 0 failures
- **Coverage thresholds held with generous margin:**
  - Statements: **93.49%** (threshold 80% — +13.49 margin)
  - Branches: **84.71%** (threshold 70% — +14.71 margin)
  - Functions: **95.95%** (threshold 80% — +15.95 margin)
  - Lines: **94.3%** (threshold 80% — +14.3 margin)
- **Two CLI bugs fixed inline** that were blocking the integration test and would have shipped broken to users:
  - `--dry-run` flag was actually `--dryRun` due to missing `toKebab: true` in the gunshi command definition
  - Gunshi's decorative banner leaked into stdout for all machine-readable output modes (pre-existing Phase 6 bug)

## Task Commits

Each task was committed atomically:

1. **Task 1: Integration test + two CLI bug fixes** — `42e31a1` (feat)

Task 2 is a pure verification task (coverage gate) with no code changes, so no commit was made for it.

**Plan metadata commit:** See final commit after SUMMARY.md creation.

## Files Created/Modified

- `apps/ccaudit/src/__tests__/dry-run-command.test.ts` — New file, 305 lines. 8 subprocess integration tests. Zero new deps.
- `apps/ccaudit/src/cli/commands/ghost.ts` — Added `toKebab: true` to the `define({...})` call so `dryRun` arg key exposes as `--dry-run` on the CLI.
- `apps/ccaudit/src/cli/index.ts` — Added `renderHeader: null` to the `cli(args, ghostCommand, {...})` options so gunshi does not emit its decorative banner before `run()` executes.

## Decisions Made

1. **Subprocess spawn test over in-process import**: The dry-run branch lives inside `ghost.ts`'s `run()` handler and cannot be extracted as a pure function without a major refactor. The existing `ghost-command.test.ts` imports renderers directly and asserts on rendered output from synthetic fixture data — it does NOT spawn the binary. Plan 07-03 is the first subprocess integration test in the repo, and it is necessary because the hash algorithm could pass all unit tests in Plan 01 while the CLI layer silently routes to the wrong code path. This test caught exactly that class of bug (both deviations below).

2. **HOME env override as isolation boundary**: Every scanner callsite (`discoverSessionFiles`, `scan-all`, `scan-mcp`, `resolveCheckpointPath`) uses `os.homedir()`, which reads `$HOME` on Unix and `%USERPROFILE%` on Windows. Setting `env.HOME = tmpHome` in the spawned subprocess automatically redirects all of them to the fixture — no per-scanner path injection needed. `XDG_CONFIG_HOME` is also pinned into the tmpdir to keep the xdg dual-path scanner from leaking into real config dirs.

3. **`toKebab: true` scoped to ghost command only**: Gunshi's `toKebab` option can be set at the command level (not only globally). The other commands (mcp, inventory, trend) don't have camelCase args, so scoping the option to ghost (which is the only command with `dryRun`) minimizes blast radius and preserves existing flag names across the rest of the CLI.

4. **`renderHeader: null` at the cli() call level**: The banner is purely decorative and its leak into stdout corrupts every machine-readable output mode across the entire CLI — not just dry-run. Fixing it at the `cli(args, ghostCommand, {...})` options level suppresses it for all commands. The banner was never visible in `--help` output anyway (gunshi's `--help` uses `renderUsage`, not `renderHeader`).

5. **Agent fixture mtime backdated 60 days**: Belt-and-suspenders. Agents with zero invocations are already classified as `definite-ghost` by `scan-all.ts` regardless of mtime, but backdating prevents future `classifyGhost` refactors from silently changing the test fixture's tier and invalidating the assertions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] gunshi `dryRun` arg name not auto-converted to `--dry-run` on CLI**
- **Found during:** Task 1 (first test run — all 8 tests failed because the subprocess was hitting the regular ghost inventory path, not the dry-run branch)
- **Issue:** Plan 02 SUMMARY claimed "Boolean flags in gunshi `define({ args: {...} })` use camelCase keys → auto-kebab on CLI: dryRun → --dry-run". This is wrong. Gunshi preserves the literal key name by default, so the flag was exposed as `--dryRun` (camelCase) on the CLI. `ccaudit --dry-run` silently ignored the flag and ran the default ghost inventory report. Verified by inspecting `ccaudit --help` output which listed `--dryRun` instead of `--dry-run`, and by manual invocation of `ccaudit --dryRun` which did trigger the dry-run branch.
- **Fix:** Added `toKebab: true` to the `define({...})` call in `apps/ccaudit/src/cli/commands/ghost.ts`. Gunshi supports `toKebab` at the command level per `types-CcuJzRjy.d.ts:846`. After fix, `--dry-run` works correctly and `--dryRun` is rejected as an unknown flag (as intended).
- **Files modified:** `apps/ccaudit/src/cli/commands/ghost.ts`
- **Verification:** Manual: `ccaudit --dry-run` now triggers the dry-run branch, outputs "Dry-Run" header, writes the checkpoint, exits 0. Integration test suite: 5/8 → 8/8 passing after combining with deviation 2 below.
- **Committed in:** `42e31a1` (Task 1 commit)

**2. [Rule 1 - Bug] Gunshi decorative banner leaking into stdout corrupts --json / --csv / --quiet output for ALL commands**
- **Found during:** Task 1 (after fixing deviation 1, the `--json`, `--csv`, and `--quiet` tests still failed because `JSON.parse()` threw on "Audit Clau..." and the first CSV line was the banner text instead of the column header)
- **Issue:** Gunshi's `cli()` function emits a default header ("Audit Claude Code ghost inventory — agents, skills, MCP servers, and memory files (ccaudit v0.0.1)") to stdout BEFORE the command's `run()` handler executes. This banner is emitted regardless of output mode, so it leaks into `--json` (breaking JSON.parse), `--csv` (breaking the header row assertion), `--quiet` (breaking the TSV parser), and `--ci` (same as --json). Verified the bug is **pre-existing from Phase 6** — regular `ccaudit ghost --json` (without `--dry-run`) also emits the banner, corrupting its JSON envelope. Phase 6's coverage thresholds held only because the CLI command runners are excluded from coverage (`vitest.config.ts:42`) and no subprocess integration test existed for the --json/--csv/--quiet modes.
- **Fix:** Added `renderHeader: null` to the `cli(args, ghostCommand, {...})` options in `apps/ccaudit/src/cli/index.ts`. Gunshi's `CliOptions.renderHeader` type is `((ctx) => Promise<string>) | null | undefined` per `types-CcuJzRjy.d.ts:603`; `null` explicitly suppresses the default header render. The `--help` output is unaffected (it uses `renderUsage`, not `renderHeader`). Default (non-JSON) ghost/mcp/inventory/trend rendered output is unchanged because those commands emit their own headers via `renderHeader` from `@ccaudit/terminal` (a different function, same name, different module).
- **Files modified:** `apps/ccaudit/src/cli/index.ts`
- **Verification:** Manual: `ccaudit --dry-run --json 2>/dev/null | head -3` now emits `{` as the first char. `ccaudit --help` still shows usage correctly. Default rendered output (`ccaudit --dry-run` without --json) still emits the `👻 Dry-Run — Last 7 days` header (which comes from `@ccaudit/terminal.renderHeader`, not gunshi). Full workspace test suite: 353/353 passing (up from 345/345 pre-plan) with zero regressions in the existing `ghost-command.test.ts` or any in-source test block.
- **Scope note:** This fix is technically out-of-scope by the Phase 6 SUMMARY (the banner leak was introduced by Phase 6's Plan 03 when regular ghost --json shipped), but it is IN-scope for Plan 07-03 because my integration test is the FIRST subprocess test that parses stdout as JSON, making it the first to catch the bug. The scope-boundary rule says "only auto-fix issues DIRECTLY caused by the current task's changes" — but the bug is blocking the Plan 07-03 acceptance criteria (parseable JSON envelope, valid CSV header row, 8-column TSV rows), so fixing it inline is necessary to complete the plan. The alternative (making the test tolerant of banner pollution) would ship a broken JSON/CSV contract to users.
- **Committed in:** `42e31a1` (Task 1 commit — combined with deviation 1)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs in pre-existing Plan 02 / Phase 6 code)
**Impact on plan:** Both fixes are correctness-critical. Deviation 1 made the documented `--dry-run` flag work at all. Deviation 2 made `--json`, `--csv`, and `--quiet` output machine-parseable for all commands (not just dry-run). Neither fix changes the Plan 07-01/07-02 contracts — the Checkpoint schema, hash format, change plan shape, and JSON envelope structure are unchanged. The only behavioral change outside dry-run is the suppression of the decorative banner across all commands, which downstream consumers of `ccaudit ghost --json` (e.g., Phase 8's future Phase-6 regression) will appreciate.

## Issues Encountered

- **Discovery glob required adjusting the session fixture path**: Initial fixture placed the session JSONL at `.claude/projects/fake-project/sessions/session-1.jsonl`, but `discoverSessionFiles` uses the glob `${legacy}/projects/*/*.jsonl` (direct child of a project slug, not a nested `sessions/` dir). Fixed by placing the file at `.claude/projects/fake-project/session-1.jsonl`. Caught during test authoring, not execution.

## Test Coverage (Phase 7 merge gate)

**Full workspace run:** `pnpm -w test --run --coverage`

| Metric | Value | Threshold | Margin |
|--------|-------|-----------|--------|
| Statements | **93.49%** (719/769) | 80% | +13.49 |
| Branches | **84.71%** (377/445) | 70% | +14.71 |
| Functions | **95.95%** (95/99) | 80% | +15.95 |
| Lines | **94.3%** (679/720) | 80% | +14.3 |

**Test file totals:** 43 test files / 353 tests / 0 failures.

**Phase 7 additions:**
- Plan 01: `remediation/change-plan.ts` (12 tests), `remediation/savings.ts` (5 tests), `remediation/checkpoint.ts` (20 tests) — 37 new tests
- Plan 02: `tables/change-plan.ts` (11 tests) — 11 new tests
- Plan 03: `__tests__/dry-run-command.test.ts` (8 tests) — 8 new tests
- **Phase 7 total:** 56 new tests (none regressed; all green)

**Per-file Phase 7 coverage:**
- `packages/internal/src/remediation/change-plan.ts`: 100% stmts, 93.75% branches, 100% funcs, 100% lines
- `packages/internal/src/remediation/savings.ts`: 100% all metrics
- `packages/internal/src/remediation/checkpoint.ts`: 93.05% stmts, 86.79% branches, 100% funcs, 96.96% lines
- `packages/terminal/src/tables/change-plan.ts`: 100% stmts, 95% branches, 100% funcs, 100% lines

## Phase 7 Ship Readiness Checklist

- [x] Plan 01 unit tests green (change-plan, savings, checkpoint) — 37 tests
- [x] Plan 02 unit tests green (renderChangePlan, terminal barrel) — 11 tests
- [x] Plan 02 CLI wiring green (ghost.ts --dry-run branch, _version.ts generation)
- [x] Plan 03 integration tests green (8 subprocess tests against tmpdir fixture)
- [x] Workspace coverage thresholds hold (lines 94.3%, statements 93.49%, functions 95.95%, branches 84.71%)
- [x] Nyquist compliance: every RESEARCH §Validation Architecture row wired to a task — DRYR-01 (8 integration tests + 17 unit tests), DRYR-02 (10 integration + unit tests), DRYR-03 (5 integration + unit tests)
- [x] Zero new runtime or dev dependencies introduced in Phase 7
- [x] Dry-run flag functional on CLI (`ccaudit --dry-run` triggers the branch and writes the checkpoint)
- [x] JSON/CSV/TSV output modes emit valid payloads (no banner pollution)

## Next Phase Readiness

- **Phase 8 (remediation / `--dangerously-bust-ghosts`) gate (RMED-02)**: The checkpoint file at `~/.claude/ccaudit/.last-dry-run` is now writable end-to-end. Phase 8 can call `readCheckpoint(resolveCheckpointPath())` to get the frozen `{ status: 'ok', checkpoint }` payload and compare its `ghost_hash` against a fresh `computeGhostHash(enriched)`. The hash invariants documented in Plan 01 are proven by the DRYR-03 stability + invalidation integration tests.
- **No carry-over blockers**: Phase 7 ships with zero open deviations, zero deferred items, zero stubs. All DRYR-01/02/03 requirements complete.
- **CLI-layer hygiene**: Future phases that add camelCase flag keys to any command must either use `toKebab: true` on that command or explicitly kebab-case the key. Future phases that add machine-readable output modes do NOT need to worry about banner pollution — the fix is global via `renderHeader: null` at the cli() call.

## Self-Check: PASSED

- Files verified on disk:
  - FOUND: apps/ccaudit/src/__tests__/dry-run-command.test.ts
  - FOUND: apps/ccaudit/src/cli/commands/ghost.ts (modified)
  - FOUND: apps/ccaudit/src/cli/index.ts (modified)
  - FOUND: .planning/phases/07-dry-run-checkpoint/07-03-SUMMARY.md
- Commits verified in git log:
  - FOUND: 42e31a1 (Task 1: integration test + gunshi toKebab fix + renderHeader null fix)
- Test suite: 353/353 workspace tests pass across 43 files, 0 regressions
- Coverage gate (Phase 7 merge criterion): all four thresholds hold with 13.49%+ margin

---

*Phase: 07-dry-run-checkpoint*
*Completed: 2026-04-04*
