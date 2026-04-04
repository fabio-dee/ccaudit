import { stat } from 'node:fs/promises';
import type { TokenEstimate } from './types.ts';

/** Approximate bytes per token for English text (chars/4 heuristic). */
export const BYTES_PER_TOKEN = 4;

/**
 * Estimate token count from file size on disk.
 * Uses bytes/4 heuristic -- accurate within 10-20% for English markdown.
 * Returns null if the file does not exist or cannot be read.
 */
export async function estimateFromFileSize(filePath: string): Promise<TokenEstimate | null> {
  try {
    const s = await stat(filePath);
    const tokens = Math.ceil(s.size / BYTES_PER_TOKEN);
    return {
      tokens,
      confidence: 'estimated',
      source: `file size (${s.size} bytes / ${BYTES_PER_TOKEN} bytes per token)`,
    };
  } catch {
    return null;
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { writeFile, unlink, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  describe('estimateFromFileSize', () => {
    it('should return tokens = Math.ceil(fileSize / 4) for a real temp file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-test-'));
      const filePath = join(dir, 'test-file.md');
      // Write exactly 400 bytes
      await writeFile(filePath, 'a'.repeat(400));
      const result = await estimateFromFileSize(filePath);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(100); // 400 / 4 = 100
      await unlink(filePath);
    });

    it('should return confidence = estimated', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-test-'));
      const filePath = join(dir, 'test-conf.md');
      await writeFile(filePath, 'hello world');
      const result = await estimateFromFileSize(filePath);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe('estimated');
      await unlink(filePath);
    });

    it('should return null for nonexistent file path', async () => {
      const result = await estimateFromFileSize('/tmp/definitely-does-not-exist-ccaudit-test.md');
      expect(result).toBeNull();
    });

    it('should ceil for non-evenly-divisible sizes', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-test-'));
      const filePath = join(dir, 'test-ceil.md');
      // 401 bytes -> Math.ceil(401/4) = 101
      await writeFile(filePath, 'a'.repeat(401));
      const result = await estimateFromFileSize(filePath);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(101);
      await unlink(filePath);
    });
  });

  describe('BYTES_PER_TOKEN', () => {
    it('should equal 4', () => {
      expect(BYTES_PER_TOKEN).toBe(4);
    });
  });
}
