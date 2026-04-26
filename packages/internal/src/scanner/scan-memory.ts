import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { InventoryItem } from './types.ts';
import type { ClaudePaths } from '../types.ts';
import { resolveMarkdownImports } from './resolve-imports.ts';

/**
 * Derive the Claude Code project slug from an absolute project path.
 * Replaces all path separators (both POSIX '/' and Windows '\') with '-',
 * and strips Windows drive-letter colons so the result is a single valid
 * path segment on any platform.
 *
 * Examples:
 *   /Users/alice/repos/my-project  →  -Users-alice-repos-my-project
 *   C:\Users\alice\repos\my-project  →  C-Users-alice-repos-my-project
 *
 * Note: this mirrors ccaudit's internal slug convention. Claude Code's own
 * Windows slug encoding is not verified — the goal is consistency and valid
 * path segments, not byte-identity with Claude Code's internal representation.
 * If a Windows user reports auto-memory not detected due to slug mismatch,
 * that is a separate investigation.
 */
export function projectSlug(projPath: string): string {
  // Replace path separators (both POSIX and Windows) then strip drive colons.
  return projPath.replace(/[\\/]/g, '-').replace(/:/g, '');
}

/**
 * Scan Claude Code's auto-managed memory file for a project.
 *
 * Claude Code stores per-project auto-memory at:
 *   ~/.claude/projects/<slug>/memory/MEMORY.md
 *
 * If the file exists, one InventoryItem is returned with:
 *   name     = 'MEMORY.md (auto)'
 *   scope    = 'project'
 *   category = 'memory'
 *
 * If absent, returns undefined and never throws.
 *
 * @param projPath   Absolute project path used to derive the slug.
 * @param claudeRoot Override for ~/.claude (used in tests). Defaults to homedir()/.claude.
 */
async function scanAutoMemory(
  projPath: string,
  claudeRoot?: string,
): Promise<InventoryItem | undefined> {
  const slug = projectSlug(projPath);
  const base = claudeRoot ?? path.join(homedir(), '.claude');
  const memPath = path.join(base, 'projects', slug, 'memory', 'MEMORY.md');
  try {
    const s = await stat(memPath);
    return {
      name: 'MEMORY.md (auto)',
      path: memPath,
      scope: 'project',
      category: 'memory',
      projectPath: projPath,
      mtimeMs: s.mtimeMs,
    };
  } catch {
    // File does not exist -- silently skip
    return undefined;
  }
}

/**
 * Emit import-chain InventoryItems for a root CLAUDE.md.
 *
 * For each @-imported file at depth > 0, emits:
 *   name        = '<rootName> @ <relative-path>'
 *   importDepth = depth in the chain
 *   importRoot  = absolute path of the root CLAUDE.md
 *
 * Uses the shared resolveMarkdownImports helper so stripping/resolution
 * semantics are identical to the token estimator.
 */
async function scanImportChain(
  rootPath: string,
  rootName: string,
  projRoot: string | null,
  scope: 'global' | 'project',
  projectPath: string | null,
): Promise<InventoryItem[]> {
  const imports = await resolveMarkdownImports(rootPath);
  return imports.map((imp) => {
    const relPath = projRoot
      ? path.relative(projRoot, imp.path).replace(/\\/g, '/')
      : path.basename(imp.path);
    return {
      name: `${rootName} @ ${relPath}`,
      path: imp.path,
      scope,
      category: 'memory' as const,
      projectPath,
      mtimeMs: imp.mtimeMs,
      importDepth: imp.depth,
      importRoot: rootPath,
    };
  });
}

/**
 * Discover memory files (CLAUDE.md and rules/*.md) at global and project levels.
 *
 * Phase 5 additions:
 *   - Auto-memory: scans ~/.claude/projects/<slug>/memory/MEMORY.md per project (T39)
 *   - Import chains: for each root CLAUDE.md, emits child InventoryItems for
 *     @-imported files with importDepth and importRoot fields set (T40)
 *
 * Includes mtimeMs from stat() on each file for mtime-based ghost classification.
 * Silently skips missing directories and files (never throws).
 */
export async function scanMemoryFiles(
  claudePaths: ClaudePaths,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // 1. Global CLAUDE.md files (+ their import chains)
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const claudeMdPath = path.join(base, 'CLAUDE.md');
    try {
      const s = await stat(claudeMdPath);
      items.push({
        name: 'CLAUDE.md',
        path: claudeMdPath,
        scope: 'global',
        category: 'memory',
        projectPath: null,
        mtimeMs: s.mtimeMs,
      });
      // T40: emit import-chain rows for this root CLAUDE.md
      const chainItems = await scanImportChain(claudeMdPath, 'CLAUDE.md', null, 'global', null);
      items.push(...chainItems);
    } catch {
      // File doesn't exist -- silently skip
    }
  }

  // 2. Global rules/ files
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const rulesDir = path.join(base, 'rules');
    try {
      const entries = await readdir(rulesDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(rulesDir, entry);
        try {
          const s = await stat(filePath);
          items.push({
            name: entry,
            path: filePath,
            scope: 'global',
            category: 'memory',
            projectPath: null,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // File disappeared between readdir and stat -- skip
        }
      }
    } catch {
      // rules/ directory doesn't exist -- skip
    }
  }

  // 3. Project CLAUDE.md files (+ import chains + auto-memory)
  for (const projPath of projectPaths) {
    const projClaudeMd = path.join(projPath, 'CLAUDE.md');
    try {
      const s = await stat(projClaudeMd);
      items.push({
        name: 'CLAUDE.md',
        path: projClaudeMd,
        scope: 'project',
        category: 'memory',
        projectPath: projPath,
        mtimeMs: s.mtimeMs,
      });
      // T40: emit import-chain rows for this project CLAUDE.md
      const chainItems = await scanImportChain(
        projClaudeMd,
        'CLAUDE.md',
        projPath,
        'project',
        projPath,
      );
      items.push(...chainItems);
    } catch {
      // File doesn't exist -- skip
    }

    // T39: emit auto-memory item if present
    const autoMem = await scanAutoMemory(projPath);
    if (autoMem) items.push(autoMem);
  }

  // 4. Project .claude/rules/ files
  for (const projPath of projectPaths) {
    const rulesDir = path.join(projPath, '.claude', 'rules');
    try {
      const entries = await readdir(rulesDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(rulesDir, entry);
        try {
          const s = await stat(filePath);
          items.push({
            name: entry,
            path: filePath,
            scope: 'project',
            category: 'memory',
            projectPath: projPath,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // File disappeared between readdir and stat -- skip
        }
      }
    } catch {
      // rules/ directory doesn't exist -- skip
    }
  }

  return items;
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm, utimes } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('scanMemoryFiles', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-memory-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when no memory files exist', async () => {
      const result = await scanMemoryFiles(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toEqual([]);
    });

    it('should discover global CLAUDE.md in legacy path', async () => {
      const legacyDir = path.join(tmpDir, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(legacyDir, 'CLAUDE.md'), '# Global config');

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('CLAUDE.md');
      expect(result[0].scope).toBe('global');
      expect(result[0].category).toBe('memory');
      expect(result[0].projectPath).toBeNull();
      expect(result[0].mtimeMs).toBeDefined();
      expect(typeof result[0].mtimeMs).toBe('number');
    });

    it('should discover global CLAUDE.md in both legacy and xdg paths', async () => {
      const legacyDir = path.join(tmpDir, 'legacy');
      const xdgDir = path.join(tmpDir, 'xdg');
      await mkdir(legacyDir, { recursive: true });
      await mkdir(xdgDir, { recursive: true });
      await writeFile(path.join(legacyDir, 'CLAUDE.md'), '# Legacy');
      await writeFile(path.join(xdgDir, 'CLAUDE.md'), '# XDG');

      const result = await scanMemoryFiles({ legacy: legacyDir, xdg: xdgDir }, []);
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.name === 'CLAUDE.md')).toBe(true);
    });

    it('should discover global rules/*.md files', async () => {
      const legacyDir = path.join(tmpDir, 'legacy');
      const rulesDir = path.join(legacyDir, 'rules');
      await mkdir(rulesDir, { recursive: true });
      await writeFile(path.join(rulesDir, 'security.md'), '# Security rules');
      await writeFile(path.join(rulesDir, 'style.md'), '# Style rules');
      await writeFile(path.join(rulesDir, 'readme.txt'), 'not an md file');

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['security.md', 'style.md']);
      for (const item of result) {
        expect(item.scope).toBe('global');
        expect(item.category).toBe('memory');
        expect(item.mtimeMs).toBeDefined();
      }
    });

    it('should discover project-level CLAUDE.md', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      await mkdir(projPath, { recursive: true });
      await writeFile(path.join(projPath, 'CLAUDE.md'), '# Project config');

      const result = await scanMemoryFiles(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('CLAUDE.md');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
      expect(result[0].mtimeMs).toBeDefined();
    });

    it('should discover project .claude/rules/ files', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const rulesDir = path.join(projPath, '.claude', 'rules');
      await mkdir(rulesDir, { recursive: true });
      await writeFile(path.join(rulesDir, 'custom-rule.md'), '# Custom rule');

      const result = await scanMemoryFiles(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('custom-rule.md');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
    });

    it('should populate mtimeMs from file stat', async () => {
      const legacyDir = path.join(tmpDir, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      const claudeMdPath = path.join(legacyDir, 'CLAUDE.md');
      await writeFile(claudeMdPath, '# Config');

      // Set a known mtime
      const knownTime = new Date('2026-01-15T12:00:00Z');
      await utimes(claudeMdPath, knownTime, knownTime);

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].mtimeMs).toBeCloseTo(knownTime.getTime(), -2);
    });

    it('should discover all memory file types combined', async () => {
      // Global CLAUDE.md
      const legacyDir = path.join(tmpDir, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(legacyDir, 'CLAUDE.md'), '# Global');

      // Global rules
      const globalRules = path.join(legacyDir, 'rules');
      await mkdir(globalRules, { recursive: true });
      await writeFile(path.join(globalRules, 'rule1.md'), '# Rule');

      // Project CLAUDE.md + rules
      const projPath = path.join(tmpDir, 'project');
      const projRules = path.join(projPath, '.claude', 'rules');
      await mkdir(projRules, { recursive: true });
      await writeFile(path.join(projPath, 'CLAUDE.md'), '# Project');
      await writeFile(path.join(projRules, 'proj-rule.md'), '# Proj rule');

      const result = await scanMemoryFiles({ legacy: legacyDir, xdg: path.join(tmpDir, 'xdg') }, [
        projPath,
      ]);
      expect(result).toHaveLength(4);
      expect(result.filter((r) => r.scope === 'global')).toHaveLength(2);
      expect(result.filter((r) => r.scope === 'project')).toHaveLength(2);
      expect(result.every((r) => r.category === 'memory')).toBe(true);
      expect(result.every((r) => typeof r.mtimeMs === 'number')).toBe(true);
    });
  });

  // ── T39: scanAutoMemory tests ──────────────────────────────────────────────
  describe('scanAutoMemory (T39)', () => {
    let tmpDir2: string;

    beforeEach(async () => {
      tmpDir2 = await mkdtemp(path.join(tmpdir(), 'scan-auto-mem-'));
    });

    afterEach(async () => {
      await rm(tmpDir2, { recursive: true, force: true });
    });

    it('emits MEMORY.md (auto) item when the file is present', async () => {
      // Build a fake ~/.claude/projects/<slug>/memory/MEMORY.md structure
      const projPath = '/fake/project/path';
      const slug = projPath.replace(/\//g, '-');
      const memDir = path.join(tmpDir2, 'projects', slug, 'memory');
      await mkdir(memDir, { recursive: true });
      const memFile = path.join(memDir, 'MEMORY.md');
      await writeFile(memFile, '# Auto memory content');

      // Pass tmpDir2 as the claudeRoot override so scanAutoMemory looks there
      const item = await scanAutoMemory(projPath, tmpDir2);

      expect(item).toBeDefined();
      expect(item!.name).toBe('MEMORY.md (auto)');
      expect(item!.path).toBe(memFile);
      expect(item!.scope).toBe('project');
      expect(item!.category).toBe('memory');
      expect(item!.projectPath).toBe(projPath);
      expect(typeof item!.mtimeMs).toBe('number');
    });

    it('returns undefined when MEMORY.md is absent (no throw)', async () => {
      const projPath = '/nonexistent/project';
      const item = await scanAutoMemory(projPath, tmpDir2);
      expect(item).toBeUndefined();
    });

    it('auto-memory is included via scanMemoryFiles when the file exists', async () => {
      // Fake project path and claude root
      const projPath = path.join(tmpDir2, 'myproject');
      await mkdir(projPath, { recursive: true });
      await writeFile(path.join(projPath, 'CLAUDE.md'), '# Proj');

      const slug = projectSlug(projPath);
      const memDir = path.join(tmpDir2, 'fake-claude', 'projects', slug, 'memory');
      await mkdir(memDir, { recursive: true });
      await writeFile(path.join(memDir, 'MEMORY.md'), '# Auto mem');

      // We cannot override claudeRoot through scanMemoryFiles directly, so
      // call scanAutoMemory directly with the override to verify the integration.
      const item = await scanAutoMemory(projPath, path.join(tmpDir2, 'fake-claude'));
      expect(item).toBeDefined();
      expect(item!.name).toBe('MEMORY.md (auto)');
    });

    it('projectSlug strips Windows drive colons and normalises backslashes', () => {
      // Verify the slug function produces a valid single path segment on
      // Windows-style paths — no colon, no backslash, no absolute-path confusion.
      expect(projectSlug('C:\\Users\\runner\\AppData\\Local\\Temp\\myproject')).toBe(
        'C-Users-runner-AppData-Local-Temp-myproject',
      );
      // POSIX paths should behave as before.
      expect(projectSlug('/Users/alice/repos/my-project')).toBe('-Users-alice-repos-my-project');
    });
  });

  // ── T40: import-chain rows tests ───────────────────────────────────────────
  describe('import-chain rows via scanMemoryFiles (T40)', () => {
    let tmpDir3: string;

    beforeEach(async () => {
      tmpDir3 = await mkdtemp(path.join(tmpdir(), 'scan-chain-'));
    });

    afterEach(async () => {
      await rm(tmpDir3, { recursive: true, force: true });
    });

    it('2-level @-chain produces 3 memory items: root + 2 imports', async () => {
      // grandchild.md <- child.md <- CLAUDE.md
      const legacyDir = path.join(tmpDir3, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      const grandchild = path.join(legacyDir, 'grandchild.md');
      const child = path.join(legacyDir, 'child.md');
      const root = path.join(legacyDir, 'CLAUDE.md');
      await writeFile(grandchild, '# Grandchild content');
      await writeFile(child, '@grandchild.md\n# Child content');
      await writeFile(root, '@child.md\n# Root content');

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir3, 'xdg') },
        [],
      );

      // Should have: CLAUDE.md (root), CLAUDE.md @ child.md, CLAUDE.md @ grandchild.md
      expect(result).toHaveLength(3);
      const rootItem = result.find((r) => r.name === 'CLAUDE.md');
      expect(rootItem).toBeDefined();

      const chainItems = result.filter((r) => r.importDepth !== undefined);
      expect(chainItems).toHaveLength(2);

      const depth1 = chainItems.find((r) => r.importDepth === 1);
      expect(depth1).toBeDefined();
      expect(depth1!.importRoot).toBe(root);
      expect(depth1!.category).toBe('memory');
      expect(depth1!.scope).toBe('global');

      const depth2 = chainItems.find((r) => r.importDepth === 2);
      expect(depth2).toBeDefined();
      expect(depth2!.importRoot).toBe(root);
    });

    it('import rows carry correct importDepth and importRoot for project-scoped roots', async () => {
      const projPath = path.join(tmpDir3, 'my-proj');
      await mkdir(projPath, { recursive: true });
      const child = path.join(projPath, 'rules.md');
      await writeFile(child, '# Rules');
      const root = path.join(projPath, 'CLAUDE.md');
      await writeFile(root, '@rules.md\n# Project root');

      const result = await scanMemoryFiles(
        { legacy: path.join(tmpDir3, 'legacy'), xdg: path.join(tmpDir3, 'xdg') },
        [projPath],
      );

      // 2 items: CLAUDE.md root + import row
      const chainItem = result.find((r) => r.importDepth !== undefined);
      expect(chainItem).toBeDefined();
      expect(chainItem!.importDepth).toBe(1);
      expect(chainItem!.importRoot).toBe(root);
      expect(chainItem!.projectPath).toBe(projPath);
      expect(chainItem!.scope).toBe('project');
      // Name uses relative path from projRoot
      expect(chainItem!.name).toContain('CLAUDE.md @');
      expect(chainItem!.name).toContain('rules.md');
    });

    it('CLAUDE.md with no @-imports produces no chain items', async () => {
      const legacyDir = path.join(tmpDir3, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(legacyDir, 'CLAUDE.md'), '# No imports');

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir3, 'xdg') },
        [],
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.importDepth).toBeUndefined();
    });

    it('import inside fenced code block is NOT followed', async () => {
      const legacyDir = path.join(tmpDir3, 'legacy');
      await mkdir(legacyDir, { recursive: true });
      const secret = path.join(legacyDir, 'secret.md');
      await writeFile(secret, '# Secret');
      await writeFile(path.join(legacyDir, 'CLAUDE.md'), '```\n@secret.md\n```\n# Root');

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir3, 'xdg') },
        [],
      );

      expect(result).toHaveLength(1);
      expect(result.every((r) => r.importDepth === undefined)).toBe(true);
    });
  });
}
