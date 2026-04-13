import type { GhostItem } from '../types.ts';
import type { FrameworkStatus } from './types.ts';

/**
 * Computes a framework's aggregate status from its members' ghost tiers.
 *
 * Tier semantics (from packages/internal/src/scanner/classify.ts):
 *   'used'           invoked within 7 days
 *   'likely-ghost'   7-30 days since last invocation
 *   'definite-ghost' >30 days or never
 *
 * Status rules:
 *   'fully-used':     every member has tier === 'used'
 *   'partially-used': at least one 'used' AND at least one non-'used' member
 *   'ghost-all':      zero members are 'used' (all are likely-ghost or definite-ghost)
 *   edge case:        empty member list resolves to 'ghost-all' — there is no
 *                     active member to protect, so downstream bust-protection
 *                     logic (Phase 4) treats it as safe to archive.
 *
 * Pure sync function. No I/O. Linear scan, O(n) over members.
 */
export function computeFrameworkStatus(members: GhostItem[]): FrameworkStatus {
  if (members.length === 0) return 'ghost-all';
  let sawUsed = false;
  let sawGhost = false;
  for (const m of members) {
    if (m.tier === 'used') {
      sawUsed = true;
    } else {
      sawGhost = true;
    }
    if (sawUsed && sawGhost) return 'partially-used';
  }
  if (sawUsed) return 'fully-used';
  return 'ghost-all';
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function makeItem(tier: GhostItem['tier'], name = 'test'): GhostItem {
    return {
      name,
      path: `/home/.claude/agents/${name}.md`,
      scope: 'global',
      category: 'agent',
      tier,
      lastUsed: tier === 'used' ? new Date() : null,
      urgencyScore: tier === 'used' ? 10 : 70,
      daysSinceLastUse: tier === 'used' ? 3 : null,
      framework: 'test-fw',
    };
  }

  describe('computeFrameworkStatus', () => {
    it('returns "fully-used" when every member is used', () => {
      const members = [makeItem('used', 'a'), makeItem('used', 'b')];
      expect(computeFrameworkStatus(members)).toBe('fully-used');
    });

    it('returns "partially-used" when mixed used + definite-ghost', () => {
      const members = [makeItem('used', 'a'), makeItem('definite-ghost', 'b')];
      expect(computeFrameworkStatus(members)).toBe('partially-used');
    });

    it('returns "partially-used" when mixed used + likely-ghost', () => {
      const members = [makeItem('used', 'a'), makeItem('likely-ghost', 'b')];
      expect(computeFrameworkStatus(members)).toBe('partially-used');
    });

    it('returns "ghost-all" when every member is definite-ghost', () => {
      const members = [makeItem('definite-ghost', 'a'), makeItem('definite-ghost', 'b')];
      expect(computeFrameworkStatus(members)).toBe('ghost-all');
    });

    it('returns "ghost-all" when mix of likely-ghost + definite-ghost with zero used', () => {
      const members = [makeItem('likely-ghost', 'a'), makeItem('definite-ghost', 'b')];
      expect(computeFrameworkStatus(members)).toBe('ghost-all');
    });

    it('returns "fully-used" for a single used member', () => {
      expect(computeFrameworkStatus([makeItem('used', 'solo')])).toBe('fully-used');
    });

    it('returns "ghost-all" for a single definite-ghost member', () => {
      expect(computeFrameworkStatus([makeItem('definite-ghost', 'solo')])).toBe('ghost-all');
    });

    it('returns "ghost-all" for an empty members array (edge case)', () => {
      expect(computeFrameworkStatus([])).toBe('ghost-all');
    });
  });
}
