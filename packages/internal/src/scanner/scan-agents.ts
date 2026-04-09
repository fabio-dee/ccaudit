import { glob } from 'tinyglobby';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { InventoryItem } from './types.ts';
import type { ClaudePaths } from '../types.ts';

/**
 * Discover agent .md files from global and project-local agents/ directories.
 *
 * Searches recursively using tinyglobby `**\/*.md` patterns.
 * Returns InventoryItem[] with category='agent'.
 * Silently skips missing directories (never throws).
 */
export async function scanAgents(
  claudePaths: ClaudePaths,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // Global agents: scan both legacy and XDG paths
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    // CRITICAL: Use forward slashes for tinyglobby (cross-platform)
    const posixBase = base.replace(/\\/g, '/');
    try {
      const files = await glob([`${posixBase}/agents/**/*.md`], {
        absolute: true,
        dot: false,
        ignore: [`${posixBase}/agents/_archived/**`],
      });
      for (const filePath of files) {
        try {
          const s = await stat(filePath);
          items.push({
            name: path.basename(filePath, '.md'),
            path: filePath,
            scope: 'global',
            category: 'agent',
            projectPath: null,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // File disappeared between glob and stat -- skip
        }
      }
    } catch {
      // Directory doesn't exist -- silently skip
    }
  }

  // Project-local agents: .claude/agents/ in each project path
  for (const projPath of projectPaths) {
    const agentsDir = path.join(projPath, '.claude', 'agents');
    const posixDir = agentsDir.replace(/\\/g, '/');
    try {
      const files = await glob([`${posixDir}/**/*.md`], {
        absolute: true,
        dot: false,
        ignore: [`${posixDir}/_archived/**`],
      });
      for (const filePath of files) {
        try {
          const s = await stat(filePath);
          items.push({
            name: path.basename(filePath, '.md'),
            path: filePath,
            scope: 'project',
            category: 'agent',
            projectPath: projPath,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // File disappeared between glob and stat -- skip
        }
      }
    } catch {
      // Directory doesn't exist -- silently skip
    }
  }

  return items;
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('scanAgents', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-agents-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when agents directories do not exist', async () => {
      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toEqual([]);
    });

    it('should discover .md files in global legacy agents/', async () => {
      const agentsDir = path.join(tmpDir, 'legacy', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'code-reviewer.md'), '# Agent');
      await writeFile(path.join(agentsDir, 'deploy-helper.md'), '# Agent');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['code-reviewer', 'deploy-helper']);
      for (const item of result) {
        expect(item.scope).toBe('global');
        expect(item.category).toBe('agent');
        expect(item.projectPath).toBeNull();
      }
    });

    it('should discover .md files in global xdg agents/', async () => {
      const agentsDir = path.join(tmpDir, 'xdg', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'my-agent.md'), '# Agent');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('my-agent');
      expect(result[0].scope).toBe('global');
    });

    it('should discover agents in subdirectories recursively', async () => {
      const subDir = path.join(tmpDir, 'legacy', 'agents', 'design');
      await mkdir(subDir, { recursive: true });
      await writeFile(path.join(subDir, 'deep-agent.md'), '# Agent');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('deep-agent');
    });

    it('should exclude _archived subdirectory (legacy ccaudit archives)', async () => {
      const agentsDir = path.join(tmpDir, 'legacy', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'active-agent.md'), '# Agent');
      const archivedDir = path.join(agentsDir, '_archived');
      await mkdir(archivedDir, { recursive: true });
      await writeFile(path.join(archivedDir, 'old-agent.md'), '# Archived');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('active-agent');
    });

    it('should ignore non-.md files', async () => {
      const agentsDir = path.join(tmpDir, 'legacy', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'agent.md'), '# Agent');
      await writeFile(path.join(agentsDir, 'notes.txt'), 'not an agent');
      await writeFile(path.join(agentsDir, 'config.json'), '{}');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('agent');
    });

    it('should discover project-local agents with scope=project', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const agentsDir = path.join(projPath, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'local-agent.md'), '# Agent');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('local-agent');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
    });

    it('should discover both global and project agents', async () => {
      // Global agent
      const globalDir = path.join(tmpDir, 'legacy', 'agents');
      await mkdir(globalDir, { recursive: true });
      await writeFile(path.join(globalDir, 'global-agent.md'), '# Agent');

      // Project agent
      const projPath = path.join(tmpDir, 'project');
      const projDir = path.join(projPath, '.claude', 'agents');
      await mkdir(projDir, { recursive: true });
      await writeFile(path.join(projDir, 'proj-agent.md'), '# Agent');

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(2);
      const global = result.find((r) => r.name === 'global-agent');
      const local = result.find((r) => r.name === 'proj-agent');
      expect(global?.scope).toBe('global');
      expect(local?.scope).toBe('project');
      expect(local?.projectPath).toBe(projPath);
    });

    it('should skip files that disappear between glob and stat (missing-file race)', async () => {
      const agentsDir = path.join(tmpDir, 'legacy', 'agents');
      await mkdir(agentsDir, { recursive: true });
      // Create two agent files
      await writeFile(path.join(agentsDir, 'stable-agent.md'), '# Stable agent');
      const racyPath = path.join(agentsDir, 'racy-agent.md');
      await writeFile(racyPath, '# Will be deleted');

      // Delete one file before scanAgents runs. tinyglobby may or may not
      // re-observe the deletion depending on OS caching -- the defensive
      // try/catch-stat must swallow ENOENT regardless.
      await unlink(racyPath);

      const result = await scanAgents(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      // At minimum, the stable agent survives. The racy one may or may not
      // appear in the glob result; if it does, it was caught by the try/catch.
      const names = result.map((r) => r.name);
      expect(names).toContain('stable-agent');
      expect(names).not.toContain('racy-agent');
      // Every returned item must have mtimeMs populated
      expect(result.every((r) => typeof r.mtimeMs === 'number')).toBe(true);
    });
  });
}
