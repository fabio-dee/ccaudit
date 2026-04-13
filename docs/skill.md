# ccaudit-bust Skill

The `ccaudit-bust` skill is a Claude Code slash command that lets you archive ghost inventory by plain-English request — "clean up my marketing skills", "archive any agent I haven't used in 90 days" — and handles the moves directly, right inside your Claude Code session.

## What it does

When you type `/ccaudit-bust` (or ask Claude to clean something specific up), Claude will:

1. Run `npx ccaudit-cli@latest ghost --json` and read the ghost inventory
2. Filter candidates (agents + skills only) by what you asked for
3. Show the matching items with their token cost
4. Wait for your explicit confirmation (`yes`, a subset like `1, 3`, or item names)
5. Move each confirmed file into `~/.claude/ccaudit/archived/` via `mv`
6. Report what moved and how to undo it

Nothing is deleted. Everything is reversible by asking Claude to put it back or running `mv` yourself.

## Installation

The skill file ships inside the ccaudit package. Copy it into your global Claude Code commands directory:

```bash
cp node_modules/ccaudit/.claude/commands/ccaudit-bust.md ~/.claude/commands/ccaudit-bust.md
```

Or, if you are running from the ccaudit repository:

```bash
cp apps/ccaudit/.claude/commands/ccaudit-bust.md ~/.claude/commands/ccaudit-bust.md
```

Or use the bundled installer:

```bash
npx ccaudit-cli@latest install-skill
```

After copying, the skill is available in any Claude Code session as `/ccaudit-bust`.

## Usage

Open Claude Code and type:

```
/ccaudit-bust
```

Or phrase the request naturally:

```
clean up my marketing skills
archive any agent I haven't used in 90 days
remove all GSD-related ghost skills
find unused Python agents and archive them
what ghost skills do I have about SEO?
```

Claude will audit, filter by your description, show the matches, and wait for your go-ahead before moving anything.

## Flow at a glance

| Step              | What happens                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| 1. Audit          | `ghost --json` runs; Claude keeps only agents + skills at `definite-ghost`/`likely-ghost` |
| 2. Filter         | Claude matches candidates against your request (by name, path, and content if needed)     |
| 3. Show + confirm | Claude presents a numbered list with tokens; you reply `yes`, a subset, or `no`           |
| 4. Archive        | Claude `mkdir -p`s the archive dir and `mv`s each confirmed item                          |
| 5. Report         | Claude shows what moved where and how to undo                                             |

## Scope: agents and skills only

The skill handles:

- **Agents**: `~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`
- **Skills**: `~/.claude/skills/*.md`, `~/.claude/skills/X/SKILL.md`, and the project-scoped equivalents

It deliberately does **not** touch:

- **MCP servers** (entries in `~/.claude.json` / `.mcp.json`)
- **Memory files** (`CLAUDE.md` frontmatter flags)

Those require editing files that Claude Code holds open, which isn't safe from inside a running session. For MCP and memory cleanup, close Claude Code and run the bulk command from a standalone terminal:

```bash
npx ccaudit-cli@latest ghost --dangerously-bust-ghosts
```

## What ccaudit changes

Agents and skills are **moved** from their active location to a parallel archive directory:

```
~/.claude/agents/old-agent.md
  → ~/.claude/ccaudit/archived/agents/old-agent.md

~/.claude/skills/marketing-copy.md
  → ~/.claude/ccaudit/archived/skills/marketing-copy.md

~/.claude/skills/big-skill/SKILL.md     (entire big-skill/ dir moves)
  → ~/.claude/ccaudit/archived/skills/big-skill/SKILL.md
```

Project-scoped items follow the same rule relative to the project's `.claude/` root:

```
<project>/.claude/agents/foo.md
  → <project>/.claude/ccaudit/archived/agents/foo.md
```

Filenames and directory names are preserved. Nothing is renamed or rewritten.

## Restoring

The skill doesn't write a manifest — there's nothing to read back. Restoration is a plain move:

**Ask Claude** (easiest):

> "put marketing-copy back"
> "restore seo-writer"

Claude reverses the archive mapping with a single `mv`.

**Or do it yourself**:

```bash
mv ~/.claude/ccaudit/archived/skills/marketing-copy.md ~/.claude/skills/marketing-copy.md
```

For bulk restores of items archived by the CLI's `--dangerously-bust-ghosts` ceremony (which does write a manifest), `ccaudit restore` still works:

```bash
npx ccaudit-cli@latest restore        # restore all from the last CLI bust
npx ccaudit-cli@latest restore <name> # restore one by name
npx ccaudit-cli@latest restore --list # list archived items
```

## Safety guarantees

The skill enforces four rules:

**1. Explicit confirmation required.** The skill never archives without you typing `yes`, naming specific items, or selecting indices. Silent consent is not consent.

**2. Only ghost-tier items, unless you override.** If you name an item that ccaudit reports as actively used (`tier: "used"`), the skill warns you and asks before archiving.

**3. Agent and skill files only.** The skill never edits `~/.claude.json`, `.mcp.json`, or memory file contents. For those, it points you at the external CLI.

**4. Preserve the original name.** Files and directories keep their names inside the archive, so restoration is trivial.

## JSON output for automation

The skill calls `ccaudit ghost --json` internally, but you can use the same endpoint directly:

```bash
# See all ghosts
npx ccaudit-cli@latest ghost --json

# Top 5 agents/skills by urgency
npx ccaudit-cli@latest ghost --json \
  | jq '[.items[] | select((.category == "agent" or .category == "skill") and .urgencyScore >= 70)] | sort_by(-.urgencyScore) | .[0:5]'

# Count definite ghosts across all categories
npx ccaudit-cli@latest ghost --json | jq '[.items[] | select(.tier == "definite-ghost")] | length'

# Framework-grouped view (v1.3.0+)
npx ccaudit-cli@latest ghost --json | jq '.frameworks[]'
```

See [JSON-SCHEMA.md](./JSON-SCHEMA.md) for the full envelope shape and all field definitions.

## Skill vs. CLI — when to use which

| You want to…                                               | Use                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Archive a specific slice of agents/skills by plain-English | `/ccaudit-bust` (this skill, inside Claude Code)                            |
| Restore a specific item you archived through the skill     | Ask the skill, or `mv` it yourself                                          |
| Archive MCP servers or memory files                        | `ccaudit ghost --dangerously-bust-ghosts` (CLI, from a standalone terminal) |
| Bulk-clean _every_ ghost at once                           | `ccaudit ghost --dangerously-bust-ghosts` (CLI)                             |
| Restore from a CLI bust                                    | `ccaudit restore` (manifest-aware)                                          |
| Read-only inventory scan                                   | `ccaudit ghost` or `ccaudit ghost --json`                                   |

The skill is for selective, interactive cleanup. The CLI is for bulk operations that need to edit shared config.
