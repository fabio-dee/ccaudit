// @ccaudit/internal -- reclaim orchestrator (Phase 4)
//
// reclaim() enumerates every file under ~/.claude/ccaudit/archived/,
// computes the union of archive_path values across all manifests, and
// identifies "orphans" — files on disk that are NOT referenced by any
// manifest (i.e., they were stranded during a bust before Phase 3's
// multi-manifest fix, or the manifest was lost).
//
// For each orphan, the inferred source path is computed by replacing
// the archived-root prefix with the home directory, exactly reversing
// the archive path construction used by bust.ts.
//
// Architecture:
// - All I/O paths are behind injectable deps (ReclaimDeps) for testability.
// - Production callers wire real node:fs/promises + os.homedir().
// - The CLI layer (apps/ccaudit/src/cli/commands/reclaim.ts) passes
//   process.env.HOME to the homeDir option for subprocess-safe isolation.
//
// Safety invariants (non-negotiable):
// 1. NEVER overwrite a file at the inferred source path.
// 2. Dry-run is truly read-only — no FS mutation whatsoever.
// 3. Corrupt / truncated manifests: skip with warning, never crash.
// 4. Symlinks in archived/: skip with warning, never follow.
// 5. Non-regular files (directories) in archived/: skip with warning.

import path from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { Result } from '@praha/byethrow';
import type { ManifestEntry } from './manifest.ts';
import { readManifest } from './manifest.ts';
import { moveArchiveToSource } from './archive-move.ts';

// -- Deps interface ---------------------------------------------------

/**
 * Injectable I/O deps for reclaim(). Production callers wire these to
 * real node:fs/promises implementations. Tests pass fakes.
 */
export interface ReclaimDeps {
  /** Resolved home directory (honors HOME env var via CLI layer). */
  homeDir: string;

  /** Discover all bust manifests, sorted newest-first by mtime. */
  discoverManifests: () => Promise<ManifestEntry[]>;

  /** Read a single manifest JSONL file. */
  readManifest: typeof readManifest;

  /** List all entries (recursively) in a directory. Throws ENOENT if not found. */
  readDirRecursive: (dir: string) => Promise<DirEntry[]>;

  /** Check if a path exists (any kind). */
  pathExists: (p: string) => Promise<boolean>;

  /**
   * Move a file from `from` to `to`.
   * Caller guarantees parent dir exists (mkdirRecursive is called first).
   */
  renameFile: (from: string, to: string) => Promise<void>;

  /** Create directory hierarchy. */
  mkdirRecursive: (dir: string) => Promise<void>;

  /** Emit a warning line (used for skipped entries, corrupt manifests, etc.). */
  onWarning?: (msg: string) => void;
}

/** A single entry returned by readDirRecursive. */
export interface DirEntry {
  /** Absolute path to the file/dir. */
  absolutePath: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

// -- Result types ---------------------------------------------------

/** Per-orphan classification. */
export interface OrphanEntry {
  /** Absolute path inside ~/.claude/ccaudit/archived/. */
  archivePath: string;
  /** Inferred source path (where the file came from). */
  inferredSource: string;
  /** True if something already exists at inferredSource. */
  sourceExists: boolean;
}

/** Final summary returned by reclaim(). */
export interface ReclaimResult {
  /** All detected orphans (both restored and skipped). */
  orphans: OrphanEntry[];
  /** Number of files moved from archived/ to their source path. */
  reclaimed: number;
  /** Files skipped because source already exists. */
  skippedSourceExists: number;
  /** Files that threw an error during rename. */
  failed: Array<{ archivePath: string; error: string }>;
}

// -- Options --------------------------------------------------------

export interface ReclaimOptions {
  /** When true: detect + report but do NOT mutate the filesystem. */
  dryRun: boolean;
  /** Injectable I/O deps. Defaults to production implementations. */
  deps?: Partial<ReclaimDeps>;
}

// -- Path inference -------------------------------------------------

/**
 * Compute the inferred source path for an orphaned archive path.
 *
 * Archive layout: <homeDir>/.claude/ccaudit/archived/<relative-to-home>
 * Source layout:  <homeDir>/<relative-to-home>
 *
 * Example:
 *   archivedRoot = /home/user/.claude/ccaudit/archived
 *   archivePath  = /home/user/.claude/ccaudit/archived/.claude/agents/foo.md
 *   inferredSource = /home/user/.claude/agents/foo.md
 */
function inferSourcePath(archivePath: string, archivedRoot: string, homeDir: string): string {
  // Remove the archivedRoot prefix and rejoin with homeDir.
  const rel = path.relative(archivedRoot, archivePath);
  return path.join(homeDir, rel);
}

// -- Core logic -----------------------------------------------------

/**
 * Reclaim orphaned files from ~/.claude/ccaudit/archived/.
 *
 * An "orphan" is a file on disk in archived/ that is not referenced
 * by any manifest's archive_path field.
 *
 * @param opts.dryRun If true, detects orphans but makes no changes.
 * @param opts.deps   Injectable deps (production defaults used if omitted).
 */
export async function reclaim(opts: ReclaimOptions): Promise<ReclaimResult> {
  const deps = buildDeps(opts.deps ?? {});
  const { homeDir, onWarning } = deps;
  const warn = onWarning ?? (() => undefined);

  const archivedRoot = path.join(homeDir, '.claude', 'ccaudit', 'archived');

  // Step 1: Enumerate all files in archived/ ---------------------------
  let diskEntries: DirEntry[];
  try {
    diskEntries = await deps.readDirRecursive(archivedRoot);
  } catch (err) {
    // ENOENT means archived/ does not exist; nothing to reclaim.
    // Any other error (EACCES, EIO, etc.) is unexpected: rethrow so the caller
    // is not silently misled into treating every archived file as an orphan.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { orphans: [], reclaimed: 0, skippedSourceExists: 0, failed: [] };
    }
    throw err;
  }

  // Collect only regular files (skip dirs, symlinks, non-regular)
  const archivedFiles: string[] = [];
  for (const entry of diskEntries) {
    if (entry.isSymbolicLink) {
      warn(`reclaim: skipping symlink at ${entry.absolutePath}`);
      continue;
    }
    if (entry.isDirectory) {
      // Directories are not reclaimable; skip silently (traversal artifact).
      continue;
    }
    if (!entry.isFile) {
      warn(`reclaim: skipping non-regular entry at ${entry.absolutePath}`);
      continue;
    }
    archivedFiles.push(entry.absolutePath);
  }

  // Step 2: Union all archive_path values from all manifests -----------
  const manifestedPaths = new Set<string>();
  let manifests: ManifestEntry[];
  try {
    manifests = await deps.discoverManifests();
  } catch (err) {
    // ENOENT means the manifests directory does not exist yet (no busts have run).
    // Any other error is unexpected: rethrow to avoid silently treating all
    // archived files as orphans on a real filesystem failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      manifests = [];
    } else {
      throw err;
    }
  }

  for (const entry of manifests) {
    let result: Awaited<ReturnType<typeof readManifest>>;
    try {
      result = await deps.readManifest(entry.path);
    } catch (err) {
      warn(
        `reclaim: skipping unreadable manifest ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    // Corrupt manifest (no header): skip with warning, never crash.
    if (result.header === null) {
      warn(`reclaim: skipping corrupt manifest (no header) at ${entry.path}`);
      continue;
    }
    for (const op of result.ops) {
      if (op.op_type === 'archive' && op.archive_path) {
        manifestedPaths.add(op.archive_path);
      }
    }
  }

  // Step 3: Identify orphans ------------------------------------------
  const orphans: OrphanEntry[] = [];
  for (const archivePath of archivedFiles) {
    if (manifestedPaths.has(archivePath)) {
      // Referenced by a manifest → not an orphan.
      continue;
    }
    const inferredSource = inferSourcePath(archivePath, archivedRoot, homeDir);
    const sourceExists = await deps.pathExists(inferredSource);
    orphans.push({ archivePath, inferredSource, sourceExists });
  }

  // Step 4: Act (or dry-run skip) -------------------------------------
  if (opts.dryRun) {
    // Dry-run: report only, no mutations.
    return {
      orphans,
      reclaimed: 0,
      skippedSourceExists: orphans.filter((o) => o.sourceExists).length,
      failed: [],
    };
  }

  let reclaimed = 0;
  let skippedSourceExists = 0;
  const failed: Array<{ archivePath: string; error: string }> = [];

  for (const orphan of orphans) {
    if (orphan.sourceExists) {
      // SAFETY INVARIANT: never overwrite existing source.
      warn(
        `reclaim: skipping ${orphan.archivePath} — source already exists at ${orphan.inferredSource}`,
      );
      skippedSourceExists++;
      continue;
    }

    // Delegate the actual move to the shared helper. Archive existence was
    // already confirmed via readDirRecursive; pass a pathExists that vouches
    // for the archive and reports the (already-verified-free) source state.
    const moveResult = await moveArchiveToSource(
      { archivePath: orphan.archivePath, sourcePath: orphan.inferredSource },
      {
        pathExists: async (p) => (p === orphan.archivePath ? true : deps.pathExists(p)),
        mkdirRecursive: deps.mkdirRecursive,
        renameFile: deps.renameFile,
      },
    );

    if (Result.isSuccess(moveResult)) {
      reclaimed++;
      continue;
    }

    const message = moveResult.error.message;
    warn(`reclaim: failed to move ${orphan.archivePath} → ${orphan.inferredSource}: ${message}`);
    failed.push({ archivePath: orphan.archivePath, error: message });
  }

  return { orphans, reclaimed, skippedSourceExists, failed };
}

// -- Production deps builder ----------------------------------------

/**
 * Build a full ReclaimDeps object, filling in production defaults for
 * any fields not provided by the caller.
 */
function buildDeps(partial: Partial<ReclaimDeps>): ReclaimDeps {
  return {
    homeDir: partial.homeDir ?? homedir(),
    discoverManifests: partial.discoverManifests ?? buildProductionDiscoverManifests(),
    readManifest: partial.readManifest ?? readManifest,
    readDirRecursive: partial.readDirRecursive ?? productionReadDirRecursive,
    pathExists: partial.pathExists ?? productionPathExists,
    renameFile: partial.renameFile ?? productionRenameFile,
    mkdirRecursive: partial.mkdirRecursive ?? productionMkdirRecursive,
    onWarning: partial.onWarning,
  };
}

function buildProductionDiscoverManifests(): () => Promise<ManifestEntry[]> {
  return async () => {
    // Lazy import to avoid circular at module load time.
    const { discoverManifests } = await import('./manifest.ts');
    const { readdir, stat } = await import('node:fs/promises');
    return discoverManifests({
      readdir: (dir: string) => readdir(dir),
      stat: async (p: string) => {
        const s = await stat(p);
        return { mtime: s.mtime };
      },
    });
  };
}

async function productionReadDirRecursive(dir: string): Promise<DirEntry[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.map((e) => ({
    absolutePath: path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name),
    isFile: e.isFile(),
    isDirectory: e.isDirectory(),
    isSymbolicLink: e.isSymbolicLink(),
  }));
}

async function productionPathExists(p: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function productionRenameFile(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  await rename(from, to);
}

async function productionMkdirRecursive(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

// -- In-source unit tests -------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  // Minimal fake DirEntry builder
  const makeFile = (absolutePath: string): DirEntry => ({
    absolutePath,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  });

  const makeSymlink = (absolutePath: string): DirEntry => ({
    absolutePath,
    isFile: false,
    isDirectory: false,
    isSymbolicLink: true,
  });

  const makeDir = (absolutePath: string): DirEntry => ({
    absolutePath,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
  });

  describe('reclaim unit tests', () => {
    it('returns empty result when archived root does not exist (ENOENT)', async () => {
      const deps: Partial<ReclaimDeps> = {
        homeDir: path.join(tmpdir(), 'fake-home'),
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.orphans).toHaveLength(0);
      expect(result.reclaimed).toBe(0);
    });

    it('rethrows non-ENOENT errors from readDirRecursive', async () => {
      const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const deps: Partial<ReclaimDeps> = {
        homeDir: path.join(tmpdir(), 'fake-home'),
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => {
          throw eacces;
        },
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      await expect(reclaim({ dryRun: false, deps })).rejects.toThrow('EACCES');
    });

    it('rethrows non-ENOENT errors from discoverManifests', async () => {
      const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'foo.md');
      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => {
          throw eio;
        },
        readManifest,
        readDirRecursive: async () => [makeFile(archivePath)],
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      await expect(reclaim({ dryRun: false, deps })).rejects.toThrow('EIO');
    });

    it('treats all files as orphans when manifests dir is empty', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'foo.md');

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [makeFile(archivePath)],
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.orphans).toHaveLength(1);
      expect(result.reclaimed).toBe(1);
      expect(result.orphans[0]?.inferredSource).toBe(
        path.join(home, '.claude', 'agents', 'foo.md'),
      );
    });

    it('symlinks are skipped with a warning (never followed)', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const symlinkPath = path.join(archivedRoot, '.claude', 'agents', 'link.md');
      const warnings: string[] = [];

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [makeSymlink(symlinkPath)],
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
        onWarning: (msg) => {
          warnings.push(msg);
        },
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.orphans).toHaveLength(0);
      expect(result.reclaimed).toBe(0);
      expect(warnings.some((w) => w.includes('symlink'))).toBe(true);
    });

    it('directories in archived/ are silently skipped', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const dirEntry = makeDir(path.join(archivedRoot, '.claude', 'agents'));

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [dirEntry],
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.orphans).toHaveLength(0);
    });

    it('SAFETY: never overwrites existing source file', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'bar.md');
      const renameFile = vi.fn(async () => undefined);

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [makeFile(archivePath)],
        pathExists: async () => true, // source EXISTS
        renameFile,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.reclaimed).toBe(0);
      expect(result.skippedSourceExists).toBe(1);
      // renameFile must NOT have been called
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('dry-run: detects orphans but never calls renameFile', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'baz.md');
      const renameFile = vi.fn(async () => undefined);

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [makeFile(archivePath)],
        pathExists: async () => false,
        renameFile,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: true, deps });
      expect(result.orphans).toHaveLength(1);
      expect(result.reclaimed).toBe(0);
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('TOCTOU (M7): source appearing after scan but before move is caught by deps.pathExists', async () => {
      // Simulate a race: during the orphan-scan phase, the inferred source does NOT
      // exist (pathExists returns false for the source → orphan.sourceExists = false,
      // so the early-exit at line ~246 is skipped). Between scan and move a file
      // materialises at the source path. The forwarded deps.pathExists now returns
      // true, moveArchiveToSource's INVARIANT check fires, and the move is refused.
      // Expected: reclaimed === 0, failed contains one entry, renameFile never called.
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'toctou.md');
      const inferredSource = path.join(home, '.claude', 'agents', 'toctou.md');
      const renameFile = vi.fn(async () => undefined);
      let callCount = 0;

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [],
        readManifest,
        readDirRecursive: async () => [makeFile(archivePath)],
        // First call (during orphan scan): source does NOT exist → sourceExists=false.
        // Subsequent calls (forwarded from moveArchiveToSource): source NOW exists.
        // Use path.resolve() for comparison so the test is correct on both POSIX
        // and Windows regardless of separator differences.
        pathExists: async (p: string) => {
          if (path.resolve(p) === path.resolve(archivePath)) return true; // archive always present
          if (path.resolve(p) === path.resolve(inferredSource)) {
            callCount++;
            return callCount > 1; // scan-time: false; move-time: true
          }
          return false;
        },
        renameFile,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      expect(result.reclaimed).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.archivePath).toBe(archivePath);
      // renameFile must NOT have been called (overwrite prevented)
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('manifest-referenced file is NOT an orphan', async () => {
      const home = path.join(tmpdir(), 'fake-home');
      const archivedRoot = path.join(home, '.claude', 'ccaudit', 'archived');
      const archivePath = path.join(archivedRoot, '.claude', 'agents', 'referenced.md');
      const manifestPath = path.join(
        home,
        '.claude',
        'ccaudit',
        'manifests',
        'bust-2026-01-01T00-00-00Z.jsonl',
      );

      const fakeManifestResult = {
        header: {
          record_type: 'header' as const,
          manifest_version: 1 as const,
          ccaudit_version: '1.4.0',
          checkpoint_ghost_hash: 'abc',
          checkpoint_timestamp: '2026-01-01T00:00:00Z',
          since_window: '30d',
          os: 'darwin' as NodeJS.Platform,
          node_version: 'v22.0.0',
          planned_ops: { archive: 1, disable: 0, flag: 0 },
        },
        ops: [
          {
            op_id: 'uuid-1',
            op_type: 'archive' as const,
            timestamp: '2026-01-01T00:00:01Z',
            status: 'completed' as const,
            category: 'agent' as const,
            scope: 'global' as const,
            source_path: path.join(home, '.claude', 'agents', 'referenced.md'),
            archive_path: archivePath,
            content_sha256: 'deadbeef',
          },
        ],
        footer: null,
        truncated: false,
      };

      const deps: Partial<ReclaimDeps> = {
        homeDir: home,
        discoverManifests: async () => [{ path: manifestPath, mtime: new Date() }],
        readManifest: async () => fakeManifestResult,
        readDirRecursive: async () => [makeFile(archivePath)],
        pathExists: async () => false,
        renameFile: async () => undefined,
        mkdirRecursive: async () => undefined,
      };

      const result = await reclaim({ dryRun: false, deps });
      // File is referenced → not an orphan
      expect(result.orphans).toHaveLength(0);
      expect(result.reclaimed).toBe(0);
    });
  });
}
