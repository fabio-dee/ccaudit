---
phase: 08-remediation-core
plan: 02
subsystem: remediation-infrastructure
tags: [collision-handling, iso-timestamp, process-detection, ps-tasklist, parent-chain, fail-closed]
dependency_graph:
  requires:
    - Plan 08-01 (atomic-write.ts + index.ts barrel — preserved, not disturbed)
    - Phase 3 scan-agents.ts (confirms scanners return full nested filePath; motivates RESEARCH Open Question 1 fix)
  provides:
    - packages/internal/src/remediation/collisions.ts (4 helpers: timestampSuffixForFilename, timestampSuffixForJsonKey, buildArchivePath, buildDisabledMcpKey)
    - packages/internal/src/remediation/processes.ts (detectClaudeProcesses, walkParentChain, parsePsComm, parseTasklistCsv, CLAUDE_NAME_REGEX + ProcessDetectorDeps DI surface)
    - Nested-archive path semantics (path.relative preservation closes Open Question 1)
    - Fail-closed spawn policy ({status:'spawn-failed'} tagged result per D-02)
    - DI pattern template for platform-specific child_process code (runCommand/getParentPid/platform injection)
  affects:
    - Wave 1 bust orchestrator (Plan 08-04/08-05): consumes buildArchivePath for archive step, buildDisabledMcpKey for MCP disable step, detectClaudeProcesses + walkParentChain for D-02/D-03/D-04 preflight gate
    - Phase 9 restore: manifest records exact archive_path (preserving nested structure) and disabled key (preserving colons) that Phase 9 reverses
tech_stack:
  added:
    - node:child_process.spawn with SIGKILL timeout (new pattern — prior code only did atomic file I/O)
    - Conservative anchored regex for binary-name matching (rejects partial/prefix matches)
  patterns:
    - Injected dependency pattern for child_process (ProcessDetectorDeps) — tests never spawn real processes on any platform
    - Tagged-result fail-closed return ({status:'ok'} | {status:'spawn-failed'}) instead of silent empty array
    - path.relative escape guard (throws when sourcePath is outside categoryRoot via ..)
    - Filename-vs-JSON-key ISO suffix bifurcation (filenames strip colons for NTFS, JSON keys preserve colons per RFC 8259)
key_files:
  created:
    - packages/internal/src/remediation/collisions.ts (204 lines, 15 in-source tests)
    - packages/internal/src/remediation/processes.ts (378 lines, 21 in-source tests)
    - .planning/phases/08-remediation-core/08-02-SUMMARY.md (this file)
  modified:
    - packages/internal/src/remediation/index.ts (added collisions + processes barrel exports alongside existing atomic-write block)
decisions:
  - D-05 filename collision handling (ISO timestamp, colons -> dashes for cross-filesystem safety)
  - D-06 MCP key collision handling (ISO timestamp, colons PRESERVED per RFC 8259)
  - Open Question 1 resolved — buildArchivePath uses path.relative to preserve nested subdir structure (never flattens to basename)
  - D-02 fail-closed spawn policy — ANY spawn error returns tagged spawn-failed, never silent empty array
  - D-04 self-invocation detection via iterative walkParentChain with maxDepth=16 safety cap
  - CLAUDE_NAME_REGEX anchored ^...$ to reject ClaudeBar/claude-code-router/ClaudeHelper prefixes and suffixes
  - SpawnOptions (not SpawnOptionsWithoutStdio) chosen for runCommand implementation — WithoutStdio forbids stdio property
requirements_completed: [RMED-04, RMED-05, RMED-06, RMED-03]
metrics:
  duration: ~5 minutes
  completed_date: 2026-04-05
  tasks_completed: 2
  tests_added: 36 (15 collisions.ts + 21 processes.ts)
  full_remediation_suite: 88 passing + 1 skipped (up from 52+1 post-Plan-01)
  full_workspace_tests: 418 passing + 1 skipped (up from 382+1)
---

# Phase 8 Plan 02: Collision Helpers + Running-Process Detection Summary

Two Wave 0 infrastructure modules: `collisions.ts` ships nested-path-preserving archive builder plus filename/JSON-key ISO suffix helpers with divergent colon semantics (D-05/D-06, closes RESEARCH Open Question 1), and `processes.ts` ships a fail-closed `ps`/`tasklist` scanner with anchored `CLAUDE_NAME_REGEX` and iterative parent-chain walker for self-invocation detection (D-02/D-03/D-04). Both modules are fully testable via injected dependencies — zero real `fs` or `child_process` calls in unit tests.

## Performance

- **Duration:** ~5 minutes (4m48s wall-clock)
- **Started:** 2026-04-05T15:08:17Z
- **Completed:** 2026-04-05T15:13:05Z
- **Tasks:** 2 (both `type=auto tdd=true`)
- **Files modified:** 3 (2 created + index.ts barrel)

## Accomplishments

- **Nested archive paths preserved** — `agents/design/foo.md` archives to `_archived/design/foo.md`, not `_archived/foo.md`. Closes RESEARCH Open Question 1. Implemented via `path.relative(categoryRoot, sourcePath)` with a `..`-escape guard that throws rather than silently archiving outside the target tree.
- **Filename-vs-JSON-key colon bifurcation** — `timestampSuffixForFilename` strips colons to dashes (NTFS forbids `:` in filenames, matching Plan 01 manifest path convention), while `timestampSuffixForJsonKey` preserves colons (JSON RFC 8259 allows any UTF-8 in object keys). Caller picks the right helper; the distinction is documented in module JSDoc so downstream bust orchestrator can't mix them up.
- **Conservative Claude process matching** — `CLAUDE_NAME_REGEX = /^(claude(?:\.exe)?|Claude(?:\.exe)?|Claude Code)$/` rejects `ClaudeBar`, `claude-code-router`, `ClaudeHelper`, `claudia`, `claude-desktop`, and `Claude.exe.bak`. Anchored with `^...$` to prevent accidental non-anchored regression.
- **Fail-closed spawn detection** — Any spawn error (ENOENT, permission denied, timeout, non-zero exit) returns `{status: 'spawn-failed', error: <message>}` rather than an empty array. Caller refuses the bust with the D-02 message "could not verify Claude Code is stopped" instead of producing a silent false negative. 2000ms hard timeout with SIGKILL.
- **Self-invocation detection via parent-chain walk** — `walkParentChain` iteratively queries `getParentPid` with a 16-level depth cap, stopping on pid ≤ 1 (init/launchd), null return, or self-reference. Bust orchestrator (Wave 1) will intersect the returned chain with detected Claude pids to emit the D-04 "open a standalone terminal" message when ccaudit is invoked via the Bash tool inside a Claude Code session.
- **Injected-deps test architecture** — `ProcessDetectorDeps = { runCommand, getParentPid, platform }` means every unit test runs on any OS without actually spawning `ps`/`tasklist`/`wmic`. The `platform: 'win32'` test case verifies tasklist is selected and the CSV path is parsed correctly, from a macOS dev machine.

## Task Commits

Each task committed atomically:

1. **Task 1: Create collisions.ts** — `7e08225` (feat)
   - 4 exported helpers (2 timestamp suffixers, buildArchivePath, buildDisabledMcpKey)
   - 15 in-source tests: ms stripping, colon semantics, flat/nested/deep archive paths, collision suffix insertion, escape guard, double-collision edge case, hyphenated server names
   - Barrel export appended to `index.ts` (atomic-write block from Plan 01 preserved untouched)

2. **Task 2: Create processes.ts** — `f1c6057` (feat)
   - `detectClaudeProcesses` with platform-routed ps/tasklist selection, 2s SIGKILL timeout, self-pid exclusion
   - `parsePsComm` handles both basename (`claude`) and full-path (`/Applications/Claude.app/.../Claude`) comm= formats
   - `parseTasklistCsv` handles quoted CSV fields with trailing CRLF or bare last line
   - `walkParentChain` iterative walker with 4 termination conditions (maxDepth, pid≤1, null, self-ref)
   - `CLAUDE_NAME_REGEX` anchored exact-basename regex
   - `ProcessDetectorDeps` DI surface for zero-spawn unit tests
   - 21 in-source tests including D-04 chain-overlap scenario and CRLF edge cases
   - Barrel export (5 values + 3 types) appended to `index.ts`

## Files Created/Modified

- `packages/internal/src/remediation/collisions.ts` — **CREATED** (204 lines). ISO timestamp suffix helpers with filename vs. JSON-key colon semantics, collision-resistant nested archive path builder with escape guard, collision-resistant MCP disabled key builder. 15 in-source tests.
- `packages/internal/src/remediation/processes.ts` — **CREATED** (378 lines). Fail-closed `ps`/`tasklist` scanner with anchored regex, iterative parent-chain walker, injectable deps for zero-spawn unit tests. Default deps implementation uses `node:child_process.spawn` with 2s SIGKILL timeout. 21 in-source tests.
- `packages/internal/src/remediation/index.ts` — **MODIFIED** (barrel exports). Added collisions and processes export blocks beneath existing atomic-write block from Plan 01. Preserved all Plan 01 exports byte-for-byte.

## Decisions Made

- **D-05/D-06 colon bifurcation enforced at the API boundary**: Two separate helpers (`timestampSuffixForFilename` vs. `timestampSuffixForJsonKey`) rather than one helper with a flag parameter. Rationale: picking the wrong one at call-sites is a harder bug to make when the type signature actively forces a choice, and the JSDoc explicitly documents when to use each.
- **Open Question 1 resolved as "preserve nested structure"**: `buildArchivePath` uses `path.relative(categoryRoot, sourcePath)` + `path.join(archivedDir, rel)` so `agents/design/foo.md` lands at `_archived/design/foo.md`. Rejected alternative was "flatten to basename and disambiguate via subdir-in-filename encoding" — more complex, more collision-prone, and loses the visual hierarchy in listings of the archive directory.
- **Escape guard is a `throw`, not a silent fallback**: If `rel` starts with `..` or is absolute, `buildArchivePath` throws. This is a programming bug in the caller, not a user-input validation failure. Tests document the contract.
- **D-02 fail-closed tagged result, not empty array**: `detectClaudeProcesses` returns `{status: 'ok'|'spawn-failed'}` so the caller MUST pattern-match on status. An empty array could mean either "no Claude running" (safe to proceed) or "ps didn't spawn" (MUST refuse) — the tagged result eliminates the ambiguity at the type level.
- **CLAUDE_NAME_REGEX anchored with `^...$`**: Explicit belt-and-suspenders against regex-drift regressions. Test case `rejects partial matches even when prefix matches` catches any future edit that removes the anchors.
- **`walkParentChain` hard cap at 16 levels**: Prevents pathological infinite loops even if the self-reference/null/pid≤1 termination logic has a bug. 16 is vastly deeper than any realistic process tree (typical depth on macOS is 5-8).
- **`SpawnOptions` instead of `SpawnOptionsWithoutStdio`**: The `WithoutStdio` variant forbids the `stdio` property entirely — it's for callers that want default stdio. Since we explicitly set `['ignore', 'pipe', 'pipe']`, we need the base `SpawnOptions` type. See Deviations section below for the typecheck fix that caught this.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `SpawnOptionsWithoutStdio` type rejected explicit stdio config**
- **Found during:** Task 2 verification (post-write typecheck)
- **Issue:** The plan's reference implementation (08-02-PLAN.md lines 477-499) typed the spawn options as `SpawnOptionsWithoutStdio`, but TypeScript emits `error TS2322: Type '"ignore"' is not assignable to type 'StdioPipe'` because the `WithoutStdio` variant explicitly forbids the `stdio` property. Blocking: Plan 02 typecheck fails, downstream plans can't build.
- **Fix:** Changed import from `SpawnOptionsWithoutStdio` to `SpawnOptions` (which does permit `stdio`). Added `?.` optional chain on `child.stdout.on(...)` because `SpawnOptions` widens `ChildProcess.stdout` to `Readable | null` even though we set it to `'pipe'` (TypeScript can't narrow from the runtime value). The behavior is identical — at runtime, `stdout` is always non-null because we set `stdio[1] = 'pipe'`. A comment above the call documents the invariant.
- **Files modified:** `packages/internal/src/remediation/processes.ts` (import line + runCommand body)
- **Verification:** `pnpm -F @ccaudit/internal typecheck` exits 0; `pnpm exec vitest --run packages/internal/src/remediation/processes.ts` still exits 0 (21/21 tests pass).
- **Committed in:** `f1c6057` (folded into Task 2 commit — caught before commit landed)
- **Note:** The plan author used the same type reference the Phase 7 checkpoint code used, but checkpoint.ts never called `spawn` with an explicit stdio array, so the type mismatch never surfaced there. This is a stdio-array-specific TypeScript quirk, not a logic bug.

### Rule 2: Proactive additions beyond the plan text

**2. Added extra test coverage beyond plan's behavior list**
- **collisions.ts** gained one test (`handles zero milliseconds (ISO string without fractional seconds)`) verifying the `.replace(/\.\d{3}Z$/, 'Z')` regex handles the `.000Z` case that `Date.prototype.toISOString()` always emits. The plan's 11 behaviors didn't explicitly cover this but it's a natural edge case worth locking in.
- **collisions.ts** gained one test (`double collision: still returns the timestamped key (caller responsibility)`) — Test 10 from the plan's behavior list was stated but not in the code block; I implemented it and added an explanatory comment documenting the contract.
- **processes.ts** gained one test (`returns empty ok when no Claude processes present`) verifying the common success case (no matching processes) returns `{status:'ok', processes:[]}` rather than spawn-failed. Plan's behaviors didn't cover this baseline case.
- **processes.ts** gained one test (`rejects partial matches even when prefix matches`) as a belt-and-suspenders guard against future regex anchor removal.
- None of these added tests violate any behavior specified in the plan; they document and lock additional edge cases.

---

**Total deviations:** 1 auto-fixed blocking typecheck error + 4 additional test cases.
**Impact on plan:** The typecheck fix was necessary for the plan to compile at all. The extra tests strengthen coverage without contradicting any plan assertion. No scope creep.

## Issues Encountered

- None beyond the typecheck deviation documented above.

## Verification Results

**Plan-wide verification block:**

```
$ pnpm exec vitest --run packages/internal/src/remediation/collisions.ts packages/internal/src/remediation/processes.ts
 ✓ |@ccaudit/internal| src/remediation/collisions.ts (15 tests) 4ms
 ✓ |@ccaudit/internal| src/remediation/processes.ts  (21 tests) 3ms
 Test Files  2 passed (2)
      Tests  36 passed (36)

$ pnpm -F @ccaudit/internal typecheck
> tsc
(exit 0, no output)

$ grep -c "collisions.ts" packages/internal/src/remediation/index.ts
1

$ grep -c "processes.ts" packages/internal/src/remediation/index.ts
2   # 1 runtime export line + 1 type export line
```

**Full remediation suite regression:**

```
$ pnpm exec vitest --run packages/internal/src/remediation/
 ✓ src/remediation/savings.ts       (5 tests)
 ✓ src/remediation/change-plan.ts   (12 tests)
 ✓ src/remediation/collisions.ts    (15 tests)  — NEW in 08-02
 ✓ src/remediation/processes.ts     (21 tests)  — NEW in 08-02
 ✓ src/remediation/atomic-write.ts  (15 tests | 1 skipped)
 ✓ src/remediation/checkpoint.ts    (21 tests)
 Test Files  6 passed (6)
      Tests  88 passed | 1 skipped (89)
```

**Full workspace regression:**

```
$ pnpm exec vitest --run
 Test Files  48 passed (48)
      Tests  418 passed | 1 skipped (419)
```

Delta vs. pre-Plan-02 (post-Plan-01 baseline in 08-01-SUMMARY.md): `382 passing + 1 skipped → 418 passing + 1 skipped`. Exactly `+36` tests with zero regressions — the count perfectly matches the 15 collisions + 21 processes additions.

## Plan 01 Preservation Check

The plan explicitly required that `index.ts` barrel exports from Plan 01 (atomic-write) be preserved. Verified:

```
$ grep -n "atomic-write\|atomicWriteJson\|renameWithRetry\|AtomicWriteOptions" packages/internal/src/remediation/index.ts
12:// Phase 8: atomic write primitive (D-18 extraction, reused by bust orchestrator)
13:export { atomicWriteJson, renameWithRetry } from './atomic-write.ts';
14:export type { AtomicWriteOptions } from './atomic-write.ts';
```

All 3 Plan 01 export lines remain byte-for-byte identical. Plan 01's 21 checkpoint.ts regression tests + 15 atomic-write.ts tests still pass unchanged.

## Next Plan Readiness

Wave 0 is now at 3/5 shared infrastructure modules complete (atomic-write from Plan 01, collisions + processes from Plan 02). The remaining Wave 0 modules per `08-VALIDATION.md` are `frontmatter.ts` (hand-rolled YAML patcher per D-08) and `manifest.ts` (JSONL append writer with header/footer per D-09/D-10/D-11/D-12). These have no cross-dependency on collisions.ts or processes.ts, so Plan 03 can begin immediately with the same parallel-development-within-a-plan pattern used here.

The Wave 1 bust orchestrator (later plans in Phase 8) will import from this plan via:

```ts
import {
  buildArchivePath,
  buildDisabledMcpKey,
  detectClaudeProcesses,
  walkParentChain,
} from '@ccaudit/internal/remediation';
```

All four functions are barrel-exported and typecheck-clean.

## Threat Flags

None. No new network endpoints, no authentication paths, no schema changes at trust boundaries. The `child_process.spawn` calls go to local `ps`/`tasklist`/`wmic` binaries with fixed hardcoded arguments (no user input reaches spawn args); the shell-injection surface is zero.

## Known Stubs

None. Both modules are complete, tested, and production-ready. No TODO/FIXME markers, no hardcoded placeholder data, no components wired to empty inputs.

## Self-Check: PASSED

**Created files:**
- `packages/internal/src/remediation/collisions.ts` — FOUND (verified via `test -f`)
- `packages/internal/src/remediation/processes.ts` — FOUND (verified via `test -f`)
- `.planning/phases/08-remediation-core/08-02-SUMMARY.md` — FOUND (this file)

**Modified files:**
- `packages/internal/src/remediation/index.ts` — FOUND (collisions + processes blocks added, atomic-write block preserved)

**Commits:**
- `7e08225` — FOUND via `git log --oneline | grep 7e08225` (Task 1: feat collision helpers)
- `f1c6057` — FOUND via `git log --oneline | grep f1c6057` (Task 2: feat running-process detection)

**Acceptance criteria (plan success criteria):**
- collisions.ts exports 4 helpers (timestampSuffixForFilename, timestampSuffixForJsonKey, buildArchivePath, buildDisabledMcpKey) — PASS
- Filename helper strips ms and replaces colons with dashes — PASS (test: `2026-04-05T18:30:00.123Z` → `2026-04-05T18-30-00Z`)
- JSON-key helper strips ms but preserves colons — PASS (test: `2026-04-05T18:30:00.123Z` → `2026-04-05T18:30:00Z`)
- buildArchivePath preserves nested subdirectory structure via path.relative — PASS (test: `design/foo.md` → `_archived/design/foo.md`, `design/ux/foo.md` → `_archived/design/ux/foo.md`)
- buildArchivePath throws on sourcePath outside categoryRoot — PASS (test: `/home/u/.claude/other/foo.md` throws `/outside categoryRoot/`)
- processes.ts exports detectClaudeProcesses, walkParentChain, parsePsComm, parseTasklistCsv, CLAUDE_NAME_REGEX — PASS
- CLAUDE_NAME_REGEX matches `{claude, Claude, claude.exe, Claude.exe, Claude Code}` and rejects `ClaudeBar`/`claude-code-router`/`ClaudeHelper`/`claudia`/`notclaude`/`claude-desktop` — PASS
- detectClaudeProcesses fails closed with `{status:'spawn-failed'}` on any error (per D-02) — PASS (2 tests: ENOENT + timeout)
- walkParentChain stops at pid≤1, self-reference, null, or maxDepth — PASS (5 tests)
- All tests pass with injected deps (no real fs/spawn in unit tests) — PASS (36/36 via ProcessDetectorDeps DI)
- Full remediation suite 88 passing + 1 skipped — PASS
- Full workspace 418 passing + 1 skipped, zero regressions — PASS
- TypeScript clean (`pnpm -F @ccaudit/internal typecheck` exits 0) — PASS

---
*Phase: 08-remediation-core*
*Plan: 02*
*Completed: 2026-04-05*
