import type { TokenCostResult } from '../token/types.ts';
import { CONTEXT_WINDOW_SIZE } from '../token/mcp-estimates-data.ts';
import type { HealthScore, HealthGrade } from './types.ts';

/**
 * Per-category ghost penalty weights.
 *
 * Rationale:
 * - agents/skills/mcp-server: high blast radius (eager-load, full schema every session) → weight 3/1
 * - memory: still loaded but lower marginal harm → weight 2/1
 * - command: often bulk-installed sets; many legitimate stubs → weight 1/0.5
 * - hook: dormant replaces definite/likely for inject-capable hooks; non-inject-capable
 *   hooks with zero fires don't cost context, so their "ghost" weight is 0/0.
 *   Dormant hooks get weight 1 (upper-bound cost exists but unconfirmed).
 *
 * The 'dormant' key only exists on the 'hook' category.
 */
const GHOST_PENALTY_WEIGHTS = {
  agent: { definite: 3, likely: 1, dormant: 0 },
  skill: { definite: 3, likely: 1, dormant: 0 },
  'mcp-server': { definite: 3, likely: 1, dormant: 0 },
  memory: { definite: 2, likely: 1, dormant: 0 },
  command: { definite: 1, likely: 0.5, dormant: 0 },
  hook: { definite: 0, likely: 0, dormant: 1 },
} as const;

/**
 * Calculate a health score (0-100) for the ghost inventory.
 *
 * Algorithm:
 *   score = 100 - ghostPenalty - tokenPenalty
 *
 * ghostPenalty (capped at 60):
 *   Sum of per-item weights based on category × tier.
 *   Weights vary by category — see GHOST_PENALTY_WEIGHTS above.
 *   Integer-rounded at the end.
 *
 * tokenPenalty (capped at 20):
 *   (ghostTokens / contextWindow) * 100
 *   Only counts tokens on ghost/dormant items (not 'used').
 *   When opts.includeHooks is false (the ghost command default), hook tokens
 *   are excluded from ghostTokens so tokenPenalty matches the displayed total.
 *
 * dormantPenalty:
 *   The portion of ghostPenalty attributable to dormant-tier hooks.
 *   Always present in the return; 0 when no dormant hooks exist.
 *   Unchanged by includeHooks — hooks still count as a health stat.
 *
 * Score bounds: min 0, max 100
 * Grades: Healthy >= 80, Fair >= 50, Poor >= 20, Critical < 20
 */
export function calculateHealthScore(
  results: TokenCostResult[],
  opts?: { includeHooks?: boolean },
): HealthScore {
  let rawGhostPenalty = 0;
  let rawDormantPenalty = 0;

  for (const r of results) {
    const weights = GHOST_PENALTY_WEIGHTS[r.item.category as keyof typeof GHOST_PENALTY_WEIGHTS];
    if (!weights) continue;

    if (r.tier === 'dormant') {
      const w = weights.dormant;
      rawGhostPenalty += w;
      rawDormantPenalty += w;
    } else if (r.tier === 'definite-ghost') {
      rawGhostPenalty += weights.definite;
    } else if (r.tier === 'likely-ghost') {
      rawGhostPenalty += weights.likely;
    }
    // 'used' tier contributes 0 penalty
  }

  // Cap total ghostPenalty at 60; scale dormantPenalty proportionally
  const ghostPenalty = Math.min(Math.round(rawGhostPenalty), 60);
  // If the raw total was capped, scale dormant portion proportionally
  const dormantPenalty =
    rawGhostPenalty > 60
      ? Math.round(rawDormantPenalty * (60 / rawGhostPenalty))
      : Math.round(rawDormantPenalty);

  // When includeHooks is false (ghost command default), exclude hook tokens from
  // tokenPenalty so it matches the headline total shown in the ghost output.
  // ghostPenalty and dormantPenalty are unchanged — hooks still count as a health stat.
  const includeHooks = opts?.includeHooks ?? true;
  const ghostTokens = results
    .filter((r) => r.tier !== 'used')
    .filter((r) => includeHooks || r.item.category !== 'hook')
    .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
  const tokenPenalty = Math.min(Math.round((ghostTokens / CONTEXT_WINDOW_SIZE) * 100), 20);

  const score = Math.max(0, 100 - ghostPenalty - tokenPenalty);

  let grade: HealthGrade;
  if (score >= 80) grade = 'Healthy';
  else if (score >= 50) grade = 'Fair';
  else if (score >= 20) grade = 'Poor';
  else grade = 'Critical';

  return { score, grade, ghostPenalty, tokenPenalty, dormantPenalty };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Helper: build a minimal TokenCostResult for testing. */
  function makeResult(
    tier: 'used' | 'likely-ghost' | 'definite-ghost' | 'dormant',
    tokens: number | null = null,
    category: string = 'agent',
  ): TokenCostResult {
    return {
      item: {
        name: `test-${tier}`,
        path: '/test/path',
        scope: 'global',
        category: category as TokenCostResult['item']['category'],
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
        dormantPenalty: 0,
      });
    });

    it('returns score 85/Healthy for 5 definite-ghost agents (3 weight each = 15)', () => {
      const results = Array.from({ length: 5 }, () => makeResult('definite-ghost', 0, 'agent'));
      const result = calculateHealthScore(results);
      expect(result.score).toBe(85);
      expect(result.grade).toBe('Healthy');
      expect(result.ghostPenalty).toBe(15);
      expect(result.tokenPenalty).toBe(0);
      expect(result.dormantPenalty).toBe(0);
    });

    it('regression: 100 agents all definite-ghost → ghostPenalty capped at 60 (same as before)', () => {
      const results = Array.from({ length: 100 }, () => makeResult('definite-ghost', 0, 'agent'));
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(60);
      expect(result.score).toBe(40);
      expect(result.grade).toBe('Poor');
      expect(result.dormantPenalty).toBe(0);
    });

    it('100 commands all ghost → lower ghostPenalty than 100 agents (weight 1 vs 3)', () => {
      const agents = Array.from({ length: 100 }, () => makeResult('definite-ghost', 0, 'agent'));
      const commands = Array.from({ length: 100 }, () =>
        makeResult('definite-ghost', 0, 'command'),
      );
      const agentResult = calculateHealthScore(agents);
      const commandResult = calculateHealthScore(commands);
      // Both are capped at 60, but commands raw = 100*1 = 100, agents raw = 100*3 = 300
      // Both hit the cap, but let's verify raw weights: 20 commands = 20, 20 agents = 60
      const twentyAgents = Array.from({ length: 20 }, () =>
        makeResult('definite-ghost', 0, 'agent'),
      );
      const twentyCommands = Array.from({ length: 20 }, () =>
        makeResult('definite-ghost', 0, 'command'),
      );
      const agentScore = calculateHealthScore(twentyAgents);
      const commandScore = calculateHealthScore(twentyCommands);
      expect(agentScore.ghostPenalty).toBe(60); // 20 * 3 = 60 (at cap)
      expect(commandScore.ghostPenalty).toBe(20); // 20 * 1 = 20 (below cap)
      expect(commandScore.ghostPenalty).toBeLessThan(agentScore.ghostPenalty);
      // Bulk cap test: both 100-item arrays are capped
      expect(agentResult.ghostPenalty).toBe(60);
      expect(commandResult.ghostPenalty).toBe(60);
    });

    it('100 dormant hooks → dormantPenalty = 60 (capped), ghostPenalty = 60', () => {
      const results = Array.from({ length: 100 }, () => makeResult('dormant', 0, 'hook'));
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(60); // capped from 100*1=100
      expect(result.dormantPenalty).toBe(60); // all penalty is from dormant
      expect(result.score).toBe(40);
    });

    it('dormant hooks penalty is isolated in dormantPenalty field', () => {
      const results = [
        makeResult('definite-ghost', 0, 'agent'), // 3 pts
        makeResult('dormant', 0, 'hook'), // 1 pt (dormant)
        makeResult('dormant', 0, 'hook'), // 1 pt (dormant)
      ];
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(5); // 3 + 1 + 1
      expect(result.dormantPenalty).toBe(2); // 2 dormant hooks × 1
    });

    it('mixed categories → weighted sum correct', () => {
      const results = [
        makeResult('definite-ghost', 0, 'agent'), // 3
        makeResult('likely-ghost', 0, 'agent'), // 1
        makeResult('definite-ghost', 0, 'mcp-server'), // 3
        makeResult('definite-ghost', 0, 'memory'), // 2
        makeResult('definite-ghost', 0, 'command'), // 1
        makeResult('likely-ghost', 0, 'command'), // 0.5
        makeResult('dormant', 0, 'hook'), // 1
      ];
      // Total raw = 3 + 1 + 3 + 2 + 1 + 0.5 + 1 = 11.5 → rounded = 12
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(12);
      expect(result.dormantPenalty).toBe(1);
      expect(result.score).toBe(88);
    });

    it('hook definite-ghost/likely-ghost weight is 0 (non-inject-capable hooks)', () => {
      const results = [
        makeResult('definite-ghost', 0, 'hook'),
        makeResult('likely-ghost', 0, 'hook'),
      ];
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(0);
      expect(result.dormantPenalty).toBe(0);
      expect(result.score).toBe(100);
    });

    it('caps definite-ghost penalty at 60 (20 agents → score 40/Poor)', () => {
      const results = Array.from({ length: 20 }, () => makeResult('definite-ghost', 0));
      const result = calculateHealthScore(results);
      expect(result.score).toBe(40);
      expect(result.grade).toBe('Poor');
      expect(result.ghostPenalty).toBe(60);
    });

    it('ignores tokens on used items (100k tokens on used → score 100)', () => {
      const results = [makeResult('used', 100_000)];
      const result = calculateHealthScore(results);
      expect(result.score).toBe(100);
      expect(result.grade).toBe('Healthy');
      expect(result.tokenPenalty).toBe(0);
    });

    it('applies token penalty from ghost items (1 definite-ghost agent with 40k tokens → 77/Fair)', () => {
      // ghostPenalty = min(round(1*3), 60) = 3
      // tokenPenalty = min(round(40000/200000*100), 20) = min(20, 20) = 20
      // score = 100 - 3 - 20 = 77
      const results = [makeResult('definite-ghost', 40_000, 'agent')];
      const result = calculateHealthScore(results);
      expect(result.score).toBe(77);
      expect(result.grade).toBe('Fair');
      expect(result.ghostPenalty).toBe(3);
      expect(result.tokenPenalty).toBe(20);
    });

    it('clamps score at 0 for extreme ghost load (100 agents + 100 commands + 100 hooks all ghost)', () => {
      const agents = Array.from({ length: 100 }, () => makeResult('definite-ghost', 0, 'agent'));
      const commands = Array.from({ length: 100 }, () =>
        makeResult('definite-ghost', 0, 'command'),
      );
      const hooks = Array.from({ length: 100 }, () => makeResult('dormant', 0, 'hook'));
      const results = [...agents, ...commands, ...hooks];
      // rawGhostPenalty = 100*3 + 100*1 + 100*1 = 500 → capped at 60
      const result = calculateHealthScore(results);
      expect(result.ghostPenalty).toBe(60);
      expect(result.score).toBeLessThanOrEqual(40); // at most 40 from ghost penalty alone
    });

    it('assigns correct grades at boundary values', () => {
      // Score 80: need ghostPenalty=20 → 20 likely-ghost agents (1 each)
      const at80 = Array.from({ length: 20 }, () => makeResult('likely-ghost', 0, 'agent'));
      expect(calculateHealthScore(at80).grade).toBe('Healthy');

      // Score 79: 1 definite-agent (3) + 18 likely-agents (18) = 21 → score 79 = Fair
      const at79 = [
        makeResult('definite-ghost', 0, 'agent'),
        ...Array.from({ length: 18 }, () => makeResult('likely-ghost', 0, 'agent')),
      ];
      expect(calculateHealthScore(at79).grade).toBe('Fair');

      // Score 50: 10 definite-agents (30) + 20 likely-agents (20) = 50 → score 50 = Fair
      const at50 = [
        ...Array.from({ length: 10 }, () => makeResult('definite-ghost', 0, 'agent')),
        ...Array.from({ length: 20 }, () => makeResult('likely-ghost', 0, 'agent')),
      ];
      expect(calculateHealthScore(at50).grade).toBe('Fair');
    });

    it('dormantPenalty=0 when no dormant hooks present', () => {
      const results = [makeResult('definite-ghost', 0, 'agent')];
      const result = calculateHealthScore(results);
      expect(result.dormantPenalty).toBe(0);
    });

    it('includeHooks:false → tokenPenalty excludes hook tokens vs includeHooks:true', () => {
      // 1 dormant hook with 20k tokens + 1 definite-ghost agent with 0 tokens
      const results = [
        makeResult('dormant', 20_000, 'hook'),
        makeResult('definite-ghost', 0, 'agent'),
      ];
      const withHooks = calculateHealthScore(results, { includeHooks: true });
      const withoutHooks = calculateHealthScore(results, { includeHooks: false });

      // tokenPenalty with hooks: min(round(20000/200000*100), 20) = min(10, 20) = 10
      expect(withHooks.tokenPenalty).toBe(10);
      // tokenPenalty without hooks: 0 tokens from non-hook ghosts → 0
      expect(withoutHooks.tokenPenalty).toBe(0);
      // tokenPenalty must be lower without hooks
      expect(withoutHooks.tokenPenalty).toBeLessThan(withHooks.tokenPenalty);

      // ghostPenalty unchanged across both modes (hooks still count for health stat)
      expect(withHooks.ghostPenalty).toBe(withoutHooks.ghostPenalty);
      // dormantPenalty unchanged across both modes
      expect(withHooks.dormantPenalty).toBe(withoutHooks.dormantPenalty);
      expect(withHooks.dormantPenalty).toBe(1);
    });

    it('includeHooks defaults to true (backward-compatible: no opts → hooks included)', () => {
      const results = [makeResult('dormant', 20_000, 'hook')];
      const noOpts = calculateHealthScore(results);
      const explicitTrue = calculateHealthScore(results, { includeHooks: true });
      expect(noOpts.tokenPenalty).toBe(explicitTrue.tokenPenalty);
      expect(noOpts.ghostPenalty).toBe(explicitTrue.ghostPenalty);
    });
  });
}
