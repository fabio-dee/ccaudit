# ccaudit

## What This Is

`ccaudit` is a companion CLI to [ccusage](https://github.com/ryoppippi/ccusage) that audits Claude Code's ghost inventory — agents, skills, MCP servers, and memory files that load every session but are rarely or never invoked. It ships analysis-only ghost detection with token cost attribution, a dry-run preview with hash-based checkpoint, and one-command remediation (`--dangerously-bust-ghosts`) with full rollback. Zero runtime dependencies, zero-install via `npx`.

## Core Value

Show users exactly how many tokens their ghost inventory wastes — and give them one safe, reversible command to reclaim them.

## Current State

**v1.2 shipped 2026-04-06.**

- ~16,500 lines TypeScript across `apps/ccaudit/`, `packages/internal/`, `packages/terminal/`
- 229 commits, 226 files, 37 plans across 9 phases
- 54/56 v1 requirements validated; 2 (COMM-01/02) deferred indefinitely
- All CI jobs green: ubuntu + macOS + windows-latest

**Shipped capabilities:**
- `npx ccaudit` — ghost inventory table with token cost attribution and health score
- `ccaudit inventory`, `ccaudit mcp`, `ccaudit mcp --live`, `ccaudit trend`
- `--json`, `--csv`, `--quiet`, `--verbose`, `--ci`, `--no-color`, `--since`
- `ccaudit --dry-run` — full change-plan preview with SHA-256 checkpoint
- `ccaudit --dangerously-bust-ghosts` — safe remediation with process gate + atomic writes
- `ccaudit restore` / `restore <name>` / `restore --list` — full rollback

## Requirements

### Validated (v1.2 — all shipped)

- ✓ Zero runtime dependencies — all deps as devDependencies, bundler owns the payload — v1.0
- ✓ `npx ccaudit --help` executes from working monorepo with shebang binary — v1.0
- ✓ Monorepo layout: apps/ccaudit/, packages/internal/, packages/terminal/, docs/ — v1.0
- ✓ Node.js >=20.0.0 engines field enforced — v1.0
- ✓ CI pipeline: lint, typecheck, test, build on every push — v1.0
- ✓ Parse JSONL session files from `~/.claude/projects/` and `~/.config/claude/projects/` — v1.0
- ✓ Project path decoded from `cwd` field in JSONL system message — v1.0
- ✓ Silent skip of malformed JSONL lines — v1.0
- ✓ Dual path support: XDG + legacy — v1.0
- ✓ `--since <duration>` flag on all read commands (default: 7d) — v1.0
- ✓ Ghost agents, skills, MCP servers, stale memory files detected — v1.0
- ✓ "Likely ghost" (7–30d) vs "definite ghost" (>30d) tiering — v1.0
- ✓ `lastUsed` date in every ghost row — v1.0
- ✓ Per-project breakdown alongside global view — v1.0
- ✓ Per-item token estimates from bundled `mcp-token-estimates.json` with `~` prefix — v1.0
- ✓ Confidence tiers: "estimated" / "measured" / "community-reported" — v1.0
- ✓ `ccaudit mcp --live` for exact token counts — v1.0
- ✓ Total ghost overhead as token count + % of 200k window — v1.0
- ✓ Ghost table with Defined / Used / Ghost / ~Token-cost columns — v1.0
- ✓ Health score (0–100), README badge-ready, CI gate semantics — v1.0
- ✓ Per-item recommendations: Archive / Monitor / Keep — v1.0
- ✓ `--since` window in output headers — v1.0
- ✓ Exit codes: 0 = no ghosts, 1 = ghosts found — v1.0
- ✓ `NO_COLOR` env var and `--no-color` flag — v1.0
- ✓ `--quiet` / `-q`, `--verbose` / `-v`, `--ci` flags — v1.0
- ✓ `--json` and `--csv` export on all read commands — v1.0
- ✓ `ccaudit --dry-run` — full change plan, no filesystem changes — v1.1
- ✓ Checkpoint written to `~/.claude/ccaudit/.last-dry-run` — v1.1
- ✓ Hash-based checkpoint invalidation — v1.1
- ✓ `ccaudit --dangerously-bust-ghosts` with two-prompt confirmation ceremony — v1.2
- ✓ Three-stage checkpoint gate (exists + hash match + recent) — v1.2
- ✓ Hard preflight: refuse if Claude Code process running — v1.2
- ✓ Archive agents/skills to `_archived/` (not delete) — v1.2
- ✓ MCP disable via key-rename (`ccaudit-disabled:<name>`) — v1.2
- ✓ Stale memory flagged with `ccaudit-stale: true` frontmatter — v1.2
- ✓ Incremental restore manifest written as operations complete — v1.2
- ✓ Atomic write pattern for all `~/.claude.json` mutations — v1.2
- ✓ `ccaudit restore` — full rollback from last bust — v1.2
- ✓ `ccaudit restore <name>` — restore single archived item — v1.2
- ✓ `ccaudit restore --list` — show all archived items with dates — v1.2

### Out of Scope

- **COMM-01/02**: `ccaudit contribute` / `mcp-token-estimates.json` community PR loop — deferred indefinitely
- Integration with Agent-Registry, the-library, or external tools — native algorithms only
- Cloud sync or remote storage — local-only, zero-install philosophy
- GUI or web dashboard — CLI-only; ccboard covers TUI/web space
- Auto-running on session start — user-initiated only
- Non-Claude Code tools (Cursor, Windsurf) — Claude Code JSONL schema only
- Destructive delete (vs archive) — trust model requires reversibility
- Comment-out in JSON config — JSON does not support comments
- Time-based checkpoint expiry — hash-based is correct

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

**Competitive landscape:**
- `who-ran-what`: unused agents/skills, no token attribution, no fix — Threat: MEDIUM-HIGH
- `agent-usage-analyzer`: skill-first, no ghost framing, no fix — Threat: MEDIUM
- `ccboard`: Rust TUI, agent stats + MCP, no ghost framing, no npx — Threat: HIGH if they add ghost+npx
- ccaudit differentiates on: token cost attribution + fix command + viral `--dangerously-bust-ghosts` UX

**Viral mechanics:**
- `--dangerously-bust-ghosts` flag name appears in every screenshot
- Two-prompt confirmation with "I accept full responsibility" is shareable content
- Before/after token numbers (108k → 12k) are the hook
- Ghost framing (`👻 Ghost Inventory`) in UX, not in tool name (avoids trademark)

## Constraints

- **Runtime deps**: Zero — all deps as `devDependencies`, bundler owns the payload (ccusage pattern)
- **Distribution**: `npx ccaudit@latest` — zero-install
- **Tech stack**: TypeScript/Node · `gunshi` CLI · `tinyglobby` · `valibot` safeParse · `cli-table3` · `tsdown` · `vitest` in-source tests · `pnpm` workspaces
- **Monorepo layout**: `apps/ccaudit/` (main CLI), `packages/internal/` (shared types/utils), `packages/terminal/` (table rendering), `docs/` (VitePress)
- **Reversibility**: All remediation ops fully reversible — archive not delete, key-rename not delete, flag not move
- **Safety gate**: `--dangerously-bust-ghosts` blocked unless checkpoint exists with matching hash

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Name: `ccaudit` not `ccghostbuster` | "Ghostbusters" is Sony trademark — legal risk at virality | ✓ Good |
| Ghost concept lives in UX, not name | Viral asset (`--dangerously-bust-ghosts`) without trademark exposure | ✓ Good |
| v1.0 analysis-only | Build trust before touching files; ccusage proved read-only earns adoption | ✓ Good |
| Hash-based checkpoint expiry | Time-based (24h) is wrong — a 5-min-old dry-run is invalid if user added agents; hash is correct | ✓ Implemented |
| Archive not delete for agents/skills | Reversibility; users won't trust a tool that deletes their work | ✓ Implemented |
| Key-rename not comment-out for MCP | JSON doesn't support comments — key-rename to `ccaudit-disabled:<name>` preserves valid JSON | ✓ Implemented |
| MCP config source: `~/.claude.json` not `settings.json` | MCP servers are in `~/.claude.json` and `.mcp.json`; `settings.json` contains permissions/hooks only | ✓ Corrected |
| Running-process gate before `~/.claude.json` mutation | `~/.claude.json` contains OAuth tokens; concurrent writes corrupt it | ✓ Implemented |
| `--live` ships in v1.0 | Token estimates start as guesses; users will quote them as facts; must provide verification path at launch | ✓ Shipped |
| All token estimates labeled `~` (approximate) | Trust dies if ccaudit reports wrong numbers at viral scale | ✓ Implemented |
| Two-prompt confirmation (not three) | Original three-prompt design (RMED-10) was over-engineered; two prompts + "I accept full responsibility" is sufficient ceremony | ✓ Corrected in Phase 8 |
| `--privacy-output` flag added post-v1.0 | Users couldn't safely share screenshots with real project paths visible | ✓ Shipped |
| Global baseline as separate section | Burying global items in the projects table obscured what loads every session vs project-specific | ✓ Shipped |

## Evolution

This document evolves at milestone boundaries.

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-06 after v1.2 milestone — all 9 phases complete, 54 requirements validated, full remediation + restore shipped*
