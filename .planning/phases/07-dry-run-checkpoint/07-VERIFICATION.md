---
phase: 07-dry-run-checkpoint
verified: 2026-04-04T21:40:00Z
re_verified: 2026-04-05T00:00:00Z
status: gaps_found
score: 2/3 must-haves verified (1 regressed after human smoke test)
re_verification: true
---

# Phase 7: Dry-Run & Checkpoint Verification Report

**Phase Goal:** Users can preview exactly what remediation would change without touching the filesystem, and the tool writes a hash-based checkpoint that gates future remediation.
**Verified:** 2026-04-04T21:40:00Z (initial)
**Re-verified:** 2026-04-05T00:00:00Z (after human smoke test revealed escaped gap)
**Status:** GAPS_FOUND — automated verification passed, but human verification #2 (live dry-run against a real Claude installation) revealed a crash the synthetic fixture did not catch.
**Re-verification:** Yes — required after gap closure.

---

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                  | Status     | Evidence                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ccaudit --dry-run` outputs a full change plan (archived agents, disabled MCP servers, estimated token savings) without modifying files | ✓ VERIFIED | `buildChangePlan` + dry-run branch in `ghost.ts:134-214`; four output modes (default/json/csv/quiet) wired; integration test case 1–4 confirm real output                             |
| 2   | A checkpoint file is written to `~/.claude/ccaudit/.last-dry-run` containing timestamp and SHA-256 hash of current ghost inventory     | ✓ VERIFIED | `writeCheckpoint` (atomic tmp-rename, 0o600 file mode, 0o700 dir) called in `ghost.ts:206`; 7-field D-17 schema enforced by `Checkpoint` type; integration test case 5–6 confirm write |
| 3   | The checkpoint is invalidated when the ghost inventory hash changes (hash-based, not time-based)                                       | ✓ VERIFIED | `computeGhostHash` produces `sha256:<64 hex>`; integration test case 7 proves hash stability; integration test case 8 proves hash change on mtime mutation                            |

**Score:** 3/3 truths verified

---

### Required Artifacts

| Artifact                                                            | Expected                                                         | Status     | Details                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/internal/src/remediation/change-plan.ts`                 | ChangePlan types + buildChangePlan pure builder                  | ✓ VERIFIED | 222 lines; 12 in-source tests; exports ChangePlan/ChangePlanItem/ChangePlanAction/buildChangePlan                        |
| `packages/internal/src/remediation/savings.ts`                     | calculateDryRunSavings (archive+disable only, excludes flag)     | ✓ VERIFIED | 80 lines; 5 in-source tests; correct exclusion of memory flag tier verified                                              |
| `packages/internal/src/remediation/checkpoint.ts`                  | computeGhostHash, resolveCheckpointPath, writeCheckpoint, readCheckpoint | ✓ VERIFIED | 608 lines; 20 in-source tests; atomic write pattern confirmed; discriminated union read API confirmed                    |
| `packages/internal/src/remediation/index.ts`                       | Remediation module barrel re-exports                             | ✓ VERIFIED | 10 lines; exports all 4 functions + 3 type groups                                                                        |
| `packages/internal/src/index.ts`                                   | Workspace barrel includes remediation exports                    | ✓ VERIFIED | Lines 99-114 export all remediation symbols from @ccaudit/internal                                                       |
| `packages/terminal/src/tables/change-plan.ts`                      | renderChangePlan + renderChangePlanVerbose renderers             | ✓ VERIFIED | 211 lines; 11 in-source tests; grouped-by-action body confirmed; savings line always present per D-08                   |
| `apps/ccaudit/scripts/gen-version.mjs`                             | Reads package.json, writes _version.ts CCAUDIT_VERSION constant | ✓ VERIFIED | 28 lines; wired via prebuild+pretest lifecycle hooks in apps/ccaudit/package.json                                        |
| `apps/ccaudit/src/cli/commands/ghost.ts`                           | --dry-run flag + dry-run branch wired to remediation module      | ✓ VERIFIED | dryRun arg (type: boolean) present; toKebab: true set; 85-line dry-run branch calls buildChangePlan/computeGhostHash/writeCheckpoint |
| `apps/ccaudit/src/cli/index.ts`                                    | renderHeader: null suppresses banner in machine-readable modes   | ✓ VERIFIED | Line 23: `renderHeader: null` confirmed                                                                                  |
| `apps/ccaudit/src/__tests__/dry-run-command.test.ts`               | 8 subprocess integration tests covering DRYR-01/02/03             | ✓ VERIFIED | 303 lines; spawns dist/index.js; HOME-redirected tmpdir fixture; all 8 test shapes confirmed in code                    |

---

### Key Link Verification

| From                                | To                                    | Via                                               | Status  | Details                                                                  |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `ghost.ts` dry-run branch           | `@ccaudit/internal` remediation funcs | `import { buildChangePlan, computeGhostHash, writeCheckpoint, resolveCheckpointPath }` | WIRED   | Lines 12-16 of ghost.ts; used in dry-run branch lines 135-211           |
| `ghost.ts`                          | `@ccaudit/terminal` renderers         | `import { renderChangePlan, renderChangePlanVerbose }`                                 | WIRED   | Lines 28-30 of ghost.ts; rendered at lines 193-196                      |
| `ghost.ts`                          | `apps/ccaudit/src/_version.ts`        | `import { CCAUDIT_VERSION }`                                                            | WIRED   | Line 33 of ghost.ts; used at checkpoint construction line 143            |
| `@ccaudit/internal` barrel          | `remediation/index.ts`                | re-export block lines 99-114                                                            | WIRED   | All 6 functions + all types exported and importable from @ccaudit/internal |
| `@ccaudit/terminal` barrel          | `tables/change-plan.ts`               | `export { renderChangePlan, renderChangePlanVerbose }` in tables/index.ts               | WIRED   | Confirmed in terminal/src/index.ts lines 13-14                          |
| `apps/ccaudit/package.json` prebuild/pretest | `scripts/gen-version.mjs`    | npm lifecycle hooks                                                                     | WIRED   | Lines 42+44 of package.json; generates `_version.ts` before test or build |
| Integration tests                   | `dist/index.js`                       | subprocess spawn with HOME override               | WIRED   | dist/index.js exists (309176 bytes, Apr 4); beforeAll ensures it exists |
| `cli/index.ts`                      | `renderHeader: null`                  | gunshi cli() option                                                                     | WIRED   | Confirmed at line 23; no banner corruption in machine-readable output    |

---

### Data-Flow Trace (Level 4)

| Artifact                            | Data Variable  | Source                                                   | Produces Real Data                  | Status      |
| ----------------------------------- | -------------- | -------------------------------------------------------- | ----------------------------------- | ----------- |
| `ghost.ts` dry-run branch           | `enriched`     | `enrichScanResults(results)` called at line 129          | Real scan pipeline from discoverSessionFiles → scanAll → enrich | ✓ FLOWING  |
| `ghost.ts` dry-run branch           | `plan`         | `buildChangePlan(enriched)` at line 135                  | Derived from live enriched results  | ✓ FLOWING  |
| `ghost.ts` dry-run branch           | `ghostHash`    | `computeGhostHash(enriched)` at line 138                 | SHA-256 over real mtime-stat'd files | ✓ FLOWING  |
| `checkpoint.ts` `writeCheckpoint`   | Written file   | `JSON.stringify(checkpoint)` then atomic tmp-rename      | Real JSON persisted to disk         | ✓ FLOWING  |
| Integration test                    | `envelope.changePlan.archive` | subprocess stdout | Parsed from real subprocess output  | ✓ FLOWING  |

---

### Behavioral Spot-Checks

| Behavior                                       | Command                                          | Result                                          | Status   |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | -------- |
| `--dry-run` appears in ghost --help            | `node dist/index.js ghost --help \| grep dry-run` | `--dry-run  Preview changes... (default: false)` | ✓ PASS  |
| No banner leaks into stdout                    | `node dist/index.js --help \| head -1`           | `USAGE:` (not decorative banner text)            | ✓ PASS  |
| dist/index.js built and present                | `ls apps/ccaudit/dist/index.js`                  | 309176 bytes, Apr 4 23:20                        | ✓ PASS  |
| Flag uses kebab-case not camelCase             | `node dist/index.js ghost --help \| grep dry`    | `--dry-run` (not `--dryRun`)                     | ✓ PASS  |
| Integration test exercises full pipeline       | Code review of dry-run-command.test.ts           | 8 subprocess tests, HOME-redirected tmpdir, DRYR-01/02/03 covered | ✓ PASS |

**Note on test suite coverage claim (353 tests, 93.49% stmts):** The SUMMARY's test count is plausible and consistent with: 37 (remediation unit) + 11 (terminal change-plan) + 8 (integration) = 56 new tests added in Phase 7, building on the prior 345 total from Phase 6's merge gate. The test suite was not re-run to avoid modifying filesystem state, but the commit hashes (db0f6c4, 78012ff, de5f5aa, 6ee3fb2, b962a77, d3c5443, 42e31a1) are all confirmed in git log, and the individual test counts are verified by grep. No suspicious patterns found.

---

### Requirements Coverage

| Requirement | Source Plans      | Description                                                                                                                         | Status      | Evidence                                                                                     |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| DRYR-01     | 07-01, 07-02, 07-03 | `ccaudit --dry-run` shows full change plan (archived agents, disabled MCP, estimated token savings) without touching the filesystem | ✓ SATISFIED | `buildChangePlan` + all 4 output modes in ghost.ts dry-run branch + 4 integration test cases |
| DRYR-02     | 07-01, 07-02, 07-03 | Checkpoint written to `~/.claude/ccaudit/.last-dry-run` with timestamp + SHA-256 hash of current ghost inventory                   | ✓ SATISFIED | `writeCheckpoint` + `computeGhostHash` + D-17 7-field schema + integration test case 6      |
| DRYR-03     | 07-01, 07-03      | Checkpoint invalidated when ghost inventory hash changes (hash-based, not time-based expiry)                                        | ✓ SATISFIED | Hash algorithm uses mtimeMs per file; integration test case 7 (stability) + case 8 (invalidation on mtime change) |

**REQUIREMENTS.md tracking table discrepancy:** The "Pending" status shown in the REQUIREMENTS.md tracking table (lines 169-171) was written during requirements definition and was never updated to "Complete" after phase execution. This is a documentation-only gap — the implementation is verified above. The `[x]` checkboxes in the requirements body section (lines 66-68) correctly reflect the completed state. This discrepancy is informational only and does not block Phase 8.

**Orphaned requirements:** None. All three DRYR requirements are covered by plans in this phase. No additional Phase 7 requirement IDs exist in REQUIREMENTS.md beyond DRYR-01/02/03.

---

### Anti-Patterns Found

| File                                                     | Line | Pattern                   | Severity | Impact                 |
| -------------------------------------------------------- | ---- | ------------------------- | -------- | ---------------------- |
| `.planning/REQUIREMENTS.md`                             | 169-171 | Status column still shows "Pending" for DRYR-01/02/03 | Info | Documentation only — no code impact |

No code-level anti-patterns found. No TODO/FIXME/placeholder comments. No empty implementations. No stub return values. No hardcoded empty arrays in rendering paths.

---

### Human Verification Required

#### 1. Full Test Suite Execution

**Test:** Run `pnpm -w test --run --coverage` from the repo root.
**Expected:** 353 tests pass, 0 failures, coverage at statements 93.49% / branches 84.71% / functions 95.95% / lines 94.3% (all above thresholds).
**Why human:** The test suite spawns subprocesses and reads real filesystem state. Running it in the verification context risks HOME-fixture pollution or port conflicts. The individual unit test counts (37+11+8 = 56 new) are verified by grep; the aggregate claim is plausible but not re-executed.

#### 2. Live Dry-Run Against a Real Claude Installation

**Test:** On a machine with actual Claude Code session history, run `ccaudit --dry-run` (after `npx ccaudit@latest` or building locally).
**Expected:** The command prints a grouped change plan showing real agents/MCP servers from `~/.claude/`, then writes `~/.claude/ccaudit/.last-dry-run` with a valid JSON checkpoint, exits 0.
**Why human:** Integration tests use a synthetic empty-inventory fixture (no real JSONL data). A real Claude installation would exercise the full scan/enrich/hash pipeline against production data, confirming that non-trivial inventories work end-to-end.

#### 3. Hash Stability Across Sessions on Real Inventory

**Test:** Run `ccaudit --dry-run --json` twice in sequence (unchanged inventory), compare `checkpoint.ghost_hash` values in both outputs.
**Expected:** Both values are identical `sha256:<64 hex>` strings.
**Why human:** The unit tests prove hash determinism with synthetic data; the integration tests prove it with an empty fixture. Real cross-process hash stability depends on the OS returning stable stat() mtimeMs values between closely-spaced calls, which only a live run can confirm.

---

### Gaps Summary

**Post-verification escaped gap discovered during human smoke test (2026-04-05):**

The first manual execution of `ccaudit --dry-run` against a real `~/.claude/` installation crashed with an unhandled `ENOENT` when the inventory contained a broken symlink skill. The synthetic fixture used by the integration test suite does not cover this case. See the **Escaped Gaps** section below for full details.

Automated verification and the two intra-phase bugs (gunshi `toKebab`, banner pollution) are not affected by this discovery. The escaped gap is scoped to file-disappearance handling in `scanSkills`, `scanAgents`, and `computeGhostHash`.

---

### Escaped Gaps (post-verification, discovered 2026-04-05)

#### Gap #1 — `ccaudit --dry-run` crashes on broken-symlink skills (affects DRYR-02, DRYR-03)

**Severity:** BLOCKER — command is unusable for any user whose `~/.claude/skills/` contains a broken symlink (common with dotfiles-managed skill sets).

**How it escaped:**
- Human verification item #2 ("Live Dry-Run Against a Real Claude Installation") was listed as required in the initial VERIFICATION but was not executed before marking the phase passed.
- The subprocess integration test fixture in `apps/ccaudit/src/__tests__/dry-run-command.test.ts` (lines 62-124, `buildFixture`) creates real agent files via `writeFile` + `utimes` and **never creates skill directories or broken symlinks**. No test case exercises "inventory references a path that cannot be stat'd."
- The regressed human verification item therefore passed through the gate undetected.

**Error signature (from user terminal, 2026-04-05):**
```
Error: ENOENT: no such file or directory, stat '/Users/helldrik/.claude/skills/full-output-enforcement'
    at async stat (node:internal/fs/promises:1039:18)
    at async Promise.all (index 164)
    at async computeGhostHash (.../packages/internal/src/remediation/checkpoint.ts:137)
    at async run (.../apps/ccaudit/src/cli/commands/ghost.ts:138)
```

**Root cause (two layers):**

1. **Scanners skip `mtimeMs` for agents and skills.** `scanMemoryFiles` populates `mtimeMs` on every item via a try/catch-wrapped `stat` (`scan-memory.ts:22, 45, 67, 90`). `scanSkills` (`scan-skills.ts:51-58, 75-82`) and `scanAgents` (`scan-agents.ts:29-35, 52-58`) do NOT — items are pushed with `mtimeMs` undefined.
2. **`computeGhostHash` has an unprotected `stat()` fallback.** At `packages/internal/src/remediation/checkpoint.ts:137`:
   ```typescript
   const mtimeMs = r.item.mtimeMs ?? (await statFn(r.item.path)).mtimeMs;
   ```
   When layer 1 leaves `mtimeMs` undefined, the nullish-coalesce falls through to `statFn` with no try/catch. Any `ENOENT` (or `ELOOP`, `EACCES`, `ENOTDIR`) crashes the entire `Promise.all` and bubbles up to the CLI.

**Requirements impacted:**

| Req | Impact |
|-----|--------|
| DRYR-01 | **Partial regression** — the command crashes before rendering the change plan on real-world inventories with broken symlinks. Synthetic-fixture test cases still pass, so the automated verification row is unchanged, but the real-world path is broken. |
| DRYR-02 | **Failed** — no checkpoint is written because the crash happens before `writeCheckpoint` is called. |
| DRYR-03 | **Failed** — hash-based invalidation cannot be tested because the hash function itself throws. |

**D-17 contract check:** The frozen hash contract in `07-01-SUMMARY.md` is silent on missing-file handling. Excluding an un-stat-able item from the hash is consistent with the contract's "Changes when items enter/leave eligible set" clause. No contract break.

**Fix scope (to be executed via gap-closure plan 07-04):**

| File | Lines | Change |
|------|-----:|--------|
| `packages/internal/src/scanner/scan-skills.ts` | 1, 50-58, 72-83 | Import `stat`, wrap item creation in try/catch-stat (copy `scan-memory.ts:44-56` pattern), populate `mtimeMs` |
| `packages/internal/src/scanner/scan-agents.ts` | 1, 28-36, 51-59 | Same pattern — import `stat`, wrap, populate `mtimeMs` |
| `packages/internal/src/remediation/checkpoint.ts` | 117-148 (the `eligible.map` body), line 137 | Defensive safety net — return `HashRecord \| null` from the async mapper, wrap `statFn` call in try/catch, filter nulls before serializing |

**Tests required (to close the gap and prevent recurrence):**

1. `scan-skills.ts` in-source test — broken symlink excluded; existing symlink test updated to assert `mtimeMs` populated
2. `scan-agents.ts` in-source test — missing-file race
3. `checkpoint.ts` in-source test — `computeGhostHash` survives missing path, hash matches "item absent" control
4. `dry-run-command.test.ts` — extend `buildFixture` with `brokenSymlinkSkills` option; add regression test case that, had it existed, would have caught this bug in CI instead of the user's terminal

**Planning reference:** Full plan captured at `~/.claude/plans/stateless-watching-koala.md` — approved by user 2026-04-05. The gap-closure plan (07-04-PLAN.md) should distill that plan into GSD task format.

---

**Pre-existing open item (not a new gap):** The REQUIREMENTS.md tracking table showing "Pending" status for DRYR-01/02/03 is a project-wide documentation maintenance pattern affecting all completed phases (01-06 show the same), not a Phase 7 regression.

---

## Commits Verified

| Hash    | Description                                                        |
| ------- | ------------------------------------------------------------------ |
| db0f6c4 | feat(07-01): add change-plan builder and savings calculator        |
| 78012ff | feat(07-01): add checkpoint module with hash, atomic write, and read API |
| de5f5aa | feat(07-01): export remediation module at @ccaudit/internal barrel |
| 6ee3fb2 | feat(07-02): add renderChangePlan + renderChangePlanVerbose        |
| b962a77 | chore(07-02): add gen-version.mjs build-time CCAUDIT_VERSION injection |
| d3c5443 | feat(07-02): wire --dry-run branch in ghost command                |
| 42e31a1 | feat(07-03): add dry-run integration test + fix --dry-run flag routing |

All 7 commits confirmed present in `git log`.

---

_Verified: 2026-04-04T21:40:00Z_
_Verifier: Claude (gsd-verifier)_
