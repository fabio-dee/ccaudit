---
phase: "09-restore-rollback"
plan: "03"
subsystem: "cli"
tags: ["restore", "gunshi", "cli-command", "output-modes", "exit-codes"]
dependency_graph:
  requires: ["09-01", "09-02"]
  provides: ["ccaudit-restore-command", "restore-cli-surface"]
  affects: ["apps/ccaudit/src/cli/index.ts", "packages/internal/src/index.ts"]
tech_stack:
  added: []
  patterns:
    - "gunshi define() with renderHeader: null per Phase 7 Plan 02 precedent"
    - "buildProductionRestoreDeps() wiring injectable deps to real fs primitives"
    - "exhaustive RestoreResult switch for TypeScript compile-time safety"
    - "colorize.green/colorize.yellow (object API, not callable)"
    - "renderHeader(emoji, title, since) 3-arg signature from packages/terminal"
key_files:
  created:
    - "apps/ccaudit/src/cli/commands/restore.ts"
  modified:
    - "apps/ccaudit/src/cli/index.ts"
    - "packages/internal/src/index.ts"
    - "packages/internal/src/remediation/index.ts"
    - "packages/internal/src/remediation/restore.ts"
    - "packages/internal/src/remediation/atomic-write.ts"
    - "packages/internal/src/remediation/bust.ts"
    - "packages/internal/src/remediation/collisions.ts"
    - "packages/internal/src/remediation/frontmatter.ts"
    - "packages/internal/src/remediation/manifest.ts"
    - "packages/internal/src/remediation/processes.ts"
decisions:
  - "renderHeader takes 3 args (emoji, title, sinceWindow) not 1; used '🔄', 'Restore', ISO timestamp"
  - "colorize is an object ({green, yellow, ...}), not a callable; fixed from plan's colorize(str, 'green') to colorize.green(str)"
  - "packages/internal/src/index.ts required Phase 9 barrel additions; plan assumed they existed but main barrel only had Phase 8 — added executeRestore, discoverManifests, readManifest, extractServerName, removeFrontmatterKeys, setFrontmatterValue + all RestoreResult types"
  - "Worktree required Phase 8/9 remediation source files copied from main repo; committed alongside Task 1 as prerequisite sources"
  - "CSV output emits category-level summary rows (not per-op) — v1.2 limitation documented in code comment"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-06"
  tasks_completed: 2
  files_changed: 11
---

# Phase 9 Plan 03: Restore CLI Command Summary

Wire the Phase 9 restore orchestrator into the CLI: `restoreCommand` gunshi subcommand with `buildProductionRestoreDeps`, full output-mode matrix (rendered/--quiet/--json/--csv), exit-code ladder (0/1/3), `--list` grouped format, and registration in the subCommands map.

## What Was Built

### Task 1: apps/ccaudit/src/cli/commands/restore.ts

New gunshi subcommand (`restoreCommand`) that:

1. **Invocation routing** — dispatches three modes from CLI args:
   - `ccaudit restore` → `{ kind: 'full' }` (most recent manifest)
   - `ccaudit restore <name>` → `{ kind: 'single', name }` via `ctx._[0]`
   - `ccaudit restore --list` → `{ kind: 'list' }` (read-only, skips process gate)

2. **buildProductionRestoreDeps()** — wires all 12 RestoreDeps fields:
   | RestoreDeps field | Production implementation |
   |---|---|
   | `discoverManifests` | `discoverManifests({ readdir, stat })` from `@ccaudit/internal` |
   | `readManifest` | `readManifest(p)` from `@ccaudit/internal` |
   | `processDetector` | `defaultProcessDeps` (ps/tasklist subprocess) |
   | `selfPid` | `process.pid` |
   | `renameFile` | `node:fs/promises rename()` |
   | `mkdirRecursive` | `node:fs/promises mkdir({ recursive: true })` |
   | `readFileBytes` | `node:fs/promises readFile(p)` |
   | `pathExists` | `stat()` in try/catch returning boolean |
   | `removeFrontmatterKeys` | `removeFrontmatterKeys(filePath, keys)` |
   | `setFrontmatterValue` | `setFrontmatterValue(filePath, key, value)` |
   | `readFileUtf8` | `node:fs/promises readFile(p, 'utf8')` |
   | `atomicWriteJson` | `atomicWriteJson(targetPath, value)` |
   | `now` | `() => new Date()` |
   | `onWarning` | captures to `warnings[]` array for --verbose display |

3. **Exit code ladder** (exhaustive switch, TypeScript compile-safe):
   - `0` → success, no-manifests, name-not-found, list
   - `1` → partial-success, manifest-corrupt, config-parse-error, config-write-error
   - `3` → running-process, process-detection-failed
   - `2` → unexpected thrown error (defensive path)

4. **Output mode matrix**:
   - `--json` → `buildJsonEnvelope('restore', 'n/a', exitCode, restoreResultToJson())`
   - `--csv` → header row + category-level summary rows (see CSV limitation below)
   - `--quiet` → TSV: `restore\t<status>\t<unarchived>\t<reenabled>\t<stripped>`
   - rendered → header (`renderHeader('🔄', 'Restore', iso)`) + per-category counts + colorized status line

5. **--list format** (per D-04):
   - Header: `Archived items — N bust(s)`
   - Per-entry: `● <ISO timestamp>  (<clean/partial bust>, N item(s))`
   - Per-op detail lines: `archive` → category + name + archive_path; `disable` → mcp + server + config_path + disabled_key; `flag/refresh` → memory + filename + file_path
   - `skipped` ops omitted (not actionable by restore)

6. **gunshi options**:
   - `toKebab: true` — camelCase keys → kebab-case flags
   - `renderHeader: null` — suppresses decorative banner from structured output modes (Phase 7 Plan 02 precedent)

7. **In-source vitest tests** covering exit-code ladder, quiet rendering, CSV header, and `extractServerName` re-export verification.

### Task 2: apps/ccaudit/src/cli/index.ts

Two-line surgical change:
- Added `import { restoreCommand } from './commands/restore.ts';`
- Added `restore: restoreCommand` to the `subCommands` map (alphabetical order alongside ghost/inventory/mcp/trend)

### packages/internal/src/index.ts

Added Phase 9 barrel re-exports (previously missing from main index, present only in remediation sub-barrel):
- Functions: `executeRestore`, `discoverManifests`, `readManifest`, `extractServerName`, `removeFrontmatterKeys`, `setFrontmatterValue`
- Types: `RestoreDeps`, `RestoreResult`, `RestoreCounts`, `RestoreMode`, `ManifestListEntry`, `ManifestEntry`, `ManifestOp`, `ArchiveOp`, `DisableOp`, `FlagOp`, `RefreshOp`

## Verification Results

```
pnpm -r typecheck     → all 3 packages: PASS
pnpm -F ccaudit build → 389.59 kB dist/index.js: PASS
pnpm -r test run      → 35+10+9 = 54 test files, 396+75+73 = 544 tests: PASS (1 skipped)
node dist/index.js restore --help → shows command + --list flag: PASS
node dist/index.js restore --list → "No bust history found." exit 0: PASS
node dist/index.js --help | grep restore → shows in subcommand list: PASS
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] renderHeader takes 3 args, not 1**
- **Found during:** Task 1 typecheck
- **Issue:** Plan showed `renderHeader(titleString)` but actual signature is `renderHeader(emoji, title, sinceWindow)`. CLI uses `renderHeader('🔄', 'Restore', isoTimestamp)`.
- **Fix:** Corrected call site to 3-arg form
- **Files modified:** `apps/ccaudit/src/cli/commands/restore.ts`
- **Commit:** 533c307

**2. [Rule 1 - Bug] colorize is an object, not a callable function**
- **Found during:** Task 1 typecheck
- **Issue:** Plan showed `colorize(str, 'green')` but actual export is `colorize: { green: fn, yellow: fn, ... }`. Changed to `colorize.green(str)` and `colorize.yellow(str)`.
- **Fix:** Updated call sites to use object property accessors
- **Files modified:** `apps/ccaudit/src/cli/commands/restore.ts`
- **Commit:** 533c307

**3. [Rule 2 - Missing functionality] packages/internal main barrel missing Phase 9 exports**
- **Found during:** Task 1 typecheck
- **Issue:** `packages/internal/src/index.ts` only had Phase 7/8 re-exports; Phase 9 symbols were in `remediation/index.ts` but not surfaced to the main barrel. All `@ccaudit/internal` imports in `restore.ts` failed.
- **Fix:** Added Phase 9 function + type re-exports to `packages/internal/src/index.ts`
- **Files modified:** `packages/internal/src/index.ts`
- **Commit:** 533c307

**4. [Rule 3 - Blocking] Worktree missing Phase 8/9 prerequisite source files**
- **Found during:** Initial setup
- **Issue:** Worktree's working tree and index were at an earlier state (before Phase 8/9 source files were added). `packages/internal/src/remediation/` only had 4 files from Phase 7.
- **Fix:** Copied all Phase 8/9 remediation source files from main repo, committed as part of Task 1 prerequisites.
- **Files modified:** All 7 new remediation source files + bust-command test
- **Commit:** 533c307

## CSV Limitation Note

`renderRestoreCsv()` emits category-level summary rows (3 rows: agents_skills, mcp, memory) rather than per-op rows. This is a documented v1.2 limitation: `executeRestore` returns `RestoreCounts` (completed/failed per category) not per-op details — per-op granularity would require persisting manifest ops in `RestoreResult`, which is out of scope for this plan. The limitation is documented via code comment.

## Known Stubs

None — all output paths render real data from `RestoreResult`. The "No bust history found." message is functional behavior (empty manifest directory), not a stub.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan's threat model already covers (T-09-14 through T-09-19).

## Self-Check: PASSED

- `apps/ccaudit/src/cli/commands/restore.ts` — FOUND
- `apps/ccaudit/src/cli/index.ts` — FOUND (contains `restore: restoreCommand`)
- Commit 533c307 — FOUND (`feat(09-03): create restore CLI command...`)
- Commit 39c89e0 — FOUND (`feat(09-03): register restoreCommand in subCommands map...`)
- `pnpm -r typecheck` — PASSED (3/3 packages)
- `pnpm -r test run` — PASSED (544 tests, 1 skipped)
