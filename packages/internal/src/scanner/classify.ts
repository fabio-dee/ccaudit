import type { GhostTier } from '../types.ts';

/** 7 days in milliseconds -- boundary between 'used' and 'likely-ghost' */
export const LIKELY_GHOST_MS = 7 * 86_400_000;

/** 30 days in milliseconds -- boundary between 'likely-ghost' and 'definite-ghost' */
export const DEFINITE_GHOST_MS = 30 * 86_400_000;

/**
 * Classify an inventory item's ghost tier based on its last invocation time.
 *
 * @param lastUsedMs - Timestamp of last invocation in ms since epoch, or null if never invoked
 * @param now - Current time in ms since epoch (default: Date.now())
 * @returns Ghost classification tier
 *
 * Classification rules:
 * - null (never invoked) -> 'definite-ghost'
 * - elapsed <= 7 days -> 'used'
 * - elapsed <= 30 days -> 'likely-ghost'
 * - elapsed > 30 days -> 'definite-ghost'
 */
export function classifyGhost(lastUsedMs: number | null, now: number = Date.now()): GhostTier {
  if (lastUsedMs === null) return 'definite-ghost';
  const elapsed = now - lastUsedMs;
  if (elapsed <= LIKELY_GHOST_MS) return 'used';
  if (elapsed <= DEFINITE_GHOST_MS) return 'likely-ghost';
  return 'definite-ghost';
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('classifyGhost', () => {
    // Use a fixed "now" for deterministic tests
    const NOW = 1_712_000_000_000; // arbitrary fixed timestamp

    it('returns "definite-ghost" when lastUsedMs is null (never invoked)', () => {
      expect(classifyGhost(null, NOW)).toBe('definite-ghost');
    });

    it('returns "used" for 3 days ago', () => {
      const threeAgo = NOW - 3 * 86_400_000;
      expect(classifyGhost(threeAgo, NOW)).toBe('used');
    });

    it('returns "used" at exactly 7 days (boundary -- still used)', () => {
      const sevenExact = NOW - 7 * 86_400_000;
      expect(classifyGhost(sevenExact, NOW)).toBe('used');
    });

    it('returns "likely-ghost" at 7 days + 1ms (just past boundary)', () => {
      const justPastSeven = NOW - 7 * 86_400_000 - 1;
      expect(classifyGhost(justPastSeven, NOW)).toBe('likely-ghost');
    });

    it('returns "likely-ghost" for 20 days ago', () => {
      const twentyAgo = NOW - 20 * 86_400_000;
      expect(classifyGhost(twentyAgo, NOW)).toBe('likely-ghost');
    });

    it('returns "likely-ghost" at exactly 30 days (boundary -- still likely)', () => {
      const thirtyExact = NOW - 30 * 86_400_000;
      expect(classifyGhost(thirtyExact, NOW)).toBe('likely-ghost');
    });

    it('returns "definite-ghost" at 30 days + 1ms (just past boundary)', () => {
      const justPastThirty = NOW - 30 * 86_400_000 - 1;
      expect(classifyGhost(justPastThirty, NOW)).toBe('definite-ghost');
    });

    it('returns "definite-ghost" for 1 year ago', () => {
      const yearAgo = NOW - 365 * 86_400_000;
      expect(classifyGhost(yearAgo, NOW)).toBe('definite-ghost');
    });
  });

  describe('constants', () => {
    it('LIKELY_GHOST_MS is 7 days in milliseconds', () => {
      expect(LIKELY_GHOST_MS).toBe(604_800_000);
    });

    it('DEFINITE_GHOST_MS is 30 days in milliseconds', () => {
      expect(DEFINITE_GHOST_MS).toBe(2_592_000_000);
    });
  });
}
