# ccaudit

> **ccusage** tells you what you spent. **ccaudit** tells you what's wasting it — and cleans it up.

Companion CLI to [ccusage](https://github.com/ryoppippi/ccusage) that audits your Claude Code **ghost inventory**: agents, skills, MCP servers, and memory files that load every session but are rarely or never invoked. Then optionally remediates them in one command.

---

## The Problem

```
MCP tools:     39.8k tokens  (19.9% of 200k window)
Custom agents:  9.7k tokens   (4.9%)
System tools:  22.6k tokens  (11.3%)
Memory files:  36.0k tokens  (18.0%)
─────────────────────────────────────────────────────
Before any conversation: ~108k tokens (54%)
Remaining for actual work:  92k tokens
```

Most of that is **ghost overhead** — inventory you configured once and never touched again. ccaudit finds it, quantifies it, and removes it.

```
Before: 108k tokens consumed before you type a word
After:    12k tokens
Command:  ccaudit --dangerously-bust-ghosts
```

---

## Usage

```bash
npx ccaudit@latest
```

### Analysis (read-only, always safe)

```bash
npx ccaudit                     # ghost inventory, last 7 days
npx ccaudit ghost --since 30d   # configurable threshold
npx ccaudit ghost --json        # structured JSON with meta envelope
npx ccaudit ghost --csv         # RFC 4180 CSV for spreadsheets
npx ccaudit ghost --quiet       # machine-parseable TSV (pipe-friendly)
npx ccaudit --no-color ghost    # ANSI-free output
npx ccaudit inventory           # full inventory + all usage stats
npx ccaudit mcp                 # MCP servers: token cost + frequency
npx ccaudit mcp --live          # exact token count via live connection
npx ccaudit trend               # invocation frequency over time
npx ccaudit trend --csv         # time-series CSV export
```

### CI / Scripting

ccaudit is designed to be piped, parsed, and dropped into CI pipelines. Exit codes, machine-readable formats, and stderr/stdout separation are all first-class.

**Exit codes:**

- `ghost`, `inventory`, `mcp` — exit `1` when ghosts are found, `0` otherwise
- `trend` — always exits `0` (time-series data is informational, not pass/fail)

**GitHub Actions example:**

```yaml
- run: npx ccaudit@latest --ci
```

The `--ci` flag is shorthand for `--json --quiet` combined with the exit code semantics above. It emits compact JSON on stdout (no pretty-printing, no ANSI, no decorative output) so a pipeline step can pipe it straight into `jq`:

```bash
npx ccaudit --ci | jq .healthScore.score
```

**Scripting examples:**

```bash
# Count ghost rows
npx ccaudit ghost --quiet | wc -l

# Export to CSV for Google Sheets
npx ccaudit ghost --csv > ghosts.csv

# Verbose scan progress on stderr, clean JSON on stdout
npx ccaudit ghost --json --verbose 2>/dev/null > report.json
```

Verbose messages are written to **stderr** with a `[ccaudit]` prefix, so they never contaminate JSON/CSV/TSV output on stdout. Redirect stderr (`2>/dev/null`) or capture it separately when composing pipelines.

**NO_COLOR support:**

ccaudit respects the [`NO_COLOR`](https://no-color.org/) environment variable and the `--no-color` flag. Either one disables all ANSI color codes in every rendered output — useful for log files, CI environments, and terminals that can't render colors.

### Flags Reference

| Flag | Short | Description |
|------|-------|-------------|
| `--since <duration>` | `-s` | Time window (`7d`, `30d`, `2w`, …) |
| `--json` | `-j` | JSON output with meta envelope |
| `--csv` |  | RFC 4180 CSV export |
| `--quiet` | `-q` | Machine-readable only (TSV, compact JSON, headerless CSV) |
| `--verbose` | `-v` | Scan details on stderr |
| `--ci` |  | CI mode: `--json --quiet` plus exit codes |
| `--no-color` |  | Disable ANSI colors (also respects `NO_COLOR` env var) |
| `--live` |  | (mcp only) Live MCP server token measurement |

### Dry-run (preview, no changes)

```bash
npx ccaudit --dry-run
```

Shows the full change plan — which agents would be archived, which MCP servers disabled, estimated savings — without touching anything. **Must be run before remediation is allowed.**

### Remediation (gated, reversible)

```bash
npx ccaudit --dangerously-bust-ghosts
```

Triple-confirmation flow. Requires a recent dry-run checkpoint. All changes are reversible.

```bash
ccaudit restore           # undo everything from last bust
ccaudit restore <name>    # restore single item
ccaudit restore --list    # show all archived items
```

---

## Ghost Inventory Output

```
👻 Ghost Inventory — Last 7 days
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Agents       Defined: 140   Used: 12   Ghost: 128   ~47k tokens/session
Skills       Defined: 90    Used: 8    Ghost: 82    ~18k tokens/session
MCP Servers  Defined: 6     Used: 2    Ghost: 4     ~32k tokens/session
Memory Files Loaded:  9     Active: 3  Stale: 6     ~12k tokens/session

Total ghost overhead: ~109k tokens/session (54% of 200k window)

Run `ccaudit --dry-run` to preview cleanup.
```

---

## Remediation Mechanics

All operations are reversible. Nothing is deleted.

**Agents & Skills** — moved to `_archived/`, not deleted:
```
~/.claude/agents/code-reviewer.md
→ ~/.claude/agents/_archived/code-reviewer.md
```

**MCP Servers** — commented out in `settings.json`, not removed:
```json
"// ccaudit-disabled playwright": { "command": "npx", "args": ["playwright-mcp"] }
```

**Memory Files** — flagged in frontmatter, still load normally:
```yaml
---
ccaudit-stale: true
ccaudit-flagged: "2026-04-03T14:26:00Z"
---
```

---

## Safety Design

The `--dangerously-bust-ghosts` flag is gated behind a mechanical checkpoint:

1. A `--dry-run` must have been completed
2. The dry-run must be recent (hash-based — invalidates automatically when your setup changes, not just on a timer)
3. The current ghost inventory must match what the dry-run saw

All three must pass before the triple-confirmation prompt appears.

---

## Stack

TypeScript · Node · `npx ccaudit@latest` · `gunshi` CLI · `tinyglobby` · `valibot` · `cli-table3` · `tsdown` · `vitest` · `pnpm` workspaces

**Zero external runtime dependencies.** The bundler owns the payload.

---

## Roadmap

| Version | Scope |
|---------|-------|
| **v1.0** | Analysis only — ghost inventory, per-project breakdown, token waste calculator, `--json`/`--csv` export |
| **v1.1** | Dry-run mode — full change preview, checkpoint file |
| **v1.2** | Remediation — `--dangerously-bust-ghosts`, `restore`, `ccaudit contribute` |

---

## Relationship to ccusage

| Tool | Question |
|------|----------|
| [ccusage](https://github.com/ryoppippi/ccusage) | What did you spend? |
| **ccaudit** | What are you loading vs actually using — and fix it. |

---

## Status

**v1.0** — Analysis-only release. Ghost detection, token attribution, all output formats (JSON/CSV/TSV). CI-ready with exit codes.

---

## Disclaimer

ccaudit is provided AS-IS with NO WARRANTY. Anthropic does not endorse this tool. Use at your own risk.
