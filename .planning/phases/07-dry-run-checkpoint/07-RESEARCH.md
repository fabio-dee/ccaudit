# Phase 7: Dry-Run & Checkpoint - Research

**Researched:** 2026-04-04
**Domain:** Pure functions + Node builtins (no new deps); CLI integration on top of Phase 6 output-mode infrastructure.
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**--dry-run flag mechanics**
- **D-01:** `--dry-run` is a boolean flag on the default `ghostCommand` (`apps/ccaudit/src/cli/commands/ghost.ts`). No dedicated `dry-run` subcommand.
- **D-02:** `--dry-run` honors every Phase 6 output mode (`--json`, `--csv`, `--quiet`, `--ci`, `--no-color`, `--verbose`).
- **D-03:** Exit code on successful dry-run is **always 0** when scan + checkpoint write succeed — even when the plan is empty. Non-zero only for genuine errors.
- **D-04:** A zero-ghost dry-run **still writes the checkpoint**.
- **D-05:** When `--dry-run` is active, default rendered output is replaced with change-plan rendering. The Phase 5 footer "Dry-run coming in v1.1" is replaced with a checkpoint confirmation line.

**Change-plan layout & scope**
- **D-06:** Rendered output is **grouped by action verb** via `renderChangePlan(plan)` in `@ccaudit/terminal`. Header uses `renderHeader('👻', 'Dry-Run', ...)`.
- **D-07:** The change plan includes Archive tier (definite-ghost agents/skills), Disable tier (definite-ghost AND likely-ghost MCP servers), Flag tier (stale memory files, `tier !== 'used'`). `likely-ghost` agents/skills are excluded.
- **D-08:** `calculateDryRunSavings(plan)` = sum of `tokenEstimate.tokens` for Archive + Disable tiers only. Memory files excluded from savings (flagged, not moved). Label: `"~Xk tokens (definite ghosts only)"`.
- **D-09:** `--verbose` appends a per-item listing after the grouped summary.

**Hash input scope**
- **D-10:** `ghost_hash` is computed over **archive-eligible items only**.
- **D-11:** Canonical record shape:
  - Agent/Skill (definite-ghost): `{ category, scope, projectPath, path, mtimeMs }`
  - MCP server: `{ category: 'mcp-server', scope, projectPath, serverName, sourcePath, configMtimeMs }`
  - Memory file (any stale tier): `{ category: 'memory', scope, path, mtimeMs }`
- **D-11a:** MCP includes both definite-ghost AND likely-ghost. Agents/skills: only definite-ghost.
- **D-12:** Canonicalization: sort by `(category, scope, projectPath ?? '', path ?? serverName)` using `String.localeCompare` with `'en-US-POSIX'`. Stable key order inside records. `JSON.stringify(sortedArray)` single-line. `crypto.createHash('sha256').update(json, 'utf8').digest('hex')`. Prefix: `"sha256:"`.
- **D-13:** `mtimeMs` = raw integer ms from `fs.stat`. Batched via `Promise.all`.
- **D-14:** `configMtimeMs` computed once per unique `sourcePath`, cached in a `Map<sourcePath, mtimeMs>`.
- **D-15:** `--since` window is **NOT** part of the hash.
- **D-16:** Tier is NOT in the hash beyond the filter in D-11.

**Checkpoint file schema**
- **D-17:** Checkpoint JSON fields: `checkpoint_version: 1`, `ccaudit_version` (build-time injected), `timestamp` (ISO-8601 UTC), `since_window`, `ghost_hash`, `item_count: { agents, skills, mcp, memory }`, `savings: { tokens }`. All mandatory.
- **D-18:** Checkpoint path: `~/.claude/ccaudit/.last-dry-run` (literal, legacy-only). `fs.mkdir(dir, { recursive: true, mode: 0o700 })`. File mode `0o600`.
- **D-19:** Checkpoint write uses atomic write: `~/.claude/ccaudit/.last-dry-run.tmp-<pid>` → `fs.writeFile` → `fs.rename` onto final path.
- **D-20:** Checkpoint errors are fatal: `process.exitCode = 2`. Change-plan output still rendered to stdout before checkpoint failure.

### Claude's Discretion
- Footer CTA wording after checkpoint write
- Module placement inside `@ccaudit/internal` (recommend `packages/internal/src/remediation/`)
- Human-relative last-used formatting in `--verbose` listing
- Column widths and spacing in grouped summary
- `ccaudit_version` build-time injection mechanism (define vs generated version.ts)
- In-source test fixture layout
- CSV column schema for `--dry-run --csv` (recommend `action,category,name,scope,projectPath,path,tokens,tier`)
- JSON envelope field ordering
- Whether JSON includes full canonical hash input (recommend: final hash only)

### Deferred Ideas (OUT OF SCOPE)
- `--dry-run --list` / per-item plan inspection subcommand
- Checkpoint history / rollback multi-checkpoint storage
- Per-project scoped checkpoints
- SHA-3 / BLAKE3 hash upgrade
- Dry-run TUI / interactive selection
- Checkpoint TTL / time-based expiry (explicitly rejected)
- XDG path for checkpoint
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DRYR-01 | `ccaudit --dry-run` outputs a full change plan (archives, disables, savings) without modifying files | `buildChangePlan(enriched)` pure function + `renderChangePlan(plan, mode)` in `@ccaudit/terminal` + existing `ghostCommand` wiring with a new `dryRun` boolean arg; CLI path branches on `ctx.values.dryRun` BEFORE output-mode routing, feeding the same plan object through all four output branches (default/json/csv/quiet). |
| DRYR-02 | Checkpoint written to `~/.claude/ccaudit/.last-dry-run` with timestamp + SHA-256 hash of current ghost inventory | `computeGhostHash(enriched)` applies canonical algorithm from D-10/D-12; `writeCheckpoint(checkpoint)` handles atomic write (D-19), directory creation (D-18), and error propagation (D-20); schema matches D-17 exactly. |
| DRYR-03 | Checkpoint invalidated when ghost inventory hash changes (hash-based, not time-based) | Phase 7 only writes; Phase 8 reads. `readCheckpoint()` ships in Phase 7 so Phase 8 has a pre-built, tested parser. Hash determinism across runs is the whole invalidation mechanism — same input → same hash, any change → different hash. |
</phase_requirements>

## Summary

Phase 7 adds two new capabilities to ccaudit with **zero runtime dependency changes**: (1) a pure-function pipeline that filters `TokenCostResult[]` into a typed `ChangePlan` and (2) a small checkpoint module that computes a deterministic SHA-256 hash of the archive-eligible inventory, writes it atomically to `~/.claude/ccaudit/.last-dry-run`, and exposes a symmetric read API for Phase 8. Everything hangs off a single `dryRun` boolean flag on the existing `ghostCommand`; the output-mode resolver, JSON envelope, CSV/quiet emitters, and `initColor()` path from Phase 6 are reused unchanged. The rendering layer gets one new file, `packages/terminal/src/tables/change-plan.ts`, that reuses `renderHeader`, `humanizeSinceWindow`, `colorize`, and the `formatTokenShort` idiom from the existing ghost table.

The three technical risks the brief flagged all resolved cleanly in verification: `en-US-POSIX` is a real ICU locale in Node 22 (resolves to `en-US-u-va-posix`), `crypto.createHash('sha256')` has the exact API shape D-12 expects, and atomic-write via `writeFile` + `rename` works on macOS with file mode `0o600` preserved. The only sub-decision requiring planner judgment is `ccaudit_version` injection: a generated `src/version.ts` from a prebuild script is simpler than tsdown `define` and sidesteps the NodeNext `rootDir: "./src"` constraint that prevents a direct `import ... from '../package.json' with { type: 'json' }`.

**Primary recommendation:** One new directory (`packages/internal/src/remediation/` with four files: `change-plan.ts`, `savings.ts`, `checkpoint.ts`, `index.ts`), one new terminal renderer (`packages/terminal/src/tables/change-plan.ts`), one new version module (`apps/ccaudit/src/_version.ts`, generated by a `prebuild` script), and a single diff in `ghost.ts` that branches on `ctx.values.dryRun` before the existing output-routing chain. All new logic is covered by in-source vitest tests; integration tests live in `apps/ccaudit/src/__tests__/` next to the existing `ghost-command.test.ts`.

## Module Layout

### New files

```
packages/internal/src/remediation/
├── change-plan.ts      # ChangePlan types + buildChangePlan(enriched) pure function
├── savings.ts          # calculateDryRunSavings(plan): number
├── checkpoint.ts       # Checkpoint type + computeGhostHash + readCheckpoint + writeCheckpoint
└── index.ts            # Barrel re-exports for the remediation module

packages/terminal/src/tables/
└── change-plan.ts      # renderChangePlan(plan, opts) + renderChangePlanVerbose(plan)

apps/ccaudit/src/
└── _version.ts         # Generated from apps/ccaudit/package.json by scripts/generate-version.mjs
                        # Contains: export const CCAUDIT_VERSION = '0.0.1';
                        # Underscore prefix excludes it from tsdown entry (per tsdown.config.ts line 4)

apps/ccaudit/scripts/
└── generate-version.mjs  # Prebuild + pretest step: reads package.json, writes _version.ts
```

### Modified files

| File | Change |
|------|--------|
| `packages/internal/src/index.ts` | Add barrel exports for `./remediation/index.ts` (ChangePlan, ChangePlanItem, Checkpoint, buildChangePlan, calculateDryRunSavings, computeGhostHash, readCheckpoint, writeCheckpoint) |
| `packages/terminal/src/tables/index.ts:1-7` | Add `export { renderChangePlan, renderChangePlanVerbose } from './change-plan.ts';` |
| `packages/terminal/src/index.ts:2-13` | Re-export the two new renderers from `./tables/index.ts` |
| `packages/terminal/src/tables/ghost-table.ts:93-97` | `renderGhostFooter(sinceWindow)` — suppress the "Dry-run coming in v1.1" line when a new optional `options.dryRunActive` is true; keep it in non-dry-run mode until v1.2 |
| `apps/ccaudit/src/cli/commands/ghost.ts:28-51` | Add `dryRun: { type: 'boolean', description: 'Preview changes without mutating files', default: false }` to the `args` object |
| `apps/ccaudit/src/cli/commands/ghost.ts:52-242` | Add an early branch after enrichment: `if (ctx.values.dryRun) { return runDryRun(enriched, sinceStr, mode, files, projectPaths); }` — new helper function at bottom of file |
| `apps/ccaudit/package.json:40-45` | Add `"prebuild": "node scripts/generate-version.mjs"` and `"pretest": "node scripts/generate-version.mjs"` to scripts; ensure `_version.ts` is git-ignored |
| `.gitignore` (root) | Add `apps/ccaudit/src/_version.ts` |

**Why this layout:** The `remediation/` directory naming matches CONTEXT.md Claude's Discretion recommendation and the Phase 8 preview in `<code_context>`. Keeping `change-plan.ts`, `savings.ts`, and `checkpoint.ts` as three small files (rather than one mega-file) lets vitest in-source tests stay focused and mirrors the Phase 3 scanner split (`scan-agents.ts`, `scan-skills.ts`, etc.). Phase 8 will add `archive.ts`, `disable-mcp.ts`, `flag-memory.ts`, and `restore-manifest.ts` to the same directory.

## Data Model

```typescript
// packages/internal/src/remediation/change-plan.ts

import type { TokenCostResult } from '../token/types.ts';
import type { ItemScope, ItemCategory } from '../types.ts';

/**
 * Action verbs grouping items in the change plan.
 * - archive: agents + skills (definite-ghost) → moved to _archived/ in Phase 8
 * - disable: MCP servers (definite-ghost OR likely-ghost) → key-renamed in Phase 8
 * - flag:    memory files (any stale tier) → frontmatter added in Phase 8
 */
export type ChangePlanAction = 'archive' | 'disable' | 'flag';

/**
 * A single item that would be modified by --dangerously-bust-ghosts.
 * Category narrows what fields are meaningful: MCP servers carry serverName +
 * sourcePath instead of a file path; agents/skills carry path + mtimeMs.
 */
export interface ChangePlanItem {
  action: ChangePlanAction;
  category: ItemCategory;         // 'agent' | 'skill' | 'mcp-server' | 'memory'
  scope: ItemScope;               // 'global' | 'project'
  name: string;                   // Display name (agent basename, skill dir, MCP key, memory filename)
  projectPath: string | null;     // Absolute project path for project-scoped items
  path: string;                   // Agent/skill/memory: absolute file path. MCP: source config path (sourcePath).
  tokens: number;                 // tokenEstimate.tokens ?? 0 (raw integer; renderer formats)
  tier: 'definite-ghost' | 'likely-ghost';  // Source tier (memory normalizes to 'definite-ghost' for display)
}

/**
 * The full change plan — grouped by action and typed for both renderers
 * (renderChangePlan) and JSON emission (buildJsonEnvelope payload).
 */
export interface ChangePlan {
  archive: ChangePlanItem[];      // Agents + skills (definite-ghost only)
  disable: ChangePlanItem[];      // MCP servers (definite-ghost OR likely-ghost per D-11a)
  flag: ChangePlanItem[];         // Memory files (tier !== 'used')
  counts: {
    agents: number;
    skills: number;
    mcp: number;
    memory: number;
  };
  savings: {
    tokens: number;               // calculateDryRunSavings(plan) result; raw integer per D-17
  };
}
```

```typescript
// packages/internal/src/remediation/checkpoint.ts

/**
 * Checkpoint schema version 1. Phase 8 reads this and refuses unknown versions.
 * Do not add fields without bumping checkpoint_version and updating readCheckpoint.
 */
export interface Checkpoint {
  checkpoint_version: 1;
  ccaudit_version: string;        // From CCAUDIT_VERSION build constant (apps/ccaudit/src/_version.ts)
  timestamp: string;              // ISO-8601 UTC, e.g., "2026-04-04T18:30:00.000Z"
  since_window: string;           // Raw --since string the user passed, e.g., "7d"
  ghost_hash: string;             // "sha256:" + hex digest
  item_count: {
    agents: number;
    skills: number;
    mcp: number;
    memory: number;
  };
  savings: {
    tokens: number;               // Raw integer (Phase 8 re-formats)
  };
}

/** Internal canonical-record types used by computeGhostHash. Not exported. */
interface AgentSkillHashRecord {
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  projectPath: string | null;
  path: string;
  mtimeMs: number;
}
interface McpHashRecord {
  category: 'mcp-server';
  scope: 'global' | 'project';
  projectPath: string | null;
  serverName: string;
  sourcePath: string;
  configMtimeMs: number;
}
interface MemoryHashRecord {
  category: 'memory';
  scope: 'global' | 'project';
  path: string;
  mtimeMs: number;
}
type HashRecord = AgentSkillHashRecord | McpHashRecord | MemoryHashRecord;
```

Notes:
- `ChangePlanItem.tokens` is `number` not `number | null` because the renderer and savings math both need a definite value; `tokenEstimate?.tokens ?? 0` is applied at build time inside `buildChangePlan`.
- `Checkpoint.checkpoint_version` is a literal `1` (not `number`) so TypeScript catches accidental bumps without a codepath update.
- The three internal hash-record types are a discriminated union on `category`; they stay internal because nothing outside `checkpoint.ts` should know about the canonical form.

## Hash Algorithm

The algorithm is a literal transcription of D-10 through D-16 using `node:crypto.createHash`:

```typescript
// packages/internal/src/remediation/checkpoint.ts

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { TokenCostResult } from '../token/types.ts';

/**
 * Compute the deterministic SHA-256 hash of the archive-eligible inventory.
 *
 * Steps (D-12):
 *  1. Filter `enriched` to the exact set Phase 8 would mutate (D-10, D-11a)
 *  2. For each eligible item, stat() its file to fetch mtimeMs (D-13)
 *  3. For MCP items, stat() the sourcePath once per unique path, cache in Map (D-14)
 *  4. Build canonical records with stable key order (D-11)
 *  5. Sort records by (category, scope, projectPath ?? '', path ?? serverName)
 *     using String.localeCompare with 'en-US-POSIX' locale (D-12, verified in Node 22)
 *  6. JSON.stringify the sorted array (single line, default spacing = no spacing)
 *  7. sha256 the UTF-8 bytes of the JSON string
 *  8. Return "sha256:" + hexDigest (D-12 literal prefix)
 */
export async function computeGhostHash(enriched: TokenCostResult[]): Promise<string> {
  // Step 1: filter
  const eligible = enriched.filter((r) => {
    if (r.item.category === 'agent' || r.item.category === 'skill') {
      return r.tier === 'definite-ghost';  // D-11a: archive is definite-only
    }
    if (r.item.category === 'mcp-server') {
      return r.tier !== 'used';            // D-11a: disable widens to include likely-ghost
    }
    if (r.item.category === 'memory') {
      return r.tier !== 'used';            // D-11: any stale tier
    }
    return false;
  });

  // Step 2-3: stat batch with per-sourcePath cache for MCP (D-14)
  const mcpConfigMtimeCache = new Map<string, number>();
  const records: HashRecord[] = await Promise.all(
    eligible.map(async (r): Promise<HashRecord> => {
      if (r.item.category === 'mcp-server') {
        // serverName = r.item.name; sourcePath = r.item.path (already set by scanMcpServers)
        let configMtimeMs = mcpConfigMtimeCache.get(r.item.path);
        if (configMtimeMs === undefined) {
          const s = await stat(r.item.path);
          configMtimeMs = s.mtimeMs;
          mcpConfigMtimeCache.set(r.item.path, configMtimeMs);
        }
        return {
          category: 'mcp-server',
          scope: r.item.scope,
          projectPath: r.item.projectPath,
          serverName: r.item.name,
          sourcePath: r.item.path,
          configMtimeMs,
        };
      }
      if (r.item.category === 'memory') {
        // Memory scanner populates mtimeMs already (scan-memory.ts:29)
        return {
          category: 'memory',
          scope: r.item.scope,
          path: r.item.path,
          mtimeMs: r.item.mtimeMs ?? (await stat(r.item.path)).mtimeMs,
        };
      }
      // Agent / skill: scanners do NOT populate mtimeMs (see scan-agents.ts, scan-skills.ts);
      // stat on demand here (see "mtimeMs Strategy" section for rationale)
      const mtimeMs = r.item.mtimeMs ?? (await stat(r.item.path)).mtimeMs;
      return {
        category: r.item.category as 'agent' | 'skill',
        scope: r.item.scope,
        projectPath: r.item.projectPath,
        path: r.item.path,
        mtimeMs,
      };
    }),
  );

  // Step 5: deterministic sort with stable POSIX locale
  records.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category, 'en-US-POSIX');
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope, 'en-US-POSIX');
    const ap = ('projectPath' in a ? a.projectPath : null) ?? '';
    const bp = ('projectPath' in b ? b.projectPath : null) ?? '';
    if (ap !== bp) return ap.localeCompare(bp, 'en-US-POSIX');
    const akey = 'serverName' in a ? a.serverName : a.path;
    const bkey = 'serverName' in b ? b.serverName : b.path;
    return akey.localeCompare(bkey, 'en-US-POSIX');
  });

  // Step 4 (stable key order) + Step 6: canonicalize each record. We construct
  // plain objects literal-by-literal in a fixed order so JSON.stringify emits
  // keys in that order (ES2015+ guarantees insertion-order for string keys).
  const canonicalArray = records.map((r) => {
    if (r.category === 'mcp-server') {
      return {
        category: r.category,
        scope: r.scope,
        projectPath: r.projectPath,
        serverName: r.serverName,
        sourcePath: r.sourcePath,
        configMtimeMs: r.configMtimeMs,
      };
    }
    if (r.category === 'memory') {
      return {
        category: r.category,
        scope: r.scope,
        path: r.path,
        mtimeMs: r.mtimeMs,
      };
    }
    return {
      category: r.category,
      scope: r.scope,
      projectPath: r.projectPath,
      path: r.path,
      mtimeMs: r.mtimeMs,
    };
  });
  const canonicalJson = JSON.stringify(canonicalArray);

  // Step 7-8: hash and prefix
  const hexDigest = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return `sha256:${hexDigest}`;
}
```

**Worked stability example.** Given two agents (`a.md` with mtime 1712000000000 scope:global, `b.md` with mtime 1712000000001 scope:project projectPath:/p) where the scan order is `[b, a]` on run 1 and `[a, b]` on run 2:

- Run 1 sort keys: `('agent', 'global', '', '/.../a.md')`, `('agent', 'project', '/p', '/.../b.md')` → sorted `[a, b]`
- Run 2 sort keys: identical → sorted `[a, b]`
- Canonical JSON (run 1 & 2 identical): `[{"category":"agent","scope":"global","projectPath":null,"path":"/.../a.md","mtimeMs":1712000000000},{"category":"agent","scope":"project","projectPath":"/p","path":"/.../b.md","mtimeMs":1712000000001}]`
- Hash: identical `sha256:<same>` → checkpoint valid.

If `b.md` is then touched (mtime bumps to 1712000000500), run 3 produces a different canonical JSON → different hash → Phase 8 refuses the stale checkpoint. This is the entire invalidation mechanism for DRYR-03.

**Locale verification (HIGH confidence):** Confirmed in Node 22.20.0 that `new Intl.Collator('en-US-POSIX')` resolves to `en-US-u-va-posix` — a valid ICU variant locale. Sort output: `['Apple', 'Banana', 'apple', 'banana']` (uppercase-first, case-sensitive — the traditional POSIX/C sort order). This contrasts with `'en'` which case-folds (`['apple', 'Apple', 'banana', 'Banana']`). POSIX ordering is the correct choice: it's deterministic regardless of OS, and the sort outcome is identical on Linux, macOS, and Windows.

## Atomic Checkpoint Write

```typescript
// packages/internal/src/remediation/checkpoint.ts

import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Resolve the canonical checkpoint file path (D-18).
 * Always ~/.claude/ccaudit/.last-dry-run — no XDG fallback (explicitly rejected).
 */
export function resolveCheckpointPath(): string {
  return path.join(homedir(), '.claude', 'ccaudit', '.last-dry-run');
}

/**
 * Write the checkpoint atomically (D-19).
 *
 * Semantics:
 * - Ensures parent dir exists with mode 0o700 (rwx for owner only)
 * - Writes to a .tmp-<pid> sibling file with mode 0o600 (rw for owner only)
 * - Renames onto the final path (atomic on POSIX; overwrite-semantics on Windows)
 * - On any failure, attempts to unlink the tmp file before rethrowing (best-effort)
 *
 * Errors are propagated to the caller unchanged — the dry-run command handler
 * converts them into process.exitCode = 2 per D-20.
 */
export async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const finalPath = resolveCheckpointPath();
  const dir = path.dirname(finalPath);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;

  // D-18: mkdir with mode 0o700, recursive:true silently succeeds if dir already exists.
  // Note: mode is a no-op on Windows (NTFS ignores POSIX permission bits). On Unix,
  // mkdir recursive applies mode to all newly-created segments.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(checkpoint, null, 2);  // Pretty-printed for human inspection

  try {
    // D-18: file mode 0o600 (owner rw only). On Windows this is approximated; the
    // file will be created with default NTFS ACLs but the bit is honored where possible.
    await writeFile(tmpPath, body, { mode: 0o600, encoding: 'utf8' });
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file (ignore unlink errors)
    try { await unlink(tmpPath); } catch { /* swallow */ }
    throw err;
  }
}
```

**Cross-platform verification (HIGH):**
- macOS/Linux: `fs.rename` is atomic on same-filesystem renames (POSIX guarantee). Verified locally: `fs.rename` onto an existing file **replaces** the target, `stat().mode & 0o777 === 0o600` after `writeFile({ mode: 0o600 })`.
- Windows: `fs.rename` over an existing file works on Node 20+ but can return `EPERM` under rare conditions (antivirus locks, another process holding a handle). The Phase 8 plan already notes this ([`STATE.md` blocker: "Windows fs.rename EPERM handling untested"](.planning/STATE.md:149)) and is tracked as a Phase 8 concern. **Phase 7 does NOT need to handle EPERM retry** because:
  1. The checkpoint target is under the user's home — no other tool races for it
  2. Phase 8 is where remediation mutates `~/.claude.json`, which IS at risk of concurrent writes and will add the retry logic there (RMED-09)
  3. On a Phase 7 write failure, D-20 prescribes exit code 2 with a clear error message — that's sufficient signal on Windows v1.1

**Error taxonomy:**

| Condition | Node error | Propagates as |
|-----------|-----------|---------------|
| `$HOME` not writable | `EACCES` on mkdir or writeFile | Thrown; caller sets `process.exitCode = 2` |
| Disk full | `ENOSPC` on writeFile | Thrown; exit 2 |
| `~/.claude/ccaudit` exists as a file (not dir) | `ENOTDIR` on mkdir | Thrown; exit 2 |
| Read-only filesystem | `EROFS` on writeFile | Thrown; exit 2 |
| Rename target locked (Windows) | `EPERM` on rename | Thrown; exit 2 (no retry in Phase 7) |
| Tmp file orphaned by crash | — | Next write overwrites with new `.tmp-<pid>`; manual cleanup not required |

**Unique tmp suffix choice:** `process.pid` is sufficient because (a) the dry-run command is a one-shot CLI execution (not a long-running daemon), (b) two concurrent `ccaudit --dry-run` invocations by the same user would have different PIDs, and (c) orphaned `.tmp-<pid>` files from crashed runs are harmless (the next successful run writes to a new suffix and the old tmp is eventually cleaned up by the user or left to `~/.claude/ccaudit` housekeeping). `crypto.randomUUID()` is equally viable but adds a line with no behavioral improvement.

## Checkpoint Read API

Phase 7 ships `readCheckpoint()` so Phase 8 can consume the parser without duplication:

```typescript
// packages/internal/src/remediation/checkpoint.ts

import { readFile } from 'node:fs/promises';

/**
 * Result of attempting to read the checkpoint file.
 * null result for missing file (expected: no prior dry-run);
 * discriminated error types for invalid file (actionable errors for Phase 8).
 */
export type ReadCheckpointResult =
  | { status: 'ok'; checkpoint: Checkpoint }
  | { status: 'missing' }                                    // File does not exist
  | { status: 'parse-error'; message: string }               // JSON.parse threw
  | { status: 'unknown-version'; version: number }           // checkpoint_version !== 1
  | { status: 'schema-mismatch'; missingField: string };     // Required field absent

/**
 * Read and validate the checkpoint file at ~/.claude/ccaudit/.last-dry-run.
 *
 * Returns a discriminated result. Never throws for the expected paths
 * (missing/parse-error/unknown-version) because Phase 8 needs to branch on
 * each distinct failure to print a specific user-facing error message.
 *
 * Unexpected I/O errors (permission denied, etc.) are propagated to the caller.
 */
export async function readCheckpoint(): Promise<ReadCheckpointResult> {
  const checkpointPath = resolveCheckpointPath();

  let raw: string;
  try {
    raw = await readFile(checkpointPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    throw err;  // EACCES, EROFS, etc. propagate
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'parse-error', message: (err as Error).message };
  }

  // Version gate before any other field checks — forward-compatibility hedge
  if (
    typeof parsed !== 'object' || parsed === null ||
    !('checkpoint_version' in parsed) ||
    (parsed as { checkpoint_version: unknown }).checkpoint_version !== 1
  ) {
    const version = (parsed as { checkpoint_version?: number } | null)?.checkpoint_version ?? -1;
    return { status: 'unknown-version', version };
  }

  // Shallow required-field check. We intentionally do NOT use a heavy schema
  // validator (valibot) here — Phase 7 writes these files itself with a fixed
  // schema, and a runtime pass would only catch corrupted/hand-edited files.
  // The field list must match D-17 exactly.
  const required = [
    'checkpoint_version', 'ccaudit_version', 'timestamp', 'since_window',
    'ghost_hash', 'item_count', 'savings',
  ] as const;
  for (const field of required) {
    if (!(field in (parsed as object))) {
      return { status: 'schema-mismatch', missingField: field };
    }
  }

  return { status: 'ok', checkpoint: parsed as Checkpoint };
}
```

**Design rationale:**
- **Discriminated union, not `Checkpoint | null`:** Phase 8's block messages per-failure-mode need to differ ("no dry-run found" vs "dry-run file corrupted" vs "dry-run from newer ccaudit version — upgrade required"). A bare `null` would force Phase 8 to re-read the file to classify.
- **No valibot:** The project uses valibot for *external* data (JSONL sessions, MCP estimates JSON). The checkpoint file is written by ccaudit itself, so a full schema validator adds bundle weight without catching realistic failures. A seven-field `in`-check is enough.
- **No byethrow Result:** ccusage uses `@praha/byethrow` for chained I/O pipelines (see STACK.md). Phase 7's read path is a single linear flow — a discriminated union reads more naturally than `Result.andThen` chaining. Phase 8 can wrap in Result if needed downstream.

## Change-Plan Builder

```typescript
// packages/internal/src/remediation/change-plan.ts

import type { TokenCostResult } from '../token/types.ts';
import type { ChangePlan, ChangePlanItem, ChangePlanAction } from './change-plan.ts';

/**
 * Build a ChangePlan from enriched scan results.
 *
 * Filter rules (D-07, D-11a):
 *  - archive: agents + skills with tier === 'definite-ghost'
 *  - disable: MCP servers with tier !== 'used' (definite + likely)
 *  - flag:    memory files with tier !== 'used'
 *  - likely-ghost agents/skills are EXCLUDED from the plan (monitor-only per Phase 5 D-12)
 *
 * Savings math (D-08): calculated via calculateDryRunSavings over archive + disable only.
 * Memory tokens are NOT counted because memory files are flagged, not moved.
 *
 * Pure function: no I/O, no global state. All classification comes from the enriched
 * TokenCostResult input which was produced by scanAll() + enrichScanResults() upstream.
 */
export function buildChangePlan(enriched: TokenCostResult[]): ChangePlan {
  const archive: ChangePlanItem[] = [];
  const disable: ChangePlanItem[] = [];
  const flag: ChangePlanItem[] = [];

  for (const r of enriched) {
    const base = {
      category: r.item.category,
      scope: r.item.scope,
      name: r.item.name,
      projectPath: r.item.projectPath,
      path: r.item.path,
      tokens: r.tokenEstimate?.tokens ?? 0,
      tier: r.tier as 'definite-ghost' | 'likely-ghost',
    };

    if (r.item.category === 'agent' || r.item.category === 'skill') {
      if (r.tier === 'definite-ghost') {
        archive.push({ action: 'archive', ...base });
      }
      continue;
    }
    if (r.item.category === 'mcp-server') {
      if (r.tier !== 'used') {
        disable.push({ action: 'disable', ...base });
      }
      continue;
    }
    if (r.item.category === 'memory') {
      if (r.tier !== 'used') {
        flag.push({ action: 'flag', ...base });
      }
      continue;
    }
  }

  const counts = {
    agents: archive.filter((i) => i.category === 'agent').length,
    skills: archive.filter((i) => i.category === 'skill').length,
    mcp: disable.length,
    memory: flag.length,
  };

  const savings = { tokens: calculateDryRunSavings({ archive, disable, flag, counts, savings: { tokens: 0 } }) };

  return { archive, disable, flag, counts, savings };
}
```

**Filter correctness check against D-07 / D-11 / D-11a:**

| Tier × Category | Archive? | Disable? | Flag? | Hash input? |
|-----------------|----------|----------|-------|-------------|
| agent definite-ghost | ✓ | — | — | ✓ |
| agent likely-ghost | ✗ | — | — | ✗ (monitor-only) |
| skill definite-ghost | ✓ | — | — | ✓ |
| skill likely-ghost | ✗ | — | — | ✗ |
| mcp definite-ghost | — | ✓ | — | ✓ |
| mcp likely-ghost | — | ✓ | — | ✓ (widened per D-11a) |
| memory likely-ghost | — | — | ✓ | ✓ |
| memory definite-ghost | — | — | ✓ | ✓ |
| anything used | — | — | — | ✗ |

## Savings Calculation

```typescript
// packages/internal/src/remediation/savings.ts

import type { ChangePlan } from './change-plan.ts';

/**
 * Calculate estimated token savings from executing the change plan (D-08).
 *
 * Formula: sum of tokens across archive + disable items.
 * Memory files (flag tier) are EXCLUDED because they are flagged, not moved —
 * they still load, so no tokens are reclaimed on the next session.
 *
 * This is distinct from calculateTotalOverhead(ghosts) which sums all ghost
 * token cost including monitor-tier (likely-ghost) items. The dry-run savings
 * is honest: it's exactly what --dangerously-bust-ghosts will reclaim.
 */
export function calculateDryRunSavings(plan: ChangePlan): number {
  let total = 0;
  for (const item of plan.archive) total += item.tokens;
  for (const item of plan.disable) total += item.tokens;
  // Intentionally skip plan.flag — memory files still load.
  return total;
}
```

**Worked example.** Given an enriched scan result containing:

- 128 definite-ghost agents totaling 47000 tokens
- 82 definite-ghost skills totaling 18000 tokens (capped at 500 each, see `estimate.ts:42-49`)
- 4 MCP servers: 3 definite-ghost + 1 likely-ghost, totaling 32000 tokens
- 12 likely-ghost agents totaling 8000 tokens (EXCLUDED from plan — monitor only)
- 6 stale memory files totaling 12000 tokens (INCLUDED in plan as flag, EXCLUDED from savings)

Then:
- `calculateTotalOverhead(ghosts)` = 47000 + 18000 + 32000 + 8000 + 12000 = **117000 tokens** (Phase 5 display: "total ghost overhead")
- `calculateDryRunSavings(plan)` = 47000 + 18000 + 32000 = **97000 tokens** (Phase 7 display: "Estimated savings: ~97k tokens (definite ghosts only)")

The ~20k token gap (12 likely-ghost agents + 6 memory files) is intentional and honest: bust-ghosts will not reclaim those tokens.

## CLI Integration

**File: `apps/ccaudit/src/cli/commands/ghost.ts`**

**Change 1** — add the `dryRun` arg to the `args` declaration (insert between `verbose` and the closing brace at line 50):

```typescript
// apps/ccaudit/src/cli/commands/ghost.ts:28-51
export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  args: {
    ...outputArgs,
    since: { /* unchanged, line 33-38 */ },
    json: { /* unchanged, line 39-44 */ },
    verbose: { /* unchanged, line 45-50 */ },
    dryRun: {
      type: 'boolean',
      description: 'Preview changes without mutating files (writes checkpoint to ~/.claude/ccaudit/.last-dry-run)',
      default: false,
    },
  },
  // ...
});
```

gunshi auto-converts `dryRun` → `--dry-run` for the CLI arg, following the same camelCase→kebab-case convention as `--no-color` (though `--no-color` is root-level). `ctx.values.dryRun` is typed `boolean`.

**Change 2** — branch early on `dryRun` in the `run` handler. Insert the branch at `apps/ccaudit/src/cli/commands/ghost.ts:111` (right after `const enriched = await enrichScanResults(results);`):

```typescript
// apps/ccaudit/src/cli/commands/ghost.ts (inside run(), after line 111)

// Dry-run branch (Phase 7). Route to the change-plan path BEFORE the inventory
// rendering chain so all four output branches (default/json/csv/quiet) share
// the same plan + checkpoint data.
if (ctx.values.dryRun) {
  const plan = buildChangePlan(enriched);

  // Compute the hash and build the checkpoint object
  const ghostHash = await computeGhostHash(enriched);
  const checkpoint: Checkpoint = {
    checkpoint_version: 1,
    ccaudit_version: CCAUDIT_VERSION,       // from ../_version.ts (generated prebuild)
    timestamp: new Date().toISOString(),
    since_window: sinceStr,
    ghost_hash: ghostHash,
    item_count: plan.counts,
    savings: plan.savings,
  };

  // Render the change plan to stdout FIRST (D-20: user sees output even if write fails)
  if (mode.json) {
    const envelope = buildJsonEnvelope('ghost', sinceStr, 0, {
      dryRun: true,
      changePlan: {
        archive: plan.archive,
        disable: plan.disable,
        flag: plan.flag,
        counts: plan.counts,
        savings: plan.savings,
      },
      checkpoint: {
        path: resolveCheckpointPath(),
        ghost_hash: ghostHash,
        timestamp: checkpoint.timestamp,
      },
    });
    console.log(JSON.stringify(envelope, null, mode.quiet ? 0 : 2));
  } else if (mode.csv) {
    // CSV schema: action,category,name,scope,projectPath,path,tokens,tier (one row per item)
    const headers = ['action', 'category', 'name', 'scope', 'projectPath', 'path', 'tokens', 'tier'];
    const rows = [...plan.archive, ...plan.disable, ...plan.flag].map((i) => [
      i.action, i.category, i.name, i.scope, i.projectPath ?? '', i.path, String(i.tokens), i.tier,
    ]);
    console.log(csvTable(headers, rows, !mode.quiet));
  } else if (mode.quiet) {
    // TSV: one row per item (same columns as CSV, no header)
    for (const item of [...plan.archive, ...plan.disable, ...plan.flag]) {
      console.log(tsvRow([
        item.action, item.category, item.name, item.scope,
        item.projectPath ?? '', item.path, String(item.tokens), item.tier,
      ]));
    }
  } else {
    // Default rendered output (grouped-by-action + footer checkpoint line)
    console.log('');
    console.log(renderHeader('\u{1F47B}', 'Dry-Run', humanizeSinceWindow(sinceStr)));
    console.log('');
    console.log(renderChangePlan(plan));
    console.log('');
    if (mode.verbose) {
      console.log(renderChangePlanVerbose(plan));
      console.log('');
    }
    // Footer: checkpoint confirmation line replaces the Phase 5 footer
    console.log(`Checkpoint: ${resolveCheckpointPath()}`);
    console.log(`Next: ccaudit --dangerously-bust-ghosts`);
  }

  // D-20: checkpoint write happens LAST. Any error converts to exit code 2.
  try {
    await writeCheckpoint(checkpoint);
  } catch (err) {
    console.error(`[ccaudit] Failed to write checkpoint: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  // D-03: dry-run exits 0 on success even when the plan is empty
  return;
}

// ... existing non-dry-run path continues unchanged from line 113
```

**New imports at the top of `ghost.ts`:**

```typescript
import {
  // ... existing imports
  buildChangePlan,
  calculateDryRunSavings,  // only needed if we use it directly; currently called by buildChangePlan
  computeGhostHash,
  writeCheckpoint,
  readCheckpoint,          // not used in this file, but re-export to verify barrel hookup
  resolveCheckpointPath,
  type Checkpoint,
} from '@ccaudit/internal';
import {
  // ... existing imports
  renderChangePlan,
  renderChangePlanVerbose,
} from '@ccaudit/terminal';
import { CCAUDIT_VERSION } from '../_version.ts';
```

**Why early branch, not nested in the output chain:** The brief's option (B) from the Existing-Code-Insights note ("lift the decision earlier") is correct. Wrapping every output branch with `if (dryRun)` doubles the branch count and makes testing harder. Lifting once gives one test path per output mode per command mode (4 × 2 = 8 test cases) versus 16 for nested.

## Rendering Layer

```typescript
// packages/terminal/src/tables/change-plan.ts

import { colorize } from '../color.ts';
import type { ChangePlan, ChangePlanItem } from '@ccaudit/internal';

/**
 * Render the change plan as grouped-by-action plain text (D-06).
 * Matches the handoff mockup in docs/ccaudit-handoff-v6.md:127-143.
 *
 * Header is rendered by the caller via renderHeader('👻', 'Dry-Run', since).
 * This function emits ONLY the grouped body + savings line.
 *
 * Mode is informational only — color/quiet/etc are handled upstream via
 * colorize (which is a no-op when color is disabled).
 */
export function renderChangePlan(plan: ChangePlan): string {
  const lines: string[] = [];

  // Group 1: Archive
  if (plan.counts.agents > 0 || plan.counts.skills > 0) {
    lines.push(colorize.bold('Will ARCHIVE (reversible via `ccaudit restore <name>`):'));
    if (plan.counts.agents > 0) {
      lines.push(`  ${String(plan.counts.agents).padStart(3)} agents  → ~/.claude/agents/_archived/`);
    }
    if (plan.counts.skills > 0) {
      lines.push(`  ${String(plan.counts.skills).padStart(3)} skills  → ~/.claude/skills/_archived/`);
    }
    lines.push('');
  }

  // Group 2: Disable
  if (plan.counts.mcp > 0) {
    lines.push(colorize.bold('Will DISABLE in ~/.claude.json (key-rename, JSON-valid):'));
    lines.push(`  ${String(plan.counts.mcp).padStart(3)} MCP servers  (moved to \`ccaudit-disabled:<name>\` key)`);
    lines.push('');
  }

  // Group 3: Flag
  if (plan.counts.memory > 0) {
    lines.push(colorize.bold('Will FLAG in memory files (ccaudit-stale: true frontmatter, still load):'));
    lines.push(`  ${String(plan.counts.memory).padStart(3)} stale files`);
    lines.push('');
  }

  // Savings line — always present, even when zero (honest zero-state)
  const tokenDisplay = formatSavingsShort(plan.savings.tokens);
  lines.push(colorize.bold(`Estimated savings: ${tokenDisplay} (definite ghosts only)`));

  return lines.join('\n');
}

/**
 * Render the per-item verbose listing (D-09).
 * Appends to renderChangePlan output when --verbose is active.
 */
export function renderChangePlanVerbose(plan: ChangePlan): string {
  const lines: string[] = [];
  lines.push(colorize.dim('Per-item listing:'));
  for (const item of [...plan.archive, ...plan.disable, ...plan.flag]) {
    const scope = item.scope === 'project' ? `project:${item.projectPath}` : 'global';
    lines.push(`  • ${item.action} ${item.category} ${item.name} (${scope}) — ~${item.tokens} tokens, path: ${item.path}`);
  }
  return lines.join('\n');
}

function formatSavingsShort(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}
```

**ASCII sketch — matches D-06 exactly:**

```
👻 Dry-Run — Last 7 days
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Will ARCHIVE (reversible via `ccaudit restore <name>`):
  128 agents  → ~/.claude/agents/_archived/
   82 skills  → ~/.claude/skills/_archived/

Will DISABLE in ~/.claude.json (key-rename, JSON-valid):
    4 MCP servers  (moved to `ccaudit-disabled:<name>` key)

Will FLAG in memory files (ccaudit-stale: true frontmatter, still load):
    6 stale files

Estimated savings: ~97k tokens (definite ghosts only)

Checkpoint: /Users/fabio/.claude/ccaudit/.last-dry-run
Next: ccaudit --dangerously-bust-ghosts
```

The header is rendered by `ghost.ts` via `renderHeader('\u{1F47B}', 'Dry-Run', humanizeSinceWindow(sinceStr))` — same call shape as line 212. The footer `Checkpoint: ...` / `Next: ...` is emitted directly by `ghost.ts` (not by the renderer) because it depends on `resolveCheckpointPath()` which lives in `@ccaudit/internal`; passing the path through the renderer would couple packages unnecessarily.

**Verbose mode sketch (`--dry-run --verbose`):**

```
[same header + grouped summary as above]

Per-item listing:
  • archive agent stale-reviewer (global) — ~420 tokens, path: /Users/f/.claude/agents/stale-reviewer.md
  • archive agent old-helper (project:/Users/f/projects/p1) — ~380 tokens, path: /Users/f/projects/p1/.claude/agents/old-helper.md
  • disable mcp-server brave-search (global) — ~2800 tokens, path: /Users/f/.claude.json
  • flag memory CLAUDE.md (project:/Users/f/projects/p2) — ~600 tokens, path: /Users/f/projects/p2/CLAUDE.md
  ...
```

## ccaudit_version Injection

**Recommendation: generated `_version.ts` via a prebuild script.** This is the pattern that survives the NodeNext module-resolution constraint ccaudit inherits from the root `tsconfig.json:5` (`"moduleResolution": "NodeNext"`) without requiring tsdown-specific knowledge.

**Why not `import { version } from '../package.json'`:**
ccusage uses this pattern ([apps/ccusage/src/commands/index.ts:3](https://github.com/ryoppippi/ccusage/blob/main/apps/ccusage/src/commands/index.ts)), but ccusage's tsconfig sets `"moduleResolution": "bundler"` + `"resolveJsonModule": true`, which lets TypeScript silently resolve bare JSON imports. ccaudit's NodeNext resolution requires the `with { type: 'json' }` import attribute (see the Phase 4 decision in `STATE.md` and the working pattern in [`mcp-estimates-data.ts:2`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/token/mcp-estimates-data.ts)). The attribute syntax works, BUT `apps/ccaudit/package.json` lives outside `apps/ccaudit/tsconfig.json`'s `"rootDir": "./src"` (line 4), so importing it requires either widening rootDir (invasive) or relative-imports that escape the project boundary (TS error TS6059).

**Why not tsdown `define`:**
tsdown's `define` is AST-based (delegated to rolldown's `transform.define`). Per rolldown docs, it requires literal string form with embedded quotes: `define: { 'CCAUDIT_VERSION': '"0.0.1"' }`. Workable, but:
1. The value must be hardcoded or computed in `tsdown.config.ts` by reading package.json synchronously — which is itself a build-time file read
2. TypeScript doesn't know about `define` substitutions, so a placeholder typed `declare const CCAUDIT_VERSION: string` is still required
3. `pnpm test` (vitest) does NOT run tsdown — `define` only fires at build time, so tests would read `undefined` or the raw placeholder unless vitest is also configured with `define`

Both these drawbacks are absent with a generated file.

**Concrete code for the recommended path:**

```javascript
// apps/ccaudit/scripts/generate-version.mjs
// Reads package.json and writes _version.ts with the version literal.
// Runs on prebuild and pretest via package.json scripts.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(here, '..', 'package.json');
const outPath = path.resolve(here, '..', 'src', '_version.ts');

const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const content =
  '// AUTO-GENERATED by scripts/generate-version.mjs — do not edit by hand.\n' +
  '// Sourced from apps/ccaudit/package.json at build/test time.\n' +
  `export const CCAUDIT_VERSION = ${JSON.stringify(pkg.version)};\n`;

await writeFile(outPath, content, 'utf8');
```

```typescript
// apps/ccaudit/src/_version.ts (AUTO-GENERATED — do not edit by hand)
export const CCAUDIT_VERSION = '0.0.1';
```

**package.json changes (apps/ccaudit/package.json:40-45):**

```json
"scripts": {
  "build": "tsdown",
  "prebuild": "node scripts/generate-version.mjs",
  "test": "TZ=UTC vitest",
  "pretest": "node scripts/generate-version.mjs",
  "typecheck": "tsc --noEmit",
  "prepack": "pnpm run build && clean-pkg-json"
}
```

**.gitignore (root):**
```
apps/ccaudit/src/_version.ts
```

**Side benefits:**
- The `_` prefix matches the existing `tsdown.config.ts:4` exclusion pattern (`'!./src/_*.ts'`), so tsdown will NOT try to emit it as a separate entry file — it's only bundled through imports
- `pnpm typecheck` fails if `_version.ts` is missing (strict refs), which catches the "forgot to run generate-version" error before build
- Phase 6's existing `version: '0.0.1'` literal in [`_output-mode.ts:69`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/apps/ccaudit/src/cli/_output-mode.ts) and [`cli/index.ts:14`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/apps/ccaudit/src/cli/index.ts) can ALSO migrate to `CCAUDIT_VERSION` in the same plan — cleanup win

**Migration TODO for the planner:** include a task to replace the three `'0.0.1'` hardcodes (`_output-mode.ts:69`, `cli/index.ts:14`, `mcp-live-client.ts:148`) with `CCAUDIT_VERSION` imports. The `mcp-live-client.ts` version is inside `packages/internal` which does not have `_version.ts` — that one either stays hardcoded or gets its own generated file. Recommend: leave `mcp-live-client.ts` hardcoded for now (it's an MCP protocol `clientInfo` field, not user-facing) and revisit in Phase 8.

## mtimeMs Strategy for Agents/Skills

**Recommendation: stat-on-demand inside `computeGhostHash`.** Do NOT retrofit `scanAgents` or `scanSkills`.

**Rationale:**

1. **Scope of the stat pass.** Hash input is archive-eligible items only (D-10). In a typical user's inventory there may be 140 agents but only 128 definite-ghost (Phase 5 D-01 example). The hash pass stats 128 items, not 140. Retrofitting the scanner would stat all 140 even when the user only runs `ccaudit ghost` (non-dry-run) — wasted I/O on every invocation.

2. **Scan-agents.ts already walks file paths but doesn't return stat.** [scan-agents.ts:22-36](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-agents.ts) uses `tinyglobby.glob()` which does NOT call `fs.stat` internally. Retrofitting would add a second pass of stats for every discovered `.md` file on every invocation.

3. **Scan-skills.ts uses readdir with `withFileTypes`** ([scan-skills.ts:43](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-skills.ts)), so `entry.isDirectory()` works without stat. The "skill" path actually points to the skill directory (`path.join(skillsDir, entry.name)`), not SKILL.md, so `stat(skillPath)` returns the directory mtime — which is what we want (directory mtime changes when any file inside changes on most filesystems).

4. **Batching via `Promise.all` in the hash builder is already prescribed** (D-13). The sketch in the Hash Algorithm section implements this: a single `Promise.all` over eligible items gives O(N_eligible) parallel stats with negligible overhead.

5. **Zero scanner-module changes = zero test regressions.** Phase 3's existing scan-agents / scan-skills in-source tests (150+ assertions between them) need zero modification. The stat logic is localized to `checkpoint.ts` where it has its own focused tests.

6. **Skill stat note:** `r.item.path` for skills is the skill directory, e.g., `/Users/u/.claude/skills/deploy`. `fs.stat` on a directory returns directory mtime — which IS the correct hash input because "a skill changed" includes "a file inside the skill directory changed" (manifested as an mtime bump on the directory on Linux/macOS; Windows updates directory mtime when entries are added/removed but NOT when file contents change, which is an acceptable limitation for v1.1 — content-hashing skills is deferred).

**Counter-consideration (rejected):** Phase 8 will also need mtimeMs for the restore manifest. If Phase 8 wants fresh mtimes from *after* the archive (so the manifest records the pre-archive state), it must stat again anyway. No reuse benefit from retrofitting Phase 3.

**Escape hatch:** if a future phase (not 7, not 8) decides all scanners should populate mtimeMs unconditionally, the change is localized — `InventoryItem.mtimeMs` is already an optional field ([types.ts:20](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/types.ts)), and Phase 7's `checkpoint.ts` falls through to `r.item.mtimeMs ?? (await stat(...)).mtimeMs`, so it will pick up populated values automatically if/when scanners start providing them.

## Cross-Platform Concerns

| Concern | Linux/macOS | Windows | Phase 7 mitigation |
|---------|-------------|---------|--------------------|
| Path separators in `resolveCheckpointPath()` | `/` | `\` | Use `path.join(homedir(), '.claude', 'ccaudit', '.last-dry-run')` — handles both |
| `homedir()` availability | `$HOME` | `%USERPROFILE%` | Node `os.homedir()` abstracts this (already used in [scan-mcp.ts:27](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-mcp.ts)) |
| `fs.mkdir({ mode: 0o700 })` | Applied | Ignored (NTFS) | D-18 mode is best-effort; on Windows, NTFS ACLs govern access. Documented in comment. |
| `fs.writeFile({ mode: 0o600 })` | Applied | Ignored (NTFS) | Same. Best-effort. |
| `fs.rename` atomicity | Atomic on same filesystem (POSIX) | Atomic on same volume (Windows 10+ uses `MOVEFILE_REPLACE_EXISTING` under the hood) | No change; both work. EPERM retry deferred to Phase 8 per STATE.md blocker. |
| Path separators in hash canonical form | `/` | `\` | **HAZARD:** the hash includes `path` and `projectPath`. If the user runs `ccaudit --dry-run` on Linux and Windows against the same inventory, the hashes will differ because paths differ. This is INTENTIONAL — a checkpoint is machine-local, not portable, and the `.last-dry-run` file location itself is machine-local. Document in code comment. |
| `tinyglobby` posix-slash requirement | n/a | Forward slashes required in glob patterns | Already handled in scanners ([scan-agents.ts:22](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-agents.ts), [scan-skills.ts uses readdir not glob](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-skills.ts)) — Phase 7 does not introduce new globs |
| Line endings in JSON body | `\n` | `\n` (writeFile default) | Both use LF; JSON parse ignores trailing whitespace |
| `en-US-POSIX` locale availability | Node ≥16 Full ICU | Node ≥16 Full ICU (macOS/Linux/Windows ship Full ICU by default) | HIGH confidence; verified in Node 22.20.0 via `Intl.Collator('en-US-POSIX').resolvedOptions().locale → 'en-US-u-va-posix'` |

**Windows CI gap:** the Phase 6 CI matrix covers `ubuntu-latest` and `macos-latest`. Phase 7 tests will pass on both. The Phase 8 roadmap already plans to add `windows-latest` (ROADMAP Phase 8 success criterion 9). Phase 7 does NOT need to block on Windows CI because (a) atomic-write on Windows is rolldown/Node territory, not ccaudit-specific, and (b) the Phase 8 matrix extension will retroactively validate Phase 7 code paths.

## Dependency Check

**Zero new runtime dependencies. Zero new devDependencies.** All code uses existing catalog packages or `node:` builtins.

### Node builtins used in Phase 7

| Builtin | Module | Purpose |
|---------|--------|---------|
| `createHash` | `node:crypto` | SHA-256 digest for `ghost_hash` (D-12) |
| `mkdir`, `writeFile`, `rename`, `unlink`, `readFile`, `stat` | `node:fs/promises` | Atomic checkpoint write (D-19), checkpoint read, mtimeMs stat pass |
| `homedir` | `node:os` | Resolve `~/.claude/ccaudit/` path (D-18) |
| `join`, `dirname` | `node:path` | Cross-platform path assembly |
| `process.pid`, `process.exitCode` | global `process` | Tmp-file suffix (D-19), exit code (D-20) |

### Existing catalog packages used (nothing new)

| Package | Usage |
|---------|-------|
| `gunshi` | `dryRun` arg declaration (existing pattern) |
| `picocolors` (via `@ccaudit/terminal/color.ts`) | `colorize.bold`, `colorize.dim` in renderer |
| `cli-table3` | NOT used by `change-plan.ts` (plain-text layout per D-06, matching the Phase 5 ghost-summary precedent) |
| `valibot` | NOT used by checkpoint read (see Checkpoint Read API rationale) |
| `vitest` | In-source tests |

### package.json diff summary

- `apps/ccaudit/package.json:40-45` — add `prebuild` and `pretest` scripts pointing at `node scripts/generate-version.mjs`
- No new `devDependencies` entries

## Concerns / Open Questions

**None — all 20 CONTEXT.md decisions are technically sound.**

Three areas were spot-verified to confirm the decisions work as written:

1. **D-12 `en-US-POSIX` locale** — verified in Node 22.20.0. Resolves to `en-US-u-va-posix` (Full ICU variant). Sort ordering is deterministic and cross-platform.

2. **D-19 atomic write + D-18 file modes** — verified locally on macOS. `fs.writeFile` honors `{ mode: 0o600 }`, `fs.rename` replaces existing files atomically on same-filesystem renames, stat after the rename shows `mode & 0o777 === 0o600`.

3. **D-12 `crypto.createHash('sha256')` API** — verified. Identical to the literal call in D-12 step 5. Returns a 64-character hex string; prefixed with `"sha256:"` per D-12 step 6.

**One implementation advisory (not a concern with a locked decision):** the Phase 8 read path for the checkpoint should NOT use the current `version: '0.0.1'` literal in `_output-mode.ts:69` to compare against `checkpoint.ccaudit_version`. The checkpoint `ccaudit_version` field is informational/diagnostic only in Phase 8 ("your dry-run was from ccaudit 0.0.1, current is 0.2.0 — still compatible"). Only `checkpoint_version: 1` is the semver gate. This is already captured by D-17 ("Phase 8 reads this and refuses checkpoints with an unknown version") — clarifying only to prevent a downstream planning mistake.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.2 (from catalog, already in devDependencies) |
| Config file | `vitest.config.ts` at repo root (projects mode; inherits coverage from root) |
| Quick run command | `pnpm -w test` (all workspaces) or `pnpm --filter @ccaudit/internal test` (isolated) |
| Full suite command | `pnpm -w test --coverage` |
| Phase gate | `pnpm -w test --coverage` green; coverage thresholds from `vitest.config.ts:49-62` hold (lines 80, functions 80, statements 80, branches 70) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Test File | Command | Exists? |
|--------|----------|-----------|-----------|---------|---------|
| DRYR-01 | `buildChangePlan` filters definite-ghost agents/skills into archive tier | unit (in-source) | `packages/internal/src/remediation/change-plan.ts` | `pnpm --filter @ccaudit/internal test -- change-plan` | Wave 0 |
| DRYR-01 | `buildChangePlan` includes likely-ghost MCP in disable (D-11a) | unit (in-source) | same | same | Wave 0 |
| DRYR-01 | `buildChangePlan` excludes likely-ghost agents (monitor only per Phase 5 D-12) | unit (in-source) | same | same | Wave 0 |
| DRYR-01 | `calculateDryRunSavings` sums archive+disable, excludes flag | unit (in-source) | `packages/internal/src/remediation/savings.ts` | `pnpm --filter @ccaudit/internal test -- savings` | Wave 0 |
| DRYR-01 | `renderChangePlan` produces grouped-by-action layout matching D-06 | unit (in-source) | `packages/terminal/src/tables/change-plan.ts` | `pnpm --filter @ccaudit/terminal test -- change-plan` | Wave 0 |
| DRYR-01 | `renderChangePlan` omits empty groups (e.g., no MCP → no "Will DISABLE" line) | unit (in-source) | same | same | Wave 0 |
| DRYR-01 | `renderChangePlanVerbose` appends one line per item | unit (in-source) | same | same | Wave 0 |
| DRYR-01 | `ghost --dry-run` produces change-plan output end-to-end against fixture tmpdir | integration | `apps/ccaudit/src/__tests__/dry-run-command.test.ts` | `pnpm --filter ccaudit test -- dry-run-command` | Wave 0 |
| DRYR-01 | `ghost --dry-run --json` envelope contains `{ dryRun: true, changePlan, checkpoint }` | integration | same file | same | Wave 0 |
| DRYR-01 | `ghost --dry-run --csv` emits one row per item with columns `action,category,...,tier` | integration | same file | same | Wave 0 |
| DRYR-01 | `ghost --dry-run --quiet` emits TSV rows, no header | integration | same file | same | Wave 0 |
| DRYR-01 | `ghost --dry-run` exits 0 even when no ghosts (D-03, D-04) | integration | same file | same | Wave 0 |
| DRYR-02 | `computeGhostHash` determinism: same input → same hash across 10 iterations | unit (in-source, property) | `packages/internal/src/remediation/checkpoint.ts` | `pnpm --filter @ccaudit/internal test -- checkpoint` | Wave 0 |
| DRYR-02 | `computeGhostHash` stability under input reordering: `[a,b]` and `[b,a]` → same hash | unit (in-source, property) | same | same | Wave 0 |
| DRYR-02 | `computeGhostHash` returns `sha256:` + 64 hex chars | unit (in-source) | same | same | Wave 0 |
| DRYR-02 | `computeGhostHash` only includes eligible items (D-10, D-11a filter matrix) | unit (in-source) | same | same | Wave 0 |
| DRYR-02 | `computeGhostHash` MCP `configMtimeMs` cached per unique sourcePath (D-14) | unit (in-source, spy on stat) | same | same | Wave 0 |
| DRYR-02 | `writeCheckpoint` creates the directory with recursive mkdir | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-02 | `writeCheckpoint` writes file mode 0o600 (Unix only; skip on Windows CI) | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-02 | `writeCheckpoint` uses tmp-file-rename pattern; crashed write doesn't corrupt existing checkpoint | unit (in-source, tmpdir with simulated crash) | same | same | Wave 0 |
| DRYR-02 | `writeCheckpoint` propagates EACCES/ENOSPC unchanged to caller | unit (in-source, mock fs.writeFile) | same | same | Wave 0 |
| DRYR-02 | Checkpoint round-trip: `writeCheckpoint(x)` then `readCheckpoint()` returns `{ status: 'ok', checkpoint: x }` | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-02 | Checkpoint JSON on disk matches D-17 schema exactly (all 7 top-level fields present) | unit (in-source, tmpdir, JSON.parse of written file) | same | same | Wave 0 |
| DRYR-03 | `readCheckpoint()` returns `{ status: 'missing' }` when file does not exist | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-03 | `readCheckpoint()` returns `{ status: 'parse-error' }` on malformed JSON | unit (in-source, tmpdir with invalid file) | same | same | Wave 0 |
| DRYR-03 | `readCheckpoint()` returns `{ status: 'unknown-version', version: 2 }` for checkpoint_version !== 1 | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-03 | `readCheckpoint()` returns `{ status: 'schema-mismatch', missingField }` for missing required fields | unit (in-source, tmpdir) | same | same | Wave 0 |
| DRYR-03 | Hash changes when an agent's mtimeMs bumps → checkpoint becomes invalid per Phase 8 semantics | unit (in-source) | `packages/internal/src/remediation/checkpoint.ts` | `pnpm --filter @ccaudit/internal test -- checkpoint` | Wave 0 |
| DRYR-03 | Hash changes when an agent is added to the eligible set | unit (in-source) | same | same | Wave 0 |
| DRYR-03 | Hash changes when a likely-ghost MCP transitions to used (drops from hash input) | unit (in-source) | same | same | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter @ccaudit/internal test -- remediation` (runs the three new in-source suites ≈ <1s)
- **Per wave merge:** `pnpm -w test` (all workspaces, all in-source + integration tests)
- **Phase gate:** `pnpm -w test --coverage` passes with existing thresholds (80/80/80/70 per `vitest.config.ts:49-62`) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `packages/internal/src/remediation/change-plan.ts` — covers DRYR-01 (buildChangePlan filter logic)
- [ ] `packages/internal/src/remediation/savings.ts` — covers DRYR-01 (calculateDryRunSavings math)
- [ ] `packages/internal/src/remediation/checkpoint.ts` — covers DRYR-02 and DRYR-03 (hash determinism + checkpoint I/O + read API)
- [ ] `packages/internal/src/remediation/index.ts` — barrel exports (no tests; excluded from coverage via `vitest.config.ts:36` `'**/index.ts'` exclusion)
- [ ] `packages/terminal/src/tables/change-plan.ts` — covers DRYR-01 (renderChangePlan + renderChangePlanVerbose)
- [ ] `apps/ccaudit/src/__tests__/dry-run-command.test.ts` — NEW integration test for the full `ghost --dry-run` pipeline against a synthetic `~/.claude/` tmpdir fixture (modeled after existing [`ghost-command.test.ts`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/apps/ccaudit/src/__tests__/) if present, or Phase 5 pattern otherwise)
- [ ] `apps/ccaudit/src/_version.ts` — generated by `scripts/generate-version.mjs`; not tested directly (single literal export)
- [ ] `apps/ccaudit/scripts/generate-version.mjs` — tested implicitly by `pretest` hook; no dedicated test needed

No new framework installation. Vitest + coverage-v8 already in catalog. No new testing utilities required.

### Fixture Strategy

**Unit tests (hash, savings, plan-builder):** synthetic `TokenCostResult[]` arrays constructed inline in test bodies. Follow the `makeGhost` helper idiom from [`ghost-table.ts:171`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/terminal/src/tables/ghost-table.ts) — a local factory function that produces a minimal valid `TokenCostResult` with one field overridden per test case.

**Unit tests (checkpoint I/O):** `node:os.tmpdir()` + `mkdtemp('ccaudit-checkpoint-')` in `beforeEach`, `rm(tmp, { recursive: true, force: true })` in `afterEach`. Follow the [`scan-memory.ts:113-125`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/scanner/scan-memory.ts) tmpdir pattern exactly. Override `resolveCheckpointPath()` via a `writeCheckpoint` internal option like `writeCheckpoint(cp, { pathOverride })` — OR (cleaner) extract the path resolver as a parameter: `writeCheckpoint(cp, resolveCheckpointPath())` so tests can inject a tmpdir path. **Recommend the latter** — pure function, no mocking.

**Integration test:** build a fake `$HOME` under `tmpdir()` with a minimal `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.claude.json`, and `.claude/projects/*/sessions/*.jsonl`, then spawn `node dist/index.js --dry-run` as a subprocess with `HOME=<tmpdir>` in `env`. Assert on stdout (grouped layout), checkpoint file existence + content, and exit code. Mirrors the Phase 5/6 end-to-end test pattern (the existing `apps/ccaudit/src/__tests__/ghost-command.test.ts` — the file exists based on the `vitest.config.ts:42` exclusion note).

**Property test (hash stability under input reordering):** handwritten, not with `fast-check` — would add a new dependency. Manual property test:
```typescript
it('hash is stable under input reordering', async () => {
  const items = [/* 5 synthetic TokenCostResult, mixed categories & tiers */];
  const h1 = await computeGhostHash(items);
  const shuffled = [...items].reverse();
  const h2 = await computeGhostHash(shuffled);
  const rotated = [...items.slice(2), ...items.slice(0, 2)];
  const h3 = await computeGhostHash(rotated);
  expect(h1).toBe(h2);
  expect(h1).toBe(h3);
});
```

### Coverage Targets

Match Phase 6 thresholds (from `vitest.config.ts:49-62`):
- Lines ≥ 80%
- Functions ≥ 80%
- Statements ≥ 80%
- Branches ≥ 70%

The three `remediation/*.ts` files are pure or near-pure logic (hash, filter, sum) and should easily clear 90%+ lines. The tricky branches to cover are the error paths in `writeCheckpoint` (EACCES, ENOSPC, rename failure) and `readCheckpoint` (all four non-`ok` statuses). Use mocking sparingly — the tmpdir-based tests naturally exercise most branches. For EACCES simulation on CI, set file mode `0o000` before attempting a write and assert the error propagates. Skip the Windows permission tests on `process.platform === 'win32'` — the 0o600 bits are NTFS-ignored anyway.

**In-source test placement:** All three `remediation/*.ts` files get an `if (import.meta.vitest) { ... }` block at the bottom, following the existing pattern in every Phase 2–6 module. The tsdown config at [`apps/ccaudit/tsdown.config.ts:15-17`](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/apps/ccaudit/tsdown.config.ts) already strips `import.meta.vitest` at build time via `define`, so tests are excluded from the production bundle without extra work. The terminal-package renderer test goes inside `change-plan.ts` (same package-level convention).

## Sources

### Primary (HIGH confidence)
- CONTEXT.md (locked decisions D-01 through D-20) — `.planning/phases/07-dry-run-checkpoint/07-CONTEXT.md`
- REQUIREMENTS.md DRYR-01/02/03 — `.planning/REQUIREMENTS.md:66-68`
- ROADMAP.md Phase 7/8 — `.planning/ROADMAP.md:135-159`
- Handoff v6 lines 84-161 — `docs/ccaudit-handoff-v6.md`
- Phase 5 CONTEXT (branding) — `.planning/phases/05-report-cli-commands/05-CONTEXT.md`
- Phase 6 CONTEXT (output modes) — `.planning/phases/06-output-control-polish/06-CONTEXT.md`
- Existing code (all read in full during research):
  - `apps/ccaudit/src/cli/commands/ghost.ts`
  - `apps/ccaudit/src/cli/_shared-args.ts`
  - `apps/ccaudit/src/cli/_output-mode.ts`
  - `apps/ccaudit/tsdown.config.ts`
  - `apps/ccaudit/tsconfig.json`
  - `apps/ccaudit/package.json`
  - `packages/internal/src/scanner/scan-mcp.ts`
  - `packages/internal/src/scanner/scan-memory.ts`
  - `packages/internal/src/scanner/scan-agents.ts`
  - `packages/internal/src/scanner/scan-skills.ts`
  - `packages/internal/src/scanner/types.ts`
  - `packages/internal/src/token/types.ts`
  - `packages/internal/src/token/estimate.ts`
  - `packages/internal/src/token/mcp-estimates-data.ts`
  - `packages/internal/src/token/index.ts`
  - `packages/internal/src/report/recommendation.ts`
  - `packages/internal/src/index.ts`
  - `packages/internal/src/types.ts`
  - `packages/internal/tsconfig.json`
  - `packages/terminal/src/index.ts`
  - `packages/terminal/src/tables/ghost-table.ts`
  - `packages/terminal/src/tables/index.ts`
  - `vitest.config.ts`
  - `pnpm-workspace.yaml`
  - Root `tsconfig.json`
- Runtime verification in Node 22.20.0:
  - `Intl.Collator('en-US-POSIX').resolvedOptions().locale === 'en-US-u-va-posix'` ✓
  - `crypto.createHash('sha256').update(s, 'utf8').digest('hex')` returns 64 hex chars ✓
  - `fs.writeFile(tmp, body, { mode: 0o600 })` + `fs.rename(tmp, final)` over existing file → mode preserved, content replaced ✓
- ccusage reference patterns (via GitHub raw):
  - `apps/ccusage/tsdown.config.ts` — confirms `define: { 'import.meta.vitest': 'undefined' }` is the only define usage
  - `apps/ccusage/src/commands/index.ts:3` — `import { version } from '../../package.json'` (bundler mode, not NodeNext — does not apply to ccaudit directly)
  - `apps/ccusage/tsconfig.json` — `moduleResolution: 'bundler'` + `resolveJsonModule: true`

### Secondary (MEDIUM confidence)
- Rolldown `transform.define` docs (via WebFetch of https://rolldown.rs/guide/notable-features): confirms AST-based replacement requires embedded quotes for string literals
- `@rollup/plugin-replace` vs `transform.define` distinction (via WebSearch): confirms AST vs string replacement difference
- Node `fs.rename` Windows atomicity on same volume (general Node.js platform knowledge; NOT verified on Windows CI in this project — tracked as Phase 8 concern per STATE.md)

### Tertiary (LOW confidence)
- None — all critical claims are either verified by direct code reading, runtime execution, or primary-source docs.

## Metadata

**Confidence breakdown:**
- Data model (ChangePlan, Checkpoint, HashRecord types): HIGH — directly derived from CONTEXT.md D-11 and D-17 field lists
- Hash algorithm: HIGH — all three sub-concerns (crypto API, en-US-POSIX, JSON.stringify determinism) verified in Node 22.20.0
- Atomic checkpoint write: HIGH on macOS/Linux (verified); MEDIUM on Windows (documented, deferred to Phase 8)
- Change-plan builder: HIGH — pure function, filter logic is a direct transcription of D-07 + D-11a
- Savings math: HIGH — single-pass sum, distinct from existing `calculateTotalOverhead` (code read in full)
- CLI integration: HIGH — all integration points identified by line number in existing files
- Rendering layer: HIGH — mockup matches D-06 verbatim; helpers reuse Phase 5 `formatTokenShort` idiom
- ccaudit_version injection: HIGH for "generated file" recommendation — justified by direct reading of ccaudit tsconfig (NodeNext) and a sibling verified pattern ([mcp-estimates-data.ts:2](/Users/helldrik/gitRepos/_ai_coding_tools/ccaudit-aka-ghostbuster/packages/internal/src/token/mcp-estimates-data.ts))
- mtimeMs strategy: HIGH — confirmed by code reading that scan-agents/scan-skills do NOT populate mtimeMs
- Cross-platform concerns: MEDIUM — Unix verified; Windows extrapolated from documented Node behavior
- Validation architecture: HIGH — test pattern matches existing Phase 3/4/5/6 in-source conventions

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (30 days — stable dependencies, locked decisions, no fast-moving APIs in scope)

