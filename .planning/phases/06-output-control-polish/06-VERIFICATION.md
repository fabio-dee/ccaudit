---
phase: 06-output-control-polish
verified: 2026-04-05T06:00:00Z
status: gaps_found
score: 7/7 ROADMAP truths verified, 4 escaped gaps discovered during first end-to-end manual test
re_verification:
  previous_status: passed
  previous_verified: 2026-04-04T17:10:00Z
  previous_score: 7/7 must-haves verified
  escaped_gaps:
    - "Gap #3 — JSON schema is undocumented; three camelCase fields (items / meta.timestamp / meta.exitCode) correctly implement D-16 but have no public discoverability (README, JSON-SCHEMA.md, per-command --json help text all silent)"
    - "Gap #4 — --no-color functional but invisible in every --help output (D-07 initColor() bypasses gunshi parsing → zero help metadata)"
    - "Gap #5 — ccaudit mcp --csv and rendered table emit duplicate rows when the same MCP server is defined in multiple project-level .mcp.json files (scanner per-project dedup is by design for future Phase 8 RMED-06; missing presentation-layer aggregation)"
    - "Gap #6 — pnpm -r build errors from subpackage directories (packages/internal and packages/terminal lack a build script; CI only works because pnpm -r tolerates partial matches when apps/ccaudit has the script)"
  gaps_closed:
    - "CI test job fails if any coverage metric drops below 80% (Gap #1 closed by Plan 06-05)"
    - "npm pack --dry-run succeeds and shows zero runtime dependencies (Gap #2 closed by Plan 06-06)"
  gaps_remaining:
    - "Gaps #3–#6 — see Escaped Gaps section below; to be closed by Plan 06-07"
  regressions: []
---

# Phase 6: Output Control & Polish Verification Report

**Phase Goal:** Deliver production-ready output control for all 4 CLI commands — shared `--quiet`, `--csv`, `--ci` flags with exit code semantics, JSON meta envelope, CSV export, verbose-to-stderr routing, quiet TSV output, plus CI matrix with 80% coverage enforcement and publication-ready npm metadata.

**Verified:** 2026-04-04T17:10:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (Plan 06-05 for Gap #1, Plan 06-06 for Gap #2)

## Re-Verification Summary

The prior verification run (2026-04-04T15:32:11Z) identified two gaps blocking Phase 6 goal achievement:

1. **Gap #1 — CI coverage invocation was a silent no-op.** `.github/workflows/ci.yaml` line 48 used `pnpm test -- --run --coverage ...` where the `--` delimiter was passed through to vitest and consumed as the positional-argument separator, turning every `--coverage*` flag into a positional file filter. Coverage was never measured in CI.
2. **Gap #2 — commit e3dbe01 (Plan 06-04) accidentally wiped the `scripts` and `devDependencies` blocks from `apps/ccaudit/package.json` while adding npm metadata.** `pnpm -r build` silently skipped ccaudit; `npm pack --dry-run` only appeared to work because a stale pre-regression `dist/index.js` was on disk.

Both gaps have been closed:

- **Plan 06-05 (Gap #1):** Moved coverage config into `vitest.config.ts` as source-of-truth (provider v8, 4-metric thresholds 80/80/80/70, documented exclude list). Fixed CI YAML line 48 to invoke `pnpm exec vitest --run --coverage` (no `--` delimiter). Added +14 branch tests across `mcp-table.ts`, `ghost-table.ts`, `inventory-table.ts`, lifting branch coverage from 50-64% to 85-100% on those renderers. Committed in 6fd80d4 (config), 08879b5 (CI fix), 26b80c4 (branch tests).
- **Plan 06-06 (Gap #2):** Restored the `scripts` block (4 scripts: build/test/typecheck/prepack) and `devDependencies` block (10 entries incl. workspace refs for @ccaudit/internal, @ccaudit/terminal, and the catalog ref for @vitest/coverage-v8) to `apps/ccaudit/package.json` via union-restore from cb0932f. Preserved e3dbe01's npm metadata additions. Regenerated fresh dist/index.js (295.93 kB) via `pnpm -F ccaudit build`. Committed in 0d4b5af.

Live spot-check at re-verification time confirms: `pnpm -r test -- --run` exits 0 with 297 tests across 38 files; `pnpm exec vitest --run --coverage` exits 0 with thresholds met (93.22% stmts, 83.61% branches, 95.18% fns, 93.79% lines) and creates coverage/coverage-summary.json; `pnpm -r build` and `pnpm -r typecheck` succeed for all 4 workspace projects; `npm pack --dry-run` succeeds and emits a 72 kB tarball with zero runtime dependencies, 3 files (dist/index.js, package.json, src/index.ts).

## Goal Achievement

### Observable Truths (derived from ROADMAP Success Criteria)

| #   | Truth (ROADMAP SC)                                                                                                                              | Status     | Evidence                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Exit code 0 when no ghosts, 1 when ghosts found (ghost/inventory/mcp); trend always 0                                                           | ✓ VERIFIED | `ghost --ci > /dev/null; echo $?` → EXIT=1 (473 session files, 196 ghosts). `trend --json > /dev/null; echo $?` → TREND_EXIT=0. Source: `process.exitCode = 1` present in ghost.ts, inventory.ts, mcp.ts; trend.ts only sets exitCode=1 inside the parseDuration error handler.                                                                      |
| 2   | `NO_COLOR` env and `--no-color` flag produce ANSI-free output; `--quiet` suppresses decoration; `--verbose` shows scan details                  | ✓ VERIFIED | `NO_COLOR=1 node apps/ccaudit/dist/index.js ghost \| cat -v` produces zero `^[` escape sequences. `ghost --quiet \| cat -v` shows tab-separated rows. `ghost --verbose 2>&1 1>/dev/null` streams `[ccaudit] Scanning sessions (window: 7d)...` and `[ccaudit] Found 473 session file(s)` to stderr. initColor() reads both process.argv and NO_COLOR. |
| 3   | `--ci` combines exit-code + quiet + JSON for GitHub Actions                                                                                     | ✓ VERIFIED | `resolveOutputMode({ ci: true })` returns `{ json: true, quiet: true, csv: false, verbose: false }`. End-to-end: `ghost --ci` produces compact JSON envelope on stdout `{"meta":{"command":"ghost","version":"0.0.1","since":"7d","timestamp":"...","exitCode":1},...}` and exits 1.                                                                 |
| 4   | `--json` and `--csv` flags produce structured/spreadsheet-compatible export on all read commands                                                | ✓ VERIFIED | All 4 commands (ghost, inventory, mcp, trend) import `csvTable`, wrap in `buildJsonEnvelope(command, since, exitCode, data)`. `ghost --csv` emits `name,category,tier,lastUsed,tokens,recommendation,confidence` header + real data rows. Trend uses distinct schema `date,bucket,agents,skills,mcp,total` per D-20.                                 |
| 5   | README, npm metadata, and package are publication-ready (v1.0 launch candidate)                                                                 | ✓ VERIFIED | README documents --quiet/--csv/--ci/--no-color/--verbose/NO_COLOR/exit codes/GitHub Actions example/Flags Reference table/v1.0 status. apps/ccaudit/package.json has keywords (8), MIT license, author (Fabio D.), homepage/repository pointing at 0xD-Fabio/ccaudit. **Scripts and devDependencies blocks restored by Plan 06-06** (58-line file with all 14 top-level keys). `npm pack --dry-run` exits 0, tarball is 72 kB with dist/index.js (295.9 kB, fresh 19:08 build) + package.json (749 B post clean-pkg-json) + src/index.ts. Zero runtime dependencies confirmed. |
| 6   | CI test job enforces 80% coverage threshold via `vitest --coverage`; fails if coverage drops                                                    | ✓ VERIFIED | **Gap #1 closed by Plan 06-05.** Coverage config lives in `vitest.config.ts` (provider: v8, reporter: ['text','text-summary','json-summary'], thresholds lines/statements/functions: 80, branches: 70 with documented rationale). CI YAML line 48: `pnpm exec vitest --run --coverage` (no `--` delimiter). Live run: `rm -rf coverage && pnpm exec vitest --run --coverage` exits 0, creates `coverage/coverage-summary.json`, reports stmts 93.22%/branches 83.61%/fns 95.18%/lines 93.79% (all above thresholds with double-digit margins). Negative test performed during Plan 06-05: bumping lines to 99 produced vitest exit 1 with explicit threshold error. |
| 7   | CI matrix runs on ubuntu-latest and macos-latest; all jobs pass on both                                                                         | ✓ VERIFIED | `.github/workflows/ci.yaml` lines 35-48: `test:` job has `strategy: matrix: os: [ubuntu-latest, macos-latest]` with `runs-on: ${{ matrix.os }}`. Build job remains ubuntu-only and depends on `[lint, typecheck, test]`.                                                                                                                             |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact                                | Expected                                                                                   | Status     | Details                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/terminal/src/color.ts`        | initColor, isColorEnabled, getTableStyle, colorize exports                                 | ✓ VERIFIED | All 4 exports present; initColor() reads process.argv and NO_COLOR; getTableStyle() returns `{ head: ['cyan'] }` or `{}`; colorize uses `pc.createColors(false)` for identity wrappers.                                                                                                                                                      |
| `packages/terminal/src/csv.ts`          | csvEscape, csvRow, csvTable (RFC 4180)                                                     | ✓ VERIFIED | All 3 exports present; proper RFC 4180 escaping.                                                                                                                                                                                                                                                                                             |
| `packages/terminal/src/quiet.ts`        | tsvRow export                                                                              | ✓ VERIFIED | Single export, joins fields with `\t`.                                                                                                                                                                                                                                                                                                       |
| `packages/terminal/src/index.ts`        | Barrel exports for all new modules                                                         | ✓ VERIFIED | Re-exports initColor/isColorEnabled/getTableStyle/colorize, csvEscape/csvRow/csvTable, tsvRow.                                                                                                                                                                                                                                               |
| `apps/ccaudit/src/cli/_shared-args.ts`  | outputArgs with quiet/csv/ci (no 'no-color')                                               | ✓ VERIFIED | Exports outputArgs with quiet (short 'q'), csv, ci — no 'no-color' key (D-07 compliance).                                                                                                                                                                                                                                                    |
| `apps/ccaudit/src/cli/_output-mode.ts`  | resolveOutputMode, buildJsonEnvelope, OutputMode                                           | ✓ VERIFIED | OutputMode interface (json/csv/quiet/verbose); resolveOutputMode handles --ci sugar, json-over-csv and quiet-over-verbose precedence; buildJsonEnvelope wraps with `meta: { command, version, since, timestamp, exitCode }`.                                                                                                                 |
| `apps/ccaudit/src/cli/commands/ghost.ts`      | Full output control wiring                                                                 | ✓ VERIFIED | Imports outputArgs, initColor, csvTable, tsvRow, resolveOutputMode, buildJsonEnvelope. Spreads outputArgs. Calls initColor() before rendering. Sets `process.exitCode = 1` when `hasGhosts`. 4-way output routing: json → csv → quiet TSV → rendered.                                                                                          |
| `apps/ccaudit/src/cli/commands/inventory.ts`  | Full output control wiring                                                                 | ✓ VERIFIED | Same pattern as ghost.ts. Exit code set when `hasGhosts`.                                                                                                                                                                                                                                                                                    |
| `apps/ccaudit/src/cli/commands/mcp.ts`        | Full output control wiring                                                                 | ✓ VERIFIED | Same pattern. Live-measurement progress messages also routed to stderr.                                                                                                                                                                                                                                                                      |
| `apps/ccaudit/src/cli/commands/trend.ts`      | Full output control wiring, no ghost-based exit code                                       | ✓ VERIFIED | Same pattern except `exitCode = 0` always. Trend-specific CSV schema `date,bucket,agents,skills,mcp,total`.                                                                                                                                                                                                                                  |
| `vitest.config.ts`                      | Coverage config with provider, thresholds, exclude list                                    | ✓ VERIFIED | **NEW (Plan 06-05):** `test.coverage` block with provider v8, reporter [text, text-summary, json-summary], reportsDirectory ./coverage, include globs (apps/*/src, packages/*/src), 15-entry documented exclude list, thresholds lines/statements/functions: 80, branches: 70 with inline rationale. 65-line config.                       |
| `.github/workflows/ci.yaml`             | OS matrix + coverage enforcement invocation                                                | ✓ VERIFIED | **FIXED (Plan 06-05):** Line 48 now `pnpm exec vitest --run --coverage` (was the broken `pnpm test -- --run --coverage ...`). OS matrix intact (ubuntu-latest + macos-latest). Build job dependencies intact `[lint, typecheck, test]`.                                                                                                      |
| `pnpm-workspace.yaml`                   | @vitest/coverage-v8 in catalog                                                             | ✓ VERIFIED | `'@vitest/coverage-v8': ^4.1.2` in Build group of catalog.                                                                                                                                                                                                                                                                                    |
| `packages/internal/package.json`        | @vitest/coverage-v8 devDep                                                                 | ✓ VERIFIED | `"@vitest/coverage-v8": "catalog:"`.                                                                                                                                                                                                                                                                                                          |
| `packages/terminal/package.json`        | @vitest/coverage-v8 devDep                                                                 | ✓ VERIFIED | `"@vitest/coverage-v8": "catalog:"`.                                                                                                                                                                                                                                                                                                          |
| `apps/ccaudit/package.json`             | keywords, license, repository, homepage, author + scripts + devDependencies                | ✓ VERIFIED | **RESTORED (Plan 06-06):** 58-line file with all 14 top-level keys. keywords (8), MIT license, author "Fabio D.", homepage/repository pointing at 0xD-Fabio/ccaudit. `scripts`: build (tsdown), test (TZ=UTC vitest), typecheck (tsc --noEmit), prepack (pnpm run build && clean-pkg-json). `devDependencies`: 10 entries (2 workspace refs + 7 catalog refs + @types/node). |
| `README.md`                             | Documents all new flags, CI/scripting, exit codes, Flags Reference                         | ✓ VERIFIED | Contains `--ci`, `--quiet`, `--csv`, `--no-color`, `NO_COLOR`, exit codes, GitHub Actions example, Flags Reference table, `v1.0` status.                                                                                                                                                                                                      |
| `packages/terminal/src/tables/mcp-table.ts` (tests) | +6 branch tests (from Plan 06-05)                                              | ✓ VERIFIED | Contains 8 `it(...)` blocks (was 2). Covers LIKELY tier, monitor recommendation, Keep/ACTIVE/today, 1d ago, Nd ago, never/GHOST/Archive.                                                                                                                                                                                                      |
| `packages/terminal/src/tables/ghost-table.ts` (tests) | +5 branch tests (from Plan 06-05)                                            | ✓ VERIFIED | Contains 20 `it(...)` blocks (was 15). 2 new describe blocks: `formatLastUsed branches (via renderTopGhosts)` and `formatTokenShort branches (via renderGhostSummary)`.                                                                                                                                                                       |
| `packages/terminal/src/tables/inventory-table.ts` (tests) | +3 branch tests (from Plan 06-05)                                      | ✓ VERIFIED | Contains 7 `it(...)` blocks (was 4). Covers today, 1d ago, Nd ago branches.                                                                                                                                                                                                                                                                   |
| `apps/ccaudit/dist/index.js`            | Fresh build with --quiet/--csv/--ci flags, shebang, stripped in-source tests              | ✓ VERIFIED | **REGENERATED (Plan 06-06):** Fresh build from current session (Apr 4 19:08), 295,929 bytes. First line `#!/usr/bin/env node`. Zero `import.meta.vitest` matches (stripped). `ghost --help` lists -q/--quiet, --csv, --ci, -s/--since, -j/--json, -v/--verbose.                                                                             |

### Key Link Verification

| From                                                 | To                                        | Via                                          | Status    | Details                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All 6 renderers (inventory/header/score/ghost/mcp/trend-table) | `packages/terminal/src/color.ts`          | `import { colorize / getTableStyle } from '../color.ts'` | ✓ WIRED   | Zero bare `import pc from 'picocolors'` in tables/. All use centralized `colorize`/`getTableStyle`.                                                                       |
| `apps/ccaudit/src/cli/commands/ghost.ts`             | `apps/ccaudit/src/cli/_shared-args.ts`    | `import { outputArgs }`                      | ✓ WIRED   | Spread as `...outputArgs` in args block.                                                                                                                                  |
| `apps/ccaudit/src/cli/commands/ghost.ts`             | `apps/ccaudit/src/cli/_output-mode.ts`    | `import { resolveOutputMode, buildJsonEnvelope }` | ✓ WIRED   | `resolveOutputMode(ctx.values)` called at run-start; `buildJsonEnvelope('ghost', ...)` called for JSON output path.                                                       |
| `apps/ccaudit/src/cli/commands/ghost.ts`             | `@ccaudit/terminal`                       | `import { initColor, csvTable, tsvRow }`     | ✓ WIRED   | `initColor()` called before rendering; `csvTable()` in CSV path; `tsvRow()` in quiet path.                                                                                |
| Same imports for `inventory.ts`, `mcp.ts`, `trend.ts` | —                                         | —                                            | ✓ WIRED   | All 4 commands verified via grep — each contains initColor, resolveOutputMode, buildJsonEnvelope, csvTable, tsvRow, outputArgs.                                           |
| `.github/workflows/ci.yaml` (test step)              | `vitest --coverage`                       | `pnpm exec vitest --run --coverage`          | ✓ WIRED   | **Fixed in Plan 06-05.** Direct exec bypasses the `--` delimiter issue. Thresholds inherited from vitest.config.ts regardless of invocation path.                         |
| `vitest.config.ts` (coverage.thresholds)             | CI invocation                             | config-as-source-of-truth                    | ✓ WIRED   | Thresholds (lines/statements/functions: 80, branches: 70) in config mean any `--coverage` invocation enforces them.                                                       |
| `apps/ccaudit/package.json` (scripts.build)          | `tsdown`                                  | `"build": "tsdown"`                          | ✓ WIRED   | **Restored in Plan 06-06.** `pnpm -r build` now processes all 4 workspace projects (verified this session).                                                               |
| `apps/ccaudit/package.json` (scripts.prepack)        | `clean-pkg-json`                          | `"prepack": "pnpm run build && clean-pkg-json"` | ✓ WIRED | **Restored in Plan 06-06.** Verified this session: `npm pack --dry-run` runs prepack, produces stripped package.json (749 B) + fresh dist/ artifact. Clean-up note below. |
| `apps/ccaudit/package.json` (devDependencies)        | workspace packages                        | `@ccaudit/internal: workspace:*`, `@ccaudit/terminal: workspace:*` | ✓ WIRED | **Restored in Plan 06-06.** `pnpm install` re-linked the workspace symlinks; `pnpm -F ccaudit test` runs the 26 test cases.                                              |

### Data-Flow Trace (Level 4)

| Artifact              | Data Variable                      | Source                                                                                                                | Produces Real Data | Status      |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| ghost.ts JSON output  | `enriched` → `envelope.items`      | `enrichScanResults(results)` ← `scanAll(allInvocations, { projectPaths })` ← `parseSession()` ← `discoverSessionFiles()` | ✓ YES              | ✓ FLOWING   |
| ghost.ts CSV output   | `enriched.map(...)`                | Same upstream as JSON                                                                                                 | ✓ YES              | ✓ FLOWING   |
| ghost.ts TSV (quiet)  | `enriched` iteration               | Same upstream                                                                                                         | ✓ YES              | ✓ FLOWING   |
| mcp.ts JSON/CSV/TSV   | `enriched` (filtered to mcp-server) | `enrichScanResults(mcpResults)` + optional `measureMcpTokens()`                                                       | ✓ YES              | ✓ FLOWING   |
| trend.ts JSON/CSV/TSV | `buckets`                          | `buildTrendData(allInvocations, sinceMs)`                                                                             | ✓ YES              | ✓ FLOWING   |

End-to-end behavioral verification this session: `ghost --ci` produced meta envelope with real data (473 session files, 29 projects, 213 inventory items, 196 ghosts, health score 11 "Critical"). `ghost --csv` emitted real rows with real ghost names and token estimates. `trend --json` exited 0 with real bucket data.

### Behavioral Spot-Checks (Re-verification)

| #   | Behavior                                                            | Command                                                                          | Result                                                                                                                              | Status                                       |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | `ccaudit ghost --help` lists output flags                           | `node apps/ccaudit/dist/index.js ghost --help`                                   | Shows `-q, --quiet`, `--csv`, `--ci`, `-s/--since`, `-j/--json`, `-v/--verbose`                                                     | ✓ PASS                                       |
| 2   | `ccaudit ghost --ci` exits 1 when ghosts found                      | `ghost --ci > /dev/null; echo $?`                                                | EXIT=1                                                                                                                              | ✓ PASS (OUTP-01, OUTP-05)                    |
| 3   | `ccaudit trend --json` always exits 0                               | `trend --json > /dev/null; echo $?`                                              | EXIT=0                                                                                                                              | ✓ PASS (OUTP-01)                             |
| 4   | `ccaudit ghost --csv` produces RFC 4180 header + rows               | `ghost --csv \| head -5`                                                         | `name,category,tier,lastUsed,tokens,recommendation,confidence` + real rows                                                          | ✓ PASS (OUTP-07)                             |
| 5   | `NO_COLOR=1 ccaudit ghost` produces ANSI-free output                | `NO_COLOR=1 ghost \| cat -v \| grep -c '\^\['`                                  | 0 escape sequences                                                                                                                  | ✓ PASS (OUTP-02)                             |
| 6   | `ccaudit ghost --quiet` produces TSV (tab-separated)                | `ghost --quiet \| cat -v`                                                        | Tab-separated fields, no headers, no decoration                                                                                     | ✓ PASS (OUTP-03)                             |
| 7   | `ccaudit ghost --verbose` routes progress to stderr                 | `ghost --verbose 2>&1 1>/dev/null`                                               | `[ccaudit] Scanning sessions (window: 7d)...` and `[ccaudit] Found 473 session file(s)` on stderr                                   | ✓ PASS (OUTP-04)                             |
| 8   | `ccaudit ghost --ci` includes meta envelope                         | `ghost --ci \| head`                                                             | `{"meta":{"command":"ghost","version":"0.0.1","since":"7d","timestamp":"2026-04-04T17:07:55.985Z","exitCode":1},...}`              | ✓ PASS (OUTP-06)                             |
| 9   | Full test suite passes                                              | `pnpm -r test -- --run`                                                          | **297 tests pass across 38 files (207 internal + 64 terminal + 26 ccaudit)**                                                        | ✓ PASS                                       |
| 10  | `pnpm -r build` rebuilds apps/ccaudit                               | `pnpm -r build`                                                                  | **EXIT=0**, all 4 workspace projects build. `apps/ccaudit build$ tsdown` runs, produces dist/index.js (295.93 kB, gzip 71.63 kB) with shebang | ✓ PASS (previously ✗ FAIL — Gap #2 CLOSED)  |
| 11  | CI-style coverage invocation enforces thresholds                    | `rm -rf coverage && pnpm exec vitest --run --coverage`                           | **EXIT=0**, coverage/coverage-summary.json created. Report: stmts 93.22% / branches 83.61% / fns 95.18% / lines 93.79%. All thresholds met. | ✓ PASS (previously ✗ FAIL — Gap #1 CLOSED)  |
| 12  | `pnpm -r typecheck` covers apps/ccaudit                             | `pnpm -r typecheck`                                                              | EXIT=0, all 4 projects typecheck: packages/internal, packages/terminal, apps/ccaudit                                                | ✓ PASS (regression check)                    |
| 13  | `npm pack --dry-run` succeeds with fresh prepack                    | `cd apps/ccaudit && npm pack --dry-run`                                          | EXIT=0, prepack runs tsdown + clean-pkg-json, tarball 72 kB, 3 files (dist/index.js 295.9 kB + package.json 749 B + src/index.ts 72 B), zero runtime deps | ✓ PASS (OUTP-06, regression check)           |
| 14  | Fresh dist/index.js reflects current source                         | `head -1 dist/index.js; grep -c 'import.meta.vitest' dist/index.js`             | `#!/usr/bin/env node`; 0 matches (in-source tests stripped); mtime Apr 4 19:08 (current session)                                    | ✓ PASS (Gap #2 regression check)             |

**All 14 spot-checks pass.** Behavioral checks 10 and 11 (previously failing) are now green. Checks 12-14 are added to confirm no regressions in adjacent areas.

### Requirements Coverage

| Requirement | Source Plan(s)             | Description                                                                     | Status      | Evidence                                                                                                                                                                                                           |
| ----------- | -------------------------- | ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OUTP-01     | 06-02, 06-04               | Exit codes: 0 = no ghosts, 1 = ghosts found (CI/pre-commit use)                 | ✓ SATISFIED | `process.exitCode = 1` in ghost.ts, inventory.ts, mcp.ts; trend.ts sets exitCode=1 only in parseDuration error path. Spot-check #2: `ghost --ci` → EXIT=1; spot-check #3: `trend --json` → EXIT=0.                |
| OUTP-02     | 06-01, 06-04               | `NO_COLOR` env respected; `--no-color` flag available                           | ✓ SATISFIED | `initColor()` reads both process.argv and NO_COLOR. All 6 renderers use centralized `colorize`/`getTableStyle`. Spot-check #5 verified 0 ANSI escapes with NO_COLOR=1.                                              |
| OUTP-03     | 06-01, 06-02, 06-04        | `--quiet` / `-q`: machine-readable data only                                    | ✓ SATISFIED | outputArgs.quiet with short 'q'; 4-way output routing in every command (json > csv > quiet-tsv > rendered). Spot-check #6 verified TSV output with tabs.                                                           |
| OUTP-04     | 06-02, 06-04               | `--verbose` / `-v`: scan details                                                | ✓ SATISFIED | All 4 commands use `console.error('[ccaudit] ...')` when `mode.verbose`. Spot-check #7 verified verbose messages on stderr.                                                                                        |
| OUTP-05     | 06-02, 06-04               | `--ci` flag: exit-code + quiet + JSON                                           | ✓ SATISFIED | `resolveOutputMode({ ci: true })` sets json=true, quiet=true. Spot-check #2 confirmed end-to-end: `ghost --ci` produced compact JSON envelope and exited 1.                                                        |
| OUTP-06     | 06-02, 06-03, 06-04, 06-05, 06-06 | `--json` export on all read commands (structured output) AND CI coverage threshold enforcement | ✓ SATISFIED | All 4 commands wrap output via `buildJsonEnvelope(command, since, exitCode, payload)`. **CI coverage enforcement now genuinely active (Gap #1 closed by Plan 06-05):** `vitest.config.ts` owns thresholds; spot-check #11 confirmed exit 0 with thresholds met; Plan 06-05 performed negative test proving exit 1 on violation. **npm pack pipeline now genuinely works (Gap #2 closed by Plan 06-06):** spot-check #13 confirmed fresh prepack chain. |
| OUTP-07     | 06-01, 06-02, 06-03, 06-04, 06-05 | `--csv` export on all read commands (spreadsheet-compatible) AND OS matrix (ubuntu + macOS)     | ✓ SATISFIED | All 4 commands implement CSV via `csvTable()`. RFC 4180 escaping verified via in-source tests. Trend uses distinct schema per D-20. Spot-check #4 verified real CSV output. OS matrix intact in ci.yaml (ubuntu-latest + macos-latest). |

**All 7 OUTP requirements are SATISFIED.** No orphaned requirements — each ID is declared in at least one plan's `requirements:` field, and REQUIREMENTS.md maps all 7 exclusively to Phase 6.

### Anti-Patterns Found

| File                                             | Line(s)   | Pattern                                           | Severity    | Impact                                                                                                                                         |
| ------------------------------------------------ | --------- | ------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/internal/src/token/mcp-live-client.ts` | 78-79, 106 | Hardcoded `"not available"` string in stderr message | ℹ️ Info    | NOT a stub — documented in Plan 06-02 summary as correct runtime behavior for non-stdio MCP transports.                                         |

**No blocker or warning anti-patterns.** The two previously-flagged blockers (apps/ccaudit/package.json missing scripts/devDeps, ci.yaml broken `--` delimiter) are resolved by Plans 06-06 and 06-05 respectively. The stale-dist issue is resolved by the fresh 19:08 build (verified via mtime and behavioral spot-check #14).

**Operational note (not a gap):** `npm pack --dry-run` invokes the `prepack` hook chain, which runs `clean-pkg-json` and strips `scripts` and `devDependencies` from the on-disk `apps/ccaudit/package.json` as a side effect. Plan 06-06 documents this as a known ccusage pattern quirk. During this verification run the verifier used `git checkout apps/ccaudit/package.json` after the dry-run to restore the committed state. In a real publish workflow this is safe because publishes run from throwaway branches/worktrees or CI cleans up post-publish. This is not a regression, not a gap, not a code issue — just a workflow reminder.

### Human Verification Required

None — all testable behaviors were verified programmatically via behavioral spot-checks.

### Gaps Summary

**No gaps remain.** Both gaps from the prior verification (2026-04-04T15:32:11Z) are empirically closed:

- **Gap #1 (ROADMAP SC-6, CI coverage enforcement)** — Closed by Plan 06-05 (commits 6fd80d4, 08879b5, 26b80c4). Coverage config moved to `vitest.config.ts` as source-of-truth; CI YAML rewritten to `pnpm exec vitest --run --coverage`; +14 branch tests added to lift renderer coverage above thresholds with comfortable margin. Negative test performed (threshold bumped to 99 → vitest exit 1 with explicit error; reverted → exit 0). Current coverage: stmts 93.22% / branches 83.61% / fns 95.18% / lines 93.79% — all above thresholds (80/70/80/80) with double-digit margin.

- **Gap #2 (ROADMAP SC-5, publication readiness regression)** — Closed by Plan 06-06 (commit 0d4b5af). `apps/ccaudit/package.json` scripts block and devDependencies block restored via union-restore from cb0932f, preserving the e3dbe01 metadata additions. Fresh `dist/index.js` regenerated (295.93 kB, Apr 4 19:08, contains post-06-02 CLI flags). `pnpm install` re-linked workspace deps. All 5 Behavioral Spot-Check #10 items now pass: `pnpm -r build` runs apps/ccaudit; `pnpm -r typecheck` runs apps/ccaudit; `pnpm -F ccaudit test` runs 26 cases; `npm pack --dry-run` runs fresh prepack and produces a valid 72 kB tarball.

All 7 observable truths pass. All 7 OUTP requirements are satisfied. All 14 behavioral spot-checks pass. Phase 6 goal is achieved.

**Phase 6 is ready to close.** The v1.0 launch candidate is fully production-ready: shared output control across all 4 CLI commands, exit code semantics, JSON meta envelope, CSV export (RFC 4180), verbose-to-stderr routing, quiet TSV output, CI matrix on ubuntu + macOS with genuinely-enforced 80% coverage thresholds, and a publishable npm package with complete metadata and zero runtime dependencies.

---

*Verified: 2026-04-04T17:10:00Z*
*Verifier: Claude (gsd-verifier, re-verification run after Plans 06-05 and 06-06 gap closure)*

---

## Escaped Gaps (discovered 2026-04-05 during first end-to-end manual test)

**Context.** After Phase 6 sealed passed on 2026-04-04 and Phase 7 (dry-run & checkpoint) landed on 2026-04-05, the user ran the first full 15-section manual test of the v1.0 candidate binary (`apps/ccaudit/dist/index.js`) against their live `~/.claude/` environment. 12 sections passed. 4 real gaps surfaced — none fatal, but all block a credible v1.0 launch. Results are in `docs/manual-test-results.md`. Parallel analysis across three angles (JSON contract, MCP data flow, help/build hygiene) confirms the scope.

**Why these escaped the 2026-04-04 verification.** The 14 behavioral spot-checks all ran `ghost --ci`, `ghost --csv`, `ghost --quiet`, `trend --json` etc. and validated the *body* of the output. No spot-check greps the `--help` text of any command for flag visibility, no spot-check attempts cross-project MCP dedup (the live fixture happens to not duplicate any servers in the same way Phase 3's test fixture didn't), no spot-check runs `pnpm -r build` from a subpackage directory, and no spot-check validates the discoverability of the JSON field contract outside of the vitest suite. The gaps are all discoverability / edge-case / cross-directory issues that the verification matrix never probed.

### Gap #3 — JSON schema contract is undocumented (Category A in plan-file analysis)

**Symptom.** Tester expected `ghost --json | jq '.data'`, `jq '.meta.generated_at'`, `jq '.meta.exit_code'` (snake_case). Actual: `.items`, `.meta.timestamp`, `.meta.exitCode` (camelCase). Tester flagged as "breaks spec contract".

**Diagnosis.** Code is correct per Phase 6 D-16: *"Every command's JSON output includes a `meta` envelope with `{ command, version, since, timestamp, exitCode }` alongside the command-specific data."* camelCase matches TypeScript internals and the `gh` CLI convention. The contract is locked by vitest at `apps/ccaudit/src/cli/_output-mode.ts:125` (`expect(envelope).toHaveProperty('items')`) and enforced across all 4 commands. **The tester's expectation came from a JSON REST-API snake_case default; no documentation exists outside the phase files to correct that assumption.** This is a discoverability gap, not a code bug — renaming would violate D-16, fail vitest, and break any script that already uses the camelCase form.

**Requirements impact.** OUTP-06 (`--json` export on all read commands). The requirement is structurally satisfied, but the absence of public schema documentation means the contract is effectively invisible to first-time users. Fix is documentation: `docs/JSON-SCHEMA.md` + README section + per-command `--json` help text enhancement.

**Fix owner.** Plan 06-07, Category A.

### Gap #4 — `--no-color` invisible in `--help` output (Category B1)

**Symptom.** Tester ran `ccaudit --help`, `ccaudit ghost --help`, `ccaudit mcp --help` (all 5 commands). `--no-color` does not appear in any help listing. Tester confirmed the flag IS functional — `NO_COLOR=1` env var and piping both strip ANSI correctly — but it is undocumented.

**Diagnosis.** Intentional D-07 design: `apps/ccaudit/src/cli/_shared-args.ts:1-8` comment says *"--no-color is NOT here (per D-07). It is detected at root level by initColor() reading process.argv directly."* `packages/terminal/src/color.ts:19-23` implements `initColor()` reading `process.argv.includes('--no-color')` directly. Gunshi never sees the flag as a declared arg, so it's absent from every `--help` rendering. The in-source test at `_shared-args.ts:64-67` explicitly asserts `outputArgs` does NOT have the key — the design is locked.

**The D-07 optimization ("no per-command duplication") cost DX.** The trade-off needs reversing: declare `no-color` in `outputArgs` so gunshi adds help metadata, while keeping `initColor()` reading `process.argv` as the authoritative source. Both agree because `process.argv` is the same for both code paths.

**Requirements impact.** OUTP-02 (`NO_COLOR` env var and `--no-color` flag — ANSI-free output for piped/CI contexts). The requirement is functionally satisfied (the flag works) but fails the "is available" spirit of the flag declaration.

**Fix owner.** Plan 06-07, Category B1. Two files modified: `_shared-args.ts` (add `no-color` to `outputArgs`, flip the `expect(outputArgs).not.toHaveProperty('no-color')` test). No changes to color.ts or to any command.

### Gap #5 — `ccaudit mcp --csv` and rendered table emit duplicate rows for cross-project MCP servers (Category B2)

**Symptom.** Tester ran `ccaudit mcp --csv` against their live environment. Same server name appears twice in the CSV output:
```
supabase,mcp-server,definite-ghost,never,0,archive,none
supabase,mcp-server,definite-ghost,never,0,archive,none     ← duplicate
```
Rendered table shows the same duplication. Duplicates come from `supabase` being defined in multiple project-level `.mcp.json` files.

**Diagnosis.** `packages/internal/src/scanner/scan-mcp.ts:45-109` builds items with per-project dedup via `Set<string>` keyed on `${projectPath}::${serverName}`. This is **correct by design** — Phase 8 `RMED-06` will disable MCP servers via key-rename in `~/.claude.json` (`projects.<path>.mcpServers` is per-project), so the remediation MUST know which project configs to mutate. Scanner must preserve per-project granularity.

`apps/ccaudit/src/cli/commands/mcp.ts:108-111` filters by category and enriches, then all four output branches (JSON `:184-197`, CSV `:204-212`, TSV `:216-225`, rendered table `:235`) iterate the enriched array without aggregating by server name. The presentation layer was never added because Phase 5's MCP view used a test fixture that didn't duplicate servers across projects.

**Fix.** Presentation-layer aggregation in `commands/mcp.ts` — a new `aggregateMcpByName` helper that groups by server name, picks the "least ghost" tier (`used` > `likely-ghost` > `definite-ghost`), takes the max `lastUsed` across instances, sums `invocationCount`, keeps token estimate (identical per-server), and exposes a `projectPaths: string[]` field in JSON output for traceability. Scanner is untouched.

**Requirements impact.** OUTP-07 (`--csv` export on all read commands). The CSV schema is correct; the row set has duplicate data. New integration test extends the dry-run test pattern: fixture with two `.mcp.json` files defining the same server, assert no duplicate rows.

**Fix owner.** Plan 06-07, Category B2. Files modified: `apps/ccaudit/src/cli/commands/mcp.ts` (inline helper + invocation + JSON field addition + in-source tests). New E2E integration test in `apps/ccaudit/src/__tests__/`.

### Gap #6 — `pnpm -r build` fails with ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT from subpackage directories (Category B3)

**Symptom.** Tester ran `pnpm -r build` and got:
```
ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "build" script
```
Workaround: `pnpm -F ccaudit build` succeeds. `pnpm -r typecheck` succeeds.

**Diagnosis.** Root `package.json:11` defines `"build": "pnpm -r build"`. CI `.github/workflows/ci.yaml:61` runs the same command. `packages/internal/package.json:9-12` and `packages/terminal/package.json:9-12` only define `test` and `typecheck` scripts — no `build`. Only `apps/ccaudit` has a build script. Per pnpm 10.x: `pnpm -r <script>` errors when NO package has the script, but silently skips packages without it when at least one does. From the workspace root, `apps/ccaudit` provides the script so `pnpm -r build` succeeds (CI is green). From a subpackage directory, `pnpm -r`'s implicit scope excludes `apps/ccaudit` and the error surfaces. Fragile.

**Fix.** Add `"build": "tsc"` stubs to `packages/internal/package.json` and `packages/terminal/package.json`, matching their existing `typecheck` script invocations. Aligns with TypeScript composite project conventions, idempotent (tsconfig decides emission), symmetric with `pnpm -r typecheck`, requires no CI changes.

**Requirements impact.** Not a Phase 6 OUTP requirement — this is Phase 1 scaffold hygiene that escaped to Phase 6 verification. Riding along in Plan 06-07 because the fix is tiny (2 lines across 2 files) and it's part of the same manual-test escape class.

**Fix owner.** Plan 06-07, Category B3.

### Gap closure routing

Plan 06-07 (next available number in `.planning/phases/06-output-control-polish/`) will address all 4 escaped gaps in a single gap-closure plan with `gap_closure: true` frontmatter. Source plan document: `/Users/helldrik/.claude/plans/stateless-watching-koala.md` (approved by user 2026-04-05). Execution via `/gsd:execute-phase 6 --gaps-only`. Re-verification will re-run the 14 existing behavioral spot-checks plus new ones covering:

- `--no-color` appears in `--help` output for root and all 4 subcommands (B1)
- `mcp --csv` produces no duplicate rows after cross-project aggregation (B2)
- `pnpm -r build` succeeds from both workspace root and subpackage directories (B3)
- `docs/JSON-SCHEMA.md` exists, README links to it, per-command `--json` help text references it (A)
- All 357+ existing tests still pass
- Coverage thresholds (80/70/80/80) still met

On success, this VERIFICATION.md flips back to `status: passed` with a new `re_verification` entry documenting the Gap #3–#6 closure.
