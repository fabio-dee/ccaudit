# /ccaudit-bust — Selective Ghost Archive

Audit the current Claude Code ghost inventory and — on your plain-English request — selectively archive the agents and skills you name. This skill uses your judgment, not rigid urgency bands, to decide what to archive.

**When to use this skill**: when the user says something like:

- "clean up my marketing skills"
- "archive any agent I haven't used in 90 days"
- "remove all GSD-related ghost skills"
- "find unused Python agents and delete them"
- "what ghost skills do I have about SEO?"

---

## Scope

This skill handles **agents** (`~/.claude/agents/*.md`) and **skills** (`~/.claude/skills/**`). These are standalone files that can be moved safely while Claude Code is running.

This skill does **not** touch MCP servers (entries in `~/.claude.json` / `.mcp.json`) or memory files (`CLAUDE.md` frontmatter). Those require editing files that Claude Code has open, which is unsafe from inside a running session. For those, tell the user:

> "For MCP servers and stale memory files, close Claude Code and run `npx ccaudit-cli@latest ghost --dangerously-bust-ghosts` from a standalone terminal."

---

## Step 1 — Audit

### 1a. Save the scan to a temp file

`ccaudit ghost --json` can produce a payload larger than the Bash tool's output buffer (typically 100+ items for a well-used Claude Code setup). **Always redirect to a file first**, then read from the file — don't parse stdout directly.

**Choose the window before running.** `ghost --json` defaults to a 7-day unused-since window, so items unused for longer than 7 days are _already_ in the candidate set — but the `daysSinceLastUse` field will not reach back further than the scan window. If the user specifies an age window (e.g. "unused for 90 days", "90 days+", "3 months+", "anything old", "stale for a quarter"), derive `--since <WINDOW>` before running ghost so age-based filtering later in Step 2 is sound. If the request is non-age-based (e.g. "archive marketing-copy", "clean up SEO skills"), keep the default.

Rule of thumb for deriving `--since`:

- "unused for N days" / "N days+" → `--since ${N}d`
- "N weeks+" → `--since ${N}w` (or `${N*7}d`)
- "N months+" / "a quarter" / "3 months+" → `--since ${N*30}d` (e.g. `--since 90d`)
- "old" / "stale" with no number → default to `--since 90d` and say so in your reply
- "never used" → default window is fine; filter on `daysSinceLastUse === null` in Step 2

Default (no age filter in the user's request):

```bash
npx ccaudit-cli@latest ghost --json > /tmp/ccaudit-audit.json 2>/dev/null || true
```

Age-window example (user asked for "unused for 90 days"):

```bash
npx ccaudit-cli@latest ghost --json --since 90d > /tmp/ccaudit-audit.json 2>/dev/null || true
```

Why each part:

- `--since <WINDOW>` — widens the scan so items older than the default 7d window are visible and carry accurate `daysSinceLastUse` values (omit for non-age-based requests)
- `> /tmp/ccaudit-audit.json` — writes the full envelope to a known location
- `2>/dev/null` — silences progress chatter so stderr doesn't mix in
- `|| true` — ccaudit exits with code 1 when ghosts are found. **This is expected**, not a failure. Coercing to 0 keeps the Bash tool from flagging it as an error.

### 1b. Filter to agent/skill ghosts (with framework protection)

Run a single `node -e` snippet that reads the file, applies the baseline filter, and optionally adds the user's topic/scope filter. The baseline is always: `category ∈ {agent, skill}` AND `tier ∈ {definite-ghost, likely-ghost}`.

**Framework protection (v1.3.0).** The envelope's top-level `frameworks[]` describes detected framework groups. Any framework whose `status === "partially-used"` has some members that are still in active use — the CLI's `ghost --dangerously-bust-ghosts` flow protects every member of that framework by default (archiving them requires the explicit `--force-partial` flag). This skill mirrors that protection: partially-used members are **excluded from the default candidate list** and surfaced separately so the user can decide whether to override.

If the user's natural-language request explicitly names a framework member (e.g., "archive `gsd-planner`"), still surface the protection warning first and require an explicit second confirmation before archiving it; don't silently bypass the safeguard.

**Baseline only** (show all ghost agents/skills, minus partially-used framework members):

```bash
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/ccaudit-audit.json", "utf8"));
const protectedFws = new Set(
  (d.frameworks || [])
    .filter(f => f.status === "partially-used")
    .map(f => f.id)
);
const baseline = d.items.filter(i =>
  (i.category === "agent" || i.category === "skill") &&
  (i.tier === "definite-ghost" || i.tier === "likely-ghost")
);
const candidates = baseline.filter(i =>
  !i.framework || !protectedFws.has(i.framework)
);
const protectedMembers = baseline.filter(i =>
  i.framework && protectedFws.has(i.framework)
);
console.log(JSON.stringify({ candidates, protectedMembers }, null, 2));
'
```

**With a topic filter** (e.g., user asked for "marketing"):

```bash
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/ccaudit-audit.json", "utf8"));
const protectedFws = new Set(
  (d.frameworks || [])
    .filter(f => f.status === "partially-used")
    .map(f => f.id)
);
const match = i => /marketing/i.test(i.name + " " + i.path);
const baseline = d.items.filter(i =>
  (i.category === "agent" || i.category === "skill") &&
  (i.tier === "definite-ghost" || i.tier === "likely-ghost") &&
  match(i)
);
const candidates = baseline.filter(i =>
  !i.framework || !protectedFws.has(i.framework)
);
const protectedMembers = baseline.filter(i =>
  i.framework && protectedFws.has(i.framework)
);
console.log(JSON.stringify({ candidates, protectedMembers }, null, 2));
'
```

Adapt the regex, category, tier, or scope conditions to match the user's request. Never pipe the original stdout of `ccaudit ghost --json` into `node -e` or similar — always go through the temp file.

**Present `candidates` as the primary list.** If `protectedMembers` is non-empty, show a brief note after the numbered list:

> N item(s) were skipped because their framework is still partially in use: `<framework-id>: <names>`. To archive these anyway, close Claude Code and run `npx ccaudit-cli@latest ghost --dangerously-bust-ghosts --force-partial` from a standalone terminal, or confirm each by name in your next reply.

If the user later explicitly names a protected member, archive it with the same `mv` step as any other item but first warn: "`gsd-planner` is part of `gsd`, which is still partially in use — archive anyway?" and wait for explicit confirmation.

**Ignore** `mcp-server` and `memory` items in the filter — they're out of scope for this skill. If the user's request implies those categories, point them at the external CLI (see Scope section above).

### Envelope shape (for reference)

```json
{
  "meta": { "command": "ghost", "exitCode": 1 },
  "frameworks": [
    {
      "id": "gsd",
      "status": "partially-used",
      "totals": { "defined": 5, "used": 2, "definiteGhost": 3 }
    }
  ],
  "items": [
    {
      "name": "marketing-copy",
      "category": "skill",
      "scope": "global",
      "tier": "definite-ghost",
      "path": "/Users/you/.claude/skills/marketing-copy.md",
      "daysSinceLastUse": null,
      "tokenEstimate": { "tokens": 1200 },
      "framework": null
    },
    {
      "name": "gsd-planner",
      "category": "agent",
      "scope": "global",
      "tier": "definite-ghost",
      "path": "/Users/you/.claude/agents/gsd-planner.md",
      "daysSinceLastUse": 42,
      "tokenEstimate": { "tokens": 800 },
      "framework": "gsd"
    }
  ]
}
```

`meta.exitCode` of `1` with `items[]` populated is the normal "ghosts found" state. Treat it as success. `frameworks[]` is the key the protection logic keys off of; `item.framework` (string or null) is how each member is attributed.

---

## Step 2 — Apply the user's filter

Use your judgment to match candidates against what the user asked for. The filter can be anything:

- **By topic**: "marketing", "python", "seo", "anything about copywriting"
- **By age**: "unused for 90 days", "never used", "old"
- **By framework/prefix**: "all gsd", "all superpowers skills"
- **By scope**: "only global ones", "project-local ghosts"
- **Combinations**: "marketing skills unused for 60 days"

**Matching strategy**:

1. Start with `name` and `path` (cheap, often enough).
2. If the name is ambiguous for a topic filter, `Read` the first ~30 lines of the file to check what it's actually about.
3. Prefer false negatives (ask the user about edge cases) over false positives (archiving something they didn't mean).

**If the request is vague** (e.g., "clean up unused stuff"), don't guess — show the full ghost list and ask the user to narrow it down.

---

## Step 3 — Show the list and confirm

Present the matching candidates as a numbered list:

```text
Found 4 ghost items matching "marketing":

  1. marketing-copy         [skill, global, never used,     ~1,200 tokens]
  2. seo-writer             [skill, global, 67 days ago,      ~900 tokens]
  3. campaign-planner       [skill, global, 120 days ago,   ~1,500 tokens]
  4. landing-page-critique  [skill, global, never used,       ~800 tokens]

Total if all archived: ~4,400 tokens/session freed.

Archive all 4? Reply with:
  - yes / y / all             → archive everything shown
  - no / n / cancel           → stop, nothing changes
  - "1, 3" or item names      → archive just those
```

Wait for an explicit reply. Parse it:

| Reply                              | Action                         |
| ---------------------------------- | ------------------------------ |
| `yes`, `y`, `all`                  | Archive every item in the list |
| `no`, `n`, `cancel`, empty/unclear | Stop. Say "Nothing changed."   |
| `1, 3` or `1-3` or `1 and 3`       | Archive only those indices     |
| Item names (`seo-writer, ...`)     | Archive matching names         |
| Anything ambiguous                 | Ask again rather than guessing |

---

## Step 4 — Archive

For each confirmed item, compute the destination and move it.

**Destination mapping**:

| Source                             | Destination                                                           |
| ---------------------------------- | --------------------------------------------------------------------- |
| `~/.claude/agents/X.md`            | `~/.claude/ccaudit/archived/agents/X.md`                              |
| `~/.claude/skills/X.md`            | `~/.claude/ccaudit/archived/skills/X.md`                              |
| `~/.claude/skills/X/SKILL.md`      | move the `X/` directory → `~/.claude/ccaudit/archived/skills/X/`      |
| `<proj>/.claude/agents/X.md`       | `<proj>/.claude/ccaudit/archived/agents/X.md`                         |
| `<proj>/.claude/skills/X.md`       | `<proj>/.claude/ccaudit/archived/skills/X.md`                         |
| `<proj>/.claude/skills/X/SKILL.md` | move the `X/` directory → `<proj>/.claude/ccaudit/archived/skills/X/` |

The rule: replace `.claude/{agents,skills}/` with `.claude/ccaudit/archived/{agents,skills}/`, preserving the filename (or directory name) on the tail.

**Before the first move**, create the parent archive directory:

```bash
mkdir -p ~/.claude/ccaudit/archived/skills
mkdir -p ~/.claude/ccaudit/archived/agents
```

(Adjust for project-scoped items by using the project's `.claude/` root. The `~` in `mkdir -p ~/...` is fine — tilde expands at word-start when unquoted.)

**Then move one item at a time**:

```bash
mv "<source>" "<destination>"
```

**Path expansion rule.** When you substitute concrete paths into the `mv` command, do **not** write `"~/.claude/..."` with the tilde inside double quotes — POSIX shells only expand `~` when it's unquoted at the start of a word. Use one of these instead:

- **Preferred**: the literal home path (`"$HOME/.claude/..."`), which expands safely inside double quotes and tolerates paths with spaces.
- Acceptable: the absolute path you already have in `item.path` (e.g. `"/Users/you/.claude/..."`), because `ccaudit ghost --json` always returns fully-resolved absolute paths.

For skill directories (where `path` ends in `/SKILL.md`), move the parent directory, not the `SKILL.md` file itself:

```bash
# path = /Users/you/.claude/skills/marketing-copy/SKILL.md
# Move the dir, not the file:
mv "/Users/you/.claude/skills/marketing-copy" "/Users/you/.claude/ccaudit/archived/skills/marketing-copy"
```

**If one move fails** (permission error, destination already exists, source missing), report that specific failure and continue with the remaining items. Never abort the whole batch on a single failure.

---

## Step 5 — Report

After all moves are attempted, summarize:

```text
Archived 4 items:
  ✓ marketing-copy         → ~/.claude/ccaudit/archived/skills/marketing-copy.md
  ✓ seo-writer             → ~/.claude/ccaudit/archived/skills/seo-writer.md
  ✓ campaign-planner       → ~/.claude/ccaudit/archived/skills/campaign-planner.md
  ✓ landing-page-critique  → ~/.claude/ccaudit/archived/skills/landing-page-critique.md

Estimated tokens freed per session: ~4,400

To restore any of these, just ask me — I'll move them back.
You can also restore manually with `mv`.
```

If any moves failed, list them separately with the error:

```text
Failed:
  ✗ old-agent — destination already exists at ~/.claude/ccaudit/archived/agents/old-agent.md
```

---

## Restoration

If the user later says "put marketing-copy back" or "restore seo-writer", reverse the mapping:

```bash
mv "$HOME/.claude/ccaudit/archived/skills/marketing-copy.md" "$HOME/.claude/skills/marketing-copy.md"
```

(Same tilde rule as Step 4: don't write `"~/..."` — use `"$HOME/..."` or an absolute path. The `~` in the `mkdir` below is fine because it's unquoted at word-start.)

For skill directories, move the directory back. Confirm the original parent directory exists (`mkdir -p ~/.claude/skills` first, to be safe).

---

## Constraints

1. **Only touch agent files and skill files/directories.** Never edit `~/.claude.json`, `.mcp.json`, or memory file contents (`CLAUDE.md` or similar). If the user asks to archive an MCP server or memory file, tell them to use the external CLI:

   > "For MCP servers and memory files, close Claude Code and run `npx ccaudit-cli@latest ghost --dangerously-bust-ghosts` from a standalone terminal."

2. **Only archive items ccaudit reports as ghosts.** If the user names an item that ccaudit shows as `tier: "used"` (actively invoked), warn them:

   > "marketing-copy was used 4 days ago — it's not a ghost. Archive anyway?"
   > Only proceed on explicit confirmation.

3. **One explicit confirmation minimum.** Never archive without the user typing `yes`/`y`/`all`, naming items, or selecting by index. Silent consent is not consent.

4. **Preserve original names.** Don't rename files on the way into the archive. `X.md` stays `X.md`.

5. **`mkdir -p` before the first `mv`.** The archive directory may not exist yet.

6. **Respect user intent.** If the user says "skip #2" mid-list, honor it immediately. If they name an item you didn't plan to archive, add it (subject to constraint 2 if it's not a ghost).

---

## Example invocation

**User**: "Can you archive all my marketing-related ghost skills?"

**You**:

1. Save the audit: `npx ccaudit-cli@latest ghost --json > /tmp/ccaudit-audit.json 2>/dev/null || true`
2. Filter with one `node -e` call: `category === "skill"` AND `tier ∈ {definite-ghost, likely-ghost}` AND `/marketing/i.test(name + " " + path)`.
3. If some candidates have ambiguous filenames, `Read` the first ~30 lines of each to confirm topic fit.
4. **Heads-up the user about any mismatch between their wording and what exists** — e.g., if they said "skills" but the matches are actually agents, say so and ask if they want those instead.
5. Show the matches as a numbered list with tokens.
6. Wait for explicit confirmation (`yes`, `all`, subset like `1, 3`, or names).
7. `mkdir -p` the archive directory, then one `mv` per item.
8. Report what moved and how to undo.
