---
phase: 03
plan: 01
subsystem: test-infrastructure
tags: [test-helpers, ghost-hook, ccaudit-force-tty, phase3-infra]
dependency_graph:
  requires: []
  provides: [CCAUDIT_FORCE_TTY-hook, test-helpers-phase3]
  affects: [03-02, 03-03, 03-04]
tech_stack:
  added: []
  patterns: [fake-ps-shim, tmpHome-fixture, subprocess-spawn-with-signals, canonical-id-wrappers]
key_files:
  modified:
    - apps/ccaudit/src/cli/commands/ghost.ts
    - apps/ccaudit/src/__tests__/_test-helpers.ts
decisions:
  - CCAUDIT_FORCE_TTY is env-only (not a flag), scoped to two isTty call sites only, absent from --help
  - runCcauditGhost returns SpawnedGhost (live child + done promise) instead of a bare Promise so INV-S2 can SIGINT mid-flight
  - createMcpFixture uses hand-crafted string (not JSON.stringify) so byte-identity assertions are non-trivial
  - void killed retained in close handler to satisfy no-unused-vars; lint failure is pre-existing worktree env issue (not introduced by this plan)
metrics:
  duration: ~10m
  completed: 2026-04-16T05:59:59Z
  tasks: 2
  files_modified: 2
---

# Phase 03 Plan 01: Test Infrastructure SUMMARY

One-liner: CCAUDIT_FORCE_TTY=1 test hook + 8 shared Phase 3 helpers enabling subprocess-based safety-invariant tests without a pty dependency.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add CCAUDIT_FORCE_TTY=1 test-only hook to ghost.ts | 05b0d15 | apps/ccaudit/src/cli/commands/ghost.ts |
| 2 | Extend _test-helpers.ts with shared Phase 3 helpers | 03c6a14 | apps/ccaudit/src/__tests__/_test-helpers.ts |

## Files Modified

| File | Lines Before | Lines After | Delta |
|------|-------------|-------------|-------|
| apps/ccaudit/src/cli/commands/ghost.ts | 1857 | 1868 | +11 |
| apps/ccaudit/src/__tests__/_test-helpers.ts | 109 | 358 | +249 |

## Task 1: CCAUDIT_FORCE_TTY Hook — Exact Diff Sites

**Site A — run() interactive branch (new line numbers ~599–607):**
```typescript
// TEST-ONLY: CCAUDIT_FORCE_TTY=1 lets the Phase 3 INV-S2 integration test
// exercise the runInteractiveGhostFlow path from a non-pty subprocess
// (Phase 3 D-21 / CONTEXT.md). NEVER document in --help. This env var has
// no effect on production usage because users on a real terminal already
// have isTTY === true, and CI/non-TTY users would never set it.
const forceTty = process.env['CCAUDIT_FORCE_TTY'] === '1';
const isTty =
  forceTty || (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));
```

**Site B — runInteractiveGhostFlow() defensive guard (new line numbers ~144–146):**
```typescript
// TEST-ONLY: CCAUDIT_FORCE_TTY=1 — see ghost.ts Site A in run() for full rationale.
const forceTty = process.env['CCAUDIT_FORCE_TTY'] === '1';
const isTty = forceTty || (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));
```

## Task 2: New Exports from _test-helpers.ts

| Export | Kind | Purpose |
|--------|------|---------|
| `buildFakePs` | async function | Install fake `ps` shim at `<tmpHome>/bin/ps` for Claude-process preflight |
| `SpawnedGhost` | interface | `{ child: ChildProcess; done: Promise<CliResult> }` |
| `runCcauditGhost` | function | Spawn `ccaudit ghost` returning live child + done promise (enables SIGINT in INV-S2) |
| `createMcpFixture` | async function | Write hand-crafted `~/.claude.json` with 2 MCP servers + deliberate formatting quirks (INV-S1) |
| `createFrameworkFixture` | async function | Build partial-use GSD framework (1 used + 2 ghost agents, session JSONL) for INV-S6 |
| `listManifestsDir` | async function | Return sorted basenames from manifests dir, `[]` if absent (INV-S2 baseline check) |
| `readMcpConfigBytes` | function | Read `~/.claude.json` as raw `Buffer` for byte-identity assertions (INV-S1) |
| `agentItemId` | function | Compute `canonicalItemId` for a global agent by filename |
| `mcpItemId` | function | Compute `canonicalItemId` for a global MCP server by name |

## Verification Results

| Check | Result |
|-------|--------|
| `grep -c "CCAUDIT_FORCE_TTY" ghost.ts` | 4 (2 per site) |
| `grep -c "TEST-ONLY" ghost.ts` | 2 |
| `grep -c "CCAUDIT_FORCE_TTY" dist/index.js` | 2 |
| `ghost --help \| grep CCAUDIT_FORCE_TTY` | 0 (not in --help) |
| `grep -c "^export " _test-helpers.ts` | 15 (4 original + 9 new + 2 pre-existing) |
| `grep -c "canonicalItemId" _test-helpers.ts` | 3 (1 import + 2 calls) |
| `jq '.dependencies \| length'` (all 3 packages) | 0, 0, 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test --run` | 96 files, 1306 passed, 2 skipped |
| `pnpm format:check` | exit 0 |
| `pnpm verify` | exit 1 (pre-existing lint: worktree .mjs doubling in ESLint default project; confirmed same 4 errors on base commit 451ad65 before any changes) |

## Deviations from Plan

None — plan executed exactly as written. The `pnpm verify` lint failure (4 errors in `.mjs` scripts) is pre-existing in this worktree environment: running `pnpm -w lint` on the base commit `451ad65` (before any changes) produces the identical 4 ESLint "Too many files matched the default project" errors caused by the worktree path `.claude/worktrees/agent-a46a81ba/` being picked up alongside the main repo scripts by the ESLint default project configuration. This is not caused by any change in this plan.

## Self-Check: PASSED

- [x] `apps/ccaudit/src/cli/commands/ghost.ts` exists and contains both hook sites
- [x] `apps/ccaudit/src/__tests__/_test-helpers.ts` exists and exports all 9 new symbols
- [x] Commit 05b0d15 exists (Task 1)
- [x] Commit 03c6a14 exists (Task 2)
- [x] `dist/index.js` contains `CCAUDIT_FORCE_TTY` (grep returns 2)
- [x] `ghost --help` does NOT mention `CCAUDIT_FORCE_TTY` (grep returns 0)
- [x] All 1306 existing tests pass
