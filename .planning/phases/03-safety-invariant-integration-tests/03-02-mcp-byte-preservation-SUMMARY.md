---
phase: 03
plan: 02
subsystem: test-infrastructure
tags: [inv-s1, inv-s4, inv-s5, mcp-byte-preservation, surgical-write, safety-invariants]
dependency_graph:
  requires: [03-01]
  provides: [INV-S1-test, INV-S4-cross-path-test, INV-S5-cross-path-test]
  affects: [03-03, 03-04]
tech_stack:
  added: []
  patterns: [surgical-text-patcher, atomicWriteText, patchMcpConfigText, byte-identity-assertion]
key_files:
  created:
    - apps/ccaudit/src/__tests__/safety-invariants-mcp.test.ts
  modified:
    - packages/internal/src/remediation/atomic-write.ts
    - packages/internal/src/remediation/bust.ts
    - packages/internal/src/remediation/index.ts
    - packages/internal/src/index.ts
    - apps/ccaudit/src/cli/commands/ghost.ts
decisions:
  - "Rule 1 (auto-fix): disableMcpTransactional used atomicWriteJson (JSON.stringify) which reformatted all bytes including unselected server values. Fixed with surgical text patcher (patchMcpConfigText) that preserves byte identity for flat-schema and global-scope mutations."
  - "atomicWriteText added as a required dep to BustDeps; makeDeps test helper updated accordingly. Project-scope mutations still fall back to atomicWriteJson (text surgery for nested paths deferred as out-of-scope for this plan)."
  - "patchMcpConfigText exported from bust.ts for in-source unit testing. It returns null on malformed input, triggering atomicWriteJson fallback."
metrics:
  duration: ~35m
  completed: 2026-04-15T06:19:00Z
  tasks: 1
  files_modified: 6
---

# Phase 03 Plan 02: MCP Byte-Preservation SUMMARY

One-liner: INV-S1 byte-identity test for unselected MCP keys + INV-S4/S5 cross-path equivalence, with surgical text patcher to make the invariant hold in production.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (fix) | Add atomicWriteText + patchMcpConfigText for INV-S1 byte-preservation | b287e70 | 5 files |
| 1 (test) | Add safety-invariants-mcp.test.ts with INV-S1 + INV-S4/S5 tests | 0b2ba30 | 1 file |

## Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `apps/ccaudit/src/__tests__/safety-invariants-mcp.test.ts` | 277 | 3 integration tests: INV-S1 byte-identity, INV-S1 key-rename, INV-S4/S5 cross-path |

## Files Modified

| File | Delta | Change |
|------|-------|--------|
| `packages/internal/src/remediation/atomic-write.ts` | +34 | Add `atomicWriteText` export |
| `packages/internal/src/remediation/bust.ts` | +122 | Add `patchMcpConfigText`, update `BustDeps`, update `disableMcpTransactional`, update `makeDeps` |
| `packages/internal/src/remediation/index.ts` | +1 | Export `atomicWriteText` |
| `packages/internal/src/index.ts` | +1 | Export `atomicWriteText` |
| `apps/ccaudit/src/cli/commands/ghost.ts` | +3 | Import `atomicWriteText`, wire in both BustDeps sites |

## Test Names (3 it() blocks)

1. `serverB key + value + surrounding bytes are byte-identical after subset-bust(serverA)` — INV-S1 byte-identity using `findServerBSlice` inline helper, Buffer-level comparison
2. `serverA key is renamed to ccaudit-disabled:serverA after subset-bust(serverA)` — INV-S1 key-rename assertion with JSON parse of post-bust file
3. `subset bust on serverA produces a manifest with subset selection_filter and subset-accurate freedTokens` — INV-S4/S5 cross-path equivalence checking `selection_filter.mode === 'subset'`, `planned_ops.disable === 1`, `freedTokens > 0 && <= totalPlannedTokens`

## Vitest Results

```
Test Files  97 passed (97)
     Tests  1309 passed | 2 skipped (1311)
```

3 new tests added (INV-S1 × 2, INV-S4/S5 × 1). No regressions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] disableMcpTransactional used atomicWriteJson (full JSON.stringify rewrite)**

- **Found during:** Running Test 1 (INV-S1 byte-identity) — test correctly caught that serverB's `args: ["server-b", "--port", "9999"]` was reformatted to multi-line by JSON.stringify.
- **Issue:** `atomicWriteJson` calls `JSON.stringify(value, null, 2)` which reformats ALL array values in the file, including unselected server content. This violated INV-S1: "unselected MCP server keys are byte-identical post-bust."
- **Fix:** Added `atomicWriteText(targetPath, text)` function to `atomic-write.ts` and `patchMcpConfigText(raw, mutations)` surgical text patcher to `bust.ts`. The patcher:
  1. Finds the named key in the mcpServers block using string search
  2. Walks balanced braces to find the value boundary
  3. Removes key+value+surrounding comma while preserving all other bytes
  4. Appends the new root-level disabled key using `JSON.stringify` for just the value (acceptable since this is new content)
  5. Falls back to `atomicWriteJson` if patching fails (null return) or for project-scope mutations
- **Files modified:** `atomic-write.ts`, `bust.ts`, `remediation/index.ts`, `internal/src/index.ts`, `ghost.ts`
- **Commits:** b287e70 (fix), 0b2ba30 (test)

## Confirmation: No inlined helpers

- `grep -c "FAKE_PS_SCRIPT"` → 0 (no inlined fake-ps script)
- `grep -c "from './_test-helpers.ts'"` → 1 (single import covers all helpers)
- All fake-ps and spawn logic comes from `_test-helpers.ts` (Plan 01 contract)

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The `patchMcpConfigText` function reads and writes the same `~/.claude.json` path that `disableMcpTransactional` already mutated. No new trust boundaries created.

## Self-Check: PASSED

- [x] `apps/ccaudit/src/__tests__/safety-invariants-mcp.test.ts` exists (277 lines, 3 it() blocks)
- [x] Commit b287e70 exists (implementation fix)
- [x] Commit 0b2ba30 exists (test file)
- [x] All 1309 tests pass (97 files)
- [x] No hard-coded home paths in test file (grep returns 0)
- [x] Single `_test-helpers.ts` import (grep returns 1)
- [x] `readMcpConfigBytes` used ≥2 times (grep returns 4)
- [x] `ccaudit-disabled:serverA` asserted ≥1 time (grep returns 5)
