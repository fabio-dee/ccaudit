# Phase 9: Restore & Rollback - Research

**Researched:** 2026-04-05
**Domain:** JSONL manifest reading, fs.rename reversal, frontmatter key removal, gunshi positional args
**Confidence:** HIGH

## Summary

Phase 9 is a pure mirror of Phase 8: it reads the JSONL manifest that Phase 8 wrote and reverses every recorded operation. The codebase already provides all the building blocks — `readManifest`, `detectClaudeProcesses`, `atomicWriteJson`, and `patchFrontmatter` are all importable from `@ccaudit/internal`. The only net-new code required is the `restore.ts` orchestrator, one new `removeFrontmatterKeys` helper (or an extension of `patchFrontmatter`), the manifest discovery glob, and the `restore` CLI command wired into `index.ts`.

Every integration point has a verified precedent in the bust pipeline. The key correctness challenges are (a) the dual-schema MCP re-enable (`.mcp.json` flat vs `~/.claude.json` nested), (b) matching collision-renamed archive filenames via the exact `archive_path` recorded in each manifest op, and (c) correctly reversing both `flag` ops (strip keys) and `refresh` ops (restore previous timestamp) as distinct cases.

**Primary recommendation:** Implement `restore.ts` with injectable `RestoreDeps` mirroring `BustDeps`, re-using `detectClaudeProcesses`, `atomicWriteJson`, and `readManifest` directly. Add `removeFrontmatterKeys` as a sibling to `patchFrontmatter` in `frontmatter.ts`. Use `tinyglobby` + `fs.stat` for manifest discovery.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `ccaudit restore` is a new gunshi subcommand registered alongside `ghost`, `mcp`, `inventory`, `trend` in `apps/ccaudit/src/cli/index.ts`. Three invocations on the same subcommand: `ccaudit restore` (full), `ccaudit restore <name>` (single by positional), `ccaudit restore --list` (list all).
- **D-02:** `<name>` is the base filename without extension, matched case-sensitively against `archive_path` basename (without extension) in manifest archive ops. `ccaudit restore playwright` should also find disable ops where `original_key` ends in `.playwright` — extending name match to MCP server names is the discretion recommendation confirmed for implementation.
- **D-03:** Full restore selects newest manifest by mtime. If no manifests: exit 0 with `No bust history found. Run ccaudit --dangerously-bust-ghosts first.`
- **D-04:** `--list` reads ALL manifest files, sorted newest-first by mtime, grouped by bust. Honors Phase 6 `--json`, `--quiet`, `--no-color` flags.
- **D-05:** `restore <name>` searches all manifests newest-first, restores from most recent bust containing an archive op for that name.
- **D-06:** Partial bust (header present, footer absent): warn and auto-proceed (no prompt).
- **D-07:** Corrupt manifest (no header): exit 1 with refusal message.
- **D-08:** Archive ops: move `archive_path → source_path`, mkdir parents, continue-on-error.
- **D-09:** Disable ops: find `new_key`, rename back to `original_key`. Transactional per config file. Skip-not-fail if new_key not found (user manually re-enabled). Skip-not-fail if original_key already exists (name collision). Preserve edited config value (do NOT use `original_value` from manifest for restore).
- **D-10:** Flag ops: strip `ccaudit-stale` and `ccaudit-flagged` keys. Continue-on-error.
- **D-11:** Refresh ops: restore `ccaudit-flagged: <previous_flagged_at>`. Leave `ccaudit-stale: true` in place. Continue-on-error.
- **D-12:** Skipped ops: no action.
- **D-13:** Tamper detection: compare SHA256 of file at `archive_path` vs `content_sha256` in manifest. On mismatch: warn and proceed.
- **D-14:** Running-process gate via `detectClaudeProcesses()`. Exit 3. `--list` skips gate (read-only).
- **D-15:** Hybrid failure policy: continue-on-error for fs ops; fail-fast per config file for `~/.claude.json` + `.mcp.json`. Exit codes: 0 (all succeeded), 1 (any failure), 3 (process gate).
- **D-16:** Output mirrors bust style. `--verbose` appends per-item lines. `--quiet`, `--json`, `--no-color`, `--ci` all honored.

### Claude's Discretion

- Exact module layout (recommend `packages/internal/src/remediation/restore.ts` + injectable deps)
- JSON envelope schema for `--json` restore output (follow `buildJsonEnvelope` pattern)
- CSV schema for `--restore --csv`
- Whether `restore <name>` also searches disable ops for MCP server names (recommended: yes)
- Exact wording of per-item verbose lines and summary footer

### Deferred Ideas (OUT OF SCOPE)

- `ccaudit restore --from bust-2026-04-01` flag (restore from specific historical bust)
- Interactive item selection (`ccaudit restore --interactive`)
- `restore --dry-run`
- Restore verification report

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RMED-11 | `ccaudit restore`: full rollback from last bust | Manifest discovery (Section 1) + restore orchestrator (Section 2) + execution order (Section 8) |
| RMED-12 | `ccaudit restore <name>`: restore single archived item | Gunshi positional arg pattern (Section 5) + manifest search (Section 1) |
| RMED-13 | `ccaudit restore --list`: show all archived items with dates | Manifest discovery glob (Section 1) + `--list` output spec (Section 4) |

</phase_requirements>

---

## 1. Manifest Discovery (glob + mtime sort implementation)

### Pattern

[VERIFIED: packages/internal/src/remediation/manifest.ts]

`resolveManifestPath(now)` reveals the exact path pattern:

```
~/.claude/ccaudit/manifests/bust-<ISO-dashed>.jsonl
```

For discovery, Phase 9 needs to glob all files matching `bust-*.jsonl` in that directory and sort by `mtime` (stat-based, not filename-based — filename sort is technically equivalent since ISO timestamps sort lexicographically, but mtime is the locked decision per D-03 and is more robust to manually placed files).

### Implementation

```typescript
// [VERIFIED: packages/internal/src/remediation/manifest.ts + node:fs/promises]
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

export function resolveManifestDir(): string {
  return path.join(homedir(), '.claude', 'ccaudit', 'manifests');
}

export interface ManifestEntry {
  path: string;
  mtime: Date;
}

/**
 * Discover all bust-*.jsonl manifests, sorted newest-first by mtime.
 * Returns empty array if directory does not exist (no busts yet).
 */
export async function discoverManifests(): Promise<ManifestEntry[]> {
  const dir = resolveManifestDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // ENOENT = no busts yet, not an error
  }
  const jsonlFiles = entries.filter((e) => e.startsWith('bust-') && e.endsWith('.jsonl'));
  const statted = await Promise.all(
    jsonlFiles.map(async (name) => {
      const p = path.join(dir, name);
      const s = await stat(p);
      return { path: p, mtime: s.mtime };
    }),
  );
  // Sort newest-first (descending mtime)
  return statted.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
```

**Key notes:**
- `readdir` is already available from `node:fs/promises` (same import used in `frontmatter.ts` and `manifest.ts`)
- No external dep — `tinyglobby` is overkill for a flat single-directory listing; plain `readdir` + filter is simpler and faster
- `stat` is already imported in `atomic-write.ts` — same import pattern reused here
- `Promise.all` over stat calls is safe since manifests directory will have at most tens of files

### Path injection for testability

The `discoverManifests` function should accept an injectable `readdir`/`stat` pair (like `StatFn` in `checkpoint.ts`) so tests can provide a fake manifest directory without touching real `~/.claude/`. See Section 2 for the full `RestoreDeps` interface.

---

## 2. restore.ts Orchestrator Design (injectable deps, parallel vs sequential)

### Overall shape mirrors bust.ts

[VERIFIED: packages/internal/src/remediation/bust.ts lines 118-173]

`bust.ts` uses a `BustDeps` interface with every I/O path injectable. `restore.ts` follows the same pattern:

```typescript
// packages/internal/src/remediation/restore.ts

export interface RestoreDeps {
  // Manifest discovery
  discoverManifests: () => Promise<ManifestEntry[]>;
  readManifest: (path: string) => Promise<ReadManifestResult>;

  // Process gate (D-14)
  processDetector: ProcessDetectorDeps;
  selfPid: number;

  // Filesystem ops
  renameFile: (from: string, to: string) => Promise<void>;      // archive_path -> source_path
  mkdirRecursive: (dir: string, mode?: number) => Promise<void>;
  readFileBytes: (p: string) => Promise<Buffer>;                 // for SHA256 tamper check
  pathExists: (p: string) => Promise<boolean>;                   // for checking archive_path

  // Memory file key removal
  removeFrontmatterKeys: (filePath: string, keys: string[]) => Promise<FrontmatterRemoveResult>;

  // MCP re-enable (needs read + mutate + atomic write)
  readFileUtf8: (p: string) => Promise<string>;
  atomicWriteJson: <T>(targetPath: string, value: T) => Promise<void>;

  // Runtime
  now: () => Date;
}
```

**Injectable test surface matches bust.ts precedent.** The production command handler builds a `buildProductionRestoreDeps()` object with real `node:fs/promises` implementations.

### Sequential vs parallel for restore ops

[ASSUMED: based on bust.ts sequential design + D-15 hybrid failure policy]

Phase 8 bust.ts executes agent archive, skill archive, MCP disable, memory flag **sequentially in a for loop** — this is the correct pattern for Phase 9 too.

**Rationale against parallel:**
1. D-15 requires fail-fast per config file for MCP ops. Parallel execution would require tracking which files have been written and may leave partial state on error.
2. Continue-on-error for fs ops doesn't benefit from parallelism in restore (there are at most ~200 items, each taking <1ms for `rename()`).
3. MCP mutations share the same `~/.claude.json` file — concurrent writes would race.
4. Bust.ts itself is fully sequential, and this precedent should be maintained for predictable failure reporting.

**Verdict:** Sequential for loops, same as bust.ts. No `Promise.all` for ops.

### RestoreResult discriminated union

Mirrors `BustResult` from bust.ts:

```typescript
export type RestoreResult =
  | { status: 'success'; counts: RestoreCounts; duration_ms: number }
  | { status: 'partial-success'; counts: RestoreCounts; failed: number; duration_ms: number }
  | { status: 'no-manifests' }
  | { status: 'name-not-found'; name: string }
  | { status: 'manifest-corrupt'; path: string }
  | { status: 'running-process'; pids: number[]; selfInvocation: boolean; message: string }
  | { status: 'process-detection-failed'; error: string }
  | { status: 'config-parse-error'; path: string; error: string }
  | { status: 'config-write-error'; path: string; error: string };

export interface RestoreCounts {
  unarchived: { completed: number; failed: number };
  reenabled: { completed: number; failed: number };
  stripped: { completed: number; failed: number };
}
```

---

## 3. MCP Re-enable Transaction (reverse of disableMcpTransactional)

### What bust.ts wrote (verified)

[VERIFIED: packages/internal/src/remediation/bust.ts lines 543-680 (disableMcpTransactional)]

For each ghost MCP server, bust.ts wrote one of three patterns into the manifest op:

**a) `.mcp.json` flat schema:**
- `original_key`: `mcpServers.playwright` (dot-notation, flat relative to file root)
- `new_key`: `ccaudit-disabled:playwright` (or `ccaudit-disabled:playwright:2026-04-05T18:30:00Z` on collision)
- The disabled key is at document root, the `mcpServers` key still exists but the server is removed from it

**b) `~/.claude.json` global scope:**
- `original_key`: `mcpServers.playwright`
- `new_key`: `ccaudit-disabled:playwright`
- Same structure as flat — disabled key at document root

**c) `~/.claude.json` project scope:**
- `original_key`: `projects./path/to/project.mcpServers.playwright` (full dotted path)
- `new_key`: `ccaudit-disabled:playwright` (stored inside the project object, not at document root)

### Reverse logic for restore

```typescript
async function reEnableMcpTransactional(
  disableOps: DisableOp[],
  deps: RestoreDeps,
): Promise<ReEnableResult> {
  // Group by config file, same as disableMcpTransactional
  const byConfigPath = new Map<string, DisableOp[]>();
  for (const op of disableOps) {
    const list = byConfigPath.get(op.config_path) ?? [];
    list.push(op);
    byConfigPath.set(op.config_path, list);
  }

  for (const [configPath, ops] of byConfigPath) {
    const isFlatMcpJson = path.basename(configPath) === '.mcp.json';

    let raw: string;
    try { raw = await deps.readFileUtf8(configPath); }
    catch (err) { return { status: 'parse-error', path: configPath, error: ... }; }

    let config: Record<string, unknown>;
    try { config = JSON.parse(raw); }
    catch (err) { return { status: 'parse-error', path: configPath, error: ... }; }

    for (const op of ops) {
      // Find new_key in config. If missing, user manually re-enabled -> warn + skip (D-09).
      if (!(op.new_key in config) && !nestedKeyExists(config, op.new_key, isFlatMcpJson, op)) {
        // warn + skip
        continue;
      }

      // Extract the original server name from original_key:
      //   "mcpServers.playwright" -> "playwright"
      //   "projects./path.mcpServers.playwright" -> "playwright"
      const serverName = op.original_key.split('.').pop()!;

      // Check if original_key target already has that server name -> skip (D-09 collision guard)
      // Re-insert the config value UNDER the server name at the correct nested location.
      // The VALUE to restore is NOT op.original_value but the current value at op.new_key
      // (preserve any edits the user made in _archived between bust and restore -- D-09).
      // ... mutation logic here ...
    }

    try { await deps.atomicWriteJson(configPath, config); }
    catch (err) { return { status: 'write-error', path: configPath, error: ... }; }
  }

  return { status: 'ok' };
}
```

### Key nuances for MCP re-enable

**D-09 says:** "the key-rename is reversed in-place, preserving any edits the user made to the config value between bust and restore." This means:
- The value to put back under `mcpServers.<name>` is the CURRENT value found at `config[op.new_key]`, NOT `op.original_value`
- `op.original_value` is recorded in the manifest only for future reference, not for restore

**Schema detection:**
- `.mcp.json` flat: `config[op.new_key]` exists at document root. Move it to `config.mcpServers[serverName]`.
- `~/.claude.json` global: `config[op.new_key]` exists at document root. Move it to `config.mcpServers[serverName]`.
- `~/.claude.json` project scope: `config.projects[projectPath][op.new_key]` exists inside the project object. Move it to `config.projects[projectPath].mcpServers[serverName]`.

**Detecting the scope from the manifest:** `op.scope === 'project'` AND `path.basename(configPath) !== '.mcp.json'` AND `op.project_path !== null` → this is the nested project scope case.

**Collision key format:** `ccaudit-disabled:playwright:2026-04-05T18:30:00Z` — when `op.new_key` has three colon-separated segments, the logic must still find this exact key (it's stored verbatim in the manifest, so just look up `op.new_key` directly — no parsing needed).

---

## 4. Frontmatter Key Removal (API extension needed)

### Current `patchFrontmatter` API

[VERIFIED: packages/internal/src/remediation/frontmatter.ts]

The existing `patchFrontmatter(filePath, nowIso)` only ADDS/UPDATES `ccaudit-stale` and `ccaudit-flagged`. It does not support removing keys. A sibling function is needed.

### Two distinct restore behaviors (D-10 vs D-11)

**For `flag` ops (D-10):** Strip BOTH `ccaudit-stale` and `ccaudit-flagged` entirely — the file had no ccaudit keys before the bust.

**For `refresh` ops (D-11):** Keep `ccaudit-stale: true` in place, but RESTORE `ccaudit-flagged` to the `previous_flagged_at` value from the manifest — the file had ccaudit keys before the bust, and the bust only refreshed the timestamp.

### New `removeFrontmatterKeys` function

A new export in `frontmatter.ts`:

```typescript
export type FrontmatterRemoveResult =
  | { status: 'removed'; keysRemoved: string[] }
  | { status: 'no-frontmatter' }        // file has no --- block; nothing to remove
  | { status: 'keys-not-found' }        // block exists but keys weren't there
  | { status: 'skipped'; reason: 'exotic-yaml' | 'read-error' | 'write-error' | 'file-not-found' };
```

Implementation pattern (mirrors patchFrontmatter):
1. Read file, detect line endings
2. If no `---` on line 0: return `{status: 'no-frontmatter'}` (nothing to remove, continue-on-error not a failure)
3. Find closing `---`
4. Validate body is flat key:value (same exotic-yaml detection from patchFrontmatter)
5. Filter out lines whose key matches any of the `keys` argument
6. If `remaining body === original body` after filter: return `{status: 'keys-not-found'}`
7. If body is now EMPTY (only the ccaudit keys were there), check if we should remove the entire frontmatter block or leave an empty `---\n---\n` block → recommend: if all remaining body lines are blank/comment, remove the entire `---` block entirely and leave just the body (don't leave orphaned empty frontmatter)
8. Write back, return `{status: 'removed', keysRemoved: [...]}`

### For `refresh` op restoration (D-11)

Use the existing `patchFrontmatter` with a twist: need a `setFrontmatterValue(filePath, key, value)` helper, OR overload `removeFrontmatterKeys` with a `replace` map argument:

```typescript
// Recommended approach: a separate targeted setter
export async function setFrontmatterKey(
  filePath: string,
  key: string,
  value: string,
): Promise<FrontmatterRemoveResult>
```

This sets the named key's value in place (line-based, same exotic-yaml guards). Called with `('file.md', 'ccaudit-flagged', op.previous_flagged_at)` to restore the timestamp.

**Simpler alternative:** Just call `removeFrontmatterKeys` to strip `ccaudit-flagged`, then use `patchFrontmatter`-style injection to write the old value back. But this is two file writes — the setter approach is cleaner.

**RECOMMENDED:** Add `removeFrontmatterKeys(filePath, keys)` and `setFrontmatterValue(filePath, key, value)` as separate exports in `frontmatter.ts`. Both follow the same line-based pattern as `patchFrontmatter` and share the exotic-yaml guard logic (extract to a shared internal helper).

---

## 5. gunshi Positional Arg + Flag on Same Command

### How gunshi exposes positionals

[VERIFIED: node_modules/.pnpm/gunshi@0.29.3/node_modules/gunshi/lib/types-CcuJzRjy.d.ts line 707]

The gunshi `CommandContext` exposes THREE collections beyond `ctx.values`:
- `ctx.positionals: string[]` — positionals resolved with `resolveArgs`
- `ctx.rest: string[]` — remaining args after `--`
- `ctx._: string[]` — the raw positional arguments that were NOT parsed as named flags

For `ccaudit restore code-reviewer`:
- `ctx._[0]` = `'code-reviewer'` (the item name)

For `ccaudit restore --list`:
- `ctx._` is empty; `ctx.values.list` = `true`

### Command definition pattern

```typescript
// apps/ccaudit/src/cli/commands/restore.ts
import { define } from 'gunshi';
import { outputArgs } from '../_shared-args.ts';

export const restoreCommand = define({
  name: 'restore',
  description: 'Restore archived items from the last bust (or a named item)',
  toKebab: true,   // required: exposes list as --list (not --list camelCase)
  args: {
    ...outputArgs,
    list: {
      type: 'boolean',
      description: 'List all archived items across all busts',
      default: false,
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Show per-item restore lines',
      default: false,
    },
  },
  async run(ctx) {
    const name = ctx._[0] ?? null;     // optional positional: restore <name>
    const list = ctx.values.list;

    if (list) {
      // --list mode: read all manifests, display grouped output
    } else if (name !== null) {
      // single-item mode: restore <name>
    } else {
      // full restore mode: restore from newest manifest
    }
  },
});
```

**Registration in index.ts:**
```typescript
// apps/ccaudit/src/cli/index.ts — add:
import { restoreCommand } from './commands/restore.ts';
// ...
subCommands: {
  ghost: ghostCommand,
  mcp: mcpCommand,
  inventory: inventoryCommand,
  trend: trendCommand,
  restore: restoreCommand,   // <-- add
}
```

**Verified pattern:** `ctx._` is the standard gunshi positional accessor (line 707 in gunshi types). This is the same convention as most `minimist`/`mri`-style parsers. No additional configuration needed — gunshi populates `ctx._` automatically with any argument tokens that don't match defined flag names.

---

## 6. Integration Test Pattern (restore-command.test.ts structure)

### Model: bust-command.test.ts

[VERIFIED: apps/ccaudit/src/__tests__/bust-command.test.ts]

The bust integration test:
1. Resolves the dist binary path: `path.resolve(here, '..', '..', 'dist', 'index.js')`
2. Requires a pre-built dist: `beforeAll` asserts `existsSync(distPath)` and throws with build instructions
3. Creates a `tmpHome` with `mkdtemp` in `beforeEach`, tears it down in `afterEach`
4. Builds a fake `ps` script in `tmpHome/bin/ps` (POSIX only) to avoid real process detection
5. Overrides `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `NO_COLOR`, `PATH` in the subprocess env
6. Pipes `stdin` closed immediately (`child.stdin.end()`) so `isTTY === false`
7. Uses a 30s timeout per test

### restore-command.test.ts should follow this structure exactly:

```typescript
// apps/ccaudit/src/__tests__/restore-command.test.ts

const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

async function runRestoreCommand(
  tmpHome: string,
  flags: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  // Same spawn pattern as bust-command.test.ts
  // env: HOME=tmpHome, PATH=tmpHome/bin (fake-ps), NO_COLOR=1
  // stdin: pipe + close immediately
}
```

### Test fixture for restore

A restore test fixture must contain:
1. A valid manifest file at `~/.claude/ccaudit/manifests/bust-*.jsonl` (with header, ops, footer)
2. The archived files at their `archive_path` locations (for unarchive tests)
3. A modified `~/.claude.json` with `ccaudit-disabled:` keys (for MCP re-enable tests)
4. A fake ps binary in `tmpHome/bin/ps`

**Fixture helper pattern:**
```typescript
async function buildRestoreFixture(tmpHome: string): Promise<{
  manifestPath: string;
  archivePath: string;
  sourcePath: string;
}> {
  // Build minimal fixture without running a real bust first
  // Write a JSONL manifest directly using ManifestWriter
  // Write the archived agent file at archive_path
  // Inject ccaudit-disabled: key into ~/.claude.json
}
```

Alternatively: run a real bust first (like `runDryRunFirst` then bust), then run restore on the output. This end-to-end approach tests the full bust → restore round-trip and is the preferred approach for the "full pipeline" test cases.

### Key test cases to cover:

1. **No manifests → exit 0 with message** (no bust history)
2. **Full restore from manifest → files unarchived, MCP re-enabled, frontmatter stripped, exit 0**
3. **`restore <name>` → only named item restored, exit 0**
4. **`restore --list` → formatted output with bust grouping, no process gate, exit 0**
5. **Partial bust (no footer) → warns and proceeds, exit 0**
6. **Corrupt manifest (no header) → exit 1 with refusal message**
7. **Process gate → exit 3** (same fake-PATH trick as bust tests)
8. **`--json` output → parseable JSON envelope with restore result**
9. **Name not found across all manifests → exit 0 with message**
10. **Tamper detected (SHA256 mismatch) → warns and restores anyway**

---

## 7. Collision Filename Handling (archive_path naming from Phase 8)

### How collisions.ts names the archive file

[VERIFIED: packages/internal/src/remediation/collisions.ts]

```typescript
// First archive (no collision):
//   source: ~/.claude/agents/design/code-reviewer.md
//   archive: ~/.claude/agents/_archived/design/code-reviewer.md

// On collision (file already in _archived):
//   archive: ~/.claude/agents/_archived/design/code-reviewer.2026-04-05T18-30-00Z.md
//   (ISO timestamp suffix inserted BEFORE the extension, colons → dashes)
```

The exact formula:
```typescript
const parsed = path.parse(candidate);  // { dir, name, ext }
const suffix = timestampSuffixForFilename(opts.now);  // '2026-04-05T18-30-00Z'
return path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext}`);
// -> /path/_archived/design/code-reviewer.2026-04-05T18-30-00Z.md
```

### Phase 9 restore implication

**Phase 9 does NOT need to reconstruct the archive path.** The manifest `ArchiveOp` records the exact `archive_path` for each operation:

```jsonl
{"op_type":"archive","archive_path":"/home/u/.claude/agents/_archived/design/code-reviewer.2026-04-05T18-30-00Z.md","source_path":"/home/u/.claude/agents/design/code-reviewer.md",...}
```

The restore operation is simply `rename(op.archive_path, op.source_path)` — no collision logic needed for the unarchive direction. The `source_path` already has the canonical target path.

### Edge case: source_path occupied

If the user recreated the agent at `source_path` after the bust, the restore would overwrite it. D-08 only says continue-on-error for ENOENT/EACCES (file gone or permissions) but doesn't explicitly address an existing file at source_path. Recommend: check if `source_path` exists before rename; if it does, warn and skip (don't silently overwrite a new file the user created).

[ASSUMED: This edge case is not explicitly addressed in D-08/D-09/D-10. The "warn + skip" policy is consistent with D-09's "warn and skip rather than overwrite" for MCP re-enable collisions.]

### MCP key format for `ccaudit restore <name>`

For D-02's extension to match MCP server names: when searching `disable` ops in a manifest, match against the server name extracted from `original_key`. The server name is the LAST dot-separated segment:
- `mcpServers.playwright` → `playwright`
- `projects./path.mcpServers.playwright` → `playwright`

So `ccaudit restore playwright` matches any `disable` op where `original_key.split('.').pop() === 'playwright'`.

---

## 8. Restore Execution Order (flag-strip → MCP → skills → agents)

### Phase 8 bust order (verified)

[VERIFIED: packages/internal/src/remediation/bust.ts D-13 comment + implementation]

```
Bust:     archive agents → archive skills → disable MCP → flag memory
Restore:  strip flags → re-enable MCP → unarchive skills → unarchive agents
```

### Rationale for reversed order

From 09-CONTEXT.md specifics section:
> "This ensures that if any step fails, the user is not left with MCP re-enabled but agents still in `_archived/` (a less confusing failure state than the reverse)."

**Analysis:**
1. **Strip flags first** (memory files): low-blast-radius, additive-only reversal. If this fails, MCP and agents are still in archived state — fully reversible from manifest.
2. **Re-enable MCP second**: risky `~/.claude.json` mutation. If this succeeds, MCP is back. If agents then fail, user has MCP + no agents — better than having agents back but MCP still disabled.
3. **Unarchive skills third**: before agents, since agents depend on skills (an agent that uses a skill should have the skill available when the agent is restored).
4. **Unarchive agents last**: the "heaviest" items restored last.

**Note on skills-before-agents:** The context document shows `restore reverses: memory → MCP → skills → agents` which puts skills before agents. This is the locked execution order.

### Implementation structure

```typescript
export async function runRestore(opts: {
  mode: 'full' | { name: string } | 'list';
  deps: RestoreDeps;
}): Promise<RestoreResult> {
  // 1. Process gate (skip for --list)
  // 2. Discover manifest(s)
  // 3. Select manifest(s) to process
  // 4. Read manifest, check header/footer (D-06, D-07)
  // 5. Warn on partial bust if needed
  // 6. Execute ops in reversed order:
  //    a. flag+refresh ops (strip/restore frontmatter)
  //    b. disable ops (re-enable MCP, transactional per config file)
  //    c. archive ops where category='skill' (unarchive)
  //    d. archive ops where category='agent' (unarchive)
  // 7. Return RestoreResult
}
```

### Filtering ops for execution

For `restore <name>` (single-item mode), the ops to execute are:
- Archive ops where `path.basename(op.archive_path, path.extname(op.archive_path)) === name` (for agents/skills)
- Disable ops where `op.original_key.split('.').pop() === name` (for MCP servers) [DISCRETION: recommended]
- No flag/refresh ops in single-item mode (frontmatter is not addressable by name per D-02)

---

## 9. Validation Architecture (how to verify the implementation works)

### Test framework

[VERIFIED: packages/internal/src/remediation/manifest.ts, bust-command.test.ts]

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x (in-source + standalone) |
| Config detection | `vitest.config.ts` in root |
| Quick run command | `pnpm -F @ccaudit/internal vitest run` |
| Full suite command | `pnpm -r test` |
| Integration tests require | Built dist: `pnpm -F ccaudit build` before running `bust-command.test.ts` or `restore-command.test.ts` |

### In-source tests (unit level)

`packages/internal/src/remediation/restore.ts` — use `if (import.meta.vitest)` blocks to test:
- `discoverManifests` with injected fake `readdir`/`stat`
- `reEnableMcpTransactional` with injected `readFileUtf8` / `atomicWriteJson`
- `unarchiveOne` with injected `renameFile` / `mkdirRecursive`

`packages/internal/src/remediation/frontmatter.ts` — extend existing test suite with:
- `removeFrontmatterKeys` for each edge case (no frontmatter, keys present, keys absent, exotic YAML)
- `setFrontmatterValue` for the refresh-op restore case

### Subprocess integration tests

`apps/ccaudit/src/__tests__/restore-command.test.ts` — same subprocess model as bust-command.test.ts:
- 10 test cases enumerated in Section 6
- Fake `ps` binary for process gate tests
- Real manifest files written to `tmpHome` as fixtures

### Phase requirements → test map

| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| RMED-11 | Full restore from last manifest | integration subprocess | `pnpm -F ccaudit test` | `restore-command.test.ts` |
| RMED-12 | `restore <name>` single item | integration subprocess | `pnpm -F ccaudit test` | positional arg + manifest search |
| RMED-13 | `restore --list` all items | integration subprocess | `pnpm -F ccaudit test` | read-only, no process gate |
| D-06 | Partial bust warning | integration subprocess | `pnpm -F ccaudit test` | fixture with footer omitted |
| D-09 | MCP re-enable transactional | unit in-source | `pnpm -F @ccaudit/internal vitest run` | injected fake config |
| D-13 | Tamper detection warn | unit + integration | both | SHA256 mismatch fixture |
| D-14 | Process gate exit 3 | integration subprocess | `pnpm -F ccaudit test` | fake empty PATH |
| D-15 | Hybrid failure policy | unit in-source | `pnpm -F @ccaudit/internal vitest run` | injected rename failures |

### Wave 0 gaps (files to create)

- [ ] `packages/internal/src/remediation/restore.ts` — main orchestrator + in-source tests
- [ ] `apps/ccaudit/src/cli/commands/restore.ts` — gunshi command definition
- [ ] `apps/ccaudit/src/__tests__/restore-command.test.ts` — subprocess integration tests
- [ ] Extensions to `packages/internal/src/remediation/frontmatter.ts` — `removeFrontmatterKeys` + `setFrontmatterValue` + in-source tests
- [ ] Update `packages/internal/src/remediation/index.ts` — barrel exports for restore
- [ ] Update `apps/ccaudit/src/cli/index.ts` — register `restore: restoreCommand`

---

## 10. Open Questions / Risks

### Q1: source_path occupied on restore

If the user recreated an agent at `source_path` after the bust, `rename(archive_path, source_path)` would silently overwrite it. D-08 specifies continue-on-error for ENOENT/EACCES but is silent on EEXIST.

**Recommendation:** Before `rename`, `stat(source_path)`. If it exists: emit warning `⚠️ <name> already exists at <source_path> — skipping (restore manually if needed)`, increment failed count, continue. This is consistent with D-09's "warn and skip rather than overwrite" for MCP re-enable collisions.

[ASSUMED: this edge case needs planner confirmation on whether it counts as "failed" or "skipped" in the RestoreCounts]

### Q2: Which field to extract server name from for `restore <name>` MCP matching

D-02 says `<name>` matches `archive_path` basename for agents/skills. The CONTEXT.md discretion note recommends also matching `original_key` for disable ops. The server name extraction is: `original_key.split('.').pop()`.

This works for all three schema variants:
- `mcpServers.playwright` → `playwright`
- `projects./path.mcpServers.playwright` → `playwright`
- `mcpServers.github-copilot` → `github-copilot` (hyphenated names handled correctly)

**Edge case:** What if the MCP server name itself contains a dot (e.g., `my.server`)? Then `original_key = 'mcpServers.my.server'` and `split('.').pop()` = `'server'`, which would be wrong. But looking at D-06's collision key format (`ccaudit-disabled:my.server`), it appears server names with dots are possible. A safer extraction: strip the known prefix `mcpServers.` or `projects.<path>.mcpServers.`:

```typescript
function extractServerName(originalKey: string): string {
  const mcpIdx = originalKey.lastIndexOf('.mcpServers.');
  if (mcpIdx >= 0) {
    return originalKey.slice(mcpIdx + '.mcpServers.'.length);
  }
  if (originalKey.startsWith('mcpServers.')) {
    return originalKey.slice('mcpServers.'.length);
  }
  return originalKey;
}
```

[ASSUMED: no verified test fixtures for dotted server names. Recommend defensive extraction.]

### Q3: `restore --list` for `refresh` ops

The D-04 `--list` format shows `mcp`, `agent`, `skill` categories per item. `flag` and `refresh` ops on memory files should be shown with a `(frontmatter)` annotation per D-04. There is no explicit format for `skipped` ops in the list — recommend omitting them (skipped = no action taken = not relevant to restore).

### Q4: `removeFrontmatterKeys` when result is empty frontmatter block

After removing all ccaudit keys from a frontmatter block that ONLY contained ccaudit keys, we're left with `---\n---\n`. Options:
1. Leave empty `---\n---\n` block (benign but ugly)
2. Remove the entire frontmatter block (cleaner but slightly more complex)

**Recommendation:** Remove the entire `---\n---\n` block if all body lines after filtering are blank or comment-only. Return the file body content starting from the first non-blank line after the closing `---`. This mirrors what the file would have looked like before the bust.

[ASSUMED: no locked decision on this. Recommend option 2 for cleanliness.]

### Q5: `restore <name>` and refresh ops

D-02 says "Only `archive` op types are matched by name; `disable` and `flag` ops are not addressable by `restore <name>`." But the discretion note says MCP disable ops SHOULD be matchable. What about `refresh` ops? A refresh op modifies a memory file's timestamp — it has a `file_path` but no "name" in the agent/skill/MCP sense. Recommend: `restore <name>` does NOT match refresh ops. Refresh ops are only executed in full restore mode.

### Q6: `--ci` flag behavior for restore

D-16 says all Phase 6 output modes apply. The `ghost.ts` implementation shows `--ci` implies `--yes-proceed-busting` for bust. For restore, `--ci` should imply `--json --quiet` (per Phase 6 semantics). Restore has no confirmation ceremony so there is no `--yes-proceed-busting` equivalent needed.

---

## Standard Stack

### Core (all reused from Phase 8)

| Library | Version | Purpose | Source |
|---------|---------|---------|--------|
| `node:fs/promises` | Node 20+ built-in | rename, mkdir, readdir, stat, readFile | [VERIFIED: bust.ts, manifest.ts, atomic-write.ts] |
| `node:path` | Node 20+ built-in | Path joining and basename extraction | [VERIFIED: bust.ts] |
| `node:crypto` | Node 20+ built-in | SHA256 for tamper detection | [VERIFIED: manifest.ts sha256Hex] |
| `gunshi` | 0.29.3 | CLI subcommand + positional args | [VERIFIED: index.ts, ghost.ts] |
| `@ccaudit/internal` | workspace | readManifest, detectClaudeProcesses, atomicWriteJson | [VERIFIED: index.ts exports] |
| `@ccaudit/terminal` | workspace | renderHeader, colorize, initColor | [VERIFIED: ghost.ts imports] |

### New modules to create

| Module | Purpose |
|--------|---------|
| `packages/internal/src/remediation/restore.ts` | Restore orchestrator with RestoreDeps injection |
| `apps/ccaudit/src/cli/commands/restore.ts` | gunshi subcommand handler |

### Reused without modification

| Module | What Phase 9 uses |
|--------|------------------|
| `manifest.ts` | `readManifest()`, all Op types |
| `processes.ts` | `detectClaudeProcesses()`, `walkParentChain()`, `defaultDeps` |
| `atomic-write.ts` | `atomicWriteJson()` for MCP re-enable |
| `frontmatter.ts` | Extend with `removeFrontmatterKeys()` + `setFrontmatterValue()` |
| `_shared-args.ts` | `outputArgs` spread into restore command args |
| `_output-mode.ts` | `resolveOutputMode()`, `buildJsonEnvelope()` |

---

## Architecture Patterns

### Restore orchestrator mirrors bust orchestrator

```
restore.ts (packages/internal/src/remediation/)
├── discoverManifests()              // readdir + stat + sort
├── selectManifest(mode, manifests)  // newest / search by name
├── runRestore(opts)                 // main entry point
│   ├── process gate (detectClaudeProcesses)
│   ├── read manifest (readManifest)
│   ├── validate header/footer (D-06, D-07)
│   ├── stripMemoryFlags()           // flag ops → removeFrontmatterKeys
│   ├── restoreRefreshedTimestamps() // refresh ops → setFrontmatterValue
│   ├── reEnableMcpTransactional()   // disable ops → atomicWriteJson
│   └── unarchiveFiles()             // archive ops → rename
└── buildListOutput()                // --list mode
```

### Anti-Patterns to Avoid

- **Reconstructing archive paths from source paths**: Phase 9 MUST use `op.archive_path` directly — never recompute the path with `buildArchivePath`. The collision suffix is in the recorded path.
- **Using `op.original_value` for MCP restore**: D-09 says restore the CURRENT value at `op.new_key`, not `op.original_value`. This preserves user edits made between bust and restore.
- **Parallel op execution**: Sequential loops only — MCP mutations share the same config file, and continue-on-error reporting is simpler to implement correctly with sequential execution.
- **Not checking for file existence before rename**: Check that `op.archive_path` exists (tamper detection D-13) AND that `op.source_path` doesn't already exist before rename.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Manifest reading | Custom JSONL parser | `readManifest()` from manifest.ts |
| Process detection | New ps/tasklist wrapper | `detectClaudeProcesses()` from processes.ts |
| Atomic JSON write | tmp+rename from scratch | `atomicWriteJson()` from atomic-write.ts |
| Output mode resolution | Ad-hoc flag checking | `resolveOutputMode()` from _output-mode.ts |
| JSON envelope | Custom meta wrapper | `buildJsonEnvelope()` from _output-mode.ts |
| Color/no-color | Process.env checking | `initColor()` + `colorize()` from @ccaudit/terminal |

---

## Common Pitfalls

### Pitfall 1: Using `original_value` from disable op for MCP re-enable

**What goes wrong:** Restoring the manifest's `original_value` field instead of the current value found at `op.new_key`. D-09 explicitly says to reverse the key-rename in-place, preserving any edits the user made to the config value between bust and restore.

**Why it happens:** `op.original_value` looks like the obvious thing to restore.

**How to avoid:** Find `config[op.new_key]` (or its nested equivalent for project scope), use THAT value to put under the restored key. Ignore `op.original_value` for the move operation.

### Pitfall 2: Flattening nested archive path structure

**What goes wrong:** Using `path.basename(op.archive_path)` to find the file instead of using `op.archive_path` directly. If a file was in `agents/design/foo.md`, its archive path is `_archived/design/foo.md` (not `_archived/foo.md`).

**How to avoid:** Use `op.archive_path` verbatim from the manifest. Never recompute it.

### Pitfall 3: Missing `.mcp.json` flat schema in re-enable

**What goes wrong:** Treating all MCP re-enable as `~/.claude.json` nested schema, which breaks for flat `.mcp.json` files. The disabled key in `.mcp.json` is at document root, not inside a `mcpServers` object.

**How to avoid:** Same `path.basename(configPath) === '.mcp.json'` detection used in bust.ts `disableMcpTransactional`. For flat schema: the disabled entry is at `config[op.new_key]` (document root); move it to `config.mcpServers[serverName]`.

### Pitfall 4: Ignoring partial-bust marker before restore

**What goes wrong:** Reading a manifest with no footer and proceeding silently without the D-06 warning.

**How to avoid:** Check `result.footer === null` after `readManifest()`. If header is present but footer is absent, print the partial-bust warning before executing ops.

### Pitfall 5: `--list` skipping process gate causes confusion

**What goes wrong:** Running process gate in `--list` mode, causing a confusing "Claude is running" error for a read-only operation.

**How to avoid:** D-14 explicitly states `--list` skips the gate. Branch on mode BEFORE calling `detectClaudeProcesses`.

### Pitfall 6: SHA256 tamper check on `archive_path` before `rename`

**What goes wrong:** Reading the file AFTER the rename for hash comparison (too late — the file is now at `source_path`).

**How to avoid:** Read bytes from `op.archive_path`, compute SHA256, compare with `op.content_sha256`, then perform the rename. Read → compare → rename is the correct sequence.

---

## Sources

### Primary (HIGH confidence)
- `packages/internal/src/remediation/manifest.ts` — `readManifest`, all op types, `resolveManifestPath` [VERIFIED]
- `packages/internal/src/remediation/bust.ts` — `BustDeps` interface, `disableMcpTransactional`, execution order [VERIFIED]
- `packages/internal/src/remediation/processes.ts` — `detectClaudeProcesses`, `ProcessDetectorDeps` [VERIFIED]
- `packages/internal/src/remediation/atomic-write.ts` — `atomicWriteJson`, retry logic [VERIFIED]
- `packages/internal/src/remediation/frontmatter.ts` — `patchFrontmatter`, exotic-yaml guard [VERIFIED]
- `packages/internal/src/remediation/collisions.ts` — `buildArchivePath`, `timestampSuffixForFilename` [VERIFIED]
- `packages/internal/src/remediation/index.ts` — barrel export pattern [VERIFIED]
- `apps/ccaudit/src/cli/commands/ghost.ts` — gunshi command definition pattern with `toKebab: true` [VERIFIED]
- `apps/ccaudit/src/cli/index.ts` — subCommands registration pattern [VERIFIED]
- `apps/ccaudit/src/cli/_shared-args.ts` — `outputArgs` definition [VERIFIED]
- `apps/ccaudit/src/cli/_output-mode.ts` — `resolveOutputMode`, `buildJsonEnvelope` [VERIFIED]
- `apps/ccaudit/src/__tests__/bust-command.test.ts` — subprocess integration test pattern [VERIFIED]
- `node_modules/.pnpm/gunshi@0.29.3/.../types-CcuJzRjy.d.ts` line 707 — `ctx._: string[]` positionals [VERIFIED]
- `.planning/phases/09-restore-rollback/09-CONTEXT.md` — all locked decisions D-01 through D-16 [VERIFIED]
- `.planning/phases/08-remediation-core/08-CONTEXT.md` — manifest schema D-09..D-12, dual-schema MCP D-13 [VERIFIED]

### Tertiary (LOW confidence — ASSUMED)
- Edge case: source_path occupied on restore → warn + skip (consistent with D-09 collision policy) [A1]
- Edge case: dotted MCP server names in `original_key` extraction → use `lastIndexOf('.mcpServers.')` [A2]
- Empty frontmatter block after key removal → remove entire `---\n---\n` block [A3]
- `restore <name>` does NOT match refresh ops (only archive + disable) [A4]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | source_path occupied → warn + skip (not overwrite) | Section 7, Q1 | Could overwrite a file the user created post-bust — high impact but low likelihood |
| A2 | Dotted MCP server names: use `lastIndexOf('.mcpServers.')` for extraction | Section 10 Q2 | Would match wrong server name fragment for dotted server names; low real-world impact |
| A3 | Remove entire frontmatter block if all body lines blank after key removal | Section 4, Q4 | Minor cosmetic difference — empty `---\n---\n` block left in file instead of none |
| A4 | `restore <name>` does not match refresh ops | Section 8 | Refresh ops are not restorable by name; this is likely correct behavior per D-02 semantics |

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all libraries verified in existing codebase
- Architecture: HIGH — directly mirrors bust.ts with verified patterns
- Frontmatter extension: HIGH — code read, extension pattern is clear
- gunshi positional args: HIGH — verified in gunshi type definitions (ctx._)
- MCP re-enable dual schema: HIGH — bust.ts disableMcpTransactional fully read and understood
- Edge cases: LOW/ASSUMED — flagged in assumptions log

**Research date:** 2026-04-05
**Valid until:** 2026-05-05 (stable codebase, internal only — no external version dependencies)

---

## RESEARCH COMPLETE
