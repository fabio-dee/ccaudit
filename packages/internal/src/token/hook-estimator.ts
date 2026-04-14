import type { ConfidenceTier } from '../types.ts';

/**
 * Maximum tokens a single inject-capable hook output can contribute per fire.
 * Hooks that inject into context (SessionStart, PreToolUse, PostToolUse, etc.)
 * can return up to 2500 tokens of stdout per invocation.
 */
const HOOK_MAX_TOKENS_PER_FIRE = 2500;

/**
 * Estimate token cost for a single hook item.
 *
 * Three cases:
 *
 * 1. Non-inject-capable hook (pure side-effect, e.g. Notification):
 *    → 0 tokens. The hook's output is NOT fed back into model context.
 *
 * 2. Inject-capable hook that fired `fires > 0` times in the window:
 *    → fires * 2500 tokens (measured-style estimate from firing count).
 *    Confidence: 'estimated' (we know it fired, but not the exact output size).
 *
 * 3. Inject-capable hook with fires === 0 (never observed in the window):
 *    → 2500 tokens upper-bound (single worst-case fire).
 *    Confidence: 'upper-bound' (may never actually cost tokens if truly dormant).
 *
 * @param injectCapable - Whether the hook event injects stdout into model context
 * @param fires         - Number of observed firings in the scan window (0 = never seen)
 */
export function estimateHookTokens(
  injectCapable: boolean,
  fires: number,
): { tokens: number; confidence: ConfidenceTier; source: string } {
  if (!injectCapable) {
    return {
      tokens: 0,
      confidence: 'measured',
      source: 'hook config not in model context',
    };
  }

  if (fires > 0) {
    return {
      tokens: fires * HOOK_MAX_TOKENS_PER_FIRE,
      confidence: 'estimated',
      source: `hook output × ${fires} fires (≤${HOOK_MAX_TOKENS_PER_FIRE} tok each)`,
    };
  }

  // fires === 0: inject-capable but never observed → upper-bound
  return {
    tokens: HOOK_MAX_TOKENS_PER_FIRE,
    confidence: 'upper-bound',
    source: 'hook output upper-bound (never observed)',
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('estimateHookTokens', () => {
    it('non-inject-capable → 0 tokens, measured confidence', () => {
      const result = estimateHookTokens(false, 0);
      expect(result.tokens).toBe(0);
      expect(result.confidence).toBe('measured');
      expect(result.source).toContain('not in model context');
    });

    it('non-inject-capable with fires > 0 → still 0 tokens (pure side-effect)', () => {
      const result = estimateHookTokens(false, 5);
      expect(result.tokens).toBe(0);
      expect(result.confidence).toBe('measured');
    });

    it('inject-capable, fires = 0 → 2500 tokens upper-bound', () => {
      const result = estimateHookTokens(true, 0);
      expect(result.tokens).toBe(2500);
      expect(result.confidence).toBe('upper-bound');
      expect(result.source).toContain('upper-bound');
      expect(result.source).toContain('never observed');
    });

    it('inject-capable, fires = 1 → 2500 tokens estimated', () => {
      const result = estimateHookTokens(true, 1);
      expect(result.tokens).toBe(2500);
      expect(result.confidence).toBe('estimated');
      expect(result.source).toContain('1 fires');
    });

    it('inject-capable, fires = 3 → 7500 tokens estimated', () => {
      const result = estimateHookTokens(true, 3);
      expect(result.tokens).toBe(7500);
      expect(result.confidence).toBe('estimated');
      expect(result.source).toContain('3 fires');
    });

    it('inject-capable, fires = 10 → 25000 tokens estimated', () => {
      const result = estimateHookTokens(true, 10);
      expect(result.tokens).toBe(25000);
      expect(result.confidence).toBe('estimated');
      expect(result.source).toContain('10 fires');
    });
  });
}
