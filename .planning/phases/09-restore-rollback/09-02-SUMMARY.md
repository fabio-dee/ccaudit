---
phase: 09-restore-rollback
plan: "02"
subsystem: packages/internal
tags: [restore, frontmatter, mcp, archive, tdd]
dependency_graph:
  requires: [09-01]
  provides: [restoreArchiveOp, reEnableMcpTransactional, restoreFlagOp, restoreRefreshOp, removeFrontmatterKeys, setFrontmatterValue, FrontmatterRemoveResult]
  affects: [packages/internal/src/remediation/frontmatter.ts, packages/internal/src/remediation/restore.ts, packages/internal/src/remediation/index.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, dependency injection, discriminated union, dual-schema JSON mutation, continue-on-error, fail-fast transactional]
key_files:
  created: []
  modified:
    - packages/internal/src/remediation/frontmatter.ts
    - packages/internal/src/remediation/restore.ts
    - packages/internal/src/remediation/index.ts
decisions:
  - "parseFlatFrontmatter shared helper extracted from patchFrontmatter logic — single source of truth for exotic-yaml detection, BOM handling, and line-ending detection"
  - "FrontmatterRemoveResult discriminated union covers all 5 outcomes: removed, updated, no-frontmatter, keys-not-found, skipped (with 4 sub-reasons)"
  - "Q4 empty-block handling: entire --- block removed when all remaining body lines are blank/comment-only after key removal"
  - "reEnableMcpTransactional uses CURRENT value at new_key (not op.original_value) per D-09 — preserves user edits between bust and restore"
  - "D-15 hybrid failure policy: fs ops (archive/flag/refresh) continue-on-error within category; MCP ops fail-fast per config file (returns config-parse-error or config-write-error on failure)"
  - "Locked execution order in executeOpsOnManifest: refresh → flag → MCP → skills → agents (reversed bust order per RESEARCH Section 8)"
  - "restoreFlagOp treats no-frontmatter and keys-not-found as completed (idempotent — user may have already removed keys manually)"
  - "makeFakeDeps frontmatter stubs updated to return proper FrontmatterRemoveResult (void return was type-incorrect after RestoreDeps tightening)"
metrics:
  duration: "13 minutes"
  completed: "2026-04-06T06:09:30Z"
  tasks: 2
  files: 3
---

# Phase 9 Plan 02: Restore Op Executors Summary

Implement every restore operation executor that Plan 01's stubs punted on. Adds `removeFrontmatterKeys()` and `setFrontmatterValue()` to `frontmatter.ts`, four executors to `restore.ts`, and wires `executeOpsOnManifest` with the locked execution order and hybrid failure policy.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add removeFrontmatterKeys, setFrontmatterValue, FrontmatterRemoveResult | 73dc368 | frontmatter.ts, index.ts |
| 2 | Implement restoreArchiveOp, reEnableMcpTransactional, restoreFlagOp, restoreRefreshOp, wire executeOpsOnManifest | 6106ee4 | restore.ts, index.ts |

## Execution Order Implemented

```
executeOpsOnManifest locked order (RESEARCH Section 8):
  1. RefreshOp   → restoreRefreshOp  (setFrontmatterValue: restore previous ccaudit-flagged timestamp, D-11)
  2. FlagOp      → restoreFlagOp     (removeFrontmatterKeys: strip ccaudit-stale + ccaudit-flagged, D-10)
  3. DisableOp[] → reEnableMcpTransactional (grouped by config_path, fail-fast per file, D-09, D-15)
  4. ArchiveOp (skill) → restoreArchiveOp (category=skill, D-08, D-13, Q1)
  5. ArchiveOp (agent) → restoreArchiveOp (category=agent, D-08, D-13, Q1)
```

## Hybrid Failure Policy Outcomes

| Condition | Outcome |
|-----------|---------|
| All ops succeed | `status: 'success'` with full counts |
| Some fs ops fail (archive/flag/refresh) | `status: 'partial-success'`, counts.*.failed > 0, other ops continue |
| MCP config file cannot be read/parsed | `status: 'config-parse-error'` — entire executeOpsOnManifest returns early |
| MCP atomic write fails | `status: 'config-write-error'` — entire executeOpsOnManifest returns early |
| source_path already occupied (Q1) | archive op counts as failed, warning emitted, next archive continues |
| SHA256 mismatch (D-13) | warning emitted, rename proceeds, counts as completed |

## Q1 / Q4 Edge Case Decisions

**Q1 (source_path occupied):** `restoreArchiveOp` calls `deps.pathExists(op.source_path)` first. If it returns true, emits a warning like "already exists at {path} — skipping (restore manually if needed)" and returns `'failed'`. Does NOT overwrite.

**Q4 (empty frontmatter block after key removal):** `removeFrontmatterKeys` checks if all remaining body lines after key removal are blank or comment-only. If so, drops the entire `---\n...\n---\n` block and appends the trailing body directly (with leading blank lines stripped). If any content key remains, keeps the block with only the non-removed keys.

## parseFlatFrontmatter Helper

Extracted as a private helper shared by `removeFrontmatterKeys` and `setFrontmatterValue`:

```typescript
interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  openLineIdx: number;      // always 0 when hasFrontmatter
  closeLineIdx: number;     // index of closing --- (-1 if unterminated)
  bodyLines: string[];      // lines between the fences
  trailingLines: string[];  // everything after closing ---
  lineEnding: '\n' | '\r\n';
  hasBom: boolean;
  exotic: boolean;          // true if any exotic construct detected
}
```

Exotic detection logic is copied verbatim from `patchFrontmatter` (same EXOTIC_INDENT / EXOTIC_FOLDED_SCALAR / EXOTIC_ARRAY_ITEM / FLAT_KV regexes). An unterminated block (no closing `---`) is classified as exotic.

## Deltas from Plan 01 Stub Signatures

- `RestoreDeps.removeFrontmatterKeys` return type tightened: `Promise<unknown>` → `Promise<FrontmatterRemoveResult>`
- `RestoreDeps.setFrontmatterValue` return type tightened: `Promise<unknown>` → `Promise<FrontmatterRemoveResult>`
- `makeFakeDeps` stubs updated: `async () => {}` → proper `FrontmatterRemoveResult` values for both functions

## Test Counts

| Suite | Tests |
|-------|-------|
| frontmatter.ts (existing patchFrontmatter) | 12 |
| frontmatter.ts (new removeFrontmatterKeys + setFrontmatterValue) | 12 |
| restore.ts (Plan 01 scaffold) | 14 |
| restore.ts (Plan 02 executor tests 1-22) | 22 |
| **Full @ccaudit/internal package** | **396 pass, 1 skip** |

## Deviations from Plan

None — plan executed exactly as written. The `makeFakeDeps` stub type fix was a direct consequence of tightening `RestoreDeps` types (required by the plan's action step) and resolved by the typecheck error.

## Self-Check

### Files Exist

- [x] `packages/internal/src/remediation/frontmatter.ts` — modified with new exports
- [x] `packages/internal/src/remediation/restore.ts` — modified with executors
- [x] `packages/internal/src/remediation/index.ts` — updated barrel exports

### Commits Exist

- [x] 73dc368 — Task 1 (frontmatter.ts + index.ts)
- [x] 6106ee4 — Task 2 (restore.ts + index.ts)

## Self-Check: PASSED
