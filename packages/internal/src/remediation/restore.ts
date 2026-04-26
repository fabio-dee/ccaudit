// @ccaudit/internal -- restore orchestrator (Phase 9 Plan 01)
//
// executeRestore() is the entry point for `ccaudit restore`. It wires manifest
// discovery, running-process gate, manifest integrity checks, and op execution
// into the full restore pipeline described in Phase 9 CONTEXT.md.
//
// Architecture follows Phase 8 bust.ts precisely:
//   - All I/O paths are behind RestoreDeps (injectable for unit tests)
//   - Op execution is STUBBED in this plan (Plan 02 implements real executors)
//   - RestoreResult is a discriminated union covering all outcomes
//
// Execution order per CONTEXT.md specifics:
//   strip flags (memory) → re-enable MCP → unarchive skills → unarchive agents
//
// Running-process gate (D-14):
//   - Full restore and single-item restore: gate BEFORE any fs mutation
//   - List mode (read-only): skip the gate
//
// Manifest integrity rules:
//   - header present + footer present  → clean bust
//   - header present + footer missing  → partial bust: warn via onWarning + proceed (D-06)
//   - header missing                   → corrupt manifest: refuse with manifest-corrupt (D-07)

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ArchiveOp,
  DisableOp,
  FlagOp,
  ManifestEntry,
  ManifestOp,
  ReadManifestResult,
  RefreshOp,
} from './manifest.ts';
import type { FrontmatterRemoveResult } from './frontmatter.ts';
import type { ProcessDetectorDeps } from './processes.ts';
import { detectClaudeProcesses, walkParentChain } from './processes.ts';

// -- Deps interface -----------------------------------------------

/**
 * Dependency injection surface for executeRestore.
 *
 * Mirrors BustDeps structure from bust.ts so that production callers can build
 * a deps object from the same primitives. Op executor fields (renameFile, etc.)
 * are stubs in Plan 01 and wired to real implementations in Plan 02.
 */
export interface RestoreDeps {
  // Manifest discovery + reading
  discoverManifests: () => Promise<ManifestEntry[]>;
  readManifest: (p: string) => Promise<ReadManifestResult>;

  // Process gate (D-14)
  processDetector: ProcessDetectorDeps;
  selfPid: number;

  // Filesystem ops (stubs in this plan — Plan 02 wires real fs)
  renameFile: (from: string, to: string) => Promise<void>;
  mkdirRecursive: (dir: string, mode?: number) => Promise<void>;
  readFileBytes: (p: string) => Promise<Buffer>;
  pathExists: (p: string) => Promise<boolean>;

  // Memory file frontmatter ops
  removeFrontmatterKeys: (filePath: string, keys: string[]) => Promise<FrontmatterRemoveResult>;
  setFrontmatterValue: (
    filePath: string,
    key: string,
    value: string,
  ) => Promise<FrontmatterRemoveResult>;

  // MCP re-enable (Plan 02 wires these)
  readFileUtf8: (p: string) => Promise<string>;
  atomicWriteJson: <T>(targetPath: string, value: T) => Promise<void>;

  // Runtime
  now: () => Date;

  // Optional warning sink (for --verbose + test capture)
  onWarning?: (msg: string) => void;
}

// -- Result types -------------------------------------------------

/**
 * Per-category op counters for the restore summary.
 *
 * unarchived.moved         — files actually renamed from archive → source
 * unarchived.alreadyAtSource — files already at source (archive missing): no-op,
 *                             NOT counted as a rename (Phase 3 fix)
 * unarchived.failed        — files that could not be restored
 */
export interface RestoreCounts {
  unarchived: { moved: number; alreadyAtSource: number; failed: number };
  reenabled: { completed: number; failed: number };
  stripped: { completed: number; failed: number };
}

/**
 * A single entry in the --list output.
 */
export interface ManifestListEntry {
  path: string;
  mtime: Date;
  isPartial: boolean;
  opCount: number;
  ops: ManifestOp[];
}

/**
 * Discriminated result union for executeRestore.
 *
 * Exit code mapping (CLI layer responsibility):
 *   success               → 0
 *   partial-success       → 1
 *   no-manifests          → 0  (informational: no bust history)
 *   name-not-found        → 0  (informational: no such archived item)
 *   manifest-corrupt      → 1  (D-07: header missing)
 *   list                  → 0  (read-only listing)
 *   running-process       → 3  (D-14: Claude Code is running)
 *   process-detection-failed → 3  (fail-closed per D-14)
 *   config-parse-error    → 1  (D-15 fail-fast on ~/.claude.json / .mcp.json)
 *   config-write-error    → 1
 */
export type RestoreResult =
  | {
      status: 'success';
      counts: RestoreCounts;
      manifestPath: string;
      manifestPaths: string[];
      duration_ms: number;
      /**
       * D8-16: null for full restore, { mode: 'subset', ids } for
       * interactive / all-matching subset restore. Optional to keep
       * existing call sites type-compatible; treat `undefined` as `null`.
       */
      selectionFilter?: { mode: 'subset'; ids: string[] } | null;
      /**
       * D8-14: per-item source-exists skips aggregated across all
       * manifests touched by this restore. Empty when nothing skipped.
       */
      skipped: Array<{ reason: 'source_exists'; path: string; canonical_id: string }>;
      // Phase 8.2 / SC6: additive. Count of archive ops suppressed
      // (archive_missing + source_exists). Callers treat undefined as 0.
      filteredStaleCount?: number;
    }
  | {
      status: 'partial-success';
      counts: RestoreCounts;
      failed: number;
      manifestPath: string;
      manifestPaths: string[];
      duration_ms: number;
      selectionFilter?: { mode: 'subset'; ids: string[] } | null;
      skipped: Array<{ reason: 'source_exists'; path: string; canonical_id: string }>;
      filteredStaleCount?: number;
    }
  | { status: 'no-manifests' }
  | { status: 'name-not-found'; name: string }
  | { status: 'manifest-corrupt'; path: string }
  | { status: 'list'; entries: ManifestListEntry[]; filteredStaleCount: number }
  | { status: 'running-process'; pids: number[]; selfInvocation: boolean; message: string }
  | { status: 'process-detection-failed'; error: string }
  | { status: 'config-parse-error'; path: string; error: string }
  | { status: 'config-write-error'; path: string; error: string };

/**
 * Restore mode discriminated union.
 * - full:   restore all ops from the most recent manifest
 * - single: restore ops matching a specific item name
 * - list:   read-only listing of all manifests (skips process gate)
 */
export type RestoreMode =
  | { kind: 'full' }
  | { kind: 'single'; name: string }
  | { kind: 'list' }
  | { kind: 'interactive'; ids: string[] }
  | { kind: 'all-matching'; pattern: string };

// -- Helpers ------------------------------------------------------

/**
 * Validate that a path stays within the user's home directory.
 *
 * A crafted or corrupted manifest could reference paths outside ~/.
 * This guard is applied to every path before any filesystem mutation.
 * Returns an error string on failure, undefined on success.
 */
function assertWithinHomedir(p: string): string | undefined {
  const home = homedir();
  // Normalise both sides so symlinks, `.`, `..` in the manifest path
  // don't trick a simple startsWith check.
  const normalised = path.resolve(p);
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalised !== home && !normalised.startsWith(homeWithSep)) {
    return `manifest-corrupt: path escapes home directory: ${p}`;
  }
  return undefined;
}

/**
 * Return all manifest entries newest-first from discoverManifests.
 *
 * Phase 3 fix: previously this function returned only entries[0] (the newest),
 * making every prior bust's archived items unreachable orphans. Now returns
 * the full sorted list so executeRestore can walk all manifests.
 *
 * Returns [] when there are no manifests (no bust history).
 */
export async function findManifestsForRestore(deps: RestoreDeps): Promise<ManifestEntry[]> {
  return deps.discoverManifests();
}

/**
 * Dedup entry+op pairs across a newest-first list of ManifestEntry objects (D8-05).
 *
 * Input invariant: `entries` is already sorted newest-first (findManifestsForRestore
 * returns entries in that order). Dedup preserves iteration order and keeps the
 * first occurrence of each canonical_id — so older duplicates are filtered out.
 *
 * canonical_id derivation:
 *   - archive op  → `${category}:${archive_path}`   (e.g. "skill:/home/u/.claude/skills/foo")
 *   - disable op  → `mcp:${config_path}:${new_key}` (scoped per config file + renamed key)
 *
 * flag/refresh/skipped ops are excluded (not restorable as distinct items under
 * this phase's interactive restore UX).
 */
export function dedupManifestOps(
  entries: Array<{ entry: ManifestEntry; ops: readonly ManifestOp[] }>,
): Array<{ entry: ManifestEntry; op: ArchiveOp | DisableOp; canonical_id: string }> {
  // Phase 9 SC6: archive_purge follow-up ops suppress their originals from
  // restore candidates. Pass 1 collects every `original_op_id` that was
  // purged across all manifests; pass 2 runs the existing dedup, skipping
  // archive ops whose op_id appears in the purged set.
  const purgedOriginalOpIds = collectPurgedOpIds(entries);

  // Keyed by canonical_id; first-seen wins (newest-first input ⇒ newer wins).
  const seen = new Map<
    string,
    { entry: ManifestEntry; op: ArchiveOp | DisableOp; canonical_id: string }
  >();
  for (const { entry, ops } of entries) {
    for (const op of ops) {
      let canonical_id: string;
      if (op.op_type === 'archive') {
        if (purgedOriginalOpIds.has(op.op_id)) continue;
        canonical_id = `${op.category}:${op.archive_path}`;
      } else if (op.op_type === 'disable') {
        canonical_id = `mcp:${op.config_path}:${op.new_key}`;
      } else {
        continue; // flag / refresh / skipped / archive_purge ops are not dedup targets
      }
      if (!seen.has(canonical_id)) {
        seen.set(canonical_id, { entry, op, canonical_id });
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Scan every op across all manifests for `archive_purge` follow-ups and
 * return the set of `original_op_id` values they reference. A later
 * archive_purge op suppresses its originating ArchiveOp from restore
 * candidates (the archive has been drained).
 */
function collectPurgedOpIds(
  entries: Array<{ entry: ManifestEntry; ops: readonly ManifestOp[] }>,
): Set<string> {
  const purged = new Set<string>();
  for (const { ops } of entries) {
    for (const op of ops) {
      if (op.op_type === 'archive_purge') {
        purged.add(op.original_op_id);
      }
    }
  }
  return purged;
}

/**
 * Collect restoreable ops including memory ops (FlagOp / RefreshOp) for the
 * interactive restore picker (D81-01 / Phase 8.1 C1a).
 *
 * Sibling to `dedupManifestOps` — that function drops flag/refresh/skipped ops
 * because `executeRestore`'s `--name` / `--all-matching` paths need the strict
 * `ArchiveOp | DisableOp` shape. The interactive picker, however, must surface
 * memory items so users can undo frontmatter flags from the TUI.
 *
 * canonical_id derivation:
 *   - archive op           → `${category}:${archive_path}`
 *   - disable op           → `mcp:${config_path}:${new_key}`
 *   - flag / refresh op    → `memory:${file_path}`
 *
 * Skipped ops are omitted — by construction they represent items the bust
 * could not operate on, so they are not restoreable.
 *
 * Input invariant: `entries` is newest-first (as returned by
 * `findManifestsForRestore`). First-seen wins → newer manifest wins.
 */
export type RestoreableOp = ArchiveOp | DisableOp | FlagOp | RefreshOp;

export function collectRestoreableItems(
  entries: Array<{ entry: ManifestEntry; ops: readonly ManifestOp[] }>,
): Array<{ entry: ManifestEntry; op: RestoreableOp; canonical_id: string }> {
  // Phase 9 SC6: archive_purge follow-ups suppress their originals here too.
  const purgedOriginalOpIds = collectPurgedOpIds(entries);
  const seen = new Map<string, { entry: ManifestEntry; op: RestoreableOp; canonical_id: string }>();
  for (const { entry, ops } of entries) {
    for (const op of ops) {
      let canonical_id: string;
      if (op.op_type === 'archive') {
        if (purgedOriginalOpIds.has(op.op_id)) continue;
        canonical_id = `${op.category}:${op.archive_path}`;
      } else if (op.op_type === 'disable') {
        canonical_id = `mcp:${op.config_path}:${op.new_key}`;
      } else if (op.op_type === 'flag' || op.op_type === 'refresh') {
        // INV-S3: distinct flag/refresh ops on the same file MUST remain individually
        // restoreable. Including op_type and op_id (uuid) guarantees uniqueness.
        canonical_id = `memory:${op.op_type}:${op.file_path}:${op.op_id}`;
      } else {
        continue; // skipped / archive_purge ops are not restoreable
      }
      if (!seen.has(canonical_id)) {
        seen.set(canonical_id, { entry, op, canonical_id });
      }
    }
  }
  return Array.from(seen.values());
}

// Phase 8.2: Stale-archive predicate for restore listing hygiene. An
// archive op is stale iff archive_path is gone AND source_path is back
// — the already-restored / test-residue shape. Both-paths-missing is
// kept listed (D-02) so the executor can surface the fail-loud signal.
export async function isStaleArchiveOp(
  op: ArchiveOp,
  pathExists: (p: string) => Promise<boolean>,
): Promise<boolean> {
  const [archiveStillThere, sourceBack] = await Promise.all([
    pathExists(op.archive_path),
    pathExists(op.source_path),
  ]);
  return !archiveStillThere && sourceBack;
}

// Phase 8.2: Filter a collected restoreable-items list, dropping only
// stale ARCHIVE ops. Flag / disable / refresh pass through (D-03 / SC2).
export async function filterRestoreableItems(
  items: ReadonlyArray<{ entry: ManifestEntry; op: RestoreableOp; canonical_id: string }>,
  pathExists: (p: string) => Promise<boolean>,
): Promise<{
  kept: Array<{ entry: ManifestEntry; op: RestoreableOp; canonical_id: string }>;
  filteredStaleCount: number;
}> {
  const kept: Array<{ entry: ManifestEntry; op: RestoreableOp; canonical_id: string }> = [];
  let filteredStaleCount = 0;
  for (const item of items) {
    if (item.op.op_type === 'archive' && (await isStaleArchiveOp(item.op, pathExists))) {
      filteredStaleCount += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, filteredStaleCount };
}

/**
 * Case-insensitive substring matcher over a pre-deduped op list (D8-08).
 *
 * Matching rules:
 *   - archive op  → basename of archive_path (without extension)
 *   - disable op  → extractServerName(original_key)
 *   - pattern     → lowercase, substring `includes` over the display name
 *   - empty / whitespace-only pattern → [] (guards against accidental match-all)
 *
 * Output is sorted lex ASC by canonical_id for deterministic tiebreaks. No
 * ranking, no scoring — pure inclusion/exclusion.
 */
export function matchByName(
  items: Array<{ canonical_id: string; op: ArchiveOp | DisableOp }>,
  pattern: string,
): Array<{ canonical_id: string; op: ArchiveOp | DisableOp }> {
  if (!pattern || pattern.trim().length === 0) return [];
  const needle = pattern.toLowerCase();
  const matches = items.filter((item) => {
    let displayName: string;
    if (item.op.op_type === 'archive') {
      displayName = path.basename(item.op.archive_path, path.extname(item.op.archive_path));
    } else {
      displayName = extractServerName(item.op.original_key);
    }
    return displayName.toLowerCase().includes(needle);
  });
  matches.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );
  return matches;
}

/**
 * Extract the server name from an original_key field that may use either
 * flat (mcpServers.<name>) or nested (projects.<path>.mcpServers.<name>) schema.
 *
 * Uses lastIndexOf('.mcpServers.') so that server names containing dots
 * (e.g. 'my.server') parse correctly (RESEARCH Q2 defensive extraction).
 *
 * @example
 *   extractServerName('mcpServers.playwright')            // → 'playwright'
 *   extractServerName('projects./foo.mcpServers.my.srv') // → 'my.srv'
 */
export function extractServerName(originalKey: string): string {
  const mcpIdx = originalKey.lastIndexOf('.mcpServers.');
  if (mcpIdx >= 0) {
    return originalKey.slice(mcpIdx + '.mcpServers.'.length);
  }
  if (originalKey.startsWith('mcpServers.')) {
    return originalKey.slice('mcpServers.'.length);
  }
  return originalKey;
}

/**
 * Search all manifests newest-first for one containing ops that match `name`.
 *
 * Matching rules per D-02 + CONTEXT specifics:
 * - archive ops: match by basename of archive_path (without extension)
 * - disable ops: match by extractServerName(original_key)
 *
 * Returns the manifest entry, its parsed content, and the matched ops,
 * or null if no match found across any manifest.
 */
export async function findManifestForName(
  name: string,
  deps: RestoreDeps,
): Promise<{
  entry: ManifestEntry;
  manifest: ReadManifestResult;
  matchedOps: ManifestOp[];
} | null> {
  const entries = await deps.discoverManifests();
  for (const entry of entries) {
    const manifest = await deps.readManifest(entry.path);
    const matchedOps: ManifestOp[] = [];
    for (const op of manifest.ops) {
      if (op.op_type === 'archive') {
        const basename = path.basename(op.archive_path, path.extname(op.archive_path));
        if (basename === name) matchedOps.push(op);
      } else if (op.op_type === 'disable') {
        if (extractServerName(op.original_key) === name) matchedOps.push(op);
      }
    }
    if (matchedOps.length > 0) {
      return { entry, manifest, matchedOps };
    }
  }
  return null;
}

// -- Process gate message -----------------------------------------

function buildProcessGateMessage(processes: Array<{ pid: number; command?: string }>): string {
  const lines = processes.map((p) => `  PID ${p.pid}${p.command ? ` (${p.command})` : ''}`);
  return [
    'Claude Code is running. Refusing to mutate ~/.claude.json while other sessions are active.',
    ...lines,
    'Stop all Claude Code processes and re-run ccaudit restore.',
  ].join('\n');
}

// -- List mode ----------------------------------------------------

async function executeListMode(deps: RestoreDeps): Promise<RestoreResult> {
  const entries = await deps.discoverManifests();
  const listEntries: ManifestListEntry[] = [];
  let filteredStaleCount = 0;
  for (const entry of entries) {
    // M9: skip purge manifests — their archive_purge records are not restoreable
    // items and should not appear in --list output as additional "busts".
    // Two-tier detection: canonical filename prefix (primary) + ops-shape check
    // (defense-in-depth for hand-named files).
    const basename = path.basename(entry.path);
    if (basename.startsWith('purge-')) continue;

    const manifest = await deps.readManifest(entry.path);
    if (manifest.header === null) continue; // corrupt: silently skip in list mode

    // Defense-in-depth: if all ops are archive_purge, skip regardless of filename.
    if (manifest.ops.length > 0 && manifest.ops.every((op) => op.op_type === 'archive_purge')) {
      continue;
    }

    // Phase 8.2: drop stale archive ops (archive_missing + source_exists)
    // from per-entry op lists so `--list` mirrors the listing hygiene
    // applied in the interactive picker and full-restore paths.
    const kept: ManifestOp[] = [];
    for (const op of manifest.ops) {
      if (op.op_type === 'archive' && (await isStaleArchiveOp(op, deps.pathExists))) {
        filteredStaleCount += 1;
        continue;
      }
      kept.push(op);
    }
    listEntries.push({
      path: entry.path,
      mtime: entry.mtime,
      isPartial: manifest.footer === null,
      opCount: kept.length,
      ops: kept,
    });
  }
  return { status: 'list', entries: listEntries, filteredStaleCount };
}

// -- Internal result type for MCP re-enable ----------------------

type ReEnableResult =
  | { status: 'ok'; completed: number; failed: number }
  | { status: 'config-parse-error'; path: string; error: string }
  | { status: 'config-write-error'; path: string; error: string };

// -- Op executors (Plan 02) ----------------------------------------

/**
 * Restore one archived agent or skill: rename archive_path → source_path.
 *
 * - Q1: if source_path already exists, warn and count as failed (skip rather
 *   than overwrite).
 * - D-13: SHA256 tamper check — warn and proceed (do NOT fail).
 * - D-08: mkdirRecursive parent directory before rename.
 * - Continue-on-error: returns 'failed' without throwing so the outer loop
 *   can continue with remaining ops.
 */
export async function restoreArchiveOp(
  op: ArchiveOp,
  deps: RestoreDeps,
): Promise<'moved' | 'already-at-source' | 'failed'> {
  // Boundary check: both paths must stay within the user's home directory
  const sourceErr = assertWithinHomedir(op.source_path);
  if (sourceErr !== undefined) {
    deps.onWarning?.(sourceErr);
    return 'failed';
  }
  const archiveErr = assertWithinHomedir(op.archive_path);
  if (archiveErr !== undefined) {
    deps.onWarning?.(archiveErr);
    return 'failed';
  }

  // Q1: check if source_path already exists.
  // If the archive also doesn't exist, the file was already restored externally
  // or the bust never actually moved it — classify as 'already-at-source' so it
  // is NOT counted as a successful rename operation. This prevents false-positive
  // inflation of the restored count (Phase 3 fix).
  // If BOTH source and archive exist, there is a genuine collision — warn and
  // classify as 'already-at-source' (v1 policy: don't overwrite). Document
  // the collision in the warning message so the user can act manually.
  if (await deps.pathExists(op.source_path)) {
    if (!(await deps.pathExists(op.archive_path))) {
      // Already in original location with no archive copy — nothing to do.
      deps.onWarning?.(
        `ℹ️  ${path.basename(op.source_path)} already at source (no archive copy) — skipping`,
      );
      return 'already-at-source';
    }
    // Both exist: collision. Treat as already-at-source (don't overwrite) per v1 policy.
    deps.onWarning?.(
      `⚠️  ${path.basename(op.source_path)} exists at both source and archive — skipping to avoid overwrite (restore manually if needed)`,
    );
    return 'already-at-source';
  }

  // D-13: SHA256 tamper detection on archive_path (warn, proceed)
  try {
    const bytes = await deps.readFileBytes(op.archive_path);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== op.content_sha256) {
      deps.onWarning?.(
        `⚠️  ${path.basename(op.source_path)} was modified after archiving — restoring anyway`,
      );
    }
  } catch {
    // Hash read failure isn't fatal — rename will surface the real error below
  }

  // D-08: mkdir parent directory before rename
  try {
    await deps.mkdirRecursive(path.dirname(op.source_path));
  } catch (err) {
    deps.onWarning?.(
      `✗ ${path.basename(op.source_path)} — mkdir failed: ${(err as Error).message}`,
    );
    return 'failed';
  }

  // Rename archive → source
  try {
    await deps.renameFile(op.archive_path, op.source_path);
    return 'moved';
  } catch (err) {
    deps.onWarning?.(`✗ ${path.basename(op.source_path)} — ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * Re-enable MCP servers by reversing disable ops.
 *
 * Groups by config_path (fail-fast per config file per D-15).
 * Handles dual schema:
 *   - flat .mcp.json:        config[new_key] → config.mcpServers[serverName]
 *   - nested ~/.claude.json global:  config[new_key] → config.mcpServers[serverName]
 *   - nested ~/.claude.json project: config.projects[path][new_key] → config.projects[path].mcpServers[serverName]
 *
 * D-09: uses CURRENT value at new_key (not op.original_value) to preserve
 * user edits made between bust and restore.
 */
export async function reEnableMcpTransactional(
  disableOps: DisableOp[],
  deps: RestoreDeps,
): Promise<ReEnableResult> {
  let completed = 0;
  const failed = 0;

  // Group by config file — each file is its own transaction (D-15 fail-fast)
  const byConfigPath = new Map<string, DisableOp[]>();
  for (const op of disableOps) {
    const list = byConfigPath.get(op.config_path) ?? [];
    list.push(op);
    byConfigPath.set(op.config_path, list);
  }

  for (const [configPath, ops] of byConfigPath) {
    // Boundary check: config file must stay within the user's home directory
    const configErr = assertWithinHomedir(configPath);
    if (configErr !== undefined) {
      return { status: 'config-parse-error', path: configPath, error: configErr };
    }

    const isFlatMcpJson = path.basename(configPath) === '.mcp.json';

    let raw: string;
    try {
      raw = await deps.readFileUtf8(configPath);
    } catch (err) {
      return { status: 'config-parse-error', path: configPath, error: (err as Error).message };
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return { status: 'config-parse-error', path: configPath, error: (err as Error).message };
    }

    for (const op of ops) {
      const serverName = extractServerName(op.original_key);

      // Nested ~/.claude.json project scope (non-.mcp.json, scope=project, project_path present)
      if (op.scope === 'project' && !isFlatMcpJson && op.project_path !== null) {
        const projects = (config['projects'] as Record<string, unknown> | undefined) ?? {};
        const proj = projects[op.project_path] as Record<string, unknown> | undefined;
        if (proj === undefined || !(op.new_key in proj)) {
          deps.onWarning?.(
            `⚠️  ${serverName}: already re-enabled or missing from ${configPath} — skipping`,
          );
          continue;
        }
        const mcpServers = (proj['mcpServers'] as Record<string, unknown> | undefined) ?? {};
        if (serverName in mcpServers) {
          deps.onWarning?.(
            `⚠️  ${serverName}: already present in mcpServers of ${configPath} — skipping (collision)`,
          );
          continue;
        }
        // D-09: use CURRENT value at new_key, not op.original_value
        const currentValue = proj[op.new_key];
        mcpServers[serverName] = currentValue;
        proj['mcpServers'] = mcpServers;
        delete proj[op.new_key];
        projects[op.project_path] = proj;
        config['projects'] = projects;
        completed++;
      } else {
        // Flat .mcp.json OR nested global ~/.claude.json:
        // config[new_key] → config.mcpServers[serverName]
        if (!(op.new_key in config)) {
          deps.onWarning?.(
            `⚠️  ${serverName}: already re-enabled or missing from ${configPath} — skipping`,
          );
          continue;
        }
        const mcpServers = (config['mcpServers'] as Record<string, unknown> | undefined) ?? {};
        if (serverName in mcpServers) {
          deps.onWarning?.(
            `⚠️  ${serverName}: already present in mcpServers of ${configPath} — skipping (collision)`,
          );
          continue;
        }
        // D-09: use CURRENT value at new_key, not op.original_value
        const currentValue = config[op.new_key];
        mcpServers[serverName] = currentValue;
        config['mcpServers'] = mcpServers;
        delete config[op.new_key];
        completed++;
      }
    }

    // Atomic write per config file (D-15 transactional)
    try {
      await deps.atomicWriteJson(configPath, config);
    } catch (err) {
      return {
        status: 'config-write-error',
        path: configPath,
        error: (err as Error).message,
      };
    }
  }

  return { status: 'ok', completed, failed };
}

/**
 * Strip ccaudit frontmatter keys from a memory file (D-10).
 *
 * Calls removeFrontmatterKeys with both ccaudit keys. Treats
 * no-frontmatter and keys-not-found as completed (nothing to undo).
 * Only skipped (exotic-yaml, read/write error) counts as failed.
 */
export async function restoreFlagOp(
  op: FlagOp,
  deps: RestoreDeps,
): Promise<'completed' | 'failed'> {
  const result = await deps.removeFrontmatterKeys(op.file_path, [
    'ccaudit-stale',
    'ccaudit-flagged',
  ]);
  switch (result.status) {
    case 'removed':
      return 'completed';
    case 'no-frontmatter':
    case 'keys-not-found':
      // User or another tool already removed the keys — treat as done
      return 'completed';
    case 'skipped':
      deps.onWarning?.(`✗ ${path.basename(op.file_path)} — frontmatter skipped (${result.reason})`);
      return 'failed';
    default:
      return 'failed';
  }
}

/**
 * Restore the previous ccaudit-flagged timestamp (D-11).
 *
 * Calls setFrontmatterValue to replace the current ccaudit-flagged value
 * with op.previous_flagged_at. Leaves ccaudit-stale intact (D-11).
 */
export async function restoreRefreshOp(
  op: RefreshOp,
  deps: RestoreDeps,
): Promise<'completed' | 'failed'> {
  const result = await deps.setFrontmatterValue(
    op.file_path,
    'ccaudit-flagged',
    op.previous_flagged_at,
  );
  switch (result.status) {
    case 'updated':
      return 'completed';
    case 'no-frontmatter':
    case 'keys-not-found':
      // Nothing to update — file may have been edited after bust; treat as done
      return 'completed';
    case 'skipped':
      deps.onWarning?.(`✗ ${path.basename(op.file_path)} — frontmatter skipped (${result.reason})`);
      return 'failed';
    default:
      return 'failed';
  }
}

// -- Op execution (Plan 02 implementation) ------------------------

/**
 * Execute ops from a manifest entry and return a RestoreResult.
 *
 * Locked execution order per CONTEXT.md + RESEARCH Section 8:
 *   1. Refresh ops  (restore previous timestamp, D-11)
 *   2. Flag ops     (strip ccaudit keys, D-10)
 *   3. MCP re-enable (transactional per config file, D-09, D-15)
 *   4. Skill unarchive (ArchiveOp category=skill)
 *   5. Agent unarchive (ArchiveOp category=agent)
 *
 * Failure policy (D-15 hybrid):
 *   - fs ops (archive / flag / refresh): continue-on-error within category
 *   - MCP ops: fail-fast per config file (returns config-parse/write-error)
 */
async function executeOpsOnManifest(
  entry: ManifestEntry,
  ops: ManifestOp[],
  deps: RestoreDeps,
  start: number,
  allEntryPaths?: string[],
  /**
   * Optional map from ArchiveOp.archive_path → canonical_id so that the
   * subset-restore path can populate skipped[] entries with stable ids.
   * When provided, archive ops whose source_path already exists are
   * recorded in the returned result's skipped[] array.
   */
  canonicalIdByArchivePath?: Map<string, string>,
  // Phase 8.2: stale ops suppressed upstream (threaded to CLI envelope)
  filteredStaleCount = 0,
): Promise<RestoreResult> {
  const skipped: Array<{ reason: 'source_exists'; path: string; canonical_id: string }> = [];
  const counts: RestoreCounts = {
    unarchived: { moved: 0, alreadyAtSource: 0, failed: 0 },
    reenabled: { completed: 0, failed: 0 },
    stripped: { completed: 0, failed: 0 },
  };

  // Partition ops by type
  const archiveOps = ops.filter((o): o is ArchiveOp => o.op_type === 'archive');
  const disableOps = ops.filter((o): o is DisableOp => o.op_type === 'disable');
  const flagOps = ops.filter((o): o is FlagOp => o.op_type === 'flag');
  const refreshOps = ops.filter((o): o is RefreshOp => o.op_type === 'refresh');
  // D-12: skipped ops require no action on restore

  // Step 1: Refresh ops (restore previous timestamp, D-11)
  for (const op of refreshOps) {
    const outcome = await restoreRefreshOp(op, deps);
    if (outcome === 'completed') counts.stripped.completed++;
    else counts.stripped.failed++;
  }

  // Step 2: Flag ops (strip ccaudit keys, D-10)
  for (const op of flagOps) {
    const outcome = await restoreFlagOp(op, deps);
    if (outcome === 'completed') counts.stripped.completed++;
    else counts.stripped.failed++;
  }

  // Step 3: MCP re-enable (D-09 transactional per config file, D-15 fail-fast)
  if (disableOps.length > 0) {
    const result = await reEnableMcpTransactional(disableOps, deps);
    if (result.status === 'config-parse-error') {
      return { status: 'config-parse-error', path: result.path, error: result.error };
    }
    if (result.status === 'config-write-error') {
      return { status: 'config-write-error', path: result.path, error: result.error };
    }
    counts.reenabled.completed = result.completed;
    counts.reenabled.failed = result.failed;
  }

  // Step 4: Unarchive skills (before agents per locked order)
  const skillOps = archiveOps.filter((o) => o.category === 'skill');
  for (const op of skillOps) {
    const outcome = await restoreArchiveOp(op, deps);
    if (outcome === 'moved') counts.unarchived.moved++;
    else if (outcome === 'already-at-source') {
      counts.unarchived.alreadyAtSource++;
      const cid = canonicalIdByArchivePath?.get(op.archive_path);
      if (cid !== undefined) {
        skipped.push({ reason: 'source_exists', path: op.source_path, canonical_id: cid });
      }
    } else counts.unarchived.failed++;
  }

  // Step 5: Unarchive agents
  const agentOps = archiveOps.filter((o) => o.category === 'agent');
  for (const op of agentOps) {
    const outcome = await restoreArchiveOp(op, deps);
    if (outcome === 'moved') counts.unarchived.moved++;
    else if (outcome === 'already-at-source') {
      counts.unarchived.alreadyAtSource++;
      const cid = canonicalIdByArchivePath?.get(op.archive_path);
      if (cid !== undefined) {
        skipped.push({ reason: 'source_exists', path: op.source_path, canonical_id: cid });
      }
    } else counts.unarchived.failed++;
  }

  // Step 5.1: Unarchive commands (after agents, before totals)
  const commandOps = archiveOps.filter((o) => o.category === 'command');
  for (const op of commandOps) {
    const outcome = await restoreArchiveOp(op, deps);
    if (outcome === 'moved') counts.unarchived.moved++;
    else if (outcome === 'already-at-source') {
      counts.unarchived.alreadyAtSource++;
      const cid = canonicalIdByArchivePath?.get(op.archive_path);
      if (cid !== undefined) {
        skipped.push({ reason: 'source_exists', path: op.source_path, canonical_id: cid });
      }
    } else counts.unarchived.failed++;
  }

  const totalFailed = counts.unarchived.failed + counts.reenabled.failed + counts.stripped.failed;
  const duration_ms = Date.now() - start;
  const manifestPaths = allEntryPaths ?? [entry.path];
  if (totalFailed === 0) {
    return {
      status: 'success',
      counts,
      manifestPath: entry.path,
      manifestPaths,
      duration_ms,
      selectionFilter: null,
      skipped,
      filteredStaleCount,
    };
  }
  return {
    status: 'partial-success',
    counts,
    failed: totalFailed,
    manifestPath: entry.path,
    manifestPaths,
    duration_ms,
    selectionFilter: null,
    skipped,
    filteredStaleCount,
  };
}

/**
 * Group-selected ops by manifest, dispatch through executeOpsOnManifest
 * once per manifest, aggregate counts + skipped[] + manifestPaths.
 *
 * Shared between `{ kind: 'interactive' }` and `{ kind: 'all-matching' }`
 * (both are subset restores driven by a list of canonical_ids).
 *
 * Returns `{ status: 'no-manifests' }` when there is no bust history and
 * `{ status: 'name-not-found', name: '<ids[0]>' }` when the selected ids
 * match nothing in the restoreable op pool. Otherwise returns success /
 * partial-success with `selectionFilter: { mode: 'subset', ids }` and
 * the aggregated `skipped[]` array. No manifest is synthesized on disk.
 */
async function executeInteractiveOps(
  ids: string[],
  deps: RestoreDeps,
  start: number,
): Promise<RestoreResult> {
  const allEntries = await findManifestsForRestore(deps);
  if (allEntries.length === 0) return { status: 'no-manifests' };

  // Zip (entry, ops) for each valid manifest; silently skip corrupt ones
  // in the middle of the list (the full-restore path warns via onWarning;
  // subset restore keeps the invariant by also warning).
  const zipped: Array<{ entry: ManifestEntry; ops: readonly ManifestOp[] }> = [];
  for (const e of allEntries) {
    const m = await deps.readManifest(e.path);
    if (m.header === null) {
      deps.onWarning?.(`⚠️  Skipping corrupt manifest ${path.basename(e.path)} (no header record)`);
      continue;
    }
    zipped.push({ entry: e, ops: m.ops });
  }

  // Phase 8.2: strip stale archive ops before resolving ids.
  const { kept: collected, filteredStaleCount: interactiveFilteredStale } =
    await filterRestoreableItems(collectRestoreableItems(zipped), deps.pathExists);
  const availableById = new Map(collected.map((item) => [item.canonical_id, item]));
  const resolvedSelectedIds: string[] = [];
  const resolvedIdSet = new Set<string>();
  for (const id of ids) {
    if (resolvedIdSet.has(id)) continue;
    if (!availableById.has(id)) continue;
    resolvedIdSet.add(id);
    resolvedSelectedIds.push(id);
  }
  const selected = collected.filter((item) => resolvedIdSet.has(item.canonical_id));

  if (selected.length === 0) {
    // No id from the selection resolved to an op — mirror name-not-found
    // semantics (exit code 0, informational).
    return { status: 'name-not-found', name: ids[0] ?? '' };
  }

  // Group by originating manifest (reference equality on ManifestEntry).
  const byEntry = new Map<
    ManifestEntry,
    { entry: ManifestEntry; ops: ManifestOp[]; canonIds: Map<string, string> }
  >();
  for (const { entry, op, canonical_id } of selected) {
    let bucket = byEntry.get(entry);
    if (bucket === undefined) {
      bucket = { entry, ops: [], canonIds: new Map() };
      byEntry.set(entry, bucket);
    }
    bucket.ops.push(op);
    if (op.op_type === 'archive') {
      bucket.canonIds.set(op.archive_path, canonical_id);
    }
  }

  // Aggregate across all per-manifest dispatches.
  const agg: RestoreCounts = {
    unarchived: { moved: 0, alreadyAtSource: 0, failed: 0 },
    reenabled: { completed: 0, failed: 0 },
    stripped: { completed: 0, failed: 0 },
  };
  const aggSkipped: Array<{
    reason: 'source_exists';
    path: string;
    canonical_id: string;
  }> = [];
  const aggManifestPaths: string[] = [];
  let totalFailed = 0;
  let firstManifestPath: string | null = null;

  for (const bucket of byEntry.values()) {
    const perResult = await executeOpsOnManifest(
      bucket.entry,
      bucket.ops,
      deps,
      start,
      [bucket.entry.path],
      bucket.canonIds,
    );
    // Propagate hard-failure variants from MCP re-enable path unchanged.
    if (
      perResult.status === 'config-parse-error' ||
      perResult.status === 'config-write-error' ||
      perResult.status === 'manifest-corrupt'
    ) {
      return perResult;
    }
    if (perResult.status !== 'success' && perResult.status !== 'partial-success') {
      // Unexpected short-circuit variant — shouldn't happen for op execution,
      // but surface it rather than silently swallowing.
      return perResult;
    }
    agg.unarchived.moved += perResult.counts.unarchived.moved;
    agg.unarchived.alreadyAtSource += perResult.counts.unarchived.alreadyAtSource;
    agg.unarchived.failed += perResult.counts.unarchived.failed;
    agg.reenabled.completed += perResult.counts.reenabled.completed;
    agg.reenabled.failed += perResult.counts.reenabled.failed;
    agg.stripped.completed += perResult.counts.stripped.completed;
    agg.stripped.failed += perResult.counts.stripped.failed;
    aggSkipped.push(...perResult.skipped);
    aggManifestPaths.push(...perResult.manifestPaths);
    if (perResult.status === 'partial-success') {
      totalFailed += perResult.failed;
    }
    if (firstManifestPath === null) firstManifestPath = perResult.manifestPath;
  }

  const duration_ms = Date.now() - start;
  const manifestPath = firstManifestPath ?? '';
  const selectionFilter = { mode: 'subset' as const, ids: resolvedSelectedIds };
  if (totalFailed === 0) {
    return {
      status: 'success',
      counts: agg,
      manifestPath,
      manifestPaths: aggManifestPaths,
      duration_ms,
      selectionFilter,
      skipped: aggSkipped,
      filteredStaleCount: interactiveFilteredStale,
    };
  }
  return {
    status: 'partial-success',
    counts: agg,
    failed: totalFailed,
    manifestPath,
    manifestPaths: aggManifestPaths,
    duration_ms,
    selectionFilter,
    skipped: aggSkipped,
    filteredStaleCount: interactiveFilteredStale,
  };
}

// -- Main entry point ---------------------------------------------

/**
 * Execute the restore pipeline.
 *
 * @param mode   What to restore (full / single-item / list)
 * @param deps   Injectable dependency surface (production deps wired in Plan 03)
 */
export async function executeRestore(mode: RestoreMode, deps: RestoreDeps): Promise<RestoreResult> {
  const start = Date.now();

  // --list mode: read-only, skip process gate (D-14)
  if (mode.kind === 'list') {
    return executeListMode(deps);
  }

  // D-14: Running-process gate (full + single-item modes)
  const detection = await detectClaudeProcesses(deps.selfPid, deps.processDetector);
  if (detection.status === 'spawn-failed') {
    return { status: 'process-detection-failed', error: detection.error };
  }
  if (detection.processes.length > 0) {
    // D-04: walk our own parent chain; if any detected pid is an ancestor
    // of ccaudit (ccaudit was spawned from inside a Claude Code session,
    // typically via the Bash tool), emit the tailored self-invocation error.
    let selfInvocation = false;
    let message = buildProcessGateMessage(detection.processes);
    try {
      const chain = await walkParentChain(deps.selfPid, deps.processDetector);
      const detectedPids = new Set(detection.processes.map((p) => p.pid));
      const selfInvocationPid = chain.find((p) => detectedPids.has(p));
      if (selfInvocationPid !== undefined) {
        selfInvocation = true;
        message = `You appear to be running ccaudit from inside a Claude Code session (parent pid: ${selfInvocationPid}). Open a standalone terminal and run this command there.`;
      }
    } catch {
      // walkParentChain is best-effort enrichment; fall back to the standard
      // process-gate message when PPID lookup fails.
    }
    return {
      status: 'running-process',
      pids: detection.processes.map((p) => p.pid),
      selfInvocation,
      message,
    };
  }

  // Full restore: walk ALL manifests newest-first, deduplicate ops by archive_path.
  //
  // Phase 3 fix: the old code called findManifestForRestore() which returned only
  // entries[0] (the newest manifest). Every prior bust's archived items became
  // unreachable orphans. Now we collect ops from every manifest, deduplicate by
  // archive_path (newer manifest wins), and execute the unified op list.
  //
  // Dedup rationale: two consecutive busts could theoretically archive the same
  // source path (e.g. if the user manually restored between busts). In that case,
  // the newer manifest's archive_path takes precedence.
  //
  // Already-restored detection: if source_path exists AND archive_path is missing,
  // restoreArchiveOp classifies the op as 'already-at-source'. This handles the
  // idempotency case where the user re-runs restore after a crash mid-way.
  if (mode.kind === 'full') {
    const allEntries = await findManifestsForRestore(deps);
    if (allEntries.length === 0) return { status: 'no-manifests' };

    // Validate the newest manifest's header (D-07). If the newest is corrupt,
    // refuse entirely rather than silently falling back to an older one.
    const newestEntry = allEntries[0]!;
    const newestManifest = await deps.readManifest(newestEntry.path);
    if (newestManifest.header === null) {
      return { status: 'manifest-corrupt', path: newestEntry.path };
    }
    if (newestManifest.footer === null) {
      deps.onWarning?.(
        `Partial bust detected — ${path.basename(newestEntry.path)} has no completion record. Restoring operations that were recorded.`,
      );
    }

    // Collect ops from ALL manifests newest-first, deduplicating by archive_path.
    // Phase 8.2: also suppress stale archive ops (archive_missing +
    // source_exists) — surfaced via `filtered_stale_count` (SC6).
    // RE-M9: also suppress archive ops whose op_id was referenced by an
    // archive_purge op in a purge manifest — mirrors dedupManifestOps() and
    // collectRestoreableItems(). Two-pass approach:
    //   Pass 1 — read all manifests, build a cached map + purgedOriginalOpIds set.
    //   Pass 2 — iterate the cache, skip purge manifests and purged archive ops.
    const manifestCache = new Map<
      string,
      { manifest: Awaited<ReturnType<RestoreDeps['readManifest']>>; isPurge: boolean }
    >();
    for (const entry of allEntries) {
      const manifest = entry === newestEntry ? newestManifest : await deps.readManifest(entry.path);
      const isPurge = path.basename(entry.path).startsWith('purge-');
      manifestCache.set(entry.path, { manifest, isPurge });
    }

    // Build purged-op-id set from archive_purge ops across all manifests.
    const purgedOriginalOpIds = new Set<string>();
    for (const { manifest, isPurge } of manifestCache.values()) {
      if (!isPurge) continue; // archive_purge ops only live in purge manifests
      for (const op of manifest.ops) {
        if (op.op_type === 'archive_purge') {
          purgedOriginalOpIds.add(op.original_op_id);
        }
      }
    }

    const seenArchivePaths = new Set<string>();
    const collectedOps: ManifestOp[] = [];
    let filteredStaleCount = 0;

    for (const entry of allEntries) {
      const cached = manifestCache.get(entry.path)!;

      // RE-M9: skip purge manifests entirely — their archive_purge records are
      // not restoreable ops; we already harvested their original_op_ids above.
      if (cached.isPurge) continue;

      const { manifest } = cached;

      // Skip corrupt manifests in the middle of the list — only the newest
      // triggers a hard failure (validated above).
      if (manifest.header === null) {
        deps.onWarning?.(
          `⚠️  Skipping corrupt manifest ${path.basename(entry.path)} (no header record)`,
        );
        continue;
      }

      for (const op of manifest.ops) {
        if (op.op_type === 'archive') {
          // RE-M9: skip archive ops whose archive has since been purged.
          if (purgedOriginalOpIds.has(op.op_id)) continue;
          if (seenArchivePaths.has(op.archive_path)) continue;
          seenArchivePaths.add(op.archive_path);
          if (await isStaleArchiveOp(op, deps.pathExists)) {
            filteredStaleCount += 1;
            continue;
          }
          collectedOps.push(op);
        } else {
          // Non-archive ops (disable, flag, refresh): include from all manifests.
          // These are idempotent: re-enabling an already-enabled MCP is detected
          // inside reEnableMcpTransactional; stripping already-absent frontmatter
          // is a no-op in restoreFlagOp / restoreRefreshOp.
          collectedOps.push(op);
        }
      }
    }

    // Execute all collected ops via the existing orchestrator.
    // Pass newestEntry as the manifest reference for the result (manifestPath field).
    // Pass allEntries paths so the result records every consumed manifest.
    return executeOpsOnManifest(
      newestEntry,
      collectedOps,
      deps,
      start,
      allEntries.map((e) => e.path),
      undefined,
      filteredStaleCount,
    );
  }

  // Subset restore via interactive picker output (D8-13).
  if (mode.kind === 'interactive') {
    return executeInteractiveOps(mode.ids, deps, start);
  }

  // Subset restore via fuzzy pattern: match every candidate, restore each.
  // Ambiguity is NOT a special case here (all-matching restores every match
  // by design; see D8-09 for --name ambiguity which is enforced CLI-side).
  if (mode.kind === 'all-matching') {
    const allEntries = await findManifestsForRestore(deps);
    if (allEntries.length === 0) return { status: 'no-manifests' };
    const zipped: Array<{ entry: ManifestEntry; ops: readonly ManifestOp[] }> = [];
    for (const e of allEntries) {
      const m = await deps.readManifest(e.path);
      if (m.header === null) continue;
      zipped.push({ entry: e, ops: m.ops });
    }
    const deduped = dedupManifestOps(zipped);
    const matched = matchByName(deduped, mode.pattern);
    if (matched.length === 0) return { status: 'name-not-found', name: mode.pattern };
    return executeInteractiveOps(
      matched.map((m) => m.canonical_id),
      deps,
      start,
    );
  }

  // Single-item restore: search all manifests for the named item
  const found = await findManifestForName(mode.name, deps);
  if (found === null) return { status: 'name-not-found', name: mode.name };

  if (found.manifest.header === null) {
    return { status: 'manifest-corrupt', path: found.entry.path };
  }
  if (found.manifest.footer === null) {
    deps.onWarning?.(
      `Partial bust detected — ${path.basename(found.entry.path)} has no completion record. Restoring matched operations that were recorded.`,
    );
  }
  return executeOpsOnManifest(found.entry, found.matchedOps, deps, start);
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // -- Shared fake deps builder ----------------------------------

  /**
   * Build a fully-stubbed RestoreDeps.
   * Override individual fields per test.
   */
  function makeFakeDeps(overrides: Partial<RestoreDeps> = {}): RestoreDeps {
    const noopProcessDeps: ProcessDetectorDeps = {
      runCommand: async () => '',
      getParentPid: async () => null,
      platform: 'linux',
    };

    const defaults: RestoreDeps = {
      discoverManifests: async () => [],
      readManifest: async () => ({ header: null, ops: [], footer: null, truncated: false }),
      processDetector: noopProcessDeps,
      selfPid: 99999,
      renameFile: async () => {},
      mkdirRecursive: async () => {},
      readFileBytes: async () => Buffer.alloc(0),
      pathExists: async () => false,
      removeFrontmatterKeys: async () => ({
        status: 'removed' as const,
        keysRemoved: [],
        blockDeleted: false,
      }),
      setFrontmatterValue: async () => ({
        status: 'updated' as const,
        key: 'ccaudit-flagged',
        previousValue: null,
      }),
      readFileUtf8: async () => '',
      atomicWriteJson: async () => {},
      now: () => new Date('2026-04-05T18:30:00Z'),
      onWarning: undefined,
    };
    return { ...defaults, ...overrides };
  }

  // Fake manifest data helpers
  const fakeHeader = {
    record_type: 'header' as const,
    manifest_version: 1 as const,
    ccaudit_version: '0.0.1',
    checkpoint_ghost_hash: 'sha256:abc',
    checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
    since_window: '7d',
    os: 'linux' as NodeJS.Platform,
    node_version: 'v22',
    planned_ops: { archive: 0, disable: 0, flag: 0 },
  };

  const fakeFooter = {
    record_type: 'footer' as const,
    status: 'completed' as const,
    actual_ops: {
      archive: { completed: 0, failed: 0 },
      disable: { completed: 0, failed: 0 },
      flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
    },
    duration_ms: 100,
    exit_code: 0,
  };

  const fakeEntry: ManifestEntry = {
    path: '/fake/.claude/ccaudit/manifests/bust-2026-04-05T18-30-00Z.jsonl',
    mtime: new Date('2026-04-05T18:30:00Z'),
  };

  // -- Tests -------------------------------------------------------

  describe('executeRestore', () => {
    it('Test 1: returns no-manifests when discoverManifests returns []', async () => {
      const deps = makeFakeDeps({ discoverManifests: async () => [] });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('no-manifests');
    });

    it('Test 2: full restore with clean manifest returns success with zero counts', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [],
          footer: fakeFooter,
          truncated: false,
        }),
        // process gate: no claude processes
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(0);
        expect(result.counts.unarchived.alreadyAtSource).toBe(0);
        expect(result.counts.reenabled.completed).toBe(0);
        expect(result.counts.stripped.completed).toBe(0);
      }
    });

    it('Test 3: returns running-process when detectClaudeProcesses finds live processes', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        processDetector: {
          runCommand: async () => '  1234 claude\n',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.pids).toContain(1234);
      }
    });

    it('Test 3a: detects self-invocation via parent chain (D-04)', async () => {
      // Parent tree: ccaudit (999) -> shell (500) -> claude (100) -> init (1)
      const tree: Record<number, number> = { 999: 500, 500: 100, 100: 1 };
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        selfPid: 999,
        processDetector: {
          runCommand: async () => '  100 claude\n',
          getParentPid: async (pid: number) => tree[pid] ?? null,
          platform: 'darwin',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.selfInvocation).toBe(true);
        expect(result.message).toMatch(/inside a Claude Code session/);
        expect(result.message).toMatch(/parent pid: 100/);
      }
    });

    it('Test 3b: running-process without self-invocation shows generic message', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        selfPid: 99999,
        processDetector: {
          runCommand: async () => '  1234 claude\n',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.pids).toContain(1234);
        expect(result.selfInvocation).toBe(false);
        expect(result.message).toMatch(/re-run ccaudit restore/);
      }
    });

    it('Test 3c: falls back to non-enriched message when getParentPid throws', async () => {
      // Regression: walkParentChain is best-effort signal enrichment. If
      // getParentPid throws on the hot path, executeRestore must still return
      // the blocked running-process result (not propagate the error).
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        selfPid: 999,
        processDetector: {
          runCommand: async () => '  1234 claude\n',
          getParentPid: async () => {
            throw new Error('EPERM: parent pid lookup failed');
          },
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.pids).toContain(1234);
        expect(result.selfInvocation).toBe(false);
        expect(result.message).not.toMatch(/inside a Claude Code session/);
        expect(result.message).toMatch(/re-run ccaudit restore/);
      }
    });

    it('Test 4: returns process-detection-failed when detectClaudeProcesses spawn-fails', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        processDetector: {
          runCommand: async () => {
            throw new Error('ENOENT: ps not found');
          },
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('process-detection-failed');
    });

    it('Test 5: list mode skips process gate and returns listing', async () => {
      // Even if process detector would return running processes, list mode skips it
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [],
          footer: fakeFooter,
          truncated: false,
        }),
        processDetector: {
          // This would trigger running-process if the gate ran
          runCommand: async () => '  9999 claude\n',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'list' }, deps);
      expect(result.status).toBe('list');
      if (result.status === 'list') {
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]!.isPartial).toBe(false);
      }
    });

    it('Test 6: returns manifest-corrupt when header is null (D-07)', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: null, // corrupt — no header record
          ops: [],
          footer: null,
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('manifest-corrupt');
      if (result.status === 'manifest-corrupt') {
        expect(result.path).toBe(fakeEntry.path);
      }
    });

    it('Test 7: warns via onWarning when footer is null, but proceeds (D-06)', async () => {
      const warnings: string[] = [];
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [],
          footer: null, // partial bust — no footer
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });
      const result = await executeRestore({ kind: 'full' }, deps);
      // Should warn but still proceed
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/Partial bust detected/);
      expect(result.status).toBe('success');
    });

    it('Test 7b: corrupt older manifest is skipped with a warning; valid newer manifest still restores (regression)', async () => {
      // Regression for the skip-corrupt-older-manifest branch (lines 737-742).
      // Scenario: two manifests, newest has a valid header, older is truncated/corrupt.
      // Expected: onWarning fires once for the corrupt older manifest; restore succeeds.
      const newerEntry: ManifestEntry = {
        path: '/fake/.claude/ccaudit/manifests/bust-2026-04-10T10-00-00Z.jsonl',
        mtime: new Date('2026-04-10T10:00:00Z'),
      };
      const olderEntry: ManifestEntry = {
        path: '/fake/.claude/ccaudit/manifests/bust-2026-04-01T08-00-00Z.jsonl',
        mtime: new Date('2026-04-01T08:00:00Z'),
      };

      const warnings: string[] = [];

      const deps = makeFakeDeps({
        discoverManifests: async () => [newerEntry, olderEntry],
        readManifest: async (p) => {
          if (p === newerEntry.path) {
            return { header: fakeHeader, ops: [], footer: fakeFooter, truncated: false };
          }
          // Older manifest is corrupt: no header record.
          return { header: null, ops: [], footer: null, truncated: true };
        },
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });

      const result = await executeRestore({ kind: 'full' }, deps);

      // The corrupt older manifest must have triggered exactly one warning.
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/Skipping corrupt manifest/);
      expect(warnings[0]).toMatch(path.basename(olderEntry.path));

      // Restore must still succeed (the newer manifest is intact).
      expect(result.status).toBe('success');
    });

    it('Test 7c: corrupt newest manifest hard-fails even when older manifests are valid (regression)', async () => {
      // Counterpart regression: a corrupt *newest* manifest must produce
      // manifest-corrupt, not silently fall back to older ones.
      const newerEntry: ManifestEntry = {
        path: '/fake/.claude/ccaudit/manifests/bust-2026-04-10T10-00-00Z.jsonl',
        mtime: new Date('2026-04-10T10:00:00Z'),
      };
      const olderEntry: ManifestEntry = {
        path: '/fake/.claude/ccaudit/manifests/bust-2026-04-01T08-00-00Z.jsonl',
        mtime: new Date('2026-04-01T08:00:00Z'),
      };

      const deps = makeFakeDeps({
        discoverManifests: async () => [newerEntry, olderEntry],
        readManifest: async (p) => {
          if (p === newerEntry.path) {
            // Newest manifest is corrupt.
            return { header: null, ops: [], footer: null, truncated: true };
          }
          // Older manifest is perfectly valid.
          return { header: fakeHeader, ops: [], footer: fakeFooter, truncated: false };
        },
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });

      const result = await executeRestore({ kind: 'full' }, deps);

      // Hard failure on corrupt newest -- must not silently continue.
      expect(result.status).toBe('manifest-corrupt');
      if (result.status === 'manifest-corrupt') {
        expect(result.path).toBe(newerEntry.path);
      }
    });
  });

  describe('findManifestForName', () => {
    const archiveOp: ArchiveOp = {
      op_id: 'uuid-1',
      op_type: 'archive',
      timestamp: '2026-04-05T18:30:00Z',
      status: 'completed',
      category: 'agent',
      scope: 'global',
      source_path: '/home/u/.claude/agents/code-reviewer.md',
      archive_path: '/home/u/.claude/agents/_archived/code-reviewer-2026-04-05T18-30-00Z.md',
      content_sha256: 'abc123',
    };

    const entries: ManifestEntry[] = [
      { path: '/fake/bust-2026-04-05T18-30-00Z.jsonl', mtime: new Date('2026-04-05T18:30:00Z') },
      { path: '/fake/bust-2026-04-01T12-00-00Z.jsonl', mtime: new Date('2026-04-01T12:00:00Z') },
      { path: '/fake/bust-2026-03-15T08-00-00Z.jsonl', mtime: new Date('2026-03-15T08:00:00Z') },
    ];

    it('Test 8: matches archive op by basename in the middle manifest', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => entries,
        readManifest: async (p) => {
          if (p.includes('2026-04-01')) {
            return { header: fakeHeader, ops: [archiveOp], footer: fakeFooter, truncated: false };
          }
          return { header: fakeHeader, ops: [], footer: fakeFooter, truncated: false };
        },
      });
      // The archive_path basename without extension is 'code-reviewer-2026-04-05T18-30-00Z'
      // BUT the name we use is the full basename minus extension of the archive_path
      // Let's check what extractServerName returns for archive ops —
      // For archive, we check path.basename(archive_path, ext)
      const archiveBasename = path.basename(
        archiveOp.archive_path,
        path.extname(archiveOp.archive_path),
      );
      const result = await findManifestForName(archiveBasename, deps);
      expect(result).not.toBeNull();
      expect(result!.entry.path).toContain('2026-04-01');
      expect(result!.matchedOps).toHaveLength(1);
      expect(result!.matchedOps[0]!.op_type).toBe('archive');
    });

    it('Test 9: returns null when name matches no ops across any manifest', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => entries,
        readManifest: async () => ({
          header: fakeHeader,
          ops: [archiveOp],
          footer: fakeFooter,
          truncated: false,
        }),
      });
      const result = await findManifestForName('nonexistent-tool', deps);
      expect(result).toBeNull();
    });

    it('Test 10: matches MCP server names via extractServerName (dotted name)', async () => {
      const disableOp: DisableOp = {
        op_id: 'uuid-2',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: '/home/u/.claude.json',
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.my.dotted.server',
        new_key: 'ccaudit-disabled:my.dotted.server',
        original_value: { command: 'npx', args: ['@my/mcp-server'] },
      };
      const deps = makeFakeDeps({
        discoverManifests: async () => [entries[0]!],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [disableOp],
          footer: fakeFooter,
          truncated: false,
        }),
      });
      const result = await findManifestForName('my.dotted.server', deps);
      expect(result).not.toBeNull();
      expect(result!.matchedOps[0]!.op_type).toBe('disable');
    });
  });

  describe('extractServerName', () => {
    it('handles flat mcpServers.<name>', () => {
      expect(extractServerName('mcpServers.playwright')).toBe('playwright');
    });

    it('handles nested projects.<path>.mcpServers.<name>', () => {
      expect(extractServerName('projects./home/u/project.mcpServers.playwright')).toBe(
        'playwright',
      );
    });

    it('handles dotted server name via lastIndexOf', () => {
      expect(extractServerName('mcpServers.my.dotted.server')).toBe('my.dotted.server');
    });

    it('returns original key when no mcpServers pattern found', () => {
      expect(extractServerName('some-other-key')).toBe('some-other-key');
    });
  });

  // -- Task 2 tests: executor functions ----------------------------

  describe('restoreArchiveOp', () => {
    it('Test 1: archive file exists, source_path empty → rename succeeds, returns moved', async () => {
      const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');

      // Must be within homedir() so assertWithinHomedir passes
      const dir = await mkdtemp(join(homedir(), '.ccaudit-restore-t1-'));
      try {
        const archivePath = join(dir, 'code-reviewer.md');
        const sourcePath = join(dir, 'src', 'code-reviewer.md');
        const content = '# Agent\n';
        await wf(archivePath, content, 'utf8');
        const sha256 = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

        const op: ArchiveOp = {
          op_id: 'uuid-1',
          op_type: 'archive',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          category: 'agent',
          scope: 'global',
          source_path: sourcePath,
          archive_path: archivePath,
          content_sha256: sha256,
        };

        const warnings: string[] = [];
        const deps = makeFakeDeps({
          renameFile: async (from, to) => {
            const { rename, mkdir: md } = await import('node:fs/promises');
            await md(path.dirname(to), { recursive: true });
            await rename(from, to);
          },
          mkdirRecursive: async (dir, _mode) => {
            const { mkdir: md } = await import('node:fs/promises');
            await md(dir, { recursive: true });
          },
          readFileBytes: async (p) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(p);
          },
          pathExists: async (p) => {
            try {
              await import('node:fs/promises').then((m) => m.stat(p));
              return true;
            } catch {
              return false;
            }
          },
          onWarning: (msg) => {
            warnings.push(msg);
          },
        });

        const result = await restoreArchiveOp(op, deps);
        expect(result).toBe('moved');
        expect(warnings).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 2: SHA256 mismatch → onWarning called but rename still proceeds (D-13)', async () => {
      const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');

      // Must be within homedir() so assertWithinHomedir passes
      const dir = await mkdtemp(join(homedir(), '.ccaudit-restore-t2-'));
      try {
        const archivePath = join(dir, 'agent.md');
        const sourcePath = join(dir, 'src', 'agent.md');
        await wf(archivePath, '# Modified content\n', 'utf8');

        const op: ArchiveOp = {
          op_id: 'uuid-2',
          op_type: 'archive',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          category: 'agent',
          scope: 'global',
          source_path: sourcePath,
          archive_path: archivePath,
          content_sha256: 'wrong-hash',
        };

        const warnings: string[] = [];
        const deps = makeFakeDeps({
          renameFile: async (from, to) => {
            const { rename, mkdir: md } = await import('node:fs/promises');
            await md(path.dirname(to), { recursive: true });
            await rename(from, to);
          },
          mkdirRecursive: async (dir) => {
            const { mkdir: md } = await import('node:fs/promises');
            await md(dir, { recursive: true });
          },
          readFileBytes: async (p) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(p);
          },
          pathExists: async () => false,
          onWarning: (msg) => {
            warnings.push(msg);
          },
        });

        const result = await restoreArchiveOp(op, deps);
        expect(result).toBe('moved');
        expect(warnings.some((w) => w.includes('modified after archiving'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 3: source_path exists but archive does NOT exist → already-at-source, returns already-at-source', async () => {
      const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises');
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');

      const dir = await mkdtemp(join(_homedir(), '.ccaudit-restore-t3-'));
      try {
        const archivePath = join(dir, '_archived', 'agent.md'); // does NOT exist
        const sourcePath = join(dir, 'agent.md');
        // Source exists but archive does not — bust failed silently / already restored
        await wf(sourcePath, '# Existing\n', 'utf8');

        const op: ArchiveOp = {
          op_id: 'uuid-3',
          op_type: 'archive',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          category: 'agent',
          scope: 'global',
          source_path: sourcePath,
          archive_path: archivePath,
          content_sha256: 'abc',
        };

        const warnings: string[] = [];
        const deps = makeFakeDeps({
          pathExists: async (p) => {
            try {
              await import('node:fs/promises').then((m) => m.stat(p));
              return true;
            } catch {
              return false;
            }
          },
          onWarning: (msg) => {
            warnings.push(msg);
          },
        });

        const result = await restoreArchiveOp(op, deps);
        expect(result).toBe('already-at-source');
        expect(warnings.some((w) => w.includes('already at source'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 3b: source_path AND archive_path both exist → collision treated as already-at-source (v1 policy: no overwrite)', async () => {
      const { mkdtemp, writeFile: wf, mkdir, rm } = await import('node:fs/promises');
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');

      const dir = await mkdtemp(join(_homedir(), '.ccaudit-restore-t3b-'));
      try {
        const archiveDir = join(dir, '_archived');
        await mkdir(archiveDir, { recursive: true });
        const archivePath = join(archiveDir, 'agent.md');
        const sourcePath = join(dir, 'agent.md');
        // Both exist — genuine collision
        await wf(sourcePath, '# Source\n', 'utf8');
        await wf(archivePath, '# Archive\n', 'utf8');

        const op: ArchiveOp = {
          op_id: 'uuid-3b',
          op_type: 'archive',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          category: 'agent',
          scope: 'global',
          source_path: sourcePath,
          archive_path: archivePath,
          content_sha256: 'abc',
        };

        const warnings: string[] = [];
        const deps = makeFakeDeps({
          pathExists: async (p) => {
            try {
              await import('node:fs/promises').then((m) => m.stat(p));
              return true;
            } catch {
              return false;
            }
          },
          onWarning: (msg) => {
            warnings.push(msg);
          },
        });

        const result = await restoreArchiveOp(op, deps);
        // v1 policy: collision (both exist) → already-at-source, not failed; don't overwrite.
        expect(result).toBe('already-at-source');
        expect(warnings.some((w) => w.includes('exists at both source and archive'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 4: archive_path missing (ENOENT) → returns failed, continue-on-error', async () => {
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');

      const op: ArchiveOp = {
        op_id: 'uuid-4',
        op_type: 'archive',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: join(_homedir(), '.ccaudit-test-source.md'),
        archive_path: join(_homedir(), '.ccaudit-test-nonexistent.md'),
        content_sha256: 'abc',
      };

      const warnings: string[] = [];
      const deps = makeFakeDeps({
        pathExists: async () => false,
        readFileBytes: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        mkdirRecursive: async () => {},
        renameFile: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });

      const result = await restoreArchiveOp(op, deps);
      expect(result).toBe('failed');
    });

    it('Test 5: mkdirRecursive called before rename (for nested source_path)', async () => {
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');

      const op: ArchiveOp = {
        op_id: 'uuid-5',
        op_type: 'archive',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: join(_homedir(), '.ccaudit-test', 'a', 'b', 'nested.md'),
        archive_path: join(_homedir(), '.ccaudit-test', '_archived', 'nested.md'),
        content_sha256: 'abc',
      };

      const callOrder: string[] = [];
      const deps = makeFakeDeps({
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {
          callOrder.push('mkdir');
        },
        renameFile: async () => {
          callOrder.push('rename');
        },
      });

      await restoreArchiveOp(op, deps);
      expect(callOrder.indexOf('mkdir')).toBeLessThan(callOrder.indexOf('rename'));
    });
  });

  describe('reEnableMcpTransactional', () => {
    it('Test 6: flat .mcp.json → moves ccaudit-disabled:playwright back to mcpServers.playwright', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { atomicWriteJson: realWrite } = await import('./atomic-write.ts');

      const dir = await mkdtemp(join(_homedir(), '.ccaudit-restore-t6-'));
      try {
        const configPath = join(dir, '.mcp.json');
        const initialConfig = {
          'ccaudit-disabled:playwright': { command: 'npx', args: ['@playwright/mcp'] },
        };
        await realWrite(configPath, initialConfig);

        const op: DisableOp = {
          op_id: 'uuid-6',
          op_type: 'disable',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          config_path: configPath,
          scope: 'project',
          project_path: null,
          original_key: 'mcpServers.playwright',
          new_key: 'ccaudit-disabled:playwright',
          original_value: { command: 'npx', args: ['@playwright/mcp'] },
        };

        const deps = makeFakeDeps({
          readFileUtf8: async (p) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(p, 'utf8');
          },
          atomicWriteJson: async (p, v) => realWrite(p, v),
        });

        const result = await reEnableMcpTransactional([op], deps);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          expect(result.completed).toBe(1);
        }
        const { readFile } = await import('node:fs/promises');
        const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        expect(written).toHaveProperty('mcpServers');
        expect((written.mcpServers as Record<string, unknown>)['playwright']).toBeDefined();
        expect(written).not.toHaveProperty('ccaudit-disabled:playwright');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 7: nested ~/.claude.json global scope → moves disabled key back to mcpServers', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { atomicWriteJson: realWrite } = await import('./atomic-write.ts');

      const dir = await mkdtemp(join(_homedir(), '.ccaudit-restore-t7-'));
      try {
        const configPath = join(dir, '.claude.json');
        const initialConfig = {
          mcpServers: {},
          'ccaudit-disabled:playwright': { command: 'npx' },
        };
        await realWrite(configPath, initialConfig);

        const op: DisableOp = {
          op_id: 'uuid-7',
          op_type: 'disable',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          config_path: configPath,
          scope: 'global',
          project_path: null,
          original_key: 'mcpServers.playwright',
          new_key: 'ccaudit-disabled:playwright',
          original_value: { command: 'npx' },
        };

        const deps = makeFakeDeps({
          readFileUtf8: async (p) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(p, 'utf8');
          },
          atomicWriteJson: async (p, v) => realWrite(p, v),
        });

        const result = await reEnableMcpTransactional([op], deps);
        expect(result.status).toBe('ok');
        const { readFile } = await import('node:fs/promises');
        const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        expect((written.mcpServers as Record<string, unknown>)['playwright']).toBeDefined();
        expect(written).not.toHaveProperty('ccaudit-disabled:playwright');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 8: nested ~/.claude.json project scope → moves back into projects.path.mcpServers', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { homedir: _homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { atomicWriteJson: realWrite } = await import('./atomic-write.ts');

      const dir = await mkdtemp(join(_homedir(), '.ccaudit-restore-t8-'));
      try {
        const configPath = join(dir, '.claude.json');
        const projectPath = '/home/user/project';
        const initialConfig = {
          projects: {
            [projectPath]: {
              mcpServers: {},
              'ccaudit-disabled:playwright': { command: 'npx' },
            },
          },
        };
        await realWrite(configPath, initialConfig);

        const op: DisableOp = {
          op_id: 'uuid-8',
          op_type: 'disable',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          config_path: configPath,
          scope: 'project',
          project_path: projectPath,
          original_key: `projects.${projectPath}.mcpServers.playwright`,
          new_key: 'ccaudit-disabled:playwright',
          original_value: { command: 'npx' },
        };

        const deps = makeFakeDeps({
          readFileUtf8: async (p) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(p, 'utf8');
          },
          atomicWriteJson: async (p, v) => realWrite(p, v),
        });

        const result = await reEnableMcpTransactional([op], deps);
        expect(result.status).toBe('ok');
        const { readFile } = await import('node:fs/promises');
        const written = JSON.parse(await readFile(configPath, 'utf8')) as {
          projects: Record<string, Record<string, unknown>>;
        };
        const proj = written.projects[projectPath]!;
        expect((proj['mcpServers'] as Record<string, unknown>)['playwright']).toBeDefined();
        expect(proj).not.toHaveProperty('ccaudit-disabled:playwright');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 9: user manually re-enabled (new_key not found) → onWarning, skip (not fail)', async () => {
      const warnings: string[] = [];
      const config = JSON.stringify({ mcpServers: { playwright: {} } });
      const deps = makeFakeDeps({
        readFileUtf8: async () => config,
        atomicWriteJson: async () => {},
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });

      const op: DisableOp = {
        op_id: 'uuid-9',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: path.join(homedir(), '.ccaudit-test-config.json'),
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: {},
      };

      const result = await reEnableMcpTransactional([op], deps);
      expect(result.status).toBe('ok');
      expect(warnings.some((w) => w.includes('already re-enabled'))).toBe(true);
    });

    it('Test 10: original_key target already exists → onWarning, skip (collision)', async () => {
      const warnings: string[] = [];
      // Both the new_key (disabled) AND the original server already exist — collision
      const config = JSON.stringify({
        mcpServers: { playwright: { command: 'existing' } },
        'ccaudit-disabled:playwright': { command: 'disabled' },
      });
      const deps = makeFakeDeps({
        readFileUtf8: async () => config,
        atomicWriteJson: async () => {},
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });

      const op: DisableOp = {
        op_id: 'uuid-10',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: path.join(homedir(), '.ccaudit-test-config.json'),
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: {},
      };

      const result = await reEnableMcpTransactional([op], deps);
      expect(result.status).toBe('ok');
      expect(warnings.some((w) => w.includes('already present in mcpServers'))).toBe(true);
    });

    it('Test 11: uses CURRENT value at new_key, NOT op.original_value (D-09)', async () => {
      const currentValue = { command: 'npx', args: ['--updated'] };
      const originalValue = { command: 'npx', args: ['--old'] };
      let writtenConfig: Record<string, unknown> = {};
      const config = JSON.stringify({
        'ccaudit-disabled:playwright': currentValue, // user edited this after bust
      });
      const deps = makeFakeDeps({
        readFileUtf8: async () => config,
        atomicWriteJson: async (_p, v) => {
          writtenConfig = v as Record<string, unknown>;
        },
      });

      const op: DisableOp = {
        op_id: 'uuid-11',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: path.join(homedir(), '.ccaudit-test-config.json'),
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: originalValue,
      };

      await reEnableMcpTransactional([op], deps);
      const restoredValue = (writtenConfig['mcpServers'] as Record<string, unknown>)['playwright'];
      // Must use CURRENT value, not original_value
      expect(restoredValue).toEqual(currentValue);
      expect(restoredValue).not.toEqual(originalValue);
    });

    it('Test 12: atomicWriteJson called exactly once per config file (D-15)', async () => {
      let writeCount = 0;
      const config = JSON.stringify({
        'ccaudit-disabled:playwright': {},
        'ccaudit-disabled:github': {},
      });
      const deps = makeFakeDeps({
        readFileUtf8: async () => config,
        atomicWriteJson: async () => {
          writeCount++;
        },
      });

      const ops: DisableOp[] = [
        {
          op_id: 'a',
          op_type: 'disable',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          config_path: path.join(homedir(), '.ccaudit-test-config.json'),
          scope: 'global',
          project_path: null,
          original_key: 'mcpServers.playwright',
          new_key: 'ccaudit-disabled:playwright',
          original_value: {},
        },
        {
          op_id: 'b',
          op_type: 'disable',
          timestamp: '2026-04-05T18:30:00Z',
          status: 'completed',
          config_path: path.join(homedir(), '.ccaudit-test-config.json'),
          scope: 'global',
          project_path: null,
          original_key: 'mcpServers.github',
          new_key: 'ccaudit-disabled:github',
          original_value: {},
        },
      ];

      await reEnableMcpTransactional(ops, deps);
      expect(writeCount).toBe(1); // one write for two ops on the same config file
    });

    it('Test 13: JSON parse error on config file → returns config-parse-error', async () => {
      const deps = makeFakeDeps({
        readFileUtf8: async () => 'not valid json {{{',
      });
      const op: DisableOp = {
        op_id: 'uuid-13',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: path.join(homedir(), '.ccaudit-test-config.json'),
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: {},
      };
      const result = await reEnableMcpTransactional([op], deps);
      expect(result.status).toBe('config-parse-error');
    });

    it('Test 14: atomic write failure → returns config-write-error', async () => {
      const config = JSON.stringify({ 'ccaudit-disabled:playwright': {} });
      const deps = makeFakeDeps({
        readFileUtf8: async () => config,
        atomicWriteJson: async () => {
          throw new Error('ENOSPC');
        },
      });
      const op: DisableOp = {
        op_id: 'uuid-14',
        op_type: 'disable',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        config_path: path.join(homedir(), '.ccaudit-test-config.json'),
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: {},
      };
      const result = await reEnableMcpTransactional([op], deps);
      expect(result.status).toBe('config-write-error');
    });
  });

  describe('restoreFlagOp + restoreRefreshOp', () => {
    it('Test 15: restoreFlagOp calls removeFrontmatterKeys with both ccaudit keys, returns completed', async () => {
      const keysUsed: string[][] = [];
      const deps = makeFakeDeps({
        removeFrontmatterKeys: async (_p, keys) => {
          keysUsed.push(keys);
          return {
            status: 'removed',
            keysRemoved: ['ccaudit-stale', 'ccaudit-flagged'],
            blockDeleted: true,
          } as FrontmatterRemoveResult;
        },
      });
      const op: FlagOp = {
        op_id: 'uuid-15',
        op_type: 'flag',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        file_path: '/fake/CLAUDE.md',
        scope: 'global',
        had_frontmatter: true,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale', 'ccaudit-flagged'],
        original_content_sha256: 'abc',
      };
      const result = await restoreFlagOp(op, deps);
      expect(result).toBe('completed');
      expect(keysUsed[0]).toContain('ccaudit-stale');
      expect(keysUsed[0]).toContain('ccaudit-flagged');
    });

    it('Test 16: restoreRefreshOp calls setFrontmatterValue with ccaudit-flagged + previous value, returns completed', async () => {
      const setCalls: Array<{ key: string; value: string }> = [];
      const deps = makeFakeDeps({
        setFrontmatterValue: async (_p, key, value) => {
          setCalls.push({ key, value });
          return {
            status: 'updated',
            key,
            previousValue: '2026-01-01T00:00:00Z',
          } as FrontmatterRemoveResult;
        },
      });
      const op: RefreshOp = {
        op_id: 'uuid-16',
        op_type: 'refresh',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        file_path: '/fake/CLAUDE.md',
        scope: 'global',
        previous_flagged_at: '2026-03-01T10:00:00Z',
      };
      const result = await restoreRefreshOp(op, deps);
      expect(result).toBe('completed');
      expect(setCalls[0]?.key).toBe('ccaudit-flagged');
      expect(setCalls[0]?.value).toBe('2026-03-01T10:00:00Z');
    });

    it('Test 17: restoreFlagOp treats no-frontmatter/keys-not-found as completed (nothing to do)', async () => {
      const deps = makeFakeDeps({
        removeFrontmatterKeys: async () =>
          ({ status: 'no-frontmatter' }) as FrontmatterRemoveResult,
      });
      const op: FlagOp = {
        op_id: 'uuid-17',
        op_type: 'flag',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        file_path: '/fake/CLAUDE.md',
        scope: 'global',
        had_frontmatter: false,
        had_ccaudit_stale: false,
        patched_keys: [],
        original_content_sha256: 'abc',
      };
      const result = await restoreFlagOp(op, deps);
      expect(result).toBe('completed');

      const deps2 = makeFakeDeps({
        removeFrontmatterKeys: async () =>
          ({ status: 'keys-not-found' }) as FrontmatterRemoveResult,
      });
      const result2 = await restoreFlagOp(op, deps2);
      expect(result2).toBe('completed');
    });

    it('Test 18: restoreFlagOp treats skipped status as failed with warning', async () => {
      const warnings: string[] = [];
      const deps = makeFakeDeps({
        removeFrontmatterKeys: async () =>
          ({ status: 'skipped', reason: 'exotic-yaml' }) as FrontmatterRemoveResult,
        onWarning: (msg) => {
          warnings.push(msg);
        },
      });
      const op: FlagOp = {
        op_id: 'uuid-18',
        op_type: 'flag',
        timestamp: '2026-04-05T18:30:00Z',
        status: 'completed',
        file_path: '/fake/CLAUDE.md',
        scope: 'global',
        had_frontmatter: true,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale'],
        original_content_sha256: 'abc',
      };
      const result = await restoreFlagOp(op, deps);
      expect(result).toBe('failed');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('executeOpsOnManifest (wired)', () => {
    const makeArchiveOp = (category: 'agent' | 'skill', id: string): ArchiveOp => ({
      op_id: id,
      op_type: 'archive',
      timestamp: '2026-04-05T18:30:00Z',
      status: 'completed',
      category,
      scope: 'global',
      source_path: path.join(homedir(), `.ccaudit-test-${category}`, `${id}.md`),
      archive_path: path.join(homedir(), `.ccaudit-test-${category}`, '_archived', `${id}.md`),
      content_sha256: 'abc',
    });

    const makeFlagOp = (id: string): FlagOp => ({
      op_id: id,
      op_type: 'flag',
      timestamp: '2026-04-05T18:30:00Z',
      status: 'completed',
      file_path: `/fake/memory/${id}.md`,
      scope: 'global',
      had_frontmatter: true,
      had_ccaudit_stale: true,
      patched_keys: ['ccaudit-stale', 'ccaudit-flagged'],
      original_content_sha256: 'abc',
    });

    const makeRefreshOp = (id: string): RefreshOp => ({
      op_id: id,
      op_type: 'refresh',
      timestamp: '2026-04-05T18:30:00Z',
      status: 'completed',
      file_path: `/fake/memory/${id}.md`,
      scope: 'global',
      previous_flagged_at: '2026-03-01T10:00:00Z',
    });

    const makeDisableOp = (id: string): DisableOp => ({
      op_id: id,
      op_type: 'disable',
      timestamp: '2026-04-05T18:30:00Z',
      status: 'completed',
      config_path: path.join(homedir(), '.ccaudit-test-config.json'),
      scope: 'global',
      project_path: null,
      original_key: `mcpServers.${id}`,
      new_key: `ccaudit-disabled:${id}`,
      original_value: {},
    });

    it('Test 19: ops executed in locked order: refresh → flag → disable → skill → agent', async () => {
      const callLog: string[] = [];

      const deps = makeFakeDeps({
        removeFrontmatterKeys: async (p) => {
          callLog.push(`flag:${path.basename(p)}`);
          return {
            status: 'removed',
            keysRemoved: ['ccaudit-stale'],
            blockDeleted: true,
          } as FrontmatterRemoveResult;
        },
        setFrontmatterValue: async (p) => {
          callLog.push(`refresh:${path.basename(p)}`);
          return {
            status: 'updated',
            key: 'ccaudit-flagged',
            previousValue: null,
          } as FrontmatterRemoveResult;
        },
        readFileUtf8: async () => JSON.stringify({ 'ccaudit-disabled:playwright': {} }),
        atomicWriteJson: async () => {},
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {
          callLog.push('mkdir');
        },
        renameFile: async (_from, to) => {
          callLog.push(`rename:${path.basename(to)}`);
        },
      });

      // Mixed ops: agent archive, disable, flag, skill archive, refresh
      const ops: ManifestOp[] = [
        makeArchiveOp('agent', 'my-agent'),
        makeDisableOp('playwright'),
        makeFlagOp('claude-md'),
        makeArchiveOp('skill', 'my-skill'),
        makeRefreshOp('other-md'),
      ];

      const result = await executeRestore(
        { kind: 'full' },
        makeFakeDeps({
          discoverManifests: async () => [fakeEntry],
          readManifest: async () => ({
            header: fakeHeader,
            ops,
            footer: fakeFooter,
            truncated: false,
          }),
          processDetector: {
            runCommand: async () => '',
            getParentPid: async () => null,
            platform: 'linux' as const,
          },
          removeFrontmatterKeys: deps.removeFrontmatterKeys,
          setFrontmatterValue: deps.setFrontmatterValue,
          readFileUtf8: deps.readFileUtf8,
          atomicWriteJson: deps.atomicWriteJson,
          pathExists: deps.pathExists,
          readFileBytes: deps.readFileBytes,
          mkdirRecursive: deps.mkdirRecursive,
          renameFile: deps.renameFile,
        }),
      );
      expect(result.status).toBe('success');

      // Verify order: refresh comes before flag, disable comes before renames
      const refreshIdx = callLog.findIndex((e) => e.startsWith('refresh:'));
      const flagIdx = callLog.findIndex((e) => e.startsWith('flag:'));
      const skillRenameIdx = callLog.findIndex((e) => e.includes('my-skill'));
      const agentRenameIdx = callLog.findIndex((e) => e.includes('my-agent'));

      expect(refreshIdx).toBeGreaterThanOrEqual(0);
      expect(flagIdx).toBeGreaterThan(refreshIdx);
      expect(skillRenameIdx).toBeGreaterThan(flagIdx);
      expect(agentRenameIdx).toBeGreaterThan(skillRenameIdx);
    });

    it('Test 20: hybrid failure policy — fs ops continue, MCP config-write-error returns early', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [makeDisableOp('playwright'), makeArchiveOp('agent', 'my-agent')],
          footer: fakeFooter,
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        readFileUtf8: async () => JSON.stringify({ 'ccaudit-disabled:playwright': {} }),
        atomicWriteJson: async () => {
          throw new Error('ENOSPC');
        },
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from(''),
        mkdirRecursive: async () => {},
        renameFile: async () => {},
      });

      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('config-write-error');
    });

    it('Test 21: all ops succeed → status=success with counts filled', async () => {
      const ops: ManifestOp[] = [
        makeArchiveOp('skill', 'my-skill'),
        makeFlagOp('claude-md'),
        makeRefreshOp('other-md'),
        makeDisableOp('playwright'),
      ];

      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops,
          footer: fakeFooter,
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        removeFrontmatterKeys: async () =>
          ({
            status: 'removed',
            keysRemoved: ['ccaudit-stale'],
            blockDeleted: true,
          }) as FrontmatterRemoveResult,
        setFrontmatterValue: async () =>
          ({
            status: 'updated',
            key: 'ccaudit-flagged',
            previousValue: null,
          }) as FrontmatterRemoveResult,
        readFileUtf8: async () => JSON.stringify({ 'ccaudit-disabled:playwright': {} }),
        atomicWriteJson: async () => {},
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {},
        renameFile: async () => {},
      });

      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBeGreaterThan(0);
        expect(result.counts.unarchived.alreadyAtSource).toBe(0);
        expect(result.counts.reenabled.completed).toBeGreaterThan(0);
        expect(result.counts.stripped.completed).toBeGreaterThan(0);
        expect(result.counts.unarchived.failed).toBe(0);
      }
    });

    it('Test 22: single-mode with findManifestForName → only matched ops executed', async () => {
      const opLog: string[] = [];
      const agentOp = makeArchiveOp('agent', 'target-agent');
      const skillOp = makeArchiveOp('skill', 'other-skill');

      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [agentOp, skillOp],
          footer: fakeFooter,
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {},
        renameFile: async (_from, to) => {
          opLog.push(path.basename(to));
        },
      });

      // Restore only 'target-agent-2026-04-05T18-30-00Z' by archive basename
      const archiveBasename = path.basename(
        agentOp.archive_path,
        path.extname(agentOp.archive_path),
      );
      await executeRestore({ kind: 'single', name: archiveBasename }, deps);
      // Only the matched op should have been renamed
      expect(opLog).toHaveLength(1);
      expect(opLog[0]).toContain('target-agent');
    });
  });

  // -- Phase 3: findManifestsForRestore (plural) + counter split ---------

  describe('findManifestsForRestore (Phase 3)', () => {
    it('P3-Test 1: returns [] when discoverManifests returns empty list', async () => {
      const deps = makeFakeDeps({ discoverManifests: async () => [] });
      const result = await findManifestsForRestore(deps);
      expect(result).toEqual([]);
    });

    it('P3-Test 2: returns all entries newest-first from discoverManifests', async () => {
      const entries: ManifestEntry[] = [
        { path: '/fake/bust-2026-04-05T18-30-00Z.jsonl', mtime: new Date('2026-04-05T18:30:00Z') },
        { path: '/fake/bust-2026-04-01T10-00-00Z.jsonl', mtime: new Date('2026-04-01T10:00:00Z') },
      ];
      // discoverManifests already returns newest-first; findManifestsForRestore passes through
      const deps = makeFakeDeps({ discoverManifests: async () => entries });
      const result = await findManifestsForRestore(deps);
      expect(result).toHaveLength(2);
      expect(result[0]!.path).toContain('2026-04-05');
      expect(result[1]!.path).toContain('2026-04-01');
    });

    it('P3-Test 3: full restore with TWO manifests restores ops from BOTH (cross-manifest iteration)', async () => {
      // Older manifest: 3 agent archive ops
      const olderEntry: ManifestEntry = {
        path: '/fake/bust-2026-04-01T10-00-00Z.jsonl',
        mtime: new Date('2026-04-01T10:00:00Z'),
      };
      const newerEntry: ManifestEntry = {
        path: '/fake/bust-2026-04-05T18-30-00Z.jsonl',
        mtime: new Date('2026-04-05T18:30:00Z'),
      };

      // Build fake archive ops with distinct archive_paths to avoid dedup
      const makeOp = (name: string): ArchiveOp => ({
        op_id: `op-${name}`,
        op_type: 'archive',
        timestamp: '2026-04-01T10:00:01Z',
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: `${homedir()}/.claude/agents/${name}.md`,
        archive_path: `${homedir()}/.claude/ccaudit/archived/agents/${name}.md`,
        content_sha256: 'abc',
      });

      const olderOps: ManifestOp[] = [makeOp('alpha'), makeOp('beta'), makeOp('gamma')];
      const newerOps: ManifestOp[] = [makeOp('delta'), makeOp('epsilon')];

      const renamedPaths: string[] = [];
      const deps = makeFakeDeps({
        discoverManifests: async () => [newerEntry, olderEntry], // newest-first
        readManifest: async (p) => {
          if (p.includes('2026-04-05')) {
            return { header: fakeHeader, ops: newerOps, footer: fakeFooter, truncated: false };
          }
          return { header: fakeHeader, ops: olderOps, footer: fakeFooter, truncated: false };
        },
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {},
        renameFile: async (_from, to) => {
          renamedPaths.push(path.basename(to));
        },
      });

      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('success');
      // All 5 ops must have been executed (2 from newer + 3 from older)
      expect(renamedPaths).toHaveLength(5);
      expect(renamedPaths).toContain('alpha.md');
      expect(renamedPaths).toContain('beta.md');
      expect(renamedPaths).toContain('gamma.md');
      expect(renamedPaths).toContain('delta.md');
      expect(renamedPaths).toContain('epsilon.md');
      // Counter: 5 moved, 0 already-at-source, 0 failed
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(5);
        expect(result.counts.unarchived.alreadyAtSource).toBe(0);
        expect(result.counts.unarchived.failed).toBe(0);
      }
    });

    it('P3-Test 4: dedup by archive_path — newer manifest wins, older op skipped', async () => {
      const olderEntry: ManifestEntry = {
        path: '/fake/bust-2026-04-01T10-00-00Z.jsonl',
        mtime: new Date('2026-04-01T10:00:00Z'),
      };
      const newerEntry: ManifestEntry = {
        path: '/fake/bust-2026-04-05T18-30-00Z.jsonl',
        mtime: new Date('2026-04-05T18:30:00Z'),
      };

      // Same archive_path in both manifests (duplicate bust of the same source)
      const sharedArchivePath = `${homedir()}/.claude/ccaudit/archived/agents/shared-agent.md`;
      const sharedSourcePath = `${homedir()}/.claude/agents/shared-agent.md`;
      const sharedOp = (label: string): ArchiveOp => ({
        op_id: `op-${label}`,
        op_type: 'archive',
        timestamp: '2026-04-01T10:00:01Z',
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: sharedSourcePath,
        archive_path: sharedArchivePath,
        content_sha256: 'abc',
      });

      const renames: string[] = [];
      const deps = makeFakeDeps({
        discoverManifests: async () => [newerEntry, olderEntry],
        readManifest: async (p) => {
          const ops: ManifestOp[] = p.includes('2026-04-05')
            ? [sharedOp('newer')]
            : [sharedOp('older')];
          return { header: fakeHeader, ops, footer: fakeFooter, truncated: false };
        },
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        pathExists: async () => false,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {},
        renameFile: async (_from, to) => {
          renames.push(to);
        },
      });

      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('success');
      // Only ONE rename despite two manifests having the same archive_path
      expect(renames).toHaveLength(1);
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(1);
      }
    });

    it('P3-Test 5: already-at-source ops counted separately, not as moved', async () => {
      // One op where source exists and archive does NOT → already-at-source
      const op: ArchiveOp = {
        op_id: 'op-ats',
        op_type: 'archive',
        timestamp: '2026-04-05T18:30:01Z',
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: `${homedir()}/.claude/agents/existing-agent.md`,
        archive_path: `${homedir()}/.claude/ccaudit/archived/agents/existing-agent-GONE.md`,
        content_sha256: 'abc',
      };

      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        readManifest: async () => ({
          header: fakeHeader,
          ops: [op],
          footer: fakeFooter,
          truncated: false,
        }),
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux' as const,
        },
        // source exists, archive does NOT
        pathExists: async (p) => p === op.source_path,
        readFileBytes: async () => Buffer.from('content'),
        mkdirRecursive: async () => {},
        renameFile: async () => {},
      });

      const result = await executeRestore({ kind: 'full' }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // The already-at-source op must NOT inflate the moved counter.
        // Phase 8.2: such ops (archive_missing + source_exists) are now
        // suppressed at collection time via isStaleArchiveOp — they no
        // longer reach the executor so alreadyAtSource stays 0 and the
        // suppression is reported via filteredStaleCount instead.
        expect(result.counts.unarchived.moved).toBe(0);
        expect(result.counts.unarchived.alreadyAtSource).toBe(0);
        expect(result.counts.unarchived.failed).toBe(0);
        expect(result.filteredStaleCount).toBe(1);
      }
    });
  });

  // -- dedupManifestOps (Phase 08-01) -----------------------------

  describe('dedupManifestOps', () => {
    const entryNew: ManifestEntry = {
      path: '/m/bust-2026-04-10T00-00-00Z.jsonl',
      mtime: new Date('2026-04-10T00:00:00Z'),
    };
    const entryOld: ManifestEntry = {
      path: '/m/bust-2026-04-01T00-00-00Z.jsonl',
      mtime: new Date('2026-04-01T00:00:00Z'),
    };

    const archiveOp = (
      archive_path: string,
      category: ArchiveOp['category'] = 'skill',
    ): ArchiveOp => ({
      op_id: `op-${archive_path}`,
      op_type: 'archive',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      category,
      scope: 'global',
      source_path: archive_path.replace('/archived/', '/'),
      archive_path,
      content_sha256: 'sha256:abc',
    });

    const disableOp = (new_key: string, config_path = '/home/u/.claude.json'): DisableOp => ({
      op_id: `op-${new_key}`,
      op_type: 'disable',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      config_path,
      scope: 'global',
      project_path: null,
      original_key: `mcpServers.${new_key.replace('ccaudit-disabled:', '')}`,
      new_key,
      original_value: { command: 'x' },
    });

    const flagOp: FlagOp = {
      op_id: 'op-flag',
      op_type: 'flag',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      file_path: '/home/u/CLAUDE.md',
      scope: 'global',
      had_frontmatter: false,
      had_ccaudit_stale: false,
      patched_keys: ['ccaudit-stale'],
      original_content_sha256: 'sha256:x',
    };

    it('empty input returns empty output', () => {
      expect(dedupManifestOps([])).toEqual([]);
    });

    it('single manifest with no duplicates passes through', () => {
      const ops = [archiveOp('/a/skills/foo'), archiveOp('/a/skills/bar')];
      const out = dedupManifestOps([{ entry: entryNew, ops }]);
      expect(out.map((o) => o.canonical_id)).toEqual([
        'skill:/a/skills/foo',
        'skill:/a/skills/bar',
      ]);
      expect(out.every((o) => o.entry === entryNew)).toBe(true);
    });

    it('duplicate archive_path across manifests: newer wins (first-seen)', () => {
      const op1 = archiveOp('/a/skills/foo');
      const op2 = archiveOp('/a/skills/foo');
      const out = dedupManifestOps([
        { entry: entryNew, ops: [op1] },
        { entry: entryOld, ops: [op2] },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].entry).toBe(entryNew);
      expect(out[0].op).toBe(op1);
    });

    it('flag and refresh ops are filtered out', () => {
      const out = dedupManifestOps([
        { entry: entryNew, ops: [flagOp, archiveOp('/a/skills/foo')] },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].canonical_id).toBe('skill:/a/skills/foo');
    });

    it('mixed archive + disable dedup by distinct canonical_id', () => {
      const a = archiveOp('/a/skills/foo');
      const d = disableOp('ccaudit-disabled:pencil');
      const out = dedupManifestOps([{ entry: entryNew, ops: [a, d] }]);
      expect(out.map((o) => o.canonical_id).sort()).toEqual(
        ['mcp:/home/u/.claude.json:ccaudit-disabled:pencil', 'skill:/a/skills/foo'].sort(),
      );
    });

    it('Phase 9 SC6: archive_purge follow-up suppresses its original ArchiveOp', () => {
      const orig = archiveOp('/a/skills/foo');
      const purgeOp: ManifestOp = {
        op_id: 'purge-1',
        op_type: 'archive_purge',
        timestamp: '2026-04-22T12:00:00Z',
        status: 'completed',
        original_op_id: orig.op_id,
        purged: true,
        reason: 'source_occupied',
      };
      // Purge manifest is newer; bust manifest is older. Both present to dedup.
      const entryPurge: ManifestEntry = {
        path: '/m/purge-2026-04-22T12-00-00Z.jsonl',
        mtime: new Date('2026-04-22T12:00:00Z'),
      };
      const out = dedupManifestOps([
        { entry: entryPurge, ops: [purgeOp] },
        { entry: entryNew, ops: [orig] },
      ]);
      expect(out).toHaveLength(0);
    });

    it('archive_purge only suppresses the referenced op, not siblings', () => {
      const a = archiveOp('/a/skills/foo');
      const b = archiveOp('/a/skills/bar');
      const purgeOp: ManifestOp = {
        op_id: 'purge-1',
        op_type: 'archive_purge',
        timestamp: '2026-04-22T12:00:00Z',
        status: 'completed',
        original_op_id: a.op_id,
        purged: true,
        reason: 'reclaimed',
      };
      const entryPurge: ManifestEntry = {
        path: '/m/purge-2026-04-22T12-00-00Z.jsonl',
        mtime: new Date('2026-04-22T12:00:00Z'),
      };
      const out = dedupManifestOps([
        { entry: entryPurge, ops: [purgeOp] },
        { entry: entryNew, ops: [a, b] },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]!.canonical_id).toBe('skill:/a/skills/bar');
    });
  });

  // -- collectRestoreableItems (Phase 8.1 — D81-01 C1a) -----------

  describe('collectRestoreableItems', () => {
    const entryNew: ManifestEntry = {
      path: '/m/bust-2026-04-10T00-00-00Z.jsonl',
      mtime: new Date('2026-04-10T00:00:00Z'),
    };
    const entryOld: ManifestEntry = {
      path: '/m/bust-2026-04-01T00-00-00Z.jsonl',
      mtime: new Date('2026-04-01T00:00:00Z'),
    };

    const archiveOp = (archive_path: string): ArchiveOp => ({
      op_id: `op-${archive_path}`,
      op_type: 'archive',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      category: 'skill',
      scope: 'global',
      source_path: archive_path.replace('/archived/', '/'),
      archive_path,
      content_sha256: 'sha256:abc',
    });

    const disableOp = (new_key: string): DisableOp => ({
      op_id: `op-${new_key}`,
      op_type: 'disable',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      config_path: '/home/u/.claude.json',
      scope: 'global',
      project_path: null,
      original_key: `mcpServers.${new_key.replace('ccaudit-disabled:', '')}`,
      new_key,
      original_value: { command: 'x' },
    });

    const mkFlagOp = (file_path: string, timestamp = '2026-04-10T00:00:00Z'): FlagOp => ({
      op_id: `op-flag-${file_path}`,
      op_type: 'flag',
      timestamp,
      status: 'completed',
      file_path,
      scope: 'global',
      had_frontmatter: false,
      had_ccaudit_stale: false,
      patched_keys: ['ccaudit-stale'],
      original_content_sha256: 'sha256:x',
    });

    const mkRefreshOp = (file_path: string): RefreshOp => ({
      op_id: `op-refresh-${file_path}`,
      op_type: 'refresh',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      file_path,
      scope: 'global',
      previous_flagged_at: '2026-04-01T00:00:00Z',
    });

    it('empty input returns empty output', () => {
      expect(collectRestoreableItems([])).toEqual([]);
    });

    it('flag op is preserved (not dropped)', () => {
      const f = mkFlagOp('/home/u/CLAUDE.md');
      const out = collectRestoreableItems([{ entry: entryNew, ops: [f] }]);
      expect(out).toHaveLength(1);
      // M8: canonical_id includes op_type + op_id to keep distinct ops distinct
      expect(out[0]!.canonical_id).toBe(`memory:flag:/home/u/CLAUDE.md:${f.op_id}`);
      expect(out[0]!.op).toBe(f);
    });

    it('refresh op is preserved under its own memory: key (distinct from flag)', () => {
      const r = mkRefreshOp('/home/u/rules/style.md');
      const out = collectRestoreableItems([{ entry: entryNew, ops: [r] }]);
      expect(out).toHaveLength(1);
      expect(out[0]!.canonical_id).toBe(`memory:refresh:/home/u/rules/style.md:${r.op_id}`);
    });

    it('M8: two flag ops on the same file_path get DISTINCT canonical_ids (INV-S3)', () => {
      // Same file_path, different op_ids — must both be individually restoreable.
      const f1 = mkFlagOp('/home/u/CLAUDE.md', '2026-04-10T00:00:00Z');
      const f2: FlagOp = {
        ...mkFlagOp('/home/u/CLAUDE.md', '2026-04-01T00:00:00Z'),
        op_id: 'op-flag-different-id',
      };
      const out = collectRestoreableItems([
        { entry: entryNew, ops: [f1] },
        { entry: entryOld, ops: [f2] },
      ]);
      // Both ops are individually restoreable — NO dedup collapse
      expect(out).toHaveLength(2);
      const ids = out.map((o) => o.canonical_id);
      expect(ids[0]).toBe(`memory:flag:/home/u/CLAUDE.md:${f1.op_id}`);
      expect(ids[1]).toBe(`memory:flag:/home/u/CLAUDE.md:${f2.op_id}`);
      // Both canonical_ids are distinct
      expect(new Set(ids).size).toBe(2);
    });

    it('M8: flag + refresh on same file_path are both individually restoreable', () => {
      const f = mkFlagOp('/home/u/CLAUDE.md');
      const r: RefreshOp = {
        op_id: 'op-refresh-different',
        op_type: 'refresh',
        timestamp: '2026-04-11T00:00:00Z',
        status: 'completed',
        file_path: '/home/u/CLAUDE.md',
        scope: 'global',
        previous_flagged_at: '2026-04-10T00:00:00Z',
      };
      const out = collectRestoreableItems([{ entry: entryNew, ops: [f, r] }]);
      expect(out).toHaveLength(2);
      const ids = out.map((o) => o.canonical_id);
      expect(ids).toContain(`memory:flag:/home/u/CLAUDE.md:${f.op_id}`);
      expect(ids).toContain(`memory:refresh:/home/u/CLAUDE.md:${r.op_id}`);
    });

    it('mixed archive + disable + flag: all three returned with distinct keys', () => {
      const a = archiveOp('/a/skills/foo');
      const d = disableOp('ccaudit-disabled:pencil');
      const f = mkFlagOp('/home/u/CLAUDE.md');
      const out = collectRestoreableItems([{ entry: entryNew, ops: [a, d, f] }]);
      expect(out.map((o) => o.canonical_id).sort()).toEqual(
        [
          `memory:flag:/home/u/CLAUDE.md:${f.op_id}`,
          'mcp:/home/u/.claude.json:ccaudit-disabled:pencil',
          'skill:/a/skills/foo',
        ].sort(),
      );
    });

    it('skipped ops are omitted (not restoreable)', () => {
      const skipped: ManifestOp = {
        op_id: 'op-skipped',
        op_type: 'skipped',
        timestamp: '2026-04-10T00:00:00Z',
        status: 'completed',
        file_path: '/home/u/weird.md',
        category: 'memory',
        reason: 'unreadable',
      };
      const out = collectRestoreableItems([{ entry: entryNew, ops: [skipped] }]);
      expect(out).toEqual([]);
    });
  });

  // -- matchByName (Phase 08-01) ----------------------------------

  describe('matchByName', () => {
    const mkArchive = (archive_path: string): ArchiveOp => ({
      op_id: `op-${archive_path}`,
      op_type: 'archive',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      category: 'skill',
      scope: 'global',
      source_path: archive_path,
      archive_path,
      content_sha256: 'sha256:x',
    });
    const mkDisable = (name: string): DisableOp => ({
      op_id: `op-${name}`,
      op_type: 'disable',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      config_path: '/home/u/.claude.json',
      scope: 'global',
      project_path: null,
      original_key: `mcpServers.${name}`,
      new_key: `ccaudit-disabled:${name}`,
      original_value: {},
    });

    const items = [
      { canonical_id: 'skill:/a/skills/pencil-dev', op: mkArchive('/a/skills/pencil-dev') },
      { canonical_id: 'skill:/a/skills/scanner', op: mkArchive('/a/skills/scanner') },
      { canonical_id: 'mcp:/home/u/.claude.json:ccaudit-disabled:pencil', op: mkDisable('pencil') },
    ];

    it('0 matches returns empty array', () => {
      expect(matchByName(items, 'nonexistent')).toEqual([]);
    });

    it('1 match returns the single item', () => {
      const out = matchByName(items, 'scanner');
      expect(out).toHaveLength(1);
      expect(out[0].canonical_id).toBe('skill:/a/skills/scanner');
    });

    it('multiple matches returned sorted by canonical_id ASC', () => {
      const out = matchByName(items, 'pencil');
      expect(out.map((i) => i.canonical_id)).toEqual([
        'mcp:/home/u/.claude.json:ccaudit-disabled:pencil',
        'skill:/a/skills/pencil-dev',
      ]);
    });

    it('case-insensitive: uppercase pattern matches lowercase name', () => {
      const out = matchByName(items, 'PENCIL');
      expect(out.map((i) => i.canonical_id)).toContain('skill:/a/skills/pencil-dev');
    });

    it('disable op matches by extracted server name', () => {
      // mcpServers.pencil → 'pencil' via extractServerName
      const out = matchByName([items[2]], 'pencil');
      expect(out).toHaveLength(1);
      expect(out[0].op.op_type).toBe('disable');
    });

    it('empty or whitespace-only pattern returns []', () => {
      expect(matchByName(items, '')).toEqual([]);
      expect(matchByName(items, '   ')).toEqual([]);
    });
  });

  // -- executeRestore (subset) — Phase 08-02 ----------------------
  //
  // Covers { kind: 'interactive'; ids } and { kind: 'all-matching'; pattern }
  // dispatch: group-by-manifest, skipped[] on source-exists, name-not-found
  // when no pattern matches.

  describe('executeRestore (subset)', () => {
    const entryA: ManifestEntry = {
      path: '/fake/.claude/ccaudit/manifests/bust-2026-04-10T10-00-00Z.jsonl',
      mtime: new Date('2026-04-10T10:00:00Z'),
    };
    const entryB: ManifestEntry = {
      path: '/fake/.claude/ccaudit/manifests/bust-2026-04-05T08-00-00Z.jsonl',
      mtime: new Date('2026-04-05T08:00:00Z'),
    };

    const mkArchive = (source_path: string, archive_path: string): ArchiveOp => ({
      op_id: `op-${archive_path}`,
      op_type: 'archive',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      category: 'skill',
      scope: 'global',
      source_path,
      archive_path,
      content_sha256: 'sha256:x',
    });

    // Paths must be within homedir() to satisfy assertWithinHomedir.
    const home = homedir();
    const opA1 = mkArchive(
      path.join(home, '.claude/skills/pencil-dev.md'),
      path.join(home, '.claude/skills/_archived/pencil-dev.md'),
    );
    const opB1 = mkArchive(
      path.join(home, '.claude/skills/scanner.md'),
      path.join(home, '.claude/skills/_archived/scanner.md'),
    );

    const cidA1 = `skill:${opA1.archive_path}`;
    const cidB1 = `skill:${opB1.archive_path}`;

    const mkFlag = (file_path: string): FlagOp => ({
      op_id: `op-flag-${file_path}`,
      op_type: 'flag',
      timestamp: '2026-04-10T00:00:00Z',
      status: 'completed',
      file_path,
      scope: 'global',
      had_frontmatter: true,
      had_ccaudit_stale: true,
      patched_keys: ['ccaudit-stale', 'ccaudit-flagged'],
      original_content_sha256: 'sha256:flag',
    });

    function subsetDeps(overrides: Partial<RestoreDeps> = {}): RestoreDeps {
      return makeFakeDeps({
        discoverManifests: async () => [entryA, entryB],
        readManifest: async (p) => {
          if (p === entryA.path) {
            return { header: fakeHeader, ops: [opA1], footer: fakeFooter, truncated: false };
          }
          return { header: fakeHeader, ops: [opB1], footer: fakeFooter, truncated: false };
        },
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
        // Default: source does NOT exist → every restore succeeds as a no-op rename.
        pathExists: async () => false,
        renameFile: async () => {},
        mkdirRecursive: async () => {},
        readFileBytes: async () => Buffer.from(''),
        ...overrides,
      });
    }

    it('{ kind: interactive } with ids from two manifests visits both', async () => {
      const deps = subsetDeps();
      const result = await executeRestore({ kind: 'interactive', ids: [cidA1, cidB1] }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(2);
        expect(result.manifestPaths).toEqual(expect.arrayContaining([entryA.path, entryB.path]));
        expect(result.selectionFilter).toEqual({ mode: 'subset', ids: [cidA1, cidB1] });
        expect(result.skipped).toEqual([]);
      }
    });

    it('interactive subset executes a selected memory flag op', async () => {
      const flagOp = mkFlag(path.join(home, '.claude/CLAUDE.md'));
      // M8: canonical_id now includes op_type + op_id for per-op uniqueness (INV-S3)
      const flagId = `memory:flag:${flagOp.file_path}:${flagOp.op_id}`;
      const deps = subsetDeps({
        readManifest: async (p) => {
          if (p === entryA.path) {
            return { header: fakeHeader, ops: [flagOp], footer: fakeFooter, truncated: false };
          }
          return { header: fakeHeader, ops: [], footer: fakeFooter, truncated: false };
        },
      });

      const result = await executeRestore({ kind: 'interactive', ids: [flagId] }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(0);
        expect(result.counts.stripped.completed).toBe(1);
        expect(result.selectionFilter).toEqual({ mode: 'subset', ids: [flagId] });
      }
    });

    it('interactive subset executes archive + memory ops and drops unresolved ids from selectionFilter', async () => {
      const flagOp = mkFlag(path.join(home, '.claude/CLAUDE.md'));
      // M8: canonical_id now includes op_type + op_id for per-op uniqueness (INV-S3)
      const flagId = `memory:flag:${flagOp.file_path}:${flagOp.op_id}`;
      const deps = subsetDeps({
        readManifest: async (p) => {
          if (p === entryA.path) {
            return {
              header: fakeHeader,
              ops: [opA1, flagOp],
              footer: fakeFooter,
              truncated: false,
            };
          }
          return { header: fakeHeader, ops: [opB1], footer: fakeFooter, truncated: false };
        },
      });

      const result = await executeRestore(
        { kind: 'interactive', ids: [flagId, 'memory:flag:/does/not/exist:op-gone', cidA1] },
        deps,
      );
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(1);
        expect(result.counts.stripped.completed).toBe(1);
        expect(result.selectionFilter).toEqual({ mode: 'subset', ids: [flagId, cidA1] });
      }
    });

    it('{ kind: all-matching } restores every matching candidate', async () => {
      const deps = subsetDeps();
      // Pattern "n" matches both 'pencil-dev' and 'scanner'
      const result = await executeRestore({ kind: 'all-matching', pattern: 'n' }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(2);
        expect(result.selectionFilter?.mode).toBe('subset');
        expect(result.selectionFilter?.ids.length).toBe(2);
      }
    });

    it('{ kind: all-matching } with 0 matches returns name-not-found', async () => {
      const deps = subsetDeps();
      const result = await executeRestore(
        { kind: 'all-matching', pattern: 'nothing-matches-xyz' },
        deps,
      );
      expect(result.status).toBe('name-not-found');
      if (result.status === 'name-not-found') {
        expect(result.name).toBe('nothing-matches-xyz');
      }
    });

    it('source-exists → skipped[] populated and item excluded from unarchived.moved', async () => {
      // Simulate source_path for opA1 already existing AND archive_path also
      // present on disk (e.g. user manually copied source back without
      // restoring) → restoreArchiveOp classifies as already-at-source and
      // records skipped[]. Archive_path presence keeps the op out of the
      // Phase 8.2 stale-filter (which requires archive_missing +
      // source_exists). opB1 proceeds as a normal move.
      const deps = subsetDeps({
        pathExists: async (p) => p === opA1.source_path || p === opA1.archive_path,
      });
      const result = await executeRestore({ kind: 'interactive', ids: [cidA1, cidB1] }, deps);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.counts.unarchived.moved).toBe(1); // opB1 only
        expect(result.counts.unarchived.alreadyAtSource).toBe(1); // opA1
        expect(result.skipped).toEqual([
          { reason: 'source_exists', path: opA1.source_path, canonical_id: cidA1 },
        ]);
      }
    });

    it('{ kind: interactive } with ids matching nothing returns name-not-found', async () => {
      const deps = subsetDeps();
      const result = await executeRestore(
        { kind: 'interactive', ids: ['skill:/does/not/exist'] },
        deps,
      );
      expect(result.status).toBe('name-not-found');
    });

    it('zero manifests on disk returns no-manifests for subset modes', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [],
        processDetector: {
          runCommand: async () => '',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const r1 = await executeRestore({ kind: 'interactive', ids: [cidA1] }, deps);
      expect(r1.status).toBe('no-manifests');
      const r2 = await executeRestore({ kind: 'all-matching', pattern: 'pencil' }, deps);
      expect(r2.status).toBe('no-manifests');
    });
  });

  // -- Phase 8.2: stale-archive listing hygiene -----------------------

  describe('isStaleArchiveOp + filterRestoreableItems (Phase 8.2)', () => {
    const mkArchive = (archive_path: string, source_path: string): ArchiveOp => ({
      op_id: `op-${archive_path}`,
      op_type: 'archive',
      timestamp: '2026-04-22T00:00:00.000Z',
      status: 'completed',
      category: 'agent',
      scope: 'global',
      source_path,
      archive_path,
      content_sha256: 'sha256:stub',
    });

    // Build a pathExists fake from a set of paths that "exist" on disk.
    const fakeExists = (existing: Set<string>) => async (p: string) => existing.has(p);

    const fakeEntryS: ManifestEntry = {
      path: '/fake/.claude/ccaudit/manifests/bust-stale.jsonl',
      mtime: new Date('2026-04-22T00:00:00Z'),
    };

    it('T1: archive_missing + source_exists → isStale=true (D-01 / SC1)', async () => {
      const op = mkArchive('/h/.claude/ccaudit/archived/agents/a.md', '/h/.claude/agents/a.md');
      const exists = fakeExists(new Set(['/h/.claude/agents/a.md'])); // source back, archive gone
      expect(await isStaleArchiveOp(op, exists)).toBe(true);
    });

    it('T2: archive_exists (regardless of source) → isStale=false (kept; SC1 inverse)', async () => {
      const op = mkArchive('/h/.claude/ccaudit/archived/agents/b.md', '/h/.claude/agents/b.md');
      const existsArchiveOnly = fakeExists(new Set([op.archive_path]));
      expect(await isStaleArchiveOp(op, existsArchiveOnly)).toBe(false);
      const existsBoth = fakeExists(new Set([op.archive_path, op.source_path]));
      expect(await isStaleArchiveOp(op, existsBoth)).toBe(false);
    });

    it('T3: both_missing → isStale=false (kept; fail-loud preserved per D-02 / SC5)', async () => {
      const op = mkArchive('/h/.claude/ccaudit/archived/agents/c.md', '/h/.claude/agents/c.md');
      const existsNone = fakeExists(new Set());
      expect(await isStaleArchiveOp(op, existsNone)).toBe(false);
    });

    it('T4: flag op and disable op pass through filterRestoreableItems regardless of fs state (D-03 / SC2)', async () => {
      const flagOp: FlagOp = {
        op_id: 'op-flag',
        op_type: 'flag',
        timestamp: '2026-04-22T00:00:00Z',
        status: 'completed',
        file_path: '/h/.claude/CLAUDE.md',
        scope: 'global',
        had_frontmatter: true,
        had_ccaudit_stale: true,
        patched_keys: ['ccaudit-flagged'],
        original_content_sha256: 'sha256:flag',
      };
      const disableOp: DisableOp = {
        op_id: 'op-dis',
        op_type: 'disable',
        timestamp: '2026-04-22T00:00:00Z',
        status: 'completed',
        config_path: '/h/.claude.json',
        scope: 'global',
        project_path: null,
        original_key: 'mcpServers.playwright',
        new_key: 'mcpServers.ccaudit-disabled:playwright',
        original_value: {},
      };
      // Include one stale archive op to prove the archive filter fires
      // while flag/disable are untouched.
      const staleArchive = mkArchive(
        '/h/.claude/ccaudit/archived/agents/stale.md',
        '/h/.claude/agents/stale.md',
      );
      const exists = fakeExists(new Set([staleArchive.source_path]));

      const items = [
        {
          entry: fakeEntryS,
          op: flagOp as RestoreableOp,
          canonical_id: `memory:${flagOp.file_path}`,
        },
        {
          entry: fakeEntryS,
          op: disableOp as RestoreableOp,
          canonical_id: `mcp:${disableOp.config_path}:${disableOp.new_key}`,
        },
        {
          entry: fakeEntryS,
          op: staleArchive as RestoreableOp,
          canonical_id: `agent:${staleArchive.archive_path}`,
        },
      ];

      const { kept, filteredStaleCount } = await filterRestoreableItems(items, exists);

      expect(filteredStaleCount).toBe(1);
      expect(kept).toHaveLength(2);
      const keptTypes = kept.map((k) => k.op.op_type).sort();
      expect(keptTypes).toEqual(['disable', 'flag']);
    });
  });
}
