---
phase: 07-dry-run-checkpoint
plan: 04
subsystem: remediation
tags: [gap-closure, enoent, broken-symlink, try-catch-stat, defensive-coding, scanner, hash]

# Dependency graph
requires:
  - phase: 03-inventory-scanner
    provides: scanMemoryFiles try/catch-stat pattern at scan-memory.ts:44-56 (the exact idiom copied verbatim)
  - phase: 07-dry-run-checkpoint
    provides: computeGhostHash, StatFn injection hook, MCP sourcePath cache (all preserved unchanged by this plan)
provides:
  - scanSkills and scanAgents now populate mtimeMs: number on every returned item via try/catch-wrapped stat
  - Broken symlinks, deleted files, ELOOP cycles, EACCES paths silently excluded from scan results
  - computeGhostHash defensive safety net: eligible.map returns HashRecord | null, filters nulls before canonical sort
  - Real-world ccaudit --dry-run against ~/.claude/ with broken-symlink skills no longer crashes with ENOENT
affects: [phase-8-remediation, phase-8-rmed-02-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mirror of scan-memory.ts:44-56 try/catch-stat pattern across all InventoryItem-producing scanners for file-disappearance resilience"
    - "Defensive safety net via HashRecord | null return type + type predicate filter — belt-and-suspenders against future scanner regressions"

key-files:
  created: []
  modified:
    - packages/internal/src/scanner/scan-skills.ts (added stat import + try/catch-stat around both loops + 1 new test + 1 updated assertion)
    - packages/internal/src/scanner/scan-agents.ts (added stat import + try/catch-stat around both loops + 1 new test + unlink import)
    - packages/internal/src/remediation/checkpoint.ts (eligible.map returns HashRecord | null, broad try/catch, filter nulls + 1 new test)
    - apps/ccaudit/src/__tests__/dry-run-command.test.ts (extended FixtureSpec with brokenSymlinkSkills + 1 new end-to-end regression test)

key-decisions:
  - "Broad bare catch {} over error-code discrimination — matches scan-memory.ts precedent, handles ENOENT/ELOOP/EACCES/ENOTDIR uniformly, simpler to reason about"
  - "stat() follows symlinks (not lstat) — a valid linked skill resolves through the symlink; only broken links throw and get skipped, which is the correct semantic"
  - "Hash safety net returns null and filters rather than throwing — consistent with frozen D-17 contract clause 'items enter/leave eligible set'; un-stat-able items effectively leave the set"
  - "StatFn injection hook at checkpoint.ts:86 preserved unchanged — required by existing D-14 cache test; the defensive layer wraps the statFn call, doesn't replace it"
  - "Scanner fix is the primary root cause; hash safety net is belt-and-suspenders against any future scanner regression that reintroduces unpopulated mtimeMs"

patterns-established:
  - "File-disappearance resilience: every scanner loop that emits InventoryItem with a filesystem path must stat inside a try/catch — the cost of a stat is small compared to the cost of a crashed Promise.all downstream"
  - "Null-sentinel error-swallowing in Promise.all mappers: return null on expected errors, filter with type predicate before use — preserves Promise.all parallelism without losing type safety"

requirements-completed: [DRYR-01, DRYR-02, DRYR-03]

# Metrics
duration: 7min
completed: 2026-04-05
---

# Phase 7 Plan 4: Gap Closure — Broken-Symlink ENOENT Fix Summary

**Two-layer fix for the Phase 7 escaped gap: scanSkills/scanAgents now populate mtimeMs via try/catch-wrapped stat, and computeGhostHash has a defensive safety net that filters un-stat-able items — `ccaudit --dry-run` against a real `~/.claude/` with broken-symlink skills no longer crashes with ENOENT.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-04-05T05:05:00Z
- **Completed:** 2026-04-05T05:09:25Z
- **Tasks:** 3 (all autonomous, TDD)
- **Files modified:** 4
- **Lines added:** ~120 (code + tests)

## Why the Gap Escaped

The automated Phase 7 verification gate passed with a clean `passed` score (353/353 tests, 93.49% stmts, gsd-verifier confirmed all 3 observable truths). The very first manual execution of `ccaudit --dry-run` against a real `~/.claude/` installation crashed immediately with an unhandled `ENOENT`.

**Root cause: synthetic-fixture blind spot.** The integration test suite in `apps/ccaudit/src/__tests__/dry-run-command.test.ts` built its fixture with `writeFile` + `utimes` — every file in the fixture was real and stat-able. No test case ever exercised "inventory references a path that cannot be stat'd". The regressed human verification item ("Live Dry-Run Against a Real Claude Installation") would have caught it but was not executed before marking Phase 7 passed.

**Two layers both trusted stat()**:
1. `scanSkills` and `scanAgents` did not populate `mtimeMs` at discovery time (unlike `scanMemoryFiles` which does). Items were pushed with `mtimeMs: undefined`.
2. `computeGhostHash` had an unprotected `stat()` fallback at `checkpoint.ts:137`: `const mtimeMs = r.item.mtimeMs ?? (await statFn(r.item.path)).mtimeMs;`. Any `ENOENT` (or `ELOOP`, `EACCES`, `ENOTDIR`) crashed the entire `Promise.all` and bubbled up to the CLI.

The original crash trace (user terminal, 2026-04-05):
```
Error: ENOENT: no such file or directory, stat '/Users/helldrik/.claude/skills/full-output-enforcement'
    at async Promise.all (index 164)
    at async computeGhostHash (packages/internal/src/remediation/checkpoint.ts:137)
    at async run (apps/ccaudit/src/cli/commands/ghost.ts:138)
```

## Accomplishments

- **Task 1 — Scanner fix (primary root cause):** `scanSkills` and `scanAgents` now import `stat` from `node:fs/promises` and wrap their `items.push` calls in try/catch-stat blocks mirroring `scan-memory.ts:44-56` verbatim. Every returned item carries `mtimeMs: number`. Broken symlinks, deleted files, and un-stat-able paths are silently excluded from scan results rather than crashing downstream consumers.
- **Task 2 — Hash safety net (belt-and-suspenders):** `computeGhostHash`'s `eligible.map` async body now returns `HashRecord | null`. The body is wrapped in a broad try/catch that returns `null` on any stat failure; a type-predicate filter `(r): r is HashRecord => r !== null` produces the final `records` array. The StatFn injection hook and MCP sourcePath cache semantics are preserved unchanged — all 20 pre-existing checkpoint.ts tests pass.
- **Task 3 — End-to-end regression test:** Extended `FixtureSpec` with `brokenSymlinkSkills?: string[]`, added buildFixture logic to create broken symlinks under `${tmpHome}/.claude/skills/`, and added the regression test "should succeed when ~/.claude/skills/ contains a broken symlink" that spawns the built binary and asserts exit code 0, no ENOENT in stderr, Dry-Run header in stdout, and a valid sha256 ghost_hash in the written checkpoint file.
- **Four new tests** prevent recurrence:
  1. `scanSkills` — "should skip broken symlinks (target deleted)" (valid skill survives alongside a broken link)
  2. `scanAgents` — "should skip files that disappear between glob and stat (missing-file race)" (unlink after writeFile, before scan)
  3. `computeGhostHash` — "should skip items whose path cannot be stat'd (broken symlink, deleted file)" (real ENOENT path, hash matches "only valid item" control)
  4. `dry-run-command` — "should succeed when ~/.claude/skills/ contains a broken symlink (gap 07-04 regression)" (end-to-end subprocess test with broken symlink fixture)
- **Updated test:** `scanSkills` "should include symlinks as skill entries" now asserts `mtimeMs` is populated as a number.

## Task Commits

Each task was committed atomically:

1. **Task 1: Scanner fix (scan-skills.ts + scan-agents.ts)** — `f033733` (fix)
2. **Task 2: computeGhostHash safety net** — `0596112` (fix)
3. **Task 3: End-to-end regression test** — `0dd1238` (test)

## Files Modified

- `packages/internal/src/scanner/scan-skills.ts` — Added `stat` import (line 1); wrapped both global and project loops in try/catch-stat; populated `mtimeMs: s.mtimeMs` on every push; added "should skip broken symlinks" test; updated "should include symlinks as skill entries" test to assert `mtimeMs`.
- `packages/internal/src/scanner/scan-agents.ts` — Added `stat` import alongside existing `glob` import; wrapped both global and project loops in try/catch-stat; populated `mtimeMs: s.mtimeMs` on every push; added `unlink` import at test-block level; added "should skip files that disappear between glob and stat" test.
- `packages/internal/src/remediation/checkpoint.ts` — Changed `eligible.map` return type to `Promise<HashRecord | null>`; wrapped entire mapper body in broad try/catch returning `null` on any error; replaced `records` assignment with `maybeRecords.filter((r): r is HashRecord => r !== null)`; added "should skip items whose path cannot be stat'd" in-source test.
- `apps/ccaudit/src/__tests__/dry-run-command.test.ts` — Added `symlink, readFile` to fs/promises import; added `brokenSymlinkSkills?: string[]` to `FixtureSpec`; extended `buildFixture` to create broken symlinks under `${tmpHome}/.claude/skills/` pointing at a `_never_exists_` subdirectory; added end-to-end regression test asserting exit code 0, no ENOENT in stderr, Dry-Run header in stdout, valid sha256 in checkpoint file.

## Decisions Made

1. **Broad bare `catch {}` over error-code discrimination.** The plan called for swallowing `ENOENT`, `ELOOP`, `EACCES`, and `ENOTDIR`. A discriminating catch with `if (err.code === 'ENOENT' || ...)` would be more explicit but adds complexity without value — any stat failure on a path discovered via `readdir`/`glob` is a file-disappearance signal and the item should be excluded. Matches `scan-memory.ts:44-56` precedent verbatim.

2. **`stat()` not `lstat()` in scanners.** `stat()` follows symlinks, which is the correct behavior: a valid linked skill resolves through the symlink and returns the target's mtime; only broken links throw and get skipped. Using `lstat()` would populate `mtimeMs` with the symlink's own mtime (which is semantically wrong — the skill content is at the target) and would not surface broken links until `computeGhostHash` tried to hash them.

3. **Null-sentinel safety net over exception translation in `computeGhostHash`.** Alternative designs considered: (a) wrap entire `Promise.all` in try/catch and swallow (loses granularity, all-or-nothing), (b) throw a custom error class and catch at the CLI layer (leaks fs concerns into the CLI), (c) filter eligible before mapping (requires a separate stat pass, defeats the Promise.all parallelism). Null-sentinel + type-predicate filter keeps the Promise.all intact, preserves per-item granularity, and aligns with the frozen D-17 hash contract clause "items enter/leave eligible set".

4. **Scanner fix as primary; hash safety net as secondary.** The scanner fix removes the root cause — after Task 1, the hash builder's unprotected `stat` fallback is only hit if a future scanner regression reintroduces unpopulated `mtimeMs`. The hash safety net (Task 2) is belt-and-suspenders that ensures the CLI never crashes even if such a regression happens. Both layers are needed: Task 1 alone would leave a latent bug, Task 2 alone would silently exclude items from the hash on every scan (wrong semantics — we want the item counted when its file is valid).

## Deviations from Plan

None - plan executed exactly as written.

The code snippets in `07-04-PLAN.md`'s `<interfaces>` block were verbatim-complete. No surprises during execution, no Rule 1/2/3/4 deviations. The plan's verbatim code approach paid off.

## Issues Encountered

None.

## Quality Gate Results

**Test count:**
- Baseline (Phase 7 complete): 353 tests
- After gap closure: **357 tests** (+4 new: scan-skills broken-symlink, scan-agents missing-file race, checkpoint un-stat-able, dry-run regression)

**Workspace suite:**
```
Test Files  43 passed (43)
Tests  357 passed (357)
```

**Coverage snapshot (Phase 6 thresholds: 80/70/80/80):**
```
All files    | 93.61% | 84.71% |  96% | 94.4% | PASS
checkpoint.ts | 93.42% | 86.79% | 100% | 97.1% | PASS
scan-skills.ts| 97.14% | 78.57% | 100% | 100%  | PASS
scan-agents.ts|  100%  |  100%  | 100% | 100%  | PASS
```

**Typecheck:** `pnpm -w typecheck` exits 0 across all 3 packages.

## Real-World Verification (the Originally-Escaped Command)

**The exact command that was crashing:**
```bash
node apps/ccaudit/dist/index.js --dry-run
```

**Before (2026-04-05, initial smoke test):**
```
Error: ENOENT: no such file or directory, stat '/Users/helldrik/.claude/skills/full-output-enforcement'
    at async Promise.all (index 164)
    at async computeGhostHash (packages/internal/src/remediation/checkpoint.ts:137)
```

**After (2026-04-05, post-gap-closure):**
```json
{
  "checkpoint": {
    "path": "/Users/helldrik/.claude/ccaudit/.last-dry-run",
    "ghost_hash": "sha256:392a20a38aa0fb53d005911c092a0042aeb6a392a7d33595e48b968d2bccd7bd",
    "timestamp": "2026-04-05T05:08:34.284Z",
    "ccaudit_version": "0.0.1",
    "checkpoint_version": 1
  },
  "counts": { "agents": 160, "skills": 17, "mcp": 4, "memory": 6 },
  "savings": { "tokens": 445546 }
}
```

**Hash stability (DRYR-03 real-world verification — originally the skipped human-verification item):**
```
H1: sha256:392a20a38aa0fb53d005911c092a0042aeb6a392a7d33595e48b968d2bccd7bd
H2: sha256:392a20a38aa0fb53d005911c092a0042aeb6a392a7d33595e48b968d2bccd7bd
STABLE
```

Two sequential runs against the unchanged real inventory produce identical ghost_hash values — the previously-skipped human verification item #2 and #3 from `07-VERIFICATION.md` both now pass.

## D-17 Contract Preservation

The frozen hash contract in `07-01-SUMMARY.md` Phase 8 Contract Notes section is silent on missing-file handling. The relevant clause is:

> Changes when any eligible item's mtimeMs bumps, **when items enter/leave the eligible set**, or when MCP tier transitions cross the used/not-used boundary.

Excluding an un-stat-able item from the hash is consistent with "items enter/leave the eligible set" — the scanner fix removes the item from the input entirely; the hash safety net is a belt-and-suspenders last-resort filter. **No contract break**. All 20 pre-existing `computeGhostHash` tests (including the D-14 cache verification, the 10-iteration determinism test, the 3-ordering stability test, and the mtime-invalidation test) continue to pass.

## DRYR Requirements Re-satisfied

- **DRYR-01** (change plan output without filesystem changes): End-to-end regression test in `dry-run-command.test.ts` now exercises a real-world-shaped fixture with broken symlinks and asserts the change plan renders correctly and exits 0.
- **DRYR-02** (checkpoint file written with valid sha256): Regression test asserts `checkpoint.ghost_hash` matches `/^sha256:[a-f0-9]{64}$/` after a dry-run against a broken-symlink fixture. Before the fix, the command crashed before `writeCheckpoint` was called.
- **DRYR-03** (hash-based invalidation): Real-world verification on the actual `~/.claude/` proves two sequential runs produce the same hash. Existing in-source determinism tests (10 iterations, 3 orderings, mtime invalidation, add invalidation, tier-transition invalidation) all still pass.

## Next Phase Readiness

- **Phase 8 (remediation) is unblocked.** The `computeGhostHash` signature, the checkpoint schema, the StatFn injection hook, and the MCP sourcePath cache are all preserved unchanged. Phase 8's RMED-02 three-stage gate will consume `readCheckpoint()` → compare hash against live `computeGhostHash(enriched)` → no surprises.
- **Hash input semantics slightly strengthened.** After this plan, the hash input is guaranteed to exclude un-stat-able paths. Phase 8's gate logic is simpler as a result: if `readCheckpoint().status === 'ok' && result.checkpoint.ghost_hash === liveHash`, proceed; no need to reason about "what if the file was readable when the checkpoint was written but not now" — both sides use the same filter.
- **No new concerns** for Phase 8. The fs.rename EPERM concern logged for v1.2 is unchanged.

## Self-Check: PASSED

- Files verified on disk:
  - FOUND: packages/internal/src/scanner/scan-skills.ts (modified)
  - FOUND: packages/internal/src/scanner/scan-agents.ts (modified)
  - FOUND: packages/internal/src/remediation/checkpoint.ts (modified)
  - FOUND: apps/ccaudit/src/__tests__/dry-run-command.test.ts (modified)
- Commits verified in git log:
  - FOUND: f033733 (Task 1: scanner fix)
  - FOUND: 0596112 (Task 2: checkpoint safety net)
  - FOUND: 0dd1238 (Task 3: integration test)
- Test suite green: 357/357 workspace tests pass.
- Coverage gate green: 93.61% stmts / 84.71% br / 96% fn / 94.4% lines (all above Phase 6 thresholds of 80/70/80/80).
- Typecheck green across all 3 packages.
- Real-world smoke test passes: `node apps/ccaudit/dist/index.js --dry-run` against the actual `~/.claude/` that originally crashed now exits 0 and writes a valid checkpoint.

---
*Phase: 07-dry-run-checkpoint*
*Completed: 2026-04-05*
