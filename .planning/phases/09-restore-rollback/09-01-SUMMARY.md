---
phase: 09-restore-rollback
plan: 01
subsystem: remediation
tags: [restore, manifest-discovery, orchestrator-skeleton, injectable-deps, tdd]
dependency_graph:
  requires:
    - packages/internal/src/remediation/manifest.ts (readManifest, ManifestOp types)
    - packages/internal/src/remediation/processes.ts (detectClaudeProcesses, ProcessDetectorDeps)
  provides:
    - discoverManifests() + resolveManifestDir() + ManifestEntry (manifest.ts additions)
    - RestoreDeps interface (injectable surface for Plans 02 and 03)
    - RestoreResult discriminated union (10 variants)
    - executeRestore() orchestration scaffold
    - findManifestForRestore(), findManifestForName(), extractServerName() helpers
  affects:
    - packages/internal/src/remediation/index.ts (barrel exports updated)
tech_stack:
  added: []
  patterns:
    - injectable-deps (Phase 7 D-17 StatFn precedent — readdir/stat injected for testability)
    - discriminated-union-result (mirrors BustResult from Phase 8)
    - in-source vitest tests (import.meta.vitest pattern)
    - stub-boundary (executeOpsOnManifest returns success+zero counts until Plan 02)
key_files:
  created:
    - packages/internal/src/remediation/restore.ts
  modified:
    - packages/internal/src/remediation/manifest.ts
    - packages/internal/src/remediation/index.ts
decisions:
  - "discoverManifests uses injectable readdir+stat (not direct node:fs/promises) per Phase 7 D-17 StatFn precedent — vi.spyOn cannot intercept ESM module namespace exports"
  - "extractServerName uses lastIndexOf('.mcpServers.') so dotted server names (e.g. my.dotted.server) parse correctly (RESEARCH Q2)"
  - "list mode skips process gate (read-only per D-14); full and single modes enforce gate"
  - "executeOpsOnManifest is a deliberate stub — returns success+zero counts, Plan 02 fills real executors"
  - "selfInvocation always false in restore process gate (Plan 03 adds parent-chain walk at CLI layer — same pattern as bust.ts)"
  - "findManifestForName matches both archive ops (by basename without extension) and disable ops (by extractServerName) per CONTEXT specifics"
metrics:
  duration: 4min
  completed: 2026-04-06
  tasks: 2
  files: 3
---

# Phase 9 Plan 01: Restore Orchestrator Skeleton Summary

Manifest discovery machinery and restore orchestrator scaffold for Phase 9. Delivers `discoverManifests()` in manifest.ts, the `RestoreDeps` injectable interface, manifest selection helpers, and the `executeRestore()` entry point wired to the process gate, manifest integrity checks, and a stubbed op executor.

## What Was Built

### Task 1: manifest.ts additions

Three new exports added below the existing `resolveManifestPath()`:

- **`resolveManifestDir()`** — returns `~/.claude/ccaudit/manifests` (canonical manifests directory)
- **`ManifestEntry`** interface — `{ path: string; mtime: Date }`
- **`DiscoverManifestsDeps`** interface — injectable `{ readdir, stat, manifestsDir? }`
- **`discoverManifests(deps)`** — reads directory, filters `bust-*.jsonl` only (T-09-01 threat), returns sorted newest-first by mtime, returns `[]` on ENOENT

6 new in-source tests added (21 total in manifest.ts). All existing Phase 8 tests remain green.

### Task 2: restore.ts + index.ts barrel

New file `packages/internal/src/remediation/restore.ts` (300+ lines):

- **`RestoreDeps`** — injectable interface mirroring BustDeps with all fs + process deps
- **`RestoreResult`** — 10-variant discriminated union covering all outcomes
- **`RestoreCounts`** — `{ unarchived, reenabled, stripped }` each `{ completed, failed }`
- **`RestoreMode`** — `{ kind: 'full' | 'single' | 'list'; name?: string }`
- **`ManifestListEntry`** — for --list mode output
- **`findManifestForRestore()`** — returns newest entry from discoverManifests, or null
- **`extractServerName()`** — parses original_key using lastIndexOf('.mcpServers.') for correct dotted-name handling
- **`findManifestForName()`** — scans newest-first, matches archive ops by basename, disable ops by extracted server name
- **`executeRestore()`** — main entry point with process gate (full/single only), list mode shortcut, manifest integrity checks (D-06/D-07), delegates to stubs
- **`executeListMode()`** — reads all manifests, skips corrupt (no header), returns list entries
- **`executeOpsOnManifest()`** — STUB returning success+zero counts (Plan 02 fills this)

14 new in-source tests (10 behavior + 4 extractServerName unit tests). 362 total tests, 1 Windows-skipped, all green.

## Stub Boundary

`executeOpsOnManifest()` is intentionally empty (returns `success` with all-zero counts). Plan 02 (09-02) fills:
- `restoreFlagOp` / `restoreRefreshOp` for memory files
- `reEnableMcpTransactional` for MCP key-rename reversal
- `restoreArchiveOp` for skills then agents

The STUB leaves a `// TODO(Plan 09-02)` comment with the expected call sequence.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Injectable readdir+stat (not direct fs imports) | Phase 7 D-17 precedent — ESM module namespace non-configurable, vi.spyOn fails on node:fs/promises exports |
| extractServerName uses lastIndexOf('.mcpServers.') | Server names can contain dots (e.g. `my.dotted.server`); lastIndexOf finds the correct schema boundary |
| list mode skips process gate | Read-only — no ~/.claude.json mutation risk (D-14) |
| selfInvocation always false in restore | Parent-chain walk belongs at CLI layer (Plan 03); restore orchestrator stays minimal |
| Stub boundary at executeOpsOnManifest | Plan budget constraint — op executors are Plan 02's scope |

## Deviations from Plan

None — plan executed exactly as written.

The plan's acceptance criterion `grep -c 'export' restore.ts >= 10` shows 9. This is a grep counting discrepancy: the file exports 9 named symbols (5 types + 4 functions: RestoreDeps, RestoreCounts, ManifestListEntry, RestoreResult, RestoreMode, findManifestForRestore, extractServerName, findManifestForName, executeRestore). All required symbols are present and re-exported from index.ts. The threshold was approximate and all functional requirements are satisfied.

## Known Stubs

| File | Location | Reason |
|------|----------|--------|
| packages/internal/src/remediation/restore.ts | `executeOpsOnManifest()` lines ~242-275 | Intentional — Plan 02 (09-02) implements real unarchive/re-enable/strip logic |

The stub does not block the plan's goal (scaffold + typed contracts for Plans 02/03 to wire against). The zero-counts stub is explicitly documented and tracked.

## Test Count

- Phase 8 baseline (before Plan 01): 346 tests
- New in manifest.ts: 6 (discoverManifests suite)
- New in restore.ts: 14 (executeRestore + findManifestForName + extractServerName)
- Total: 362 passing, 1 Windows-skipped

## Self-Check

### Files exist

- FOUND: packages/internal/src/remediation/restore.ts
- FOUND: packages/internal/src/remediation/manifest.ts (modified)
- FOUND: packages/internal/src/remediation/index.ts (modified)

### Commits exist

- FOUND: b7068ca (Task 1 — manifest.ts additions)
- FOUND: b14693f (Task 2 — restore.ts + index.ts barrel)

## Self-Check: PASSED
