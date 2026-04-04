---
phase: 03-inventory-scanner
verified: 2026-04-04T07:10:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 03: Inventory Scanner Verification Report

**Phase Goal:** The tool detects ghost items across all four categories (agents, skills, MCP servers, memory files) by comparing installed inventory against the invocation ledger, with tiered ghost classification and per-project breakdown
**Verified:** 2026-04-04T07:10:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                                | Status     | Evidence                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Ghost agents and ghost skills are detected by comparing files in `~/.claude/agents/` and `~/.claude/skills/` against the invocation ledger           | ✓ VERIFIED | `scanAgents` (tinyglobby glob) + `scanSkills` (readdir) in Plan 02; `matchInventory` classifies against invocations |
| 2   | Ghost MCP servers are detected by reading `~/.claude.json` (root + per-project `mcpServers`) and `.mcp.json`, then comparing against invocations    | ✓ VERIFIED | `scanMcpServers` reads 3 sources with dedup; `matchInventory` performs O(1) lookup against `mcpServers` map         |
| 3   | Stale memory files (CLAUDE.md, `rules/` files) are detected via file mod-date heuristic (no modification in >30 days)                               | ✓ VERIFIED | `scanMemoryFiles` stat()s each file for `mtimeMs`; `matchInventory` uses `item.mtimeMs` directly as `lastUsedMs`    |
| 4   | Each ghost item shows `lastUsed` date and is classified as "likely ghost" (7-30d) or "definite ghost" (>30d / never)                                | ✓ VERIFIED | `classifyGhost` with 7d/30d boundaries; ghost CLI shows `[GHOST]/[LIKELY] name — last used Nd ago / never used`    |
| 5   | Per-project breakdown is available alongside the global cross-project view                                                                           | ✓ VERIFIED | `groupByProject` returns `Map<string, ScanResult[]>` keyed by projectPath; `byProject` returned from `scanAll`     |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact                                               | Expected                                                                 | Status      | Details                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `packages/internal/src/scanner/types.ts`               | InventoryItem, ScanResult, ScannerOptions, InvocationSummary interfaces  | ✓ VERIFIED  | All 4 interfaces exported; 20 in-source tests pass                                                |
| `packages/internal/src/scanner/classify.ts`            | classifyGhost function, LIKELY_GHOST_MS, DEFINITE_GHOST_MS constants     | ✓ VERIFIED  | Function and constants exported; 10 boundary tests pass including all specified cases              |
| `packages/internal/src/scanner/invocation-map.ts`     | buildInvocationMaps function returning 3 Maps                            | ✓ VERIFIED  | Exported; returns `{agents, skills, mcpServers}` Maps; 9 in-source tests pass                    |
| `packages/internal/src/scanner/scan-agents.ts`         | scanAgents function                                                      | ✓ VERIFIED  | Exported; tinyglobby `**/*.md` glob; global + project-local scope; 7 tests pass                   |
| `packages/internal/src/scanner/scan-skills.ts`         | scanSkills, resolveSkillName functions                                   | ✓ VERIFIED  | Both exported; readdir+withFileTypes; symlink detection; SKILL.md name resolution; 10 tests pass  |
| `packages/internal/src/scanner/scan-mcp.ts`            | scanMcpServers, readClaudeConfig, ClaudeConfig interface                 | ✓ VERIFIED  | All exported; 3 sources (global, per-project, .mcp.json); composite-key dedup; 9 tests pass       |
| `packages/internal/src/scanner/scan-memory.ts`         | scanMemoryFiles function                                                 | ✓ VERIFIED  | Exported; CLAUDE.md + rules/*.md; stat() for mtimeMs; 9 tests pass                               |
| `packages/internal/src/scanner/scan-all.ts`            | scanAll, matchInventory, groupByProject functions                        | ✓ VERIFIED  | All 3 exported; Promise.all parallel scanners; skillUsage fallback; 11 tests pass                 |
| `packages/internal/src/scanner/index.ts`               | Barrel re-exporting all scanner functions and types                      | ✓ VERIFIED  | All 12 value exports + 4 type exports + ClaudeConfig present                                      |
| `packages/internal/src/index.ts`                       | Package barrel updated with scanner exports                              | ✓ VERIFIED  | Lines 41-62: full scanner re-export block including ClaudeConfig type                              |
| `apps/ccaudit/src/cli/commands/ghost.ts`               | Ghost command using scanAll with tier/lastUsed output                    | ✓ VERIFIED  | scanAll imported from @ccaudit/internal; byProject captured; tier labels + lastUsed date in output |

---

### Key Link Verification

| From                                    | To                                              | Via                            | Status     | Details                                                                     |
| --------------------------------------- | ----------------------------------------------- | ------------------------------ | ---------- | --------------------------------------------------------------------------- |
| `scanner/classify.ts`                   | `packages/internal/src/types.ts`                | `import type { GhostTier }`    | ✓ WIRED    | Line 1: `import type { GhostTier } from '../types.ts'`                      |
| `scanner/types.ts`                      | `packages/internal/src/types.ts`                | `import GhostTier, ItemCategory, ItemScope` | ✓ WIRED | Line 1: `import type { ClaudePaths, GhostTier, ItemCategory, ItemScope }` |
| `scanner/invocation-map.ts`             | `packages/internal/src/parser/types.ts`         | `import InvocationRecord`      | ✓ WIRED    | Line 1: `import type { InvocationRecord } from '../parser/types.ts'`        |
| `scanner/scan-agents.ts`                | `tinyglobby`                                    | `import { glob }`              | ✓ WIRED    | Line 1: `import { glob } from 'tinyglobby'`                                 |
| `scanner/scan-mcp.ts`                   | `node:fs/promises`                              | `readFile` for JSON parsing    | ✓ WIRED    | Line 1: `import { readFile } from 'node:fs/promises'`                       |
| `scanner/scan-skills.ts`                | `scanner/types.ts`                              | `import InventoryItem`         | ✓ WIRED    | Line 3: `import type { InventoryItem } from './types.ts'`                   |
| `scanner/scan-all.ts`                   | `scanner/scan-agents.ts`                        | `import scanAgents`            | ✓ WIRED    | Line 8: `import { scanAgents } from './scan-agents.ts'`                     |
| `scanner/scan-all.ts`                   | `scanner/classify.ts`                           | `import classifyGhost`         | ✓ WIRED    | Line 6: `import { classifyGhost } from './classify.ts'`                     |
| `scanner/scan-all.ts`                   | `scanner/invocation-map.ts`                     | `import buildInvocationMaps`   | ✓ WIRED    | Line 7: `import { buildInvocationMaps } from './invocation-map.ts'`         |
| `apps/ccaudit/src/cli/commands/ghost.ts` | `packages/internal/src/scanner/scan-all.ts`   | `import scanAll from @ccaudit/internal` | ✓ WIRED | Lines 6-7: `scanAll` imported from `@ccaudit/internal`; `await scanAll(...)` at line 72 |

---

### Data-Flow Trace (Level 4)

| Artifact                                | Data Variable     | Source                           | Produces Real Data            | Status      |
| --------------------------------------- | ----------------- | -------------------------------- | ----------------------------- | ----------- |
| `apps/ccaudit/src/cli/commands/ghost.ts` | `results`, `byProject` | `scanAll(allInvocations, ...)` | Yes — reads real filesystem and real JSONL sessions | ✓ FLOWING |
| `scanner/scan-all.ts`                   | `agentItems`, `skillItems`, `mcpItems`, `memoryItems` | `Promise.all([scanAgents, scanSkills, scanMcpServers, scanMemoryFiles])` | Yes — tinyglobby/readdir/readFile/stat on real dirs | ✓ FLOWING |
| `scanner/scan-all.ts`                   | `skillUsage`      | `readClaudeConfig(claudeConfigPath).skillUsage` | Yes — reads `~/.claude.json`; fallback to `{}` | ✓ FLOWING |
| `apps/ccaudit/src/cli/commands/ghost.ts` | `ghosts`         | `results.filter(r => r.tier !== 'used')` | Yes — filters real classified results | ✓ FLOWING |

---

### Behavioral Spot-Checks

| Behavior                                   | Command                                 | Result                                                   | Status  |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------- | ------- |
| CLI runs end-to-end and produces ghost output | `import(dist/index.js)` (auto-executes) | 469 files, 23 projects, 212 items, 197 ghosts detected  | ✓ PASS  |
| Ghost output includes tier labels            | Visual inspection of stdout             | `[GHOST]` and `[LIKELY]` labels present on every row    | ✓ PASS  |
| Ghost output includes lastUsed date          | Visual inspection of stdout             | "last used Nd ago" or "never used" on every ghost row   | ✓ PASS  |
| All 4 categories produce ghost items         | Visual inspection of stdout             | AGENTS (162), SKILLS (26), MCP-SERVERS (4), MEMORYS (5) | ✓ PASS  |
| All 148 tests pass                           | `pnpm --filter @ccaudit/internal run test` | 16 test files, 148 tests, 0 failures                  | ✓ PASS  |
| TypeScript compiles cleanly                  | `pnpm -r typecheck`                     | 3 packages, 0 errors                                     | ✓ PASS  |
| CLI builds successfully                      | `pnpm --filter ccaudit build`           | dist/index.js 187.91 kB, build complete in 23ms          | ✓ PASS  |

---

### Requirements Coverage

| Requirement | Source Plan | Description                                                                                                               | Status       | Evidence                                                                                               |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| SCAN-01     | 03-02, 03-03 | Ghost agents detected: `~/.claude/agents/` and `.claude/agents/` files with zero invocations                            | ✓ SATISFIED  | `scanAgents` + `matchInventory` agent branch; behavioral spot-check shows 162 agent ghosts             |
| SCAN-02     | 03-02, 03-03 | Ghost skills detected: `~/.claude/skills/` and `.claude/skills/` with zero `Skill` tool_use invocations                 | ✓ SATISFIED  | `scanSkills` + skillUsage fallback in `matchInventory`; spot-check shows 26 skill ghosts with tier     |
| SCAN-03     | 03-02, 03-03 | Ghost MCP servers detected: `~/.claude.json` (root + per-project mcpServers) and `.mcp.json`                            | ✓ SATISFIED  | `scanMcpServers` reads 3 sources; `matchInventory` mcpServers branch; spot-check shows 4 MCP ghosts   |
| SCAN-04     | 03-02, 03-03 | Stale memory files: CLAUDE.md and `rules/` files with no modification in >30 days                                       | ✓ SATISFIED  | `scanMemoryFiles` stat() for mtimeMs; `matchInventory` memory branch uses mtime directly               |
| SCAN-05     | 03-01, 03-03 | "Likely ghost" (7-30d) vs "definite ghost" (>30d / never) tiers shown in default output                                 | ✓ SATISFIED  | `classifyGhost` with 7d/30d boundaries; `[GHOST]/[LIKELY]` labels in ghost.ts output                  |
| SCAN-06     | 03-01, 03-03 | `lastUsed` date shown in every ghost row                                                                                 | ✓ SATISFIED  | `r.lastUsed` in ghost.ts; "last used Nd ago" / "never used" string on every ghost row                 |
| SCAN-07     | 03-03       | Per-project breakdown available alongside global cross-project view                                                      | ✓ SATISFIED  | `groupByProject` returns `Map<string, ScanResult[]>`; `byProject` captured and available in ghost.ts  |

**All 7 requirements (SCAN-01 through SCAN-07) satisfied.**

No orphaned requirements: REQUIREMENTS.md maps exactly SCAN-01 through SCAN-07 to Phase 3, and all 7 are covered by the three plans.

---

### Anti-Patterns Found

No anti-patterns found. Scan of all 9 scanner files and ghost.ts revealed:

- No TODO/FIXME/PLACEHOLDER comments
- No stub return values (no `return null` / `return []` / `return {}` in production paths)
- No old Phase 3 stub message ("Ghost detection requires inventory scan -- Phase 3") — confirmed removed
- No hardcoded empty data flowing to render paths
- All `try/catch` empty blocks are intentional silent-skip error handlers (documented by comments), not stubs

---

### Human Verification Required

None — all automated checks passed and behavioral spot-checks confirmed real data flow.

The one item that merits optional human verification (but does not block the phase goal):

**Display formatting of "MEMORYS" category label**: The ghost CLI output renders `MEMORYS` for the memory category (from `cat.toUpperCase() + 'S'`). This is cosmetic output and the Phase 5 table renderer will replace it. Not a blocker for Phase 3 goal.

---

## Gaps Summary

No gaps. All 5 success criteria from ROADMAP.md Phase 3 are verified:

1. Ghost agents and skills detected — scanAgents, scanSkills, matchInventory wired and producing real results
2. Ghost MCP servers detected — 3 sources (global claude.json, per-project claude.json, .mcp.json) all working
3. Stale memory files detected — mtimeMs stat heuristic wired through classify
4. lastUsed date + tier classification on every item — classifyGhost boundaries confirmed by 10 unit tests
5. Per-project breakdown available — groupByProject confirmed by 3 unit tests; byProject in ghost.ts

The phase goal is fully achieved. The CLI is detecting real ghosts from the user's actual inventory (197 ghosts across 4 categories confirmed by end-to-end behavioral check).

---

_Verified: 2026-04-04T07:10:00Z_
_Verifier: Claude (gsd-verifier)_
