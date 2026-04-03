import { glob } from 'tinyglobby';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudePaths } from '../types.ts';

export interface DiscoverOptions {
  claudePaths?: ClaudePaths;
  sinceMs?: number; // If provided, pre-filter by file mtime
}

// STUB: intentionally broken for TDD RED phase
export async function discoverSessionFiles(_options?: DiscoverOptions): Promise<string[]> {
  throw new Error('Not implemented');
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
