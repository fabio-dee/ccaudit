# Milestones

## v1.2 Full Release (Shipped: 2026-04-06)

**Phases completed:** 9 phases, 37 plans, 75 tasks

**Key accomplishments:**

- pnpm monorepo with strict catalogs, zero-dep CLI skeleton, shared GhostItem types, and vitest in-source test infrastructure
- gunshi CLI skeleton with ghost stub command, tsdown-built shebang binary, and GitHub Actions CI pipeline verifying all Phase 1 success criteria
- Valibot schemas for JSONL line validation, parser type contracts, duration parser, MCP name splitter, and invocation extractor with 65 in-source tests
- Tinyglobby dual-path session discovery, streaming JSONL parser with node:readline + valibot safeParse, and wired ghost CLI command outputting real invocation counts from local session files
- Interface-first scanner type contracts (InventoryItem, ScanResult, InvocationSummary) with classifyGhost boundary classifier and buildInvocationMaps O(1) lookup builder
- Four inventory scanner modules (agents, skills, MCP servers, memory files) discovering installed items from filesystem and config files with 36 in-source vitest tests
- scanAll coordinator wiring all four inventory scanners with invocation-ledger matching, skillUsage fallback, per-project breakdown, and ghost CLI command producing real tier/lastUsed output
- Token estimation types, bundled MCP estimates JSON with valibot validation, file-size heuristic estimator, and ~-prefixed formatting functions
- Minimal MCP JSON-RPC 2.0 client using node:child_process for live token measurement via tools/list handshake
- Enrichment pipeline wiring all four categories into ghost command with token cost columns, plus new ccaudit mcp --live subcommand for measured token counts
- Health score calculator, recommendation classifier, and trend builder as pure functions in @ccaudit/internal with integration test scaffold for ghost command
- 10 render functions for @ccaudit/terminal: column-aligned ghost summary, cli-table3 bordered tables for inventory/mcp/trend, branded header with heavy box divider, and colored health score display using picocolors
- All 4 CLI subcommands (ghost, mcp, inventory, trend) wired to @ccaudit/terminal renderers with branded output, health scores, recommendations, and full integration test coverage
- Health score added to trend command and full discover->parse->scan->enrich pipeline test exercised against mock filesystem
- Centralized color detection with picocolors.createColors, RFC 4180 CSV formatter, and TSV quiet-mode formatter -- all renderers migrated to color-aware wrappers
- Wired shared output flags (--quiet, --csv, --ci) into all 4 CLI commands with exit code semantics, standardized JSON meta envelope, RFC 4180 CSV export, TSV quiet mode, and verbose messages routed to stderr
- @vitest/coverage-v8 installed across monorepo with CI enforcing 80% thresholds on ubuntu + macOS matrix
- Updated README with full v1.0 CLI flag reference, CI / Scripting section (exit codes, GitHub Actions, NO_COLOR, piping examples) and Flags Reference table, and finalized apps/ccaudit/package.json with keywords, license, author, homepage, and git-remote-sourced repository URL — validated zero-runtime-deps via npm pack --dry-run
- Moved coverage config into vitest.config.ts with documented exclusions + branches-70 rationale, fixed the CI workflow to invoke `pnpm exec vitest --run --coverage` (no `--` delimiter), and added 14 in-source branch tests to lift terminal-table renderer coverage from 50-64% branches to 85-100%.
- Restored the scripts and devDependencies blocks in apps/ccaudit/package.json that commit e3dbe01 accidentally deleted, regenerated dist/index.js from current source, and empirically proved the build/test/pack pipeline now works end-to-end.
- Closed the 4 escaped gaps from Phase 6 VERIFICATION.md (JSON schema discoverability, --no-color help visibility, mcp --csv cross-project duplicate rows, pnpm -r build from subpackages) in 8 atomic tasks with zero modifications to D-16, D-07, or Phase 8 RMED-06 invariant files.
- Pure-function change-plan builder, savings calculator, deterministic SHA-256 ghost-inventory hash, and atomic checkpoint read/write primitives that Phase 8's RMED-02 three-stage gate will consume.
- Wire Plan 01's remediation module into the ghost command as a `--dry-run` boolean flag, routing through all four Phase 6 output modes via a single decision point, with a dedicated grouped-by-action terminal renderer and a build-time `CCAUDIT_VERSION` injection for the checkpoint schema.
- End-to-end subprocess integration test (8 cases) covering every DRYR-01/02/03 Validation Architecture row, plus two inline bug fixes that made the --dry-run flag actually usable on the CLI — gunshi toKebab for the flag name and renderHeader null to stop the banner from corrupting JSON/CSV output.
- Two-layer fix for the Phase 7 escaped gap: scanSkills/scanAgents now populate mtimeMs via try/catch-wrapped stat, and computeGhostHash has a defensive safety net that filters un-stat-able items — `ccaudit --dry-run` against a real `~/.claude/` with broken-symlink skills no longer crashes with ENOENT.
- New module
- 1. [Rule 3 - Blocking] `SpawnOptionsWithoutStdio` type rejected explicit stdio config
- 1. [Cosmetic — test name normalization] Unicode arrow `→` for acceptance-criteria parity
- Note on count:
- 1. [Rule 1 - Plan text bug] `scanAll` signature mismatch in BustDeps.scanAndEnrich
- Problem.
- 1. [Rule 2 — Public doc drift] README Remediation Mechanics and Safety Design sections still described the obsolete v6 design
- Q1 (source_path occupied):
- 1. [Rule 1 - Bug] renderHeader takes 3 args, not 1
- 1. [Rule 1 - Bug] Wrong gunshi positional index for subcommand args

---
