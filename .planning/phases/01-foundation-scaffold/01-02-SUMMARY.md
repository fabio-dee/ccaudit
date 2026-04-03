---
phase: 01-foundation-scaffold
plan: 02
subsystem: infra
tags: [gunshi, cli, tsdown, shebang, github-actions, ci]

# Dependency graph
requires:
  - phase: 01-01
    provides: pnpm monorepo, tsdown config, package.json with bin/publishConfig, @ccaudit/internal types
provides:
  - Working CLI binary (apps/ccaudit/dist/index.js) with gunshi routing
  - Ghost stub command with --since and --json args
  - Shebang-enabled entry point for npx distribution
  - GitHub Actions CI pipeline (lint, typecheck, test, build)
affects: [02-session-parser, 03-inventory-scanner, 05-report-cli]

# Tech tracking
tech-stack:
  added: []
  patterns: [gunshi define+cli pattern, source-file shebang preserved by tsdown, outputOptions.entryFileNames for .js extension]

key-files:
  created:
    - apps/ccaudit/src/index.ts
    - apps/ccaudit/src/cli/index.ts
    - apps/ccaudit/src/cli/commands/ghost.ts
    - .github/workflows/ci.yaml
  modified:
    - apps/ccaudit/tsdown.config.ts
    - apps/ccaudit/tsconfig.json
    - packages/internal/tsconfig.json
    - packages/terminal/tsconfig.json

key-decisions:
  - "Removed unused:true and publint:true from tsdown.config.ts -- both require uninstalled optional deps (unplugin-unused, publint) that were not in the pnpm catalog"
  - "Added outputOptions.entryFileNames '[name].js' to force .js extension instead of default .mjs for ESM"
  - "Added allowImportingTsExtensions + noEmit + node types to apps/ccaudit tsconfig for .ts import path support"
  - "Added composite:true to packages/internal and packages/terminal tsconfig.json for TypeScript project references"
  - "Hardcoded version '0.0.1' in CLI router -- Phase 6 will switch to reading from package.json"

patterns-established:
  - "gunshi CLI pattern: define() for commands, cli() for router with name/version/description/subCommands"
  - "Source-file shebang: #!/usr/bin/env node as first line of src/index.ts, tsdown preserves it in output"
  - "CI pipeline pattern: 4 jobs (lint, typecheck, test, build) with build gated on the other three"

requirements-completed: [DIST-01, DIST-02, DIST-03, DIST-04, DIST-05]

# Metrics
duration: 3min
completed: 2026-04-03
---

# Phase 01 Plan 02: CLI Entry Point & CI Pipeline Summary

**gunshi CLI skeleton with ghost stub command, tsdown-built shebang binary, and GitHub Actions CI pipeline verifying all Phase 1 success criteria**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-03T20:38:25Z
- **Completed:** 2026-04-03T20:41:55Z
- **Tasks:** 2
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments
- Working CLI binary: `node apps/ccaudit/dist/index.js --help` prints usage with "ccaudit v0.0.1" name and version
- Shebang `#!/usr/bin/env node` preserved in built dist/index.js (first line), enabling `npx` distribution
- Production bundle (64KB) has zero `import.meta.vitest` references -- in-source tests fully stripped
- GitHub Actions CI with 4 jobs: lint (eslint+oxfmt), typecheck (tsc), test (vitest), build (tsdown + binary verification)
- All 5 Phase 1 DIST requirements verified passing locally (DIST-01 through DIST-05)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create CLI entry point, gunshi router, and ghost stub command** - `378a7cb` (feat)
2. **Task 2: Create CI pipeline and verify zero-dep invariant** - `25b00de` (chore)

## Files Created/Modified
- `apps/ccaudit/src/index.ts` - CLI entry point with `#!/usr/bin/env node` shebang
- `apps/ccaudit/src/cli/index.ts` - gunshi command router with name/version/description
- `apps/ccaudit/src/cli/commands/ghost.ts` - Default ghost stub command with --since and --json args
- `.github/workflows/ci.yaml` - CI pipeline: lint, typecheck, test, build (gated) with binary verification
- `apps/ccaudit/tsdown.config.ts` - Fixed: removed unused/publint, added outputOptions for .js extension
- `apps/ccaudit/tsconfig.json` - Fixed: added allowImportingTsExtensions, noEmit, node types
- `packages/internal/tsconfig.json` - Fixed: added composite:true for project references
- `packages/terminal/tsconfig.json` - Fixed: added composite:true for project references

## Decisions Made
- Removed `unused: true` from tsdown.config.ts because it requires `unplugin-unused` which was not installed or in the pnpm catalog (pre-existing gap from Plan 01)
- Removed `publint: true` from tsdown.config.ts because it requires the `publint` package which was not installed or in the catalog (pre-existing gap from Plan 01)
- Added `outputOptions: { entryFileNames: '[name].js' }` to force `.js` extension since tsdown defaults to `.mjs` for ESM format, but `publishConfig.bin` points to `./dist/index.js`
- Added `allowImportingTsExtensions: true` and `noEmit: true` to apps/ccaudit tsconfig because the plan specifies `.ts` extensions in import paths (e.g., `from './cli/index.ts'`) which `NodeNext` module resolution requires this flag for
- Added `composite: true` to both packages/internal and packages/terminal tsconfig.json because apps/ccaudit tsconfig has `references` to them (TypeScript requires referenced projects to have composite enabled)
- Hardcoded version `'0.0.1'` in the CLI router as specified in the plan -- dynamic version reading deferred to Phase 6

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused:true from tsdown.config.ts**
- **Found during:** Task 1 (building CLI)
- **Issue:** `unused: true` requires `unplugin-unused` package which is not installed and not in pnpm catalog
- **Fix:** Removed the `unused` option from tsdown config
- **Files modified:** `apps/ccaudit/tsdown.config.ts`
- **Verification:** Build succeeds
- **Committed in:** `378a7cb` (Task 1 commit)

**2. [Rule 3 - Blocking] Removed publint:true from tsdown.config.ts**
- **Found during:** Task 1 (building CLI)
- **Issue:** `publint: true` requires the `publint` package which is not installed
- **Fix:** Removed the `publint` option from tsdown config
- **Files modified:** `apps/ccaudit/tsdown.config.ts`
- **Verification:** Build completes without post-build validation error
- **Committed in:** `378a7cb` (Task 1 commit)

**3. [Rule 3 - Blocking] Added outputOptions.entryFileNames for .js extension**
- **Found during:** Task 1 (building CLI)
- **Issue:** tsdown outputs `.mjs` for ESM format by default, but `publishConfig.bin` expects `./dist/index.js`
- **Fix:** Added `outputOptions: { entryFileNames: '[name].js' }` to tsdown config
- **Files modified:** `apps/ccaudit/tsdown.config.ts`
- **Verification:** Build outputs `dist/index.js` (not `.mjs`)
- **Committed in:** `378a7cb` (Task 1 commit)

**4. [Rule 3 - Blocking] Fixed TypeScript config for .ts import paths and project references**
- **Found during:** Task 1 (typechecking CLI)
- **Issue:** `tsc --noEmit` failed with TS5097 (`.ts` extension requires `allowImportingTsExtensions`), TS2591 (`process` not found), and TS6306 (referenced projects missing `composite: true`)
- **Fix:** Added `allowImportingTsExtensions`, `noEmit`, and `types: ["vitest/importMeta", "node"]` to apps/ccaudit/tsconfig.json; added `composite: true` to packages/internal and packages/terminal tsconfig.json
- **Files modified:** `apps/ccaudit/tsconfig.json`, `packages/internal/tsconfig.json`, `packages/terminal/tsconfig.json`
- **Verification:** `pnpm --filter ccaudit typecheck` exits 0
- **Committed in:** `378a7cb` (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (4 blocking)
**Impact on plan:** All fixes necessary for build and typecheck to succeed. Pre-existing config gaps from Plan 01 (missing optional deps, missing composite flag). No scope creep.

## Known Stubs

- `apps/ccaudit/src/cli/commands/ghost.ts` line 21: `console.log('ccaudit ghost: not yet implemented')` -- intentional stub command for Phase 1 scaffold; actual ghost detection implementation in Phase 5

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CLI skeleton complete: `node dist/index.js --help` works, gunshi routes to ghost command
- All Phase 1 success criteria verified: shebang, zero deps, tests stripped, engines field, CI exists
- Phase 2 (session-parser) can now import from `@ccaudit/internal` and add parsing logic
- Ghost command is wired and ready to be replaced with real implementation in Phase 5
- CI pipeline will automatically validate lint, typecheck, test, and build on all pushes

## Self-Check: PASSED

- All 8 created/modified files verified present on disk
- Commit `378a7cb` (Task 1) verified in git log
- Commit `25b00de` (Task 2) verified in git log

---
*Phase: 01-foundation-scaffold*
*Completed: 2026-04-03*
