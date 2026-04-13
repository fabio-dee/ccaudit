import { glob } from 'tinyglobby';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudePaths } from '../types.ts';

export interface DiscoverOptions {
  claudePaths?: ClaudePaths;
  sinceMs?: number; // If provided, pre-filter by file mtime
}

/**
 * Discover JSONL session files from Claude Code's data directories.
 *
 * Searches both XDG (~/.config/claude/) and legacy (~/.claude/) paths.
 * Includes main sessions (*.jsonl) and subagent sessions (subagents/agent-*.jsonl).
 *
 * @param options.claudePaths - Override default Claude paths (useful for testing)
 * @param options.sinceMs - If provided, pre-filter by file mtime (skip files older than window)
 */
export async function discoverSessionFiles(options?: DiscoverOptions): Promise<string[]> {
  const home = homedir();
  const paths = options?.claudePaths ?? {
    xdg: path.join(home, '.config', 'claude'),
    legacy: path.join(home, '.claude'),
  };

  // CRITICAL: Use forward slashes for tinyglobby patterns (cross-platform)
  const patterns = [paths.xdg, paths.legacy].flatMap((base) => {
    const posixBase = base.replace(/\\/g, '/');
    return [
      `${posixBase}/projects/*/*.jsonl`, // Main sessions
      `${posixBase}/projects/*/*/subagents/agent-*.jsonl`, // Subagent sessions
    ];
  });

  const allFiles = await glob(patterns, { absolute: true, dot: false });

  // Fast pre-filter: skip files whose mtime is older than the time window
  if (options?.sinceMs != null && options.sinceMs !== Infinity) {
    const cutoff = Date.now() - options.sinceMs;
    const filtered: string[] = [];
    for (const file of allFiles) {
      try {
        const stats = await stat(file);
        if (stats.mtimeMs >= cutoff) {
          filtered.push(file);
        }
      } catch {
        continue; // File disappeared between glob and stat -- silently skip
      }
    }
    return filtered;
  }

  return allFiles;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('discoverSessionFiles', () => {
    it('should return an array', async () => {
      // Uses default paths (home directory) -- should return an array even if empty
      const result = await discoverSessionFiles();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should accept ClaudePaths option for custom paths', async () => {
      const fixturePath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '__fixtures__',
      );
      const result = await discoverSessionFiles({
        claudePaths: {
          xdg: path.join(fixturePath, 'nonexistent-xdg'),
          legacy: path.join(fixturePath, 'nonexistent-legacy'),
        },
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('should filter files by mtime when sinceMs is provided', async () => {
      const { mkdtemp, writeFile, rm, mkdir, utimes } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmp = await mkdtemp(join(tmpdir(), 'discover-'));
      const projDir = join(tmp, 'projects', 'test-project');
      await mkdir(projDir, { recursive: true });

      // Write two session files
      const recentFile = join(projDir, 'recent.jsonl');
      const oldFile = join(projDir, 'old.jsonl');
      await writeFile(recentFile, '{}', 'utf8');
      await writeFile(oldFile, '{}', 'utf8');

      // Set the old file's mtime to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await utimes(oldFile, tenDaysAgo, tenDaysAgo);

      try {
        const result = await discoverSessionFiles({
          claudePaths: { xdg: tmp, legacy: join(tmp, 'nonexistent') },
          sinceMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('recent.jsonl');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it('should silently skip files that fail stat', async () => {
      if (process.platform === 'win32') return; // symlink creation is permission-sensitive on Windows CI
      const { mkdtemp, writeFile, rm, mkdir, symlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmp = await mkdtemp(join(tmpdir(), 'discover-enoent-'));
      const projDir = join(tmp, 'projects', 'test-project');
      await mkdir(projDir, { recursive: true });

      // Create a broken symlink (stat will fail with ENOENT) and a real file
      const brokenLink = join(projDir, 'broken.jsonl');
      await symlink('/nonexistent/path/that/does/not/exist.jsonl', brokenLink);
      const goodFile = join(projDir, 'good.jsonl');
      await writeFile(goodFile, '{}', 'utf8');

      try {
        const result = await discoverSessionFiles({
          claudePaths: { xdg: tmp, legacy: join(tmp, 'nonexistent') },
          sinceMs: 365 * 24 * 60 * 60 * 1000, // 1 year window
        });
        // Broken symlink should be silently skipped, only good.jsonl returned
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('good.jsonl');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it('should return all files when sinceMs is Infinity', async () => {
      const { mkdtemp, writeFile, rm, mkdir, utimes } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmp = await mkdtemp(join(tmpdir(), 'discover-inf-'));
      const projDir = join(tmp, 'projects', 'test-project');
      await mkdir(projDir, { recursive: true });

      const file1 = join(projDir, 'file1.jsonl');
      const file2 = join(projDir, 'file2.jsonl');
      await writeFile(file1, '{}', 'utf8');
      await writeFile(file2, '{}', 'utf8');

      // Make file2 very old — normally would be filtered out
      const longAgo = new Date('2020-01-01T00:00:00Z');
      await utimes(file2, longAgo, longAgo);

      try {
        const result = await discoverSessionFiles({
          claudePaths: { xdg: tmp, legacy: join(tmp, 'nonexistent') },
          sinceMs: Infinity,
        });
        // Infinity should bypass the sinceMs filter entirely
        expect(result).toHaveLength(2);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
}
