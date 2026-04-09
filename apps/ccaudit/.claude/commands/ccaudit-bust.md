# /ccaudit-bust — Ghost Inventory Remediation Skill

Audit the current Claude Code ghost inventory, show a prioritized remediation plan, and — with explicit confirmation — execute it in one command.

**When to use this skill**: when the user says something like "audit my Claude setup", "clean up my ghosts", "run ccaudit", "bust my ghost inventory", or "what's loading every session that I never use?".

---

## What this skill does

1. Runs `npx ccaudit-cli@latest ghost --json` to scan the current inventory
2. Filters items to ghosts only (`tier: "definite-ghost"` or `"likely-ghost"`)
3. Sorts by `urgencyScore` descending so the worst offenders surface first
4. Shows a plain-English remediation plan with token savings
5. Asks the user to confirm before proceeding — three separate confirmations
6. Runs `npx ccaudit-cli@latest ghost --dry-run` to write the checkpoint
7. Runs `npx ccaudit-cli@latest ghost --dangerously-bust-ghosts` to execute the plan

---

## Step 1 — Scan

Run the scan and capture structured output:

```bash
npx ccaudit-cli@latest ghost --json
```

Parse the JSON response. The envelope shape is:

```json
{
  "meta": { "command": "ghost", "exitCode": 0 },
  "healthScore": { "score": 42, "grade": "C" },
  "totalOverhead": { "tokens": 47200 },
  "items": [
    {
      "name": "example-agent",
      "category": "agent",
      "scope": "global",
      "tier": "definite-ghost",
      "path": "/Users/you/.claude/agents/example-agent.md",
      "urgencyScore": 88,
      "daysSinceLastUse": null,
      "tokenEstimate": { "tokens": 1200, "confidence": "estimated" },
      "recommendation": "archive"
    }
  ]
}
```

Key fields to read:

| Field                          | Use                                                                    |
| ------------------------------ | ---------------------------------------------------------------------- |
| `items[].tier`                 | `"definite-ghost"` (never used or >30 d) or `"likely-ghost"` (7–30 d)  |
| `items[].urgencyScore`         | 0–100. Sort descending. This is the primary ranking signal.            |
| `items[].daysSinceLastUse`     | `null` means never used. Integer means days.                           |
| `items[].scope`                | `"global"` = affects every session. `"project"` = affects one project. |
| `items[].path`                 | Absolute path to the file or config entry.                             |
| `items[].tokenEstimate.tokens` | Estimated token load per session.                                      |
| `healthScore.grade`            | Letter grade (A–F). Show this prominently.                             |
| `totalOverhead.tokens`         | Total tokens consumed by ghost inventory each session.                 |

---

## Step 2 — Triage

Split ghosts into urgency bands using `urgencyScore`:

| Band     | Range  | Label                 | Action                           |
| -------- | ------ | --------------------- | -------------------------------- |
| Critical | 80–100 | "Archive immediately" | Include in bust plan             |
| High     | 60–79  | "Archive recommended" | Include in bust plan             |
| Medium   | 40–59  | "Review and decide"   | Present to user; default include |
| Low      | 0–39   | "Monitor"             | Present to user; default exclude |

**Scope matters**: a `"global"` ghost wastes tokens in every session. A `"project"` ghost wastes tokens only in that project's sessions. Call this out explicitly in your summary.

**Never-used items** (`daysSinceLastUse: null`) are always Critical regardless of `urgencyScore` if `tier` is `"definite-ghost"`.

---

## Step 2b — Ask urgency scope

Before presenting any plan, ask the user two questions.

### Question 1: Which urgency bands to tackle

Ask:

> "Which urgency bands do you want to tackle?
>
> - **Critical** (score 80–100): archive immediately — [N items, ~X tokens]
> - **High** (score 60–79): archive recommended — [N items, ~Y tokens]
> - **Medium** (score 40–59): review and decide — [N items, ~Z tokens]
> - **Low** (score 0–39): monitor only — [N items, ~W tokens]
>
> Options: `all`, `critical`, `critical+high` (default), `critical+high+medium`, or a custom score threshold like `>= 55`. You can also say something like 'only the ones never used'."

Fill in N and ~X/Y/Z/W from the Step 2 triage results before sending the question.

Parse the user's answer and filter the candidate set accordingly:

| Answer                                     | Filter                     |
| ------------------------------------------ | -------------------------- |
| `all`                                      | urgencyScore >= 0          |
| `critical`                                 | urgencyScore >= 80         |
| `critical+high` or default/enter/no answer | urgencyScore >= 60         |
| `critical+high+medium`                     | urgencyScore >= 40         |
| `>= N` or `>N`                             | urgencyScore >= N (or > N) |
| `never used` / `only never used`           | daysSinceLastUse === null  |

If the user doesn't answer, says "default", or just hits enter, use `critical+high` (urgencyScore >= 60).

### Question 2: Per-item exclusions

After the user answers the urgency scope, ask:

> "Are there any items you want to exclude regardless of score? You can name them by:
>
> - Name: `gsd-*` or `gsd` (matches any item with 'gsd' in the name)
> - Folder/path fragment: `agents/xyz` or `gsd-` prefix
> - Category: `all skills`, `all memory`, `all mcp`
> - Or just say 'none' to proceed with no exclusions."

Parse the user's answer into an exclusion filter and apply it to the candidate list before building the plan. Examples:

- "don't touch any GSD-related skills" → exclude items where `category === "skill"` AND `name` contains `"gsd"` (case-insensitive)
- "nothing in the xyz folder" → exclude items where `path` contains `"xyz"`
- "all memory" → exclude all items where `category === "memory"`
- "none" or empty → no exclusions

---

## Step 3 — Present the plan

Show the user a summary of the plan built from the scope and exclusions they chose in Step 2b. Format it like this:

```
Ghost Inventory Audit
Health: C (score 42/100)
Ghost overhead: ~47,200 tokens/session
Scope: critical+high | Exclusions: none

Critical ghosts (urgencyScore >= 80):
  - old-researcher [agent, global] — never used, ~1,200 tokens
  - playwright-mcp [mcp-server, global] — 91 days ago, ~8,400 tokens

High (urgencyScore 60-79):
  - sql-helper [skill, global] — 45 days ago, ~900 tokens

Estimated savings: ~10,500 tokens/session
```

If any items were excluded by the user's exclusion filter, list them separately at the bottom:

```
Excluded (per your request): gsd-quick [skill], gsd-debug [skill]
```

Then state clearly:

> "The bust plan will archive agents and skills (moved to ~/.claude/ccaudit/archived/, not deleted), comment out MCP servers in `~/.claude.json` or `.mcp.json`, and flag stale memory files. All changes are reversible with `ccaudit restore`."

Then add:

> "Not seeing something here? You can still say 'exclude `<name/pattern>`' and I'll update the plan before we proceed."

If the user responds with an exclusion request at this point, apply it to the candidate list and re-present the updated plan before moving to Step 4.

---

## Step 4 — Three-stage confirmation ceremony

**Do not proceed past any stage if the user declines.**

### Stage 1: Plan approval

Ask:

> "Does this plan look right? Type `yes` to continue or `no` to cancel."

If the user types anything other than `yes` (case-insensitive), stop here. Say: "Bust cancelled. Run `/ccaudit-bust` again whenever you're ready."

### Stage 2: Checkpoint

Run the dry-run to write the checkpoint file:

```bash
npx ccaudit-cli@latest ghost --dry-run
```

Tell the user: "Dry-run complete. Checkpoint saved. This is the safety gate — the bust will only proceed if your inventory matches exactly."

Ask:

> "Ready to proceed with the actual bust? This will modify your Claude Code configuration. Type `bust` to continue or `no` to cancel."

If the user does not type `bust` (case-insensitive), stop here.

### Stage 3: Final confirmation

This is the last stop before destructive changes. State:

> "Last chance. The following will be modified right now:
>
> - [list the specific files/entries from the dry-run]
>
> Type `I understand` to proceed or anything else to cancel."

If the user does not type exactly `I understand` (case-insensitive), stop here.

---

## Step 5 — Execute

```bash
npx ccaudit-cli@latest ghost --dangerously-bust-ghosts --yes-proceed-busting
```

The `--yes-proceed-busting` flag skips the interactive terminal prompts inside ccaudit because you already ran the three-stage ceremony above.

---

## Step 6 — Report results

After the bust completes, parse the JSON output (or read the exit code) and report:

- How many agents/skills were archived
- How many MCP servers were disabled
- How many memory files were flagged
- Token savings: before vs. after
- Where the manifest lives (for restore)
- Remind the user: `ccaudit restore` undoes everything

If the bust exits non-zero, surface the error clearly:

| Exit code | Meaning                                       | What to say                                                                            |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1         | Checkpoint missing, invalid, or hash mismatch | "Your inventory changed since the dry-run. Re-run `/ccaudit-bust` from the beginning." |
| 3         | Claude Code is still running                  | "Close all Claude Code windows first, then run this from a separate terminal."         |
| 4         | Non-TTY without bypass                        | Internal error — should not happen with `--yes-proceed-busting`.                       |

---

## Step 7 — Offer a restore path

Always close with:

> "Everything is reversible. To undo:
>
> - Restore all: `npx ccaudit-cli@latest restore`
> - Restore one item: `npx ccaudit-cli@latest restore <name>`
> - See what was archived: `npx ccaudit-cli@latest restore --list`"

---

## Safety rules — never violate these

1. **Never run `--dangerously-bust-ghosts` without completing all three confirmation stages.** If the user asks you to skip confirmations, explain why each stage exists and decline to skip it.

2. **Never skip the dry-run.** The dry-run checkpoint is a mechanical safety gate in ccaudit itself — without it, `--dangerously-bust-ghosts` will exit with an error. But more importantly: it shows the user exactly what will change before any change happens.

3. **Never modify Claude configuration files directly.** All changes must go through ccaudit's own commands. Do not edit `~/.claude.json`, `.mcp.json`, agent files, or memory files yourself.

4. **Do not proceed if Claude Code is running.** If the scan output or bust output mentions that Claude Code processes are detected (exit code 3, status `running-process`), instruct the user to close Claude Code and run this skill from a standalone terminal.

5. **Global ghosts first.** When presenting the plan, lead with `scope: "global"` items — these waste tokens in every single session and have the highest remediation value.

6. **Respect user intent.** Exclusions are handled explicitly in Step 2b and again after Step 3. If the user names an item to exclude at any point — during the urgency scope question, after the plan is presented, or at any stage before Stage 1 confirmation — apply the exclusion immediately, update the candidate list, and confirm what was removed. Never argue about an exclusion. The user knows their workflow.

---

## Example invocation

User: "My Claude setup feels bloated. Can you clean it up?"

You: Run Step 1, present the Step 3 summary, then begin the Step 4 ceremony. Do not run `--dangerously-bust-ghosts` until all three confirmation stages pass.
