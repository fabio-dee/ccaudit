# CLAUDE.md

Project memory for AI coding assistants working in this repo. For end-user docs see [README.md](./README.md); release notes in [CHANGELOG.md](./CHANGELOG.md); JSON envelope reference in [docs/JSON-SCHEMA.md](./docs/JSON-SCHEMA.md).

## Project

`ccaudit` is a CLI that audits Claude Code's ghost inventory: agents, skills, MCP servers, commands, hooks, and memory files defined once but rarely invoked. It quantifies the per-session token cost and ships one reversible command to archive ghosts. Companion tool to [ccusage](https://github.com/ryoppippi/ccusage).

## Tech stack

TypeScript / Node ≥20 / pnpm 10 monorepo. CLI built on `gunshi`. JSON validation via `valibot.safeParse`. Globbing via `tinyglobby`. Tables via `cli-table3`. Bundled via `tsdown` (Rolldown). Tested via `vitest` 4.1. Formatted via `oxfmt`. Linted via `eslint` 9 flat config. **Zero runtime dependencies**: everything is `devDependencies` and bundled into `dist/`.

## Monorepo layout

```text
apps/ccaudit/        CLI entry, subcommand wrappers, integration tests, dist/ bundle
packages/internal/   Domain code: scanner, remediation, framework, token, history, report
packages/terminal/   Terminal renderers (tables, panels, color)
docs/                User-facing reference docs
```

## Commands

```bash
pnpm verify         # full gate: typecheck + lint + build + test + format:check
pnpm test           # vitest only (TZ=UTC enforced, no watch in CI)
pnpm build          # tsdown bundle into apps/ccaudit/dist/
pnpm format         # oxfmt --write .
```

CI is tag-triggered only. Pre-push hook runs format + lint (not tests). Run `pnpm verify` locally before opening a PR.

## Conventions

- **In-source tests** belong in `if (import.meta.vitest) { ... }` blocks at the bottom of source files. Integration tests live under `apps/ccaudit/src/__tests__/`. The bundler strips in-source tests via `define: { 'import.meta.vitest': 'undefined' }`.
- **Result types**: prefer `@praha/byethrow` `Result` over throwing across module boundaries.
- **Paths**: use forward slashes in glob patterns (tinyglobby normalizes). `os.homedir()` for home expansion. Never hard-code `/Users/...` or `/home/...`.
- **Time**: ISO 8601 UTC strings (`new Date().toISOString()`). Tests run with `TZ=UTC`.
- **Errors at boundaries**: at the outermost layer (CLI command, history writer), catch and degrade gracefully. Inside the domain, propagate via `Result`.
- **Frontmatter writes on memory files**: always go through `writeFilePreservingMtime` from `packages/internal/src/remediation/fs-utils.ts`. A bare `fs.writeFile` destroys the staleness signal.

## Safety invariants

These are user-visible behaviors that must not regress. Each was hard-won; the fix history is in the [v1.4.0 changelog entry](./CHANGELOG.md).

- **Nothing is deleted.** Agents and skills are _moved_ to `~/.claude/ccaudit/archived/`. MCP servers are _key-renamed_ in-place (`name` → `ccaudit-disabled:name`). Memory files get a _frontmatter flag_, never destructive rewrites.
- **Bust is gated by a dry-run checkpoint.** `--dangerously-bust-ghosts` requires a matching `--dry-run` checkpoint whose SHA-256 inventory hash equals the current scan. Hash mismatch aborts the bust.
- **MCP regime is pinned at dry-run time.** The checkpoint stores `mcp_regime` and `cc_version`; bust reads them rather than re-resolving. This eliminates the Before/After token-count drift that used to flip the regime non-deterministically.
- **mtime is preserved on memory file writes.** Bust+restore cycles must not reset mtime, or staleness detection silently lies.
- **`restore` walks every manifest** in `~/.claude/ccaudit/manifests/`, deduplicated by `archive_path` (newer wins). Single-manifest restore was a bug, not a feature: items archived by older busts must be reachable.
- **`reclaim` never overwrites an existing source path.** If the inferred source already exists, skip with a warning. Same for any future recovery command.
- **History writes never crash the main command.** `recordHistory` is wrapped in try/catch at the outermost layer; on failure emit one stderr warning and continue. `CCAUDIT_NO_HISTORY=1` short-circuits before any filesystem work.

## Where things live

- `apps/ccaudit/src/cli/commands/{ghost,restore,reclaim,mcp,trend,install-skill}.ts`: subcommand wrappers
- `apps/ccaudit/src/cli/index.ts`: gunshi command registration
- `packages/internal/src/scanner/`: discover agents, skills, MCP, memory, commands, hooks
- `packages/internal/src/framework/`: 3-tier framework detection (curated → heuristic → ungrouped) and the `DOMAIN_STOP_FOLDERS` negative list
- `packages/internal/src/remediation/{bust,restore,reclaim,frontmatter,manifest,checkpoint,fs-utils}.ts`: change planning and execution
- `packages/internal/src/token/`: per-category token estimators (regime-aware MCP, lazy skills, eager agents, etc.)
- `packages/internal/src/history/{writer,record,types}.ts`: `~/.claude/ccaudit/history.jsonl` audit trail
- `packages/terminal/src/tables/`: table renderers (ghost-table, shareable-block, mcp-table, framework-section, etc.)
- `apps/ccaudit/src/__tests__/`: integration tests (subprocess-based, use `_test-helpers.ts`)

## When working on this codebase

- Read [README.md](./README.md) for the user-facing surface area before changing any CLI behavior.
- New behavior must ship with a test: integration for end-to-end CLI flows, in-source for pure functions. TDD is the norm.
- Run `pnpm verify` before claiming work is done. Do not pass `--no-verify` or skip hooks unless explicitly authorized.
- Bug fixes affecting user-visible behavior should update [README.md](./README.md) and add an entry under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md).
- The `--json` envelope is a public contract. Shape changes go through [docs/JSON-SCHEMA.md](./docs/JSON-SCHEMA.md) and a CHANGELOG note flagged as breaking.
