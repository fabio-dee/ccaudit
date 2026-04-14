import type { GhostTier, Recommendation } from '../types.ts';

/**
 * Map ghost tier to actionable recommendation (per D-12).
 *
 * - definite-ghost -> archive (safe to remove)
 * - likely-ghost -> monitor (watch for continued non-use)
 * - used -> keep (actively invoked)
 */
export function classifyRecommendation(tier: GhostTier): Recommendation {
  switch (tier) {
    case 'definite-ghost':
      return 'archive';
    case 'likely-ghost':
      return 'monitor';
    case 'used':
      return 'keep';
    case 'dormant':
      // Hooks are advisory by default (not aggregated into grand total unless --include-hooks).
      // 'monitor' is the correct recommendation: hooks cannot be safely "archived" via the
      // bust pipeline because they live in claude config JSON, not as standalone files.
      return 'monitor';
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('classifyRecommendation', () => {
    it('maps definite-ghost to archive', () => {
      expect(classifyRecommendation('definite-ghost')).toBe('archive');
    });

    it('maps likely-ghost to monitor', () => {
      expect(classifyRecommendation('likely-ghost')).toBe('monitor');
    });

    it('maps used to keep', () => {
      expect(classifyRecommendation('used')).toBe('keep');
    });

    it('maps dormant to monitor', () => {
      expect(classifyRecommendation('dormant')).toBe('monitor');
    });
  });
}
