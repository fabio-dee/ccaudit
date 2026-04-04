---
phase: 06-output-control-polish
plan: 02
subsystem: cli
tags: [exit-codes, json-envelope, csv-export, tsv-quiet, verbose-stderr, ci-mode]

# Dependency graph
requires:
  - phase: 06-output-control-polish
    provides: "Centralized color control (initColor), CSV formatter (csvTable), TSV formatter (tsvRow)"
provides:
  - "Shared CLI output flags (quiet, csv, ci) spread across all subcommands"
  - "Output mode resolver with --ci sugar and conflict resolution"
  - "Standardized JSON meta envelope with command, version, since, timestamp, exitCode"
  - "Exit code semantics: ghost/inventory/mcp exit 1 on ghosts, trend always 0"
  - "CSV export on all 4 commands (RFC 4180, trend has different schema)"
  - "TSV quiet-mode output on all 4 commands (machine-parseable, no decoration)"
  - "Verbose messages routed to stderr with [ccaudit] prefix"
affects: [06-03-documentation-polish, 06-04-integration-validation]

# Tech tracking
tech-stack:
  added: []
  patterns: [output-mode-resolver, json-meta-envelope, precedence-based-routing, stderr-verbose-logging]

key-files:
  created:
    - apps/ccaudit/src/cli/_shared-args.ts
    - apps/ccaudit/src/cli/_output-mode.ts
  modified:
    - apps/ccaudit/src/cli/commands/ghost.ts
    - apps/ccaudit/src/cli/commands/mcp.ts
    - apps/ccaudit/src/cli/commands/inventory.ts
    - apps/ccaudit/src/cli/commands/trend.ts
    - packages/terminal/tsconfig.json

key-decisions:
  - "outputArgs exports only quiet/csv/ci; --no-color excluded per D-07 (handled at root by initColor reading process.argv)"
  - "resolveOutputMode precedence: json wins over csv, quiet wins over verbose, --ci implies --json --quiet"
  - "Output routing precedence in commands: json -> csv -> quiet TSV -> rendered output (else-if chain)"
  - "trend command uses different CSV schema (date/bucket/agents/skills/mcp/total) per D-20"
  - "trend command never sets exit code based on ghosts; informational time-series data (D-01)"
  - "Verbose messages prefixed with [ccaudit] and routed via console.error (stderr) per D-13"

patterns-established:
  - "Shared args spread pattern: args: { ...outputArgs, since: {...}, json: {...}, verbose: {...} }"
  - "Mode resolution pattern: const mode = resolveOutputMode(ctx.values) after initColor()"
  - "JSON envelope pattern: buildJsonEnvelope(command, since, exitCode, payload) wraps all JSON output"
  - "Output routing pattern: if (mode.json) ... else if (mode.csv) ... else if (mode.quiet) ... else rendered"
  - "Exit code pattern: const hasGhosts = enriched.some(r => r.tier !== 'used'); if (hasGhosts) process.exitCode = 1"

requirements-completed: [OUTP-01, OUTP-03, OUTP-04, OUTP-05, OUTP-06, OUTP-07]

# Metrics
duration: 7min
completed: 2026-04-04
---

# Phase 06 Plan 02: Command Output Control Wiring Summary

**Wired shared output flags (--quiet, --csv, --ci) into all 4 CLI commands with exit code semantics, standardized JSON meta envelope, RFC 4180 CSV export, TSV quiet mode, and verbose messages routed to stderr**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-04T15:11:10Z
- **Completed:** 2026-04-04T15:18:13Z
- **Tasks:** 2
- **Files created:** 2 (_shared-args.ts, _output-mode.ts)
- **Files modified:** 5 (ghost.ts, mcp.ts, inventory.ts, trend.ts, packages/terminal/tsconfig.json)

## Accomplishments

- Created `_shared-args.ts` exporting `outputArgs` with quiet (-q), csv, ci flags; deliberately excluded no-color per D-07 (handled by initColor reading process.argv at root level)
- Created `_output-mode.ts` with `resolveOutputMode` (handles --ci sugar, json/csv conflict, verbose/quiet conflict) and `buildJsonEnvelope` (standardized meta envelope with command, version, since, timestamp, exitCode)
- Wired `outputArgs` spread into all 4 commands (ghost, mcp, inventory, trend), preserving existing per-command json/verbose args
- Added `initColor()` call before rendering in every command (no args, reads process.argv directly per D-07)
- Added output routing with precedence: `json (with meta envelope)` → `csv (RFC 4180)` → `quiet TSV` → `default rendered output`
- Set exit codes: ghost/inventory/mcp exit 1 when any item has `tier !== 'used'`; trend always exits 0 (informational per D-01)
- Moved all verbose messages to `console.error` (stderr) with `[ccaudit]` prefix per D-13, including mcp's live-measurement progress messages
- Added trend-specific CSV schema (`date,bucket,agents,skills,mcp,total`) per D-20; other commands share (`name,category,tier,lastUsed,tokens,recommendation,confidence`)
- Compact JSON (`indent=0`) when `mode.quiet`, pretty JSON (`indent=2`) otherwise per D-10
- Headerless CSV (`includeHeader=false`) when `mode.quiet` per D-11
- Fixed pre-existing typecheck failure in `packages/terminal/tsconfig.json` (Rule 3 deviation): added node + vitest/importMeta types so `process.argv` in color.ts typechecks in composite build

## Task Commits

Each task was committed atomically (TDD cycle for Task 1):

1. **Task 1 (RED): add failing tests for shared args and output mode resolver** — `59354a0` (test)
2. **Task 1 (GREEN): implement shared args and output mode resolver** — `0929f1b` (feat)
3. **Task 2: wire output control into all 4 CLI commands** — `ec83269` (feat) [includes Rule 3 tsconfig fix]

## Files Created/Modified

- `apps/ccaudit/src/cli/_shared-args.ts` — Shared flag definitions (quiet/csv/ci) spread into all commands; in-source tests assert no-color is NOT present (D-07 compliance)
- `apps/ccaudit/src/cli/_output-mode.ts` — `OutputMode` interface, `resolveOutputMode` with conflict resolution, `buildJsonEnvelope` with standardized meta wrapper; 8 in-source tests
- `apps/ccaudit/src/cli/commands/ghost.ts` — Spread outputArgs, added initColor/resolveOutputMode calls, 4-way output routing, exit code 1 on ghosts, verbose to stderr with [ccaudit] prefix
- `apps/ccaudit/src/cli/commands/mcp.ts` — Same changes; verbose prefix updated including live-measurement progress messages; added quiet/csv/ci to in-source tests
- `apps/ccaudit/src/cli/commands/inventory.ts` — Same changes; exit code 1 on ghosts
- `apps/ccaudit/src/cli/commands/trend.ts` — Same changes EXCEPT no ghost-based exit code (per D-01); trend-specific CSV schema (date/bucket/agents/skills/mcp/total)
- `packages/terminal/tsconfig.json` — Added `"types": ["vitest/importMeta", "node"]` to fix pre-existing composite-build typecheck failure in color.ts (Rule 3 deviation, unblocks plan verification)

## Decisions Made

- **outputArgs excludes no-color (D-07):** Placing --no-color per-command would break `ccaudit --no-color ghost` because gunshi parses subcommand flags. Instead initColor() reads process.argv directly, so the flag works in any position.
- **Output routing uses else-if precedence chain:** json → csv → quiet → default. This ensures --ci (which sets json+quiet) goes through the JSON path with compact output, and --csv --quiet goes through CSV without headers.
- **Exit code set AFTER all output is written (D-03):** `process.exitCode = 1` (not `process.exit(1)`) allows cleanup and ensures output completes before the process exits.
- **trend CSV uses different schema (D-20):** Trend data is time-series buckets, not per-item inventory, so it uses `date,bucket,agents,skills,mcp,total` instead of the universal schema.
- **Verbose prefixed with [ccaudit] (discretion):** Added `[ccaudit]` prefix to all stderr verbose messages for clarity when mixed with stdout JSON output (e.g., `ccaudit ghost --json --verbose` shows progress on stderr alongside JSON on stdout).
- **JSON envelope hardcodes version '0.0.1' to match cli/index.ts:** When the version is bumped, both locations need updating. This matches the pattern established in cli/index.ts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed pre-existing typecheck failure in packages/terminal/tsconfig.json**

- **Found during:** Task 2 verification step (`pnpm -F ccaudit exec tsc --noEmit`)
- **Issue:** `packages/terminal/src/color.ts` (created in Plan 01) uses global `process.argv` and `process.env.NO_COLOR`, but the terminal package's tsconfig inherited root `"types": ["vitest/importMeta"]` which overrode default node types. Verified pre-existing by stashing our changes and re-running tsc — still failed. Plan 01's `pnpm -r test` verification caught no issue because vitest runs with node globals available, but `tsc --build` on the composite project reference doesn't.
- **Impact:** Task 2 verification requires `pnpm -F ccaudit exec tsc --noEmit` to pass. Since apps/ccaudit depends on packages/terminal via project references, and terminal's .d.ts files are regenerated from tsc --build, the stale .d.ts files also blocked TS from finding the new exports (initColor, csvTable, tsvRow).
- **Fix:** Added `"types": ["vitest/importMeta", "node"]` to `packages/terminal/tsconfig.json` compilerOptions. This matches the pattern in `apps/ccaudit/tsconfig.json`. `@types/node` is already in devDependencies, so no package.json change needed.
- **Files modified:** packages/terminal/tsconfig.json (1 line added)
- **Verification:** `pnpm -F @ccaudit/terminal exec tsc --build --force` passes cleanly, regenerated dist/index.d.ts includes all Plan 01 exports, `pnpm -F ccaudit exec tsc --noEmit` passes cleanly, all 283 tests still pass.
- **Commit:** Included in Task 2 commit `ec83269`

## Issues Encountered

None beyond the Rule 3 deviation documented above. All other plan actions executed exactly as written.

## Authentication Gates

None. No external services or authentication required.

## User Setup Required

None — no external service configuration or credentials needed.

## Known Stubs

None — all code paths are fully implemented. The only "not available" string in the modified code is a runtime verbose message describing a real fallback scenario in mcp.ts (non-stdio MCP transports can't be measured live), which is correct behavior, not a stub.

## Verification Results

- `pnpm -F ccaudit test -- --run` → 26 tests pass
- `pnpm -r test -- --run` → 283 tests pass (207 internal + 50 terminal + 26 ccaudit), zero regressions
- `pnpm -F ccaudit exec tsc --noEmit` → clean, no errors
- `pnpm -F @ccaudit/terminal exec tsc --build` → clean, rebuilt .d.ts with all Plan 01 exports

### Acceptance Criteria Verified

- ghost.ts contains: `import { outputArgs }`, `resolveOutputMode(ctx.values)`, `initColor()`, `process.exitCode = 1` (x2), `buildJsonEnvelope(`, `csvTable(`, `tsvRow(`, `console.error(` (x4)
- mcp.ts contains: `import { outputArgs }`, `process.exitCode = 1` (x2: parseDuration + ghosts)
- inventory.ts contains: `import { outputArgs }`, `process.exitCode = 1` (x2)
- trend.ts contains: `import { outputArgs }`, only ONE `process.exitCode = 1` at line 55 (parseDuration error handler, NOT ghost-related)
- cli/index.ts is UNCHANGED (empty git diff between HEAD~2 and HEAD)
- No command file contains `'no-color'` in its args definition (only in negative test assertion in _shared-args.ts)

## Next Phase Readiness

- All OUTP requirements addressed except OUTP-02 (color control, completed in Plan 01)
- Plan 03 (documentation polish) can now document the full CLI surface with examples
- Plan 04 (integration validation) can run end-to-end tests with --ci, --json, --csv, --quiet, --verbose, --no-color combinations
- Pre-existing typecheck issue resolved; future plans can rely on `pnpm -F ccaudit exec tsc --noEmit` as a verification gate

## Self-Check: PASSED

- All 2 created files exist on disk:
  - apps/ccaudit/src/cli/_shared-args.ts: FOUND
  - apps/ccaudit/src/cli/_output-mode.ts: FOUND
- All 3 task commits found in git log:
  - 59354a0 (test RED): FOUND
  - 0929f1b (feat GREEN): FOUND
  - ec83269 (feat Task 2): FOUND

---
*Phase: 06-output-control-polish*
*Completed: 2026-04-04*
