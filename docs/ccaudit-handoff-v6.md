# ccaudit — Project Handoff v6

> **Status:** Brainstorming + competitive research complete. Name locked. Safety design locked.  
> **Next:** Clone study list → inspect local JSONL → lock schema → write PRD → spec.

---

## What Is ccaudit?

Companion CLI to [ccusage](https://github.com/ryoppippi/ccusage):

- **ccusage** → *"What did you spend?"*
- **ccaudit** → *"What are you loading vs actually using — and fix it."*

Audits Claude Code ghost inventory: agents, skills, MCP servers, memory files — loaded every session, rarely or never invoked. Then optionally remediates them with a single dangerous flag, using algorithms inspired by tools like Agent-Registry, implemented natively with no external dependencies.

### PRD Opening Data Point (Real Numbers, Anthropic Issue #7336)

```
MCP tools:     39.8k tokens  (19.9% of 200k window)
Custom agents:  9.7k tokens   (4.9%)
System tools:  22.6k tokens  (11.3%)
Memory files:  36.0k tokens  (18.0%)
─────────────────────────────────────────────────
Before any conversation: ~108k tokens (54%)
Remaining for actual work:  92k tokens
```

---

## Name Decision: `ccaudit` (Locked)

**Not `ccghostbuster`.** "Ghostbusters" is a registered trademark of Sony Pictures. The compound word — not the logo, not the slogan — is protected. At 5K stars and media coverage (the target), that's when legal departments notice. A cease-and-desist at peak virality kills momentum.

**The ghost concept lives in the UX instead**, where it creates virality without trademark exposure:

- Output uses "Ghost Inventory", "ghost agents", "👻 ghost overhead"
- The remediation flag is `--dangerously-bust-ghosts`
- The restore command is `ccaudit restore`
- The viral asset is the screenshot of `--dangerously-bust-ghosts` — not the tool name

`ccaudit` also has stronger companion positioning. The pair `ccusage` / `ccaudit` is instantly understood. The README writes itself: *"ccusage tells you what you spent. ccaudit tells you what's wasting it — and cleans it up."*

---

## Product Philosophy: All-In-One Analysis + Remediation

**No external dependencies.** ccaudit does not "integrate" with Agent-Registry, the-library, or any other tool. It draws algorithmic inspiration from them and implements the same logic natively:

- **Agent-Registry** proved that moving agents out of `~/.claude/agents/` into an archive + lightweight index reduces agent token load 70-90%. ccaudit implements this algorithm itself under `--dangerously-bust-ghosts`.
- **ccusage** proved that read-only, local-first, zero-install npx CLIs earn trust first — ccaudit ships analysis-only in v1, remediation in v1.2.
- **who-ran-what / agent-usage-analyzer** proved the audit market exists. ccaudit differentiates by adding token-cost attribution and fixing, not just reporting.

The headline: *"Find out what you're not using — and fix it in one command."*

Before/after on X:
```
Before: 108k tokens consumed before you type a word
After:    12k tokens
Command:  ccaudit --dangerously-bust-ghosts
```
That's the viral hook.

---

## Command Structure and Safety Design

### Three-Mode Design

```
ccaudit [command] [flags]
```

**Mode 1 — Analysis (default, read-only, always safe):**
```bash
npx ccaudit@latest              # ghost inventory, last 7 days
npx ccaudit ghost --since 30d   # configurable threshold
npx ccaudit inventory           # full inventory + all usage stats
npx ccaudit mcp                 # MCP servers: token cost + frequency
npx ccaudit mcp --live          # exact token count via live connection
npx ccaudit trend               # invocation frequency over time
```

**Mode 2 — Dry-run (simulation, read-only, shows exactly what would change):**
```bash
npx ccaudit --dry-run
```
Produces a detailed change plan — which agents would be archived, which MCP servers would be disabled, estimated token savings — without touching anything. **Must be run and reviewed before Mode 3 is allowed.**

**Mode 3 — Remediation (destructive, gated, reversible):**
```bash
npx ccaudit --dangerously-bust-ghosts
```

---

### Dry-Run Checkpoint Enforcement

The dry-run gate is mechanical, not just documented. When `--dry-run` completes successfully, ccaudit writes a checkpoint:

```
~/.claude/ccaudit/.last-dry-run
{
  "timestamp": "2026-04-03T14:22:00Z",
  "ghost_hash": "sha256:<hash of current ghost inventory>",
  "item_count": { "agents": 128, "skills": 82, "mcp": 4 }
}
```

When `--dangerously-bust-ghosts` is invoked, it checks:

1. Checkpoint exists → if not: **BLOCKED.** "Run `ccaudit --dry-run` first and review the output."
2. Checkpoint is recent (≤24h) → if not: **BLOCKED.** "Dry-run is stale. Run it again."
3. Ghost inventory hash matches → if not: **BLOCKED.** "Your setup changed since the dry-run. Run it again to see current state."

All three must pass before the triple confirmation prompt appears. This prevents "I ran dry-run three days ago on a different machine."

---

### Remediation UX (Two-Prompt Confirmation)

> **Note:** This section was updated during Phase 8 planning (2026-04). The original v6 draft specified a three-prompt ceremony (y/N, are-you-sure, typed longer phrase) with a correspondingly verbose non-TTY bypass flag. Phase 8 decision D-15 in `.planning/phases/08-remediation-core/08-CONTEXT.md` reduced it to a two-prompt ceremony with the typed phrase `proceed busting`, and Phase 8 D-16 renamed the non-TTY bypass to `--yes-proceed-busting`. The new phrase is faster to type, still screenshot-friendly, and the bypass flag is deliberately unwieldy enough to prevent copy-paste accidents from shell scripts. Both the original phrase and the original flag name were superseded before any implementation landed.

```
$ ccaudit --dangerously-bust-ghosts

✓  Dry-run checkpoint verified (inventory hash matches)

⚠️  DESTRUCTIVE OPERATION — READ CAREFULLY
──────────────────────────────────────────────────────────────────
  Will ARCHIVE (reversible via `ccaudit restore <name>`):
    128 agents → ~/.claude/agents/_archived/
     82 skills → ~/.claude/skills/_archived/

  Will DISABLE in ~/.claude.json (key-renamed, not deleted):
      4 MCP servers  (moved to ccaudit-disabled:<name>)

  Will FLAG in memory files (frontmatter only, not deleted):
      6 stale files  (ccaudit-stale: true)

  Estimated savings: ~94k tokens/session

  ⚠️  ccaudit is provided AS-IS with NO WARRANTY.
  Anthropic does not endorse this tool. Use at your own risk.
──────────────────────────────────────────────────────────────────

[1/2] Proceed busting? [y/N]:
> y

[2/2] Type exactly: proceed busting
> proceed busting

Archiving agents...  ████████████████████ 128/128
Archiving skills...  ████████████████████  82/82
Disabling MCP...     ████████████████████   4/4
Flagging memory...   ████████████████████   6/6

✓  Done. Saved ~94k tokens/session.
   Verify: npx ccaudit
   Undo:   npx ccaudit restore
   Undo single: npx ccaudit restore <name>
```

For non-interactive / CI usage, pass `--yes-proceed-busting` to skip both prompts. On the bust command only, `--ci` additionally implies `--yes-proceed-busting` (the single intentional footgun, documented prominently in the README).

### Why This UX is a Viral Asset

The two-step confirmation isn't just legal cover — it's shareable content. "This CLI made me type 'proceed busting' before cleaning my ghost agents" is a tweet. The `--dangerously-bust-ghosts` flag name will appear in every screenshot, blog post, and X thread. People post command flags when they're funny and accurate — this is both.

---

### Remediation Mechanics (All Reversible)

**Agents and Skills — Archive, Not Delete:**
```
~/.claude/agents/code-reviewer.md
→ ~/.claude/agents/_archived/code-reviewer.md

Restore: ccaudit restore code-reviewer
→ moves back to ~/.claude/agents/code-reviewer.md
```

**MCP Servers — Comment Out, Not Delete:**
```json
// settings.json — before
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["playwright-mcp"] }
  }
}

// settings.json — after (ccaudit preserves original, just disables)
{
  "mcpServers": {
    "// ccaudit-disabled playwright": { "command": "npx", "args": ["playwright-mcp"] }
  }
}
```
Restore strips the prefix. Original config preserved verbatim.

**Memory Files — Flag, Not Move:**
```yaml
# CLAUDE.md frontmatter — before
---
title: Mission Control context
---

# CLAUDE.md frontmatter — after
---
title: Mission Control context
ccaudit-stale: true
ccaudit-flagged: "2026-04-03T14:26:00Z"
---
```
Files still exist and load normally — the flag is for human review, not mechanical exclusion. Restore strips the frontmatter keys.

**Full Rollback:**
```bash
ccaudit restore          # undo everything from last bust
ccaudit restore <name>   # restore single item
ccaudit restore --list   # show all archived items
```

---

## Feature Set

### v1.0 — Analysis Only (Read-Only, Build Trust)

**Ghost Inventory** (default command):
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

Per-project breakdown, global cross-project view, token waste calculator, trend view, recommendations (Archive / Monitor / Keep), `--json` / `--csv` export.

### v1.1 — Dry-Run (Preview Mode)

`ccaudit --dry-run` — shows the full change plan, writes the checkpoint file. No filesystem changes.

### v1.2 — Remediation

`ccaudit --dangerously-bust-ghosts` — the full gated flow above.  
`ccaudit restore` / `ccaudit restore <name>` — rollback.  
`ccaudit contribute` — generate PR payload for `mcp-token-estimates.json`.

---

## Competitive Landscape

### Direct Competitors

**mylee04/who-ran-what** — `https://github.com/mylee04/who-ran-what`  
`wr clean` lists unused agents/skills 30+ days. Bash, Homebrew. No token attribution, no MCP audit, no fix.  
**Threat: MEDIUM-HIGH.** ccaudit differentiates: token cost per ghost + fix command.

**yctimlin/agent-usage-analyzer** — `https://github.com/yctimlin/agent-usage-analyzer`  
Skill-first JSONL analyzer. Reports usage counts. AI skill wrapper, not npx CLI. No ghost framing, no fix.  
**Threat: MEDIUM.**

**florianbruniaux/ccboard** — `https://github.com/FlorianBruniaux/ccboard`  
Rust TUI + Web. Shows agent invocation stats and MCP usage. No ghost inventory, no fix, not zero-install.  
**Threat: HIGH if they add ghost + npx. Currently: MEDIUM.**

### Infrastructure / Study These Parsers

| Repo | Why Study |
|---|---|
| `ryoppippi/ccusage` | Architecture to replicate verbatim |
| `florianbruniaux/ccboard` | Agents tab JSONL parsing |
| `mylee04/who-ran-what` | How wr clean detects unused items |
| `yctimlin/agent-usage-analyzer` | Signal detection from JSONL |
| `delexw/claude-code-trace` | MCP `mcp__<server>__<tool>` name parsing in Rust |
| `nadersoliman/cc-trace` | Hook event schema (PostToolUse, SubagentStop fields) |
| `simonw/claude-code-transcripts` | Clean JSONL parser reference |
| `MaTriXy/Agent-Registry` | Archive + index algorithm (implement natively) |

### Market Proof — Anthropic Issues

- `anthropics/claude-code/issues/7336` — 108k tokens before any conversation. Per-category breakdown. PRD opener.
- `anthropics/claude-code/issues/8997` — 16k agent tokens, 2-3 agents ever used per task.
- `anthropics/claude-code/issues/13805` — 23k MCP tokens only ever used by subagents.

---

## Stack

TypeScript/Node · `npx ccaudit@latest` · `gunshi` CLI · `tinyglobby` discovery  
`valibot` safeParse (silent skip invalid lines) · `cli-table3` tables · `tsdown` bundler  
`vitest` in-source tests · `pnpm` workspaces

**Monorepo:**
```
apps/ccaudit/       ← main CLI
apps/ccaudit-mcp/   ← future MCP server
packages/internal/  ← shared types/utils
packages/terminal/  ← shared table rendering
docs/               ← VitePress
```

**MCP token estimation:**
- Default: `mcp-token-estimates.json` embedded at build. Community-maintained via PRs — second growth vector.
- `--live`: connect to running servers, exact count
- `ccaudit contribute`: auto-generate PR payload

---

## Data Sources

```
~/.claude/projects/*/sessions/*.jsonl         ← primary signal
~/.config/claude/projects/*/sessions/*.jsonl  ← XDG path
~/.claude/agents/  ~/.claude/skills/          ← global definitions
~/.claude/settings.json  ~/.claude.json       ← MCP configs
~/.claude/CLAUDE.md  ~/.claude/rules/         ← memory
.claude/agents/  .claude/skills/              ← project-level
.claude/settings.json                         ← project MCP overrides
```

**MCP invocation format (confirmed from delexw/claude-code-trace):**  
`mcp__<server-name>__<tool-name>` e.g. `mcp__chrome-devtools__take_screenshot`  
Parse: split on `__`, [0] = "mcp", [1] = server name, [2] = tool name.

---

## JSONL Schema — VALIDATE BEFORE SPECCING ⚠️

```bash
# Find files
find ~/.claude/projects ~/.config/claude/projects -name "*.jsonl" 2>/dev/null | head -20

# Largest (richest data)
find ~/.claude/projects ~/.config/claude/projects -name "*.jsonl" 2>/dev/null \
  | xargs ls -lS 2>/dev/null | sort -k5 -rn | head -5

# Structure
JSONL="<path>"
head -3 "$JSONL" | while IFS= read -r line; do echo "$line" | python3 -m json.tool; echo "---"; done

# All top-level keys
head -50 "$JSONL" | python3 -c "
import sys, json
keys = set()
for line in sys.stdin:
    try:
        obj = json.loads(line); keys.update(obj.keys())
    except: pass
print(sorted(keys))"

# Invocation signals
grep -m 5 '"tool_use"' "$JSONL" | python3 -m json.tool 2>/dev/null | head -60
grep -m 5 '"agent_type"' "$JSONL" | python3 -m json.tool 2>/dev/null | head -60
grep -m 5 '"mcp__"' "$JSONL" | python3 -m json.tool 2>/dev/null | head -30

# MCP config
cat ~/.claude/settings.json 2>/dev/null | python3 -m json.tool | grep -A5 '"mcpServers"'
```

Paste output → lock schema → write PRD.

---

## Open Questions Before PRD

1. **JSONL schema** — what fields signal agent/skill/slash-command invocations?
2. **Skill invocations** — distinct event type or user text? (skills are `/skill-name` slash commands)
3. **Memory staleness** — no invocation events. File mod date heuristic or something richer?
4. **Project name decoding** — full decode of `<encoded-cwd>` or last path segment?
5. **ccboard Agents tab** — exactly what do they parse? Diff carefully.
6. **MCP estimates bootstrap** — 20+ servers for credible v1 launch.
7. **Dry-run checkpoint location** — `~/.claude/ccaudit/` vs project-local `.claude/ccaudit/`? (global makes more sense since it covers all projects)
8. **Dry-run checkpoint expiry** — 24h is arbitrary. Two better options: (a) make it configurable via `--checkpoint-ttl 12h`, or (b) tie expiry to a hash of the agents/skills/settings directories rather than a timestamp — that way the checkpoint auto-invalidates when the user adds or removes an agent, not just when time passes. Option (b) is more correct: a dry-run from 23 hours ago is still valid if nothing changed; a dry-run from 5 minutes ago is invalid if the user just installed 10 new agents. Hash-based is safer and requires no user configuration.

---

## Clone Order

```bash
git clone https://github.com/ryoppippi/ccusage           # architecture reference
git clone https://github.com/FlorianBruniaux/ccboard      # Agents tab JSONL parsing
git clone https://github.com/mylee04/who-ran-what         # wr clean detection logic
git clone https://github.com/yctimlin/agent-usage-analyzer # signal detection
git clone https://github.com/delexw/claude-code-trace      # MCP name parsing (Rust)
git clone https://github.com/nadersoliman/cc-trace         # hook event schema (Go)
git clone https://github.com/simonw/claude-code-transcripts # clean parser reference
git clone https://github.com/MaTriXy/Agent-Registry        # archive algorithm to implement natively
```

---

## ccusage Patterns to Replicate Verbatim

- All runtime deps as `devDependencies` — bundler owns the payload
- In-source tests: `if (import.meta.vitest != null) { describe(...) }`
- Dual path: XDG + legacy in `getDefaultClaudePath()`
- `--json`, `--since`, `--until`, `--compact` on every read command
- `--offline` with macro-embedded static data
- Silent skip malformed JSONL — never throw
- `@praha/byethrow` Result type for functional error handling

---

*v6 — Name locked (ccaudit). Safety design locked. All repos verified. Ready for PRD.*
