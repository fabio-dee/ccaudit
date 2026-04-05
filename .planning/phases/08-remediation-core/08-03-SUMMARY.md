---
phase: 08-remediation-core
plan: 03
subsystem: remediation-infrastructure
tags: [yaml-frontmatter, hand-rolled-parser, memory-files, idempotent-refresh, crlf-preservation, zero-deps]
dependency_graph:
  requires:
    - Plan 08-01 (atomic-write.ts + index.ts barrel — preserved, not disturbed)
    - Plan 08-02 (collisions.ts + processes.ts + their index.ts exports — preserved, not disturbed)
    - packages/internal/src/scanner/scan-memory.ts (the scanner whose output this patcher will consume in Plan 05)
  provides:
    - packages/internal/src/remediation/frontmatter.ts (patchFrontmatter + FrontmatterPatchResult discriminated union)
    - Three-case hand-rolled YAML frontmatter patcher (prepend / inject / refresh) with exotic-YAML skip path
    - D-07 idempotent timestamp refresh (re-flagging a file updates ccaudit-flagged only; ccaudit-stale is left untouched)
    - CRLF line-ending preservation on write (detected once on read, reused on every writeback)
    - BOM transparency (leading U+FEFF stripped before the opening fence check)
    - Flat-YAML regex grammar: EXOTIC_INDENT + EXOTIC_FOLDED_SCALAR + EXOTIC_ARRAY_ITEM + FLAT_KV
  affects:
    - Wave 1 bust orchestrator (Plan 08-05): imports patchFrontmatter from '@ccaudit/internal/remediation' for the RMED-07 memory-flag step
    - Plan 08-04 manifest writer: emits 'flag' (patched/hadFrontmatter/hadCcauditStale) vs 'refresh' (previousFlaggedAt) vs 'skipped' (reason: exotic-yaml) ops based on the result discriminant
    - Phase 9 restore: reads the 'flag' / 'refresh' ops to decide whether to strip the ccaudit keys or leave the prior flag in place
tech_stack:
  added:
    - Zero external YAML dependency — hand-rolled line-based patcher using only node:fs/promises + node:path
  patterns:
    - Discriminated result type (patched | refreshed | skipped) enforces caller pattern-matching before field access
    - Conservative exotic-YAML detection: three anchored regexes reject anything beyond top-level flat key:value (safer to skip than mis-patch)
    - Line-ending style detected once (crlf boolean) and reused for every eol-joined writeback — no mixed-ending output
    - Dual index: bodyLines-relative index for ccaudit-key search, lines-absolute index for rewrite (`+1` offset for the opening fence)
    - Real-tmpdir test strategy with mkdtemp fixtures — no dependency injection, tests validate actual disk writes and reads
key_files:
  created:
    - packages/internal/src/remediation/frontmatter.ts (386 lines including in-source tests)
    - .planning/phases/08-remediation-core/08-03-SUMMARY.md (this file)
  modified:
    - packages/internal/src/remediation/index.ts (appended patchFrontmatter + FrontmatterPatchResult barrel exports below Plans 01 + 02 blocks; prior exports preserved byte-for-byte)
decisions:
  - D-07 idempotent refresh semantics encoded as a distinct 'refreshed' status variant (not 'patched' with a flag) so the Plan 04 manifest writer can emit a separate op_type
  - D-08 hand-rolled patcher chosen over js-yaml / yaml to honor the zero-runtime-deps invariant; flat-YAML grammar is the entire surface we support
  - Exotic-YAML detection errs on the side of refusal — any indented non-comment line, any folded/literal scalar marker, any `- foo` array item, any unterminated block, any non-matching key:value line all return skipped/exotic-yaml
  - Empty file is treated as the no-frontmatter case (not a special edge) — the split yields `['']`, the `---` check fails on line 0, and the prepend branch runs uniformly
  - BOM stripped transparently (U+FEFF on line 0 sliced off before the fence check) — some real-world markdown editors emit it
  - Real-tmpdir tests over injected-fs tests — the behavior under test IS the disk round-trip (read-detect-patch-write), so injecting fs would shrink the assertion surface
  - Test names use `→` (Unicode U+2192) to match the plan's acceptance criteria text verbatim
requirements_completed: [RMED-07]
metrics:
  duration: ~4 minutes (4m24s wall-clock)
  completed_date: 2026-04-05
  tasks_completed: 1 (TDD: RED → GREEN → chore)
  commits: 3
  tests_added: 12 (in frontmatter.ts, all passing)
  full_remediation_suite: 100 passing + 1 skipped (up from 88+1 post-Plan-02, delta exactly +12)
  full_workspace_tests: 430 passing + 1 skipped (up from 418+1 post-Plan-02, delta exactly +12)
---

# Phase 8 Plan 03: Hand-Rolled YAML Frontmatter Patcher Summary

Shipped a line-based `patchFrontmatter` with a three-case discriminated result (prepend / inject-or-refresh / skip-exotic) that flags memory files with `ccaudit-stale: true` + `ccaudit-flagged: <iso>`, honors D-07 idempotent re-flagging by refreshing only the timestamp on repeat passes, preserves CRLF line endings byte-for-byte, and refuses to touch anything beyond top-level flat `key: value` (folded scalars, nested keys, arrays, and unterminated blocks all return `{status:'skipped', reason:'exotic-yaml'}`). Zero runtime deps — `node:fs/promises` + `node:path` only.

## Performance

- **Duration:** ~4 minutes (4m24s wall-clock)
- **Started:** 2026-04-05T15:20:08Z
- **Completed:** 2026-04-05T15:24:32Z
- **Tasks:** 1 (TDD: RED → GREEN → chore)
- **Files modified:** 2 (1 created + index.ts barrel)

## Accomplishments

- **Three-case patcher** — Case 1 (no frontmatter, the dominant real-world case per RESEARCH empirical sampling): prepend a fresh `---\nccaudit-stale: true\nccaudit-flagged: <iso>\n---\n\n` block and re-join the original body with the detected line-ending style. Case 2 (flat key:value frontmatter): walk the body, locate the closing fence, inject whichever ccaudit keys are missing immediately before the closing `---`; unrelated keys are preserved byte-for-byte. Case 3 (already has `ccaudit-stale: true`): D-07 idempotent refresh — rewrite the `ccaudit-flagged` value line in place, leave everything else alone, return `{status:'refreshed', previousFlaggedAt}` so the Plan 04 manifest writer can emit a distinct `refresh` op.
- **Conservative exotic-YAML detection** — Three regexes (EXOTIC_INDENT, EXOTIC_FOLDED_SCALAR, EXOTIC_ARRAY_ITEM) plus a fourth flat-KV pattern (FLAT_KV) are the entire grammar. Any indented non-comment line, any `key: >` / `key: |` folded-scalar marker, any top-level `- foo` array item, any unterminated block, and any line that does not match `[A-Za-z0-9_.-]+:.*` all return `{status:'skipped', reason:'exotic-yaml'}`. The file is left untouched. Folded-scalar detection runs before indent detection because the `description: >` line itself is NOT indented — its body continues on subsequent indented lines which EXOTIC_INDENT then catches.
- **CRLF preservation** — Line ending style is detected once on read (`crlf = /\r\n/.test(raw)`), stored in a local `eol` constant, and reused on every writeback (both the case-1 prepend and the case-2 / case-3 in-place rewrite). A lone-LF regex assertion in the test suite (`/(?<!\r)\n/`) catches any mixing regression.
- **BOM transparency** — A leading U+FEFF on line 0 is stripped before the fence check runs. Real-world markdown editors (VSCode with some encoders, Visual Studio) occasionally emit a BOM and we want the patcher to still recognize the frontmatter fence rather than misclassify the file as case 1.
- **Empty-file edge case folded into case 1** — The empty-string input yields `[''].split` → `['']`, the `---` fence check fails, and the prepend branch runs uniformly. An empty body after the prepend (raw was `''`) does not get a double newline — the `body === '' ? block + eol : block + eol + body` guard handles this.
- **Full-disk tests over injected-fs tests** — The behavior under test IS the read-detect-patch-write round trip, so 12 in-source tests use `mkdtemp` fixtures in `os.tmpdir()` and exercise the real `readFile` / `writeFile` paths. 11 fixture tests (10 from RESEARCH Pattern 4 + the 11th idempotency round-trip) plus the non-existent-file read-error test.

## Task Commits

Task 1 landed as three atomic commits via TDD (RED → GREEN → chore), as documented in the task-commit-protocol for `tdd="true"` tasks:

| # | Hash      | Type     | Description                                                    |
| - | --------- | -------- | -------------------------------------------------------------- |
| 1 | `80e94cd` | test     | Add failing frontmatter patcher tests (RED)                    |
| 2 | `2413b3e` | feat     | Implement hand-rolled frontmatter patcher (GREEN)              |
| 3 | `046d887` | chore    | Export patchFrontmatter barrel + rename test arrows            |

**Commit 1 (RED, `80e94cd`):** Created `packages/internal/src/remediation/frontmatter.ts` with the full 12-test in-source block and a stub `patchFrontmatter` that returned `{status:'skipped', reason:'read-error'}` for every call. Vitest reported 11 failed + 1 passed (the non-existent-file test accidentally matched the stub).

**Commit 2 (GREEN, `2413b3e`):** Replaced the stub with the complete 140-line implementation (read → detect EOL → detect frontmatter fence → walk body → dispatch case 1/2/3 → write with preserved EOL). All 12 tests now pass.

**Commit 3 (chore, `046d887`):** Appended `export { patchFrontmatter } from './frontmatter.ts'` and `export type { FrontmatterPatchResult } from './frontmatter.ts'` to `packages/internal/src/remediation/index.ts` below the existing Plans 01 + 02 export blocks (preserved byte-for-byte). Also normalized the 11 in-source test names to use `→` (Unicode U+2192) instead of `->` so they match the plan's acceptance-criteria wording verbatim.

## Files Created/Modified

- `packages/internal/src/remediation/frontmatter.ts` — **CREATED** (386 lines including the in-source test block). Public API: `patchFrontmatter(filePath, nowIso)` + `FrontmatterPatchResult` discriminated union type. Module-private: `EXOTIC_INDENT`, `EXOTIC_FOLDED_SCALAR`, `EXOTIC_ARRAY_ITEM`, `FLAT_KV` regex constants. In-source tests: 12 passing (10 fixtures + round-trip idempotency + non-existent-file read-error).
- `packages/internal/src/remediation/index.ts` — **MODIFIED** (added 4 lines at the end: comment + value export + type export, following the existing Plan 01 / Plan 02 block convention). The 9 prior export lines from Plans 01 + 02 are preserved byte-for-byte.

## Decisions Made

- **D-07 encoded as a distinct `'refreshed'` status variant** — rather than reusing `'patched'` with a `wasRefresh: true` flag. Rationale: the Plan 04 manifest writer will emit a separate `refresh` op_type per D-11, and having the status variant match the op_type one-for-one lets the orchestrator call-site pattern-match on `result.status` directly instead of destructuring twice.
- **D-08 hand-rolled over js-yaml / yaml** — honoring the zero-runtime-deps invariant from CLAUDE.md and PROJECT.md. RESEARCH § Pattern 4's "Don't Hand-Roll" table explicitly rejected js-yaml and yaml; our grammar is small enough (top-level flat `key: value`) that a ~140-line line-based patcher is more robust than a 40-line parser-library wrapper that would need to handle every YAML 1.2 construct.
- **Exotic-YAML detection errs on the side of refusal** — any line in the frontmatter body that does not match `^[A-Za-z0-9_.-]+:.*$` after the comment/blank filter falls through to `{status:'skipped', reason:'exotic-yaml'}`. The three anchored exotic regexes (indent, folded-scalar, array) give a named check for the most common exotic cases, and the fall-through catches anything else. Better to skip a file than to half-patch it and corrupt the user's frontmatter.
- **Folded-scalar check precedes indent check** — a `description: >` line is NOT indented itself; its continuation lines ARE. EXOTIC_FOLDED_SCALAR catches the marker line; EXOTIC_INDENT catches the body lines. Both branches must exist because the body lines come BEFORE the parser could otherwise decide whether the block is exotic.
- **Empty file folded into case 1** — rather than treating it as a separate branch. The uniform `body === '' ? block + eol : block + eol + body` guard handles the "no double newline after the prepend" edge case without a special code path.
- **Real-tmpdir tests over injected-fs tests** — every sibling module in `packages/internal/src/remediation/` (atomic-write, collisions, processes) uses injected deps for `child_process`, `fs.rename`, and `stat` because those dependencies are hard to reproduce reliably on CI (Windows EPERM, platform-specific `ps` output, etc.). Frontmatter patching has no such platform variance — `readFile` + `writeFile` behave identically on POSIX and Windows — so tests exercise the real fs round-trip via `mkdtemp` fixtures. 12/12 tests pass in ~15ms total.
- **Module-level `import path from 'node:path'`** — rather than `const path = await import('node:path')` inside the test block. The sibling `atomic-write.ts` does the same (`path` at module scope, `mkdtemp` / `tmpdir` / `rm` dynamically imported inside the test block). Node:path is tiny and the patcher's test code uses `path.join` multiple times per test.

## Deviations from Plan

### Auto-fixed issues

None. The plan's `<action>` section provided the complete file content and it compiled, passed typecheck, and passed all 12 tests on the first GREEN run. No Rule 1 / Rule 2 / Rule 3 fixes were required.

### Other deviations (documented for traceability)

**1. [Cosmetic — test name normalization] Unicode arrow `→` for acceptance-criteria parity**
- **Found during:** Pre-commit acceptance-criteria review
- **Issue:** The plan's `<acceptance_criteria>` section lists test names with `→` (Unicode U+2192) verbatim, but the plan's `<action>` code block used ASCII `->`. The test-name substring match in the acceptance criteria is a soft check (vitest run exit code is the hard check), but aligning to the plan text verbatim is zero-cost and future-proofs the criteria.
- **Fix:** Replaced `->` with `→` in 11 of the 12 test names (the non-existent-file test also uses `→` now for consistency).
- **Files modified:** `packages/internal/src/remediation/frontmatter.ts`
- **Verification:** All 12 tests still pass; test output now matches the plan's acceptance criteria string-for-string.
- **Committed in:** `046d887` (folded into the chore commit alongside the barrel export).

**Total deviations:** 1 cosmetic (test name normalization for plan-acceptance-criteria parity).
**Impact on plan:** None. Zero behavior change, zero test count change, zero code-path change. Documentation alignment only.

## Issues Encountered

- None. The plan's `<action>` code block was complete and correct; the implementation landed on the first GREEN run without revisions.

## Verification Results

**Plan-specific verification:**

```
$ pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts
 ✓ |@ccaudit/internal| src/remediation/frontmatter.ts (12 tests) 11ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

All 12 tests pass with the exact test names from the plan's acceptance criteria:

1. fixture 01: no frontmatter → prepends block
2. fixture 02: empty frontmatter → injects both keys
3. fixture 03: unrelated keys → injects ccaudit keys, preserves others
4. fixture 04: has ccaudit-stale → refreshed (D-07)
5. fixture 05: folded scalar → skipped exotic-yaml
6. fixture 06: array item → skipped exotic-yaml
7. fixture 07: nested key → skipped exotic-yaml
8. fixture 08: CRLF line endings → preserved on write
9. fixture 09: unterminated frontmatter → skipped exotic-yaml
10. fixture 10: empty file → prepends fresh block
11. round-trip idempotency: second patch refreshes first
12. non-existent file → skipped read-error

**Typecheck:**

```
$ pnpm -F @ccaudit/internal typecheck
> tsc
(exit 0, no output)
```

**Full remediation suite regression:**

```
$ pnpm exec vitest --run packages/internal/src/remediation/
 ✓ src/remediation/savings.ts       (5 tests)
 ✓ src/remediation/change-plan.ts   (12 tests)
 ✓ src/remediation/collisions.ts    (15 tests)
 ✓ src/remediation/processes.ts     (21 tests)
 ✓ src/remediation/atomic-write.ts  (15 tests | 1 skipped)
 ✓ src/remediation/frontmatter.ts   (12 tests)  — NEW in 08-03
 ✓ src/remediation/checkpoint.ts    (21 tests)
 Test Files  7 passed (7)
      Tests  100 passed | 1 skipped (101)
```

Delta vs. post-Plan-02 baseline (`88 passing + 1 skipped`): exactly `+12` tests, zero regressions.

**Full workspace regression:**

```
$ pnpm exec vitest --run
 Test Files  49 passed (49)
      Tests  430 passed | 1 skipped (431)
```

Delta vs. post-Plan-02 baseline (`418 passing + 1 skipped`): exactly `+12` tests, zero regressions.

**Acceptance criteria (plan-level):**

- `test -f packages/internal/src/remediation/frontmatter.ts` — PASS
- `grep -q "export async function patchFrontmatter"` — PASS
- `grep -q "export type FrontmatterPatchResult"` — PASS
- `grep -q "ccaudit-stale: true"` — PASS
- `grep -q "ccaudit-flagged"` — PASS
- `grep -q "'exotic-yaml'"` — PASS
- `grep -q "'refreshed'"` — PASS
- `grep -q "EXOTIC_FOLDED_SCALAR"` — PASS
- `grep -q "EXOTIC_ARRAY_ITEM"` — PASS
- `grep -q "FLAT_KV"` — PASS
- `grep -q "crlf"` — PASS
- `grep -q "export { patchFrontmatter } from './frontmatter.ts'"` in index.ts — PASS
- `pnpm exec vitest --run packages/internal/src/remediation/frontmatter.ts` exits 0 — PASS
- All 12 named tests from the plan's acceptance criteria pass verbatim — PASS

## Plans 01 + 02 Preservation Check

The plan explicitly required that `index.ts` barrel exports from Plans 01 (atomic-write) and 02 (collisions + processes) be preserved byte-for-byte. Verified:

```
$ git show 046d887 -- packages/internal/src/remediation/index.ts | grep '^[+-]'
+
+// Phase 8: hand-rolled YAML frontmatter patcher for memory-file flagging
+// (D-07 idempotent refresh, D-08 three-case handling: prepend / inject / skip)
+export { patchFrontmatter } from './frontmatter.ts';
+export type { FrontmatterPatchResult } from './frontmatter.ts';
```

Only 4 lines added (plus 1 leading blank line). Zero lines removed, zero lines modified. All 9 prior export lines from Plans 01 + 02 are intact. Phase 7's 21 checkpoint.ts regression tests + Plan 01's 15 atomic-write.ts tests + Plan 02's 15 collisions.ts + 21 processes.ts tests all still pass.

## Known Stubs

None. The patcher is complete, tested, and production-ready. No TODO / FIXME / XXX / placeholder markers, no hardcoded empty values, no components wired to mock data. `grep -nE 'TODO|FIXME|XXX|placeholder' packages/internal/src/remediation/frontmatter.ts` returns zero matches.

## Threat Flags

None. The patcher:

- Reads and writes files only under paths passed to it by the caller (no path traversal surface — the caller is responsible for providing the scanned memory file paths).
- Uses `node:fs/promises` exclusively (no child_process, no network, no shell expansion).
- Does not parse user input as code or YAML beyond simple regex matching on top-level flat key:value lines.
- Does not execute or evaluate any content from the files it patches.
- Fails closed on exotic input (returns skipped, leaves file untouched) rather than attempting to mutate ambiguous YAML.

No new network endpoints, no authentication paths, no schema changes at trust boundaries. `{status:'skipped', reason:'exotic-yaml'}` on any non-flat input is the primary defense against YAML-injection-style attacks on frontmatter content.

## Next Plan Readiness

Wave 0 is now at 4/5 shared infrastructure modules complete:

1. `atomic-write.ts` — Plan 01 ✅
2. `collisions.ts` — Plan 02 ✅
3. `processes.ts` — Plan 02 ✅
4. `frontmatter.ts` — Plan 03 ✅ (this plan)
5. `manifest.ts` — Plan 04 (next)

The remaining Wave 0 module is the JSONL append-only manifest writer per D-09 / D-10 / D-11 / D-12. It has no cross-dependency on frontmatter.ts — the frontmatter patcher and the manifest writer are both consumed by the Wave 1 bust orchestrator but they do not call each other. Plan 04 can begin immediately.

The Wave 1 bust orchestrator (Plan 05) will import from this plan via:

```ts
import { patchFrontmatter } from '@ccaudit/internal/remediation';
import type { FrontmatterPatchResult } from '@ccaudit/internal/remediation';
```

Both exports are barrel-exported from `packages/internal/src/remediation/index.ts` and typecheck-clean. The result type's three discriminants map 1-for-1 to three manifest op_types (`flag`, `refresh`, `skipped`) per D-11.

## Self-Check: PASSED

**Created files:**
- `packages/internal/src/remediation/frontmatter.ts` — FOUND (verified via `test -f`)
- `.planning/phases/08-remediation-core/08-03-SUMMARY.md` — FOUND (this file)

**Modified files:**
- `packages/internal/src/remediation/index.ts` — FOUND (patchFrontmatter + FrontmatterPatchResult barrel exports added below Plans 01 + 02 blocks; all prior exports preserved byte-for-byte)

**Commits (all three verified present in git log):**
- `80e94cd` — FOUND (test: add failing frontmatter patcher tests — RED)
- `2413b3e` — FOUND (feat: implement hand-rolled frontmatter patcher — GREEN)
- `046d887` — FOUND (chore: export patchFrontmatter barrel + rename test arrows)

**Acceptance criteria (plan success criteria):**
- patchFrontmatter handles all 3 cases (prepend / inject / refresh) with flat-YAML parsing — PASS
- Exotic YAML constructs (folded scalars, nested keys, arrays, unterminated blocks) return skipped with reason — PASS
- CRLF line endings preserved on write — PASS (verified by lone-LF regex assertion)
- D-07 idempotent refresh updates ccaudit-flagged timestamp and preserves ccaudit-stale — PASS
- All 12 in-source tests pass (10 fixtures + idempotency + read-error) — PASS
- Zero runtime deps (no js-yaml, no yaml) — PASS (only node:fs/promises + node:path)
- Typecheck clean (`pnpm -F @ccaudit/internal typecheck` exits 0) — PASS
- Full remediation suite regression: 100 passing + 1 skipped — PASS
- Full workspace regression: 430 passing + 1 skipped, zero regressions — PASS

---
*Phase: 08-remediation-core*
*Plan: 03*
*Completed: 2026-04-05*
