import type { ChangePlan } from './change-plan.ts';

/**
 * Calculate estimated token savings from executing the change plan (D-08).
 *
 * Formula: sum of tokens across archive + disable items.
 * Memory files (flag tier) are EXCLUDED because they are flagged, not moved --
 * they still load, so no tokens are reclaimed on the next session.
 *
 * This is distinct from calculateTotalOverhead(ghosts) which sums all ghost
 * token cost including monitor-tier (likely-ghost) items. The dry-run savings
 * is honest: it is exactly what --dangerously-bust-ghosts will reclaim.
 */
export function calculateDryRunSavings(plan: ChangePlan): number {
  let total = 0;
  for (const item of plan.archive) total += item.tokens;
  for (const item of plan.disable) total += item.tokens;
  // Intentionally skip plan.flag -- memory files still load.
  return total;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Minimal ChangePlan factory for tests
  function makePlan(parts: Partial<ChangePlan> = {}): ChangePlan {
    return {
      archive: [],
      disable: [],
      flag: [],
      counts: { agents: 0, skills: 0, mcp: 0, memory: 0 },
      savings: { tokens: 0 },
      ...parts,
    };
  }

  describe('calculateDryRunSavings', () => {
    it('sums archive tokens', () => {
      const plan = makePlan({
        archive: [
          { action: 'archive', category: 'agent', scope: 'global', name: 'a', projectPath: null, path: '/a', tokens: 100, tier: 'definite-ghost' },
          { action: 'archive', category: 'skill', scope: 'global', name: 'b', projectPath: null, path: '/b', tokens: 250, tier: 'definite-ghost' },
        ],
      });
      expect(calculateDryRunSavings(plan)).toBe(350);
    });

    it('sums disable tokens', () => {
      const plan = makePlan({
        disable: [
          { action: 'disable', category: 'mcp-server', scope: 'global', name: 'x', projectPath: null, path: '/~/.claude.json', tokens: 2800, tier: 'definite-ghost' },
          { action: 'disable', category: 'mcp-server', scope: 'global', name: 'y', projectPath: null, path: '/~/.claude.json', tokens: 1200, tier: 'likely-ghost' },
        ],
      });
      expect(calculateDryRunSavings(plan)).toBe(4000);
    });

    it('EXCLUDES flag tokens (memory files still load)', () => {
      const plan = makePlan({
        flag: [
          { action: 'flag', category: 'memory', scope: 'global', name: 'CLAUDE.md', projectPath: null, path: '/CLAUDE.md', tokens: 5000, tier: 'definite-ghost' },
        ],
      });
      expect(calculateDryRunSavings(plan)).toBe(0);
    });

    it('sums archive+disable, ignores flag', () => {
      const plan = makePlan({
        archive: [{ action: 'archive', category: 'agent', scope: 'global', name: 'a', projectPath: null, path: '/a', tokens: 1000, tier: 'definite-ghost' }],
        disable: [{ action: 'disable', category: 'mcp-server', scope: 'global', name: 'b', projectPath: null, path: '/b', tokens: 2000, tier: 'definite-ghost' }],
        flag: [{ action: 'flag', category: 'memory', scope: 'global', name: 'c', projectPath: null, path: '/c', tokens: 9999, tier: 'definite-ghost' }],
      });
      expect(calculateDryRunSavings(plan)).toBe(3000);
    });

    it('returns 0 for empty plan', () => {
      expect(calculateDryRunSavings(makePlan())).toBe(0);
    });
  });
}
