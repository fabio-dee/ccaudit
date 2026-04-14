# ccaudit JSON Output Schema

All `ccaudit` read commands support structured JSON output via the `--json` flag
(and the `--ci` convenience alias, which implies `--json --quiet`). This document
describes the canonical envelope shape and is the source of truth for scripts
and CI integrations that consume ccaudit output.

> **Naming convention:** field names are **camelCase** to match TypeScript internals
> and the `gh` CLI precedent. This is frozen as Phase 6 D-16 and will not change
> in v1.x. A future v2 may add a `--json-snake-case` compatibility flag if demand
> materializes.

## Envelope

Every command wraps its payload in a standard `meta` envelope:

```json
{
  "meta": {
    "command": "ghost",
    "version": "1.4.0",
    "since": "7d",
    "timestamp": "2026-04-13T10:30:00.000Z",
    "exitCode": 1,
    "mcpRegime": "eager",
    "toolSearchOverhead": 0,
    "hooksAggregated": false
  },
  "items": [ ... ]
}
```

| Field                     | Type                              | Description                                                                |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `meta.command`            | string                            | Subcommand name: `ghost`, `inventory`, `mcp`, or `trend`                   |
| `meta.version`            | string                            | ccaudit version (semver)                                                   |
| `meta.since`              | string                            | Time window as passed to `--since` (e.g., `7d`, `30d`, `2w`)               |
| `meta.timestamp`          | string                            | ISO 8601 UTC timestamp of the run                                          |
| `meta.exitCode`           | number                            | Process exit code: `0` = no ghosts, `1` = ghosts found                     |
| `meta.mcpRegime`          | `'eager' \| 'deferred' \| 'auto'` | MCP loading regime detected or overridden via `--regime`                   |
| `meta.toolSearchOverhead` | number                            | Tokens added by ToolSearch in deferred regime; `0` in eager mode           |
| `meta.hooksAggregated`    | boolean                           | `true` when `--include-hooks` is set and hook costs are in the grand total |

## Payload key by command

| Command     | Payload key | Row shape                                                                                                        |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `ghost`     | `items`     | `{ name, category, tier, invocations, lastUsed, tokenEstimate, recommendation, urgencyScore, daysSinceLastUse }` |
| `inventory` | `items`     | Same as `ghost` (full inventory, not just ghosts)                                                                |
| `mcp`       | `items`     | Adds `projectPaths: string[]` for cross-project traceability (see Note below)                                    |
| `trend`     | `buckets`   | `{ date, bucket, agents, skills, mcp, total }` per D-20                                                          |

### Remediation command shapes

Bust, restore, and reclaim emit a `counts` object rather than an `items` array.

**`bust`** → `counts.archive: { agents, skills, failed }`

> Note: reshaped from `{ completed, failed }` in v1.4.x. The manifest footer retains `{ completed, failed }` internally for backward compatibility, but the `--json` envelope now uses the split counters.

```json
"counts": {
  "archive":  { "agents": 116, "skills": 74, "failed": 0 },
  "disable":  { "completed": 4, "failed": 0 },
  "flag":     { "completed": 6, "refreshed": 0, "failed": 0 }
}
```

**`restore`** → `counts.unarchived: { moved, alreadyAtSource, failed }`

> Note: `counts.unarchived.completed` from v1.4.x is replaced by `moved` and `alreadyAtSource`. **Breaking change** for automation that consumed the old field.

```json
"counts": {
  "unarchived": { "moved": 159, "alreadyAtSource": 324, "failed": 0 },
  "reenabled":  { "completed": 4, "failed": 0 },
  "stripped":   { "completed": 6, "failed": 0 }
}
```

**`reclaim`** → `counts.reclaim: { orphansDetected, reclaimed, skipped, failed }`

```json
"counts": {
  "reclaim": { "orphansDetected": 12, "reclaimed": 10, "skipped": 2, "failed": 0 }
}
```

> `skipped` = files whose inferred source path already existed (safety invariant: never overwritten).

## Item categories

The `category` field on each item is one of:

| Value        | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `agent`      | Sub-agent defined in `~/.claude/agents/` or project `.claude/agents/`                             |
| `skill`      | Slash-command skill in `~/.claude/skills/` or `.claude/skills/`                                   |
| `mcp-server` | MCP server declared in `~/.claude.json` or project `.mcp.json`                                    |
| `memory`     | CLAUDE.md or `@`-imported memory file; auto-memory files from project slug dirs                   |
| `command`    | Slash command in `~/.claude/commands/` or `.claude/commands/` (added in v1.4.0)                   |
| `hook`       | `PreToolUse` / `PostToolUse` / `SessionStart` hook from `.claude/settings.json` (added in v1.4.0) |

## `totalOverhead` fields

The `totalOverhead` object on `ghost` and `inventory` responses includes:

| Field             | Type   | Description                                                                             |
| ----------------- | ------ | --------------------------------------------------------------------------------------- |
| `tokens`          | number | Grand total ghost token overhead. Excludes hooks unless `--include-hooks` is set.       |
| `hooksUpperBound` | number | Sum of hook upper-bound tokens, surfaced as advisory when `hooksAggregated` is `false`. |

### Per-item fields: `urgencyScore` and `daysSinceLastUse`

| Field              | Type           | Description                                                                                          |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| `urgencyScore`     | number (0–100) | Composite score for LLM autonomous decision-making. Higher = more urgent to remediate.               |
| `daysSinceLastUse` | number \| null | Integer days since last invocation, pre-computed. `null` if never used. Eliminates ISO 8601 parsing. |

**urgencyScore formula:**

```
urgencyScore = round(recencySignal * 0.70 + tokenSignal * 0.20 + confidenceBoost * 0.10)

recencySignal   = min(daysSinceLastUse ?? 90, 90) / 90 * 100
tokenSignal     = min(tokenEstimate.tokens ?? 0, 5000) / 5000 * 100
confidenceBoost = measured → 100 | community-reported → 66 | estimated → 33
```

### Per-item fields for new categories (v1.4.0)

| Field           | Type            | Categories | Description                                                                                 |
| --------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `hookEvent`     | string \| null  | `hook`     | Hook event name, e.g. `PostToolUse`, `SessionStart`, `PreToolUse`.                          |
| `injectCapable` | boolean \| null | `hook`     | `true` when the hook can inject output into model context. Drives the upper-bound estimate. |
| `importDepth`   | number \| null  | `memory`   | `0` = root CLAUDE.md; `1+` = file imported via `@`-directive. `null` for non-memory items.  |
| `importRoot`    | string \| null  | `memory`   | Absolute path to the root CLAUDE.md that imported this file. `null` for root memory items.  |

**Note on `mcp.items[].projectPaths`:** the MCP scanner emits one entry per
`(projectPath, serverName)` pair for Phase 8 remediation traceability. The `mcp`
command aggregates by server name for presentation, exposing the original per-project
list as `projectPaths: string[]`. A server declared globally returns `projectPaths: []`.

## Formula tags

Each `tokenEstimate` object includes a `source` string that identifies the formula used:

| `source` value                             | Formula / rationale                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `skill:lazy (desc=N chars)`                | `15 + ceil(N / 4)`, capped at 250 chars (only name+description enter startup index)    |
| `agent:eager-with-desc (desc=N chars)`     | `30 + ceil(N / 4)`, no cap (full description enters Task tool schema)                  |
| `mcp:eager (N tools)`                      | Measured per-server from real session logs in eager regime                             |
| `mcp:deferred`                             | Single ToolSearch overhead applied once; per-server costs collapse                     |
| `memory:resolved(depth=N, files=M)`        | File-size heuristic with `@`-import chain resolved to M files at depth N               |
| `memory:file-size`                         | Raw `file_size_bytes / 4` (no imports resolved or frontmatter absent)                  |
| `memory:auto (capped at 25KB)`             | Auto-memory from `~/.claude/projects/<slug>/memory/MEMORY.md`, capped at 6,250 tokens  |
| `command:frontmatter (desc=N chars)`       | `min(60 + N / 4, 90)` — description parsed from frontmatter                            |
| `command:file-size`                        | `file_size_bytes / 4` fallback when frontmatter is absent                              |
| `hook output upper-bound (never observed)` | `2500` tokens — pessimistic upper-bound for inject-capable hooks with no measured data |
| `hook:measured`                            | Observed token count from session logs                                                 |
| `hook config not in model context`         | `0` tokens — hook config does not enter model context (non-inject-capable)             |

## History audit trail

Every ccaudit invocation is appended to `~/.claude/ccaudit/history.jsonl`. The file is JSONL: one JSON object per line. The first line of a new file is a header; every subsequent line is an entry.

Opt-out: `CCAUDIT_NO_HISTORY=1` (checked before any filesystem work).

### Header (written once per file)

```json
{
  "record_type": "header",
  "history_version": 1,
  "ccaudit_version": "1.4.0",
  "created_at": "2026-04-13T08:00:00.000Z",
  "host_os": "darwin",
  "node_version": "v22.0.0"
}
```

| Field             | Type   | Description                                             |
| ----------------- | ------ | ------------------------------------------------------- |
| `record_type`     | string | Always `"header"`                                       |
| `history_version` | number | Schema version — always `1`. Readers must refuse `> 1`. |
| `ccaudit_version` | string | ccaudit semver that created this file                   |
| `created_at`      | string | ISO 8601 UTC timestamp of file creation                 |
| `host_os`         | string | `os.platform()` value, e.g. `"darwin"`, `"linux"`       |
| `node_version`    | string | `process.version`, e.g. `"v22.0.0"`                     |

### Entry (one per invocation)

```json
{
  "record_type": "entry",
  "ts": "2026-04-13T08:19:58.000Z",
  "argv": ["--dry-run"],
  "command": "dry-run",
  "exit_code": 0,
  "duration_ms": 412,
  "cwd": "/home/user/project",
  "privacy_redacted": false,
  "result": {
    "planned_archive": 146,
    "planned_disable": 4,
    "planned_flag": 6,
    "checkpoint_hash": "abc123"
  },
  "errors": []
}
```

| Field              | Type           | Description                                                                     |
| ------------------ | -------------- | ------------------------------------------------------------------------------- |
| `record_type`      | string         | Always `"entry"`                                                                |
| `ts`               | string         | ISO 8601 UTC timestamp of invocation start                                      |
| `argv`             | string[]       | Raw `process.argv.slice(2)` passed by the user                                  |
| `command`          | string         | Normalized command name: `ghost`, `bust`, `dry-run`, `restore`, `reclaim`, etc. |
| `exit_code`        | number         | Process exit code                                                               |
| `duration_ms`      | number         | Wall-clock duration in milliseconds                                             |
| `cwd`              | string         | Working directory at invocation time (redacted when `--privacy` is active)      |
| `privacy_redacted` | boolean        | `true` when `--privacy` was active and path fields are synthetic                |
| `result`           | object \| null | Per-command structured result (see shapes below); `null` for list-only commands |
| `errors`           | string[]       | Non-fatal errors recorded during execution                                      |

### Per-command `result` shapes

| Command   | `result` shape                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghost`   | `{ totals: Record<string,number>, top_ghosts: string[] }`                                                                                                  |
| `dry-run` | `{ planned_archive, planned_disable, planned_flag, checkpoint_hash }`                                                                                      |
| `bust`    | `{ before_tokens, after_tokens, freed_tokens, archived_agents, archived_skills, disabled_mcp, flagged_memory, manifest_ref, health_before, health_after }` |
| `restore` | `{ moved, already_at_source, failed, manifests_consumed: string[] }`                                                                                       |
| `reclaim` | `{ orphans_detected, reclaimed, skipped, failed }` — `skipped` = source-exists safety invariant                                                            |

> Note: `result` field names in history.jsonl use **snake_case** (matching the JSONL convention). The `--json` envelope for read commands uses **camelCase** per the naming convention documented at the top of this file.

Privacy redaction: when `--privacy` is active, `cwd` is replaced with a `~/`-relative synthetic path and any path-shaped strings within `result` are replaced using the same project-path redaction map applied to screen output.

## jq examples

```sh
# Count ghosts
ccaudit ghost --json | jq '.items | length'

# Get the exit code from JSON (alternative to shell $?)
ccaudit ghost --json | jq '.meta.exitCode'

# ISO timestamp of the run
ccaudit ghost --json | jq '.meta.timestamp'

# All definite-ghost MCP servers
ccaudit mcp --json | jq '.items[] | select(.tier == "definite-ghost") | .name'

# Trend data as CSV via jq
ccaudit trend --json | jq -r '.buckets[] | [.date, .total] | @csv'

# Get top 5 items by urgency score
ccaudit ghost --json | jq '[.items[] | select(.urgencyScore >= 70)] | sort_by(-.urgencyScore) | .[0:5]'

# Check MCP regime and ToolSearch overhead
ccaudit ghost --json | jq '{regime: .meta.mcpRegime, overhead: .meta.toolSearchOverhead}'

# See hook advisory cost without including it in the total
ccaudit ghost --json | jq '{hooksAggregated: .meta.hooksAggregated, hooksUpperBound: .totalOverhead.hooksUpperBound}'

# All memory items with their import depth
ccaudit ghost --json | jq '[.items[] | select(.category == "memory") | {name, importDepth, importRoot}]'

# Unique categories present in a run
ccaudit ghost --json | jq '[.items[].category] | unique'
```

## Full example: `ccaudit ghost --json`

```json
{
  "meta": {
    "command": "ghost",
    "version": "1.4.0",
    "since": "7d",
    "timestamp": "2026-04-13T10:30:00.000Z",
    "exitCode": 1,
    "mcpRegime": "eager",
    "toolSearchOverhead": 0,
    "hooksAggregated": false
  },
  "window": "7d",
  "files": 463,
  "projects": 30,
  "inventory": 208,
  "ghosts": { "definite": 180, "likely": 16, "total": 196 },
  "healthScore": {
    "score": 20,
    "grade": "Poor",
    "ghostPenalty": 60,
    "tokenPenalty": 20,
    "dormantPenalty": 1
  },
  "totalOverhead": { "tokens": 63722, "hooksUpperBound": 17500 },
  "items": [
    {
      "name": "example-agent",
      "category": "agent",
      "tier": "definite-ghost",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": {
        "tokens": 64,
        "confidence": "estimated",
        "source": "agent:eager-with-desc (desc=135 chars)"
      },
      "recommendation": "archive",
      "urgencyScore": 74,
      "daysSinceLastUse": null
    },
    {
      "name": "my-skill",
      "category": "skill",
      "tier": "definite-ghost",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": {
        "tokens": 78,
        "confidence": "estimated",
        "source": "skill:lazy (desc=250 chars)"
      },
      "recommendation": "archive",
      "urgencyScore": 71,
      "daysSinceLastUse": null
    },
    {
      "name": "CLAUDE.md",
      "category": "memory",
      "tier": "definite-ghost",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": {
        "tokens": 26272,
        "confidence": "estimated",
        "source": "memory:resolved(depth=1, files=9)"
      },
      "recommendation": "archive",
      "urgencyScore": 82,
      "daysSinceLastUse": null,
      "importDepth": 0,
      "importRoot": null
    },
    {
      "name": "my-command",
      "category": "command",
      "tier": "definite-ghost",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": {
        "tokens": 39,
        "confidence": "estimated",
        "source": "command:frontmatter (desc=93 chars)"
      },
      "recommendation": "archive",
      "urgencyScore": 70,
      "daysSinceLastUse": null
    },
    {
      "name": "PostToolUse:Bash|Edit|Write:abc12345",
      "category": "hook",
      "tier": "dormant",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": {
        "tokens": 2500,
        "confidence": "estimated",
        "source": "hook output upper-bound (never observed)"
      },
      "recommendation": "monitor",
      "urgencyScore": 60,
      "daysSinceLastUse": null,
      "hookEvent": "PostToolUse",
      "injectCapable": true
    }
  ]
}
```
