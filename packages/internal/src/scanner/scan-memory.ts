import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { InventoryItem } from './types.ts';
import type { ClaudePaths } from '../types.ts';

/**
 * Discover memory files (CLAUDE.md and rules/*.md) at global and project levels.
 *
 * Includes mtimeMs from stat() on each file for mtime-based ghost classification.
 * Silently skips missing directories and files (never throws).
 */
export async function scanMemoryFiles(
  claudePaths: ClaudePaths,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  // TODO: implement
  throw new Error('Not implemented');
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

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: xdgDir },
        [],
      );
      expect(result).toHaveLength(2);
      expect(result.every(r => r.name === 'CLAUDE.md')).toBe(true);
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
      const names = result.map(r => r.name).sort();
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

      const result = await scanMemoryFiles(
        { legacy: legacyDir, xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(4);
      expect(result.filter(r => r.scope === 'global')).toHaveLength(2);
      expect(result.filter(r => r.scope === 'project')).toHaveLength(2);
      expect(result.every(r => r.category === 'memory')).toBe(true);
      expect(result.every(r => typeof r.mtimeMs === 'number')).toBe(true);
    });
  });
}
