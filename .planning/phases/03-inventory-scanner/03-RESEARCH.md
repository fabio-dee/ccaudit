# Phase 3: Inventory Scanner - Research

**Researched:** 2026-04-04
**Domain:** File system inventory scanning, MCP config parsing, ghost classification, per-project breakdown
**Confidence:** HIGH

## Summary

Phase 3 transforms the invocation ledger (produced by Phase 2) into ghost classifications by comparing it against the actual installed inventory on disk. Four scanner categories must be implemented: (1) agents -- `.md` files and subdirectories in `~/.claude/agents/` and project-local `.claude/agents/`, (2) skills -- directories in `~/.claude/skills/` and `.claude/skills/` (including symlinks), (3) MCP servers -- entries in `~/.claude.json` (root `mcpServers` + `projects.<path>.mcpServers`) and project-local `.mcp.json`, and (4) memory files -- `CLAUDE.md` files and `rules/` directories assessed by `mtime` heuristic.

Research is grounded in firsthand inspection of real inventory on this machine: 171 agent `.md` files across subdirectories, 11 skill entries (3 directories + 8 symlinks), MCP servers defined both at global root and per-project in `~/.claude.json`, and `.mcp.json` files at project roots. A critical finding from JSONL analysis: `subagent_type` values in the invocation ledger include BOTH built-in types (`Explore`, `Coder`) AND custom agent file stems (`gsd-executor`, `gsd-planner`). Ghost detection must only flag custom agent files, not built-in types. Skill invocations use colon-namespaced names (`gsd:plan-phase`) that do NOT directly map to filesystem paths -- the `skillUsage` field in `~/.claude.json` provides another mapping source.

**Primary recommendation:** Build four scanner modules (`scan-agents.ts`, `scan-skills.ts`, `scan-mcp.ts`, `scan-memory.ts`) in `packages/internal/src/scanner/`, each returning a uniform `ScanResult[]` array. A coordinator (`scan-all.ts`) aggregates results and classifies ghosts using a shared `classifyGhost()` function. Use `tinyglobby` for file discovery, `node:fs/promises` `stat()` for mtime checks, and `JSON.parse` for `~/.claude.json` / `.mcp.json` reading. No new dependencies required.

## Project Constraints (from CLAUDE.md)

CLAUDE.md enforces these directives that constrain this phase:

- **Zero runtime deps**: All libraries (valibot, tinyglobby) are devDependencies; tsdown bundles them
- **Tech stack locked**: TypeScript/Node >= 20, valibot safeParse, tinyglobby, vitest in-source tests
- **Distribution**: `npx ccaudit@latest` -- zero install
- **Safety**: Silent skip on errors (never throw on corrupt/missing data)
- **GSD workflow**: Must not make direct repo edits outside GSD workflow
- **Monorepo layout**: `apps/ccaudit/` for CLI, `packages/internal/` for shared types/utils
- **In-source testing**: `if (import.meta.vitest)` blocks, vitest `includeSource`
- **Cross-platform**: `path.posix.join` for glob patterns, `path.join` for fs, `os.homedir()` for `~`
- **Existing patterns**: Follow ccusage conventions for file handling and error handling

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCAN-01 | Ghost agents detected: files in `~/.claude/agents/` and `.claude/agents/` with zero invocations in time window | Agent `.md` files found via tinyglobby glob. Invocation ledger `kind='agent'` records matched by file stem against `subagent_type`. Built-in types (`Explore`, `Coder`) excluded from ghost detection. See Architecture > Agent Scanner. |
| SCAN-02 | Ghost skills detected: `~/.claude/skills/` and `.claude/skills/` files with zero `Skill` tool_use invocations in time window | Skill directories (including symlinks) found via `readdir`. Skill names in JSONL use colon-namespaced format (`gsd:plan-phase`). Matching requires heuristic: directory name checked against skill invocation name segments. `skillUsage` in `~/.claude.json` provides supplementary data. See Architecture > Skill Scanner. |
| SCAN-03 | Ghost MCP servers detected: entries in `~/.claude.json` (`mcpServers` root key + `projects.<path>.mcpServers`) and `.mcp.json` with zero `mcp__<server>__*` invocations in time window | `~/.claude.json` has root `mcpServers` (global) and `projects.<path>.mcpServers` (per-project). `.mcp.json` at project roots has `mcpServers` key. Server names matched against invocation `kind='mcp'` records. `disabledMcpServers` array per project tracks user-disabled servers -- these should be noted. See Architecture > MCP Scanner. |
| SCAN-04 | Stale memory files detected: CLAUDE.md and `rules/` files with no modification in >30 days (file mod-date heuristic) | `node:fs/promises` `stat()` returns `mtimeMs`. Compare `Date.now() - mtimeMs` against 30-day threshold. Memory files have no invocation signal -- staleness is purely time-based. See Architecture > Memory Scanner. |
| SCAN-05 | "Likely ghost" tier (7-30d since last invocation) vs "definite ghost" tier (>30d / never) shown in default output | Shared `classifyGhost()` function: compute days since last invocation (or mtime for memory). `used` = within window, `likely-ghost` = 7-30d, `definite-ghost` = >30d or never. See Architecture > Ghost Classification. |
| SCAN-06 | `lastUsed` date shown in every ghost row -- never "ghost" without "last seen N days ago" | `lastUsed` derived from max timestamp across all invocation records for that item, or `null` if never. For memory files, `lastUsed` = file mtime. See Architecture > lastUsed Resolution. |
| SCAN-07 | Per-project breakdown available alongside global cross-project view | Invocation records carry `projectPath`. Scanner results tagged with `projectPath` (or `'global'` for `~/.claude/` items). Aggregation by project for breakdown view. See Architecture > Per-Project Breakdown. |
</phase_requirements>

## Standard Stack

### Core (Phase 3 specific)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:fs/promises` | Node 20+ built-in | `readFile()` for JSON configs, `stat()` for mtime, `readdir()` for skill dirs | No external dep needed |
| `node:path` | Node 20+ built-in | Path manipulation, `path.basename()` for name extraction, `path.extname()` for filtering | Cross-platform path handling |
| `node:os` | Node 20+ built-in | `homedir()` for `~` expansion | Already used in Phase 2 discoverer |
| `tinyglobby` | ^0.2.15 | Agent file discovery (`~/.claude/agents/**/*.md`) | Already installed, already used in Phase 2 |
| `valibot` | ^1.3.1 | Schema validation for `~/.claude.json` and `.mcp.json` parsing | Already installed, tree-shakable |

### Already Installed (from Phase 1)

All libraries above are already in the pnpm catalog. No new `pnpm add` commands needed for Phase 3.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `JSON.parse` + valibot for config | `jsonc-parser` | `~/.claude.json` and `.mcp.json` are strict JSON (no comments). Standard `JSON.parse` is sufficient. |
| `tinyglobby` for agent discovery | `node:fs/promises.readdir({ recursive: true })` | Node 20.1+ has `recursive: true` on readdir, but tinyglobby is already used and provides better pattern matching with `.md` filtering |
| `readdir` for skill discovery | `tinyglobby` | Skills are shallow directories (not deeply nested). `readdir` + `stat` is simpler. Either works. |

## Architecture Patterns

### Recommended Project Structure

```
packages/internal/src/
  scanner/
    types.ts              # ScanResult, ScannerOptions, InventoryItem types
    classify.ts           # classifyGhost() shared classification logic
    scan-agents.ts        # Agent inventory scanner
    scan-skills.ts        # Skill inventory scanner
    scan-mcp.ts           # MCP server inventory scanner
    scan-memory.ts        # Memory file (CLAUDE.md, rules/) scanner
    scan-all.ts           # Coordinator: runs all scanners, aggregates results
    index.ts              # Barrel re-export
  types.ts                # Existing: GhostItem, GhostTier, etc. (Phase 1)
  parser/                 # Existing: Phase 2 parser pipeline
apps/ccaudit/src/
  cli/commands/ghost.ts   # Updated: calls scanner after parser, renders ghost table
```

### Pattern 1: Inventory Item (pre-classification)

**What:** Each scanner discovers installed items and produces `InventoryItem` records. Classification happens after matching against the invocation ledger.

```typescript
// Source: Derived from existing GhostItem type + research findings
export interface InventoryItem {
  /** Display name (agent stem, skill name, MCP server key, memory file path) */
  name: string;
  /** Absolute filesystem path (or config source for MCP) */
  path: string;
  /** Global (~/.claude/) or project-local (.claude/) */
  scope: 'global' | 'project';
  /** Category: agent, skill, mcp-server, memory */
  category: 'agent' | 'skill' | 'mcp-server' | 'memory';
  /** Project path this item belongs to (null for global items) */
  projectPath: string | null;
  /** File modification time in ms (for memory files mtime heuristic) */
  mtimeMs?: number;
}
```

### Pattern 2: Scan Result (post-classification)

**What:** After matching inventory against invocations, each item becomes a `ScanResult`.

```typescript
// Source: Extends existing GhostItem from packages/internal/src/types.ts
export interface ScanResult {
  /** The discovered inventory item */
  item: InventoryItem;
  /** Ghost classification: 'used' | 'likely-ghost' | 'definite-ghost' */
  tier: GhostTier;
  /** Last invocation date, or null if never invoked */
  lastUsed: Date | null;
  /** Number of invocations in the time window */
  invocationCount: number;
}
```

### Pattern 3: Ghost Classification Logic

**What:** Shared function that classifies an inventory item based on invocation data.
**When to use:** After matching each inventory item against the invocation ledger.

```typescript
// Source: Derived from SCAN-05 requirement + existing GhostTier type
import type { GhostTier } from '../types.ts';

const LIKELY_GHOST_MS = 7 * 86_400_000;    // 7 days
const DEFINITE_GHOST_MS = 30 * 86_400_000; // 30 days

export function classifyGhost(
  lastUsedMs: number | null,  // null = never invoked
  now: number = Date.now(),
): GhostTier {
  if (lastUsedMs === null) return 'definite-ghost';
  const elapsed = now - lastUsedMs;
  if (elapsed <= LIKELY_GHOST_MS) return 'used';
  if (elapsed <= DEFINITE_GHOST_MS) return 'likely-ghost';
  return 'definite-ghost';
}
```

### Pattern 4: Agent Scanner

**What:** Discovers agent `.md` files using tinyglobby. Matches against invocation `kind='agent'` records by file stem.

**Critical insight:** The `subagent_type` field in JSONL contains the agent's file stem (e.g., `gsd-executor` for `gsd-executor.md`). BUT it also contains built-in Claude Code types like `Explore` and `Coder` that are NOT custom agent files. Ghost detection must only flag items that exist on disk.

```typescript
// Source: Verified from real JSONL data + filesystem inspection
import { glob } from 'tinyglobby';
import path from 'node:path';

export async function scanAgents(
  claudePaths: { xdg: string; legacy: string },
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const posixBase = base.replace(/\\/g, '/');
    const files = await glob([`${posixBase}/agents/**/*.md`], {
      absolute: true,
      dot: false,
    });

    for (const filePath of files) {
      const stem = path.basename(filePath, '.md'); // e.g., 'gsd-executor'
      items.push({
        name: stem,
        path: filePath,
        scope: 'global',
        category: 'agent',
        projectPath: null,
      });
    }
  }

  // Project-local agents: .claude/agents/ in cwd
  // (handled separately per known project path)
  return items;
}
```

**Matching logic:** For each `InventoryItem` with `category='agent'`, find all `InvocationRecord` where `kind='agent'` AND `name === item.name` (case-sensitive comparison). The most recent `timestamp` becomes `lastUsed`.

### Pattern 5: Skill Scanner

**What:** Discovers skill directories (and symlinks) in `~/.claude/skills/` and `.claude/skills/`.

**Critical insight:** Skill directory names (`agent-org-planner`, `find-skills`) do NOT directly match the `input.skill` values in JSONL (`gsd:plan-phase`, `gsd:new-project`). These are different naming systems. The skill detection must rely on:
1. Check `skillUsage` field in `~/.claude.json` for usage timestamps
2. Match directory name against the skill invocation names as a fuzzy heuristic
3. As a fallback, if no match found, treat as definite ghost

```typescript
// Source: Verified from filesystem inspection + claude.json skillUsage field
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function scanSkills(
  claudePaths: { xdg: string; legacy: string },
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const skillsDir = path.join(base, 'skills');
    let entries;
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue; // Directory doesn't exist
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip dotfiles
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        items.push({
          name: entry.name,
          path: path.join(skillsDir, entry.name),
          scope: 'global',
          category: 'skill',
          projectPath: null,
        });
      }
    }
  }

  return items;
}
```

**Matching logic:** For each skill directory, check:
1. JSONL invocation records where `kind='skill'` -- look for `name` containing the directory name
2. `skillUsage` in `~/.claude.json` -- keys like `gsd:plan-phase` with `lastUsedAt` timestamps
3. If neither match, the skill directory is a ghost

### Pattern 6: MCP Server Scanner

**What:** Reads MCP server definitions from two sources: `~/.claude.json` (global + per-project) and `.mcp.json` (project-local).

**Data structure from real `~/.claude.json`:**
```json
{
  "mcpServers": {
    "context7": { "type": "http", "url": "..." }
  },
  "projects": {
    "/Users/foo/project": {
      "mcpServers": {
        "supabase": { "type": "http", "url": "..." }
      },
      "disabledMcpServers": ["context7"]
    }
  }
}
```

**Data structure from `.mcp.json`:**
```json
{
  "mcpServers": {
    "sequential-thinking": { "command": "npx", "args": [...] },
    "chrome-devtools": { "command": "npx", "args": [...] }
  }
}
```

```typescript
// Source: Verified from real ~/.claude.json inspection
import { readFile } from 'node:fs/promises';

interface McpServerEntry {
  name: string;
  source: 'claude.json-global' | 'claude.json-project' | 'mcp.json';
  projectPath: string | null;
  isDisabled: boolean; // From disabledMcpServers array
}

export async function scanMcpServers(
  claudeJsonPath: string,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // 1. Read ~/.claude.json
  let claudeConfig: Record<string, unknown> = {};
  try {
    const raw = await readFile(claudeJsonPath, 'utf-8');
    claudeConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File missing or corrupt -- skip silently
  }

  // 2. Global mcpServers (root level)
  const globalMcp = claudeConfig.mcpServers as Record<string, unknown> | undefined;
  if (globalMcp) {
    for (const serverName of Object.keys(globalMcp)) {
      items.push({
        name: serverName,
        path: claudeJsonPath,
        scope: 'global',
        category: 'mcp-server',
        projectPath: null,
      });
    }
  }

  // 3. Per-project mcpServers
  const projects = claudeConfig.projects as Record<string, Record<string, unknown>> | undefined;
  if (projects) {
    for (const [projPath, projConfig] of Object.entries(projects)) {
      const projMcp = projConfig.mcpServers as Record<string, unknown> | undefined;
      if (projMcp) {
        for (const serverName of Object.keys(projMcp)) {
          items.push({
            name: serverName,
            path: claudeJsonPath,
            scope: 'project',
            category: 'mcp-server',
            projectPath: projPath,
          });
        }
      }
    }
  }

  // 4. .mcp.json files at project roots
  for (const projPath of projectPaths) {
    const mcpJsonPath = `${projPath}/.mcp.json`;
    try {
      const raw = await readFile(mcpJsonPath, 'utf-8');
      const mcpConfig = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (mcpConfig.mcpServers) {
        for (const serverName of Object.keys(mcpConfig.mcpServers)) {
          items.push({
            name: serverName,
            path: mcpJsonPath,
            scope: 'project',
            category: 'mcp-server',
            projectPath: projPath,
          });
        }
      }
    } catch {
      continue; // No .mcp.json or corrupt -- skip
    }
  }

  return items;
}
```

**Matching logic:** For each MCP server inventory item, find all `InvocationRecord` where `kind='mcp'` AND `name === item.name`. The server name in the invocation ledger (`mcp__<server>__<tool>` parsed to `server`) matches the key in the config.

### Pattern 7: Memory File Scanner

**What:** Discovers `CLAUDE.md` files and `rules/` directory contents at global and project levels. Uses mtime heuristic since memory files have no invocation signal.

```typescript
// Source: Verified from filesystem inspection
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const STALE_THRESHOLD_MS = 30 * 86_400_000; // 30 days

export async function scanMemoryFiles(
  claudePaths: { xdg: string; legacy: string },
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // Global CLAUDE.md files
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const claudeMdPath = path.join(base, 'CLAUDE.md');
    try {
      const s = await stat(claudeMdPath);
      items.push({
        name: 'CLAUDE.md',
        path: claudeMdPath,
        scope: 'global',
        category: 'memory',
        projectPath: null,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      continue; // File doesn't exist
    }
  }

  // Project-level CLAUDE.md and rules/ files
  for (const projPath of projectPaths) {
    // CLAUDE.md at project root
    const projClaudeMd = path.join(projPath, 'CLAUDE.md');
    try {
      const s = await stat(projClaudeMd);
      items.push({
        name: 'CLAUDE.md',
        path: projClaudeMd,
        scope: 'project',
        category: 'memory',
        projectPath: projPath,
        mtimeMs: s.mtimeMs,
      });
    } catch { /* skip */ }

    // .claude/rules/ files
    const rulesDir = path.join(projPath, '.claude', 'rules');
    try {
      const entries = await readdir(rulesDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(rulesDir, entry);
        const s = await stat(filePath);
        items.push({
          name: entry,
          path: filePath,
          scope: 'project',
          category: 'memory',
          projectPath: projPath,
          mtimeMs: s.mtimeMs,
        });
      }
    } catch { /* skip */ }
  }

  return items;
}
```

**Classification logic:** Memory files use mtime instead of invocations. `classifyGhost()` receives `mtimeMs` as `lastUsedMs`. Files modified within 30 days = `used`, 7-30 days = `likely-ghost`, >30 days = `definite-ghost`.

### Pattern 8: Per-Project Breakdown

**What:** Aggregate scan results by project path for the per-project view.

```typescript
export function groupByProject(results: ScanResult[]): Map<string, ScanResult[]> {
  const map = new Map<string, ScanResult[]>();
  for (const r of results) {
    const key = r.item.projectPath ?? 'global';
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  return map;
}
```

### Anti-Patterns to Avoid

- **Matching agent names case-insensitively:** Agent file stems are case-sensitive on Linux/macOS. Use exact match.
- **Treating symlinked skills differently from real directories:** Both should be scanned. Use `readdir({ withFileTypes: true })` and check `isDirectory() || isSymbolicLink()`.
- **Reading `~/.claude.json` multiple times:** Read once, parse once, pass the parsed object to all scanners that need it.
- **Throwing on missing config files:** `~/.claude.json` might not exist on fresh installations. `.mcp.json` is optional. Always wrap in try/catch.
- **Comparing skill directory names to full colon-namespaced invocation names:** `agent-org-planner` != `gsd:plan-phase`. These are different naming systems. Use `skillUsage` from `~/.claude.json` as the primary source, JSONL as supplementary.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File glob patterns | Custom `readdir` recursion with `.md` filtering | `tinyglobby` `glob()` with `**/*.md` pattern | Already used in Phase 2, handles cross-platform path separators |
| JSON schema validation | Manual type checks on parsed `~/.claude.json` | `valibot` `safeParse()` with schemas | Consistent with Phase 2 pattern, tree-shakable |
| File mtime checking | Custom stat + date math | `node:fs/promises` `stat()` returning `mtimeMs` | Built-in, reliable, cross-platform |
| Symlink resolution | Manual `readlink` + path resolution | `readdir({ withFileTypes: true })` + `isSymbolicLink()` | Node built-in handles it correctly |

**Key insight:** Phase 3 has no deceptively complex problems. The scanner modules are straightforward file I/O + set comparison. The trickiest part is skill name matching (directory name vs invocation name mismatch), which requires the `skillUsage` fallback strategy rather than any library solution.

## Common Pitfalls

### Pitfall 1: Agent Name Mismatch with Built-in Types
**What goes wrong:** Treating built-in `subagent_type` values (`Explore`, `Coder`) as custom agents, leading to false "agent not on disk" errors or ghost misclassification.
**Why it happens:** The invocation ledger contains both built-in and custom agent types in the same `kind='agent'` records.
**How to avoid:** Only flag items that exist in the filesystem inventory. The scanner discovers files on disk, then checks if they were invoked. Items in the ledger that don't match any on-disk file are simply ignored (they're built-in types).
**Warning signs:** Ghost output showing agents like "Explore" or "Coder" that have no file path.

### Pitfall 2: Skill Name Namespace Mismatch
**What goes wrong:** Skill directory names (`agent-org-planner`) don't match JSONL invocation names (`gsd:plan-phase`). Naive string matching finds zero matches, and all skills appear as ghosts.
**Why it happens:** Skills have a directory name and a registered name, and these are different naming systems. The JSONL `input.skill` field contains the registered colon-namespaced name, not the directory name.
**How to avoid:** Use `skillUsage` from `~/.claude.json` as the primary source for skill last-use times. The `skillUsage` object has `lastUsedAt` timestamps per registered skill name. For mapping skill directories to registered names, read each directory's `SKILL.md` file for the `name:` field.
**Warning signs:** 100% of skills classified as `definite-ghost` when some are clearly in active use.

### Pitfall 3: Duplicate MCP Server Entries
**What goes wrong:** Same server name (e.g., `context7`) appears in both `~/.claude.json` global `mcpServers` AND in `~/.claude.json` `projects.<path>.mcpServers`, causing double-counting or conflicting ghost classifications.
**Why it happens:** Users can define MCP servers globally and override per-project.
**How to avoid:** Track the source (`claude.json-global`, `claude.json-project`, `mcp.json`) and project path. When reporting, deduplicate by (server-name, project-path) pair. Global servers apply to all projects unless overridden.
**Warning signs:** Same server appearing multiple times in ghost report with different classifications.

### Pitfall 4: `.mcp.json` at Unrelated Project Paths
**What goes wrong:** Scanning `.mcp.json` for every known project path may read config files from projects the user hasn't used in the time window.
**Why it happens:** Project paths come from the invocation ledger (Phase 2 `cwd` fields), which includes all projects with sessions, not just active ones.
**How to avoid:** Only scan `.mcp.json` for project paths that appear in the current time window's invocation ledger. This naturally scopes the scan.
**Warning signs:** Ghost report showing MCP servers from projects that weren't in the `--since` window.

### Pitfall 5: Memory File mtime Reset by Git Operations
**What goes wrong:** `git pull`, `git checkout`, or `git merge` can reset the mtime of `CLAUDE.md` or `rules/*.md` files to the current time, making stale files appear fresh.
**Why it happens:** Git operations touch files and update their mtime.
**How to avoid:** Document this limitation clearly. The mtime heuristic is explicitly a "best effort" signal. The requirement (SCAN-04) specifically says "file mod-date heuristic" -- acknowledging it's imperfect.
**Warning signs:** Memory files that should be stale showing as recently modified after a `git pull`.

### Pitfall 6: Windows Path Normalization in MCP Project Keys
**What goes wrong:** On Windows, the `~/.claude.json` `projects` keys use forward slashes (e.g., `/C:/Users/...`) but the `cwd` field in JSONL may use backslashes. Path comparison fails.
**Why it happens:** Claude Code normalizes paths differently in config vs JSONL.
**How to avoid:** Normalize all paths before comparison using `path.normalize()` and converting backslashes to forward slashes. This is consistent with the Phase 2 cross-platform pattern.
**Warning signs:** Per-project breakdown showing separate entries for the same project with different path formats.

### Pitfall 7: Symlinked Skill Directories Pointing to Nonexistent Targets
**What goes wrong:** Skill symlinks (e.g., `~/.claude/skills/find-skills -> ../../.agents/skills/find-skills`) may point to targets that have been deleted. `readdir` includes them but `stat` on the target fails.
**Why it happens:** User deletes the source but doesn't clean up symlinks.
**How to avoid:** Use try/catch around `stat()` calls on skill paths. Broken symlinks should still be reported as inventory items (they occupy config space) but noted as broken.
**Warning signs:** Errors thrown when trying to stat a skill path.

## Code Examples

### Complete Invocation Ledger to Lookup Map

```typescript
// Source: Derived from Phase 2 InvocationRecord type + Phase 3 matching needs
import type { InvocationRecord } from '../parser/types.ts';

interface InvocationSummary {
  lastTimestamp: string;     // Most recent invocation ISO timestamp
  count: number;             // Total invocations in window
  projects: Set<string>;     // All project paths this item was invoked from
}

/**
 * Build lookup maps from the invocation ledger for fast matching.
 * Returns separate maps for agents, skills, and MCP servers.
 */
export function buildInvocationMaps(invocations: InvocationRecord[]): {
  agents: Map<string, InvocationSummary>;
  skills: Map<string, InvocationSummary>;
  mcpServers: Map<string, InvocationSummary>;
} {
  const agents = new Map<string, InvocationSummary>();
  const skills = new Map<string, InvocationSummary>();
  const mcpServers = new Map<string, InvocationSummary>();

  for (const inv of invocations) {
    const targetMap =
      inv.kind === 'agent' ? agents :
      inv.kind === 'skill' ? skills :
      mcpServers;

    const existing = targetMap.get(inv.name);
    if (existing) {
      if (inv.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = inv.timestamp;
      }
      existing.count++;
      if (inv.projectPath) existing.projects.add(inv.projectPath);
    } else {
      const projects = new Set<string>();
      if (inv.projectPath) projects.add(inv.projectPath);
      targetMap.set(inv.name, {
        lastTimestamp: inv.timestamp,
        count: 1,
        projects,
      });
    }
  }

  return { agents, skills, mcpServers };
}
```

### Reading `~/.claude.json` Safely

```typescript
// Source: Verified from real ~/.claude.json inspection
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, {
    mcpServers?: Record<string, unknown>;
    disabledMcpServers?: string[];
  }>;
  skillUsage?: Record<string, {
    usageCount: number;
    lastUsedAt: number; // Unix timestamp in milliseconds
  }>;
}

export async function readClaudeConfig(): Promise<ClaudeConfig> {
  const configPath = path.join(homedir(), '.claude.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return {}; // Missing or corrupt -- return empty
  }
}
```

### Scanning Project-Local Agents

```typescript
// Source: Derived from SCAN-01 requirement + filesystem patterns
import { glob } from 'tinyglobby';
import path from 'node:path';

export async function scanProjectAgents(
  projectPath: string,
): Promise<InventoryItem[]> {
  const agentsDir = path.join(projectPath, '.claude', 'agents');
  const posixDir = agentsDir.replace(/\\/g, '/');

  try {
    const files = await glob([`${posixDir}/**/*.md`], {
      absolute: true,
      dot: false,
    });

    return files.map(filePath => ({
      name: path.basename(filePath, '.md'),
      path: filePath,
      scope: 'project' as const,
      category: 'agent' as const,
      projectPath,
    }));
  } catch {
    return []; // Directory doesn't exist
  }
}
```

### Skill Name Resolution via SKILL.md

```typescript
// Source: Verified from ~/.claude/skills/agent-org-planner/SKILL.md inspection
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Extract the registered skill name from SKILL.md frontmatter.
 * Returns the `name:` field value, or the directory name as fallback.
 */
export async function resolveSkillName(skillDir: string): Promise<string> {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    // Simple YAML frontmatter extraction (no yaml parser needed)
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
  } catch {
    // SKILL.md doesn't exist or can't be read
  }
  return path.basename(skillDir);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Skill invocations tracked only in JSONL | `skillUsage` in `~/.claude.json` tracks usage counts + timestamps | Observed in current Claude Code | Provides authoritative skill usage data independent of JSONL parsing |
| MCP servers only in global config | Per-project MCP servers in `projects.<path>.mcpServers` | Current Claude Code | Must scan both global and per-project MCP definitions |
| `.mcp.json` was the only project-local MCP config | `~/.claude.json` `projects.<path>` also stores per-project MCP | Current Claude Code | Two sources of per-project MCP config; both must be checked |
| Agent files only flat `.md` files | Agent files organized in subdirectories (`design/`, `engineering/`, etc.) | Current Claude Code | Glob pattern must use `**/*.md` recursive match, not just `*.md` |

**Deprecated/outdated:**
- `settings.json` for MCP config: MCP servers are NOT in `settings.json`. They are in `~/.claude.json` and `.mcp.json`. This was confirmed during roadmap research.

## Open Questions

1. **Skill Directory-to-Name Mapping Reliability**
   - What we know: Skill directories have a `SKILL.md` with a `name:` field. The JSONL `input.skill` uses the registered name (e.g., `gsd:plan-phase`). `skillUsage` in `~/.claude.json` uses the same registered names.
   - What's unclear: Whether the `name:` field in `SKILL.md` always matches what appears in `skillUsage` keys. The `SKILL.md` for `agent-org-planner` has `name: agent-org-planner`, but this doesn't appear in `skillUsage`. This suggests not all installed skills have been used.
   - Recommendation: Use `skillUsage` as the primary skill usage source. For skills without a `skillUsage` entry, check JSONL invocation records as fallback. If neither matches, it's a ghost.

2. **Project-Local Agent/Skill Scanning Scope**
   - What we know: Project-local `.claude/agents/` and `.claude/skills/` exist in some projects. The scanner should check them.
   - What's unclear: Should ccaudit scan ALL known project paths (from the `projects` key in `~/.claude.json`) or only projects with sessions in the time window?
   - Recommendation: Scan only projects with session activity in the `--since` window. This is consistent with the time-window scoping and avoids scanning inactive projects.

3. **`disabledMcpServers` Treatment**
   - What we know: `~/.claude.json` has `projects.<path>.disabledMcpServers` arrays listing server names the user has manually disabled.
   - What's unclear: Should disabled MCP servers be shown as ghosts? They are technically "not used" but by user choice, not neglect.
   - Recommendation: Show them in the inventory but mark as "user-disabled" rather than ghost. They still consume config space but are not actionable ghosts.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.x |
| Config file | `apps/ccaudit/vitest.config.ts` + `packages/internal/vitest.config.ts` (workspace projects) |
| Quick run command | `pnpm --filter @ccaudit/internal test` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCAN-01 | Ghost agents detected from file inventory vs invocations | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-agents.ts` | Wave 0 |
| SCAN-02 | Ghost skills detected from skill dirs vs invocations/skillUsage | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-skills.ts` | Wave 0 |
| SCAN-03 | Ghost MCP servers from claude.json + .mcp.json vs invocations | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-mcp.ts` | Wave 0 |
| SCAN-04 | Stale memory files detected via mtime heuristic | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-memory.ts` | Wave 0 |
| SCAN-05 | Likely ghost (7-30d) vs definite ghost (>30d/never) tiering | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/classify.ts` | Wave 0 |
| SCAN-06 | lastUsed date shown for every ghost item | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-all.ts` | Wave 0 |
| SCAN-07 | Per-project breakdown alongside global view | unit | `pnpm --filter @ccaudit/internal vitest run src/scanner/scan-all.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter @ccaudit/internal test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/internal/src/scanner/scan-agents.ts` -- covers SCAN-01 (in-source tests)
- [ ] `packages/internal/src/scanner/scan-skills.ts` -- covers SCAN-02 (in-source tests)
- [ ] `packages/internal/src/scanner/scan-mcp.ts` -- covers SCAN-03 (in-source tests)
- [ ] `packages/internal/src/scanner/scan-memory.ts` -- covers SCAN-04 (in-source tests)
- [ ] `packages/internal/src/scanner/classify.ts` -- covers SCAN-05 (in-source tests)
- [ ] `packages/internal/src/scanner/scan-all.ts` -- covers SCAN-06, SCAN-07 (in-source tests)
- [ ] `packages/internal/src/scanner/__fixtures__/` -- test fixture directory for mock configs and file structures

*(All test infrastructure exists from Phase 1/2: vitest workspace config, in-source test pattern. Only new source files with their embedded tests needed.)*

## Sources

### Primary (HIGH confidence)
- **Real filesystem inspection** (this machine): `~/.claude/agents/` (171 `.md` files), `~/.claude/skills/` (11 entries), `~/.claude.json` (full structure with `mcpServers`, `projects`, `skillUsage`), `.mcp.json` examples
- **Real JSONL data** (this machine): `subagent_type` values (built-in `Explore` + custom `gsd-executor`), `input.skill` values (`gsd:plan-phase`), MCP invocation patterns
- **Phase 2 source code**: `packages/internal/src/parser/` -- `InvocationRecord`, `ParsedSessionResult`, `extractInvocations()`, `discoverSessionFiles()` implementations
- **Phase 1 types**: `packages/internal/src/types.ts` -- `GhostItem`, `GhostTier`, `ItemCategory`, `ClaudePaths`

### Secondary (MEDIUM confidence)
- **`~/.claude.json` `skillUsage` field**: Confirmed present with `usageCount` and `lastUsedAt` timestamps. Structure verified via `python3` JSON parsing.
- **`disabledMcpServers` and `disabledMcpjsonServers` fields**: Confirmed present in `~/.claude.json` per-project config. `disabledMcpServers` is a string array.

### Tertiary (LOW confidence)
- **Skill name resolution via `SKILL.md`**: The `name:` field in `SKILL.md` may not always match what appears in `skillUsage` keys. Needs validation during implementation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All tools already installed from Phase 1/2, no new dependencies
- Architecture: HIGH - Four scanner modules with clear boundaries, grounded in real filesystem inspection
- Pitfalls: HIGH - Validated against real data on this machine (agent name mismatch, skill namespace difference, MCP deduplication)
- Skill matching: MEDIUM - `SKILL.md` `name:` field mapping is heuristic; `skillUsage` provides authoritative timestamps but directory-to-registered-name mapping needs validation

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (stable -- filesystem structures unlikely to change)
