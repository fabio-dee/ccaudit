import type { TokenEstimate } from './token/types.ts';

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
  /** Composite urgency score 0–100 for LLM autonomous decision-making */
  urgencyScore: number;
  /** Days since last use, pre-computed integer (null if never used) */
  daysSinceLastUse: number | null;
  /** Framework group identity. null when explicitly ungrouped; undefined when not annotated. */
  framework?: string | null;
  /**
   * Token cost estimate. Always non-null for agents and MCP servers (unknown MCPs
   * fall back to DEFAULT_UNKNOWN_MCP_TOKENS). May be null for memory / skill
   * items when file-size estimation fails (e.g., unreadable file).
   */
  tokenEstimate?: TokenEstimate | null;
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
        urgencyScore: 73,
        daysSinceLastUse: null,
      };
      expect(item.tier).toBe('definite-ghost');
      expect(item.lastUsed).toBeNull();
      expect(item.urgencyScore).toBe(73);
      expect(item.daysSinceLastUse).toBeNull();
    });

    it('should accept a used item with lastUsed date', () => {
      const item: GhostItem = {
        name: 'active-skill',
        path: '/home/user/.claude/skills/active/SKILL.md',
        scope: 'global',
        category: 'skill',
        tier: 'used',
        lastUsed: new Date('2026-04-01T00:00:00Z'),
        urgencyScore: 3,
        daysSinceLastUse: 6,
      };
      expect(item.tier).toBe('used');
      expect(item.lastUsed).toBeInstanceOf(Date);
      expect(item.urgencyScore).toBe(3);
      expect(item.daysSinceLastUse).toBe(6);
    });

    it('should accept an item with framework field set (D-02 / SCAN-02 prelim)', () => {
      const withFramework: GhostItem = {
        name: 'gsd-planner',
        path: '/home/user/.claude/agents/gsd-planner.md',
        scope: 'global',
        category: 'agent',
        tier: 'definite-ghost',
        lastUsed: null,
        urgencyScore: 55,
        daysSinceLastUse: null,
        framework: 'gsd',
      };
      expect(withFramework.framework).toBe('gsd');

      const ungrouped: GhostItem = {
        name: 'custom-agent',
        path: '/home/user/.claude/agents/custom.md',
        scope: 'global',
        category: 'agent',
        tier: 'likely-ghost',
        lastUsed: new Date('2026-03-15T00:00:00Z'),
        urgencyScore: 40,
        daysSinceLastUse: 27,
        framework: null,
      };
      expect(ungrouped.framework).toBeNull();
    });

    it('should accept an item with optional tokenEstimate field set (D-14)', () => {
      const withTokens: GhostItem = {
        name: 'gsd-planner',
        path: '/home/user/.claude/agents/gsd-planner.md',
        scope: 'global',
        category: 'agent',
        tier: 'definite-ghost',
        lastUsed: null,
        urgencyScore: 55,
        daysSinceLastUse: null,
        framework: 'gsd',
        tokenEstimate: { tokens: 25, confidence: 'estimated', source: 'file size' },
      };
      expect(withTokens.tokenEstimate?.tokens).toBe(25);
      expect(withTokens.tokenEstimate?.confidence).toBe('estimated');

      const withoutTokens: GhostItem = {
        name: 'mystery-mcp',
        path: '/home/user/.claude.json',
        scope: 'global',
        category: 'mcp-server',
        tier: 'likely-ghost',
        lastUsed: new Date('2026-03-15T00:00:00Z'),
        urgencyScore: 40,
        daysSinceLastUse: 27,
        framework: null,
        tokenEstimate: null,
      };
      expect(withoutTokens.tokenEstimate).toBeNull();
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
