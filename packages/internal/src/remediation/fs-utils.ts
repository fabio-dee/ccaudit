/**
 * Shared filesystem utilities for the remediation package.
 *
 * writeFilePreservingMtime: write file contents while restoring the original
 * atime/mtime via utimes(). This is required for any write that touches a
 * memory file (~/.claude/memory/**) because the staleness classifier in
 * scan-all.ts + classify.ts is mtime-based. Without this helper, every
 * flag/unflag cycle silently resets mtime to "now" and the staleness count
 * drops to zero (Bug #3).
 *
 * NOTE: the stat → writeFile → utimes sequence is a TOCTOU: a concurrent
 * writer between stat and utimes could have its mtime overwritten by the
 * utimes call. For v1 this is accepted because ccaudit operates on
 * user-owned, non-concurrent config files. A future improvement could use
 * a file lock or atomic rename.
 *
 * Edge-case handling:
 *   - stat throws ENOENT (file created for first time): fallback to bare
 *     writeFile — no mtime to preserve.
 *   - stat or utimes throws EACCES / EROFS (read-only fs, restricted inode):
 *     warn once via console.warn and fall back to bare writeFile.
 *   - Symlink to nonexistent target: stat throws ENOENT → fallback path.
 */

import { writeFile, stat, utimes } from 'node:fs/promises';

/**
 * Write `contents` to `absPath` and then restore the file's original
 * atime/mtime using utimes().
 *
 * Falls back to a bare writeFile when stat or utimes throw (e.g. ENOENT on
 * first creation, EACCES on read-only filesystem). A single console.warn is
 * emitted on unexpected errors so callers learn about the degradation without
 * crashing.
 */
export async function writeFilePreservingMtime(absPath: string, contents: string): Promise<void> {
  // Attempt to capture original timestamps before the write.
  // Returns null if the file does not exist yet or stat fails unexpectedly.
  const timestamps = await stat(absPath).then(
    (s) => ({ atime: new Date(s.atimeMs), mtime: new Date(s.mtimeMs) }),
    (statErr: unknown) => {
      const code = (statErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Unexpected stat failure (e.g. permission denied on directory entry).
        // Warn so the caller learns about the degradation.
        console.warn(
          `[ccaudit] writeFilePreservingMtime: stat("${absPath}") failed (${code ?? 'unknown'}); ` +
            `mtime will not be preserved — file will appear freshly modified.`,
        );
      }
      // ENOENT: file is being created for the first time — no mtime to preserve.
      return null;
    },
  );

  await writeFile(absPath, contents, 'utf8');

  if (timestamps === null) return;

  try {
    await utimes(absPath, timestamps.atime, timestamps.mtime);
  } catch (utimesErr: unknown) {
    const code = (utimesErr as NodeJS.ErrnoException).code;
    console.warn(
      `[ccaudit] writeFilePreservingMtime: utimes("${absPath}") failed (${code ?? 'unknown'}); ` +
        `mtime was not restored — file will appear freshly modified. ` +
        `This can happen on read-only filesystems or overlayfs.`,
    );
    // The write already succeeded; we just lost the mtime restoration.
  }
}

// -- In-source tests -----------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, writeFile: wf, stat: fsStat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  describe('writeFilePreservingMtime', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'fs-utils-'));
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('happy path: mtime is preserved after write (±100ms)', async () => {
      const { utimes } = await import('node:fs/promises');
      const p = join(tmp, 'test.md');
      await wf(p, 'original', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      await utimes(p, oldTime, oldTime);
      const { mtimeMs: beforeMs } = await fsStat(p);

      await writeFilePreservingMtime(p, 'updated content');

      const { mtimeMs: afterMs } = await fsStat(p);
      expect(Math.abs(afterMs - beforeMs)).toBeLessThan(100);
      // Content was updated
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(p, 'utf8');
      expect(content).toBe('updated content');
    });

    it('fallback path: ENOENT (new file) — bare writeFile, no throw', async () => {
      const p = join(tmp, 'new-file.md');
      // File does not exist yet — stat will throw ENOENT, should fall back gracefully
      await expect(writeFilePreservingMtime(p, 'hello')).resolves.toBeUndefined();
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(p, 'utf8');
      expect(content).toBe('hello');
    });
  });
}
