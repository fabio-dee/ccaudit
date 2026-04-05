---
phase: 08-remediation-core
plan: 07
subsystem: integration-testing
tags: [subprocess-tests, dist-binary, tmpdir-fixtures, exit-code-ladder, dual-schema-mcp, wave-3]
dependency_graph:
  requires:
    - Plan 08-05 (runBust orchestrator with BustResult discriminants)
    - Plan 08-06 (CLI wiring of --dangerously-bust-ghosts into ghost command)
    - Phase 7 (dry-run-command.test.ts subprocess precedent)
  provides:
    - apps/ccaudit/src/__tests__/bust-command.test.ts (end-to-end integration tests for the bust CLI path)
    - Fake-ps shim pattern — portable cross-platform running-process preflight override (CI + local-inside-Claude-Code)
    - .mcp.json flat-schema end-to-end verification (Issue 1 iteration 1 checker blocker fix validated against real dist binary)
  affects:
    - Wave 3 Plan 08 (docs) will reference this test file as the canonical exit code ladder sample
    - Phase 9 (restore) inherits the manifest shape assertions made here as the stable contract
tech_stack:
  added:
    - "node:fs/promises { chmod } — installs fake-ps shim with mode 0o755"
  patterns:
    - "Fake-ps shim in <tmpHome>/bin/ps with PATH=<tmpHome>/bin — deterministic preflight bypass that works identically on CI runners (no Claude process) AND local dev (running inside a Claude Code session)"
    - "process.execPath (absolute) instead of 'node' — survives PATH stripping in the exit-3 test case"
    - "PATH=/nonexistent-dir-only for exit 3 — forces spawn('ps') ENOENT -> process-detection-failed -> BustResult status 'process-detection-failed' -> exit 3"
    - "Stdin piped and immediately closed via child.stdin.end() — makes isTTY false deterministically, exercising the D-17 non-TTY gate"
    - "Session JSONL cwd steering — <projDir>/.mcp.json discovery relies on scanMcpServers route #3 which receives projectPaths from the session parser's meta.projectPath; test seeds a session file whose cwd points at the real tmpdir project dir"
    - "buildBaseFixture helper — single-call setup for .claude/ directory tree + minimal session + empty ~/.claude.json + fake-ps shim; individual tests then layer fixture mutations on top"
key_files:
  created:
    - apps/ccaudit/src/__tests__/bust-command.test.ts (556 lines, 11 tests)
    - .planning/phases/08-remediation-core/08-07-SUMMARY.md (this file)
  modified: []
decisions:
  - "Fake-ps shim instead of vitest skipIf — the alternative (it.skipIf(process.env.CLAUDECODE === '1')) would mean the bust tests never run locally. Installing a POSIX shell script at <tmpHome>/bin/ps that emits only pid 1 and then setting PATH=<tmpHome>/bin for the subprocess gives us full control over the D-02/D-04 preflight in BOTH environments: on CI the real ps would also return no Claude processes, so the fake is a no-op; locally inside a Claude Code session it overrides the ambient process table to prevent false positives. Uniform behavior, no environment-specific skips."
  - "Dedicated PATH=/nonexistent-dir-only path for exit 3 — the alternative (kill a claude process deterministically) is impossible on CI runners where no Claude Code exists. Forcing spawn('ps') ENOENT exercises the D-02 fail-closed branch, which is a legitimate exit 3 path per the BustResult ladder. Skipped on Windows because tasklist.exe resolution is not controlled by PATH alone."
  - "spawn(process.execPath, ...) instead of spawn('node', ...) — when PATH is set to /nonexistent-dir-only for the exit 3 test, spawn('node', ...) would fail to resolve the Node binary entirely. Using process.execPath (which is always absolute) lets us strip PATH to force the ps failure WITHOUT also killing Node itself."
  - "Hash-mismatch test adds a brand-new agent (no session invocations) — matchInventory sets lastUsedMs=null for items with zero invocations, classifyGhost returns 'definite-ghost' for null, buildChangePlan puts agents with definite-ghost tier in plan.archive, and computeGhostHash hashes over the archive items. Adding the new agent therefore guarantees the hash changes regardless of the classification heuristic's time-boundary behavior, and the test never flakes on clock drift."
  - "Full-pipeline test classifies the memory file via mtime (40 days backdated) — scanMemoryFiles uses mtimeMs, and scan-all.ts line 81-86 sets lastUsedMs = item.mtimeMs for memory. Forty days back crosses the 30-day DEFINITE_GHOST_MS boundary cleanly; this is deterministic on every runner since the backdate is relative to Date.now() at test time, not a fixed calendar date."
  - "Session file cwd seeding (.mcp.json test) — scanMcpServers route #3 (line 85-106 of scan-mcp.ts) iterates over the `projectPaths` argument passed by scanAll, which gets it from `options?.projectPaths ?? [... new Set(invocations.map(inv => inv.projectPath).filter(Boolean))]`. In the bust branch's self-contained scanAndEnrich closure (ghost.ts line 326-339), projPaths is built from parseSession's meta.projectPath for each file. So the .mcp.json test's session file MUST have cwd === <real tmpdir projDir> so the parsed projectPath feeds back into scanMcpServers and the ghost server is discovered."
  - "11 distinct it() blocks for the 10 behavior rows in the plan — the plan's must_haves.truths list described: exit 4 (non-TTY), exit 4 bypass, --ci implication, exit 1 checkpoint-missing, exit 1 hash-mismatch, exit 1 --csv, exit 0 empty bust, --quiet suppression, exit 3 process-detection-failed, full pipeline, and .mcp.json flat schema. I split 'bypasses prompt' and '--ci implies --yes' into two distinct it() blocks (both under the 'exit code 4' describe) for clearer test names and independent failure messages."
requirements_completed: [RMED-01, RMED-10]
metrics:
  duration: ~20 minutes
  completed_date: 2026-04-05
  tasks_completed: 1
  commits: 1
  tests_added: 11
  full_workspace_tests: 474 passing + 1 skipped (up from 463+1 post-Plan-06, delta exactly +11)
  bust_test_wall_time_ms: 2162 (11 tests, single-file run)
---

# Phase 8 Plan 07: Bust Command Integration Tests Summary

Shipped `apps/ccaudit/src/__tests__/bust-command.test.ts` — the end-to-end subprocess integration test suite that exercises the compiled `dist/index.js --dangerously-bust-ghosts` binary against real tmpdir HOME fixtures. This closes the Phase 8 verification gap: Wave 0's unit tests covered individual primitives (atomic-write, collisions, processes, frontmatter, manifest), Wave 1's bust.ts tests covered the orchestrator with injected deps, Wave 2's Plan 06 wired runBust into the CLI, and this plan proves the whole chain works when invoked as users will invoke it — as a spawned child process reading from piped stdin.

The tests cover every cell of the exit code ladder (0/1/3/4), the Output Mode matrix (--json honored, --csv rejected, --quiet suppresses progress, --ci implies --yes-proceed-busting), the full three-category pipeline (archive agent + disable MCP + flag memory) with real on-disk side effects, AND the Issue 1 revision's `.mcp.json` flat-schema fixture — the dual-schema MCP disable path verified end-to-end against the built binary.

## Test File Structure

```
apps/ccaudit/src/__tests__/bust-command.test.ts (556 lines)
├─ FAKE_PS_SCRIPT constant + buildFakePs(tmpHome)
├─ runBustCommand(tmpHome, flags, opts)   — subprocess runner with env control
├─ buildBaseFixture(tmpHome)              — .claude/ tree + session + fake-ps
├─ runDryRunFirst(tmpHome)                — creates checkpoint via --dry-run --json
├─ beforeAll: dist binary existence guard
└─ describe('ccaudit --dangerously-bust-ghosts (integration)')
   ├─ describe('exit code 4: non-TTY requires --yes-proceed-busting (D-17)')
   │   ├─ it('piped stdin without --yes-proceed-busting -> exit 4')
   │   ├─ it('piped stdin WITH --yes-proceed-busting -> bypasses prompt (no exit 4)')
   │   └─ it('--ci --dangerously-bust-ghosts implies --yes-proceed-busting')
   ├─ describe('exit code 1: checkpoint and hash gate failures (D-01)')
   │   ├─ it('no checkpoint -> exit 1 with checkpoint-missing message')
   │   ├─ it('hash mismatch (inventory changed) -> exit 1')
   │   └─ it('--csv on bust -> exit 1 with rejection message')
   ├─ describe('exit code 0: successful bust paths')
   │   ├─ it('empty fixture + --yes-proceed-busting -> exit 0 with manifest')
   │   └─ it('--quiet suppresses progress output, still exits 0')
   ├─ describe('exit code 3: running-process preflight (D-02, D-03)')
   │   └─ it.skipIf(win32)('empty PATH so ps is unreachable -> exit 3')
   ├─ describe('full pipeline: archive + disable + flag')
   │   └─ it('real fixture: 1 agent + 1 MCP + 1 memory -> manifest with 3 ops')
   └─ describe('.mcp.json flat-schema disable (Issue 1 revision)')
       └─ it('project .mcp.json ghost MCP -> key moves to top level, no projects wrapper')
```

Each `it()` block is atomic — it gets a fresh `mkdtemp`, builds its own fixture, runs dry-run + bust, asserts, then `rm -rf` cleans up. No inter-test state.

## The Fake-ps Shim Pattern (Critical Discovery)

**Problem.** The bust command's preflight runs `ps -A -o pid=,comm=` to detect any running Claude Code process (D-02/D-03). On a CI runner with no Claude Code, the detector finds zero matches and the pipeline proceeds. But **when this test suite runs from inside a Claude Code session** (local development), the real `ps` finds the enclosing Claude process, `walkParentChain` discovers it in the ancestry, and every bust test fails with exit 3 and the D-04 self-invocation message. Smoke test from this session confirmed the issue:

```
$ HOME=/tmp/quicktest node dist/index.js --dangerously-bust-ghosts --yes-proceed-busting --json < /dev/null
{
  "meta": { "exitCode": 3 },
  "bust": {
    "status": "running-process",
    "pids": [6929, 10269],
    "selfInvocation": true,
    "message": "You appear to be running ccaudit from inside a Claude Code session (parent pid: 10269)..."
  }
}
$ echo $?
3
```

**Solution.** Each test writes a POSIX shell script at `<tmpHome>/bin/ps` that impersonates `ps`:

```sh
#!/bin/sh
case "$*" in
  *-A*)       echo "    1 init" ;;   # No Claude pid in system listing
  *-o\ ppid=*) echo "1" ;;            # Parent = init, terminates walkParentChain
  *)          echo "    1 init" ;;
esac
```

The subprocess is spawned with `PATH=<tmpHome>/bin` so this fake is the only `ps` reachable. The `runCommand` call inside `detectClaudeProcesses` and `walkParentChain` both resolve to this shim, which emits only pid 1 (init). `CLAUDE_NAME_REGEX` does not match `init`, so `processes.length === 0` and the pipeline proceeds to gate 2.

**Why this works in both environments:**
- **CI (GitHub Actions Linux):** the real `ps` would also return no Claude processes, so the fake is a no-op. No behavioral difference.
- **Local (inside Claude Code):** the fake overrides the ambient process table. The enclosing Claude process is invisible to the subprocess, and the D-04 self-invocation check sees only pid 1 as the parent.

**Why this beats `it.skipIf(process.env.CLAUDECODE === '1')`:** skipping means the bust tests never actually run locally, so a developer inside Claude Code never exercises them. The fake-ps shim keeps the tests fully functional in local dev.

## process.execPath Over 'node' (Exit 3 Test Enabler)

The exit-3 test stripPATH to `/nonexistent-dir-only` to force `spawn('ps')` → ENOENT → `process-detection-failed`. But if we spawned the subprocess with `spawn('node', [distPath, ...])`, the node binary itself would also fail to resolve on the stripped PATH. The fix is `spawn(process.execPath, [distPath, ...])` — `process.execPath` is always an absolute path (e.g. `/Users/.../node/bin/node`), so Node resolution succeeds independently of PATH, and the subprocess-internal `ps` spawn fails cleanly with ENOENT.

Verified smoke test:
```
$ PATH=/nonexistent-dir /Users/.../node/bin/node dist/index.js --dangerously-bust-ghosts --yes-proceed-busting < /dev/null; echo $?
Could not verify Claude Code is stopped: spawn ps ENOENT
Run from a clean shell where ps (Unix) or tasklist (Windows) is available.
3
```

Exit code 3, stderr contains the canonical D-02 message. Mapped in the test via `expect(result.code).toBe(3)` + `expect(result.stderr).toMatch(/Could not verify Claude Code is stopped/)`.

## Exit Code Ladder Coverage Matrix

| Test | Code | Trigger | BustResult status |
|------|------|---------|-------------------|
| non-TTY without bypass | **4** | piped stdin, no `--yes-proceed-busting` | N/A (handled pre-runBust) |
| non-TTY with bypass | **0** | piped stdin + `--yes-proceed-busting` | `success` (empty fixture) |
| --ci implies --yes | **0** | `--ci` only (implies --json + --yes-proceed-busting) | `success` |
| no checkpoint | **1** | skip dry-run, run bust | `checkpoint-missing` |
| hash mismatch | **1** | dry-run, add agent, run bust | `hash-mismatch` |
| --csv rejection | **1** | `--csv` on bust | N/A (handled pre-runBust) |
| empty bust success | **0** | empty fixture, full flags | `success` |
| --quiet suppression | **0** | `--quiet` + empty fixture | `success` (no stdout text) |
| PATH stripped | **3** | `PATH=/nonexistent-dir-only` | `process-detection-failed` |
| full pipeline | **0** | agent + mcp + memory fixture | `success` (3 ops) |
| .mcp.json flat schema | **0** | project .mcp.json with ghost server | `success` (1 disable op) |

**Exit code 2 is intentionally absent** — it is reserved for Phase 7 dry-run checkpoint write failures, not bust, per the BustResult → exit code ladder helper in ghost.ts (`bustResultToExitCode`).

## Full Pipeline Verification (Archive + Disable + Flag)

The full-pipeline test builds a fixture with:
1. `~/.claude/agents/ghost-agent.md` — brand new, zero invocations → `definite-ghost` → `plan.archive[0]`
2. `~/.claude.json` with `mcpServers.ghost-mcp` — zero invocations → `definite-ghost` → `plan.disable[0]`
3. `~/.claude/CLAUDE.md` with mtime 40 days ago — past the 30-day boundary → `definite-ghost` → `plan.flag[0]`

After running dry-run + bust, the test asserts:
- **Archive (D-13 step 1):** `~/.claude/agents/_archived/ghost-agent.md` exists; original `ghost-agent.md` removed
- **Disable (D-13 step 2):** `~/.claude.json` now has `mcpServers: {}` and `ccaudit-disabled:ghost-mcp: { command: 'npx', args: ['ghost'] }` at document root
- **Flag (D-13 step 3):** `~/.claude/CLAUDE.md` has frontmatter injected with both `ccaudit-stale: true` and `ccaudit-flagged: <iso>`
- **Manifest op order:** `records[0].record_type === 'header'`, `ops[0].op_type === 'archive'`, `ops[1].op_type === 'disable'`, `ops[2].op_type === 'flag'`, `records[last].record_type === 'footer'`
- **Counts:** `archive.completed === 1`, `disable.completed === 1`, `flag.completed === 1`

Smoke-tested manually before the automated test, so we know every assertion is stable:

```
--- .claude.json AFTER ---
{
  "mcpServers": {},
  "ccaudit-disabled:ghost-mcp": { "command": "npx", "args": ["ghost"] }
}
--- CLAUDE.md AFTER ---
---
ccaudit-stale: true
ccaudit-flagged: 2026-04-05T16:32:22.105Z
---
# old memory
```

## .mcp.json Flat-Schema Fixture (Issue 1 Revision End-to-End)

**Context.** The iteration 1 checker review flagged that `.mcp.json` uses a FLAT top-level `{ mcpServers: {...} }` schema with NO `projects` wrapper, while `~/.claude.json` uses a NESTED `{ projects: { <path>: { mcpServers: {...} } } }` schema. The scanner reports `scope: 'project'` for BOTH. The ONLY way to distinguish them at the bust layer is `path.basename(item.path) === '.mcp.json'`. Plan 05 built this detection into `disableMcpTransactional` and unit-tested it with injected deps; this plan validates it end-to-end against the compiled binary.

**Fixture construction.** The test seeds a session JSONL file whose `cwd` points at a real tmpdir project directory:

```typescript
const projDir = path.join(tmpHome, 'my-project');
await mkdir(projDir, { recursive: true });
await writeFile(path.join(projDir, '.mcp.json'), JSON.stringify({
  mcpServers: { 'mcp-json-ghost': { command: 'npx', args: ['ghost-mcp-server'] } },
}));
// CRITICAL: seed cwd so scanMcpServers route #3 receives this projDir
await writeFile(sessionFilePath, JSON.stringify({
  type: 'system', subtype: 'init', cwd: projDir, ...
}) + '\n');
```

This flow is essential because `scanMcpServers` route #3 (line 85-106 of scan-mcp.ts) iterates the `projectPaths` argument, which in the bust branch's self-contained `scanAndEnrich` closure is built from `parseSession`'s `meta.projectPath` for each session file (ghost.ts lines 326-339). Without the session cwd steering, the scanner would never walk `<projDir>/.mcp.json` and the ghost server would never be discovered.

**Assertions.** After bust:

```typescript
const mcpAfter = JSON.parse(await readFile(mcpJsonPath, 'utf8'));
expect(mcpAfter.mcpServers['mcp-json-ghost']).toBeUndefined();        // removed
expect(mcpAfter['ccaudit-disabled:mcp-json-ghost']).toEqual(original); // at DOC ROOT
expect(mcpAfter.projects).toBeUndefined();                             // NO synthetic wrapper
```

And on the manifest:

```typescript
const ourOp = disableOps.find((o) => o.config_path === mcpJsonPath);
expect(ourOp.original_key).toBe('mcpServers.mcp-json-ghost');     // FLAT path
expect(ourOp.new_key).toBe('ccaudit-disabled:mcp-json-ghost');
expect(ourOp.scope).toBe('project');
expect(ourOp.project_path).toBe(projDir);
```

**Smoke-tested before automation** to confirm the fixture produces exactly the expected on-disk state. The test passes on first run because the smoke test verified every expectation against the built binary.

## Deviations from Plan

### Auto-fixed (Rule 2 — added critical functionality to make tests reliable)

**1. [Rule 2 — Fake-ps shim] D-04 self-invocation false positive on local dev**

- **Found during:** Initial smoke test (before writing the test file)
- **Issue:** When this test suite runs from inside a Claude Code session, the real `ps` finds the enclosing Claude process and `walkParentChain` puts it in the ancestry. Every bust test would fail with `{ status: 'running-process', selfInvocation: true }` and exit 3. The plan's test body did NOT account for this scenario — it inherited the full `process.env` (including PATH) and assumed the ambient process table was acceptable.
- **Fix:** Added `FAKE_PS_SCRIPT` constant and `buildFakePs(tmpHome)` helper. Each test installs a POSIX shell script at `<tmpHome>/bin/ps` that emits only pid 1 for `-A` listings and pid 1 for `-o ppid=` walks. The subprocess is spawned with `PATH=<tmpHome>/bin` (controlled via a new `RunOpts.pathOverride` parameter) so the fake is the only `ps` on PATH. The real process table is invisible to the subprocess, and the D-04 gate sees a clean ancestry.
- **Files modified:** apps/ccaudit/src/__tests__/bust-command.test.ts (the only file in this plan)
- **Commit:** 3430e17
- **Plan acceptance criterion impact:** None — the plan's literal test bodies all still pass, they just now work in both CI and local environments. The `<env>` block in the plan's code sample inherited `process.env` via `...process.env`; the final implementation replaces that with an explicit minimal env + `PATH: <fake ps dir>`.

**2. [Rule 2 — process.execPath] Exit 3 test PATH stripping would kill Node resolution**

- **Found during:** Exit 3 test implementation
- **Issue:** The plan's exit 3 test uses `PATH: '/nonexistent-dir-only'` to force `spawn('ps')` ENOENT. But if we also spawn the subprocess with `spawn('node', [distPath, ...], { env: { PATH: '/nonexistent-dir-only' } })`, the `node` binary itself fails to resolve on the stripped PATH. The plan did not notice this — its example code uses `spawn('node', ...)` everywhere.
- **Fix:** The subprocess runner uses `spawn(process.execPath, [distPath, ...], ...)`. `process.execPath` is always an absolute path (e.g. `/Users/.../node/bin/node`), so Node resolution succeeds independently of PATH, and only the internal `ps` spawn inside the subprocess fails.
- **Files modified:** apps/ccaudit/src/__tests__/bust-command.test.ts
- **Commit:** 3430e17

**3. [Rule 2 — Session cwd seeding for .mcp.json] Scanner route #3 requires projectPaths**

- **Found during:** .mcp.json test implementation
- **Issue:** The plan's action section noted "the exact seeding mechanism depends on how Phase 3 wires project discovery" and suggested either seeding a session file OR a `projects` key in `~/.claude.json`. Investigation of the actual scanMcpServers code (scan-mcp.ts lines 85-106) showed route #3 walks only the `projectPaths` argument passed by scanAll, which comes from session invocations' `projectPath` field, NOT from `~/.claude.json`'s `projects` keys. So the authoritative steering mechanism is the session JSONL's `cwd` field — seeding `~/.claude.json.projects` alone would NOT make scanner route #3 see the ghost.
- **Fix:** The .mcp.json test overwrites the base fixture's session file with one whose `cwd` points at the real tmpdir project directory. This flows through `parseSession.meta.projectPath` → `projPaths.add(projDir)` → `scanAll({ projectPaths: [projDir] })` → `scanMcpServers(configPath, [projDir])` → route #3 reads `<projDir>/.mcp.json` → discovers `mcp-json-ghost`. Verified via the smoke test which printed the dry-run plan and confirmed the ghost appeared with the correct path and projectPath.
- **Files modified:** apps/ccaudit/src/__tests__/bust-command.test.ts
- **Commit:** 3430e17

### Rule 1 (bugs) / Rule 3 (blocking issues) / Rule 4 (architectural)

None. No bugs were found in Plan 05 or Plan 06; every production code path behaved as specified once the test environment was set up correctly.

## Authentication Gates

None. The bust branch never authenticates against external services.

## Verification

### Build

```
$ pnpm -F ccaudit build
✔ Build complete in 31ms (dist/index.js = 357.89 kB / gzip 89.64 kB)
(exit 0)
```

### Typecheck

```
$ pnpm -F ccaudit typecheck
> tsc --noEmit
(exit 0, no output)
```

### Isolated bust-command test file

```
$ pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts
 ✓ |ccaudit| src/__tests__/bust-command.test.ts (11 tests) 2162ms
       ✓ piped stdin WITH --yes-proceed-busting -> bypasses prompt (no exit 4)  403ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

11 tests, all passing on first run.

### Full workspace suite (regression check)

```
$ pnpm exec vitest --run
 ...
 ✓ |ccaudit| src/__tests__/ghost-command.test.ts (9 tests) 26ms
 ✓ |@ccaudit/internal| src/token/mcp-live-client.ts (7 tests) 745ms
 ✓ |ccaudit| src/__tests__/help-output.test.ts (5 tests) 445ms
 ✓ |ccaudit| src/__tests__/dry-run-command.test.ts (9 tests) 912ms
 ✓ |ccaudit| src/__tests__/bust-command.test.ts (11 tests) 2125ms

 Test Files  52 passed (52)
      Tests  474 passed | 1 skipped (475)
```

Delta vs Plan 06 baseline (463 passing + 1 skipped): **+11 passing**. Zero regressions.

### Smoke tests (verified before automation)

The fake-ps + .mcp.json + full-pipeline approaches were each smoke-tested manually against the built binary before writing the test file, to confirm the fixture design produced the expected on-disk state. Selected excerpts:

```
# Fake-ps exit 0 success path:
$ HOME=/tmp/quicktest PATH=/tmp/quicktest/bin node dist/index.js --dangerously-bust-ghosts --yes-proceed-busting --json < /dev/null
{"meta":{"exitCode":0},"bust":{"status":"success","manifestPath":"...","counts":{...}}}
exit=0

# PATH stripped exit 3 path:
$ HOME=/tmp/quicktest PATH=/nonexistent-dir node dist/index.js --dangerously-bust-ghosts --yes-proceed-busting < /dev/null
Could not verify Claude Code is stopped: spawn ps ENOENT
Run from a clean shell where ps (Unix) or tasklist (Windows) is available.
exit=3

# .mcp.json flat schema after bust:
$ cat /tmp/mcptest/my-project/.mcp.json
{"mcpServers":{},"ccaudit-disabled:mcp-json-ghost":{"command":"npx","args":["ghost-mcp-server"]}}
```

### Acceptance grep suite (18/18 passing)

```
PASS: file exists
PASS: ccaudit --dangerously-bust-ghosts
PASS: exit code 4
PASS: exit code 1
PASS: exit code 3
PASS: exit code 0
PASS: yes-proceed-busting
PASS: --csv is not supported
PASS: implies --yes-proceed-busting
PASS: record_type (both "header" and "footer" substrings present)
PASS: _archived
PASS: ccaudit-disabled:ghost-mcp
PASS: ccaudit-stale: true
PASS: .mcp.json flat-schema disable
PASS: mcp-json-ghost
PASS: ccaudit-disabled:mcp-json-ghost
PASS: mcpServers.mcp-json-ghost
PASS: mcpAfter.projects toBeUndefined (negative assertion — no synthetic wrapper)
```

All 18 grep criteria from the plan's acceptance_criteria block pass.

## Commits

| Task | Type | Hash    | Message                                                              |
|------|------|---------|----------------------------------------------------------------------|
| 1    | test | 3430e17 | test(08-07): add subprocess integration tests for --dangerously-bust-ghosts |

## Handoff Notes

- **Wave 3 Plan 08 (docs):** the exit code ladder table in this SUMMARY is the canonical source of truth for the README / docs/JSON-SCHEMA.md exit code documentation. The fake-ps pattern is a useful debugging aid for downstream contributors running these tests locally — surface it in CONTRIBUTING.md.
- **Phase 9 (restore):** the manifest shape assertions in the full-pipeline test (`records[0].record_type === 'header'`, op order `archive -> disable -> flag`, footer with `status: 'completed'`) are the stable contract Phase 9 will consume. Any change to the manifest schema must update these assertions in lockstep.
- **CI:** when Plan 08 adds `windows-latest` to the matrix per Success Criterion 9, the exit 3 test (`it.skipIf(process.platform === 'win32')`) will be skipped on Windows; the remaining 10 tests must still pass. The fake-ps shim only installs a Unix shell script; on Windows the subprocess would call `tasklist.exe` which is not overridable via PATH alone, so Windows CI runners rely on the real tasklist (which finds no Claude.exe process on GitHub Actions runners — same as Linux CI).

## Known Stubs

None. The test suite is complete: every exit code path has a dedicated test, every BustResult discriminant relevant to the CLI surface has an assertion, every D-13/D-14/D-15/D-16/D-17 contract has coverage, and the Issue 1 `.mcp.json` flat-schema fix is end-to-end verified against the compiled binary.

## Threat Flags

None. This plan adds a test file only. No new production code, no new network endpoints, no new authentication paths, no new file-write surfaces at trust boundaries.

The fake-ps shim is a POSIX shell script written into a tmpdir directory that is cleaned up after each test (`rm -rf tmpHome` in `afterEach`). It is not executable outside the test's lifetime and has no path traversal surface — `writeFile(path.join(tmpHome, 'bin', 'ps'), FAKE_PS_SCRIPT)` uses a literal join of the test's own mkdtemp result.

## Self-Check: PASSED

**Created files:**
- `apps/ccaudit/src/__tests__/bust-command.test.ts` — FOUND (556 lines, verified via `wc -l` and grep acceptance suite)
- `.planning/phases/08-remediation-core/08-07-SUMMARY.md` — FOUND (this file)

**Modified files:** None.

**Commits:**
- `3430e17` — FOUND via `git log --oneline | grep 3430e17` (test: subprocess integration tests for --dangerously-bust-ghosts)

**Acceptance criteria (plan success criteria):**
- [x] Subprocess test spawns dist/index.js with tmpdir HOME — PASS
- [x] Exit code 0 verified: empty fixture + --yes-proceed-busting + successful manifest — PASS (empty bust success test)
- [x] Exit code 1 verified: missing checkpoint, hash mismatch after inventory change, --csv rejection — PASS (3 distinct tests)
- [x] Exit code 3 verified: PATH stripping triggers process-detection-failed — PASS (skipIf win32)
- [x] Exit code 4 verified: piped stdin without --yes-proceed-busting — PASS
- [x] --ci bust implies --yes-proceed-busting + --json — PASS
- [x] --quiet suppresses stdout progress — PASS
- [x] Full pipeline: agent archived, MCP key-renamed, memory frontmatter added — PASS (real fixture test with all side effect assertions + manifest op order)
- [x] .mcp.json flat-schema fixture (Issue 1 revision): ghost MCP in project .mcp.json gets key-renamed at document root, no projects wrapper synthesized, manifest records .mcp.json path with correct original_key/new_key/project_path — PASS (dedicated describe block with smoke-verified fixture)
- [x] pnpm -F ccaudit build exits 0 — PASS
- [x] pnpm exec vitest --run apps/ccaudit/src/__tests__/bust-command.test.ts exits 0 — PASS (11/11)
- [x] pnpm exec vitest --run exits 0 (full suite green including Phase 7 dry-run integration) — PASS (474 passing + 1 skipped, +11 delta)
- [x] All 18 grep acceptance criteria pass — PASS (verified post-commit)

---
*Phase: 08-remediation-core*
*Plan: 07*
*Completed: 2026-04-05*
