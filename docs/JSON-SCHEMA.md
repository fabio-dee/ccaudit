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

| Field            | Type   | Description                                                  |
| ---------------- | ------ | ------------------------------------------------------------ |
| `meta.command`   | string | Subcommand name: `ghost`, `inventory`, `mcp`, or `trend`     |
| `meta.version`   | string | ccaudit version (semver)                                     |
| `meta.since`     | string | Time window as passed to `--since` (e.g., `7d`, `30d`, `2w`) |
| `meta.timestamp` | string | ISO 8601 UTC timestamp of the run                            |
| `meta.exitCode`  | number | Process exit code: `0` = no ghosts, `1` = ghosts found       |

## Payload key by command

| Command     | Payload key | Row shape                                                                        |
| ----------- | ----------- | -------------------------------------------------------------------------------- |
| `ghost`     | `items`     | `{ name, category, tier, invocations, lastUsed, tokenEstimate, recommendation }` |
| `inventory` | `items`     | Same as `ghost` (full inventory, not just ghosts)                                |
| `mcp`       | `items`     | Adds `projectPaths: string[]` for cross-project traceability (see Note below)    |
| `trend`     | `buckets`   | `{ date, bucket, agents, skills, mcp, total }` per D-20                          |

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

---

## `--dangerously-bust-ghosts` JSON envelope

When `--dangerously-bust-ghosts` is run with `--json` (or with `--ci`, which implies `--json --quiet --yes-proceed-busting`), the output is wrapped in the same top-level `meta` envelope as every other command, with the bust-specific payload under the `bust` key:

```json
{
  "meta": {
    "command": "ghost",
    "version": "0.0.1",
    "since": "7d",
    "timestamp": "2026-04-05T18:30:00.000Z",
    "exitCode": 0
  },
  "bust": { "status": "success", "...": "..." }
}
```

The `bust` payload is a **discriminated union keyed by `status`**. There are exactly 10 possible variants; every `BustResult` returned by the orchestrator maps one-to-one to a shape in this document. Automation should `switch` on `bust.status` and handle each case.

### Success variants

**`status: "success"`** — all ops completed cleanly.

```json
{
  "status": "success",
  "manifestPath": "/home/user/.claude/ccaudit/manifests/bust-2026-04-05T18-30-00Z.jsonl",
  "counts": {
    "archive": { "completed": 3, "failed": 0 },
    "disable": { "completed": 1, "failed": 0 },
    "flag":    { "completed": 2, "failed": 0, "refreshed": 0, "skipped": 0 }
  },
  "duration_ms": 145
}
```

**`status: "partial-success"`** — some ops failed but the pipeline completed; inspect `counts.*.failed` and the manifest for details.

```json
{
  "status": "partial-success",
  "manifestPath": "/home/user/.claude/ccaudit/manifests/bust-2026-04-05T18-30-00Z.jsonl",
  "counts": {
    "archive": { "completed": 2, "failed": 1 },
    "disable": { "completed": 1, "failed": 0 },
    "flag":    { "completed": 2, "failed": 1, "refreshed": 0, "skipped": 0 }
  },
  "duration_ms": 145,
  "failed": 2
}
```

### Gate failures

**`status: "checkpoint-missing"`** — no prior `--dry-run` checkpoint at the expected path.

```json
{
  "status": "checkpoint-missing",
  "checkpointPath": "/home/user/.claude/ccaudit/.last-dry-run"
}
```

**`status: "checkpoint-invalid"`** — checkpoint exists but could not be parsed, has an unknown `checkpoint_version`, or is missing a required field.

```json
{
  "status": "checkpoint-invalid",
  "reason": "parse-error: Unexpected token } in JSON at position 142"
}
```

**`status: "hash-mismatch"`** — the current ghost inventory hash differs from the one recorded in the checkpoint (the inventory changed since the dry-run).

```json
{
  "status": "hash-mismatch",
  "expected": "sha256:abc123...",
  "actual":   "sha256:def456..."
}
```

### Preflight failures

**`status: "running-process"`** — a `claude` process was detected on the system, OR ccaudit was spawned from inside a Claude Code session (`selfInvocation: true`).

```json
{
  "status": "running-process",
  "pids": [12345, 67890],
  "selfInvocation": false,
  "message": "Claude Code is running (pids: 12345, 67890). Close all Claude Code windows and re-run ccaudit --dangerously-bust-ghosts."
}
```

When `selfInvocation` is `true`, the user was running ccaudit from inside a Claude Code Bash-tool session (the parent chain of ccaudit's own pid overlaps with the detected pids). The `message` field names the overlapping pid and instructs the user to open a standalone terminal.

**`status: "process-detection-failed"`** — `ps` (Unix) or `tasklist` (Windows) could not be spawned (ENOENT, permission denied, etc). Fail-closed per D-02: if we cannot verify the process table, we refuse rather than proceed.

```json
{
  "status": "process-detection-failed",
  "error": "spawn ps ENOENT"
}
```

### User and config errors

**`status: "user-aborted"`** — the user declined at one of the two confirmation prompts.

```json
{
  "status": "user-aborted",
  "stage": "prompt1"
}
```

`stage` is `"prompt1"` (the initial y/N) or `"prompt2"` (the typed-phrase ceremony).

**`status: "config-parse-error"`** — `~/.claude.json` (or a `.mcp.json`) could not be parsed during the Disable MCP step. Per D-14 this is a fail-fast error — none of that file's rename ops are committed to the manifest.

```json
{
  "status": "config-parse-error",
  "path": "/home/user/.claude.json",
  "error": "Unexpected token } in JSON at position 142"
}
```

**`status: "config-write-error"`** — atomic write of `~/.claude.json` (or the manifest file itself) failed at the rename step.

```json
{
  "status": "config-write-error",
  "path": "/home/user/.claude.json",
  "error": "EPERM: operation not permitted"
}
```

### Exit code mapping

| `bust.status`                 | Process exit code | Rationale                                    |
|-------------------------------|-------------------|----------------------------------------------|
| `success`                     | `0`               | Clean completion                             |
| `user-aborted`                | `0`               | Graceful abort is not a failure              |
| `partial-success`             | `1`               | At least one op failed (D-14)                |
| `checkpoint-missing`          | `1`               | Gate 1 failure                               |
| `checkpoint-invalid`          | `1`               | Gate 1 failure (schema/version)              |
| `hash-mismatch`               | `1`               | Gate 2 failure                               |
| `config-parse-error`          | `1`               | Non-fatal MCP disable error                  |
| `config-write-error`          | `1`               | Non-fatal MCP disable error                  |
| `running-process`             | `3`               | Preflight failure, D-03                      |
| `process-detection-failed`    | `3`               | Preflight failure, D-02 fail-closed          |

**Exit code 2** is reserved for Phase 7 dry-run checkpoint WRITE failures and is never emitted by bust (bust only reads the checkpoint).

**Exit code 4** (non-TTY without `--yes-proceed-busting`) is emitted **before** the bust pipeline runs — so no JSON envelope is produced on stdout for this case. The error message is written to stderr only:

```
ccaudit --dangerously-bust-ghosts requires an interactive terminal.
To run non-interactively, pass --yes-proceed-busting (only if you understand what you are doing).
```

### jq recipes for bust output

```sh
# Exit code without relying on shell $?
ccaudit --dangerously-bust-ghosts --ci | jq '.meta.exitCode'

# Human-readable status
ccaudit --dangerously-bust-ghosts --ci | jq -r '.bust.status'

# Manifest path (only defined on success/partial-success)
ccaudit --dangerously-bust-ghosts --ci | jq -r '.bust.manifestPath // empty'

# Count of failed ops
ccaudit --dangerously-bust-ghosts --ci | jq '.bust.counts // {} | [..] | map(select(type=="object") | .failed // 0) | add'

# Detect running-process self-invocation
ccaudit --dangerously-bust-ghosts --ci | jq 'select(.bust.status=="running-process") | .bust.selfInvocation'
```
