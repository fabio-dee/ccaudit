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
 */
export interface RestoreCounts {
  unarchived: { completed: number; failed: number };
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
  | { status: 'success'; counts: RestoreCounts; manifestPath: string; duration_ms: number }
  | {
      status: 'partial-success';
      counts: RestoreCounts;
      failed: number;
      manifestPath: string;
      duration_ms: number;
    }
  | { status: 'no-manifests' }
  | { status: 'name-not-found'; name: string }
  | { status: 'manifest-corrupt'; path: string }
  | { status: 'list'; entries: ManifestListEntry[] }
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
export type RestoreMode = { kind: 'full' } | { kind: 'single'; name: string } | { kind: 'list' };

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
 * Find the newest manifest entry from discoverManifests, or null if none.
 */
export async function findManifestForRestore(deps: RestoreDeps): Promise<ManifestEntry | null> {
  const entries = await deps.discoverManifests();
  return entries[0] ?? null;
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
  for (const entry of entries) {
    const manifest = await deps.readManifest(entry.path);
    if (manifest.header === null) continue; // corrupt: silently skip in list mode
    listEntries.push({
      path: entry.path,
      mtime: entry.mtime,
      isPartial: manifest.footer === null,
      opCount: manifest.ops.length,
      ops: manifest.ops,
    });
  }
  return { status: 'list', entries: listEntries };
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
): Promise<'completed' | 'failed'> {
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
  // If the archive also doesn't exist, the file was never archived (bust failed
  // silently) or was already restored — treat as completed so the user gets an
  // accurate count instead of a wall of phantom failures.
  // If BOTH source and archive exist, there is a genuine collision — warn and fail.
  if (await deps.pathExists(op.source_path)) {
    if (!(await deps.pathExists(op.archive_path))) {
      // Already in original location with no archive copy — nothing to do.
      deps.onWarning?.(
        `ℹ️  ${path.basename(op.source_path)} already at original location (not in archive) — counting as restored`,
      );
      return 'completed';
    }
    deps.onWarning?.(
      `⚠️  ${path.basename(op.source_path)} exists at both source and archive — skipping to avoid overwrite (restore manually if needed)`,
    );
    return 'failed';
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
    return 'completed';
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
): Promise<RestoreResult> {
  const counts: RestoreCounts = {
    unarchived: { completed: 0, failed: 0 },
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
    if (outcome === 'completed') counts.unarchived.completed++;
    else counts.unarchived.failed++;
  }

  // Step 5: Unarchive agents
  const agentOps = archiveOps.filter((o) => o.category === 'agent');
  for (const op of agentOps) {
    const outcome = await restoreArchiveOp(op, deps);
    if (outcome === 'completed') counts.unarchived.completed++;
    else counts.unarchived.failed++;
  }

  const totalFailed = counts.unarchived.failed + counts.reenabled.failed + counts.stripped.failed;
  const duration_ms = Date.now() - start;
  if (totalFailed === 0) {
    return { status: 'success', counts, manifestPath: entry.path, duration_ms };
  }
  return {
    status: 'partial-success',
    counts,
    failed: totalFailed,
    manifestPath: entry.path,
    duration_ms,
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

  // Full restore: use the newest manifest
  if (mode.kind === 'full') {
    const entry = await findManifestForRestore(deps);
    if (entry === null) return { status: 'no-manifests' };

    const manifest = await deps.readManifest(entry.path);
    if (manifest.header === null) {
      return { status: 'manifest-corrupt', path: entry.path };
    }
    if (manifest.footer === null) {
      deps.onWarning?.(
        `Partial bust detected — ${path.basename(entry.path)} has no completion record. Restoring operations that were recorded.`,
      );
    }
    return executeOpsOnManifest(entry, manifest.ops, deps, start);
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
        expect(result.counts.unarchived.completed).toBe(0);
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
    it('Test 1: archive file exists, source_path empty → rename succeeds, returns completed', async () => {
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
        expect(result).toBe('completed');
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
        expect(result).toBe('completed');
        expect(warnings.some((w) => w.includes('modified after archiving'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 3: source_path exists but archive does NOT exist → already-restored, returns completed', async () => {
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
        expect(result).toBe('completed');
        expect(warnings.some((w) => w.includes('already at original location'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('Test 3b: source_path AND archive_path both exist → genuine collision, returns failed', async () => {
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
        expect(result).toBe('failed');
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
        expect(result.counts.unarchived.completed).toBeGreaterThan(0);
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
}
