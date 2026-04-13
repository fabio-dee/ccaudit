/**
 * Stop-lists — defensive filters that prevent Tier 2 heuristic clustering
 * from producing meaningless groups.
 *
 * STOP_PREFIXES applies ONLY to Tier 2 heuristic clustering (it never
 * short-circuits Tier 1 curated detection — a curated framework with a
 * generic-looking prefix is still known and should match).
 *
 * DOMAIN_STOP_FOLDERS is defense-in-depth: domain organization folders
 * (engineering/, design/, etc.) must NEVER be auto-promoted to frameworks
 * even if they cluster. Curated-list gating (DETECT-05) already prevents
 * folder-only matches, but this constant protects future code changes.
 *
 * Every entry in DOMAIN_STOP_FOLDERS MUST have a corresponding negative
 * test case in detect.ts (TEST-02 regression guard).
 */

/**
 * Generic English word fragments that look like framework prefixes but are not.
 * O(1) lookup via Set. 24 entries sourced verbatim from REQUIREMENTS.md §DETECT-06.
 */
export const STOP_PREFIXES: Set<string> = new Set([
  'the',
  'and',
  'for',
  'new',
  'old',
  'api',
  'app',
  'web',
  'ui',
  'test',
  'demo',
  'main',
  'util',
  'help',
  'user',
  'data',
  'file',
  'code',
  'doc',
  'dev',
  'pro',
  'lib',
  'src',
  'bin',
]);

/**
 * Domain-organization folder names that must never be treated as frameworks.
 * 18 entries sourced verbatim from REQUIREMENTS.md §DETECT-07.
 * Defense-in-depth — curated-list gating already prevents folder-only matches.
 */
export const DOMAIN_STOP_FOLDERS: Set<string> = new Set([
  'engineering',
  'design',
  'marketing',
  'testing',
  'sales',
  'integrations',
  'strategy',
  'project-management',
  'support',
  'paid-media',
  'spatial-computing',
  'examples',
  'scripts',
  'product',
  'specialized',
  'game-development',
  'agents',
  'skills',
]);

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('STOP_PREFIXES', () => {
    it('contains exactly 24 generic English fragments', () => {
      expect(STOP_PREFIXES.size).toBe(24);
    });
    it('includes api, app, web, ui (common CS noise)', () => {
      expect(STOP_PREFIXES.has('api')).toBe(true);
      expect(STOP_PREFIXES.has('app')).toBe(true);
      expect(STOP_PREFIXES.has('web')).toBe(true);
      expect(STOP_PREFIXES.has('ui')).toBe(true);
    });
    it('does NOT include gsd, sc, nwave (real framework prefixes must not be stop-listed)', () => {
      expect(STOP_PREFIXES.has('gsd')).toBe(false);
      expect(STOP_PREFIXES.has('sc')).toBe(false);
      expect(STOP_PREFIXES.has('nwave')).toBe(false);
    });
  });

  describe('DOMAIN_STOP_FOLDERS', () => {
    it('contains exactly 18 domain-organization folder names', () => {
      expect(DOMAIN_STOP_FOLDERS.size).toBe(18);
    });
    it('includes all ccaudit-known domain folders from REQUIREMENTS §DETECT-07', () => {
      const expected = [
        'engineering',
        'design',
        'marketing',
        'testing',
        'sales',
        'integrations',
        'strategy',
        'project-management',
        'support',
        'paid-media',
        'spatial-computing',
        'examples',
        'scripts',
        'product',
        'specialized',
        'game-development',
        'agents',
        'skills',
      ];
      for (const folder of expected) {
        expect(DOMAIN_STOP_FOLDERS.has(folder)).toBe(true);
      }
    });
    it('does NOT include gsd, sc, ralph (real framework folder names must not be stop-listed)', () => {
      expect(DOMAIN_STOP_FOLDERS.has('gsd')).toBe(false);
      expect(DOMAIN_STOP_FOLDERS.has('sc')).toBe(false);
      expect(DOMAIN_STOP_FOLDERS.has('ralph')).toBe(false);
    });
  });
}
