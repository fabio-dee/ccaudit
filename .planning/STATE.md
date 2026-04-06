---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Full Release
status: complete
stopped_at: "v1.2 milestone complete — all 9 phases shipped"
last_updated: "2026-04-06T18:00:00.000Z"
last_activity: 2026-04-06
progress:
  total_phases: 9
  completed_phases: 9
  total_plans: 37
  completed_plans: 37
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-04)

**Core value:** Show users exactly how many tokens their ghost inventory wastes -- and give them one safe, reversible command to reclaim them.
**Current focus:** Planning next milestone

## Current Position

Phase: 08
Plan: Not started
Status: Ready to plan
Last activity: 2026-04-06

Progress: [████████████████████] 14/14 plans (100%)

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: (none)
- Trend: N/A

| Phase 01-foundation-scaffold P01 | 3min | 2 tasks | 23 files |
| Phase 01-foundation-scaffold P02 | 3min | 2 tasks | 8 files |
| Phase 02-jsonl-parser P01 | 4min | 2 tasks | 7 files |
| Phase 02-jsonl-parser P02 | 21min | 2 tasks | 10 files |
| Phase 03-inventory-scanner P01 | 4min | 2 tasks | 3 files |
| Phase 03-inventory-scanner P02 | 10min | 2 tasks | 4 files |
| Phase 03-inventory-scanner PP03 | 5min | 2 tasks | 4 files |
| Phase 04 P02 | 2min | 1 tasks | 1 files |
| Phase 04 P01 | 4min | 2 tasks | 7 files |
| Phase 04 P03 | 5min | 2 tasks | 6 files |
| Phase 05 P01 | 5min | 3 tasks | 7 files |
| Phase 05 P02 | 4min | 2 tasks | 10 files |
| Phase 05 P03 | 5min | 3 tasks | 6 files |
| Phase 05 P04 | 4min | 2 tasks | 2 files |
| Phase 06-output-control-polish P03 | 2min | 2 tasks | 6 files |
| Phase 06 P01 | 4min | 2 tasks | 10 files |
| Phase 06-output-control-polish P02 | 7min | 2 tasks | 7 files |
| Phase 06-output-control-polish P04 | 2min | 1 tasks | 2 files |
| Phase 06-output-control-polish P06 | 4min | 3 tasks | 1 files |
| Phase 06-output-control-polish P05 | 30min | 4 tasks | 5 files |
| Phase 07-dry-run-checkpoint P01 | 14min | 3 tasks | 5 files |
| Phase 07-dry-run-checkpoint P02 | 5min | 3 tasks | 9 files |
| Phase 07-dry-run-checkpoint P03 | 6min | 2 tasks | 3 files |
| Phase 07-dry-run-checkpoint P04 | 7min | 3 tasks | 4 files |
| Phase 06-output-control-polish P07 | 11min | 8 tasks | 14 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: MCP config source is `~/.claude.json` + `.mcp.json`, NOT `settings.json` (research C1)
- [Roadmap]: MCP disable via key-rename (`ccaudit-disabled:<name>`), not comment-out (research C2)
- [Roadmap]: Running-process gate is hard preflight for `~/.claude.json` mutation (research C3)
- [Roadmap]: All token estimates labeled `~` with confidence tier (research C5)
- [Roadmap]: `--live` ships in v1.0 (Phase 4), not deferred (research C5)
- [Phase 01-foundation-scaffold]: passWithNoTests added to apps/ccaudit vitest config for empty-src tolerance
- [Phase 01-foundation-scaffold]: All devDependencies use catalog: protocol -- zero bare version strings in package.json files
- [Phase 01-foundation-scaffold]: Top-level define in tsdown config for import.meta.vitest stripping (not inputOptions.define)
- [Phase 01-foundation-scaffold]: Removed unused:true and publint:true from tsdown config -- optional deps not in catalog
- [Phase 01-foundation-scaffold]: Added outputOptions.entryFileNames to force .js extension from tsdown ESM output
- [Phase 01-foundation-scaffold]: Added allowImportingTsExtensions + composite:true to fix TypeScript project references with .ts imports
- [Phase 02-jsonl-parser]: Added allowImportingTsExtensions + noEmit to packages/internal tsconfig for .ts import paths
- [Phase 02-jsonl-parser]: ContentBlock union uses catch-all v.object({type: v.string()}) for unknown JSONL block types
- [Phase 02-jsonl-parser]: MCP name parsing splits on first __ after mcp__ prefix, supporting server names with single underscores
- [Phase 02-jsonl-parser]: isSidechain detection uses both file path pattern AND JSONL data field for robustness
- [Phase 02-jsonl-parser]: emitDeclarationOnly + declaration replaces noEmit in composite project tsconfig for TypeScript project references
- [Phase 03-inventory-scanner]: classifyGhost uses inclusive <= boundaries: exactly 7d is used, exactly 30d is likely-ghost
- [Phase 03-inventory-scanner]: InvocationSummary.projects uses Set<string> for automatic deduplication
- [Phase 03-inventory-scanner]: ISO 8601 string comparison used for lastTimestamp ordering (lexicographically correct)
- [Phase 03-inventory-scanner]: readClaudeConfig exported separately for Plan 03 coordinator to access skillUsage and disabledMcpServers
- [Phase 03-inventory-scanner]: MCP deduplication uses Set with composite key (projectPath::serverName)
- [Phase 03-inventory-scanner]: Memory scanner stat() with individual try/catch for file-disappearance edge case
- [Phase 03-inventory-scanner]: Skill matching uses invocation map first (both dir name and resolved name), then skillUsage from ~/.claude.json as fallback
- [Phase 03-inventory-scanner]: Memory files classified directly by mtimeMs -- no invocation matching needed
- [Phase 03-inventory-scanner]: scanAll extracts unique projectPaths from invocations when not explicitly provided
- [Phase 04]: Settle guard pattern for child_process promise lifecycle
- [Phase 04]: JSON import requires 'with { type: json }' attribute for NodeNext module resolution
- [Phase 04]: tsconfig include needs src/**/*.json for JSON data files in composite project
- [Phase 04]: enrichScanResults uses Promise.all for parallel per-category token estimation
- [Phase 04]: Skill token cap at 500 with source annotation when capped
- [Phase 04]: MCP --live replaces estimate with measured value on success, keeps estimate on failure
- [Phase 05]: Health score penalty weights: definite*3 cap 60, likely*1 cap 20, token ratio cap 20
- [Phase 05]: Trend granularity auto-selects: daily for <=7d, weekly for >7d with Monday-aligned weeks
- [Phase 05]: Integration test scaffold uses node:os tmpdir for portable fixtures
- [Phase 05]: Ghost summary uses column-aligned plain text (not cli-table3) per D-02 for screenshot-friendly compact output
- [Phase 05]: cli-table3 colAligns uses 'center' not 'middle' (typed enum mismatch caught by TypeScript)
- [Phase 05]: allowImportingTsExtensions added to terminal tsconfig for .ts import paths
- [Phase 05]: ghost.ts builds CategorySummary[] inline from enriched results
- [Phase 05]: mcp.ts in-source tests verify structural wiring not full pipeline
- [Phase 05]: Agent fixture changed from subdirectory format to flat .md files matching scanAgents basename naming convention
- [Phase 06-output-control-polish]: Coverage-v8 version pinned to match vitest (^4.1.2) as peer dependency
- [Phase 06-output-control-polish]: Coverage thresholds passed as CLI flags in CI workflow for explicit visibility
- [Phase 06]: picocolors.createColors(false) for no-color identity functions instead of manual passthrough
- [Phase 06]: initColor() takes no arguments -- detects --no-color from process.argv directly (per D-07: root-level flag)
- [Phase 06]: getTableStyle() returns {} when color disabled to prevent cli-table3 @colors/colors ANSI injection
- [Phase 06-output-control-polish]: outputArgs excludes no-color per D-07 -- --no-color is root-level via initColor() reading process.argv directly
- [Phase 06-output-control-polish]: Output routing precedence: json -> csv -> quiet TSV -> rendered (else-if chain ensures --ci goes through JSON path)
- [Phase 06-output-control-polish]: trend never sets ghost-based exit code -- informational time-series (D-01); uses different CSV schema (date/bucket/agents/skills/mcp/total) per D-20
- [Phase 06-output-control-polish]: packages/terminal/tsconfig.json: added node + vitest/importMeta to types to fix process.argv globals in composite build (Rule 3 fix for Plan 01 oversight)
- [Phase 06-output-control-polish]: Repository URL sourced from git remote get-url origin (0xD-Fabio/ccaudit), not plan placeholder
- [Phase 06-output-control-polish]: License set to MIT for v1.0 npm publication (ccusage-aligned)
- [Phase 06-output-control-polish]: Gap #2 closure (Plan 06-06): restored scripts and devDependencies in apps/ccaudit/package.json via verbatim union with e3dbe01 metadata additions — sourced blocks from cb0932f (last pre-regression commit), preserved the resolved 0xD-Fabio/ccaudit remote URLs, documented clean-pkg-json's working-tree mutation side effect
- [Phase 06-output-control-polish]: Coverage config lives on root vitest.config.ts only — vitest projects mode inherits coverage from root, zero duplication across per-project configs
- [Phase 06-output-control-polish]: branches: 70 threshold is a deliberate compromise with inline rationale — defensive error paths (ENOENT, parse errors, stderr diagnostics) require elaborate fixtures; raising to 80 tracked as Phase 7+ tech debt
- [Phase 06-output-control-polish]: json-summary reporter added to coverage.reporter so test -d coverage succeeds in CI — text/text-summary are stdout-only and leave no filesystem artifact
- [Phase 06-output-control-polish]: CI coverage fix uses pnpm exec vitest --run --coverage (no dash-dash delimiter) — keeps root test script unchanged (TZ=UTC vitest) so local behavior is undisturbed
- [Phase 06-output-control-polish]: Private-helper branch coverage pattern: exercise module-private formatTier/formatRecommendation/formatLastUsed/formatTokenShort via public render* entry points with dated fixtures instead of exporting the helpers
- [Phase 07-dry-run-checkpoint]: StatFn injection parameter on computeGhostHash enables D-14 cache verification in tests because vi.spyOn cannot intercept node:fs/promises ESM exports (module namespace non-configurable)
- [Phase 07-dry-run-checkpoint]: MCP sourcePath cache uses Map<string, Promise<number>> not raw numbers - promise-valued memoization deduplicates concurrent Promise.all consumers where a synchronous number cache would race-miss
- [Phase 07-dry-run-checkpoint]: Atomic write pattern (tmp-then-rename, 0o700 dir / 0o600 file, process.pid suffix) established in checkpoint.ts to be reused by Phase 8 for ~/.claude.json mutations per RMED-09
- [Phase 07-dry-run-checkpoint]: Build-time CCAUDIT_VERSION via gen-version.mjs script + prebuild/pretest hooks (not tsdown define) — generated file _version.ts is git-ignored and regenerated on every build/test from package.json
- [Phase 07-dry-run-checkpoint]: Single-decision-point dry-run branch placed after enrichScanResults and before calculateHealthScore — 4 output-mode sub-branches within the dry-run block instead of orthogonal forking across the inventory path
- [Phase 07-dry-run-checkpoint]: Dry-run JSON envelope carries full changePlan + compact checkpoint projection (not just ghost_hash) — matches --csv row coverage and keeps --json --verbose non-redundant
- [Phase 07-dry-run-checkpoint]: Stale project-reference dist .d.ts files from Plan 01 required manual rebuild during Task 1+3 typecheck — pre-existing repo hygiene issue, recommend adding pnpm -r exec tsc to Plan 03 preconditions
- [Phase 07-dry-run-checkpoint]: Subprocess integration test pattern: spawn dist/index.js with HOME override, mkdtemp fixture, NO_COLOR=1 for deterministic stdout assertions
- [Phase 07-dry-run-checkpoint]: gunshi toKebab: true required at command level for camelCase arg keys to expose as --kebab-case on CLI (Plan 02's auto-kebab assumption was wrong)
- [Phase 07-dry-run-checkpoint]: gunshi renderHeader: null at cli() call site suppresses decorative banner that was leaking into --json/--csv/--quiet output for all commands (pre-existing Phase 6 bug)
- [Phase 07-dry-run-checkpoint]: Broad bare catch{} in try/catch-stat scanner loops mirrors scan-memory.ts precedent — handles ENOENT/ELOOP/EACCES/ENOTDIR uniformly without error-code discrimination
- [Phase 07-dry-run-checkpoint]: stat() not lstat() in scanners — follows symlinks so valid linked skills resolve through to target mtime; only broken links throw and get skipped
- [Phase 07-dry-run-checkpoint]: computeGhostHash null-sentinel safety net (HashRecord | null + type-predicate filter) preserves Promise.all parallelism and D-17 'items enter/leave eligible set' contract — un-stat-able items effectively leave the set
- [Phase 07-dry-run-checkpoint]: Two-layer fix for file-disappearance: scanner fix is primary root cause (populates mtimeMs at discovery), hash safety net is belt-and-suspenders against future scanner regressions
- [Phase 06-output-control-polish]: Gap #3 fix is documentation-only — D-16 JSON envelope is frozen; docs/JSON-SCHEMA.md exposes the canonical camelCase contract + README link + per-command --json help text extension
- [Phase 06-output-control-polish]: Gap #4 two-source flag declaration: outputArgs.no-color for gunshi help metadata + initColor() reading process.argv directly as authoritative runtime source (both agree because gunshi does not mutate process.argv)
- [Phase 06-output-control-polish]: Gap #5 presentation-layer aggregation: aggregateMcpByName helper in commands/mcp.ts collapses cross-project duplicates; scanner per-project dedup preserved for Phase 8 RMED-06 config-key traceability
- [Phase 06-output-control-polish]: Gap #5 exposes new projectPaths: string[] field in mcp --json items for automation traceability after presentation-layer aggregation
- [Phase 06-output-control-polish]: Gap #6 symmetric composite-project build stubs: packages/internal and packages/terminal both get build: tsc (idempotent via emitDeclarationOnly); root pnpm -r build fans out cleanly from any workspace directory
- [Phase 06-output-control-polish]: E2E test BINARY path must use fileURLToPath(import.meta.url) — pnpm -F ccaudit scopes cwd to apps/ccaudit so cwd-relative paths double-nest; matches dry-run-command.test.ts precedent

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: Verify `import.meta.vitest` stripping in tsdown (`inputOptions.define` vs `rolldownOptions.define`)
- [Phase 1]: Verify gunshi lazy subcommand loading survives tsdown bundling
- [Phase 4]: `ccaudit mcp --live` implementation needs spike on MCP connection/tokenization mechanics
- [Phase 8]: Windows `fs.rename` EPERM handling untested; decision needed before v1.2

## Session Continuity

Last session: 2026-04-05T06:40:32.101Z
Stopped at: Completed 06-07-PLAN.md (gap closure: all 4 escaped gaps from Phase 6 VERIFICATION.md closed — JSON schema docs, --no-color help visibility, mcp cross-project dedup, pnpm -r build subpackage stubs)
Resume file: None
