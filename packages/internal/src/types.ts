/**
 * Scope of a ghost item -- global (~/.claude/) or project-local (.claude/).
 */
export type ItemScope = 'global' | 'project';

/**
 * Ghost classification tier.
 * - 'used': invoked within the time window
 * - 'likely-ghost': 7-30 days since last invocation
 * - 'definite-ghost': >30 days or never invoked
 */
export type GhostTier = 'used' | 'likely-ghost' | 'definite-ghost';

/**
 * Category of auditable inventory item.
 */
export type ItemCategory = 'agent' | 'skill' | 'mcp-server' | 'memory';

/**
 * Confidence tier for token cost estimates (TOKN-03).
 */
export type ConfidenceTier = 'estimated' | 'measured' | 'community-reported';

/**
 * Recommendation action for a ghost item (REPT-06).
 */
export type Recommendation = 'archive' | 'monitor' | 'keep';

/**
 * Core ghost item -- the unit of analysis across all categories.
 */
export interface GhostItem {
  /** Display name of the item */
  name: string;
  /** Absolute filesystem path */
  path: string;
  /** Global (~/.claude/) or project-local (.claude/) */
  scope: ItemScope;
  /** Category: agent, skill, mcp-server, memory */
  category: ItemCategory;
  /** Ghost classification based on invocation recency */
  tier: GhostTier;
  /** Last invocation date, or null if never invoked */
  lastUsed: Date | null;
}

/**
 * Dual-path resolution for XDG and legacy Claude paths (DIST-03).
 * Used by the session discoverer and inventory scanner.
 */
export interface ClaudePaths {
  /** XDG path: ~/.config/claude/ */
  xdg: string;
  /** Legacy path: ~/.claude/ */
  legacy: string;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('GhostItem', () => {
    it('should accept a valid ghost item', () => {
      const item: GhostItem = {
        name: 'test-agent',
        path: '/home/user/.claude/agents/test.md',
        scope: 'global',
        category: 'agent',
        tier: 'definite-ghost',
        lastUsed: null,
      };
      expect(item.tier).toBe('definite-ghost');
      expect(item.lastUsed).toBeNull();
    });

    it('should accept a used item with lastUsed date', () => {
      const item: GhostItem = {
        name: 'active-skill',
        path: '/home/user/.claude/skills/active/SKILL.md',
        scope: 'global',
        category: 'skill',
        tier: 'used',
        lastUsed: new Date('2026-04-01T00:00:00Z'),
      };
      expect(item.tier).toBe('used');
      expect(item.lastUsed).toBeInstanceOf(Date);
    });
  });

  describe('ClaudePaths', () => {
    it('should hold dual XDG and legacy paths', () => {
      const paths: ClaudePaths = {
        xdg: '/home/user/.config/claude',
        legacy: '/home/user/.claude',
      };
      expect(paths.xdg).toContain('.config/claude');
      expect(paths.legacy).toContain('.claude');
    });
  });
}
