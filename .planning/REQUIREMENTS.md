# Requirements: ccaudit

**Defined:** 2026-04-03
**Core Value:** Show users exactly how many tokens their ghost inventory wastes -- and give them one safe, reversible command to reclaim them.

## v1 Requirements

### Foundation & Distribution

- [x] **DIST-01**: Tool executes via `npx ccaudit@latest` with zero pre-installation required
- [x] **DIST-02**: All runtime dependencies bundled at build time; published package has zero runtime `dependencies`
- [x] **DIST-03**: Dual path support: XDG (`~/.config/claude/`) and legacy (`~/.claude/`) paths resolved automatically
- [x] **DIST-04**: Malformed or schema-invalid JSONL lines silently skipped -- tool never throws on corrupt session data
- [x] **DIST-05**: `engines` field declares minimum Node.js version (20.x LTS)

### JSONL Parsing

- [x] **PARS-01**: Session files discovered from `~/.claude/projects/*/sessions/*.jsonl` and `~/.config/claude/projects/*/sessions/*.jsonl`
- [x] **PARS-02**: Subagent sessions (`isSidechain: true`, in `subagents/` subdir) included in invocation count
- [x] **PARS-03**: Agent invocations parsed from `type=assistant` `tool_use` blocks where `name='Agent'`; `input.subagent_type` = agent type
- [x] **PARS-04**: Skill invocations parsed from `tool_use` blocks where `name='Skill'`; `input.skill` = skill name
- [x] **PARS-05**: MCP invocations parsed from `tool_use` blocks where name matches `mcp__<server>__<tool>`; split on `__` -> [1]=server, [2]=tool
- [x] **PARS-06**: Project path resolved from `cwd` field in system messages (authoritative; not folder-name decoding)
- [x] **PARS-07**: `--since <duration>` flag on all read commands with configurable lookback (default: 7d)

### Inventory Scanner

- [x] **SCAN-01**: Ghost agents detected: files in `~/.claude/agents/` and `.claude/agents/` with zero invocations in time window
- [x] **SCAN-02**: Ghost skills detected: `~/.claude/skills/` and `.claude/skills/` files with zero `Skill` tool_use invocations in time window
- [x] **SCAN-03**: Ghost MCP servers detected: entries in `~/.claude.json` (`mcpServers` root key + `projects.<path>.mcpServers`) and `.mcp.json` with zero `mcp__<server>__*` invocations in time window
- [x] **SCAN-04**: Stale memory files detected: CLAUDE.md and `rules/` files with no modification in >30 days (file mod-date heuristic)
- [x] **SCAN-05**: "Likely ghost" tier (7-30d since last invocation) vs "definite ghost" tier (>30d / never) shown in default output
- [x] **SCAN-06**: `lastUsed` date shown in every ghost row -- never "ghost" without "last seen N days ago"
- [x] **SCAN-07**: Per-project breakdown available alongside global cross-project view

### Token Cost Attribution

- [x] **TOKN-01**: Per-item token cost estimated from embedded `mcp-token-estimates.json` (community-maintained, bundled at build)
- [x] **TOKN-02**: All estimates labeled with `~` prefix everywhere ("~15k tokens (estimated)") -- never bare numbers
- [x] **TOKN-03**: Confidence tier shown per estimate: "estimated" / "measured" / "community-reported"
- [x] **TOKN-04**: `ccaudit mcp --live` connects to running MCP servers for exact token count (ships v1.0 -- verification path required at launch)
- [x] **TOKN-05**: Total ghost overhead calculated and displayed as both token count and percentage of 200k context window

### Ghost Inventory Report

- [x] **REPT-01**: Default command (`npx ccaudit`) shows ghost inventory table: Defined / Used / Ghost / ~Token-cost columns per category
- [x] **REPT-02**: `ccaudit inventory` shows full inventory with all usage stats
- [x] **REPT-03**: `ccaudit mcp` shows MCP-specific detail view (token cost + frequency)
- [x] **REPT-04**: `ccaudit trend` shows invocation frequency over time
- [x] **REPT-05**: Health score (0-100) displayed in all report views; README badge-ready; CI gate semantics
- [x] **REPT-06**: Per-item recommendations shown: Archive / Monitor / Keep
- [x] **REPT-07**: `--since` window displayed prominently in output headers: "Ghosts (no invocations in past 7 days)"

### Output Control

- [x] **OUTP-01**: Exit codes: 0 = no ghosts found, 1 = ghosts found (enables CI/pre-commit use)
- [x] **OUTP-02**: `NO_COLOR` environment variable respected; `--no-color` flag available (ANSI-free for piped/CI output)
- [x] **OUTP-03**: `--quiet` / `-q` flag: machine-readable data only, no decorative output
- [x] **OUTP-04**: `--verbose` / `-v` flag: show files scanned, skipped, and parsing decisions
- [x] **OUTP-05**: `--ci` flag: combines exit-code + quiet + JSON for GitHub Actions / CI pipelines
- [x] **OUTP-06**: `--json` export on all read commands (structured output)
- [x] **OUTP-07**: `--csv` export on all read commands (spreadsheet-compatible)

### Dry-Run (v1.1)

- [x] **DRYR-01**: `ccaudit --dry-run` shows full change plan (which agents archived, which MCP servers disabled, estimated token savings) without touching the filesystem
- [x] **DRYR-02**: Checkpoint written to `~/.claude/ccaudit/.last-dry-run` on successful dry-run: timestamp + SHA-256 hash of current ghost inventory (agent file paths + mtimes + MCP configs)
- [x] **DRYR-03**: Checkpoint invalidated when ghost inventory hash changes (hash-based, not time-based expiry)

### Remediation (v1.2)

- [ ] **RMED-01**: `ccaudit --dangerously-bust-ghosts` is the remediation command; the flag name itself is the viral UX asset
- [ ] **RMED-02**: Two-stage checkpoint gate before confirmation ceremony: (1) checkpoint file exists at ~/.claude/ccaudit/.last-dry-run, (2) `computeGhostHash(current_inventory)` matches `checkpoint.ghost_hash`. The previously-worded time-based recency gate was dropped per Phase 8 D-01 in favor of hash-only invalidation, matching the PROJECT.md Key Decision "Hash-based checkpoint expiry" (time-based is wrong because it cannot capture "inventory changed").
- [ ] **RMED-03**: Hard preflight check: detect running Claude Code processes and refuse to mutate `~/.claude.json` if Claude Code is running (concurrent writes corrupt OAuth tokens and config)
- [ ] **RMED-04**: Agents archived to `~/.claude/agents/_archived/` (not deleted); project-local agents to `.claude/agents/_archived/`
- [ ] **RMED-05**: Skills archived to `~/.claude/skills/_archived/` (not deleted)
- [ ] **RMED-06**: MCP servers disabled via key-rename in `~/.claude.json`: entry moved from `mcpServers` to `ccaudit-disabled:<name>` key (preserves valid JSON; JSON comments are not valid)
- [ ] **RMED-07**: Stale memory files flagged with `ccaudit-stale: true` frontmatter (not moved, not deleted; still load normally -- flag is for human review)
- [ ] **RMED-08**: Incremental restore manifest written: each remediation operation appended as it completes; crash mid-operation still allows partial restore
- [ ] **RMED-09**: Atomic write pattern for all `~/.claude.json` mutations (write to temp, then `rename`)
- [ ] **RMED-10**: Two-prompt confirmation UX: [1/2] `Proceed busting? [y/N]` -> [2/2] type exactly `proceed busting`. The original three-prompt "I accept full responsibility" design was superseded by Phase 8 D-15/D-16 in favor of a lighter ceremony with the typed-phrase `--yes-proceed-busting` non-TTY bypass flag.
- [ ] **RMED-11**: `ccaudit restore`: full rollback from last bust
- [ ] **RMED-12**: `ccaudit restore <name>`: restore single archived item
- [ ] **RMED-13**: `ccaudit restore --list`: show all archived items with dates

### Community & Ecosystem

- [ ] **COMM-01**: `ccaudit contribute`: generate PR payload for `mcp-token-estimates.json` based on `--live` measurements
- [ ] **COMM-02**: `mcp-token-estimates.json` community contribution loop documented in README

## v2 Requirements

### Config & Persistence

- **CONF-01**: `.ccauditrc` config file support (allowlisting seasonal agents, custom `--since` default, CI thresholds)
- **CONF-02**: Per-project ignore list (`# ccaudit: ignore` comment in agent frontmatter)

### Extended Analysis

- **ANAL-01**: Cross-session usage heatmap (which agents cluster by time-of-day / project type)
- **ANAL-02**: "Agent family" grouping (e.g., all GSD agents shown as one group with aggregate token cost)
- **ANAL-03**: Memory file content analysis (flag CLAUDE.md sections with no recent relevance to project type)

### MCP Enhancement

- **MCPE-01**: `defer_loading` awareness: show whether each MCP server benefits from defer_loading vs must still be remediated
- **MCPE-02**: Actual before/after token measurement (connect before + after bust to measure real savings, not estimated)

### Distribution

- **DIST-06**: GitHub Action (`uses: ccaudit/action@v1`) with health-score threshold gate
- **DIST-07**: Homebrew formula for users who prefer non-npx installation

## Out of Scope

| Feature | Reason |
|---------|--------|
| Integration with Agent-Registry, the-library, or external tools | ccaudit implements all algorithms natively -- no external runtime deps |
| Cloud sync or remote storage | Local-only, zero-install philosophy; user data stays on device |
| GUI or web dashboard | CLI-only for v1; ccboard covers TUI/web space |
| Auto-running on session start | User-initiated only; passive monitoring violates trust model |
| Non-Claude Code tools (Cursor, Windsurf) | Claude Code JSONL schema only; other tools use different formats |
| Destructive delete (vs archive) | Trust model requires reversibility; one data-loss report kills adoption |
| Comment-out in JSON config | JSON does not support comments; produces parse errors on startup |
| Time-based checkpoint expiry | Hash-based is correct -- time doesn't capture "inventory changed" |

## Traceability

| Requirement | Phase | Milestone | Status |
|-------------|-------|-----------|--------|
| DIST-01 | Phase 1: Foundation & Scaffold | v1.0 | Pending |
| DIST-02 | Phase 1: Foundation & Scaffold | v1.0 | Pending |
| DIST-03 | Phase 1: Foundation & Scaffold | v1.0 | Pending |
| DIST-04 | Phase 1: Foundation & Scaffold | v1.0 | Pending |
| DIST-05 | Phase 1: Foundation & Scaffold | v1.0 | Pending |
| PARS-01 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-02 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-03 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-04 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-05 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-06 | Phase 2: JSONL Parser | v1.0 | Pending |
| PARS-07 | Phase 2: JSONL Parser | v1.0 | Pending |
| SCAN-01 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-02 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-03 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-04 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-05 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-06 | Phase 3: Inventory Scanner | v1.0 | Pending |
| SCAN-07 | Phase 3: Inventory Scanner | v1.0 | Pending |
| TOKN-01 | Phase 4: Token Cost Attribution | v1.0 | Pending |
| TOKN-02 | Phase 4: Token Cost Attribution | v1.0 | Pending |
| TOKN-03 | Phase 4: Token Cost Attribution | v1.0 | Pending |
| TOKN-04 | Phase 4: Token Cost Attribution | v1.0 | Pending |
| TOKN-05 | Phase 4: Token Cost Attribution | v1.0 | Pending |
| REPT-01 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-02 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-03 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-04 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-05 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-06 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| REPT-07 | Phase 5: Report & CLI Commands | v1.0 | Pending |
| OUTP-01 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-02 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-03 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-04 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-05 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-06 | Phase 6: Output Control & Polish | v1.0 | Pending |
| OUTP-07 | Phase 6: Output Control & Polish | v1.0 | Pending |
| DRYR-01 | Phase 7: Dry-Run & Checkpoint | v1.1 | Pending |
| DRYR-02 | Phase 7: Dry-Run & Checkpoint | v1.1 | Pending |
| DRYR-03 | Phase 7: Dry-Run & Checkpoint | v1.1 | Pending |
| RMED-01 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-02 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-03 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-04 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-05 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-06 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-07 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-08 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-09 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-10 | Phase 8: Remediation Core | v1.2 | Pending |
| RMED-11 | Phase 9: Restore & Rollback | v1.2 | Pending |
| RMED-12 | Phase 9: Restore & Rollback | v1.2 | Pending |
| RMED-13 | Phase 9: Restore & Rollback | v1.2 | Pending |
| COMM-01 | Phase 10: Community Contribution | v1.2 | Pending |
| COMM-02 | Phase 10: Community Contribution | v1.2 | Pending |

**Coverage:**
- v1 requirements: 56 total
- Mapped to phases: 56
- Unmapped: 0

---
*Requirements defined: 2026-04-03*
*Last updated: 2026-04-03 after roadmap creation (10-phase fine-granularity structure)*
