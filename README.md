# ccaudit

**54% of your Claude Code context window is consumed before you type a word.**

Ghost inventory — agents, skills, MCP servers, and memory files you defined
once and never use — loads into context every session. ccaudit finds them,
shows you the cost, and removes them in one command.

```bash
npx ccaudit-cli@latest          # see what's loading vs. what's used
npx ccaudit-cli --dry-run       # preview the cleanup
npx ccaudit-cli --dangerously-bust-ghosts  # do it (fully reversible)
```

> ccusage tells you what you spent. ccaudit tells you what's wasting it.

Current release: **v1.2.1**.

---

## Example snapshot

A typical audit looks like this:

```text
┌────────────────────────────────────────────────────────────────────────────────────┐
│ CCAUDIT - ~108k tokens/session wasted                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                                               │
│ 👻 Ghost Inventory — Last 7 days                                                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                                               │
├──────────────┬──────────────┬──────────────┬───────────────────────────────────────┤
│ Agents       │ Defined: 128 │ Used: 12     │ Ghost: 116 ~51.2k tokens/session      │
├──────────────┼──────────────┼──────────────┼───────────────────────────────────────┤
│ Skills       │ Defined: 82  │ Used: 8      │ Ghost: 74 ~18.5k tokens/session       │
├──────────────┼──────────────┼──────────────┼───────────────────────────────────────┤
│ MCP Servers  │ Defined: 6   │ Used: 2      │ Ghost: 4 ~32.0k tokens/session        │
├──────────────┼──────────────┼──────────────┼───────────────────────────────────────┤
│ Memory Files │ Loaded: 18   │ Active: 12   │ Stale: 6 ~6.3k tokens/session         │
├──────────────┴──────────────┴──────────────┴───────────────────────────────────────┤
│                                                                                    │
│ Total ghost overhead: ~108k tokens (~54% of 200k context window)                   │
│ (global: ~72k tokens + worst project ~/projects/saas-app: ~36k tokens)             │
│ Health grade: 23/100 (Critical)                                                    │
│ 💡 Potential savings after ccaudit --dangerously-bust-ghosts: ~96k tokens/session  │
│ reclaimed                                                                          │
│ [█████████████████████████████░░░░░░░░░░░░░░░░░░░░] 54%                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Numbers will vary by setup, but the pattern is the same: defined inventory, actual usage, wasted tokens, and the worst-case overhead that would hit a single session.

---

### After `--dangerously-bust-ghosts`:

```
----------------------------------------------
  ccaudit --dangerously-bust-ghosts

  Before:  ~108k tokens loaded per session
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

| Command         | What it does                                                             | Notable options                                                                           |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ghost`         | Default ghost inventory report, plus dry-run and remediation entry point | `--since`, `--dry-run`, `--dangerously-bust-ghosts`, `--yes-proceed-busting`, `--privacy` |
| `inventory`     | Full inventory with usage statistics                                     | `--since`                                                                                 |
| `mcp`           | MCP server token costs and frequency                                     | `--since`, `--live`, `--timeout`                                                          |
| `trend`         | Invocation frequency over time                                           | `--since`                                                                                 |
| `restore`       | Revert a previous bust                                                   | `[name]`, `--list`                                                                        |
| `install-skill` | Install the `/ccaudit-bust` Claude Code skill                            | `--dry-run`, `--force`, `--project`                                                       |

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

```bash
npx ccaudit-cli ghost --since 30d
npx ccaudit-cli ghost --json
npx ccaudit-cli ghost --csv
npx ccaudit-cli ghost --quiet
npx ccaudit-cli ghost --verbose
npx ccaudit-cli ghost --dry-run
npx ccaudit-cli ghost --dangerously-bust-ghosts
npx ccaudit-cli ghost --yes-proceed-busting
npx ccaudit-cli ghost --privacy
```

### `inventory`

```bash
npx ccaudit-cli inventory --since 30d
npx ccaudit-cli inventory --json
npx ccaudit-cli inventory --csv
npx ccaudit-cli inventory --quiet
npx ccaudit-cli inventory --verbose
```

### `mcp`

```bash
npx ccaudit-cli mcp --since 30d
npx ccaudit-cli mcp --live
npx ccaudit-cli mcp --timeout 15000
npx ccaudit-cli mcp --json
npx ccaudit-cli mcp --csv
npx ccaudit-cli mcp --quiet
npx ccaudit-cli mcp --verbose
```

`--live` starts the MCP server commands from your Claude config locally so the token count is exact instead of estimated.

### `trend`

```bash
npx ccaudit-cli trend --since 30d
npx ccaudit-cli trend --json
npx ccaudit-cli trend --csv
npx ccaudit-cli trend --quiet
npx ccaudit-cli trend --verbose
```

### `restore`

```bash
npx ccaudit-cli restore
npx ccaudit-cli restore code-reviewer
npx ccaudit-cli restore --list
npx ccaudit-cli restore --json
npx ccaudit-cli restore --csv
npx ccaudit-cli restore --quiet
npx ccaudit-cli restore --verbose
```

### `install-skill`

```bash
npx ccaudit-cli install-skill
npx ccaudit-cli install-skill --dry-run
npx ccaudit-cli install-skill --force
npx ccaudit-cli install-skill --project
npx ccaudit-cli install-skill --json
npx ccaudit-cli install-skill --quiet
```

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

What gets reversed:

- agents and skills are archived, not deleted
- MCP servers are commented out in config, not removed
- memory files are flagged in frontmatter, not rewritten destructively

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

| Tool                                            | Question                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| [ccusage](https://github.com/ryoppippi/ccusage) | What did you spend?                                                        |
| **ccaudit**                                     | What are you loading vs. actually using — and what can you safely reclaim? |

---

## How it works

ccaudit reads the JSONL session logs that Claude Code already writes to `~/.claude/projects/`. It cross-references what is defined (agents in `~/.claude/agents/`, skills in `~/.claude/skills/`, MCP servers in `~/.claude.json` and project `.mcp.json`, memory in `.claude/` directories) against what is actually invoked. Everything is local — no data leaves your machine.

Technical decisions:

- **Zero runtime dependencies.** Everything is bundled via tsdown (Rolldown-based, Rust). The published package has no `dependencies` field.
- **JSONL parsing uses `node:readline`**, not a streaming JSON library. Lines that fail valibot's `safeParse` are silently skipped — Claude Code's format is not formally documented and varies between versions.
- **Token estimation:** measured values for common MCP servers (recorded from actual `tool_use` token counts in session logs), file-size heuristic for agents and skills (1 token ≈ 4 chars, conservative).
- **Remediation is gated behind a hash-based checkpoint.** You must `--dry-run` first. The dry-run writes a checkpoint with a SHA-256 hash of the current inventory. `--dangerously-bust-ghosts` compares the current hash against the checkpoint and refuses to proceed if anything has changed since.
- **Nothing is deleted.** Agents and skills are moved to an archive directory. MCP servers are key-renamed in the JSON (`ccaudit-disabled:name`). Memory files get a frontmatter flag.

Limitations:

- Token estimates for agents and skills are heuristic-based (file size / 4). The actual token count depends on the model's tokenizer. For most files this is within 10–15% of actual. MCP server estimates are more accurate because they are measured from real sessions.
- The "ghost" classification uses a 7-day window by default. An agent invoked once 8 days ago is technically a ghost. The `--since` flag lets you widen the window, but the default is deliberately aggressive because most ghost inventory is truly abandoned.
- Windows support: JSONL paths use forward slashes but tinyglobby handles normalization. Not tested on Windows.

---

## Version

- Current package version: **1.2.1**
- Build source of truth: `apps/ccaudit/package.json` and `apps/ccaudit/src/_version.ts`

---

## Author

[fabio-dee](https://github.com/fabio-dee)

---

## Disclaimer

ccaudit is provided AS-IS with NO WARRANTY. Anthropic does not endorse this tool. Use at your own risk.
