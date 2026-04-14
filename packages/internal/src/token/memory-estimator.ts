/**
 * Evidence-based token estimator for Claude Code memory files (CLAUDE.md + rules/).
 *
 * Memory files are fully loaded into context. This estimator follows @-imports
 * recursively to account for the full transitive closure of loaded content.
 *
 * Algorithm:
 * 1. Estimate tokens for the root file using estimateFromFileSize().
 * 2. Extract @-import references (e.g. @path/to/file.md) -- AFTER stripping
 *    fenced code blocks and inline backticks to avoid following false positives.
 * 3. Resolve relative paths against each file's directory; absolute and ~-prefixed
 *    paths resolved with os.homedir().
 * 4. Recurse up to maxDepth (default 5), bounded by maxFiles (default 50).
 * 5. Missing or unreadable imports are silently skipped.
 * 6. Cycle guard via a `seen` Set of resolved absolute paths.
 *
 * Import resolution is delegated to the shared resolveMarkdownImports helper
 * (packages/internal/src/scanner/resolve-imports.ts) so both the scanner and
 * the estimator use identical stripping/resolution logic with no divergence.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { estimateFromFileSize, BYTES_PER_TOKEN } from './file-size-estimator.ts';
import { resolveMarkdownImports } from '../scanner/resolve-imports.ts';

export interface MemoryEstimateResult {
  tokens: number;
  importChain: string[];
  depthReached: number;
  truncatedAtDepth: boolean;
}

/**
 * Estimate total token cost for a memory file, following @-imports recursively.
 *
 * Delegates import resolution to the shared resolveMarkdownImports helper so
 * both the scanner (scan-memory.ts) and the estimator use identical
 * stripping/resolution logic with no semantic divergence.
 *
 * Returns null if the root file cannot be read.
 *
 * @param opts.cycleGuard - Accepted for API compatibility but not forwarded to
 *   resolveMarkdownImports, which maintains its own internal cycle guard. Callers
 *   that already hold a visited-path Set may pass it; it has no effect here.
 */
export async function estimateMemoryTokens(
  rootPath: string,
  opts?: { maxDepth?: number; cycleGuard?: Set<string>; maxFiles?: number },
): Promise<MemoryEstimateResult | null> {
  const maxDepth = opts?.maxDepth ?? 5;
  const maxFiles = opts?.maxFiles ?? 50;

  const absRoot = resolve(rootPath);

  // Check root file exists
  try {
    await stat(absRoot);
  } catch {
    return null;
  }

  // Estimate tokens for the root file
  const rootEstimate = await estimateFromFileSize(absRoot);
  if (!rootEstimate) {
    return null;
  }

  let totalTokens = rootEstimate.tokens;
  const importChain: string[] = [absRoot];

  // Resolve all @-imports recursively via the shared helper
  const imports = await resolveMarkdownImports(absRoot, { maxDepth, maxFiles });

  let maxDepthReached = 0;
  // truncatedAtDepth: true when the helper hit the maxFiles cap or maxDepth limit
  // with remaining imports. We approximate: if we hit maxFiles, it's truncated.
  const truncatedAtDepth = imports.length >= maxFiles;

  for (const imp of imports) {
    importChain.push(imp.path);
    // Use sizeBytes from the stat result to avoid a redundant stat call
    totalTokens += Math.ceil(imp.sizeBytes / BYTES_PER_TOKEN);
    if (imp.depth > maxDepthReached) maxDepthReached = imp.depth;
  }

  return {
    tokens: totalTokens,
    importChain,
    depthReached: maxDepthReached,
    truncatedAtDepth,
  };
}

// ---------------------------------------------------------------------------
// In-source vitest
// ---------------------------------------------------------------------------
if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { writeFile, mkdir, rm, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');

  let tmpDir: string;

  describe('estimateMemoryTokens', () => {
    beforeEach(async () => {
      tmpDir = await mkdtemp(pathJoin(tmpdir(), 'mem-est-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('single file with no imports => tokens = ceil(size/4)', async () => {
      const fp = pathJoin(tmpDir, 'CLAUDE.md');
      await writeFile(fp, 'A'.repeat(400));
      const result = await estimateMemoryTokens(fp);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(100);
      expect(result!.importChain).toHaveLength(1);
      expect(result!.depthReached).toBe(0);
      expect(result!.truncatedAtDepth).toBe(false);
    });

    it('one-level @-import => tokens sum of root + imported file', async () => {
      const child = pathJoin(tmpDir, 'child.md');
      await writeFile(child, 'C'.repeat(200));
      const root = pathJoin(tmpDir, 'root.md');
      await writeFile(root, '@child.md\n' + 'R'.repeat(200));
      const result = await estimateMemoryTokens(root);
      expect(result).not.toBeNull();
      expect(result!.importChain).toHaveLength(2);
      expect(result!.tokens).toBeGreaterThan(50);
    });

    it('depth-5 chain => all files included, depthReached=5', async () => {
      const files: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const fp = pathJoin(tmpDir, 'd' + i + '.md');
        const nextRef = i < 5 ? '@d' + (i + 1) + '.md\n' : '';
        await writeFile(fp, nextRef + 'X'.repeat(40));
        files.unshift(fp);
      }
      const result = await estimateMemoryTokens(files[0]);
      expect(result).not.toBeNull();
      expect(result!.depthReached).toBe(5);
    });

    it('cycle guard: circular @-imports do not infinite-loop', async () => {
      const a = pathJoin(tmpDir, 'a.md');
      const b = pathJoin(tmpDir, 'b.md');
      await writeFile(a, '@b.md\n' + 'A'.repeat(40));
      await writeFile(b, '@a.md\n' + 'B'.repeat(40));
      const result = await estimateMemoryTokens(a);
      expect(result).not.toBeNull();
      const unique = new Set(result!.importChain);
      expect(unique.size).toBe(result!.importChain.length);
    });

    it('imports inside fenced code blocks are NOT followed', async () => {
      const child = pathJoin(tmpDir, 'secret.md');
      await writeFile(child, 'S'.repeat(400));
      const root = pathJoin(tmpDir, 'root2.md');
      await writeFile(root, '```\n@secret.md\n```\n' + 'R'.repeat(40));
      const result = await estimateMemoryTokens(root);
      expect(result).not.toBeNull();
      expect(result!.importChain).toHaveLength(1);
    });

    it('broken @-import path silently skipped', async () => {
      const root = pathJoin(tmpDir, 'root3.md');
      await writeFile(root, '@does-not-exist.md\n' + 'R'.repeat(40));
      const result = await estimateMemoryTokens(root);
      expect(result).not.toBeNull();
      expect(result!.importChain).toHaveLength(1);
    });

    it('relative resolution from nested subdirectory', async () => {
      const subDir = pathJoin(tmpDir, 'sub');
      await mkdir(subDir, { recursive: true });
      const child = pathJoin(subDir, 'child.md');
      await writeFile(child, 'C'.repeat(200));
      const root = pathJoin(tmpDir, 'root4.md');
      await writeFile(root, '@sub/child.md\n' + 'R'.repeat(40));
      const result = await estimateMemoryTokens(root);
      expect(result).not.toBeNull();
      expect(result!.importChain).toHaveLength(2);
    });

    it('root file not found => null', async () => {
      const result = await estimateMemoryTokens(pathJoin(tmpDir, 'nonexistent.md'));
      expect(result).toBeNull();
    });
  });
}
