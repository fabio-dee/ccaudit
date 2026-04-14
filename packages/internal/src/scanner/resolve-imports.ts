/**
 * Shared @-import resolver for Claude Code markdown files.
 *
 * Used by:
 *   - scan-memory.ts   (emit import-chain InventoryItems)
 *   - memory-estimator.ts (recursive token accumulation)
 *
 * Algorithm (mirrors the original memory-estimator logic exactly):
 *   1. Strip fenced code blocks (```...```) and inline backtick spans.
 *   2. Extract @-references matching /(?:^|\s)@([^\s`]+\.(?:md|markdown))/g
 *   3. Resolve relative paths against the importing file's directory;
 *      ~/...  paths against os.homedir(); /...  as absolute.
 *   4. Recurse up to maxDepth (default 5), bounded by maxFiles (default 50).
 *   5. Cycle-guard via a Set<string> of resolved absolute paths.
 *   6. Missing or unreadable imports are silently skipped.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface ResolvedImport {
  /** Absolute path of the imported file */
  path: string;
  /** Import depth (root = 0, direct children = 1, grandchildren = 2, ...) */
  depth: number;
  /** File modification time in ms (from stat) */
  mtimeMs: number;
  /** File size in bytes (from stat - allows callers to compute token estimates) */
  sizeBytes: number;
}

interface WalkOpts {
  maxDepth: number;
  maxFiles: number;
  cycleGuard: Set<string>;
}

/** Strip fenced code blocks and inline backtick spans before scanning imports. */
function stripCodeSpans(content: string): string {
  let stripped = content.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/`[^`]*`/g, '');
  return stripped;
}

/** Extract @-import paths from content (after stripping code spans). */
function extractImports(content: string): string[] {
  const stripped = stripCodeSpans(content);
  const pattern = /(?:^|\s)@([^\s`]+\.(?:md|markdown))/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    imports.push(match[1]!);
  }
  return imports;
}

/** Resolve an import path relative to the importing file's directory. */
function resolveImportPath(importPath: string, fromFile: string): string {
  if (importPath.startsWith('~/') || importPath === '~') {
    return resolve(homedir(), importPath.slice(2));
  }
  if (importPath.startsWith('/')) {
    return importPath;
  }
  return resolve(dirname(fromFile), importPath);
}

async function walk(
  filePath: string,
  depth: number,
  opts: WalkOpts,
  results: ResolvedImport[],
): Promise<void> {
  const absPath = resolve(filePath);

  if (opts.cycleGuard.has(absPath)) return;
  if (results.length >= opts.maxFiles) return;

  opts.cycleGuard.add(absPath);

  // Stat the file to get mtimeMs + sizeBytes
  let fileStat: { mtimeMs: number; size: number };
  try {
    fileStat = await stat(absPath);
  } catch {
    return; // File does not exist or unreadable - silently skip
  }

  // Only push non-root nodes into the results array; the root (depth=0) is the
  // CLAUDE.md itself - callers already have that InventoryItem.
  if (depth > 0) {
    results.push({
      path: absPath,
      depth,
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
    });
  }

  // Recurse into children if depth budget allows
  if (depth < opts.maxDepth) {
    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch {
      return;
    }

    for (const importPath of extractImports(content)) {
      if (results.length >= opts.maxFiles) break;
      const resolvedPath = resolveImportPath(importPath, absPath);
      await walk(resolvedPath, depth + 1, opts, results);
    }
  }
}

/**
 * Resolve all @-import references reachable from rootPath.
 *
 * Returns an array of ResolvedImport objects for every imported file
 * (depth >= 1). The root file itself is NOT included. Results are in
 * DFS pre-order (parent before children).
 *
 * Never throws - missing or unreadable files are silently skipped.
 */
export async function resolveMarkdownImports(
  rootPath: string,
  opts?: { maxDepth?: number; maxFiles?: number },
): Promise<ResolvedImport[]> {
  const maxDepth = opts?.maxDepth ?? 5;
  const maxFiles = opts?.maxFiles ?? 50;
  const cycleGuard = new Set<string>();

  const results: ResolvedImport[] = [];
  await walk(rootPath, 0, { maxDepth, maxFiles, cycleGuard }, results);
  return results;
}

// ---------------------------------------------------------------------------
// In-source vitest
// ---------------------------------------------------------------------------
if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdir, writeFile, rm, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let tmpDir: string;

  describe('resolveMarkdownImports', () => {
    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'resolve-imports-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array for file with no imports', async () => {
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '# No imports here\n');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(0);
    });

    it('returns one import at depth=1 for single @-reference', async () => {
      const child = join(tmpDir, 'child.md');
      await writeFile(child, '# Child');
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '@child.md\n# Root');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(1);
      expect(result[0]!.depth).toBe(1);
      expect(result[0]!.path).toBe(child);
      expect(typeof result[0]!.mtimeMs).toBe('number');
      expect(result[0]!.sizeBytes).toBeGreaterThan(0);
    });

    it('resolves 2-level chain: root -> child -> grandchild (depths 1 and 2)', async () => {
      const grandchild = join(tmpDir, 'grand.md');
      await writeFile(grandchild, '# Grandchild');
      const child = join(tmpDir, 'child.md');
      await writeFile(child, '@grand.md\n# Child');
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '@child.md\n# Root');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(2);
      expect(result[0]!.depth).toBe(1);
      expect(result[1]!.depth).toBe(2);
    });

    it('cycle guard prevents infinite loops (a -> b -> a)', async () => {
      const a = join(tmpDir, 'a.md');
      const b = join(tmpDir, 'b.md');
      await writeFile(a, '@b.md\n# A');
      await writeFile(b, '@a.md\n# B');
      const result = await resolveMarkdownImports(a);
      // a (depth=0, root) -> b (depth=1) -> a (depth=2, CYCLE -> skip)
      // Only b should appear in results
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe(b);
    });

    it('skips imports inside fenced code blocks', async () => {
      const secret = join(tmpDir, 'secret.md');
      await writeFile(secret, '# Secret');
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '```\n@secret.md\n```\n# Root');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(0);
    });

    it('skips missing import targets silently', async () => {
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '@does-not-exist.md\n# Root');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(0);
    });

    it('resolves relative paths from sub-directories', async () => {
      const sub = join(tmpDir, 'sub');
      await mkdir(sub, { recursive: true });
      const child = join(sub, 'child.md');
      await writeFile(child, '# Child in sub');
      const root = join(tmpDir, 'CLAUDE.md');
      await writeFile(root, '@sub/child.md\n# Root');
      const result = await resolveMarkdownImports(root);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe(child);
    });
  });
}
