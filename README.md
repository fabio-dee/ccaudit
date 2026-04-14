# ccaudit

**54% of your Claude Code context window is consumed before you type a word.**

Unused agents, skills, MCP servers, commands, hooks, and memory files (call them ghosts) load into context every session.<br>
ccaudit finds them, shows you the cost, and moves them to `~/.claude/ccaudit/archived/` in one command.<br>
Undo any time with `ccaudit restore`.

```bash
npx ccaudit-cli@latest          # see what's loading vs. what's used
npx ccaudit-cli --dry-run       # see the archive plan, no files touched
npx ccaudit-cli --dangerously-bust-ghosts  # archive ghosts (nothing deleted, undo with restore)
```

> ccusage tells you what you spent. ccaudit tells you what's wasting it.

Current release: **v1.4.0**.

![Image](https://github.com/user-attachments/assets/2afbe339-539b-4a8d-9f73-8d43746c9ace)

---

## Upgrading from 1.3.x

**Token totals will change.** v1.4.0 replaces the old `file-size / 4` wave with
evidence-based, per-category formulas derived from Anthropic's published loading
documentation and measured session logs.

**Most users will see lower totals.** The old formula over-counted skills and
agents whose descriptions are shorter than the full file. A small number of
users with many hooks may see a higher total if they pass `--include-hooks`
(see below).

### What's new

| Change                               | Detail                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New category: **commands**           | Slash commands in `~/.claude/commands/` and `.claude/commands/` are now inventoried and estimated.                                                                                                                      |
| New category: **hooks**              | `PreToolUse` / `PostToolUse` / `SessionStart` hooks from `.claude/settings.json` are now surfaced.                                                                                                                      |
| Hooks are advisory by default        | Hook token costs are **not** added to the grand total unless you pass `--include-hooks`. The upper-bound is shown in the summary as advisory.                                                                           |
| New flag: `--regime eager\|deferred` | Override MCP regime detection (auto by default). In deferred mode a single ToolSearch overhead (~8.7k tokens) replaces per-server costs.                                                                                |
| New flag: `--include-hooks`          | Add hook upper-bound tokens to the reported grand total.                                                                                                                                                                |
| Auto-memory + import chains          | `~/.claude/projects/<slug>/memory/MEMORY.md` auto-memory files are now surfaced. `@`-import chains are resolved recursively (depth ≤ 5) and each imported file appears as a separate memory row with `importDepth` set. |

For the full migration guide with before/after formula table see
[CHANGELOG.md § 1.4.0](./CHANGELOG.md).

---

## Example snapshot

A typical audit looks like this (default mode, hooks advisory, not included in total):

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ CCAUDIT - ~64k tokens/session wasted                                         │
│ 👻 Ghost Inventory — Last 7 days                                             │
├──────────────┬──────────────┬─────────────┬──────────────────────────────────┤
│ Agents       │ Defined: 177 │ Used: 12    │ Ghost: 165 ~24k tokens/session   │
│              │              │             │ (70 in frameworks above)         │
├──────────────┼──────────────┼─────────────┼──────────────────────────────────┤
│ Skills       │ Defined: 81  │ Used: 15    │ Ghost: 66 ~2.7k tokens/session   │
│              │              │             │ (61 in frameworks above)         │
├──────────────┼──────────────┼─────────────┼──────────────────────────────────┤
│ MCP Servers  │ Defined: 5   │ Used: 1     │ Ghost: 4 ~7.0k tokens/session    │
├──────────────┼──────────────┼─────────────┼──────────────────────────────────┤
│ Memory Files │ Loaded: 12   │ Active: 1   │ Stale: 11 ~55k tokens/session    │
├──────────────┼──────────────┼─────────────┼──────────────────────────────────┤
│ Commands     │ Defined: 45  │ Used: 8     │ Ghost: 37 ~1.4k tokens/session   │
│              │              │             │ (36 in frameworks above)         │
├──────────────┴──────────────┴─────────────┴──────────────────────────────────┤
│                                                                              │
│ Total ghost overhead: ~64k tokens (~32% of 200k context window)              │
│ (global: ~62k tokens + worst project ~/projects/my-project: ~2.1k tokens)   │
│ Health grade: D (Poor)                                                       │
│ Hooks (advisory — not included in total): ~18k tokens upper-bound (9 hooks) │
│ Pass --include-hooks to add to grand total.                                  │
│ 💡 Potential savings after ccaudit --dangerously-bust-ghosts: ~64k           │
│ tokens/session reclaimed                                                     │
│ [████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 32%                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Show your ghost score

Share your audit results in the [GitHub Discussion](https://github.com/fabio-dee/ccaudit/discussions/4)

---

With `--include-hooks` the hooks row is promoted into the main table and added
to the grand total:

```text
├──────────────┼──────────────┼─────────────┼──────────────────────────────────┤
│ Hooks        │ Defined: 9   │ Used: 2     │ Ghost: 7 ~18k tokens/session     │
├──────────────┴──────────────┴─────────────┴──────────────────────────────────┤
│ Total ghost overhead: ~81k tokens (~41% of 200k context window)              │
```

Numbers will vary by setup, but the pattern is the same: defined inventory, actual usage, wasted tokens, and the worst-case overhead that would hit a single session.

---

### After `--dangerously-bust-ghosts`:

```
----------------------------------------------
  ccaudit --dangerously-bust-ghosts

  Before (from dry-run 2026-04-13T08:19:58Z): ~108k tokens loaded per session
  After:   ~12k tokens
  Freed:   ~96k tokens (48% of context window)

  Health:  23/100 --> 91/100

  Archived: 116 agents, 74 skills
  Disabled: 4 MCP servers
  Flagged:  6 memory files

  npx ccaudit-cli@latest
----------------------------------------------

Manifest: ~/.claude/ccaudit/manifests/2026-04-06T14:26:00Z.json
Restore anytime: ccaudit restore
```

---

## Commands

| Command         | What it does                                                                           | Notable options                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghost`         | Default ghost inventory report, plus dry-run and remediation entry point               | `--since`, `--dry-run`, `--dangerously-bust-ghosts`, `--yes-proceed-busting`, `--privacy`, `--verbose`, `--no-group-frameworks`, `--force-partial`, `--include-hooks`, `--regime` |
| `inventory`     | Full inventory with usage statistics                                                   | `--since`, `--verbose`, `--no-group-frameworks`                                                                                                                                   |
| `mcp`           | MCP server token costs and frequency                                                   | `--since`, `--live`, `--timeout`                                                                                                                                                  |
| `trend`         | Invocation frequency over time                                                         | `--since`                                                                                                                                                                         |
| `restore`       | Revert a previous bust                                                                 | `[name]`, `--list`                                                                                                                                                                |
| `reclaim`       | Recover orphaned files in `~/.claude/ccaudit/archived/` not referenced by any manifest | `--dry-run`                                                                                                                                                                       |
| `install-skill` | Install the `/ccaudit-bust` Claude Code skill                                          | `--dry-run`, `--force`, `--project`                                                                                                                                               |

---

## Shared output flags

These output flags are used across the reporting commands:

| Flag         | Short | Meaning                                                |
| ------------ | ----- | ------------------------------------------------------ |
| `--json`     | `-j`  | Structured JSON with a `meta` envelope                 |
| `--csv`      |       | RFC 4180 CSV export                                    |
| `--quiet`    | `-q`  | Machine-friendly output only (TSV for report commands) |
| `--verbose`  | `-v`  | Extra progress and breakdown output on stderr          |
| `--ci`       |       | CI mode: `--json --quiet`                              |
| `--no-color` |       | Disable ANSI colors; also respects `NO_COLOR`          |

Notes:

- `ghost`, `inventory`, `mcp`, `trend`, and `restore` honor the full report output matrix.
- `install-skill` also accepts the shared output flags in help metadata, but its job is writing the skill file, so its meaningful modes are rendered, `--quiet`, and `--json`.
- `--ci` also implies `--yes-proceed-busting` on `ghost --dangerously-bust-ghosts`.

---

## Command options, verified

### `ghost`

| Flag                        | Short | Description                                                                                                                                                    |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--since <window>`          | `-s`  | Time window for ghost detection (e.g. `7d`, `30d`, `2w`). Default: `7d`.                                                                                       |
| `--json`                    | `-j`  | Output as JSON with a `meta` envelope.                                                                                                                         |
| `--csv`                     |       | RFC 4180 CSV export.                                                                                                                                           |
| `--quiet`                   | `-q`  | Machine-readable TSV only (suppress decorative text).                                                                                                          |
| `--verbose`                 | `-v`  | Show scan details on stderr; expand framework rows into member trees.                                                                                          |
| `--dry-run`                 |       | Preview the change plan without mutating files. Writes a checkpoint to `~/.claude/ccaudit/.last-dry-run`.                                                      |
| `--dangerously-bust-ghosts` |       | Execute the bust plan: archive ghost agents/skills, disable ghost MCP servers, flag stale memory. Requires a prior `--dry-run` with a matching inventory hash. |
| `--yes-proceed-busting`     |       | Skip the 3-step confirmation ceremony. Required for non-TTY shells and CI.                                                                                     |
| `--privacy`                 |       | Redact real project paths from output (replaces with `project-01`, `project-02`, etc.).                                                                        |
| `--no-group-frameworks`     |       | Disable framework grouping. Output reverts to the v1.2.1 layout.                                                                                               |
| `--force-partial`           |       | Bypass framework-as-unit bust protection. Must match between `--dry-run` and `--dangerously-bust-ghosts` runs.                                                 |
| `--include-hooks`           |       | Add hook upper-bound token costs to the grand total. By default hooks are surfaced as advisory only.                                                           |
| `--regime <mode>`           |       | Override MCP regime detection. `eager` = per-server measured costs; `deferred` = single ToolSearch overhead (~8.7k tokens). Default: `auto`.                   |

### `inventory`

| Flag                    | Short | Description                                                             |
| ----------------------- | ----- | ----------------------------------------------------------------------- |
| `--since <window>`      | `-s`  | Time window for usage analysis (e.g. `7d`, `30d`, `2w`). Default: `7d`. |
| `--json`                | `-j`  | Output as JSON with a `meta` envelope.                                  |
| `--csv`                 |       | RFC 4180 CSV export.                                                    |
| `--quiet`               | `-q`  | Machine-readable TSV only.                                              |
| `--verbose`             | `-v`  | Show scan details on stderr; expand framework rows into member trees.   |
| `--no-group-frameworks` |       | Disable framework grouping. Output reverts to the v1.2.1 layout.        |

### `mcp`

| Flag               | Short | Description                                                                                    |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------- |
| `--since <window>` | `-s`  | Time window for ghost detection (e.g. `7d`, `30d`, `2w`). Default: `7d`.                       |
| `--live`           | `-l`  | Start MCP servers from your Claude config locally for exact token counts instead of estimates. |
| `--timeout <ms>`   | `-t`  | Timeout per MCP server in milliseconds when using `--live`. Default: `15000`.                  |
| `--json`           | `-j`  | Output as JSON with a `meta` envelope.                                                         |
| `--csv`            |       | RFC 4180 CSV export.                                                                           |
| `--quiet`          | `-q`  | Machine-readable TSV only.                                                                     |
| `--verbose`        | `-v`  | Show scan details on stderr.                                                                   |

### `trend`

| Flag               | Short | Description                                                             |
| ------------------ | ----- | ----------------------------------------------------------------------- |
| `--since <window>` | `-s`  | Time window for trend analysis (e.g. `7d`, `30d`, `2w`). Default: `7d`. |
| `--json`           | `-j`  | Output as JSON with a `meta` envelope.                                  |
| `--csv`            |       | RFC 4180 CSV export.                                                    |
| `--quiet`          | `-q`  | Machine-readable TSV only.                                              |
| `--verbose`        | `-v`  | Show scan details on stderr.                                            |

### `restore`

| Flag / Arg  | Short | Description                                                            |
| ----------- | ----- | ---------------------------------------------------------------------- |
| _(no args)_ |       | Restore all items from the most recent bust manifest.                  |
| `<name>`    |       | Restore a single archived item by name (e.g. `restore code-reviewer`). |
| `--list`    |       | List all archived items across all bust manifests (read-only).         |
| `--json`    | `-j`  | Output as JSON with a `meta` envelope.                                 |
| `--csv`     |       | RFC 4180 CSV export.                                                   |
| `--quiet`   | `-q`  | Machine-readable TSV only.                                             |
| `--verbose` | `-v`  | Show detailed output including warnings.                               |

### `reclaim`

| Flag        | Short | Description                                  | Type   |
| ----------- | ----- | -------------------------------------------- | ------ |
| `--dry-run` |       | List orphans without touching the filesystem | `bool` |

Shared output flags (`--json`, `--quiet`, `--verbose`, `--no-color`) also apply.

### `install-skill`

| Flag        | Short | Description                                                                             |
| ----------- | ----- | --------------------------------------------------------------------------------------- |
| `--dry-run` |       | Show what would be installed without writing any files.                                 |
| `--force`   | `-f`  | Overwrite an existing skill file without prompting.                                     |
| `--project` | `-p`  | Install to `.claude/commands/` in the current directory instead of the global location. |
| `--json`    | `-j`  | Output as JSON.                                                                         |
| `--quiet`   | `-q`  | Machine-readable output only.                                                           |

---

## Dry-run and remediation

`--dry-run` is the safe preview mode. It scans your inventory, builds the change plan, and writes a checkpoint to `~/.claude/ccaudit/.last-dry-run`.

```bash
npx ccaudit-cli --dry-run
```

What you get:

- which agents would be archived
- which MCP servers would be disabled
- which memory files would be flagged
- the checkpoint hash needed for later remediation

When framework detection is active (the default), ghost members of partially-used
frameworks are **skipped** in the change plan. You will see a yellow warning and
a `PROTECTED` section listing what was held back. Pass `--force-partial` to
include them, but you must use `--force-partial` on both the `--dry-run` and
`--dangerously-bust-ghosts` steps, because the flag changes which items are
eligible and therefore changes the checkpoint hash. Mismatched flags between the
two steps will produce a hash-mismatch error.

### Bust ceremony

`--dangerously-bust-ghosts` is blocked until a matching dry-run checkpoint exists.

The actual confirmation ceremony is:

1. `[1/3] This will modify your Claude Code configuration. Proceed? [y/N]`
2. `[2/3] Are you sure? This archives agents, disables MCP servers, and flags memory files. [y/N]`
3. `[3/3] Type exactly: I accept full responsibility`

Use `--yes-proceed-busting` to skip the ceremony. That flag is required for non-TTY shells and CI, and `--ci` enables it automatically on the bust path.

```bash
npx ccaudit-cli --dangerously-bust-ghosts --yes-proceed-busting
```

`--csv` is rejected on the bust path; use `--json` if you want machine-readable output for remediation.

### Rollback

Everything is reversible:

```bash
npx ccaudit-cli restore           # restore everything from the latest manifest
npx ccaudit-cli restore <name>    # restore one archived item by name
npx ccaudit-cli restore --list    # list all archived items across busts
```

Full-mode `restore` now walks **every** manifest in `~/.claude/ccaudit/manifests/` (not just the newest), with deduplication. Items archived by older busts are recovered too. Output now reports `moved` and `already-at-source` separately so idempotent re-runs don't inflate the success count.

```text
159 agents/skills restored to their original locations (324 were already at source)
```

What gets reversed:

- agents and skills are archived, not deleted
- MCP servers are commented out in config, not removed
- memory files are flagged in frontmatter, not rewritten destructively

Items that were **protected** during a bust (skipped because their framework is
partially used) are never archived; they stay in place and do not appear in the
manifest. If you used `--force-partial` to archive framework members anyway,
those items are included in the manifest and are fully restorable with
`ccaudit restore`, just like any other busted item.

### Reclaim orphans

An "orphan" is a file sitting in `~/.claude/ccaudit/archived/` that is not referenced by any manifest. This happens when:

- a manifest was lost or truncated (e.g., a bust crashed mid-write)
- the bust pre-dated v1.4.0's multi-manifest restore fix and the manifest no longer exists
- files were moved into `archived/` manually

```bash
ccaudit reclaim            # restore orphans whose source path is absent
ccaudit reclaim --dry-run  # list what would be reclaimed, no filesystem changes
```

Safety invariant: `reclaim` **never** overwrites an existing file at the inferred source path. If the source already exists, the orphan is skipped with a warning.

Note: if the manifest still exists, `ccaudit restore` is the right tool: it walks all manifests including older ones. `reclaim` is the rescue path for files whose manifest is gone.

---

## Audit trail

Every ccaudit invocation is appended to `~/.claude/ccaudit/history.jsonl` (mode `0o600`, parent directory `0o700`). The file uses JSONL format: one JSON object per line, with a header record written once on first use followed by one entry per invocation.

Schema version: `history_version: 1`. Future readers must refuse files with a higher version number.

```jsonl
{"record_type":"header","history_version":1,"ccaudit_version":"1.4.0","created_at":"2026-04-13T08:00:00.000Z","host_os":"darwin","node_version":"v22.0.0"}
{"record_type":"entry","ts":"2026-04-13T08:19:58.000Z","argv":["--dry-run"],"command":"dry-run","exit_code":0,"duration_ms":412,"cwd":"/home/user/project","privacy_redacted":false,"result":{"planned_archive":146,"planned_disable":4,"planned_flag":6,"checkpoint_hash":"abc123"},"errors":[]}
```

Each entry's `result` field contains per-command structured data. See [docs/JSON-SCHEMA.md § History audit trail](./docs/JSON-SCHEMA.md) for the full per-command shapes.

Opt-out: set `CCAUDIT_NO_HISTORY=1` to disable all history writes. The env var is checked before any filesystem work; no directory is created.

Privacy: `--privacy` redacts `cwd` and any path-shaped strings in `result`.

Rotation: if `history.jsonl` exceeds 10 MB, a one-time advisory is printed to stderr suggesting manual archival:

```bash
ℹ️  ccaudit history.jsonl is >10 MB; archive it with: mv ~/.claude/ccaudit/history.jsonl{,.$(date +%Y%m%d).bak}
```

---

## Environment variables

| Variable               | Effect                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `NO_COLOR`             | Disable ANSI colors (equivalent to `--no-color`).                                           |
| `CCAUDIT_NO_HISTORY=1` | Disable all writes to `history.jsonl`. Checked before any filesystem work.                  |
| `HOME` / `USERPROFILE` | Override the home directory used to locate `~/.claude/` state. Useful in test environments. |
| `XDG_CONFIG_HOME`      | Checked as a fallback base for config lookup on Linux/macOS when `HOME` is unset.           |

---

## Output modes

### JSON

All report commands emit a JSON envelope with `meta` and command-specific payload data:

```bash
npx ccaudit-cli ghost --json | jq .
```

### CSV

CSV is RFC 4180 compliant and works well for spreadsheets and pipelines:

```bash
npx ccaudit-cli ghost --csv > ghosts.csv
npx ccaudit-cli mcp --csv > mcp.csv
```

### Quiet / TSV

Quiet mode emits machine-friendly TSV without decoration:

```bash
npx ccaudit-cli ghost --quiet
npx ccaudit-cli trend --quiet
```

### NO_COLOR

ccaudit honors `NO_COLOR` and `--no-color`.

---

## Relationship to ccusage

| Tool                                            | Question                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| [ccusage](https://github.com/ryoppippi/ccusage) | What did you spend?                                                       |
| **ccaudit**                                     | What are you loading vs. actually using, and what can you safely reclaim? |

---

## How it works

ccaudit reads the JSONL session logs that Claude Code already writes to `~/.claude/projects/`. It cross-references what is defined (agents in `~/.claude/agents/`, skills in `~/.claude/skills/`, MCP servers in `~/.claude.json` and project `.mcp.json`, memory in `.claude/` directories, commands in `~/.claude/commands/` and `.claude/commands/`, hooks in `.claude/settings.json`) against what is actually invoked. Everything is local. No data leaves your machine.

Technical decisions:

- **Zero runtime dependencies.** Everything is bundled via tsdown (Rolldown-based, Rust). The published package has no `dependencies` field.
- **JSONL parsing uses `node:readline`**, not a streaming JSON library. Lines that fail valibot's `safeParse` are silently skipped; Claude Code's format is not formally documented and varies between versions.
- **Token estimation (v1.4.0 evidence-based formulas):**
  - **Skills** (lazy): `15 + ceil(description_chars / 4)`, capped at 250 description chars. Only the name and description enter Claude Code's startup invocation index per Anthropic's published loading documentation.
  - **Agents** (eager): `30 + ceil(description_chars / 4)`, no cap. The full description enters the Task tool schema at session start.
  - **MCP servers** (regime-aware): measured per-server in eager mode (recorded from actual `tool_use` token counts in session logs). In deferred mode (auto-detected when Claude Code ≥ v2.1.7 and MCP tools exceed ~10% of context), collapses to a single ToolSearch overhead of ~8.7k tokens. Override with `--regime eager|deferred`.
  - **Memory**: file-size heuristic (1 token ≈ 4 chars) with recursive `@`-import resolution (depth ≤ 5). Auto-memory files at `~/.claude/projects/<slug>/memory/MEMORY.md` are included automatically and capped at 25KB (6,250 tokens) to match Claude Code's own truncation limit.
  - **Commands**: frontmatter-aware. `min(60 + description_chars / 4, 90)` tokens when frontmatter is present; falls back to `file-size / 4` otherwise. See `packages/internal/src/token/command-estimator.ts` for the exact formula.
  - **Hooks**: inject-capable upper bound up to 2,500 tokens per fire event. **Advisory by default**. Not aggregated into the headline total unless `--include-hooks` is passed. Rationale: the pessimistic upper-bound dominates the total and masks the signal from the other categories. Most hook configs are small; this upper-bound is the worst case.
- **Remediation is gated behind a hash-based checkpoint.** You must `--dry-run` first. The dry-run writes a checkpoint with a SHA-256 hash of the current inventory. `--dangerously-bust-ghosts` compares the current hash against the checkpoint and refuses to proceed if anything has changed since.
- **Nothing is deleted.** Agents and skills are moved to an archive directory. MCP servers are key-renamed in the JSON (`ccaudit-disabled:name`). Memory files get a frontmatter flag.
- **mtime is preserved on memory files.** Bust and restore preserve the original `mtime` of memory files so the staleness signal (used by ccaudit's memory scanner) survives flag/unflag cycles.

Limitations:

- Token estimates are evidence-based heuristics. The actual token count depends on the model's tokenizer. For most files this is within 10–15% of actual.
- Hook token estimates are pessimistic upper-bounds (2,500 tokens/fire for inject-capable hooks, zero for non-inject-capable hooks whose config does not enter model context). Real costs depend on the hook script's output.
- The "ghost" classification uses a 7-day window by default. An agent invoked once 8 days ago is technically a ghost. The `--since` flag lets you widen the window, but the default is deliberately aggressive because most ghost inventory is truly abandoned.
- Windows support: JSONL paths use forward slashes but tinyglobby handles normalization. Not tested on Windows.

---

## Framework detection

Teams that install GSD, SuperClaude, or n-wave drop dozens of agents at once.
Before v1.3.0 those showed up as 12 or 20 unrelated-looking rows in `ccaudit ghost`
and it was easy to archive half a framework without realising the other half was
still active. v1.3.0 groups related agents so you see `GSD · 12 ghost members ·
~58k tokens` instead.

### The 3-tier algorithm

Every agent and skill flows through three tiers of detection, in order. The first
tier that matches wins; later tiers do not override earlier ones.

1. **Tier 1: curated list.** ccaudit ships a hand-maintained registry of
   well-known Claude Code frameworks (`gsd`, `superclaude`, `nwave`,
   `superpowers`, `ralph-loop`, `agent-council`, `greg-strategy`, `ideabrowser`,
   `gstack`, `hermes`). An item matches a curated framework when its filename
   starts with one of the framework's declared prefixes (case-insensitive,
   followed by an alphanumeric character) **or** its path contains one of the
   framework's declared folder segments **or** (for frameworks that ship items
   without a consistent prefix, like gstack) its name is in the framework's
   `knownItems[]` list and at least three known items are present in the
   inventory.
2. **Tier 2: heuristic prefix clustering.** Items that do not match Tier 1
   have their prefix extracted via `name.split(/[-:_]/)[0]`, lowercased. The
   prefix must be at least 3 characters long and must not appear in
   `STOP_PREFIXES` (`api`, `app`, `ui`, `test`, `user`, `data`, `util`, etc.).
   Two or more items sharing the same non-stopped prefix form a heuristic
   cluster; single items stay ungrouped.
3. **Tier 3: ungrouped.** Anything that matched neither tier is listed in
   the flat inventory like before.

### Domain folders are NOT frameworks

> **Critical negative finding.** Folder names like `engineering/`, `design/`,
> `marketing/`, `testing/`, `sales/`, `integrations/`, `strategy/`,
> `project-management/`, `support/`, `paid-media/`, `spatial-computing/`,
> `examples/`, `scripts/`, `product/`, `specialized/`, `game-development/`,
> `agents/`, and `skills/` are **domain organisation** folders, not frameworks.
> ccaudit refuses to group them, even if they happen to cluster by filename.
> This is enforced twice: once by gating folder-segment matches through the
> curated list only (Tier 1), and once by an explicit `DOMAIN_STOP_FOLDERS`
> list that Tier 2 consults. If you see a folder name that looks like it
> should be a framework but is listed above, that is deliberate.

### Flag reference

| Flag                    | Default | Effect                                                                                                                                                                                      |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verbose` / `-v`      | off     | Expand each framework row into a tree of its members; used members collapse to a `+ N used members` line.                                                                                   |
| `--no-group-frameworks` | off     | Disable grouping entirely. Output reverts to the v1.2.1 layout byte-for-byte (no Frameworks section).                                                                                       |
| `--force-partial`       | off     | Bypass framework-as-unit protection and archive ghost members of partially-used frameworks. Applies to both `--dry-run` and `--dangerously-bust-ghosts`; both runs must use the same value. |

Without `--force-partial`, `ccaudit ghost --dangerously-bust-ghosts` will
**skip** ghost members of any framework that still has at least one used member.
You will see a yellow warning and a `PROTECTED` section in the change plan.
This is intentional. Busting half of GSD while the planner is in use would
break the framework. `--force-partial` is an explicit opt-in override.

ccaudit computes a **status** for each framework group:

- **`fully-used`**: all members were invoked within the `--since` window. Nothing to protect, nothing to archive.
- **`partially-used`**: at least one member is active and at least one is a ghost. Ghost members are **protected** by default (skipped during bust). This is the only status that triggers protection.
- **`ghost-all`**: no members are active. The entire framework is eligible for archival with no special protection.

These values appear in `--json` output under each framework group's `status` field.

**Scope:** only agents and skills are candidates for framework detection. MCP servers and memory files always appear in the ungrouped inventory regardless of their names.

**Heuristic display names:** Tier 2 groups auto-generate their display name by title-casing the detected prefix (e.g., items prefixed `quark-` display as "Quark").

**Flag interaction:** `--force-partial` has no effect when `--no-group-frameworks` is active, because framework protection is already disabled. The CLI emits a warning if you combine them.

### Contribute a framework

If you maintain or use a framework that isn't in the curated list, open a PR
against `packages/internal/src/framework/known-frameworks.ts`. Each entry is
validated at load time by valibot and must include:

| Field         | Type                                                              | Notes                                                    |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `id`          | `string`                                                          | Stable lowercase id (`gsd`, `superclaude`, `gstack`).    |
| `displayName` | `string`                                                          | User-facing name.                                        |
| `description` | `string`                                                          | One-line description.                                    |
| `prefixes`    | `string[]`                                                        | Filename prefixes including separator (e.g. `'gsd-'`).   |
| `folders`     | `string[]`                                                        | Folder segment names, no slashes (e.g. `'superpowers'`). |
| `knownItems`  | `string[]` (optional)                                             | For frameworks without a consistent prefix, like gstack. |
| `categories`  | `('agent' \| 'skill' \| 'command' \| 'mcp-server' \| 'memory')[]` | Item categories the framework ships.                     |
| `source`      | `string`                                                          | URL to the framework or `'unverified'`.                  |
| `source_type` | `'curated'`                                                       | Literal, always `'curated'`.                             |

Please do NOT submit generic prefixes (anything that would collide with
`STOP_PREFIXES`) or domain folders (anything listed in the negative finding
above). If you're not sure, open an issue first.

Declaration order in the registry is authoritative: the first matching entry
wins. Place more-specific entries before more-general ones to avoid shadowing.

---

## Version

- Current package version: **1.4.0**
- Build source of truth: `apps/ccaudit/package.json` and `apps/ccaudit/src/_version.ts`

---

## Author

[fabio-dee](https://github.com/fabio-dee)

---

## Disclaimer

ccaudit is provided AS-IS with NO WARRANTY. Anthropic does not endorse this tool. Use at your own risk.
