import type { TokenCostResult } from '../token/types.ts';
import type { ProjectGhostSummary } from './types.ts';

/**
 * Group ghost items by project scope.
 *
 * Returns a global summary (scope === 'global' items) and an array of
 * per-project summaries sorted by totalTokens descending. This is used
 * to compute worst-case session overhead: global + single worst project.
 */
export function groupGhostsByProject(
  ghosts: TokenCostResult[],
  homeDir: string,
): { global: ProjectGhostSummary; projects: ProjectGhostSummary[] } {
  const globalItems = ghosts.filter((g) => g.item.scope === 'global');
  const projectItems = ghosts.filter((g) => g.item.scope !== 'global');

  // Group project items by their projectPath
  const projectMap = new Map<string, TokenCostResult[]>();
  for (const item of projectItems) {
    const key = item.item.projectPath ?? '__unknown__';
    const group = projectMap.get(key);
    if (group) {
      group.push(item);
    } else {
      projectMap.set(key, [item]);
    }
  }

  // Build global summary
  const globalSorted = [...globalItems].sort(
    (a, b) => (b.tokenEstimate?.tokens ?? 0) - (a.tokenEstimate?.tokens ?? 0),
  );
  const global: ProjectGhostSummary = {
    projectPath: null,
    displayPath: '(global)',
    totalTokens: globalItems.reduce((sum, g) => sum + (g.tokenEstimate?.tokens ?? 0), 0),
    ghostCount: globalItems.length,
    items: globalSorted,
  };

  // Build per-project summaries
  const projects: ProjectGhostSummary[] = [];
  for (const [projectPath, items] of projectMap) {
    const sorted = [...items].sort(
      (a, b) => (b.tokenEstimate?.tokens ?? 0) - (a.tokenEstimate?.tokens ?? 0),
    );
    const totalTokens = items.reduce((sum, g) => sum + (g.tokenEstimate?.tokens ?? 0), 0);
    const displayPath =
      projectPath !== '__unknown__' && projectPath.startsWith(homeDir)
        ? '~' + projectPath.slice(homeDir.length)
        : projectPath;
    projects.push({
      projectPath: projectPath === '__unknown__' ? null : projectPath,
      displayPath,
      totalTokens,
      ghostCount: items.length,
      items: sorted,
    });
  }

  // Sort projects by totalTokens desc (heaviest offenders first)
  projects.sort((a, b) => b.totalTokens - a.totalTokens);

  return { global, projects };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function makeGhost(
    name: string,
    tokens: number,
    scope: 'global' | 'project',
    projectPath: string | null = null,
  ): TokenCostResult {
    return {
      item: { name, path: `/test/${name}`, scope, category: 'agent', projectPath },
      tier: 'definite-ghost',
      lastUsed: null,
      invocationCount: 0,
      tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
    };
  }

  const HOME = '/home/user';

  describe('groupGhostsByProject', () => {
    it('separates global and project items', () => {
      const ghosts = [
        makeGhost('global-a', 1000, 'global'),
        makeGhost('proj-a', 2000, 'project', '/home/user/repo'),
      ];
      const { global, projects } = groupGhostsByProject(ghosts, HOME);
      expect(global.ghostCount).toBe(1);
      expect(projects).toHaveLength(1);
      expect(projects[0]!.ghostCount).toBe(1);
    });

    it('abbreviates project paths with homeDir', () => {
      const ghosts = [makeGhost('x', 100, 'project', '/home/user/my-project')];
      const { projects } = groupGhostsByProject(ghosts, HOME);
      expect(projects[0]!.displayPath).toBe('~/my-project');
    });

    it('does not abbreviate paths outside homeDir', () => {
      const ghosts = [makeGhost('x', 100, 'project', '/opt/work/repo')];
      const { projects } = groupGhostsByProject(ghosts, HOME);
      expect(projects[0]!.displayPath).toBe('/opt/work/repo');
    });

    it('global displayPath is always "(global)"', () => {
      const { global } = groupGhostsByProject([], HOME);
      expect(global.displayPath).toBe('(global)');
    });

    it('sums totalTokens correctly per project', () => {
      const ghosts = [
        makeGhost('a', 3000, 'project', '/home/user/repo'),
        makeGhost('b', 2000, 'project', '/home/user/repo'),
        makeGhost('c', 1000, 'project', '/home/user/other'),
      ];
      const { projects } = groupGhostsByProject(ghosts, HOME);
      const repo = projects.find((p) => p.displayPath === '~/repo');
      const other = projects.find((p) => p.displayPath === '~/other');
      expect(repo!.totalTokens).toBe(5000);
      expect(other!.totalTokens).toBe(1000);
    });

    it('sorts projects by totalTokens descending', () => {
      const ghosts = [
        makeGhost('small', 100, 'project', '/home/user/small'),
        makeGhost('large', 5000, 'project', '/home/user/large'),
        makeGhost('mid', 2000, 'project', '/home/user/mid'),
      ];
      const { projects } = groupGhostsByProject(ghosts, HOME);
      expect(projects[0]!.totalTokens).toBe(5000);
      expect(projects[1]!.totalTokens).toBe(2000);
      expect(projects[2]!.totalTokens).toBe(100);
    });

    it('sorts items within each group by tokens descending', () => {
      const ghosts = [
        makeGhost('low', 100, 'project', '/home/user/repo'),
        makeGhost('high', 5000, 'project', '/home/user/repo'),
      ];
      const { projects } = groupGhostsByProject(ghosts, HOME);
      expect(projects[0]!.items[0]!.item.name).toBe('high');
      expect(projects[0]!.items[1]!.item.name).toBe('low');
    });

    it('handles empty input', () => {
      const { global, projects } = groupGhostsByProject([], HOME);
      expect(global.totalTokens).toBe(0);
      expect(global.ghostCount).toBe(0);
      expect(projects).toHaveLength(0);
    });

    it('handles null tokenEstimate gracefully', () => {
      const ghost: TokenCostResult = {
        item: {
          name: 'x',
          path: '/x',
          scope: 'project',
          category: 'agent',
          projectPath: '/home/user/repo',
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: null,
      };
      const { projects } = groupGhostsByProject([ghost], HOME);
      expect(projects[0]!.totalTokens).toBe(0);
    });
  });
}
