---
phase: 06-output-control-polish
plan: 06
subsystem: infra
tags: [pnpm, tsdown, clean-pkg-json, npm-pack, monorepo, regression-fix, gap-closure]

requires:
  - phase: 06-output-control-polish
    provides: Plan 06-03 added @vitest/coverage-v8 catalog reference; Plan 06-04 added npm metadata (keywords/license/author/homepage/repository)
provides:
  - Restored apps/ccaudit/package.json scripts block (build/test/typecheck/prepack) and devDependencies block (10 entries) that commit e3dbe01 had accidentally deleted
  - Publication-ready apps/ccaudit manifest that unions Plan 06-04's metadata with the pre-regression scripts/devDeps
  - Regenerated apps/ccaudit/dist/index.js from current post-06-02 source (ships --quiet/--csv/--ci flags)
  - Empirical proof that `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -F ccaudit test` no longer silently skip apps/ccaudit
  - Verified `npm pack --dry-run` succeeds on a real fresh build artifact (not the stale 15:56 pre-regression leftover)
affects:
  - Phase 06 verifier re-run (Gap #2 now closed; ROADMAP SC-5 genuinely satisfied)
  - Any future publication/release workflow (prepack hook + clean-pkg-json chain confirmed working)
  - Plan 06-05 (CI coverage gap closure) — will rely on the same restored apps/ccaudit/package.json to invoke vitest --coverage

tech-stack:
  added: []
  patterns:
    - "Minimum-diff field-order preservation: when re-unioning regressed JSON, keep HEAD's existing field order and append the restored blocks at the tail, producing the smallest possible diff"

key-files:
  created:
    - .planning/phases/06-output-control-polish/06-06-SUMMARY.md
  modified:
    - apps/ccaudit/package.json
    - apps/ccaudit/dist/index.js (gitignored; regenerated via tsdown)

key-decisions:
  - "Sourced the restored scripts/devDeps from cb0932f (last commit before e3dbe01 regression), not re-derived from memory — verbatim fidelity to the pre-regression source of truth"
  - "Preserved e3dbe01's resolved homepage/repository URLs (0xD-Fabio/ccaudit from git remote) rather than the helldrik/ccaudit placeholder the original 06-04 plan file contained"
  - "Documented clean-pkg-json's working-tree mutation side effect: npm pack --dry-run runs prepack which strips scripts/devDeps from the on-disk file; the dev must restore or work on a branch for publish"

patterns-established:
  - "Gap-closure plans: restore-verify-commit cycle with per-task atomic commits and explicit verbatim JSON targets in the plan body"
  - "Union-restore pattern: when a regression commit did BOTH a legitimate addition AND an accidental deletion, the fix is a minimum-diff union (preserve HEAD additions, append/restore deletions)"

requirements-completed: [OUTP-06]

duration: 4min
completed: 2026-04-04
---

# Phase 06 Plan 06: Gap #2 Closure — Restore apps/ccaudit scripts & devDependencies Summary

**Restored the scripts and devDependencies blocks in apps/ccaudit/package.json that commit e3dbe01 accidentally deleted, regenerated dist/index.js from current source, and empirically proved the build/test/pack pipeline now works end-to-end.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-04T16:45:35Z
- **Completed:** 2026-04-04T16:49:06Z
- **Tasks:** 3 (1 edit + 1 build + 1 verification)
- **Files modified:** 1 tracked (apps/ccaudit/package.json) + 1 gitignored (apps/ccaudit/dist/index.js)

## Accomplishments

- **Scripts block restored**: 4 scripts re-added to apps/ccaudit/package.json — `build: tsdown`, `test: TZ=UTC vitest`, `typecheck: tsc --noEmit`, `prepack: pnpm run build && clean-pkg-json`
- **devDependencies block restored**: 10 entries re-added — 2 workspace refs (`@ccaudit/internal`, `@ccaudit/terminal`), 7 catalog refs (`@vitest/coverage-v8`, `gunshi`, `valibot`, `tsdown`, `vitest`, `clean-pkg-json`, `typescript`), and `@types/node`
- **e3dbe01 metadata preserved**: keywords, license (MIT), author (Fabio D.), homepage, repository — all intact, all pointing at the resolved `0xD-Fabio/ccaudit` origin remote
- **pnpm install re-linked workspace deps**: Scope went from `3 of 4 workspace projects` back to `all 4 workspace projects`, confirming @ccaudit/internal and @ccaudit/terminal symlinks are re-registered
- **Fresh dist/index.js built from current source**: tsdown produced 295.93 kB (gzip 71.63 kB) bundle with shebang on line 1, `--quiet`/`--csv`/`--ci` flags visible via `ghost --help`, and `import.meta.vitest` fully stripped
- **All 5 Behavioral Spot-Check #10 verifications now pass** (previously 1 pass / 4 fail):
  1. `pnpm -r build` — exit 0, `apps/ccaudit build$ tsdown` runs, zero `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` matches
  2. `pnpm -r typecheck` — exit 0, `apps/ccaudit typecheck$ tsc --noEmit` runs
  3. `pnpm -F ccaudit test -- --run` — exit 0, **26 tests passed** (was silent-0 before)
  4. `cd apps/ccaudit && npm pack --dry-run` — exit 0, prepack runs tsdown + clean-pkg-json, tarball contains `dist/index.js` (295.9 kB), `package.json` (749 B stripped of devDeps), `src/index.ts`
  5. `pnpm -r test -- --run` — exit 0, **283 tests across 38 files** (207 internal + 50 terminal + 26 ccaudit) all pass

## Task Commits

Each task was committed atomically where it had tracked file changes:

1. **Task 1: Restore scripts and devDependencies blocks while preserving e3dbe01 metadata additions** — `0d4b5af` (fix: Gap #2 union restore)
2. **Task 2: Re-link workspace deps via pnpm install and regenerate dist/ via pnpm -F ccaudit build** — no tracked changes to commit (`dist/` is gitignored, `pnpm install` made no lockfile changes); execution proof captured via Task 3's verification logs and this SUMMARY
3. **Task 3: Verify pnpm -r build, pnpm -r typecheck, pnpm -F ccaudit test, and npm pack --dry-run all succeed** — pure verification, no tracked file changes (documented below in the plan-metadata commit)

**Plan metadata:** will be captured in the final `docs(06-06): complete plan 06 gap-closure` commit bundling SUMMARY.md + STATE.md + ROADMAP.md.

_Note: Tasks 2 and 3 are action+verification steps that operate on build artifacts and verification logs. Neither produced new or modified tracked files. Task 1's single commit carries the full source-of-truth change; Tasks 2 and 3 are fully documented by the captured command output below and the logs in `/tmp/ccaudit-pr-build.log`, `/tmp/ccaudit-pr-typecheck.log`, `/tmp/ccaudit-pf-test.log`, `/tmp/ccaudit-npm-pack.log`, `/tmp/ccaudit-pr-test.log`._

## Files Created/Modified

- `apps/ccaudit/package.json` — unioned restoration: HEAD's metadata block (name through engines) kept in order, then scripts and devDependencies blocks appended from cb0932f verbatim. Final size: 58 lines, 1081 bytes. Valid JSON, all 14 top-level keys present.
- `apps/ccaudit/dist/index.js` — **gitignored**, regenerated from current source via `rm -rf apps/ccaudit/dist && pnpm -F ccaudit build`. Contains post-06-02 CLI wiring (--quiet/--csv/--ci flags behaviorally verified via `ghost --help`), stripped in-source tests, and the shebang `#!/usr/bin/env node` on line 1.
- `.planning/phases/06-output-control-polish/06-06-SUMMARY.md` — this file.

## Decisions Made

- **Source-of-truth discipline**: Sourced the restored blocks from `git show cb0932f:apps/ccaudit/package.json` (the immediate parent of the regression commit e3dbe01) rather than re-deriving from memory or Plan 06-03's spec. Verbatim-from-git is the only reliable approach for regression reversal — any paraphrase or "improvement" risks silent drift.
- **URL preservation over plan fidelity**: The original Plan 06-04 text used a `helldrik/ccaudit` placeholder for `homepage` and `repository.url`, but when the executor ran e3dbe01 it correctly resolved these via `git remote get-url origin` to `0xD-Fabio/ccaudit`. This resolution is on HEAD today and must NOT be reverted — the plan file's placeholder was wrong; the executor's resolution was right. Plan 06-06 explicitly called this out and I preserved the resolved `0xD-Fabio/ccaudit` values.
- **Minimum-diff field order**: Kept HEAD's top section (name → engines) in its existing order and appended `scripts` + `devDependencies` at the tail, rather than re-ordering to match cb0932f's historical layout. This produces the smallest possible diff against HEAD and is easier to audit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking/operational] clean-pkg-json mutates working-tree package.json during `npm pack --dry-run`**

- **Found during:** Task 3, Check 4 (`cd apps/ccaudit && npm pack --dry-run`)
- **Issue:** The `prepack` hook chain is `pnpm run build && clean-pkg-json`. `clean-pkg-json` is designed to strip dev-only fields (scripts, devDependencies, etc.) from `./package.json` in place before `npm pack` reads it. This is correct behavior for a publish pipeline but has an unpleasant side effect during `--dry-run`: it leaves the working-tree `apps/ccaudit/package.json` stripped of `scripts` and `devDependencies` on disk after the dry-run completes — i.e., the exact Gap #2 broken state we just fixed in Task 1. If left unhandled, Task 3's own verification step would undo Task 1's committed fix.
- **Fix:** After `npm pack --dry-run` completed its verification, I restored `apps/ccaudit/package.json` to the fully-committed Task 1 state (byte-for-byte identical to commit `0d4b5af`) before proceeding to Check 5. Verified zero diff with `git diff apps/ccaudit/package.json` before continuing.
- **Files modified:** `apps/ccaudit/package.json` (restored, no net change relative to Task 1 commit)
- **Verification:** `git status --short apps/ccaudit/package.json` empty after restoration; `git diff` empty; subsequent `pnpm -r test -- --run` (Check 5) ran against the restored file and passed 283 tests.
- **Committed in:** Not committed separately — the restoration returned the file to the already-committed state (0d4b5af), so no new tracked changes exist.

**Operational note for future release work:** The `clean-pkg-json` working-tree mutation is a known quirk of the ccusage pattern. In a real publish workflow, this is safe because (a) the publish runs from a throwaway branch/worktree, or (b) the publishing CI cleans up after `npm publish` completes. For local dry-runs, the current dev must either stash first, use `git checkout -- apps/ccaudit/package.json` after, or run dry-runs in a worktree. This is NOT a ccaudit-specific issue and doesn't warrant a plan change — it's a clean-pkg-json design choice. Calling this out in the SUMMARY so Plan 06-05 (the last Phase 6 gap closure) and any future release plan are aware of it.

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking operational side effect of the verification command itself)
**Impact on plan:** The deviation was a self-inflicted side effect of Task 3's own verification command, not an upstream bug. Auto-fix was trivial (re-run Write with the same content already committed in Task 1). No scope creep, no architectural change, no follow-on work. All 5 verification checks passed end-to-end after the fix.

## Issues Encountered

- **`grep -q '\-\-csv' apps/ccaudit/dist/index.js` in the plan's automated verify block returned non-zero** even though the fresh build was correct. Investigation showed gunshi synthesizes the `--csv` CLI flag name at runtime from the object key `csv` — there is no literal `"--csv"` string in the bundled output. The flag IS wired (proven by `node apps/ccaudit/dist/index.js ghost --help` listing `--csv`, `--ci`, `-q, --quiet`). I used the behavioral `ghost --help | grep` check instead of the literal-string check to validate Task 2's done criteria, which matches the task's `<done>` section intent ("help output lists --quiet, --csv, --ci"). The grep-in-dist check in the plan's `<automated>` verify block is an imperfect proxy that doesn't account for how gunshi compiles flag names from keys; this is a minor plan-spec issue, not a code issue.
- **Tasks 2 and 3 produced no committable tracked changes.** `dist/` is gitignored, `pnpm install` made no lockfile changes (resolution was already up to date), and Task 3 is pure verification. Per the task_commit_protocol's "do not create an empty commit" rule, Task 2 and Task 3 are covered by (a) Task 1's single restoration commit which is the actual code change, and (b) this SUMMARY.md which documents the verification evidence with full log captures. The final plan-metadata commit (below) bundles SUMMARY.md + STATE.md + ROADMAP.md as the completion marker.

## Next Phase Readiness

- **Gap #2 is closed empirically**, not just on paper. ROADMAP SC-5 ("README, npm metadata, and package are publication-ready") is now truly satisfied: a fresh clone can run `pnpm install && pnpm -F ccaudit build && cd apps/ccaudit && npm pack --dry-run` and produce a publishable tarball containing the current source-built binary.
- **Plan 06-05 (CI coverage gap closure, Gap #1) is unblocked**: it depends on a working `pnpm -F ccaudit` test invocation path and on `@vitest/coverage-v8` being declared in `apps/ccaudit/package.json`. Both are now true.
- **Phase 6 verifier re-run is ready**: all Behavioral Spot-Check #10 failures are resolved. Once Plan 06-05 closes Gap #1, the re-verification should return `status: verified`.
- **No new blockers or concerns introduced.** The clean-pkg-json working-tree mutation quirk is noted as a deviation but is not a blocker — it's a well-understood behavior of a ccusage-aligned tool, relevant only for dev-side `npm pack --dry-run` invocations.

## Self-Check: PASSED

- File existence: `apps/ccaudit/package.json` present with 14 top-level keys (scripts + devDependencies confirmed); `apps/ccaudit/dist/index.js` present (gitignored) with shebang and post-06-02 flags; `.planning/phases/06-output-control-polish/06-06-SUMMARY.md` present (this file).
- Commit existence: `git log --oneline | grep 0d4b5af` — FOUND (Task 1 commit).
- All 5 verification checks passed (build, typecheck, test, pack, full-suite).
- Zero `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` in any log.
- 283 tests pass across the full monorepo.

---
*Phase: 06-output-control-polish*
*Plan: 06 (Gap #2 closure)*
*Completed: 2026-04-04*
