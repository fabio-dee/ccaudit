---
phase: 08-remediation-core
verified: 2026-04-05T19:10:00Z
status: passed
score: 9/9 success criteria verified
---

# Phase 8: Remediation Core Verification Report

**Phase Goal:** `ccaudit --dangerously-bust-ghosts` safely remediates all ghost items — archiving agents/skills, disabling MCP servers via key-rename, flagging stale memory — with running-process detection, atomic writes, and two-prompt "proceed busting" confirmation ceremony (ceremony corrected from original three-prompt design per CONTEXT.md D-15).
**Verified:** 2026-04-05T19:10:00Z
**Status:** PASSED
**Re-verification:** No — initial verification.

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Bust refuses to run unless a valid checkpoint exists with matching hash (two-gate per D-01 — no recency gate) | VERIFIED | `bust.ts:197-210` calls `deps.readCheckpoint(path)` then `deps.computeHash(enriched) === checkpoint.ghost_hash`; test `returns checkpoint-missing` + `returns hash-mismatch` (plan 05 tests); integration test `no checkpoint -> exit 1` + `hash mismatch -> exit 1` (plan 07 tests). REQUIREMENTS.md RMED-02 amended to "two-stage" per Plan 01. |
| 2 | Refuses to mutate `~/.claude.json` if a running Claude Code process is detected (hard preflight gate, exit 3) | VERIFIED | `bust.ts:213-238` calls `detectClaudeProcesses` + `walkParentChain`; plan 05 test `returns running-process when detector finds Claude pids` + plan 07 integration test `empty PATH so ps is unreachable -> exit 3` (skipped on Windows). Exit code 3 wired via `bustResultToExitCode`. Smoke test confirms `EXIT=3` on stripped PATH. |
| 3 | Ghost agents archived to `_archived/` subdirectories (not deleted); ghost skills likewise archived | VERIFIED | `bust.ts:292-296` archives agents then skills in D-13 order via `archiveOne` → `buildArchivePath` (nested-path-preserving, `path.relative`). Plan 07 full-pipeline integration test asserts `~/.claude/agents/_archived/ghost-agent.md` exists on disk after bust. |
| 4 | Ghost MCP servers disabled via key-rename in `~/.claude.json` AND `.mcp.json` (dual-schema), moved to `ccaudit-disabled:<name>` key preserving valid JSON | VERIFIED | `bust.ts:543-558` `disableMcpTransactional` with `isFlatMcpJson = path.basename(configPath) === '.mcp.json'`; two dedicated plan 05 tests (`.mcp.json disable: key moves to top level` + `mixed sources: .mcp.json AND ~/.claude.json`); plan 07 integration test `.mcp.json flat-schema disable (Issue 1 revision)` asserts `mcpAfter.projects` is undefined (no synthetic wrapper). |
| 5 | Stale memory files receive `ccaudit-stale: true` frontmatter; already-flagged files get `ccaudit-flagged` timestamp refresh (D-07) | VERIFIED | `frontmatter.ts:93-236` `patchFrontmatter` with three-case discriminated result (`patched` / `refreshed` / `skipped`); D-07 refresh handled by `ccauditFlaggedIdx` in-place rewrite; 12 in-source tests cover all fixtures including refresh-path. Plan 07 integration test asserts `ccaudit-stale: true` in `CLAUDE.md` after bust. |
| 6 | All `~/.claude.json` mutations use atomic write-to-temp-then-rename (extracted from Phase 7 per D-18) | VERIFIED | `atomic-write.ts:65-99` `atomicWriteJson` (tmp + writeFile + renameWithRetry + cleanup on error); `checkpoint.ts` refactored to thin wrapper; Plan 07 regression tests (21 in `checkpoint.ts`) still pass unchanged; bust `disableMcpTransactional` calls `deps.atomicWriteJson(configPath, updated)` for both `.mcp.json` and `~/.claude.json`. |
| 7 | Incremental restore manifest written as operations complete (JSONL with header + footer per D-09..D-12); crash mid-operation allows partial restore | VERIFIED | `manifest.ts:309-370` `ManifestWriter.open/writeOp/close` with per-op `fd.sync()`, single-write concatenation (Pitfall 5), header-before-ops invariant, footer-only-on-success. 5 op types (`archive`, `disable`, `flag`, `refresh`, `skipped`) + header + footer records. Crash-tolerant `readManifest` skips trailing truncated line. Plan 04 tests: 15 covering round-trip, truncation tolerance, mid-file corruption raises. |
| 8 | Two-prompt confirmation UX per D-15: `[1/2] Proceed busting? [y/N]` → `[2/2] Type exactly: proceed busting` (supersedes original three-prompt `I accept full responsibility`) | VERIFIED | `bust.ts` `runConfirmationCeremony` implements D-15; plan 05 tests `y at prompt1 then "proceed busting" at prompt2 → accepted` + `case sensitive: "Proceed Busting" does not match` + `y then 3× wrong phrase → aborted at prompt2`. README + handoff v6 + JSON-SCHEMA all updated to two-prompt design. Handoff v6 §145-150 superseding note documents pivot from original three-prompt; negative grep for `I accept full responsibility` passes. |
| 9 | CI matrix extended to `windows-latest`; `fs.rename` EPERM retry verified with exponential backoff (10ms initial, +10ms per retry, cap 100ms, 10s total, stat-before-retry) | VERIFIED | `.github/workflows/ci.yaml` line 38: `os: [ubuntu-latest, macos-latest, windows-latest]`. `atomic-write.ts:46-48` canonical constants `retryTotalMs: 10_000, retryInitialMs: 10, retryMaxMs: 100`. Plan 01 tests: `retries on EPERM then succeeds`, `retries on EACCES and EBUSY`, `stat-before-retry gate`, `exhausts retryTotalMs budget`, `backoff schedule: 10, 20, 30, ... capped`. Win32-only guard (`deps.platform !== 'win32'` throws first-attempt on Unix). |

**Score:** 9/9 truths verified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/internal/src/remediation/atomic-write.ts` | `atomicWriteJson` + `renameWithRetry` + EPERM retry | VERIFIED | 486 lines, exports both, 14 tests + 1 Windows-only skipped smoke |
| `packages/internal/src/remediation/collisions.ts` | `buildArchivePath` (nested preserve), `buildDisabledMcpKey`, timestamp helpers | VERIFIED | 204 lines, 4 exported helpers, 15 tests, escape guard throws on outside-root |
| `packages/internal/src/remediation/processes.ts` | `detectClaudeProcesses`, `walkParentChain`, `CLAUDE_NAME_REGEX` anchored | VERIFIED | 378 lines, fail-closed tagged result, 21 tests with injected deps, 16-level depth cap |
| `packages/internal/src/remediation/frontmatter.ts` | `patchFrontmatter` 3-case handling (prepend / inject / refresh / skip exotic) | VERIFIED | 386 lines, discriminated result type, 12 tests (10 fixtures + idempotency + read-error) |
| `packages/internal/src/remediation/manifest.ts` | `ManifestWriter` + header/footer + 5 op types | VERIFIED | 723 lines, per-op fsync, all 5 builders + header/footer + crash-tolerant reader, 15 tests |
| `packages/internal/src/remediation/bust.ts` | `runBust` orchestrator + 10 BustResult variants + dual-schema `disableMcpTransactional` | VERIFIED | 1358 lines (762 prod + 596 tests), 18 in-source tests, dual-schema via `path.basename(configPath) === '.mcp.json'` |
| `apps/ccaudit/src/cli/commands/ghost.ts` | `dangerouslyBustGhosts` + `yesProceedBusting` flags + bust branch + `ctx.values.ci === true` check | VERIFIED | Bust branch at line 279; `const yes = ctx.values.yesProceedBusting === true \|\| ctx.values.ci === true` at line 299; `process.exitCode = 4` at line 309 for non-TTY; exhaustive `bustResultToExitCode` + `bustResultToJson` helpers |
| `apps/ccaudit/src/__tests__/bust-command.test.ts` | End-to-end subprocess integration test with `.mcp.json` flat-schema case | VERIFIED | 556 lines, 11 tests, `.mcp.json flat-schema disable (Issue 1 revision)` describe block at line 466, fake-ps shim for cross-env reliability, `process.execPath` for PATH-stripped exit 3 test |
| `.github/workflows/ci.yaml` | `windows-latest` in test matrix | VERIFIED | Line 38: `os: [ubuntu-latest, macos-latest, windows-latest]` |
| `.planning/REQUIREMENTS.md` | RMED-02 amended (no "checkpoint is recent" phrase, uses "two-stage" wording per D-01) | VERIFIED | Line 73: "Two-stage checkpoint gate... (1) checkpoint file exists..., (2) `computeGhostHash`..." with historical note about D-01 rationale |
| `README.md` | Exit code ladder table + `--ci` footgun warning + "proceed busting" phrase documented | VERIFIED | H3 `### Remediation: --dangerously-bust-ghosts`; H4 `#### ⚠️ --ci footgun on bust` with "read this twice" callout; full exit code table 0/1/2/3/4; both bust flags in `--help` output |
| `docs/ccaudit-handoff-v6.md` | §145-150 uses two-prompt D-15 ceremony (not obsolete three-prompt) | VERIFIED | Lines 147-151 show `[1/2] Proceed busting? [y/N]` → `[2/2] Type exactly: proceed busting`; superseding note at line 122 cites Phase 8 D-15; negative greps confirm `I accept full responsibility`, `yes-i-accept-full-responsibility`, and `[3/3]` are all absent |
| `docs/JSON-SCHEMA.md` | Bust envelope shape for all 10 BustResult variants + exit code mapping | VERIFIED | Section added with 10 variant subsections (success, partial-success, checkpoint-missing, checkpoint-invalid, hash-mismatch, running-process, process-detection-failed, user-aborted, config-parse-error, config-write-error); Exit code mapping table at line 244; jq recipes at line 268 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `bust.ts` | `checkpoint.ts` | `readCheckpoint` + `computeGhostHash` | WIRED | Both imported at lines 35-36; called at `deps.readCheckpoint(path)` (line 197) and `deps.computeHash(enriched)` (computeGhostHash passed via BustDeps). gsd-tools multi-line regex false-negative; manual grep confirms both present. |
| `bust.ts` | `processes.ts` | `detectClaudeProcesses` + `walkParentChain` | WIRED | Both imported at lines 46-47; called at bust.ts:213 and bust.ts:222 |
| `bust.ts` | `manifest.ts` | `ManifestWriter open/writeOp/close` | WIRED | `createManifestWriter` on BustDeps → `ManifestWriter` class instantiation; full lifecycle in `runBust` pipeline |
| `bust.ts` | `atomic-write.ts` | `atomicWriteJson` for `~/.claude.json` + `.mcp.json` mutation | WIRED | Called via `deps.atomicWriteJson(configPath, updated)` inside `disableMcpTransactional` (line ~600+) |
| `bust.ts` | `frontmatter.ts` | `patchFrontmatter` for memory file flagging | WIRED | Called via `deps.patchMemoryFrontmatter(item.path, nowIso)` in memory-flag step |
| `bust.ts` | `collisions.ts` | `buildArchivePath` + `buildDisabledMcpKey` | WIRED | Both called inside `archiveOne` and `disableMcpTransactional` respectively |
| `ghost.ts` | `bust.ts` | `runBust({ yes, deps })` invocation | WIRED | Line 377: `const result = await runBust({ yes, deps })`; full `BustDeps` constructed at lines 316-374 with self-contained `scanAndEnrich` closure |
| `ghost.ts` | `_output-mode.ts` | `buildJsonEnvelope` with `bust` key | WIRED | Line 381-386: `buildJsonEnvelope('ghost', sinceStr, bustResultToExitCode(result), { bust: bustResultToJson(result) })` |
| `checkpoint.ts` | `atomic-write.ts` | thin-wrapper delegation (Phase 7 refactor preservation) | WIRED | `writeCheckpoint` now imports `atomicWriteJson`; Phase 7 regression tests (21) still pass unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `bust.ts` runBust pipeline | `enriched` (ghost inventory) | `deps.scanAndEnrich()` — drives `discoverSessionFiles → parseSession → scanAll → enrichScanResults` in the CLI production path | Yes — real scanner pipeline | FLOWING |
| `bust.ts` MCP disable step | `cfg` (parsed JSON) | `JSON.parse(await deps.readFileUtf8(configPath))` from real `~/.claude.json` or `.mcp.json` | Yes — real file read | FLOWING |
| `ghost.ts` bust branch | `plan` (ChangePlan) | `buildChangePlan(enriched)` inside runBust via Phase 7 helper | Yes — computed from real enriched inventory | FLOWING |
| `manifest.ts` ManifestWriter | `ops` appended | `writeOp(buildArchiveOp/buildDisableOp/...)` called per real operation | Yes — each op reflects real fs/json mutation | FLOWING |
| Plan 07 integration test | fs side effects | Real `mkdtemp` fixture + spawned `dist/index.js` | Yes — smoke-verified before automation | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Bust flags exposed in --help | `node dist/index.js --help \| grep dangerously-bust-ghosts` | Matched `--dangerously-bust-ghosts` + `--yes-proceed-busting` | PASS |
| Non-TTY gate exits 4 | `echo "" \| node dist/index.js --dangerously-bust-ghosts` | `EXIT=4`, stderr `requires an interactive terminal` | PASS |
| --csv rejection exits 1 | `echo "" \| node dist/index.js --dangerously-bust-ghosts --csv` | `EXIT=1` | PASS |
| Phase 7 checkpoint tests still pass (refactor regression) | `pnpm exec vitest --run packages/internal/src/remediation/checkpoint.ts` | 21 passing, 0 failed | PASS |
| Full test suite passes | `pnpm exec vitest --run` | 474 passed + 1 skipped (52 files) | PASS |
| Typecheck clean | `pnpm -F @ccaudit/internal typecheck` | exit 0, no output | PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|----------------|-------------|--------|----------|
| RMED-01 | 05, 06, 07, 08 | `ccaudit --dangerously-bust-ghosts` command (viral UX flag) | SATISFIED | `runBust` orchestrator + CLI wiring + integration tests + docs |
| RMED-02 | 01, 05 | Two-stage checkpoint gate (existence + hash match) | SATISFIED | D-01 two-gate verification in bust.ts; REQUIREMENTS.md amended to drop "checkpoint is recent" |
| RMED-03 | 02, 05 | Hard preflight: running Claude Code process → refuse | SATISFIED | `detectClaudeProcesses` + `walkParentChain` in processes.ts; runBust returns `running-process` → exit 3 |
| RMED-04 | 02, 05 | Agents archived to `_archived/` (nested-path-preserving) | SATISFIED | `buildArchivePath` via `path.relative`; `archiveOne` in bust.ts |
| RMED-05 | 02, 05 | Skills archived to `_archived/` | SATISFIED | Same `archiveOne` helper, category `'skill'` |
| RMED-06 | 02, 05 | MCP servers disabled via key-rename in **both** `~/.claude.json` and `.mcp.json` dual schema | SATISFIED | `disableMcpTransactional` with `isFlatMcpJson` branch; 2 dedicated plan 05 tests + plan 07 integration test asserting `mcpAfter.projects` undefined |
| RMED-07 | 03, 05 | Memory files flagged via `ccaudit-stale: true` frontmatter (idempotent refresh per D-07) | SATISFIED | `patchFrontmatter` with three-case discriminated result; `refreshed` op type |
| RMED-08 | 04, 05 | Incremental restore manifest (JSONL, header+footer bracket) | SATISFIED | `ManifestWriter` with per-op `fd.sync()`; Phase 9 detection rule encoded |
| RMED-09 | 01, 05 | Atomic write pattern for all `~/.claude.json` mutations | SATISFIED | `atomicWriteJson` with Windows EPERM retry; reused for MCP disable step |
| RMED-10 | 05, 06 | Two-prompt confirmation ceremony (D-15 supersedes original three-prompt) | SATISFIED (implementation) | `runConfirmationCeremony` in bust.ts implements two-prompt design; README/handoff/JSON-SCHEMA all document "proceed busting". **NOTE:** REQUIREMENTS.md RMED-10 line 81 still describes the obsolete three-prompt `I accept full responsibility` design (was not amended like RMED-02 in Plan 01). The implementation is correct; only the requirement text is stale. Not blocking goal achievement — see "Observations" below. |

**Orphaned requirements:** None. All 10 RMED-## IDs (01-10) are declared across plans 01-08 and all are satisfied by shipped code.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| (none in production code) | — | — | — |

Grep across all 6 new remediation source files for `TODO\|FIXME\|XXX\|HACK\|PLACEHOLDER` returns zero matches in production code paths. All hand-rolled return-empty constructs (`{}`, `[]`, `null`) are either:
- Legitimate defaults in type declarations (not user-visible)
- Test fixture initial state overwritten by test body
- Correct empty-state returns (e.g., `parts.length === 0` case in frontmatter parser)

None are stubs; every module has substantive logic and passing tests.

### Human Verification Required

None. Every success criterion is verified programmatically by either:
- In-source unit tests with injected deps (primitives + orchestrator)
- Subprocess integration tests with tmpdir HOME + fake-ps shim (CLI wiring + exit codes + dual-schema)
- Behavioral spot-checks via the built `dist/index.js` binary
- Static file/content verification

Phase 7 smoke-test precedent (which caught real gaps) does not apply here because Phase 8's integration test suite already covers the equivalent smoke paths end-to-end against the compiled binary. The fake-ps shim pattern means local-dev runs are deterministic regardless of Claude Code session enclosure.

### Observations (Non-Blocking)

1. **REQUIREMENTS.md RMED-10 text drift (documentation-only).** Plan 01 amended RMED-02 to drop "checkpoint is recent" per D-01, establishing the precedent of amending requirement text when shipped design diverges. RMED-10 at line 81 still reads `Triple confirmation UX: [1/3] proceed? -> [2/3] are you sure? -> [3/3] type "I accept full responsibility"` — this contradicts the shipped two-prompt `proceed busting` D-15 implementation. The ROADMAP.md Phase 8 success criterion #8 was correctly updated to two-prompt; README, handoff v6, and JSON-SCHEMA are all authoritative on the two-prompt design. This is analogous to the RMED-02 situation before Plan 01's amendment: stale requirement text that diverges from shipped code. The user's must_haves list for this verification did NOT request RMED-10 amendment, so this is flagged as an observation only, not a gap. A future cleanup plan (or Phase 9 kick-off plan) could amend RMED-10 in a single-line edit, mirroring the Plan 01 pattern.

2. **ROADMAP.md Phase 8 goal line (line 150) says "triple confirmation".** The success criteria row 8 just below correctly says "Two-prompt confirmation UX". Same category of stale wording as RMED-10 — documentation drift that does not affect shipped functionality. Not flagged as a gap because Phase 8's goal achievement is tested by the Success Criteria rows, which are correct.

3. **gsd-tools pattern-matching false negatives.** Two of the must_haves in PLAN frontmatter used regex patterns that don't match substantive content due to string-literal expectations:
   - Plan 05 key-link `readCheckpoint.*computeGhostHash` requires both on one line (bust.ts has them on separate import lines 35-36) — manual grep confirms both present and wired.
   - Plan 07 artifact pattern `describe('ccaudit --dangerously-bust-ghosts'` doesn't match actual `describe('ccaudit --dangerously-bust-ghosts (integration)'` — the substantive describe block exists at line 198 with all required sub-describes.
   Both verified manually and counted as VERIFIED. These are plan-authoring hygiene observations, not goal-achievement gaps.

### Gaps Summary

**No gaps.** All 9 ROADMAP Success Criteria are satisfied by shipped, tested code. All 10 RMED-## requirements map to production code with in-source tests, integration tests, and behavioral spot-checks. The 474-passing + 1-skipped test suite (52 files) reflects zero regressions in Phases 1-7 (checkpoint.ts's 21 Phase 7 tests still pass unchanged after the D-18 atomic-write extraction refactor).

The two documentation-drift observations (RMED-10 requirement text, ROADMAP goal line) are noted for future cleanup but do not block Phase 8 goal achievement — the shipped implementation, user-facing documentation (README, handoff v6, JSON-SCHEMA.md), and test suite are all consistent on the D-15 two-prompt `proceed busting` ceremony.

---

## Phase 8 Completion Criteria

- [x] Wave 0 primitives shipped: atomic-write, collisions, processes, frontmatter, manifest (Plans 01-04)
- [x] Wave 1 orchestrator shipped: bust.ts with dual-schema MCP disable (Plan 05)
- [x] Wave 2 CLI wiring shipped: --dangerously-bust-ghosts + --yes-proceed-busting flags (Plan 06)
- [x] Wave 3 integration tests shipped: subprocess tests with fake-ps shim + .mcp.json fixture (Plan 07)
- [x] Wave 3 public docs shipped: README + JSON-SCHEMA + handoff v6 updates (Plan 08)
- [x] All 10 RMED-## requirements satisfied
- [x] CI matrix extended to windows-latest (SC #9)
- [x] Windows EPERM retry logic verified with test coverage (SC #9)
- [x] Zero regressions in Phases 1-7 (474 passing + 1 skipped baseline)
- [x] Typecheck clean across workspace
- [x] RMED-02 wording amended per D-01 (Plan 01 deliverable)

**Phase 8 is ready to merge.** The `--dangerously-bust-ghosts` feature is shippable as v1.2.0-rc1 pending Phase 9 (`ccaudit restore`) counterpart.

---

_Verified: 2026-04-05T19:10:00Z_
_Verifier: Claude (gsd-verifier)_
