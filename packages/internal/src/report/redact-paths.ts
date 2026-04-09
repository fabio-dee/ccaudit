import type { ProjectGhostSummary } from './types.ts';

/**
 * Redact real project paths in ProjectGhostSummary[] for --privacy mode.
 *
 * Returns new copies with displayPath replaced by stable synthetic labels
 * (project-01, project-02, ...). The mapping is stable within one call:
 * the same projectPath always maps to the same label.
 *
 * Global summary (projectPath === null) keeps displayPath '(global)' unchanged.
 */
export function redactPaths(summaries: ProjectGhostSummary[]): ProjectGhostSummary[] {
  const pathMap = new Map<string, string>();
  let counter = 1;
  return summaries.map((s) => {
    if (s.projectPath === null) return s;
    let label = pathMap.get(s.projectPath);
    if (!label) {
      label = `~/projects/project-${String(counter).padStart(2, '0')}`;
      pathMap.set(s.projectPath, label);
      counter++;
    }
    return { ...s, displayPath: label };
  });
}

/**
 * Build a Map<realProjectPath, syntheticLabel> from ProjectGhostSummary[].
 * Reuses the same stable labeling as redactPaths() so labels are consistent
 * across all output modes within one command invocation.
 */
export function buildRedactionMap(summaries: ProjectGhostSummary[]): Map<string, string> {
  const redacted = redactPaths(summaries);
  const map = new Map<string, string>();
  for (let i = 0; i < summaries.length; i++) {
    const { projectPath } = summaries[i];
    if (projectPath !== null) {
      map.set(projectPath, redacted[i].displayPath);
    }
  }
  return map;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function makeSummary(projectPath: string | null, displayPath: string): ProjectGhostSummary {
    return { projectPath, displayPath, totalTokens: 1000, ghostCount: 5, items: [] };
  }

  describe('redactPaths', () => {
    it('same projectPath always maps to the same label', () => {
      const summaries = [makeSummary('/repo/a', '~/repo/a'), makeSummary('/repo/a', '~/repo/a')];
      const result = redactPaths(summaries);
      expect(result[0].displayPath).toBe(result[1].displayPath);
    });

    it('different paths map to different labels', () => {
      const summaries = [makeSummary('/repo/a', '~/repo/a'), makeSummary('/repo/b', '~/repo/b')];
      const result = redactPaths(summaries);
      expect(result[0].displayPath).not.toBe(result[1].displayPath);
    });

    it('global summary (projectPath: null) passes through unchanged', () => {
      const summaries = [makeSummary(null, '(global)')];
      const result = redactPaths(summaries);
      expect(result[0].displayPath).toBe('(global)');
    });

    it('labels are zero-padded: project-01, project-02', () => {
      const summaries = [makeSummary('/repo/a', '~/repo/a'), makeSummary('/repo/b', '~/repo/b')];
      const result = redactPaths(summaries);
      expect(result[0].displayPath).toBe('~/projects/project-01');
      expect(result[1].displayPath).toBe('~/projects/project-02');
    });

    it('returns shallow copies — originals not mutated', () => {
      const original = makeSummary('/repo/a', '~/repo/a');
      const result = redactPaths([original]);
      expect(original.displayPath).toBe('~/repo/a');
      expect(result[0].displayPath).toBe('~/projects/project-01');
    });
  });

  describe('buildRedactionMap', () => {
    it('maps real project paths to the same synthetic labels as redactPaths()', () => {
      const summaries = [makeSummary('/repo/a', '~/repo/a'), makeSummary('/repo/b', '~/repo/b')];
      const map = buildRedactionMap(summaries);
      expect(map.get('/repo/a')).toBe('~/projects/project-01');
      expect(map.get('/repo/b')).toBe('~/projects/project-02');
    });

    it('skips global summaries', () => {
      const summaries = [makeSummary(null, '(global)'), makeSummary('/repo/a', '~/repo/a')];
      const map = buildRedactionMap(summaries);
      expect(map.has('(global)')).toBe(false);
      expect(map.size).toBe(1);
      expect(map.get('/repo/a')).toBe('~/projects/project-01');
    });
  });
}
