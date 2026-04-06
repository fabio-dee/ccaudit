# Code Study: who-ran-what — Detection Logic for `wr clean`

## Executive Summary

**who-ran-what** is a Bash-based analytics dashboard for tracking Claude Code agent, skill, and tool usage. The `wr clean` command identifies unused agents and skills that haven't been invoked within a configurable time window (default: **30 days**). The tool parses Claude Code session logs (JSONL format) stored in `~/.claude/projects/` and cross-references them against hardcoded agent lists and discovered skills from project configurations.

---

## 1. `wr clean` Command — Detection Logic

### Entry Point
**File**: `bin/who-ran-what` (lines 122, 90)

The `clean` command is routed through the main dispatcher:
```bash
"clean"|...)
    source "$LIB_DIR/commands/stats.sh"
    handle_stats_command "$@"
```

### Command Handler
**File**: `lib/who-ran-what/commands/stats.sh` (lines 67-77)

```bash
"clean")
    if [[ "$JSON_OUTPUT" == "true" ]]; then
        generate_unused_json "month"
    else
        show_dashboard_header "month"
        echo ""
        show_unused "month"
        echo ""
        dim "Unused agents/skills are not used in the past 30 days"
    fi
    ;;
```

**Key observations:**
- Hardcoded to use `"month"` period (30 days)
- Calls `show_unused "month"` for text display
- Calls `generate_unused_json "month"` for JSON output

### Display Function
**File**: `lib/who-ran-what/core/display.sh` (lines 102-132)

```bash
show_unused() {
    local period="${1:-month}"
    local unused_agents unused_skills
    unused_agents=$(find_unused_agents "$period" 2>/dev/null)
    unused_skills=$(find_unused_skills "$period" 2>/dev/null)

    if [[ -n "$unused_agents" ]]; then
        echo -e "  ${YELLOW}Unused Agents:${RESET}"
        echo "$unused_agents" | head -5 | while read -r agent; do
            [[ -n "$agent" ]] && echo -e "    └── ${DIM}$agent${RESET}"
        done
    fi
    # ... similar for skills
}
```

---

## 2. Core Detection Functions

### Finding Unused Agents
**File**: `lib/who-ran-what/core/claude-parser.sh` (lines 298-319)

```bash
find_unused_agents() {
    local period="${1:-month}"
    # Hardcoded list of 16 built-in agents
    local all_agents="Explore Plan general-purpose code-reviewer test-engineer quality-engineer security-auditor backend-architect git-specialist full-stack-architect frontend-developer api-documenter devops-engineer database-optimizer cloud-architect deployment-engineer"

    local used_agents
    used_agents=$(count_agents "$period" | awk '{print $2}' | tr '\n' ' ')

    for agent in $all_agents; do
        if [[ ! " $used_agents " =~ [[:space:]]${agent}[[:space:]] ]]; then
            echo "$agent"
        fi
    done
}
```

**Critical limitation**: Agents are NOT discovered from disk — they use a hardcoded list of 16 built-in agents. Cannot detect custom agents in `~/.claude/agents/`.

### Finding Unused Skills
**File**: `lib/who-ran-what/core/claude-parser.sh` (lines 321-346)

```bash
find_unused_skills() {
    local period="${1:-month}"
    local project_root="${2:-$(pwd)}"
    local configured_skills=""
    if [[ -d "$project_root/.claude/commands" ]]; then
        configured_skills=$(find "$project_root/.claude/commands" -name "*.md" -exec basename {} .md \; 2>/dev/null | tr '\n' ' ')
    fi

    local used_skills
    used_skills=$(count_skills "$period" | awk '{print $2}' | tr '\n' ' ')

    for skill in $configured_skills; do
        if [[ ! " $used_skills " =~ [[:space:]]${skill}[[:space:]] ]]; then
            echo "$skill"
        fi
    done
}
```

**Skill discovery**: `$project_root/.claude/commands/*.md` — project-scoped only, does NOT search `~/.claude/commands/` for global skills.

---

## 3. Time Window Handling

**File**: `lib/who-ran-what/core/claude-parser.sh` (lines 9-20)

```bash
get_filter_date() {
    local period="$1"
    case "$period" in
        "today")      date +%Y-%m-%d ;;
        "week")       calculate_date_offset 7 ;;
        "month")      calculate_date_offset 30 ;;
        "last_week")  calculate_date_offset 14 ;;
        "last_month") calculate_date_offset 60 ;;
        *)            echo "" ;;  # "all" or invalid
    esac
}
```

For `clean` command: hardcoded to "month" (30 days). Not user-configurable.

Cross-platform date calculation (`lib/who-ran-what/utils/detect.sh`, lines 5-17):
```bash
calculate_date_offset() {
    local days="$1"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        date -v"-${days}d" +%Y-%m-%d
    else
        date -d "$days days ago" +%Y-%m-%d
    fi
}
```

Session file discovery uses `find -newermt` for date filtering (`claude-parser.sh`, lines 78-92).

---

## 4. Cross-Reference: JSONL with Installed Inventory

### Counting Used Agents
**File**: `lib/who-ran-what/core/claude-parser.sh` (lines 175-191)

```bash
count_agents() {
    local period="${1:-all}"
    find_session_files "$period" | \
    xargs -0 -P 4 grep -h '"name":"Task"' 2>/dev/null | \
    grep -o '"subagent_type":"[^"]*"' | \
    cut -d'"' -f4 | \
    sort | uniq -c | sort -rn
}
```

### Counting Used Skills
**File**: `lib/who-ran-what/core/claude-parser.sh` (lines 193-209)

```bash
count_skills() {
    local period="${1:-all}"
    find_session_files "$period" | \
    xargs -0 -P 4 grep -h '"name":"Skill"' 2>/dev/null | \
    grep -o '"skill":"[^"]*"' | \
    cut -d'"' -f4 | \
    sort | uniq -c | sort -rn
}
```

**Matching algorithm**: grep for `"name":"Task"` or `"name":"Skill"`, extract `subagent_type`/`skill` field, count uniques. Name matching is exact — no fuzzy matching or normalization.

---

## 5. False Positive Handling — Allowlists

### Configuration
**File**: `lib/who-ran-what/utils/config.sh` (lines 14-19, 100-140)

Config paths searched:
- `~/.who-ran-what.yml`
- `~/.who-ran-what.yaml`
- `~/.config/who-ran-what/config.yml`
- `~/.config/who-ran-what/config.yaml`

Functions `is_agent_ignored()` and `is_skill_ignored()` exist but are **NEVER CALLED** by `find_unused_agents()` or `find_unused_skills()`. This is a feature gap — the allowlist infrastructure is built but not wired up.

**No confirmation prompts** — the tool only displays information, never prompts for action.

---

## 6. Architecture Overview

| Aspect | Details |
|--------|---------|
| **Language** | Bash 3.2+ |
| **CLI Framework** | Manual command routing (no external framework) |
| **External Deps** | jq (optional, falls back to grep) |
| **Version** | 0.2.2 |
| **Data Source** | `~/.claude/projects/**/*.jsonl` |
| **Parallel Processing** | `xargs -P 4` for JSONL scanning |

### Directory Structure
```
who-ran-what/
├── bin/who-ran-what              # Main entry point
├── lib/who-ran-what/
│   ├── core/
│   │   ├── claude-parser.sh      # Main parsing logic (367 lines)
│   │   ├── display.sh            # Terminal UI (496 lines)
│   │   ├── json-output.sh        # JSON serialization (389 lines)
│   │   ├── codex-parser.sh       # Codex CLI parser
│   │   ├── gemini-parser.sh      # Gemini CLI parser
│   │   └── opencode-parser.sh    # OpenCode parser
│   ├── commands/
│   │   ├── stats.sh              # Stats command handler
│   │   └── project.sh            # Project command handler
│   └── utils/
│       ├── colors.sh, config.sh, detect.sh, errors.sh
├── tests/
└── config.example.yml
```

---

## 7. JSON Output Format for `clean`

**File**: `lib/who-ran-what/core/json-output.sh` (lines 235-252)

```json
{
  "period": "month",
  "timestamp": "2026-04-03T21:52:00Z",
  "unused": {
    "agents": ["deployment-engineer", "database-optimizer"],
    "skills": ["old-skill"]
  }
}
```

---

## 8. Key Limitations (ccaudit must improve on these)

1. **Hardcoded agent list** — Cannot detect custom agents in `~/.claude/agents/`
2. **Project-scoped skills only** — Misses global skills in `~/.claude/commands/`
3. **No MCP detection** — Completely ignores MCP server usage/ghosts
4. **No memory file detection** — Doesn't analyze CLAUDE.md or memory files
5. **Allowlist feature incomplete** — Functions exist but are never called
6. **No "likely" vs "definite" tiers** — Binary used/unused only
7. **No lastUsed date** — Reports unused items but not when they were last seen
8. **30-day window hardcoded** — Not user-configurable for `clean`
9. **No token waste estimation** — Doesn't quantify the cost of ghost inventory
10. **File modification time** — Uses `find -newermt` which checks mtime, not content timestamps

---

## 9. Patterns ccaudit Should Adopt

- **Set-difference algorithm** is correct: (installed inventory) - (used in JSONL) = ghosts
- **Parallel JSONL scanning** with `xargs -P` (we'll use async Node streams instead)
- **JSON output mode** for CI integration
- **Cross-platform date handling** (macOS vs Linux)

## 10. Patterns ccaudit Should Avoid

- Hardcoded agent lists — discover from filesystem
- Project-only scope — scan global + project inventory
- Unfinished allowlist — ship it wired up or don't ship it
- Binary used/unused — use lastUsed dates + confidence tiers
