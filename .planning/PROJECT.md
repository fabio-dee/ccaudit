# ccaudit

## What This Is

`ccaudit` is a companion CLI to [ccusage](https://github.com/ryoppippi/ccusage) that audits Claude Code's ghost inventory — agents, skills, MCP servers, and memory files that load every session but are rarely or never invoked. It ships analysis-only in v1, adds a dry-run preview in v1.1, and delivers one-command remediation (`--dangerously-bust-ghosts`) with full rollback in v1.2. Zero runtime dependencies, zero-install via `npx`.

## Core Value

Show users exactly how many tokens their ghost inventory wastes — and give them one safe, reversible command to reclaim them.

## Requirements

### Validated

- [x] Zero runtime dependencies — all deps as devDependencies, bundler owns the payload (Validated in Phase 1: Foundation & Scaffold)
- [x] `npx ccaudit --help` executes from working monorepo with shebang binary (Validated in Phase 1: Foundation & Scaffold)
- [x] Monorepo layout: apps/ccaudit/, packages/internal/, packages/terminal/, docs/ (Validated in Phase 1: Foundation & Scaffold)
- [x] Node.js >=20.0.0 engines field enforced (Validated in Phase 1: Foundation & Scaffold)
- [x] CI pipeline: lint, typecheck, test, build on every push (Validated in Phase 1: Foundation & Scaffold)
- [x] Parse JSONL session files from `~/.claude/projects/` and `~/.config/claude/projects/` to build an invocation ledger (Validated in Phase 2: JSONL Parser)
- [x] Project path decoded from `cwd` field in JSONL system message (authoritative, not folder-name heuristic) (Validated in Phase 2: JSONL Parser)
- [x] Silent skip of malformed JSONL lines — never throw (Validated in Phase 2: JSONL Parser)
- [x] Dual path support: XDG (`~/.config/claude/`) and legacy (`~/.claude/`) (Validated in Phase 2: JSONL Parser)
- [x] `--since <duration>` flag on all read commands (default: 7d); display window prominently in output header (Validated in Phase 2: JSONL Parser — parser + ghost command wired)
- [x] Detect ghost agents: files in `~/.claude/agents/` and `.claude/agents/` with zero invocations in the time window (Validated in Phase 3: Inventory Scanner)
- [x] Detect ghost skills: `Skill` tool_use entries matched against skill files; absent = ghost (Validated in Phase 3: Inventory Scanner)
- [x] Detect ghost MCP servers: `mcp__<server>__*` tool_use entries matched against `~/.claude.json` (root `mcpServers` + `projects.<path>.mcpServers`) and `.mcp.json`; absent = ghost (Validated in Phase 3: Inventory Scanner)
- [x] Detect stale memory files: CLAUDE.md and rules/ files with no recent modification (mod-date heuristic) (Validated in Phase 3: Inventory Scanner)
- [x] "Likely ghost" (7–30d) vs "definite ghost" (>30d) tiering in default output (Validated in Phase 3: Inventory Scanner)

### Active

**v1.0 — Analysis (read-only)**
- [x] Calculate per-item token cost estimates (embedded `mcp-token-estimates.json`, community-maintained) (Validated in Phase 4: Token Cost Attribution)
- [x] Render ghost inventory table with Defined / Used / Ghost / Token-cost columns per category; show `lastUsed` date in every ghost row (Validated in Phase 5: Report & CLI Commands)
- [x] All token estimates labeled `~` prefix ("~15k tokens (estimated)") — never bare numbers; show "estimated" vs "measured" vs "community-reported" confidence (Validated in Phase 4: Token Cost Attribution)
- [x] Health score (0–100) summary: single shareable number, README badge-ready, CI gate semantics (Validated in Phase 5: Report & CLI Commands)
- [ ] Exit codes: 0 = no ghosts, 1 = ghosts found (enables CI/pre-commit use)
- [ ] `NO_COLOR` env var and `--no-color` flag (ANSI-free output for piped/CI contexts)
- [ ] `--quiet` / `-q` flag (data-only output for scripts)
- [ ] `--verbose` / `-v` flag (show what was scanned/skipped)
- [ ] `--ci` flag (combines exit-code + quiet + JSON for GitHub Actions / CI pipelines)
- [ ] `--json` and `--csv` export on all read commands
- [x] `npx ccaudit ghost` (default), `ccaudit inventory`, `ccaudit mcp`, `ccaudit trend` (Validated in Phase 5: Report & CLI Commands)
- [x] `ccaudit mcp --live` for exact token counts via live MCP connection (must ship v1.0 — prevents "estimates are wrong" narrative) (Validated in Phase 4: Token Cost Attribution)


**v1.1 — Dry-run**
- [ ] `ccaudit --dry-run`: full change plan output, no filesystem changes
- [ ] Write checkpoint to `~/.claude/ccaudit/.last-dry-run` on successful dry-run
- [ ] Checkpoint contains: timestamp, ghost inventory hash (sha256 of agents/skills/settings dirs), item counts

**v1.2 — Remediation**
- [ ] `ccaudit --dangerously-bust-ghosts`: gated remediation with triple confirmation
- [ ] Checkpoint enforcement: must exist + hash must match (hash-based expiry, not time-based)
- [ ] Hard preflight gate: detect running Claude Code processes and refuse to mutate `~/.claude.json` if running (concurrent writes corrupt OAuth tokens + config)
- [ ] Atomic write pattern for all config mutations (write to temp file, then rename)
- [ ] Archive agents/skills to `_archived/` subdirectory (not delete)
- [ ] Disable MCP servers via key-rename in `~/.claude.json`: move entry from `mcpServers` to `ccaudit-disabled:<name>` key (preserves valid JSON, preserves full config for restore; JSON does not support comments — comment-out is impossible)
- [ ] Flag stale memory files with `ccaudit-stale: true` frontmatter (not move, not delete)
- [ ] `ccaudit restore`: full rollback from last bust
- [ ] `ccaudit restore <name>`: restore single archived item
- [ ] `ccaudit restore --list`: show all archived items
- [ ] `ccaudit contribute`: generate PR payload for `mcp-token-estimates.json`

### Out of Scope

- Integration with Agent-Registry, the-library, or any external tool — ccaudit implements all algorithms natively
- Cloud sync or remote storage — local-only, zero-install philosophy
- GUI or web dashboard — CLI-only for v1 (ccboard covers TUI/web space)
- Automatic invocation on session start — user-initiated analysis only
- Non-Claude Code tools (Cursor, Windsurf, etc.) — Claude Code JSONL schema only for v1

## Context

**The problem (real numbers, anthropics/claude-code#7336):**
Before any conversation: ~108k tokens consumed (54% of 200k window) — MCP tools, custom agents, system tools, memory files. ccaudit names and fixes this.

**Ecosystem positioning:**
- `ccusage` → "What did you spend?" `ccaudit` → "What are you loading vs actually using — and fix it."
- Companion pair framing: README writes itself, naming is instantly understood.

**JSONL schema (confirmed from local inspection):**
- Invocations are `tool_use` blocks in `type=assistant` messages
- Agents: `name='Agent'`, `input.subagent_type` = agent type name
- Skills: `name='Skill'`, `input.skill` = skill name (e.g., `'gsd:new-project'`)
- MCP: `name='mcp__<server>__<tool>'` — split on `__`, [1]=server, [2]=tool
- Subagent sessions: `isSidechain=true`, stored in `subagents/` subdirectory
- Project path: `cwd` field in system messages — authoritative
- No dedicated skill-slash-command event type — `Skill` tool_use is the signal

**Competitive landscape:**
- `who-ran-what`: unused agents/skills, no token attribution, no fix — Threat: MEDIUM-HIGH
- `agent-usage-analyzer`: skill-first, no ghost framing, no fix — Threat: MEDIUM
- `ccboard`: Rust TUI, agent stats + MCP, no ghost framing, no npx — Threat: HIGH if they add ghost+npx
- ccaudit differentiates on: token cost attribution + fix command + viral `--dangerously-bust-ghosts` UX

**Reference implementations to study (not depend on):**
`ryoppippi/ccusage` (architecture), `florianbruniaux/ccboard` (JSONL parsing), `mylee04/who-ran-what` (detection logic), `yctimlin/agent-usage-analyzer` (signal detection), `delexw/claude-code-trace` (MCP parsing), `simonw/claude-code-transcripts` (clean parser), `MaTriXy/Agent-Registry` (archive algorithm)

**Viral mechanics:**
- `--dangerously-bust-ghosts` flag name appears in every screenshot
- Triple confirmation with "I accept full responsibility" is shareable content
- Before/after token numbers (108k → 12k) are the hook
- Ghost framing (`👻 Ghost Inventory`) in UX, not in tool name (avoids trademark)

## Constraints

- **Runtime deps**: Zero — all deps as `devDependencies`, bundler owns the payload (ccusage pattern)
- **Distribution**: `npx ccaudit@latest` — zero-install, read-only v1 builds trust first
- **Tech stack**: TypeScript/Node · `gunshi` CLI · `tinyglobby` · `valibot` safeParse · `cli-table3` · `tsdown` · `vitest` in-source tests · `pnpm` workspaces
- **Monorepo layout**: `apps/ccaudit/` (main CLI), `apps/ccaudit-mcp/` (future), `packages/internal/` (shared types/utils), `packages/terminal/` (table rendering), `docs/` (VitePress)
- **Reversibility**: All remediation ops must be fully reversible — archive not delete, comment-out not delete, flag not move
- **Safety gate**: `--dangerously-bust-ghosts` blocked unless current dry-run checkpoint with matching hash exists

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Name: `ccaudit` not `ccghostbuster` | "Ghostbusters" is Sony trademark — legal risk at virality | — Pending |
| Ghost concept lives in UX, not name | Viral asset (`--dangerously-bust-ghosts`) without trademark exposure | — Pending |
| v1.0 analysis-only | Build trust before touching files; ccusage proved read-only earns adoption | — Pending |
| Hash-based checkpoint expiry | Time-based (24h) is wrong — a 5-min-old dry-run is invalid if user added agents; hash is correct | — Pending |
| Archive not delete for agents/skills | Reversibility; users won't trust a tool that deletes their work | — Pending |
| Key-rename not comment-out for MCP | JSON doesn't support comments — `// foo` in JSON = parse error; key-rename to `ccaudit-disabled:<name>` preserves valid JSON | ✓ Corrected |
| MCP config source: `~/.claude.json` not `settings.json` | MCP servers are in `~/.claude.json` and `.mcp.json`; `settings.json` contains permissions/hooks only | ✓ Corrected |
| Running-process gate before `~/.claude.json` mutation | `~/.claude.json` contains OAuth tokens; concurrent writes corrupt it; must detect + refuse if Claude Code is running | ✓ Added |
| `--live` ships in v1.0 | Token estimates start as guesses; users will quote them as facts; must provide verification path at launch | ✓ Confirmed |
| All token estimates labeled `~` (approximate) | Trust dies if ccaudit reports wrong numbers at viral scale | ✓ Added |
| No external runtime dependencies | ccusage proved this earns trust and simplifies distribution | — Pending |
| Project path from `cwd` field | More reliable than decoding folder-name encoding; handles edge cases | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-04 after Phase 5 completion*
