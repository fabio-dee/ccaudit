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
    "version": "0.0.1",
    "since": "7d",
    "timestamp": "2026-04-05T10:30:00.000Z",
    "exitCode": 1
  },
  "items": [ ... ]
}
```

| Field            | Type     | Description                                                         |
|------------------|----------|---------------------------------------------------------------------|
| `meta.command`   | string   | Subcommand name: `ghost`, `inventory`, `mcp`, or `trend`            |
| `meta.version`   | string   | ccaudit version (semver)                                            |
| `meta.since`     | string   | Time window as passed to `--since` (e.g., `7d`, `30d`, `2w`)        |
| `meta.timestamp` | string   | ISO 8601 UTC timestamp of the run                                   |
| `meta.exitCode`  | number   | Process exit code: `0` = no ghosts, `1` = ghosts found              |

## Payload key by command

| Command     | Payload key | Row shape                                                                              |
|-------------|-------------|----------------------------------------------------------------------------------------|
| `ghost`     | `items`     | `{ name, category, tier, invocations, lastUsed, tokenEstimate, recommendation }`       |
| `inventory` | `items`     | Same as `ghost` (full inventory, not just ghosts)                                      |
| `mcp`       | `items`     | Adds `projectPaths: string[]` for cross-project traceability (see Note below)          |
| `trend`     | `buckets`   | `{ date, bucket, agents, skills, mcp, total }` per D-20                                |

**Note on `mcp.items[].projectPaths`:** the MCP scanner emits one entry per
`(projectPath, serverName)` pair for Phase 8 remediation traceability. The `mcp`
command aggregates by server name for presentation, exposing the original per-project
list as `projectPaths: string[]`. A server declared globally returns `projectPaths: []`.

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
```

## Full example: `ccaudit ghost --json`

```json
{
  "meta": {
    "command": "ghost",
    "version": "0.0.1",
    "since": "7d",
    "timestamp": "2026-04-05T10:30:00.000Z",
    "exitCode": 1
  },
  "window": "7d",
  "files": 463,
  "projects": 30,
  "inventory": 208,
  "ghosts": { "definite": 180, "likely": 16, "total": 196 },
  "healthScore": { "score": 11, "grade": "Critical", "ghostPenalty": 80, "tokenPenalty": 9 },
  "totalOverhead": { "tokens": 180000, "percentOf200k": 90 },
  "items": [
    {
      "name": "example-agent",
      "category": "agent",
      "tier": "definite-ghost",
      "invocations": 0,
      "lastUsed": null,
      "tokenEstimate": { "tokens": 1200, "confidence": "estimated", "source": "file-size" },
      "recommendation": "archive"
    }
  ]
}
```
