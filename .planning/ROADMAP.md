# Roadmap: ccaudit

## Overview

ccaudit ships in three milestones: v1.0 delivers analysis-only ghost detection with token cost attribution (the viral launch candidate), v1.1 adds dry-run preview with checkpoint verification, and v1.2 delivers one-command remediation with full rollback. Ten phases, derived from nine requirement categories and expanded to fine granularity, take the project from empty monorepo to community contribution loop.

## Milestones

- **Milestone 1 -- v1.0 Analysis** (Phases 1-6): Read-only ghost detection, token attribution, all CLI commands, all output formats. The viral launch candidate.
- **Milestone 2 -- v1.1 Dry-Run** (Phase 7): Change plan preview with hash-based checkpoint.
- **Milestone 3 -- v1.2 Remediation** (Phases 8-10): Safe, reversible ghost busting with restore and community contribution.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3, ...): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation & Scaffold** - Monorepo, build pipeline, CLI skeleton, zero-dep invariant
- [ ] **Phase 2: JSONL Parser** - Session discovery, streaming parser, invocation extractors
- [ ] **Phase 3: Inventory Scanner** - Ghost detection across agents, skills, MCP servers, memory files
- [ ] **Phase 4: Token Cost Attribution** - Per-item token estimates, confidence tiers, live MCP measurement
- [ ] **Phase 5: Report & CLI Commands** - Ghost table, all subcommands, health score, recommendations
- [ ] **Phase 6: Output Control & Polish** - Exit codes, NO_COLOR, quiet/verbose/ci/json/csv, release prep
- [ ] **Phase 7: Dry-Run & Checkpoint** - Change plan preview, SHA-256 checkpoint, hash-based invalidation
- [ ] **Phase 8: Remediation Core** - Archive, key-rename MCP disable, memory flagging, safety gates
- [ ] **Phase 9: Restore & Rollback** - Full and partial restore from incremental manifest
- [ ] **Phase 10: Community Contribution** - ccaudit contribute, mcp-token-estimates.json PR payload

## Phase Details

### Phase 1: Foundation & Scaffold
**Goal**: Developer can run `npx ccaudit --help` from a working monorepo with build pipeline, tests, and CI -- the zero-dep invariant holds from day one
**Depends on**: Nothing (first phase)
**Requirements**: DIST-01, DIST-02, DIST-03, DIST-04, DIST-05
**Success Criteria** (what must be TRUE):
  1. `npx ccaudit --help` executes and prints usage information (binary has shebang, runs without error)
  2. `npm pack --dry-run` shows zero runtime `dependencies` in the published package
  3. Monorepo structure exists: `apps/ccaudit/`, `packages/internal/`, `packages/terminal/`, `docs/` -- pnpm workspaces resolve correctly
  4. CI pipeline runs lint, typecheck, test, and build on every push
  5. `engines` field in package.json declares Node.js >=20.x
**Plans:** 2 plans
Plans:
- [x] 01-01-PLAN.md — Monorepo workspace, root configs, package skeletons, shared types
- [x] 01-02-PLAN.md — CLI skeleton (gunshi), build pipeline (tsdown), CI workflow

### Phase 2: JSONL Parser
**Goal**: The tool can discover all session files (XDG + legacy paths, including subagent sessions) and extract a complete invocation ledger for agents, skills, and MCP tools within a configurable time window
**Depends on**: Phase 1
**Requirements**: PARS-01, PARS-02, PARS-03, PARS-04, PARS-05, PARS-06, PARS-07
**Success Criteria** (what must be TRUE):
  1. Session files are discovered from both `~/.claude/projects/*/sessions/` and `~/.config/claude/projects/*/sessions/` (dual-path), including `subagents/` subdirectories
  2. Agent, Skill, and MCP invocations are correctly extracted from `tool_use` blocks with their respective identifiers (subagent_type, skill name, server__tool split)
  3. Project path is resolved from the `cwd` field in system messages, not from folder-name decoding
  4. Malformed JSONL lines are silently skipped -- the parser never throws on corrupt data
  5. `--since <duration>` flag filters the invocation ledger to the specified window (default 7d)
**Plans:** 2 plans
Plans:
- [x] 02-01-PLAN.md — Parser types, valibot schemas, duration parser, invocation extractor
- [x] 02-02-PLAN.md — Session discovery (tinyglobby), streaming JSONL parser, ghost CLI wiring

### Phase 3: Inventory Scanner
**Goal**: The tool detects ghost items across all four categories (agents, skills, MCP servers, memory files) by comparing installed inventory against the invocation ledger, with tiered ghost classification and per-project breakdown
**Depends on**: Phase 2
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, SCAN-06, SCAN-07
**Success Criteria** (what must be TRUE):
  1. Ghost agents and ghost skills are detected by comparing files in `~/.claude/agents/` (and `.claude/agents/`), `~/.claude/skills/` (and `.claude/skills/`) against the invocation ledger
  2. Ghost MCP servers are detected by reading `~/.claude.json` (root `mcpServers` + `projects.<path>.mcpServers`) and `.mcp.json`, then comparing against `mcp__<server>__*` invocations
  3. Stale memory files (CLAUDE.md, `rules/` files with no modification in >30 days) are detected via file mod-date heuristic
  4. Each ghost item shows `lastUsed` date and is classified as "likely ghost" (7-30d) or "definite ghost" (>30d / never)
  5. Per-project breakdown is available alongside the global cross-project view
**Plans:** 4 plans
Plans:
- [x] 03-01-PLAN.md — Scanner type contracts, ghost classification, invocation map builder
- [x] 03-02-PLAN.md — Four scanner modules (agents, skills, MCP servers, memory files)
- [x] 03-03-PLAN.md — Coordinator, barrel exports, ghost CLI wiring

### Phase 4: Token Cost Attribution
**Goal**: Every ghost item has an estimated token cost from the bundled `mcp-token-estimates.json`, with clear confidence labeling and a `--live` path for exact MCP server measurements
**Depends on**: Phase 3
**Requirements**: TOKN-01, TOKN-02, TOKN-03, TOKN-04, TOKN-05
**Success Criteria** (what must be TRUE):
  1. Per-item token estimates are looked up from the bundled `mcp-token-estimates.json` and displayed with `~` prefix (e.g., "~15k tokens (estimated)")
  2. Confidence tier is shown per estimate: "estimated" / "measured" / "community-reported"
  3. `ccaudit mcp --live` connects to running MCP servers and returns exact token counts (verification path available at launch)
  4. Total ghost overhead is displayed as both absolute token count and percentage of the 200k context window
**Plans:** 2/3 plans executed
Plans:
- [x] 04-01-PLAN.md — Token types, bundled JSON data, file-size estimator, format functions
- [x] 04-02-PLAN.md — Minimal MCP JSON-RPC client for --live measurement
- [x] 04-03-PLAN.md — Enrichment pipeline, ghost command token display, mcp subcommand

### Phase 5: Report & CLI Commands
**Goal**: Users can run `ccaudit ghost`, `ccaudit inventory`, `ccaudit mcp`, and `ccaudit trend` to see ghost tables with Defined/Used/Ghost/Token-cost columns, a health score, per-item recommendations, and the `--since` window prominently displayed
**Depends on**: Phase 4
**Requirements**: REPT-01, REPT-02, REPT-03, REPT-04, REPT-05, REPT-06, REPT-07
**Success Criteria** (what must be TRUE):
  1. `npx ccaudit` (default) renders a ghost inventory table with Defined / Used / Ghost / ~Token-cost columns per category
  2. `ccaudit inventory`, `ccaudit mcp`, and `ccaudit trend` each produce their specialized views
  3. Health score (0-100) appears in all report views and is suitable for README badges and CI gate semantics
  4. Per-item recommendations (Archive / Monitor / Keep) are shown in output
  5. `--since` window is displayed prominently in output headers (e.g., "Ghosts (no invocations in past 7 days)")
  6. Integration tests exercise the full `ghost` command path using a mock filesystem (tmp directory) and fixture JSONL files, asserting on the rendered output columns and row counts
**Plans:** 4 plans
Plans:
- [x] 05-01-PLAN.md — Report logic: health score, recommendation classifier, trend builder
- [x] 05-02-PLAN.md — Terminal rendering layer: table builders, header, score display
- [x] 05-03-PLAN.md — CLI command wiring: refactor ghost/mcp, create inventory/trend
- [x] 05-04-PLAN.md — Gap closure: health score in trend command, end-to-end pipeline test
**UI hint**: yes

### Phase 6: Output Control & Polish
**Goal**: The tool is CI-ready and script-friendly with exit codes, color control, quiet/verbose modes, JSON/CSV export, and release-quality documentation
**Depends on**: Phase 5
**Requirements**: OUTP-01, OUTP-02, OUTP-03, OUTP-04, OUTP-05, OUTP-06, OUTP-07
**Success Criteria** (what must be TRUE):
  1. Exit code is 0 when no ghosts are found and 1 when ghosts are found (enables CI/pre-commit use)
  2. `NO_COLOR` env var and `--no-color` flag produce ANSI-free output; `--quiet` suppresses decorative output; `--verbose` shows scan details
  3. `--ci` flag combines exit-code + quiet + JSON for GitHub Actions pipelines
  4. `--json` and `--csv` flags produce structured and spreadsheet-compatible export on all read commands
  5. README, npm metadata, and package are publication-ready (this is the v1.0 launch candidate)
  6. CI test job enforces an 80% coverage threshold via `vitest --coverage`; the job fails if coverage drops below the threshold
  7. CI matrix runs tests on both `ubuntu-latest` and `macos-latest`; all jobs pass on both platforms
**Plans:** 4 plans
Plans:
- [x] 06-01-PLAN.md — Terminal foundation: color control, CSV formatter, TSV quiet formatter, renderer updates
- [x] 06-02-PLAN.md — Command wiring: shared args, output mode, exit codes, JSON envelope, CSV/quiet paths
- [x] 06-03-PLAN.md — CI polish: @vitest/coverage-v8, OS matrix (ubuntu+macOS), 80% coverage thresholds
- [x] 06-04-PLAN.md — Publication prep: README flag docs, CI examples, npm metadata (SC-5)

### Phase 7: Dry-Run & Checkpoint
**Goal**: Users can preview exactly what remediation would change without touching the filesystem, and the tool writes a hash-based checkpoint that gates future remediation
**Depends on**: Phase 6
**Requirements**: DRYR-01, DRYR-02, DRYR-03
**Success Criteria** (what must be TRUE):
  1. `ccaudit --dry-run` outputs a full change plan (which agents would be archived, which MCP servers disabled, estimated token savings) without modifying any files
  2. A checkpoint file is written to `~/.claude/ccaudit/.last-dry-run` containing timestamp and SHA-256 hash of the current ghost inventory
  3. The checkpoint is invalidated when the ghost inventory hash changes (hash-based, not time-based expiry)
**Plans**: TBD

### Phase 8: Remediation Core
**Goal**: `ccaudit --dangerously-bust-ghosts` safely remediates all ghost items -- archiving agents/skills, disabling MCP servers via key-rename, flagging stale memory -- with running-process detection, atomic writes, and triple confirmation
**Depends on**: Phase 7
**Requirements**: RMED-01, RMED-02, RMED-03, RMED-04, RMED-05, RMED-06, RMED-07, RMED-08, RMED-09, RMED-10
**Success Criteria** (what must be TRUE):
  1. `ccaudit --dangerously-bust-ghosts` refuses to run unless a valid checkpoint exists with matching hash
  2. The command refuses to mutate `~/.claude.json` if a running Claude Code process is detected (hard preflight gate)
  3. Ghost agents are archived to `_archived/` subdirectories (not deleted); ghost skills likewise archived
  4. Ghost MCP servers are disabled via key-rename in `~/.claude.json` (entry moved from `mcpServers` to `ccaudit-disabled:<name>` key, preserving valid JSON)
  5. Stale memory files receive `ccaudit-stale: true` frontmatter (not moved, not deleted)
  6. All `~/.claude.json` mutations use atomic write-to-temp-then-rename pattern
  7. An incremental restore manifest is written as operations complete (crash mid-operation allows partial restore)
  8. Triple confirmation UX: proceed? -> are you sure? -> type "I accept full responsibility"
  9. CI matrix extended to `windows-latest`; `fs.rename` EPERM retry logic verified on Windows with exponential backoff test
**Plans**: TBD

### Phase 9: Restore & Rollback
**Goal**: Users can fully reverse any remediation -- restoring all archived items at once, restoring a single item by name, or listing what was archived
**Depends on**: Phase 8
**Requirements**: RMED-11, RMED-12, RMED-13
**Success Criteria** (what must be TRUE):
  1. `ccaudit restore` fully reverses the last bust operation (agents moved back, MCP keys renamed back, frontmatter removed)
  2. `ccaudit restore <name>` restores a single archived item by name
  3. `ccaudit restore --list` shows all archived items with their dates
**Plans**: TBD

### Phase 10: Community Contribution
**Goal**: Users with `--live` measurements can generate a PR payload to contribute back to the community `mcp-token-estimates.json`, closing the data quality loop
**Depends on**: Phase 9
**Requirements**: COMM-01, COMM-02
**Success Criteria** (what must be TRUE):
  1. `ccaudit contribute` generates a structured PR payload based on the user's `--live` MCP measurements
  2. The contribution workflow is documented in the README so users understand how `mcp-token-estimates.json` improves over time
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Scaffold | v1.0 | 0/2 | Planning complete | - |
| 2. JSONL Parser | v1.0 | 0/2 | Planning complete | - |
| 3. Inventory Scanner | v1.0 | 0/3 | Planning complete | - |
| 4. Token Cost Attribution | v1.0 | 2/3 | In Progress|  |
| 5. Report & CLI Commands | v1.0 | 0/4 | Gap closure | - |
| 6. Output Control & Polish | v1.0 | 0/4 | Planning complete | - |
| 7. Dry-Run & Checkpoint | v1.1 | 0/0 | Not started | - |
| 8. Remediation Core | v1.2 | 0/0 | Not started | - |
| 9. Restore & Rollback | v1.2 | 0/0 | Not started | - |
| 10. Community Contribution | v1.2 | 0/0 | Not started | - |
