---
phase: 07-dry-run-checkpoint
plan: 01
subsystem: remediation

tags: [sha256, crypto, atomic-write, in-source-vitest, promise-cache, change-plan, checkpoint]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    provides: ScanResult/InventoryItem from scanAll, tier classification
  - phase: 04-token-cost-attribution
    provides: TokenCostResult from enrichScanResults, token estimate shape
  - phase: 05-report-cli-commands
    provides: classifyRecommendation archive/monitor/keep mapping (Phase 5 D-12)
provides:
  - Pure buildChangePlan(enriched) filter that groups items into archive/disable/flag tiers per D-07/D-11a
  - calculateDryRunSavings(plan) sum of archive + disable tokens (excludes flag tier; D-08)
  - computeGhostHash(enriched, statFn?) deterministic SHA-256 over archive-eligible inventory (D-10 through D-16)
  - resolveCheckpointPath() -> ~/.claude/ccaudit/.last-dry-run (D-18)
  - writeCheckpoint(cp, targetPath) atomic tmp-then-rename with 0o700 dir + 0o600 file (D-19)
  - readCheckpoint(targetPath) discriminated union result (ok/missing/parse-error/unknown-version/schema-mismatch) for Phase 8 gate (DRYR-03)
  - Checkpoint / ChangePlan / ReadCheckpointResult TypeScript types exported via @ccaudit/internal barrel
affects: [07-dry-run-checkpoint-plan-02, 07-dry-run-checkpoint-plan-03, 08-remediation, phase-8-RMED-02-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure-function change-plan builder (zero I/O) delegating savings math via one-way type-only import"
    - "Promise-valued Map<string, Promise<number>> cache for async memoization under Promise.all parallelization"
    - "Atomic tmp-then-rename file write using process.pid suffix"
    - "Discriminated-union result type for never-throw read APIs"
    - "StatFn injection parameter for test observability of cache behavior (Vitest spyOn limitation workaround)"
    - "String.localeCompare with 'en-US-POSIX' locale for cross-platform-stable sort ordering in hash canonicalization"

key-files:
  created:
    - packages/internal/src/remediation/change-plan.ts (222 lines)
    - packages/internal/src/remediation/savings.ts (80 lines)
    - packages/internal/src/remediation/checkpoint.ts (608 lines)
    - packages/internal/src/remediation/index.ts (10 lines)
  modified:
    - packages/internal/src/index.ts (appended remediation module exports)

key-decisions:
  - "computeGhostHash accepts optional StatFn injection to verify D-14 cache in tests (vi.spyOn cannot intercept built-in node:fs/promises ESM exports — module namespace non-configurable)"
  - "MCP sourcePath cache stores Promise<number> not number — synchronous cache check under Promise.all would miss and stat all N records concurrently; storing the in-flight Promise deduplicates properly (Rule 1 bug fix vs naive raw-value cache)"
  - "Savings import as type-only in savings.ts -> change-plan.ts to avoid runtime circular between change-plan.ts and savings.ts"
  - "Atomic write tmp path uses process.pid suffix (plan spec) — not randomUUID — matching Phase 8's future reuse contract on ~/.claude.json"

patterns-established:
  - "Async memoization via Promise-valued Map: cache the in-flight Promise, not the resolved value, so concurrent consumers share a single underlying I/O call"
  - "Dependency injection for I/O in otherwise-pure functions: default parameter = real impl, test override = stub — avoids mocking ESM built-ins"
  - "Never-throw read APIs: return discriminated union { status } for expected failure modes (missing/parse-error/version/schema) and propagate only truly unexpected errors (EACCES etc.)"
  - "Tests imported with renamed bindings to avoid shadow conflicts: { writeFile: wf, mkdir: mk, stat: statFn } at test-block level"

requirements-completed: [DRYR-01, DRYR-02, DRYR-03]

# Metrics
duration: 14min
completed: 2026-04-04
---

# Phase 7 Plan 1: Remediation Module Foundation Summary

**Pure-function change-plan builder, savings calculator, deterministic SHA-256 ghost-inventory hash, and atomic checkpoint read/write primitives that Phase 8's RMED-02 three-stage gate will consume.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-04-04T20:47:39Z
- **Completed:** 2026-04-04T21:01:33Z
- **Tasks:** 3 (all autonomous)
- **Files created:** 4
- **Files modified:** 1
- **Lines added:** ~920 (including in-source tests)

## Accomplishments

- **buildChangePlan**: pure filter function grouping enriched scan results into archive (definite-ghost agents+skills), disable (non-used MCP — widened per D-11a), and flag (non-used memory) tiers with canonical counts shape matching D-17 item_count
- **calculateDryRunSavings**: honest savings math — sums archive + disable token estimates only, excludes flag tier because memory files still load
- **computeGhostHash**: deterministic SHA-256 digest over the exact set Phase 8 will mutate, with per-sourcePath MCP stat cache (D-14), cross-platform sort stability via `String.localeCompare(..., 'en-US-POSIX')`, stable JSON key order via insertion-order literal construction, and `sha256:` literal prefix (D-12)
- **writeCheckpoint**: atomic tmp-then-rename write with 0o700 dir / 0o600 file modes, errors propagated unchanged for caller to convert to exit code 2 (D-20)
- **readCheckpoint**: discriminated union result covering ok/missing/parse-error/unknown-version/schema-mismatch — never throws for the four expected failure modes
- **37 in-source vitest tests** covering every DRYR-01/02/03 row in the Validation Architecture section of 07-RESEARCH.md (12 change-plan filter matrix + 5 savings math + 20 checkpoint including hash determinism across 10 iterations and 3 orderings, mtime invalidation, add invalidation, tier-transition invalidation, MCP cache dedup, round-trip, 0o600 mode, tmp-rename crash safety, and all 5 read status discriminants)

## Task Commits

Each task was committed atomically:

1. **Task 1: change-plan.ts + savings.ts** — `db0f6c4` (feat)
2. **Task 2: checkpoint.ts (hash + atomic write + read)** — `78012ff` (feat)
3. **Task 3: remediation + workspace barrel exports** — `de5f5aa` (feat)

## Files Created/Modified

- `packages/internal/src/remediation/change-plan.ts` — ChangePlan/ChangePlanItem/ChangePlanAction types + buildChangePlan pure builder + 12 in-source tests
- `packages/internal/src/remediation/savings.ts` — calculateDryRunSavings(plan) + 5 in-source tests
- `packages/internal/src/remediation/checkpoint.ts` — Checkpoint/ReadCheckpointResult/StatFn types + computeGhostHash + resolveCheckpointPath + writeCheckpoint + readCheckpoint + 20 in-source tests
- `packages/internal/src/remediation/index.ts` — module barrel re-exports
- `packages/internal/src/index.ts` — appended remediation module section after Report module

## Decisions Made

1. **StatFn injection for cache observability (Rule 3 — blocking)**: `vi.spyOn(fsMod, 'stat')` fails with `Cannot redefine property: stat` on `node:fs/promises` because ESM built-in module namespaces are non-configurable. To satisfy the RESEARCH.md §Validation Architecture row that mandates verifying D-14 cache behavior, `computeGhostHash` accepts an optional `statFn: StatFn = stat` parameter. Default path is production identical to plan spec; the test passes a counting stub and asserts `calls.length === 2` for 5 MCP records in 2 unique source paths. This is the cleanest workaround — no mocking library, no module-level indirection, and the public signature stays backward-compatible (production callers pass zero args).

2. **Promise-valued cache to survive Promise.all (Rule 1 — correctness bug)**: The plan-as-written used `Map<string, number>` with a synchronous get-check-stat-set pattern inside an async callback under `Promise.all`. Under parallel execution, all MCP records pointing to the same sourcePath observe the empty map synchronously before any stat resolves, so every record issues its own stat and the cache deduplicates nothing. Fixed by caching the in-flight `Promise<number>` so concurrent awaits share a single stat call — the standard async-memoization pattern. This is a literal correctness fix matching the stated D-14 intent ("computed once per unique sourcePath and reused across every server declared in that file").

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MCP sourcePath cache ineffective under Promise.all**
- **Found during:** Task 2 (checkpoint.ts write + cache test red phase)
- **Issue:** `Map<string, number>` cache with synchronous `get → if undefined → await stat → set` pattern does not deduplicate concurrent requests under `Promise.all(eligible.map(async ...))`. All N records pointing to the same sourcePath check the empty map before any stat resolves, then all issue their own stat. The spec's "stat once per unique sourcePath" goal was unmet.
- **Fix:** Changed cache to `Map<string, Promise<number>>` storing the in-flight Promise. First-to-arrive creates the stat Promise and stores it; subsequent arrivals retrieve the same Promise and await it. Cache deduplicates correctly under any concurrency.
- **Files modified:** `packages/internal/src/remediation/checkpoint.ts` (computeGhostHash body)
- **Verification:** New injection-based test `MCP configMtimeMs is cached per unique sourcePath (D-14)` passes with `calls.length === 2` for 5 MCP records in 2 unique source paths.
- **Committed in:** `78012ff` (Task 2 commit)

**2. [Rule 3 - Blocking] vi.spyOn cannot intercept node:fs/promises ESM exports**
- **Found during:** Task 2 (checkpoint.ts cache test red phase)
- **Issue:** Plan test body calls `vi.spyOn(fsMod, 'stat')` after `await import('node:fs/promises')`. Vitest 4.1.2 throws `TypeError: Cannot spy on export "stat". Module namespace is not configurable in ESM`. The D-14 cache verification row in RESEARCH.md §Validation Architecture cannot execute as literally written. Plan note allows "fall back to asserting hash stability as a proxy" but that's a weaker test that doesn't actually verify the cache behavior.
- **Fix:** Added optional second parameter `statFn: StatFn = stat` to `computeGhostHash`. Production callers pass one argument (unchanged behavior); tests pass a counting stub and assert exact call count. StatFn type exported from the module and through the workspace barrel. This is cleaner than vi.mock and preserves the strong verification the plan intended.
- **Files modified:** `packages/internal/src/remediation/checkpoint.ts` (signature + body + test), `packages/internal/src/remediation/index.ts` (StatFn type export)
- **Verification:** Cache test passes with call-count assertion (stronger than the "hash stability" fallback the plan suggested).
- **Committed in:** `78012ff` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 correctness bug, 1 blocking test-infra constraint)
**Impact on plan:** Deviation 1 was a literal correctness bug in the as-written impl that would have silently shipped a no-op cache — fix restores the D-14 contract Phase 8 depends on. Deviation 2 is a public-API widening (optional parameter, type export) that strengthens test verification over the plan's suggested fallback. Neither deviation changes the Phase 8 contract: computeGhostHash's default-arg call sites behave identically to the plan spec, and the hash digest is unchanged.

## Issues Encountered

- Grep-based acceptance criteria in Task 3 expected `export { computeGhostHash ...` on a single line; initial formatting split the export across multiple lines. Reformatted to a single-line export list to satisfy the literal grep check. No functional change.

## Phase 8 Contract Notes

Downstream (Phase 8, RMED-02 three-stage gate) will consume the following exact shapes from `@ccaudit/internal`:

**Hash input scope**: Archive-eligible set only —
- agent + skill: `tier === 'definite-ghost'`
- mcp-server: `tier !== 'used'` (D-11a widened — both definite and likely)
- memory: `tier !== 'used'` (any stale tier)

**Hash value**: `"sha256:" + 64 hex chars`, computed by `computeGhostHash(enriched)`. Stable under input reordering (sorted by `category, scope, projectPath, path|serverName` with `'en-US-POSIX'` locale). Changes when any eligible item's mtimeMs bumps, when items enter/leave the eligible set, or when MCP tier transitions cross the used/not-used boundary.

**Checkpoint file path**: `resolveCheckpointPath()` → `path.join(homedir(), '.claude', 'ccaudit', '.last-dry-run')`. Single global path, no XDG fallback.

**Checkpoint schema** (D-17): JSON object with exactly 7 top-level fields — `checkpoint_version: 1`, `ccaudit_version: string`, `timestamp: string (ISO-8601 UTC)`, `since_window: string`, `ghost_hash: string (sha256:...)`, `item_count: { agents, skills, mcp, memory }`, `savings: { tokens: number }`.

**Read API discriminated union**: `readCheckpoint(targetPath)` returns one of `{ status: 'ok', checkpoint }`, `{ status: 'missing' }`, `{ status: 'parse-error', message }`, `{ status: 'unknown-version', version }`, `{ status: 'schema-mismatch', missingField }`. Never throws for these five paths. Phase 8's gate logic should compare current computed hash against `result.checkpoint.ghost_hash` only when `result.status === 'ok'`.

**Atomic write pattern**: `writeCheckpoint(cp, targetPath)` writes to `<target>.tmp-<process.pid>` then `rename`. Parent dir created with `mode: 0o700`, file with `mode: 0o600`. Errors propagate unchanged — Phase 8 should reuse this module (not reimplement) for `~/.claude.json` mutations in RMED-09.

**Savings calculation**: `calculateDryRunSavings(plan)` = sum of `archive[i].tokens + disable[i].tokens` only. Memory flag tier EXCLUDED — flagged files still load, no tokens reclaimed. Phase 8 should report this as the "definitive savings" number, not a total-overhead sum.

## Next Plan Readiness

- **Plan 07-02 (CLI integration + rendering)**: all module-level primitives ready; import from `@ccaudit/internal`. The `dryRun` flag branch in `apps/ccaudit/src/cli/commands/ghost.ts` will call `buildChangePlan(enriched)` then `computeGhostHash(enriched)` then `writeCheckpoint(cp, resolveCheckpointPath())`. No changes to this module expected in Plan 02.
- **Plan 07-03 (integration tests + version injection)**: will wire `ccaudit_version` from a generated `_version.ts` module; the Checkpoint type already carries `ccaudit_version: string` so no schema changes needed.
- **Phase 8**: all contracts above are frozen. The StatFn injection parameter is purely additive and does not affect production behavior.

## Test Coverage

| File | Tests | DRYR rows covered |
|------|-------|-------------------|
| change-plan.ts | 12 | DRYR-01 filter matrix (agents/skills archive, MCP widen, memory flag, used exclusion, token passthrough) |
| savings.ts | 5 | DRYR-01 savings math (archive sum, disable sum, flag exclusion, mixed, empty) |
| checkpoint.ts | 20 | DRYR-02 hash determinism (10 iter + 3 orderings), sha256 format, eligibility filter, mtime invalidation, add invalidation, tier transition, cache dedup; DRYR-02 writeCheckpoint (mkdir recursive, 0o600 mode, tmp-rename crash safety, EACCES propagation, round-trip, schema key set); DRYR-03 readCheckpoint (missing, parse-error, unknown-version 2, schema-mismatch) |

**Full workspace test run**: 41 test files / 334 tests / 0 failures / 0 regressions (pnpm -w test --run).

## Self-Check: PASSED

- Files verified on disk:
  - FOUND: packages/internal/src/remediation/change-plan.ts
  - FOUND: packages/internal/src/remediation/savings.ts
  - FOUND: packages/internal/src/remediation/checkpoint.ts
  - FOUND: packages/internal/src/remediation/index.ts
  - FOUND: packages/internal/src/index.ts (modified)
- Commits verified in git log:
  - FOUND: db0f6c4 (Task 1: change-plan + savings)
  - FOUND: 78012ff (Task 2: checkpoint)
  - FOUND: de5f5aa (Task 3: barrel exports)
- Test suite green: 334/334 workspace tests pass, 28/28 internal package test files pass.

---
*Phase: 07-dry-run-checkpoint*
*Completed: 2026-04-04*
