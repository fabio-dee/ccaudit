import type { TokenCostResult } from '../token/types.ts';
import { CONTEXT_WINDOW_SIZE } from '../token/mcp-estimates-data.ts';
import type { HealthScore, HealthGrade } from './types.ts';

/**
 * Calculate a health score (0-100) for the ghost inventory.
 *
 * Algorithm:
 *   score = 100 - ghostPenalty - tokenPenalty
 *
 * ghostPenalty:
 *   - Each definite-ghost: 3 points (capped at 60)
 *   - Each likely-ghost: 1 point (capped at 20)
 *
 * tokenPenalty:
 *   - (ghostTokens / contextWindow) * 100, capped at 20
 *   - Only counts tokens on ghost items (not 'used')
 *
 * Score bounds: min 0, max 100
 * Grades: Healthy >= 80, Fair >= 50, Poor >= 20, Critical < 20
 */
export function calculateHealthScore(results: TokenCostResult[]): HealthScore {
  const definiteGhosts = results.filter((r) => r.tier === 'definite-ghost').length;
  const likelyGhosts = results.filter((r) => r.tier === 'likely-ghost').length;

  const ghostPenalty = Math.min(definiteGhosts * 3, 60) + Math.min(likelyGhosts * 1, 20);

  const ghostTokens = results
    .filter((r) => r.tier !== 'used')
    .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
  const tokenPenalty = Math.min(Math.round((ghostTokens / CONTEXT_WINDOW_SIZE) * 100), 20);

  const score = Math.max(0, 100 - ghostPenalty - tokenPenalty);

  let grade: HealthGrade;
  if (score >= 80) grade = 'Healthy';
  else if (score >= 50) grade = 'Fair';
  else if (score >= 20) grade = 'Poor';
  else grade = 'Critical';

  return { score, grade, ghostPenalty, tokenPenalty };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Helper: build a minimal TokenCostResult for testing. */
  function makeResult(
    tier: 'used' | 'likely-ghost' | 'definite-ghost',
    tokens: number | null = null,
  ): TokenCostResult {
    return {
      item: {
        name: `test-${tier}`,
        path: '/test/path',
        scope: 'global',
        category: 'agent',
        projectPath: null,
      },
      tier,
      lastUsed: tier === 'used' ? new Date() : null,
      invocationCount: tier === 'used' ? 1 : 0,
      tokenEstimate: tokens !== null ? { tokens, confidence: 'estimated', source: 'test' } : null,
    };
  }

  describe('calculateHealthScore', () => {
    it('returns 100/Healthy for empty input', () => {
      const result = calculateHealthScore([]);
      expect(result).toEqual({
        score: 100,
        grade: 'Healthy',
        ghostPenalty: 0,
        tokenPenalty: 0,
      });
    });

    it('returns score 85/Healthy for 5 definite-ghosts with 0 tokens', () => {
      const results = Array.from({ length: 5 }, () => makeResult('definite-ghost', 0));
      const result = calculateHealthScore(results);
      expect(result.score).toBe(85);
      expect(result.grade).toBe('Healthy');
      expect(result.ghostPenalty).toBe(15);
      expect(result.tokenPenalty).toBe(0);
    });

    it('caps definite-ghost penalty at 60 (20 definite-ghosts -> score 40/Poor)', () => {
      const results = Array.from({ length: 20 }, () => makeResult('definite-ghost', 0));
      const result = calculateHealthScore(results);
      expect(result.score).toBe(40);
      expect(result.grade).toBe('Poor');
      expect(result.ghostPenalty).toBe(60);
    });

    it('caps likely-ghost penalty at 20 (20 likely-ghosts -> score 80/Healthy)', () => {
      const results = Array.from({ length: 20 }, () => makeResult('likely-ghost', 0));
      const result = calculateHealthScore(results);
      expect(result.score).toBe(80);
      expect(result.grade).toBe('Healthy');
      expect(result.ghostPenalty).toBe(20);
    });

    it('ignores tokens on used items (100k tokens on used -> score 100)', () => {
      const results = [makeResult('used', 100_000)];
      const result = calculateHealthScore(results);
      expect(result.score).toBe(100);
      expect(result.grade).toBe('Healthy');
      expect(result.tokenPenalty).toBe(0);
    });

    it('applies token penalty from ghost items (1 definite-ghost with 40k tokens -> 77/Fair)', () => {
      // ghostPenalty = min(1*3, 60) = 3
      // tokenPenalty = min(round(40000/200000*100), 20) = min(20, 20) = 20
      // score = 100 - 3 - 20 = 77
      const results = [makeResult('definite-ghost', 40_000)];
      const result = calculateHealthScore(results);
      expect(result.score).toBe(77);
      expect(result.grade).toBe('Fair');
      expect(result.ghostPenalty).toBe(3);
      expect(result.tokenPenalty).toBe(20);
    });

    it('clamps score at 0 for extreme ghost load (30 definite + 30 likely + 50k tokens)', () => {
      const definite = Array.from({ length: 30 }, () => makeResult('definite-ghost', 0));
      const likely = Array.from({ length: 30 }, () => makeResult('likely-ghost', 0));
      // Add 50k tokens on one ghost item
      const tokenGhost = makeResult('definite-ghost', 50_000);
      const results = [...definite, ...likely, tokenGhost];
      // ghostPenalty = min(31*3, 60) + min(30*1, 20) = 60 + 20 = 80
      // tokenPenalty = min(round(50000/200000*100), 20) = min(25, 20) = 20
      // score = max(0, 100 - 80 - 20) = 0
      const result = calculateHealthScore(results);
      expect(result.score).toBe(0);
      expect(result.grade).toBe('Critical');
    });

    it('assigns correct grades at boundary values', () => {
      // Score 80 -> Healthy
      // 16 likely-ghosts + 0 definite-ghosts = ghostPenalty 16, tokenPenalty 0 -> score 84
      // But let's test more precisely...

      // Score exactly 80: need ghostPenalty=20, tokenPenalty=0
      // 20 likely-ghosts -> ghostPenalty = min(20, 20) = 20 -> score 80 = Healthy
      const at80 = Array.from({ length: 20 }, () => makeResult('likely-ghost', 0));
      expect(calculateHealthScore(at80).grade).toBe('Healthy');

      // Score 79: need ghostPenalty=21
      // 1 definite (3) + 18 likely (18) = 21 -> score 79 = Fair
      const at79 = [
        makeResult('definite-ghost', 0),
        ...Array.from({ length: 18 }, () => makeResult('likely-ghost', 0)),
      ];
      expect(calculateHealthScore(at79).grade).toBe('Fair');

      // Score 50: need ghostPenalty=50
      // 10 definite (30) + 20 likely (20) = 50 -> score 50 = Fair
      const at50 = [
        ...Array.from({ length: 10 }, () => makeResult('definite-ghost', 0)),
        ...Array.from({ length: 20 }, () => makeResult('likely-ghost', 0)),
      ];
      expect(calculateHealthScore(at50).grade).toBe('Fair');

      // Score 49: need ghostPenalty=51
      // 11 definite (33) + 18 likely (18) = 51 -> score 49 = Poor
      const at49 = [
        ...Array.from({ length: 11 }, () => makeResult('definite-ghost', 0)),
        ...Array.from({ length: 18 }, () => makeResult('likely-ghost', 0)),
      ];
      expect(calculateHealthScore(at49).grade).toBe('Poor');

      // Score 20: need ghostPenalty=80 but caps at 60+20=80 -> score 20 = Poor
      const at20 = [
        ...Array.from({ length: 20 }, () => makeResult('definite-ghost', 0)),
        ...Array.from({ length: 20 }, () => makeResult('likely-ghost', 0)),
      ];
      expect(calculateHealthScore(at20).grade).toBe('Poor');

      // Score 19: need penalty 81 + some token
      // 20 definite (60) + 20 likely (20) + 2000 tokens -> tokenPenalty = min(round(2000/200000*100), 20) = 1
      // score = max(0, 100 - 80 - 1) = 19 = Critical
      const at19 = [
        ...Array.from({ length: 20 }, () => makeResult('definite-ghost', 0)),
        ...Array.from({ length: 20 }, () => makeResult('likely-ghost', 0)),
        makeResult('definite-ghost', 2000),
      ];
      const r19 = calculateHealthScore(at19);
      expect(r19.score).toBe(19);
      expect(r19.grade).toBe('Critical');
    });
  });
}
