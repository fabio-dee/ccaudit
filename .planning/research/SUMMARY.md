# Research Summary — ccaudit

**Synthesized:** 2026-04-03 from 4 parallel research agents (STACK, FEATURES, ARCHITECTURE, PITFALLS)

---

## Critical Findings (PROJECT.md Corrections Required)

These are not preferences — they are factual errors in the current PROJECT.md that will cause broken behavior or data loss if shipped as written. They must be resolved before requirements are finalized.

### C1: MCP Config File Is Wrong

**PROJECT.md says:** "Detect ghost MCP servers matched against `settings.json`"
**Reality:** MCP servers are configured in `~/.claude.json` (user scope) and `.mcp.json` (project scope). `settings.json` holds permissions and hooks — it has zero MCP server entries.

**Impact at v1.0:** If ccaudit reads `settings.json` for MCP servers it finds nothing, reports all MCP servers as "not configured," and the ghost count is zero. The viral "108k tokens" number collapses immediately.

**Impact at v1.2:** Writing MCP disable state to `settings.json` does nothing — the actual MCP config in `~/.claude.json` is untouched.

**Fix:** Config Scanner must read `~/.claude.json` (root `mcpServers` key AND `projects.<encoded-path>.mcpServers`) plus `.mcp.json` for project-scoped servers. Source: [Claude Code Settings docs](https://code.claude.com/docs/en/settings).

---

### C2: Comment-Out MCP Remediation Strategy Is Impossible

**PROJECT.md says:** "Comment-out MCP servers in `settings.json` with `// ccaudit-disabled` prefix"
**Reality (two independent failure axes):**
1. JSON does not support comments. Writing `//` into any `.json` file produces invalid JSON. Claude Code will crash on startup with "JSON Parse error: Unexpected EOF" (confirmed GitHub issues #1506, #2835, #33650).
2. Even if JSONC were supported (it is not — open feature request #29370, unimplemented), MCP configs live in `~/.claude.json`, not `settings.json`.

**The correct approach:** Key-rename strategy. Move the server entry from `mcpServers` to a `ccaudit-disabled:` prefixed key within the same file:
```json
{
  "mcpServers": {},
  "ccaudit-disabled:context7": { "command": "npx", "args": ["-y", "@anthropic/context7-mcp"] }
}
```
This preserves valid JSON, preserves the full server config for restore, and Claude Code ignores unrecognized keys. Alternatively, use Claude Code's native `_disabled_mcpServers` pattern (what `/mcp disable` does internally).

**Fix:** The entire "Comment-out MCP servers" requirement in v1.2 must be replaced with the key-rename strategy. The remediation architecture already reflects the correct approach — the PROJECT.md requirement statement is what needs updating.

---

### C3: `~/.claude.json` Is High-Blast-Radius — Requires Running-Process Gate

**What PROJECT.md misses:** `~/.claude.json` contains the user's OAuth token, per-project state, and all MCP configs. It is not analogous to an ordinary settings file. Concurrent writes between ccaudit and a running Claude Code instance produce truncated JSON (confirmed issues #28842, #29217, #28847). Result: Claude Code cannot start AND the user loses their OAuth session and must re-authenticate.

**Required gate:** Before any mutation of `~/.claude.json`, ccaudit must:
1. Detect running Claude Code processes (process list check)
2. Refuse to proceed if Claude Code is running — print clear error: "Close Claude Code before running remediation"
3. Use atomic write-to-temp-then-rename pattern for all config mutations

This must be a hard preflight check in `--dangerously-bust-ghosts`, not an advisory warning.

---

### C4: `--since` Window Creates False Positive Ghosts That Will Kill the Viral Number

**The problem:** The "108k → 12k tokens" number is the hook. An agent used 8 days ago appears as a ghost with `--since 7d`. The user who runs ccaudit on Thursday sees their weekly Friday agent flagged as a ghost. One false positive in a viral screenshot = "ccaudit reports wrong numbers" narrative.

**Required changes:**
- Show `lastUsed` date in every ghost row — never just "ghost" without "last seen N days ago"
- Display the `--since` window prominently in output headers: "Ghosts (no invocations in past 7 days)"
- The before/after viral numbers must use **lifetime metrics** (or at minimum make the window extremely visible). Do not show "you could save X tokens" based on a windowed count alone.
- Consider a "likely ghost" (7–30d) vs "definite ghost" (>30d) tier for default output.

---

### C5: `ccaudit mcp --live` Must Be v1.0, Not Deferred

**PROJECT.md status:** `--live` is listed as a v1.0 requirement — correct. But PITFALLS research flags it must not slip.

**Why this matters:** The `mcp-token-estimates.json` file starts with engineering guesses. Users will immediately quote these as facts. Within days of launch, someone will measure actual token counts and post "ccaudit's numbers are 3x off." Trust dies before the tool gets traction.

**Requirements:**
- Label ALL estimates with `~` prefix everywhere: "~15k tokens (estimated)"
- Show confidence level: "estimated" vs "measured" vs "community-reported"
- `--live` must ship in v1.0 to give users a verification path
- Never show a bare total without qualifying it as estimated

---

### C6: Anthropic's `defer_loading` Reduces MCP Overhead ~85% But Does NOT Eliminate ccaudit's Value

**Context:** Anthropic's `defer_loading` / Tool Search loads MCP tool definitions on-demand rather than at session start, reducing MCP tool definition overhead by ~85%.

**Impact on ccaudit:** Ghost agents, ghost skills, and stale memory files are completely unaffected. Registered-but-never-invoked MCP servers still consume connection overhead and startup time. The `--live` flag becomes MORE valuable (shows real vs estimated savings in a defer_loading world).

**Messaging adjustment needed:** The raw "108k → 12k" pitch may need updating as Anthropic's own improvements reduce baseline overhead. Frame ccaudit as "what defer_loading doesn't catch" — ghosts that defer_loading leaves fully loaded.

---

### C7: Health Score (0–100) and `--ci` Flag Are Cheap v1.0 Differentiators

Both are near-zero implementation cost and appear in the FEATURES research as recommended additions. Neither is in the current PROJECT.md requirements.

- **Health score:** Single number (e.g., "Claude Code Health: 73/100") is more shareable than a table, enables README badges, and creates CI gate semantics. Pattern: Knip uses this.
- **`--ci` flag:** Combines exit codes + quiet + JSON into one ergonomic flag for CI pipeline use. Without this, ccaudit cannot be used in GitHub Actions without flag gymnastics.

**Recommendation:** Add both to v1.0 Active requirements before requirements doc is finalized.

---

### C8: Exit Codes, `NO_COLOR`, `--quiet`/`--verbose` Are Table Stakes Missing From Current Plan

**What PROJECT.md omits:**
- Exit codes: 0 = no ghosts, 1 = ghosts found. Without non-zero exit on ghosts, ccaudit cannot be used in CI, pre-commit hooks, or any scripted context. Every comparable audit tool (depcheck, audit-ci, Knip) uses exit codes.
- `NO_COLOR` env var: Without respecting this, piped output and CI logs contain ANSI escape garbage. clig.dev standard.
- `--quiet` / `-q`: Script consumers need data-only output mode.
- `--verbose` / `-v`: Users parsing large histories need to see what was scanned and what was skipped.

**Recommendation:** Add all four to v1.0 Active requirements. Exit codes alone are blocking for any CI adoption.

---

## Stack (Validated)

**Overall confidence: HIGH.** Every component is actively maintained, proven in production by the ccusage reference implementation, and fits the zero-runtime-deps constraint.

| Component | Choice | Confidence | Key Rationale |
|-----------|--------|------------|---------------|
| Language | TypeScript 5.7+ | HIGH | Standard; ccusage throughout |
| Runtime | Node.js >=20.x | HIGH | LTS; `node:readline` async iterator support |
| Package manager | pnpm 10.x | HIGH | Catalog support, supply-chain security features |
| CLI framework | gunshi ^0.29.x | HIGH | ccusage-proven; type-safe args; lazy subcommands |
| Validation | valibot ^1.3.x | HIGH | Tree-shakable to ~1KB vs zod's 13KB minimum; `safeParse()` |
| File discovery | tinyglobby ^0.2.x | HIGH | 2 subdeps vs globby's 23; async glob |
| Table rendering | cli-table3 ^0.6.x | HIGH | Stable; 4750+ dependents; ANSI support |
| Result type | @praha/byethrow ^0.10.x | MEDIUM | ccusage-proven; smaller community (only MEDIUM-confidence item) |
| Bundler | tsdown ^0.20.x | HIGH | Rust-based, best tree-shaking, ccusage-proven |
| Test runner | vitest ^4.1.x | HIGH | In-source testing via `import.meta.vitest` |
| Formatter | oxfmt | HIGH | 30x faster than Prettier, 100% compatible output |

**Gaps to fill before scaffold:**
1. tsdown `outputOptions.banner` for shebang injection (not automatic, unlike tsup)
2. `import.meta.vitest` stripping in tsdown config (`inputOptions.define` vs `rolldownOptions.define` — needs testing)
3. pnpm catalog configuration in `pnpm-workspace.yaml`
4. GitHub Actions CI/CD pipeline (lint → test → build → dry-run → publish on tag)
5. Package manager enforcement via `only-allow` preinstall hook

**Do not use:** commander.js, yargs, ink, zod, tsup, jest, neverthrow, Prettier, Biome, stream-json.

---

## Features

### Table Stakes (must ship in v1.0)

Already planned and correct:
- Ghost detection across 4 categories (agents, skills, MCP, memory)
- Token cost attribution per ghost — the primary differentiator
- Per-project + global view
- `--json` and `--csv` export
- `--since` time window (default 7d)
- `ccaudit ghost` (default), `inventory`, `mcp`, `trend` subcommands
- `ccaudit mcp --live` for exact counts via live MCP connection
- Read-only by default in v1.0
- `--help` and `--version` (handled by gunshi)

**Missing from PROJECT.md — must add to v1.0:**
- Exit codes (0 = clean, 1 = ghosts found) — CI integration blocker
- `NO_COLOR` / `--no-color` — CI output corruption without this
- `--quiet` / `-q` — required for script consumers
- `--verbose` / `-v` — required for debugging and trust-building
- Health score (0–100) — cheap, highly shareable
- `--ci` flag (exit code + quiet + JSON combined) — ergonomic CI usage
- Progress indicator for large JSONL histories

### Differentiators (the moat)

1. **Token cost attribution** — no competitor does this. who-ran-what shows counts, not cost.
2. **`--dangerously-bust-ghosts` remediation** — no competitor offers fix, only report.
3. **Viral naming** — `--dangerously-bust-ghosts` + "I accept full responsibility" + before/after numbers appear in every screenshot.
4. **Hash-based checkpoint gate** — stronger safety than time-based expiry.
5. **`npx` zero-install** — ccboard is a Rust binary, who-ran-what is git-clone-and-shell.

**Recommended additions:**
- `ccaudit score` — single health number for badges and dashboards (v1.0, very cheap)
- `ccaudit share` SVG output (v1.1)
- `.ccauditrc` config file for CI allowlists (v1.1)
- GitHub Action (v1.1, after `--ci` flag exists)

### Anti-Features (deliberately excluded)

GUI/web dashboard, real-time monitoring, multi-agent orchestration, usage dashboards (ccusage/ccboard territory), automatic session-start invocation, non-Claude Code platforms (v1), cloud sync, plugin system, `--yes`/`--force` bypass for bust command, interactive TUI mode.

---

## Architecture

### Component Map (9 components)

```
packages/internal/         (pure data, no I/O side effects, shared with future MCP server)
  discovery/               -- find JSONL files across XDG + legacy paths
  parser/                  -- readline streaming, valibot safeParse, silent skip
  parser/extractors/       -- agent / skill / mcp pattern matching
  ledger/                  -- aggregate events, --since filtering, deduplication
  scanner/                 -- scan agents, skills, ~/.claude.json + .mcp.json, memory files
  detector/                -- set difference + mcp-token-estimates.json lookup
  data/mcp-token-estimates.json

packages/terminal/         (rendering only, no business logic)
  table.ts, formatters.ts, colors.ts, responsive.ts, json.ts, csv.ts

apps/ccaudit/
  cli/commands/            -- thin wrappers (ghost, inventory, mcp, trend, restore, contribute)
  pipeline.ts              -- compose components into analysis flow
  remediation/             -- ALL filesystem mutation lives here, nowhere else
    checkpoint.ts, hash.ts, archive.ts, mcp-disabler.ts
    memory-flagger.ts, restore.ts, manifest.ts
```

**Critical boundary rule:** `packages/internal` and `packages/terminal` are read-only and side-effect-free. All mutation is in `apps/ccaudit/src/remediation/`. This is structural, not conventional.

### Data Flow Summary

```
Phase 1 (Discovery):   Filesystem + Config Files → SessionFile[] + InstalledInventory
Phase 2 (Parsing):     SessionFile[] → InvocationEvent[] → InvocationLedger
Phase 3 (Analysis):    InvocationLedger + InstalledInventory → GhostReport
Phase 4 (Output):      GhostReport → terminal table | JSON | CSV | exit code
Phase 5 (Dry-run):     GhostReport → SHA-256 checkpoint file (v1.1)
Phase 6 (Remediation): Checkpoint → triple confirm → archive + key-rename + flag (v1.2)
Phase 7 (Restore):     RestoreManifest → reverse each operation in order (v1.2)
```

Phases 1 and 2 run in parallel (independent). Phases 1–4 are strictly read-only (v1.0 scope).

### Key Design Decisions (non-negotiable)

1. **Pipeline pattern** — linear data flow, each stage independently testable
2. **valibot `safeParse` everywhere** — JSONL schema is not under our control, must never throw
3. **Async generators for JSONL** — constant memory regardless of file size (100MB+ session histories)
4. **MCP disable via key-rename** — JSON has no comments; key-rename preserves valid JSON + full config
5. **Hash-based checkpoint** — time-based expiry gets the invariant wrong; hash captures what matters
6. **Incremental manifest** — operations appended as they complete; crash = partial restore still possible
7. **Atomic config writes** — write-to-temp-then-rename; prevents `~/.claude.json` corruption
8. **Read from `~/.claude.json` + `.mcp.json`** — NOT `settings.json` (see Critical Finding C1)

### Build Order (7 phases, each ships working tool)

| Phase | Deliverable | Version |
|-------|-------------|---------|
| 1 | Monorepo scaffold + CLI skeleton + build pipeline | scaffold |
| 2 | Session Discovery + JSONL Parser + Invocation Extractors | — |
| 3 | Invocation Ledger + Config Scanner | — |
| 4 | Ghost Detector + Report Renderer + all commands + exit codes | **v1.0** |
| 5 | Checkpoint Manager + `--dry-run` flag | v1.1 |
| 6 | Full remediation engine + restore system | v1.2 |
| 7 | `ccaudit contribute` + live MCP + docs + hardening | v1.2+ |

---

## Pitfalls by Severity

### Critical (data loss / Claude Code startup failure)

| ID | Pitfall | Prevention |
|----|---------|-----------|
| C1 | MCP config read from wrong file (`settings.json` vs `~/.claude.json`) | Read `~/.claude.json` root `mcpServers` + per-project keys + `.mcp.json` |
| C2 | Comment-out strategy produces invalid JSON, crashes Claude Code | Key-rename (`ccaudit-disabled:serverName`) or `_disabled_mcpServers` pattern |
| C3 | Non-atomic archive leaves partial state with no recovery path | Manifest-first (write before moves), completion marker, SIGINT handler |
| C4 | Concurrent write to `~/.claude.json` while Claude Code runs | Detect running process, refuse to mutate, atomic write-to-temp-then-rename |
| C5 | Runtime deps leak into published package, breaks zero-install | All deps in `devDependencies`, `clean-pkg-json` in prepack, CI check with `npm pack --dry-run` |

### High (trust damage / adoption failure)

| ID | Pitfall | Prevention |
|----|---------|-----------|
| H1 | `--since` window creates false positive ghosts killing viral number | Show `lastUsed` date, display window in output, use lifetime metrics for before/after claim |
| H2 | Token estimates are guesses, users quote as facts | Label all with `~`, ship `--live` in v1.0, show "estimated" confidence indicator |
| H3 | JSONL schema evolution breaks parser silently (wrong counts, no error) | `v.looseObject()` at top level, skip rate monitoring, warn if >10% skipped |
| H4 | `npx ccaudit` serves stale cached version | README shows `@latest`, startup version check against registry |
| H5 | Shebang missing from tsdown output, binary fails to execute | `outputOptions.banner: '#!/usr/bin/env node\n'`, CI binary smoke test |

### Medium (quality / bad UX)

| ID | Pitfall | Key Prevention |
|----|---------|---------------|
| M1 | Cross-session JSONL contamination (duplicate event counts) | Deduplicate by `uuid`, verify `sessionId` matches filename |
| M2 | Subagent sessions in `subagents/` subdirs missed | Recursive glob `**/*.jsonl`, not `*.jsonl` |
| M3 | CLAUDE.md flagged as "stale ghost" — no invocation signal exists | Separate "always loaded" category, never flag memory files as ghosts |
| M4 | TOCTOU: inventory changes between dry-run and bust | Re-hash at start of bust, abort if mismatch |
| M5 | Triple confirmation can be reflexively mashed | Require typed phrase "I accept full responsibility", mandatory pause, TTY check, no `--yes` flag |
| M6 | Windows path separator mismatches break file discovery | `path.join` for fs ops, `path.posix.join` for globs, `os.homedir()` not `$HOME` |
| M7 | Only one of XDG/legacy paths scanned, missing sessions | Always scan both; deduplicate by sessionId; handle symlinks |
| M8 | Per-project MCP configs in `~/.claude.json` missed | Parse both root `mcpServers` and `projects.<path>.mcpServers` |

---

## Roadmap Implications

### Recommended Phase Structure

**Phase 1 (Foundation) — Scaffold**
- Monorepo setup, build pipeline, CLI skeleton that runs `npx ccaudit --help`
- Configure tsdown with shebang banner, vitest with `TZ=UTC`, pnpm catalog
- Zero-dep invariant enforced from day 1
- Must validate: `npx ccaudit` works, binary executes, CI pipeline green

**Phase 2 (Core Analysis) — v1.0**
- All 4 ghost categories working
- MCP config read from `~/.claude.json` and `.mcp.json` (not `settings.json`)
- Exit codes, `NO_COLOR`, `--quiet`, `--verbose`, `--since`, `--json`, `--csv`
- Health score (0–100) and `--ci` flag
- Token estimates with `~` labeling and `--live` for exact counts
- `lastUsed` date shown in ghost table; `--since` window prominent in output
- Skip rate monitoring and >10% warning
- Startup version check recommending `@latest`
- This is the viral launch milestone — must be trustworthy

**Phase 3 (Dry-Run) — v1.1**
- `--dry-run` with SHA-256 checkpoint
- Hash-based (not time-based) expiry
- `.ccauditrc` config file for CI allowlists
- `ccaudit share` SVG output for social sharing
- GitHub Action / pre-commit hook documentation

**Phase 4 (Remediation) — v1.2**
- `--dangerously-bust-ghosts` with checkpoint validation gate
- Running Claude Code detection as hard preflight
- Atomic writes throughout
- Key-rename MCP disable (NOT JSON comments)
- Incremental manifest with SIGINT handler
- Full restore system
- `ccaudit contribute` for community token estimates

### What Must Come First

The correct MCP config file location (C1) and correct MCP disable mechanism (C2) must be resolved before any code is written for the scanner or remediation engine. Getting these wrong wastes implementation time and risks a public "ccaudit broke my setup" incident at launch.

The `--since` window false positive issue (C4) must be designed into the ghost detection algorithm from the start — it affects the data model, not just the display layer.

### Research Flags

- **Phase 1 (Scaffold):** Well-documented ccusage patterns, low research risk. The only uncertainty is `import.meta.vitest` stripping via tsdown `inputOptions.define` vs `rolldownOptions.define` — verify during scaffold.
- **Phase 2 (v1.0):** The JSONL schema for agents/skills/MCP is confirmed from local inspection. `ccaudit mcp --live` is the most novel feature and may need a focused spike on MCP connection/tokenization mechanics.
- **Phase 3 (v1.1):** Standard checkpoint patterns, no deep research needed.
- **Phase 4 (v1.2):** `~/.claude.json` mutation is high-risk. Needs integration tests against real Claude Code behavior before shipping. Windows `fs.rename` EPERM handling needs a Windows test environment.

---

## Open Questions

These are unresolved items that require runtime testing or explicit design decisions before the relevant phase begins.

1. **`import.meta.vitest` stripping in tsdown:** Is the correct config key `inputOptions.define` or `rolldownOptions.define`? Vitest docs show Vite's `define`; tsdown's equivalent is inferred, not documented. Test during scaffold phase.

2. **Claude Code's `_disabled_mcpServers` vs `ccaudit-disabled:` key prefix:** The architecture uses key-rename with `ccaudit-disabled:` prefix. Claude Code's internal `/mcp disable` uses `_disabled_mcpServers` pattern. Which approach does Claude Code ignore more reliably? Does Claude Code attempt to connect to servers with unrecognized key names? Needs testing against real Claude Code.

3. **`mcp-token-estimates.json` initial values:** What are the actual token counts for common MCP servers (context7, filesystem, github)? Engineering guesses will be immediately challenged. Need to measure at least 5–10 popular servers before publishing estimates, or ship with very conservative values and prominent "estimated" labels.

4. **Memory file ghost heuristic:** CLAUDE.md and rules/ files have no invocation signal. The current plan puts them in a separate "always loaded" category with token cost. What determines if a memory file is reportable at all? Is last-modified date useful as a display field (not a ghost signal)?

5. **`ccaudit mcp --live` implementation:** Connecting to live MCP servers to count tokens requires either spawning the server process or using an existing connection. What is the safest way to get tool definition token counts without side effects? Does this require a tokenizer or does Claude Code expose a count endpoint?

6. **Windows CI:** Should CI test on `windows-latest`? ccusage does not, but ccaudit reads user home directory paths that differ on Windows. The `fs.rename` EPERM issue (Windows Defender file locking) is a confirmed problem. Decision needed before v1.2 remediation ships.

7. **`defer_loading` messaging:** How much does Anthropic's `defer_loading` actually reduce the "108k tokens" headline number for typical users? Need a real measurement on a representative setup to know whether the before/after claim needs adjusting.

8. **gunshi subcommand lazy loading with tsdown bundling:** Do dynamic imports in gunshi subcommands survive tsdown's tree-shaking? Does bundling affect lazy-load semantics? Verify during Phase 1 scaffold before committing to the subcommand architecture.

---

## Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| Stack | HIGH | Every component validated against ccusage production use |
| Features | HIGH | Well-documented domain (clig.dev, Knip, depcheck patterns + direct competitor analysis) |
| Architecture | HIGH | Detailed component map with confirmed JSONL schema, verified boundary rules |
| Pitfalls | HIGH | C1–C5 verified against official Claude Code docs + confirmed GitHub issues |
| MCP token estimates | LOW | No public data; guesses only until `--live` measurements are collected |
| Windows behavior | MEDIUM | Known issues documented; untested in CI |
| `defer_loading` impact | MEDIUM | Published by Anthropic (~85% reduction); real-world impact on ccaudit's specific claims untested |

---

## Sources (aggregated)

**Stack research:** ccusage repository + DeepWiki, ryoppippi CLI stack blog, gunshi docs, tsdown docs, valibot docs, vitest in-source testing docs, pnpm catalogs, oxfmt beta announcement, sitemcp tsdown.config.ts reference.

**Features research:** clig.dev, Knip, depcheck, ccboard GitHub, who-ran-what GitHub, Anthropic advanced tool use docs, Evil Martians CLI UX patterns, IBM audit-ci, Heroku CLI Style Guide, Atlassian CLI design principles.

**Architecture research:** ccusage architecture (DeepWiki), ccboard JSONL parsing, claude-code-trace MCP parsing reference, claude-code-transcripts clean parser reference, confirmed JSONL schema from local inspection.

**Pitfalls research:** Claude Code settings docs, Claude Code MCP docs, Claude Code changelog, Claude Code GitHub issues (#1506, #2835, #26964, #28842, #29217, #29370, #33650, #41723, #16944), npm/cli cache issues, Node.js filesystem docs, write-file-atomic reference, TOCTOU Wikipedia, valibot safeParse docs.

---

*Synthesized: 2026-04-03 from 4 parallel research agents (STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md)*
