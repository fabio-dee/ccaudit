import { glob } from 'tinyglobby';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { InventoryItem } from './types.ts';
import type { ClaudePaths } from '../types.ts';
import { parseFrontmatter } from '../token/frontmatter.ts';

/**
 * Derive a namespaced command name from a file path, relative to the
 * commands root directory.
 *
 * Examples:
 *   commands/foo.md          -> 'foo'
 *   commands/git/commit.md   -> 'git:commit'
 *   commands/a/b/c.md        -> 'a:b:c'
 *
 * If the frontmatter includes a `name` key, it takes precedence.
 *
 * @param filePath   - Absolute path to the .md file
 * @param commandsRoot - Absolute path to the commands/ directory
 * @param fmName       - Optional name from parsed frontmatter (takes precedence)
 */
export function resolveCommandName(
  filePath: string,
  commandsRoot: string,
  fmName?: string | null,
): string {
  if (fmName) return fmName;

  // Strip root prefix + leading separator
  let rel = filePath.slice(commandsRoot.length);
  if (rel.startsWith(path.sep) || rel.startsWith('/')) {
    rel = rel.slice(1);
  }

  // Strip .md extension
  if (rel.endsWith('.md')) {
    rel = rel.slice(0, -3);
  }

  // Normalise path separators to ':'
  return rel.split(/[\\/]/).join(':');
}

/**
 * Discover command .md files from global and project-local commands/ directories.
 *
 * Searches recursively using tinyglobby `**\/*.md` patterns.
 * Returns InventoryItem[] with category='command'.
 *
 * Name resolution: subdirectory segments become namespaces via ':' separator.
 * E.g. commands/git/commit.md → name='git:commit'.
 * If frontmatter contains `name:`, that value overrides the path-derived name.
 *
 * Silently skips missing directories (never throws).
 */
export async function scanCommands(
  claudePaths: ClaudePaths,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // Global commands: scan both legacy and XDG paths
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const commandsRoot = path.join(base, 'commands');
    // CRITICAL: Use forward slashes for tinyglobby (cross-platform)
    const posixRoot = commandsRoot.replace(/\\/g, '/');
    try {
      const files = await glob([`${posixRoot}/**/*.md`], {
        absolute: true,
        dot: false,
        ignore: [`${posixRoot}/_archived/**`],
      });
      for (const filePath of files) {
        try {
          const s = await stat(filePath);
          const fm = await parseFrontmatter(filePath);
          const name = resolveCommandName(filePath, commandsRoot, fm?.name);
          items.push({
            name,
            path: filePath,
            scope: 'global',
            category: 'command',
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

  // Project-local commands: .claude/commands/ in each project path
  for (const projPath of projectPaths) {
    const commandsRoot = path.join(projPath, '.claude', 'commands');
    const posixRoot = commandsRoot.replace(/\\/g, '/');
    try {
      const files = await glob([`${posixRoot}/**/*.md`], {
        absolute: true,
        dot: false,
        ignore: [`${posixRoot}/_archived/**`],
      });
      for (const filePath of files) {
        try {
          const s = await stat(filePath);
          const fm = await parseFrontmatter(filePath);
          const name = resolveCommandName(filePath, commandsRoot, fm?.name);
          items.push({
            name,
            path: filePath,
            scope: 'project',
            category: 'command',
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
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('resolveCommandName', () => {
    it('flat file -> name with no namespace', () => {
      const root = '/base/commands';
      expect(resolveCommandName('/base/commands/foo.md', root)).toBe('foo');
    });

    it('one level of subdirectory -> namespace:name', () => {
      const root = '/base/commands';
      expect(resolveCommandName('/base/commands/git/commit.md', root)).toBe('git:commit');
    });

    it('two levels of subdirectory -> a:b:c', () => {
      const root = '/base/commands';
      expect(resolveCommandName('/base/commands/a/b/c.md', root)).toBe('a:b:c');
    });

    it('frontmatter name overrides path-derived name', () => {
      const root = '/base/commands';
      expect(resolveCommandName('/base/commands/git/commit.md', root, 'custom')).toBe('custom');
    });

    it('null frontmatter name falls back to path derivation', () => {
      const root = '/base/commands';
      expect(resolveCommandName('/base/commands/foo.md', root, null)).toBe('foo');
    });
  });

  describe('scanCommands', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-commands-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when commands directories do not exist', async () => {
      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toEqual([]);
    });

    it('should discover 2 items: flat foo.md and namespaced git/commit.md', async () => {
      const commandsDir = path.join(tmpDir, 'legacy', 'commands');
      const gitDir = path.join(commandsDir, 'git');
      await mkdir(gitDir, { recursive: true });
      await writeFile(path.join(commandsDir, 'foo.md'), '# Command foo');
      await writeFile(path.join(gitDir, 'commit.md'), '# Command git commit');

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['foo', 'git:commit']);
      for (const item of result) {
        expect(item.scope).toBe('global');
        expect(item.category).toBe('command');
        expect(item.projectPath).toBeNull();
      }
    });

    it('should resolve deep namespacing: a/b/c.md -> a:b:c', async () => {
      const deepDir = path.join(tmpDir, 'legacy', 'commands', 'a', 'b');
      await mkdir(deepDir, { recursive: true });
      await writeFile(path.join(deepDir, 'c.md'), '# deep command');

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('a:b:c');
    });

    it('should skip _archived subdirectory', async () => {
      const commandsDir = path.join(tmpDir, 'legacy', 'commands');
      const archivedDir = path.join(commandsDir, '_archived');
      await mkdir(archivedDir, { recursive: true });
      await writeFile(path.join(commandsDir, 'active.md'), '# active');
      await writeFile(path.join(archivedDir, 'old.md'), '# archived');

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('active');
    });

    it('should skip dotfiles (.hidden.md)', async () => {
      const commandsDir = path.join(tmpDir, 'legacy', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(path.join(commandsDir, 'visible.md'), '# visible');
      await writeFile(path.join(commandsDir, '.hidden.md'), '# hidden');

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('visible');
    });

    it('should use frontmatter name: override when present', async () => {
      const commandsDir = path.join(tmpDir, 'legacy', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(
        path.join(commandsDir, 'path-name.md'),
        '---\nname: custom\ndescription: test\n---\n# content',
      );

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('custom');
    });

    it('should discover project-local commands with scope=project', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const commandsDir = path.join(projPath, '.claude', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(path.join(commandsDir, 'local-cmd.md'), '# local');

      const result = await scanCommands(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('local-cmd');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
    });
  });
}
