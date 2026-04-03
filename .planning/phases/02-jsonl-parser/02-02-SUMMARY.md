---
phase: 02-jsonl-parser
plan: 02
subsystem: parser
tags: [tinyglobby, node-readline, streaming, jsonl, valibot, cli-pipeline]

# Dependency graph
requires:
  - phase: 02-jsonl-parser
    plan: 01
    provides: "InvocationRecord types, valibot schemas, parseDuration, extractInvocations, parseMcpName"
  - phase: 01-foundation-scaffold
    provides: "monorepo structure, apps/ccaudit CLI with gunshi, packages/internal, tsdown build config"
provides:
  - "discoverSessionFiles function with tinyglobby dual-path (XDG + legacy) and mtime pre-filtering"
  - "parseSession streaming JSONL parser with node:readline + valibot safeParse"
  - "Fully wired ghost CLI command: discover -> parse -> summarize with --since, --json, --verbose"
  - "Parser barrel (packages/internal/src/parser/index.ts) re-exporting all parser modules"
  - "Comprehensive barrel (packages/internal/src/index.ts) re-exporting all public API"
affects: [phase-03-inventory-scanner, phase-04-mcp-live, phase-05-ghost-detection]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Streaming JSONL parsing with node:readline createInterface + for-await-of"
    - "File mtime pre-filtering before content parsing (fast-path optimization)"
    - "isSidechain detection from both file path pattern AND JSONL data"
    - "emitDeclarationOnly + declaration in composite project tsconfig (instead of noEmit)"

key-files:
  created:
    - packages/internal/src/parser/discover.ts
    - packages/internal/src/parser/parse-session.ts
    - packages/internal/src/parser/index.ts
    - packages/internal/src/parser/__fixtures__/valid-session.jsonl
    - packages/internal/src/parser/__fixtures__/malformed-session.jsonl
    - packages/internal/src/parser/__fixtures__/subagent-session.jsonl
  modified:
    - packages/internal/src/index.ts
    - packages/internal/tsconfig.json
    - packages/internal/package.json
    - apps/ccaudit/src/cli/commands/ghost.ts

key-decisions:
  - "isSidechain detection from both file path (/subagents/agent-*) AND JSONL isSidechain field for robustness"
  - "emitDeclarationOnly + declaration replaces noEmit in packages/internal tsconfig for correct TypeScript project references"

patterns-established:
  - "Test fixtures in packages/internal/src/parser/__fixtures__/ for realistic JSONL parsing tests"
  - "Streaming parser pattern: createReadStream -> createInterface -> for-await-of -> safeParse per line"
  - "Dual-source isSidechain: file path pattern + JSONL data field"

requirements-completed: [PARS-01, PARS-02, PARS-06, PARS-07]

# Metrics
duration: 21min
completed: 2026-04-03
---

# Phase 02 Plan 02: Session Discovery and Streaming Parser Summary

**Tinyglobby dual-path session discovery, streaming JSONL parser with node:readline + valibot safeParse, and wired ghost CLI command outputting real invocation counts from local session files**

## Performance

- **Duration:** 21 min
- **Started:** 2026-04-03T21:32:43Z
- **Completed:** 2026-04-03T21:54:09Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Built session file discovery with tinyglobby dual-path patterns (XDG + legacy) including subagent sessions and mtime pre-filtering
- Built streaming JSONL parser using node:readline with constant-memory processing, 10MB line limit, and silent malformed-line skipping
- Replaced ghost command stub with full parser pipeline: discovers real session files, parses invocations, filters by --since window, outputs summary (text or JSON)
- CLI binary produces real output from local machine (e.g., 470 files, 21 projects, 230 invocations in 7d window)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create session discovery and streaming JSONL parser modules** - `1cf89b7` (test, TDD RED), `cf86d1f` (feat, TDD GREEN)
2. **Task 2: Wire parser pipeline into ghost CLI command with --since filtering** - `73ea47b` (feat)

## Files Created/Modified
- `packages/internal/src/parser/discover.ts` - discoverSessionFiles with tinyglobby dual-path and mtime pre-filter
- `packages/internal/src/parser/parse-session.ts` - parseSession streaming JSONL parser with valibot safeParse
- `packages/internal/src/parser/index.ts` - Barrel re-export of all parser modules
- `packages/internal/src/parser/__fixtures__/valid-session.jsonl` - 5-line fixture with agent/skill/mcp invocations
- `packages/internal/src/parser/__fixtures__/malformed-session.jsonl` - Mix of valid and invalid JSONL lines
- `packages/internal/src/parser/__fixtures__/subagent-session.jsonl` - Subagent lines with isSidechain:true
- `packages/internal/src/index.ts` - Comprehensive re-exports of all parser functions, types, and schemas
- `packages/internal/tsconfig.json` - Changed noEmit to emitDeclarationOnly + declaration for project references
- `packages/internal/package.json` - Updated typecheck script to emit declarations (tsc without --noEmit)
- `apps/ccaudit/src/cli/commands/ghost.ts` - Full parser pipeline replacing "not yet implemented" stub

## Decisions Made
- isSidechain detection uses BOTH file path pattern (`/subagents/agent-*`) AND JSONL `isSidechain` field, because test fixtures live outside the subagents directory but contain isSidechain:true data
- Changed packages/internal tsconfig from `noEmit: true` to `emitDeclarationOnly: true` + `declaration: true` because TypeScript project references (used by apps/ccaudit) require composite projects to have emit enabled

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] isSidechain detection from JSONL data, not just file path**
- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** Original implementation only detected isSidechain from file path pattern (`/subagents/agent-*`). Test fixture files at `__fixtures__/subagent-session.jsonl` have isSidechain:true in the JSONL data but are not in a subagents directory.
- **Fix:** Added parsing of anyLineSchema to also detect isSidechain from the JSONL line data (first line with isSidechain:true sets meta.isSidechain)
- **Files modified:** packages/internal/src/parser/parse-session.ts
- **Verification:** `pnpm --filter @ccaudit/internal test` passes with all 72 tests green
- **Committed in:** cf86d1f (Task 1 GREEN commit)

**2. [Rule 3 - Blocking] Fixed TypeScript project references emit configuration**
- **Found during:** Task 2 (typecheck verification)
- **Issue:** packages/internal tsconfig had `composite: true` + `noEmit: true`, but TypeScript TS6310 error: "Referenced project may not disable emit" when apps/ccaudit references it
- **Fix:** Changed `noEmit: true` to `emitDeclarationOnly: true` + `declaration: true` in packages/internal/tsconfig.json; updated typecheck script from `tsc --noEmit` to `tsc`
- **Files modified:** packages/internal/tsconfig.json, packages/internal/package.json
- **Verification:** `pnpm -r typecheck` passes for all 3 workspace projects
- **Committed in:** 73ea47b (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correct behavior and build pipeline. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all functionality is wired and producing real output.

## Next Phase Readiness
- Full JSONL parsing pipeline operational: discover -> parse -> extract -> filter
- `ccaudit ghost --json` outputs real invocation data from local session files
- Phase 3 (inventory scanner) can now compare invocations against installed agents/skills/MCP servers to detect actual ghosts
- All parser functions exported via @ccaudit/internal for downstream consumers

## Self-Check: PASSED

- All 10 claimed files exist on disk
- Commit 1cf89b7 found in git log (TDD RED)
- Commit cf86d1f found in git log (TDD GREEN)
- Commit 73ea47b found in git log (Task 2)
- 72 tests passing across 8 test files
- Zero v.parse() calls (only safeParse)
- All imports use .ts extensions
- No "not yet implemented" stub remaining

---
*Phase: 02-jsonl-parser*
*Completed: 2026-04-03*
