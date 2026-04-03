---
phase: 01-foundation-scaffold
plan: 01
subsystem: infra
tags: [pnpm, monorepo, typescript, vitest, tsdown, eslint, oxfmt, catalogs]

# Dependency graph
requires: []
provides:
  - pnpm monorepo workspace with strict catalog mode
  - Root TypeScript, ESLint, oxfmt, vitest configs
  - apps/ccaudit package skeleton with zero-dep invariant
  - packages/internal with shared GhostItem, ClaudePaths types
  - packages/terminal stub with TERMINAL_VERSION export
  - In-source vitest test infrastructure
affects: [01-02, 02-session-parser, 03-inventory-scanner, 04-mcp-live, 05-report-cli]

# Tech tracking
tech-stack:
  added: [typescript@6.0.2, pnpm@10.33.0, vitest@4.1.2, tsdown@0.21.7, eslint@10.1.0, oxfmt@0.43.0, typescript-eslint@8.58.0, gunshi@0.29.3, valibot@1.3.1, cli-table3@0.6.5, tinyglobby@0.2.15, '@praha/byethrow@0.10.1', picocolors@1.1.1, clean-pkg-json@1.4.1]
  patterns: [zero-dep bundle, pnpm strict catalogs, in-source vitest testing, publishConfig dual bin]

key-files:
  created:
    - pnpm-workspace.yaml
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - eslint.config.ts
    - .oxfmtrc.jsonc
    - apps/ccaudit/package.json
    - apps/ccaudit/tsconfig.json
    - apps/ccaudit/vitest.config.ts
    - apps/ccaudit/tsdown.config.ts
    - packages/internal/package.json
    - packages/internal/tsconfig.json
    - packages/internal/vitest.config.ts
    - packages/internal/src/types.ts
    - packages/internal/src/index.ts
    - packages/terminal/package.json
    - packages/terminal/tsconfig.json
    - packages/terminal/vitest.config.ts
    - packages/terminal/src/index.ts
  modified: []

key-decisions:
  - "passWithNoTests added to apps/ccaudit vitest config to prevent failure when no src files exist yet"
  - "All devDependencies use catalog: protocol -- zero bare version strings in any package.json"
  - "Top-level define in tsdown config for import.meta.vitest stripping (not inputOptions.define)"

patterns-established:
  - "Zero-dep invariant: apps/ccaudit has NO dependencies field, only devDependencies"
  - "Catalog-strict: all version management through pnpm-workspace.yaml catalog section"
  - "In-source testing: vitest tests colocated in source files via import.meta.vitest blocks"
  - "publishConfig dual bin: source bin points to .ts, published bin points to dist .js"
  - "Workspace internal packages: @ccaudit/internal and @ccaudit/terminal with workspace:* references"

requirements-completed: [DIST-02, DIST-03, DIST-04, DIST-05]

# Metrics
duration: 3min
completed: 2026-04-03
---

# Phase 01 Plan 01: Foundation Scaffold Summary

**pnpm monorepo with strict catalogs, zero-dep CLI skeleton, shared GhostItem types, and vitest in-source test infrastructure**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-03T20:33:02Z
- **Completed:** 2026-04-03T20:36:12Z
- **Tasks:** 2
- **Files modified:** 23 (19 created in Task 1, 4 in Task 2)

## Accomplishments
- pnpm monorepo with 4 workspace packages, strict catalog mode, and supply-chain security (strictDepBuilds, blockExoticSubdeps)
- Root configs: TypeScript (ES2022/NodeNext), ESLint 10 flat config, oxfmt, vitest workspace orchestrator
- apps/ccaudit with zero runtime dependencies, tsdown bundler config (publint, DCE, test stripping), publishConfig dual bin
- Shared types in @ccaudit/internal: GhostItem, ClaudePaths, ItemScope, GhostTier, ItemCategory, ConfidenceTier, Recommendation
- In-source vitest tests passing: 3 tests in packages/internal, 1 test in packages/terminal

## Task Commits

Each task was committed atomically:

1. **Task 1: Create monorepo workspace, root configs, and all package skeletons** - `3ab706c` (chore)
2. **Task 2: Create shared types, barrel exports, and in-source tests** - `e19b789` (feat)

## Files Created/Modified
- `pnpm-workspace.yaml` - Workspace definition with strict catalogs and security hardening
- `package.json` - Root monorepo config with engines, packageManager, preinstall guard
- `tsconfig.json` - Root TypeScript config with vitest/importMeta types
- `vitest.config.ts` - Root vitest workspace orchestrator (projects pattern)
- `eslint.config.ts` - ESLint 10 flat config with typescript-eslint
- `.oxfmtrc.jsonc` - oxfmt formatter config (singleQuote, trailingComma)
- `apps/ccaudit/package.json` - CLI package with zero deps, publishConfig, prepack
- `apps/ccaudit/tsconfig.json` - Extends root, references internal/terminal packages
- `apps/ccaudit/vitest.config.ts` - In-source test config with passWithNoTests
- `apps/ccaudit/tsdown.config.ts` - Bundler config with publint, DCE, test stripping
- `apps/ccaudit-mcp/.gitkeep` - Future MCP server app placeholder
- `packages/internal/package.json` - @ccaudit/internal shared types package
- `packages/internal/tsconfig.json` - Extends root TypeScript config
- `packages/internal/vitest.config.ts` - In-source test config
- `packages/internal/src/types.ts` - GhostItem, ClaudePaths, ItemScope, GhostTier, ItemCategory, ConfidenceTier, Recommendation
- `packages/internal/src/index.ts` - Barrel re-export of all types
- `packages/terminal/package.json` - @ccaudit/terminal table rendering package
- `packages/terminal/tsconfig.json` - Extends root TypeScript config
- `packages/terminal/vitest.config.ts` - In-source test config
- `packages/terminal/src/index.ts` - TERMINAL_VERSION stub with in-source test
- `docs/.gitkeep` - VitePress docs placeholder
- `pnpm-lock.yaml` - Generated lockfile

## Decisions Made
- Added `passWithNoTests: true` to `apps/ccaudit/vitest.config.ts` because vitest exits with code 1 when no source files exist yet (apps/ccaudit has no `src/` until Plan 02 creates the CLI entry point)
- All other config values followed the plan verbatim -- no deviations from specified content

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added passWithNoTests to apps/ccaudit vitest config**
- **Found during:** Task 2 (running `pnpm -r test` verification)
- **Issue:** vitest exits with code 1 when no test files are found in apps/ccaudit (which has no src/ files yet)
- **Fix:** Added `passWithNoTests: true` to `apps/ccaudit/vitest.config.ts`
- **Files modified:** `apps/ccaudit/vitest.config.ts`
- **Verification:** `pnpm -r test` exits with code 0 across all packages
- **Committed in:** `e19b789` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for `pnpm -r test` to pass. No scope creep.

## Known Stubs

- `packages/terminal/src/index.ts` line 4: `TERMINAL_VERSION = '0.0.1'` -- intentional stub, implementation in Phase 5 (Report & CLI Commands)

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Monorepo structure complete: `pnpm install`, `pnpm -r typecheck`, `pnpm -r test` all pass
- Plan 02 (CLI entry point and gunshi routing) can now create `apps/ccaudit/src/index.ts` and wire the command router
- Shared types available via `@ccaudit/internal` for all downstream phases
- Build pipeline (tsdown) configured and ready for first bundle in Plan 02

## Self-Check: PASSED

- All 21 created files verified present on disk
- Commit `3ab706c` (Task 1) verified in git log
- Commit `e19b789` (Task 2) verified in git log

---
*Phase: 01-foundation-scaffold*
*Completed: 2026-04-03*
