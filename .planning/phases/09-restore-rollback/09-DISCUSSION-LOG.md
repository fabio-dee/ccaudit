# Phase 9: Restore & Rollback - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the discussion.

**Date:** 2026-04-05
**Phase:** 09-restore-rollback
**Mode:** discuss

## Gray Areas Presented

### Partial bust handling
| Question | Options | User Choice |
|----------|---------|-------------|
| When bust crashed (header, no footer), what should restore do? | Warn + auto-proceed / Warn + ask first / Refuse | **Warn + auto-proceed** |

### `--list` scope
| Question | Options | User Choice |
|----------|---------|-------------|
| ccaudit restore --list scope? | All busts grouped / Most recent bust only | **All busts, grouped** (confirmed from preview) |

### Tamper detection
| Question | Options | User Choice |
|----------|---------|-------------|
| archive file sha256 mismatch: what to do? | Warn + proceed / Warn + ask per item / Warn + skip | **Warn + proceed** |

### `restore <name>` collision
| Question | Options | User Choice |
|----------|---------|-------------|
| Same name in multiple busts: which to restore? | Most recent / All matching / Error + show list | **Most recent version** |

## Decisions Confirmed as Claude's Discretion

- Running-process gate on restore: **Yes** — same rationale as bust (concurrent `~/.claude.json` writes)
- `refresh` op restore: **Restore previous timestamp** (`ccaudit-flagged: <previous_flagged_at>`)
- Output modes: **Honor all Phase 6 modes** (--json, --quiet, --no-color, --verbose, --ci)
- `<name>` identifier: **Base filename without extension** (handoff doc confirms `ccaudit restore code-reviewer`)
- No confirmation ceremony: **Correct** — restore is recovery, not destructive
- `restore <name>` scope: **Extends to MCP server names** (not just agents/skills)
- Restore execution order: **Reverse of bust** (strip flags → re-enable MCP → unarchive)

## Corrections Made

No corrections — all recommended options accepted.

## Prior Decisions Applied (no re-asking)

- Manifest format (readManifest, op schemas): locked by Phase 8 D-09/D-10/D-11/D-12
- Hybrid failure policy: locked by Phase 8 D-14
- atomicWriteJson reuse: locked by Phase 8 D-18
- Partial bust crash-detection rule (header+footer): locked by Phase 8 D-12
- Archive path format (ISO suffix collisions): locked by Phase 8 D-05/D-06
