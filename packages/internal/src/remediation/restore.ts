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
import type { ProcessDetectorDeps } from './processes.ts';
import { detectClaudeProcesses } from './processes.ts';

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

  // Memory file frontmatter ops (Plan 02 wires these)
  removeFrontmatterKeys: (filePath: string, keys: string[]) => Promise<unknown>;
  setFrontmatterValue: (filePath: string, key: string, value: string) => Promise<unknown>;

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
  | { status: 'partial-success'; counts: RestoreCounts; failed: number; manifestPath: string; duration_ms: number }
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
export type RestoreMode =
  | { kind: 'full' }
  | { kind: 'single'; name: string }
  | { kind: 'list' };

// -- Helpers ------------------------------------------------------

/**
 * Find the newest manifest entry from discoverManifests, or null if none.
 */
export async function findManifestForRestore(
  deps: RestoreDeps,
): Promise<ManifestEntry | null> {
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
): Promise<{ entry: ManifestEntry; manifest: ReadManifestResult; matchedOps: ManifestOp[] } | null> {
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

function buildProcessGateMessage(
  processes: Array<{ pid: number; command?: string }>,
): string {
  const lines = processes.map(
    (p) => `  PID ${p.pid}${p.command ? ` (${p.command})` : ''}`,
  );
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

// -- Op execution stub (Plan 02 fills this in) --------------------

/**
 * Execute ops from a manifest entry and return a RestoreResult.
 *
 * STUB: Plan 02 (09-02) implements the actual op execution.
 *
 * Execution order per CONTEXT specifics (reversed from bust D-13):
 *   1. Strip flags from memory files (FlagOp / RefreshOp)
 *   2. Re-enable MCP servers (DisableOp batch by config_path)
 *   3. Unarchive skills (ArchiveOp where category === 'skill')
 *   4. Unarchive agents (ArchiveOp where category === 'agent')
 */
async function executeOpsOnManifest(
  entry: ManifestEntry,
  ops: ManifestOp[],
  deps: RestoreDeps,
  start: number,
): Promise<RestoreResult> {
  // STUB: Plan 02 (09-02) implements the actual op execution.
  // TODO(Plan 09-02): iterate ops in reversed order and call:
  //   - restoreFlagOp / restoreRefreshOp for memory (FlagOp | RefreshOp)
  //   - reEnableMcpTransactional for MCP (DisableOp batch by config_path)
  //   - restoreArchiveOp for skills then agents (ArchiveOp)
  //
  // The `ops`, `deps`, and `entry` params are all available for Plan 02 to use.
  void ops; // suppress unused-variable lint in stub mode
  const counts: RestoreCounts = {
    unarchived: { completed: 0, failed: 0 },
    reenabled: { completed: 0, failed: 0 },
    stripped: { completed: 0, failed: 0 },
  };
  const totalFailed =
    counts.unarchived.failed + counts.reenabled.failed + counts.stripped.failed;
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
export async function executeRestore(
  mode: RestoreMode,
  deps: RestoreDeps,
): Promise<RestoreResult> {
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
    return {
      status: 'running-process',
      pids: detection.processes.map((p) => p.pid),
      selfInvocation: detection.processes.some(
        // ClaudeProcess has no selfInvocation field — that walk happens in bust.ts.
        // For restore, we use the same conservative check: any detected process is a block.
        // Self-invocation sub-case can be added in Plan 03's CLI wiring.
        () => false,
      ),
      message: buildProcessGateMessage(detection.processes),
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
      removeFrontmatterKeys: async () => {},
      setFrontmatterValue: async () => {},
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

    it('Test 4: returns process-detection-failed when detectClaudeProcesses spawn-fails', async () => {
      const deps = makeFakeDeps({
        discoverManifests: async () => [fakeEntry],
        processDetector: {
          runCommand: async () => { throw new Error('ENOENT: ps not found'); },
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
        onWarning: (msg) => { warnings.push(msg); },
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
      const archiveBasename = path.basename(archiveOp.archive_path, path.extname(archiveOp.archive_path));
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
      expect(extractServerName('projects./home/u/project.mcpServers.playwright')).toBe('playwright');
    });

    it('handles dotted server name via lastIndexOf', () => {
      expect(extractServerName('mcpServers.my.dotted.server')).toBe('my.dotted.server');
    });

    it('returns original key when no mcpServers pattern found', () => {
      expect(extractServerName('some-other-key')).toBe('some-other-key');
    });
  });
}
