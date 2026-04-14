import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { InventoryItem } from './types.ts';
import type { ClaudePaths } from '../types.ts';
import { parseFrontmatter } from '../token/frontmatter.ts';

/**
 * Extract the registered skill name from SKILL.md frontmatter.
 * Delegates to parseFrontmatter() for robust YAML parsing.
 * Returns the `name:` field value, or the directory name as fallback.
 */
export async function resolveSkillName(skillDir: string): Promise<string> {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const fm = await parseFrontmatter(skillMdPath);
  if (fm?.name) {
    return fm.name;
  }
  return path.basename(skillDir);
}

/**
 * Discover skill directories (and symlinks) from global and project-local skills/ directories.
 *
 * Skips dotfiles (entries starting with `.`).
 * Returns InventoryItem[] with category='skill'.
 * Silently skips missing directories (never throws).
 */
export async function scanSkills(
  claudePaths: ClaudePaths,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  // Global skills: scan both legacy and XDG paths
  for (const base of [claudePaths.legacy, claudePaths.xdg]) {
    const skillsDir = path.join(base, 'skills');
    let entries;
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue; // Directory doesn't exist -- silently skip
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip dotfiles
      if (entry.name === '_archived') continue; // Skip legacy ccaudit archives
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const skillPath = path.join(skillsDir, entry.name);
        try {
          const s = await stat(skillPath);
          const name = await resolveSkillName(skillPath);
          items.push({
            name,
            path: skillPath,
            scope: 'global',
            category: 'skill',
            projectPath: null,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // Broken symlink, deleted target, or path disappeared between readdir and stat -- skip
        }
      }
    }
  }

  // Project-local skills: .claude/skills/ in each project path
  for (const projPath of projectPaths) {
    const skillsDir = path.join(projPath, '.claude', 'skills');
    let entries;
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue; // Directory doesn't exist -- silently skip
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip dotfiles
      if (entry.name === '_archived') continue; // Skip legacy ccaudit archives
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const skillPath = path.join(skillsDir, entry.name);
        try {
          const s = await stat(skillPath);
          const name = await resolveSkillName(skillPath);
          items.push({
            name,
            path: skillPath,
            scope: 'project',
            category: 'skill',
            projectPath: projPath,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // Broken symlink, deleted target, or path disappeared between readdir and stat -- skip
        }
      }
    }
  }

  return items;
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('resolveSkillName', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'skill-name-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return name from SKILL.md name: field', async () => {
      const skillDir = path.join(tmpDir, 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: custom-skill-name\ndescription: A skill\n---\n# Skill',
      );
      const name = await resolveSkillName(skillDir);
      expect(name).toBe('custom-skill-name');
    });

    it('should fall back to directory name when SKILL.md has no name field', async () => {
      const skillDir = path.join(tmpDir, 'fallback-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '# Just a heading\nNo name field.');
      const name = await resolveSkillName(skillDir);
      expect(name).toBe('fallback-skill');
    });

    it('should fall back to directory name when SKILL.md does not exist', async () => {
      const skillDir = path.join(tmpDir, 'no-skillmd');
      await mkdir(skillDir, { recursive: true });
      const name = await resolveSkillName(skillDir);
      expect(name).toBe('no-skillmd');
    });

    it('should trim whitespace from name field value', async () => {
      const skillDir = path.join(tmpDir, 'trim-test');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname:   spaced-name   \n---\n');
      const name = await resolveSkillName(skillDir);
      expect(name).toBe('spaced-name');
    });
  });

  describe('scanSkills', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-skills-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when skills directories do not exist', async () => {
      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toEqual([]);
    });

    it('should discover directories in global legacy skills/', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      await mkdir(path.join(skillsDir, 'deploy'), { recursive: true });
      await mkdir(path.join(skillsDir, 'lint'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['deploy', 'lint']);
      for (const item of result) {
        expect(item.scope).toBe('global');
        expect(item.category).toBe('skill');
        expect(item.projectPath).toBeNull();
      }
    });

    it('should skip dotfiles in skills directory', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      await mkdir(path.join(skillsDir, 'visible-skill'), { recursive: true });
      await mkdir(path.join(skillsDir, '.hidden-skill'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('visible-skill');
    });

    it('should skip _archived directory (legacy ccaudit archives)', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      await mkdir(path.join(skillsDir, 'active-skill'), { recursive: true });
      await mkdir(path.join(skillsDir, '_archived'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('active-skill');
    });

    it('should skip regular files (not directories or symlinks)', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await mkdir(path.join(skillsDir, 'real-skill'), { recursive: true });
      await writeFile(path.join(skillsDir, 'not-a-skill.txt'), 'just a file');

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('real-skill');
    });

    it('should include symlinks as skill entries', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      const targetDir = path.join(tmpDir, 'target-skill');
      await mkdir(skillsDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await symlink(targetDir, path.join(skillsDir, 'linked-skill'));

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('linked-skill');
      expect(result[0].mtimeMs).toBeTypeOf('number');
    });

    it('should skip broken symlinks (target deleted)', async () => {
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      const missingTarget = path.join(tmpDir, 'deleted-target');
      await mkdir(skillsDir, { recursive: true });
      // Create a symlink whose target does NOT exist
      await symlink(missingTarget, path.join(skillsDir, 'broken-link'));
      // And a valid skill alongside to prove the filter is selective
      await mkdir(path.join(skillsDir, 'valid-skill'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid-skill');
      expect(result[0].mtimeMs).toBeTypeOf('number');
    });

    it('should discover project-local skills with scope=project', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const skillsDir = path.join(projPath, '.claude', 'skills');
      await mkdir(path.join(skillsDir, 'project-skill'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('project-skill');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
    });

    it('should discover both global and project skills', async () => {
      // Global skill
      const globalDir = path.join(tmpDir, 'legacy', 'skills');
      await mkdir(path.join(globalDir, 'global-skill'), { recursive: true });

      // Project skill
      const projPath = path.join(tmpDir, 'project');
      const projDir = path.join(projPath, '.claude', 'skills');
      await mkdir(path.join(projDir, 'local-skill'), { recursive: true });

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(2);
      const global = result.find((r) => r.name === 'global-skill');
      const local = result.find((r) => r.name === 'local-skill');
      expect(global?.scope).toBe('global');
      expect(local?.scope).toBe('project');
      expect(local?.projectPath).toBe(projPath);
    });

    it('should use frontmatter name when it differs from folder basename (global)', async () => {
      // Regression: scanSkills must call resolveSkillName, not use entry.name directly.
      const skillsDir = path.join(tmpDir, 'legacy', 'skills');
      const folderName = 'folder-basename';
      const frontmatterName = 'declared-name-in-frontmatter';
      const skillDir = path.join(skillsDir, folderName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${frontmatterName}\ndescription: Regression test\n---\n# Skill`,
      );

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(frontmatterName);
      expect(result[0].path).toContain(folderName);
    });

    it('should use frontmatter name when it differs from folder basename (project-local)', async () => {
      const projPath = path.join(tmpDir, 'my-project');
      const skillsDir = path.join(projPath, '.claude', 'skills');
      const folderName = 'proj-folder';
      const frontmatterName = 'proj-declared-name';
      const skillDir = path.join(skillsDir, folderName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${frontmatterName}\ndescription: Regression test\n---\n# Skill`,
      );

      const result = await scanSkills(
        { legacy: path.join(tmpDir, 'legacy'), xdg: path.join(tmpDir, 'xdg') },
        [projPath],
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(frontmatterName);
      expect(result[0].scope).toBe('project');
    });
  });
}
