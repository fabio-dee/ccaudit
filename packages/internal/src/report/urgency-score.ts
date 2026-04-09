import type { ConfidenceTier } from '../types.ts';

/**
 * Calculate a per-item urgency score (0–100) and pre-computed daysSinceLastUse.
 *
 * Designed for LLM autonomous decision-making: higher score = more urgent to bust.
 *
 * Algorithm:
 *   urgencyScore = Math.round(
 *     recencySignal   * 0.70 +
 *     tokenSignal     * 0.20 +
 *     confidenceBoost * 0.10
 *   )
 *
 * recencySignal:
 *   Math.min(daysSinceLastUse ?? 90, 90) / 90 * 100
 *   Saturates at 90 days (never-used items score 100 on this axis).
 *
 * tokenSignal:
 *   Math.min(tokens ?? 0, 5000) / 5000 * 100
 *   Saturates at 5 000 tokens.
 *
 * confidenceBoost:
 *   measured           → 100
 *   community-reported → 66
 *   estimated          → 33
 *
 * daysSinceLastUse:
 *   Math.floor((now - lastUsed.getTime()) / 86_400_000), or null if lastUsed is null.
 *
 * @param lastUsed      Last invocation date, or null if never invoked.
 * @param tokenEstimate Token estimate object, or null if not available.
 * @param now           Unix timestamp in ms (defaults to Date.now() — injectable for tests).
 */
export function calculateUrgencyScore(
  lastUsed: Date | null,
  tokenEstimate: { tokens: number; confidence: ConfidenceTier } | null,
  now: number = Date.now(),
): { urgencyScore: number; daysSinceLastUse: number | null } {
  const daysSinceLastUse =
    lastUsed !== null ? Math.floor((now - lastUsed.getTime()) / 86_400_000) : null;

  const recencySignal = (Math.min(daysSinceLastUse ?? 90, 90) / 90) * 100;
  const tokenSignal = (Math.min(tokenEstimate?.tokens ?? 0, 5000) / 5000) * 100;

  let confidenceBoost: number;
  if (tokenEstimate?.confidence === 'measured') {
    confidenceBoost = 100;
  } else if (tokenEstimate?.confidence === 'community-reported') {
    confidenceBoost = 66;
  } else {
    confidenceBoost = 33;
  }

  const urgencyScore = Math.round(recencySignal * 0.7 + tokenSignal * 0.2 + confidenceBoost * 0.1);

  return { urgencyScore, daysSinceLastUse };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Fixed reference timestamp: 2026-04-07T00:00:00Z (today per project context) */
  const NOW = new Date('2026-04-07T00:00:00Z').getTime();

  /** Build a date that is exactly `days` days before NOW. */
  function daysAgo(days: number): Date {
    return new Date(NOW - days * 86_400_000);
  }

  describe('calculateUrgencyScore', () => {
    it('lastUsed=null + estimated + 5000 tokens → score ≥ 82, daysSinceLastUse=null', () => {
      // recencySignal = min(90,90)/90*100 = 100
      // tokenSignal   = min(5000,5000)/5000*100 = 100
      // confidenceBoost = 33 (estimated)
      // score = round(100*0.70 + 100*0.20 + 33*0.10) = round(70 + 20 + 3.3) = round(93.3) = 93
      const result = calculateUrgencyScore(null, { tokens: 5000, confidence: 'estimated' }, NOW);
      expect(result.daysSinceLastUse).toBeNull();
      expect(result.urgencyScore).toBeGreaterThanOrEqual(82);
      expect(result.urgencyScore).toBe(93);
    });

    it('lastUsed=35 days ago + measured + 5000 tokens → daysSinceLastUse=35', () => {
      // recencySignal = min(35,90)/90*100 = 38.888...
      // tokenSignal   = 100
      // confidenceBoost = 100 (measured)
      // score = round(38.888*0.70 + 100*0.20 + 100*0.10) = round(27.22 + 20 + 10) = round(57.22) = 57
      const result = calculateUrgencyScore(
        daysAgo(35),
        { tokens: 5000, confidence: 'measured' },
        NOW,
      );
      expect(result.daysSinceLastUse).toBe(35);
      expect(result.urgencyScore).toBe(57);
    });

    it('lastUsed=today (0 days) + estimated + 0 tokens → score ≤ 5, daysSinceLastUse=0', () => {
      // recencySignal = 0/90*100 = 0
      // tokenSignal   = 0
      // confidenceBoost = 33
      // score = round(0 + 0 + 3.3) = round(3.3) = 3
      const result = calculateUrgencyScore(daysAgo(0), { tokens: 0, confidence: 'estimated' }, NOW);
      expect(result.daysSinceLastUse).toBe(0);
      expect(result.urgencyScore).toBeLessThanOrEqual(5);
      expect(result.urgencyScore).toBe(3);
    });

    it('lastUsed=8 days ago + estimated + 0 tokens → score in 10–25 range', () => {
      // recencySignal = min(8,90)/90*100 = 8.888...
      // tokenSignal   = 0
      // confidenceBoost = 33
      // score = round(8.888*0.70 + 0 + 33*0.10) = round(6.222 + 3.3) = round(9.522) = 10
      const result = calculateUrgencyScore(daysAgo(8), { tokens: 0, confidence: 'estimated' }, NOW);
      expect(result.daysSinceLastUse).toBe(8);
      expect(result.urgencyScore).toBeGreaterThanOrEqual(10);
      expect(result.urgencyScore).toBeLessThanOrEqual(25);
      expect(result.urgencyScore).toBe(10);
    });

    it('null tokenEstimate falls back to estimated/0 tokens (confidenceBoost=33)', () => {
      // score = round(100*0.70 + 0*0.20 + 33*0.10) = round(70 + 0 + 3.3) = round(73.3) = 73
      const result = calculateUrgencyScore(null, null, NOW);
      expect(result.daysSinceLastUse).toBeNull();
      expect(result.urgencyScore).toBe(73);
    });

    it('community-reported confidence → confidenceBoost=66', () => {
      // lastUsed=null, tokens=0, community-reported
      // score = round(100*0.70 + 0*0.20 + 66*0.10) = round(70 + 0 + 6.6) = round(76.6) = 77
      const result = calculateUrgencyScore(
        null,
        { tokens: 0, confidence: 'community-reported' },
        NOW,
      );
      expect(result.urgencyScore).toBe(77);
    });
  });
}
