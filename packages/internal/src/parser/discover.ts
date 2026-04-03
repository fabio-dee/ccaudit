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
  const patterns = [paths.xdg, paths.legacy].flatMap(base => {
    const posixBase = base.replace(/\\/g, '/');
    return [
      `${posixBase}/projects/*/*.jsonl`,                   // Main sessions
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
  });
}
