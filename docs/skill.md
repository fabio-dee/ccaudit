# ccaudit-bust Skill

The `ccaudit-bust` skill is a Claude Code slash command that walks you through a guided ghost inventory audit and — with your explicit approval — cleans it up in one session.

## What it does

When you type `/ccaudit-bust` (or ask Claude to audit your setup), Claude will:

1. Run `npx ccaudit@latest ghost --json` and parse the inventory
2. Sort ghost items by urgency score and present a plain-English remediation plan
3. Ask for three separate confirmations before touching anything
4. Run `npx ccaudit@latest ghost --dry-run` to create the safety checkpoint
5. Run `npx ccaudit@latest ghost --dangerously-bust-ghosts` to execute the plan
6. Report what was changed and where the restore manifest lives

Every change is reversible. Nothing is deleted.

## Installation

The skill file ships inside the ccaudit package. Copy it into your global Claude Code commands directory:

```bash
cp node_modules/ccaudit/.claude/commands/ccaudit-bust.md ~/.claude/commands/ccaudit-bust.md
```

Or, if you are running from the ccaudit repository:

```bash
cp apps/ccaudit/.claude/commands/ccaudit-bust.md ~/.claude/commands/ccaudit-bust.md
```

After copying, the skill is available in any Claude Code session as `/ccaudit-bust`.

## Usage

Open Claude Code and type:

```
/ccaudit-bust
```

Or phrase it naturally:

```
audit my Claude setup
clean up my ghost inventory
what's loading every session that I never use?
```

Claude will take it from there.

## The ceremony

The skill enforces a seven-step flow. You cannot skip steps.

| Step                   | What happens                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| 1. Scan                | `ghost --json` runs and Claude reads the inventory                               |
| 2. Triage              | Items are sorted by urgency score and grouped by severity band                   |
| 3. Plan                | Claude presents what will be archived, disabled, or flagged — with token savings |
| 4a. Confirm plan       | You type `yes` to approve the plan                                               |
| 4b. Dry-run            | `ghost --dry-run` runs and writes the checkpoint                                 |
| 4c. Final confirmation | You type `bust`, then `I understand`                                             |
| 5. Execute             | `ghost --dangerously-bust-ghosts` runs                                           |
| 6. Report              | Claude summarizes results and token savings                                      |
| 7. Restore path        | Claude reminds you how to undo everything                                        |

## Urgency bands

The skill uses `urgencyScore` (0–100) to prioritize items. Higher scores mean higher remediation value.

| Band     | Score  | Default action                        |
| -------- | ------ | ------------------------------------- |
| Critical | 80–100 | Included in bust plan                 |
| High     | 60–79  | Included in bust plan                 |
| Medium   | 40–59  | Presented to you; included by default |
| Low      | 0–39   | Presented to you; excluded by default |

Items that were never used (`daysSinceLastUse: null`) are always treated as Critical.

Global items (`scope: "global"`) are shown first because they waste tokens in every session, not just in one project.

## What ccaudit changes

All operations are reversible. ccaudit never deletes anything.

**Agents and skills** are moved from their active location to an archive directory:

```
~/.claude/agents/old-agent.md
  -> ~/.claude/ccaudit/archived/agents/old-agent.md
```

**MCP servers** are commented out in `~/.claude.json` or `.mcp.json`, not removed:

```json
"// ccaudit-disabled playwright": { "command": "npx", "args": ["playwright-mcp"] }
```

**Memory files** receive a stale flag in their frontmatter:

```yaml
---
ccaudit-stale: true
ccaudit-flagged: '2026-04-03T14:26:00Z'
---
```

## Restoring changes

To undo everything the last bust did:

```bash
npx ccaudit@latest restore
```

To restore a single item by name:

```bash
npx ccaudit@latest restore old-agent
```

To see what was archived:

```bash
npx ccaudit@latest restore --list
```

## Safety guarantees

The skill enforces four hard rules that cannot be bypassed through conversation:

**1. No bust without three confirmations.** The skill asks for `yes`, then `bust`, then `I understand` — each at a distinct decision point — before running `--dangerously-bust-ghosts`.

**2. No bust without a dry-run checkpoint.** `--dangerously-bust-ghosts` refuses to run if no checkpoint exists. The skill creates the checkpoint at step 4b. If your inventory changes between the dry-run and the bust, ccaudit detects the hash mismatch and stops.

**3. No direct file edits.** All changes go through ccaudit's own commands. The skill does not edit `~/.claude.json`, `.mcp.json`, agent files, or memory files directly.

**4. Claude Code must not be running.** The skill will stop and ask you to close Claude Code if it detects that Claude Code processes are active. Modifying configuration while Claude Code is reading it can corrupt session state.

## Running from a separate terminal

`--dangerously-bust-ghosts` cannot modify Claude Code's configuration files while Claude Code has them open. If you invoke the skill from inside a Claude Code session and the bust exits with a "running process" error, open a separate terminal window and run:

```bash
npx ccaudit@latest ghost --dry-run
npx ccaudit@latest ghost --dangerously-bust-ghosts
```

The `--yes-proceed-busting` flag skips the interactive confirmation prompts for non-TTY environments (CI, scripts). Do not use it interactively — the prompts exist for your protection.

## JSON output for automation

Every ccaudit command supports `--json`. The skill uses this flag internally, but you can also run these commands directly:

```bash
# See what the skill sees
npx ccaudit@latest ghost --json

# Top 5 items by urgency
npx ccaudit@latest ghost --json | jq '[.items[] | select(.urgencyScore >= 70)] | sort_by(-.urgencyScore) | .[0:5]'

# Count definite ghosts
npx ccaudit@latest ghost --json | jq '[.items[] | select(.tier == "definite-ghost")] | length'

# Preview the dry-run plan as JSON
npx ccaudit@latest ghost --dry-run --json
```

See [JSON-SCHEMA.md](./JSON-SCHEMA.md) for the full envelope shape and all field definitions.

## Relationship to the CLI

The skill is a guided wrapper around existing ccaudit commands. It does not add new capabilities — it adds ceremony and safety checks that make the remediation flow safe to run inside a Claude Code session. For scripting, CI, and automation, use the CLI directly:

```bash
# Analysis only (read-only, always safe)
npx ccaudit@latest ghost --json

# Preview changes
npx ccaudit@latest ghost --dry-run

# Execute (requires prior dry-run)
npx ccaudit@latest ghost --dangerously-bust-ghosts
```
