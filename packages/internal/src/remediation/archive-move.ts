// @ccaudit/internal — shared archive→source move helper (Phase 9 Plan 03)
//
// Lifts the "move archive back to its original source path" logic out of
// reclaim.ts so both `reclaim` and `purge-archive` (Phase 9 SC6) share a
// single implementation site.
//
// SAFETY INVARIANT (CLAUDE.md §Safety invariants):
//   - NEVER overwrite a file at the inferred source path. If the source
//     already exists, the move is refused and a Result.err is returned.
//   - The caller decides whether to skip-with-warning (reclaim) or classify
//     as drop/source_occupied (purge). This helper does not mutate fs
//     unless the refuse-if-source-exists precondition passes.
//
// I/O is fully injected so callers can share real node:fs/promises primitives
// or test doubles. Zero behavior change from the previous inline reclaim code.
//
// Note: We intentionally do NOT import `writeFilePreservingMtime` here.
// Reclaim/purge restore content via `rename` (same-filesystem move), which
// preserves mtime by definition of the syscall. Cross-filesystem renames
// on EXDEV are not observed in the archive root → home layout (both live
// under ~/.claude), so a copy+utimes fallback is not warranted in v1.5.

import path from 'node:path';
import { Result } from '@praha/byethrow';

// -- Deps -----------------------------------------------------------

export interface ArchiveMoveDeps {
  /** True iff the path exists (any kind). */
  pathExists: (p: string) => Promise<boolean>;
  /** Create directory hierarchy. */
  mkdirRecursive: (dir: string) => Promise<void>;
  /** Move file from `from` to `to`. Caller guarantees parent dir exists. */
  renameFile: (from: string, to: string) => Promise<void>;
}

// -- API ------------------------------------------------------------

export interface MoveArchiveInput {
  archivePath: string;
  sourcePath: string;
}

export interface MoveArchiveOk {
  moved: true;
}

/** Distinguishable failure reasons for callers that need to classify. */
export type MoveArchiveFailure =
  | { reason: 'source_exists'; message: string }
  | { reason: 'archive_missing'; message: string }
  | { reason: 'io_error'; message: string };

/**
 * Move a file from the archive to its original source path.
 *
 * Preconditions:
 *   - `archivePath` must exist (else `archive_missing`)
 *   - `sourcePath` must NOT exist (else `source_exists`) — INVARIANT
 *
 * On success:
 *   - Parent directory of `sourcePath` is created (recursive, mode determined by caller — default 0o755)
 *   - File is moved via `renameFile` (mtime preserved by syscall contract)
 */
export async function moveArchiveToSource(
  input: MoveArchiveInput,
  deps: ArchiveMoveDeps,
): Promise<Result.Result<MoveArchiveOk, MoveArchiveFailure>> {
  const { archivePath, sourcePath } = input;

  // 1. Archive must still be on disk (defensive: caller typically checked,
  //    but another process may have moved it between classification and exec).
  const archiveExists = await deps.pathExists(archivePath);
  if (!archiveExists) {
    return Result.fail({
      reason: 'archive_missing',
      message: `archive file not found at ${archivePath}`,
    });
  }

  // 2. INVARIANT: never overwrite existing source.
  const sourceExists = await deps.pathExists(sourcePath);
  if (sourceExists) {
    return Result.fail({
      reason: 'source_exists',
      message: `refusing to overwrite existing source at ${sourcePath}`,
    });
  }

  // 3. Ensure parent dir, then rename.
  try {
    await deps.mkdirRecursive(path.dirname(sourcePath));
    await deps.renameFile(archivePath, sourcePath);
    return Result.succeed({ moved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Result.fail({
      reason: 'io_error',
      message: `rename ${archivePath} → ${sourcePath}: ${message}`,
    });
  }
}

// -- In-source unit tests ------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  const baseDeps = (overrides: Partial<ArchiveMoveDeps> = {}): ArchiveMoveDeps => ({
    pathExists: overrides.pathExists ?? (async () => false),
    mkdirRecursive: overrides.mkdirRecursive ?? (async () => undefined),
    renameFile: overrides.renameFile ?? (async () => undefined),
  });

  describe('moveArchiveToSource', () => {
    it('happy path: archive exists, source free → renames and returns ok', async () => {
      const renameFile = vi.fn(async () => undefined);
      const mkdirRecursive = vi.fn(async () => undefined);
      const pathExists = vi.fn(async (p: string) => p.includes('archived'));
      const result = await moveArchiveToSource(
        {
          archivePath: '/h/.claude/ccaudit/archived/agents/foo.md',
          sourcePath: '/h/.claude/agents/foo.md',
        },
        baseDeps({ renameFile, mkdirRecursive, pathExists }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.moved).toBe(true);
      }
      expect(renameFile).toHaveBeenCalledWith(
        '/h/.claude/ccaudit/archived/agents/foo.md',
        '/h/.claude/agents/foo.md',
      );
      expect(mkdirRecursive).toHaveBeenCalledWith('/h/.claude/agents');
    });

    it('refuses when source already exists (never overwrites)', async () => {
      const renameFile = vi.fn(async () => undefined);
      const pathExists = vi.fn(async () => true); // both exist
      const result = await moveArchiveToSource(
        { archivePath: '/a', sourcePath: '/b' },
        baseDeps({ renameFile, pathExists }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.reason).toBe('source_exists');
      }
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('fails fast when archive is missing', async () => {
      const renameFile = vi.fn(async () => undefined);
      const pathExists = vi.fn(async () => false); // archive missing
      const result = await moveArchiveToSource(
        { archivePath: '/a', sourcePath: '/b' },
        baseDeps({ renameFile, pathExists }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.reason).toBe('archive_missing');
      }
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('wraps rename I/O errors as io_error', async () => {
      const pathExists = vi.fn(async (p: string) => p === '/h/.claude/ccaudit/archived/a.md');
      const renameFile = vi.fn(async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      const result = await moveArchiveToSource(
        { archivePath: '/h/.claude/ccaudit/archived/a.md', sourcePath: '/h/.claude/a.md' },
        baseDeps({ pathExists, renameFile }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.reason).toBe('io_error');
        expect(result.error.message).toContain('EACCES');
      }
    });

    it('creates parent dir before renaming', async () => {
      const calls: string[] = [];
      const pathExists = async (p: string) => p.includes('archived');
      const mkdirRecursive = async (d: string) => {
        calls.push(`mkdir:${d}`);
      };
      const renameFile = async (from: string, to: string) => {
        calls.push(`rename:${from}->${to}`);
      };
      const result = await moveArchiveToSource(
        {
          archivePath: '/h/.claude/ccaudit/archived/x/y/z.md',
          sourcePath: '/h/.claude/x/y/z.md',
        },
        { pathExists, mkdirRecursive, renameFile },
      );
      expect(Result.isSuccess(result)).toBe(true);
      expect(calls[0]).toBe('mkdir:/h/.claude/x/y');
      expect(calls[1]).toBe('rename:/h/.claude/ccaudit/archived/x/y/z.md->/h/.claude/x/y/z.md');
    });
  });
}
