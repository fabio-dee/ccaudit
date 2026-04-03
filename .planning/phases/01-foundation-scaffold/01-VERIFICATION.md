---
phase: 01-foundation-scaffold
verified: 2026-04-03T20:47:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 1: Foundation & Scaffold Verification Report

**Phase Goal:** Developer can run `npx ccaudit --help` from a working monorepo with build pipeline, tests, and CI -- the zero-dep invariant holds from day one
**Verified:** 2026-04-03T20:47:00Z
**Status:** passed
**Re-verification:** No -- initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| #  | Truth | Status | Evidence |
|----|-------|--------|---------|
| 1  | `npx ccaudit --help` executes and prints usage (binary has shebang, runs without error) | VERIFIED | `node dist/index.js --help` prints "ccaudit v0.0.1" usage block; `head -1 dist/index.js` = `#!/usr/bin/env node` |
| 2  | `npm pack --dry-run` shows zero runtime `dependencies` in the published package | VERIFIED | `npm pack --dry-run` output contains no `"dependencies"` field; only 3 files in pack: `dist/index.js`, `package.json`, `src/index.ts` |
| 3  | Monorepo structure exists: `apps/ccaudit/`, `packages/internal/`, `packages/terminal/`, `docs/` -- pnpm workspaces resolve correctly | VERIFIED | All workspace packages confirmed on disk; `pnpm -r test` and `pnpm -r typecheck` resolve cross-package references correctly |
| 4  | CI pipeline runs lint, typecheck, test, and build on every push | VERIFIED | `.github/workflows/ci.yaml` defines 4 jobs: lint, typecheck, test, build; build job uses `needs: [lint, typecheck, test]` |
| 5  | `engines` field in package.json declares Node.js >=20.x | VERIFIED | `apps/ccaudit/package.json` and root `package.json` both declare `"node": ">=20.0.0"` |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `pnpm-workspace.yaml` | Workspace definition with catalogs and security | VERIFIED | Contains `catalogMode: strict`, `strictDepBuilds: true`, `blockExoticSubdeps: true`, `gunshi: ^0.29.3` |
| `package.json` (root) | Root monorepo config with engines and scripts | VERIFIED | Contains `engines`, `packageManager: pnpm@10.33.0`, `preinstall: npx only-allow pnpm` |
| `tsconfig.json` (root) | Root TypeScript config with vitest types | VERIFIED | Contains `"types": ["vitest/importMeta"]`, target ES2022, module NodeNext |
| `apps/ccaudit/package.json` | CLI package with zero dependencies, publishConfig bin | VERIFIED | Has `publishConfig.bin` pointing to `./dist/index.js`; no `dependencies` field; all deps use `catalog:` protocol |
| `packages/internal/src/types.ts` | Shared type definitions with in-source test | VERIFIED | Contains `GhostItem`, `ClaudePaths`, `ItemScope`, `GhostTier`, and `if (import.meta.vitest)` block |
| `apps/ccaudit/src/index.ts` | CLI entry point with shebang | VERIFIED | First line is `#!/usr/bin/env node`; imports `run` from `./cli/index.ts` |
| `apps/ccaudit/src/cli/index.ts` | gunshi command router | VERIFIED | Contains `cli(` call with `name: 'ccaudit'`, `version: '0.0.1'`, subCommands wired |
| `apps/ccaudit/src/cli/commands/ghost.ts` | Default ghost stub command | VERIFIED | Contains `export const ghostCommand` using `define()` from gunshi |
| `.github/workflows/ci.yaml` | CI pipeline for lint, typecheck, test, build | VERIFIED | All 4 jobs defined; build job contains `pnpm -r build`, `node apps/ccaudit/dist/index.js --help`, shebang check, vitest strip check |
| `apps/ccaudit/tsdown.config.ts` | Bundler config with test stripping | VERIFIED | Contains `'import.meta.vitest': 'undefined'` in `define`; `outputOptions.entryFileNames: '[name].js'` for correct extension; `publint` and `unused` removed (requires uninstalled optional deps -- acceptable deviation) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `apps/ccaudit/package.json` | `pnpm-workspace.yaml` | `catalog:` protocol references | WIRED | All devDependencies use `catalog:` -- no bare version strings found in any workspace package.json |
| `apps/ccaudit/tsconfig.json` | `tsconfig.json` (root) | `extends: "../../tsconfig.json"` | WIRED | Confirmed present; also adds `allowImportingTsExtensions`, `noEmit`, `types: ["vitest/importMeta", "node"]` |
| `packages/internal/src/index.ts` | `packages/internal/src/types.ts` | barrel re-export | WIRED | `export type { ItemScope, GhostTier, ... } from './types.ts'` |
| `apps/ccaudit/src/index.ts` | `apps/ccaudit/src/cli/index.ts` | `import { run }` | WIRED | `import { run } from './cli/index.ts'` |
| `apps/ccaudit/src/cli/index.ts` | `apps/ccaudit/src/cli/commands/ghost.ts` | `import ghostCommand` | WIRED | `import { ghostCommand } from './commands/ghost.ts'` |
| `apps/ccaudit/dist/index.js` | shebang | first line | WIRED | `head -1` confirms `#!/usr/bin/env node` preserved by tsdown in production build |

---

### Data-Flow Trace (Level 4)

Not applicable to Phase 1 artifacts. This phase produces CLI infrastructure (configs, build pipeline, type definitions, routing skeleton), not components that render dynamic data from a database or API. No data flow to trace at this stage.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `--help` prints usage with "ccaudit" name | `node apps/ccaudit/dist/index.js --help` | "Audit Claude Code ghost inventory — agents, skills, MCP servers, and memory files (ccaudit v0.0.1)" | PASS |
| Shebang preserved in built binary | `head -1 apps/ccaudit/dist/index.js` | `#!/usr/bin/env node` | PASS |
| In-source test code stripped from bundle | `grep -c 'import.meta.vitest' dist/index.js` | `0` | PASS |
| Zero runtime deps in pack output | `cd apps/ccaudit && npm pack --dry-run` | No `"dependencies"` in output; 3 files only (dist/index.js, package.json, src/index.ts) | PASS |
| Tests pass across all packages | `pnpm -r test` | 4 tests pass (3 in packages/internal, 1 in packages/terminal) | PASS |
| TypeScript compiles cleanly | `pnpm -r typecheck` | Exit 0 across packages/internal, packages/terminal, apps/ccaudit | PASS |

**Side note on npm pack behavior:** Running `npm pack --dry-run` triggered the `prepack` script which ran `clean-pkg-json`, mutating `apps/ccaudit/package.json` on disk (stripping `scripts` and `devDependencies`). This is expected `clean-pkg-json` behavior -- it prepares the file for publication in-place. The git-tracked version is intact. The file was restored via `git checkout` during verification. This is a workflow concern (the prepack lifecycle runs even on `--dry-run`) but not a bug in the code.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| DIST-01 | 01-02-PLAN | Tool executes via `npx ccaudit@latest` with zero pre-installation | SATISFIED | `node dist/index.js --help` exits 0; shebang enables `npx` execution; `publishConfig.bin` points to `dist/index.js` for distribution |
| DIST-02 | 01-01-PLAN, 01-02-PLAN | All runtime deps bundled at build time; published package has zero runtime `dependencies` | SATISFIED | No `dependencies` field in `apps/ccaudit/package.json`; all deps in `devDependencies` using `catalog:` protocol; `npm pack --dry-run` confirms no runtime deps |
| DIST-03 | 01-01-PLAN, 01-02-PLAN | Dual path support: XDG and legacy paths resolved automatically | PARTIAL (FOUNDATION ONLY) | `ClaudePaths` interface with `xdg` and `legacy` fields defined and exported from `@ccaudit/internal`. Actual runtime path resolution is NOT implemented in Phase 1 -- this is deferred to Phase 2 (session discovery). The foundation type is present; the behavior is not. This is an appropriate Phase 1 scope. |
| DIST-04 | 01-01-PLAN, 01-02-PLAN | Malformed JSONL silently skipped -- tool never throws on corrupt session data | PARTIAL (FOUNDATION ONLY) | `valibot` is in the pnpm catalog and in `packages/internal` devDependencies, ready for use. Actual JSONL parsing with `safeParse()` is NOT implemented -- JSONL parsing is Phase 2 scope. The plan explicitly documents this as "DIST-04 foundation". |
| DIST-05 | 01-01-PLAN, 01-02-PLAN | `engines` field declares minimum Node.js 20.x | SATISFIED | `apps/ccaudit/package.json` and root `package.json` both contain `"node": ">=20.0.0"` |

**Requirements note on DIST-03 and DIST-04:** Both are listed as Phase 1 requirements in both PLANs and the ROADMAP. However, the Phase 1 plans correctly scope them as "foundation" (types defined, valibot available). The full behavioral implementations (path resolution, JSONL parsing) belong to Phase 2. This scoping is appropriate -- marking as PARTIAL/FOUNDATION. No gap is introduced since Phase 2 explicitly carries PARS-01 through PARS-07 which build on this foundation.

**Orphaned requirements check:** All 5 requirement IDs (DIST-01, DIST-02, DIST-03, DIST-04, DIST-05) are accounted for in Phase 1 plans. No REQUIREMENTS.md entries for Phase 1 are orphaned.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/ccaudit/src/cli/commands/ghost.ts` | 21-22 | `console.log('ccaudit ghost: not yet implemented')` | Info | Intentional scaffold stub -- known and documented in 01-02-SUMMARY.md. Implementation is Phase 5 scope. Not a blocker. |
| `packages/terminal/src/index.ts` | 4 | `TERMINAL_VERSION = '0.0.1'` stub | Info | Intentional stub -- documented in 01-01-SUMMARY.md as "implementation in Phase 5". Exports a valid constant, not a broken promise. Not a blocker. |
| `apps/ccaudit/tsdown.config.ts` | -- | `publint` and `unused` removed from plan spec | Info | Plan specified both options; they were removed because the required optional packages (`publint`, `unplugin-unused`) were not in the pnpm catalog. Documented as auto-fixed deviations in 01-02-SUMMARY.md. The build still produces a correct, functional bundle. |

No blocker anti-patterns found. The stub patterns above are intentional Phase 1 placeholders, all documented, none affecting the phase goal.

---

### Human Verification Required

None. All Phase 1 success criteria are programmatically verifiable and have been verified.

---

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are verified. The phase goal is achieved.

**Clarification on DIST-03 and DIST-04 partial satisfaction:** These requirements are satisfied at the appropriate Phase 1 scope (type foundation + dependency availability). Full behavioral satisfaction is correctly deferred to Phase 2 as designed. This is not a gap -- it is intentional phased delivery.

---

## Commit Verification

| Commit | Hash | Status |
|--------|------|--------|
| chore: scaffold pnpm monorepo | `3ab706c` | VERIFIED in git log |
| feat: add shared types, barrel exports, in-source tests | `e19b789` | VERIFIED in git log |
| feat: create CLI entry point, gunshi router, ghost stub command | `378a7cb` | VERIFIED in git log |
| chore: add CI pipeline with lint, typecheck, test, build | `25b00de` | VERIFIED in git log |

---

_Verified: 2026-04-03T20:47:00Z_
_Verifier: Claude (gsd-verifier)_
