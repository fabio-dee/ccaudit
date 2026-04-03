---
phase: 02-jsonl-parser
verified: 2026-04-03T22:00:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 2: JSONL Parser Verification Report

**Phase Goal:** The tool can discover all session files (XDG + legacy paths, including subagent sessions) and extract a complete invocation ledger for agents, skills, and MCP tools within a configurable time window
**Verified:** 2026-04-03T22:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Session files discovered from both `~/.claude/` and `~/.config/claude/` dual-path, including `subagents/` | VERIFIED | `discover.ts` uses `projects/*/*.jsonl` + `projects/*/*/subagents/agent-*.jsonl` patterns for both XDG and legacy bases. CLI run returned 468 files from real machine. |
| 2 | Agent, Skill, and MCP invocations correctly extracted from `tool_use` blocks | VERIFIED | `extract-invocations.ts` handles Agent/Task (subagent_type), Skill (skill), mcp__ (server__tool split). 72 in-source tests pass covering all cases. |
| 3 | Project path resolved from `cwd` field in JSONL lines (not folder-name decoding) | VERIFIED | `parse-session.ts` lines 51-53: extracts cwd from first line containing it via `anyLineSchema`. In-source test confirms `projectPath === '/test/project'`. |
| 4 | Malformed JSONL lines silently skipped — parser never throws | VERIFIED | `parse-session.ts` uses try/catch on `JSON.parse` + `v.safeParse()` throughout. In-source test with `malformed-session.jsonl` passes without throwing and returns 1 invocation from 6-line file with 3 bad lines. |
| 5 | `--since <duration>` flag filters invocation ledger to specified window (default 7d) | VERIFIED | `parseDuration` converts string to ms; `ghost.ts` passes `sinceMs` to both `discoverSessionFiles` (mtime pre-filter) and `parseSession` (timestamp filter). `--since abc` prints error + exits 1. |

**Score:** 5/5 truths verified

### Note on ROADMAP Success Criterion 1 vs Actual Implementation

The ROADMAP success criterion states paths ending in `projects/*/sessions/` but Claude Code's actual storage layout is `projects/<encoded-path>/<uuid>.jsonl` (no `sessions/` subdirectory). The implementation correctly uses `projects/*/*.jsonl` which matches the real layout. The CLI discovering 468 real files confirms correctness. This is a documentation drift in ROADMAP.md, not a code defect.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/internal/src/parser/types.ts` | InvocationRecord, InvocationKind, SessionMeta, ParsedSessionResult types | VERIFIED | All 4 types exported; 119 lines with in-source tests |
| `packages/internal/src/parser/duration.ts` | parseDuration function | VERIFIED | Exports parseDuration; handles h/d/w/m units, case-insensitive, throws on invalid |
| `packages/internal/src/parser/extract-invocations.ts` | parseMcpName, extractInvocations | VERIFIED | Both functions exported; 380 lines; handles Agent/Task/Skill/mcp__ blocks |
| `packages/internal/src/schemas/session-line.ts` | anyLineSchema, assistantLineSchema + types | VERIFIED | All 4 exports present; contentBlockSchema imported from tool-use.ts |
| `packages/internal/src/schemas/tool-use.ts` | toolUseBlockSchema, contentBlockSchema + types | VERIFIED | All 4 exports present; catch-all union for unknown block types |
| `packages/internal/src/parser/discover.ts` | discoverSessionFiles with dual-path tinyglobby | VERIFIED | Exports discoverSessionFiles + DiscoverOptions; uses forward-slash normalization |
| `packages/internal/src/parser/parse-session.ts` | parseSession streaming JSONL parser | VERIFIED | Exports parseSession; uses node:readline + valibot safeParse; 10MB limit; isSidechain from both path and JSONL data |
| `packages/internal/src/parser/index.ts` | Barrel re-exporting all parser modules | VERIFIED | Re-exports discoverSessionFiles, parseSession, parseDuration, parseMcpName, extractInvocations + all types |
| `packages/internal/src/index.ts` | Comprehensive public barrel | VERIFIED | Re-exports all Phase 1 and Phase 2 types, schemas, and functions |
| `apps/ccaudit/src/cli/commands/ghost.ts` | Ghost command with full parser pipeline | VERIFIED | Imports from @ccaudit/internal; async run; calls discoverSessionFiles + parseSession; no "not yet implemented" |
| `packages/internal/src/parser/__fixtures__/valid-session.jsonl` | 5-line fixture | VERIFIED | 5 JSONL lines: system, 3 assistant (Agent/Skill/MCP), user |
| `packages/internal/src/parser/__fixtures__/malformed-session.jsonl` | Mix of valid/invalid | VERIFIED | 7 lines: 2 valid JSONL, 3 corrupt, 1 empty, 1 partial |
| `packages/internal/src/parser/__fixtures__/subagent-session.jsonl` | isSidechain:true lines | VERIFIED | 2 lines with isSidechain:true |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `extract-invocations.ts` | `schemas/tool-use.ts` | `import type { AssistantLine }` | VERIFIED | Line 1: `import type { AssistantLine } from '../schemas/session-line.ts'` |
| `extract-invocations.ts` | `parser/types.ts` | `import type { InvocationRecord }` | VERIFIED | Line 2: `import type { InvocationRecord } from './types.ts'` |
| `parse-session.ts` | `extract-invocations.ts` | `import { extractInvocations }` | VERIFIED | Line 5: `import { extractInvocations } from './extract-invocations.ts'` |
| `parse-session.ts` | `schemas/session-line.ts` | `import { anyLineSchema, assistantLineSchema }` | VERIFIED | Line 4: exact import of both schemas |
| `discover.ts` | `tinyglobby` | `import { glob } from 'tinyglobby'` | VERIFIED | Line 1 of discover.ts |
| `ghost.ts` | `@ccaudit/internal` | `import { discoverSessionFiles, parseSession, parseDuration }` | VERIFIED | Lines 2-6 of ghost.ts |
| `packages/internal/src/index.ts` | `parser/index.ts` | re-exports parser functions | VERIFIED | Lines 13-26 export from `./parser/index.ts` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `ghost.ts` | `allInvocations` | `parseSession(file, sinceMs)` | Yes — streaming readline from real .jsonl files | FLOWING |
| `ghost.ts` | `files` | `discoverSessionFiles({ sinceMs })` | Yes — tinyglobby glob against real filesystem (468 files found) | FLOWING |
| `parse-session.ts` | `invocations` | `extractInvocations(assistantLine)` | Yes — tool_use blocks from JSONL data | FLOWING |
| `parse-session.ts` | `projectPath` | `anyResult.output.cwd` from JSONL | Yes — cwd field from real session files | FLOWING |

**CLI spot-check output (real machine):**
```json
{
  "window": "7d",
  "files": 468,
  "projects": 21,
  "invocations": {
    "total": 229,
    "agents": 226,
    "skills": 3,
    "mcp": 0
  }
}
```

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| ghost --json produces valid JSON with required keys | `node dist/index.js ghost --json --since 7d` | JSON with window, files, projects, invocations keys | PASS |
| ghost --since abc prints error and exits 1 | `node dist/index.js ghost --since abc` | "Invalid duration..." printed; exit code 1 | PASS |
| 72 in-source tests pass | `pnpm --filter @ccaudit/internal test` | 8 test files, 72 tests, 0 failures | PASS |
| Workspace-wide typecheck passes | `pnpm -r typecheck` | 3 packages, 0 errors | PASS |
| Build succeeds | `pnpm --filter ccaudit build` | dist/index.js 173.73 kB, build complete | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| PARS-01 | 02-02-PLAN.md | Session files discovered from dual paths | SATISFIED | `discover.ts` globs both `~/.claude/projects/` and `~/.config/claude/projects/`; 468 files found on real machine |
| PARS-02 | 02-02-PLAN.md | Subagent sessions included (`isSidechain:true`, `subagents/` subdir) | SATISFIED | `discover.ts` pattern: `projects/*/*/subagents/agent-*.jsonl`; `parse-session.ts` detects isSidechain from both path and JSONL field |
| PARS-03 | 02-01-PLAN.md | Agent invocations from `tool_use` where `name='Agent'`; `input.subagent_type` = agent type | SATISFIED | `extractInvocations` checks `block.name === 'Agent' \|\| block.name === 'Task'`; extracts `input.subagent_type` |
| PARS-04 | 02-01-PLAN.md | Skill invocations from `tool_use` where `name='Skill'`; `input.skill` = skill name | SATISFIED | `extractInvocations` checks `block.name === 'Skill'`; extracts `input.skill` |
| PARS-05 | 02-01-PLAN.md | MCP invocations parsed from `mcp__<server>__<tool>` names | SATISFIED | `parseMcpName` strips `mcp__` prefix, finds first `__` separator; handles server names with single underscores (e.g., `Claude_in_Chrome`) |
| PARS-06 | 02-01-PLAN.md + 02-02-PLAN.md | Project path from `cwd` field (not folder-name decoding) | SATISFIED | `parse-session.ts`: `v.safeParse(anyLineSchema, json)` then `anyResult.output.cwd`; used for first occurrence only |
| PARS-07 | 02-01-PLAN.md + 02-02-PLAN.md | `--since <duration>` flag on read commands with configurable lookback (default 7d) | SATISFIED | `parseDuration` converts h/d/w/m strings to ms; mtime pre-filter in `discoverSessionFiles`; timestamp filter in `parseSession`; default `'7d'` in ghost command args |

**All 7 phase requirements: SATISFIED**

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | - | - | - | - |

Scanned: zero `v.parse(` calls (only `v.safeParse`), zero `TODO/FIXME/PLACEHOLDER` comments, no stub `return null` or `return []` without data source, no hardcoded empty props at call sites. Ghost command no longer contains "not yet implemented".

### Human Verification Required

No items require human verification. All observable behaviors are programmatically confirmed:
- File discovery against real filesystem (468 files found)
- Full invocation pipeline producing real counts (229 invocations in 7d window)
- Error handling for invalid inputs (exit code 1)
- All 72 in-source tests passing

### Gaps Summary

No gaps. All five truths verified, all 13 artifacts substantive and wired, all 7 data flows confirmed, all 7 requirement IDs satisfied.

The only notable observation is a documentation drift in ROADMAP.md: Success Criterion 1 mentions `sessions/` in the path, but Claude Code's actual storage layout does not use that subdirectory. The implementation is correct; the CLI discovering 468 real files is definitive evidence.

---

_Verified: 2026-04-03T22:00:00Z_
_Verifier: Claude (gsd-verifier)_
