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

| Flag                 | Short | Description                                               |
| -------------------- | ----- | --------------------------------------------------------- |
| `--since <duration>` | `-s`  | Time window (`7d`, `30d`, `2w`, …)                        |
| `--json`             | `-j`  | JSON output with meta envelope                            |
| `--csv`              |       | RFC 4180 CSV export                                       |
| `--quiet`            | `-q`  | Machine-readable only (TSV, compact JSON, headerless CSV) |
| `--verbose`          | `-v`  | Scan details on stderr                                    |
| `--ci`               |       | CI mode: `--json --quiet` plus exit codes                 |
| `--no-color`         |       | Disable ANSI colors (also respects `NO_COLOR` env var)    |
| `--live`             |       | (mcp only) Live MCP server token measurement              |

### Dry-run (preview, no changes)

```bash
npx ccaudit --dry-run
```

Shows the full change plan — which agents would be archived, which MCP servers disabled, estimated savings — without touching anything. **Must be run before remediation is allowed.**

### Remediation: `--dangerously-bust-ghosts`

Once you have reviewed the dry-run output and trust what the tool will change, run:

```bash
npx ccaudit --dangerously-bust-ghosts
```

This command:

1. Verifies a recent `--dry-run` checkpoint exists and its hash still matches your current inventory (hash-based, not time-based — if your inventory changed since the dry-run, the gate refuses).
2. Detects whether Claude Code is currently running. Writing to `~/.claude.json` while Claude Code is alive corrupts OAuth tokens — this gate **cannot be bypassed**. If any `claude` process is on the system, or if you are running ccaudit from inside a Claude Code Bash-tool session, the command refuses.
3. Displays the full change plan (archive + disable + flag, with token savings) and asks for two confirmations:
   - `[1/2] Proceed busting? [y/N]`
   - `[2/2] Type exactly: proceed busting`
4. Archives ghost agents and skills to `_archived/` subdirectories (nothing deleted).
5. Disables ghost MCP servers by **key-renaming** them in `~/.claude.json` (the entry is moved from `mcpServers.<name>` to `ccaudit-disabled:<name>` at the same nesting level — nothing removed). Both flat `.mcp.json` and nested `~/.claude.json` schemas are supported.
6. Flags stale memory files with `ccaudit-stale: true` YAML frontmatter (files still load normally; the flag is a marker for human review).
7. Writes an incremental restore manifest to `~/.claude/ccaudit/manifests/bust-<timestamp>.jsonl` — Phase 9 `ccaudit restore` consumes this to undo every op, including content hashes for tamper detection.

Nothing is deleted — every change is reversible via `ccaudit restore` (shipping in v1.2.1).

#### Non-interactive usage

For CI and scripted usage, pass `--yes-proceed-busting` to skip both confirmation prompts:

```bash
ccaudit --dangerously-bust-ghosts --yes-proceed-busting
```

The flag name is intentionally unwieldy — do not copy-paste it from random places on the internet. It is the only non-TTY bypass; without it, bust on a piped stdin exits with code 4.

#### ⚠️ `--ci` footgun on bust

On `--dangerously-bust-ghosts` **only**, `--ci` implies `--yes-proceed-busting` in addition to its usual `--json --quiet` behavior:

```bash
ccaudit --dangerously-bust-ghosts --ci    # NO PROMPTS — executes immediately
```

**This is the ONLY place in ccaudit where `--ci` implies destructive consent.** On every other command `--ci` is purely an output mode shorthand. Read this twice before adding `ccaudit --dangerously-bust-ghosts --ci` to a GitHub Actions workflow or a pre-commit hook.

Rationale: CI pipelines that run bust MUST be non-interactive (otherwise they hang waiting for a prompt), machine-readable (`--json`), and free of decoration (`--quiet`). Adding the `--yes-proceed-busting` implication removes the "why is my CI hanging on bust?" footgun, but it does so by silently granting destructive consent — so it is called out here prominently.

#### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Clean: bust completed with zero failures, OR empty plan (no ghosts to bust), OR user aborted at a confirmation prompt (graceful abort is not a failure). |
| `1`  | Op failures (at least one archive/disable/flag op failed — see the manifest), OR checkpoint missing/invalid, OR hash mismatch (inventory changed since dry-run), OR `~/.claude.json` parse or write error, OR `--csv` rejected on bust. |
| `2`  | **Reserved for Phase 7** — dry-run checkpoint WRITE failure. Not emitted by bust (bust only reads the checkpoint). |
| `3`  | Running-process preflight failed: Claude Code is currently running, OR ccaudit was spawned from inside a Claude Code session (self-invocation), OR `ps`/`tasklist` could not be executed (fail-closed). |
| `4`  | Non-TTY without `--yes-proceed-busting`: stdin is piped and the bypass flag is absent. |

Distinct exit codes for preflight (3) vs op failures (1) vs non-TTY (4) let CI scripts distinguish failure categories without parsing stderr.

#### Output modes on bust

| Flag | Behavior on `--dangerously-bust-ghosts` |
|------|----------------------------------------|
| `--json` | **Honored.** Emits `{ meta, bust: { status, manifestPath, counts, failed, duration_ms, ... } }` on stdout. See [JSON Schema](./docs/JSON-SCHEMA.md) for all 10 `bust.status` variants. |
| `--csv` | **Rejected.** Exits with code 1 and a stderr message suggesting `--json` instead. The plan is already in the manifest JSONL — a flat CSV would be a redundant duplicate. |
| `--quiet` | **Honored.** Suppresses decorative stdout (the "Done." summary, manifest path line, duration line). Exit code is the only success signal. Pairs with `--yes-proceed-busting` for scripted non-TTY use. |
| `--verbose` | **Honored.** Per-op progress hints go to stderr with a `[ccaudit]` prefix. |
| `--ci` | **Honored, extended.** Implies `--json --quiet --yes-proceed-busting`. See the footgun warning above. |
| `--no-color` / `NO_COLOR` | **Honored.** All ANSI color output suppressed, per Phase 6 precedent. |

### Restore (undo a bust)

```bash
ccaudit restore           # undo everything from last bust
ccaudit restore <name>    # restore single item
ccaudit restore --list    # show all archived items
```

The restore command reads the JSONL manifest written by `--dangerously-bust-ghosts` and reverses every op (archive → unarchive, key-rename → unrename, frontmatter flag → unflag). Content hashes in the manifest allow it to detect post-bust tampering before restoring.

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

## Machine-readable output

All read commands support structured JSON and spreadsheet-friendly CSV output:

```sh
# JSON envelope with meta + items (see docs/JSON-SCHEMA.md for the full schema)
ccaudit ghost --json | jq '.items | length'
ccaudit ghost --json | jq '.meta.exitCode'

# CSV for Google Sheets / Excel
ccaudit ghost --csv > ghosts.csv

# --ci is sugar for --json --quiet with exit codes (GitHub Actions, pre-commit)
ccaudit --ci
```

The JSON envelope uses **camelCase** field names (`items`, `meta.timestamp`,
`meta.exitCode`) to match TypeScript internals and the `gh` CLI convention.
See [JSON Schema](./docs/JSON-SCHEMA.md) for the canonical schema, per-command
payload keys, and jq recipes.

---

## Remediation Mechanics

All operations are reversible. Nothing is deleted.

**Agents & Skills** — moved to `_archived/`, not deleted:

```
~/.claude/agents/code-reviewer.md
→ ~/.claude/agents/_archived/code-reviewer.md
```

Nested subdirectories are preserved in the archive path. If an archive file with the same name already exists (prior bust + never restored), the new archive is suffixed with an ISO timestamp (`code-reviewer.2026-04-05T18-30-00Z.md`).

**MCP Servers** — **key-renamed** in `~/.claude.json` (and in flat `.mcp.json` files), not removed:

```json
// before
{ "mcpServers": { "playwright": { "command": "npx", "args": ["playwright-mcp"] } } }

// after
{ "mcpServers": {}, "ccaudit-disabled:playwright": { "command": "npx", "args": ["playwright-mcp"] } }
```

The entry is moved from `mcpServers.<name>` to `ccaudit-disabled:<name>` at the same nesting level — document root for flat `.mcp.json`, or under the matching `projects.<path>` for project-scoped `~/.claude.json` entries. Nothing is deleted; restore strips the `ccaudit-disabled:` prefix. On key collision (prior bust), the new key is suffixed with an ISO timestamp (`ccaudit-disabled:playwright:2026-04-05T18-30-00Z`).

**Memory Files** — flagged in frontmatter, still load normally:

```yaml
---
ccaudit-stale: true
ccaudit-flagged: '2026-04-03T14:26:00Z'
---
```

Files still exist and load normally; the flag is a marker for human review, not mechanical exclusion. Restore strips the two keys.

---

## Safety Design

The `--dangerously-bust-ghosts` flag is gated behind a layered safety model:

1. **Checkpoint gate** — a `--dry-run` must have been completed, and its hash must still match your current inventory. Hash-based (not time-based): a dry-run from 23 hours ago is still valid if nothing changed, but a dry-run from 5 minutes ago is invalid if you just installed 10 new agents.
2. **Running-process gate** — no `claude` process may be running on the system, and ccaudit must not be running from inside a Claude Code Bash-tool session. Writing to `~/.claude.json` while Claude Code is alive corrupts OAuth tokens; this gate cannot be bypassed.
3. **Two-prompt ceremony** — an interactive `y/N` confirmation followed by a typed-phrase ceremony (`proceed busting`). Both prompts can be skipped only by explicitly passing `--yes-proceed-busting` (deliberately unwieldy to prevent accidents).
4. **Non-TTY gate** — on piped stdin without `--yes-proceed-busting`, the command refuses with exit code 4 rather than hanging on a prompt that will never be answered.
5. **Atomic writes** — `~/.claude.json` is read in full, mutated in memory, then atomically written via tmp-file-plus-rename. Any error before the rename aborts the Disable step without committing any changes.
6. **Restore manifest** — every successful op is logged to a JSONL manifest with content hashes, enabling `ccaudit restore` to undo the full bust with tamper detection.

---

## Stack

TypeScript · Node · `npx ccaudit@latest` · `gunshi` CLI · `tinyglobby` · `valibot` · `cli-table3` · `tsdown` · `vitest` · `pnpm` workspaces

**Zero external runtime dependencies.** The bundler owns the payload.

---

## Roadmap

| Version  | Scope                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------- |
| **v1.0** | Analysis only — ghost inventory, per-project breakdown, token waste calculator, `--json`/`--csv` export |
| **v1.1** | Dry-run mode — full change preview, checkpoint file                                                     |
| **v1.2** | Remediation — `--dangerously-bust-ghosts`, `restore`, `ccaudit contribute`                              |

---

## Relationship to ccusage

| Tool                                            | Question                                             |
| ----------------------------------------------- | ---------------------------------------------------- |
| [ccusage](https://github.com/ryoppippi/ccusage) | What did you spend?                                  |
| **ccaudit**                                     | What are you loading vs actually using — and fix it. |

---

## Status

**v1.0** — Analysis-only release. Ghost detection, token attribution, all output formats (JSON/CSV/TSV). CI-ready with exit codes.

---

## Disclaimer

ccaudit is provided AS-IS with NO WARRANTY. Anthropic does not endorse this tool. Use at your own risk.
