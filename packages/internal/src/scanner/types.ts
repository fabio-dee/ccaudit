import type { ClaudePaths, GhostTier, ItemCategory, ItemScope } from '../types.ts';

/**
 * Pre-classification inventory entry discovered by a scanner.
 * Each scanner (agent, skill, mcp, memory) produces these before
 * matching against the invocation ledger.
 */
export interface InventoryItem {
  /** Display name (agent file stem, skill dir name, MCP server key, memory file name) */
  name: string;
  /** Absolute filesystem path (or config source path for MCP) */
  path: string;
  /** Global (~/.claude/) or project-local (.claude/) */
  scope: ItemScope;
  /** Category: agent, skill, mcp-server, memory */
  category: ItemCategory;
  /** Project path for project-scoped items, null for global */
  projectPath: string | null;
  /** Optional file modification time in ms (used by memory scanner) */
  mtimeMs?: number;
  /** Framework group identity. null when item is not part of any detected framework. */
  framework?: string | null;
  /** Hook event name for hook-category items (e.g. 'PreToolUse') */
  hookEvent?: string;
  /** Whether the hook fires on inject-capable events (up to 2500 tok overhead) */
  injectCapable?: boolean;
  /** Depth of @-import chain for memory-category items */
  importDepth?: number;
  /** Root path from which @-imports were resolved */
  importRoot?: string;
  /**
   * Phase 6 (D6-02 / D6-17): config files referencing this MCP server key.
   * Populated by `scanMcpServers` for every `mcp-server` item (length >= 1).
   * Absent for non-MCP categories. Paths rendered via `presentPath` and
   * ordered via `compareConfigRef` (project-local → ~user → system).
   */
  configRefs?: string[];
}

/**
 * Phase 6 (D6-01): framework-as-unit protection metadata attached to a
 * canonical ghost item when its framework would trip INV-S6 under a
 * partial bust. Advisory for the picker — server-side enforcement in
 * `runBust` remains the actual gate.
 */
export interface FrameworkProtection {
  /** Framework display id (e.g., "gsd", "superclaude"). */
  framework: string;
  /** Total members of the framework (used + ghost). */
  total: number;
  /** Ghost members (tier !== 'used'). */
  ghostCount: number;
  /** Canonical reason string rendered by the picker verbatim. */
  reason: string;
}

/**
 * Post-classification result after matching an inventory item
 * against the invocation ledger.
 */
export interface ScanResult {
  /** The discovered inventory item */
  item: InventoryItem;
  /** Ghost classification: 'used' | 'likely-ghost' | 'definite-ghost' */
  tier: GhostTier;
  /** Last invocation date, or null if never invoked */
  lastUsed: Date | null;
  /** Number of invocations in the time window */
  invocationCount: number;
}

/**
 * Scanner configuration options shared across all scanners.
 */
export interface ScannerOptions {
  /** Dual-path resolution for XDG and legacy Claude paths */
  claudePaths: ClaudePaths;
  /** Known project paths from invocation ledger */
  projectPaths: string[];
  /** Override path to ~/.claude.json (for testing) */
  claudeConfigPath?: string;
}

/**
 * Summary of invocations for a single item in the invocation lookup map.
 * Used for fast O(1) matching during classification.
 */
export interface InvocationSummary {
  /** Most recent invocation ISO timestamp */
  lastTimestamp: string;
  /** Total invocations in window */
  count: number;
  /** All project paths this item was invoked from */
  projects: Set<string>;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('InventoryItem', () => {
    it('should accept a global agent item', () => {
      const item: InventoryItem = {
        name: 'code-reviewer',
        path: '/home/user/.claude/agents/code-reviewer.md',
        scope: 'global',
        category: 'agent',
        projectPath: null,
      };
      expect(item.name).toBe('code-reviewer');
      expect(item.scope).toBe('global');
      expect(item.category).toBe('agent');
      expect(item.projectPath).toBeNull();
      expect(item.mtimeMs).toBeUndefined();
    });

    it('should accept a project-scoped skill item', () => {
      const item: InventoryItem = {
        name: 'deploy',
        path: '/Users/test/project/.claude/skills/deploy/SKILL.md',
        scope: 'project',
        category: 'skill',
        projectPath: '/Users/test/project',
      };
      expect(item.scope).toBe('project');
      expect(item.category).toBe('skill');
      expect(item.projectPath).toBe('/Users/test/project');
    });

    it('should accept an mcp-server item', () => {
      const item: InventoryItem = {
        name: 'sequential-thinking',
        path: '/home/user/.claude.json',
        scope: 'global',
        category: 'mcp-server',
        projectPath: null,
      };
      expect(item.category).toBe('mcp-server');
    });

    it('should accept a memory item with mtimeMs', () => {
      const item: InventoryItem = {
        name: 'CLAUDE.md',
        path: '/Users/test/project/CLAUDE.md',
        scope: 'project',
        category: 'memory',
        projectPath: '/Users/test/project',
        mtimeMs: 1712000000000,
      };
      expect(item.category).toBe('memory');
      expect(item.mtimeMs).toBe(1712000000000);
    });

    it('should accept an item with optional framework field set (SCAN-01)', () => {
      const grouped: InventoryItem = {
        name: 'gsd-planner',
        path: '/home/user/.claude/agents/gsd-planner.md',
        scope: 'global',
        category: 'agent',
        projectPath: null,
        framework: 'gsd',
      };
      expect(grouped.framework).toBe('gsd');

      const ungrouped: InventoryItem = {
        name: 'custom-agent',
        path: '/home/user/.claude/agents/custom.md',
        scope: 'global',
        category: 'agent',
        projectPath: null,
        framework: null,
      };
      expect(ungrouped.framework).toBeNull();
    });
  });

  describe('ScanResult', () => {
    it('should hold an InventoryItem with classification data', () => {
      const result: ScanResult = {
        item: {
          name: 'stale-agent',
          path: '/home/user/.claude/agents/stale.md',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
      };
      expect(result.tier).toBe('definite-ghost');
      expect(result.lastUsed).toBeNull();
      expect(result.invocationCount).toBe(0);
    });

    it('should hold a used item with lastUsed date and count', () => {
      const result: ScanResult = {
        item: {
          name: 'active-skill',
          path: '/home/user/.claude/skills/active/SKILL.md',
          scope: 'global',
          category: 'skill',
          projectPath: null,
        },
        tier: 'used',
        lastUsed: new Date('2026-04-01T12:00:00Z'),
        invocationCount: 15,
      };
      expect(result.tier).toBe('used');
      expect(result.lastUsed).toBeInstanceOf(Date);
      expect(result.invocationCount).toBe(15);
    });
  });

  describe('ScannerOptions', () => {
    it('should hold claude paths and project paths', () => {
      const opts: ScannerOptions = {
        claudePaths: {
          xdg: '/home/user/.config/claude',
          legacy: '/home/user/.claude',
        },
        projectPaths: ['/Users/test/project-a', '/Users/test/project-b'],
      };
      expect(opts.claudePaths.xdg).toContain('.config/claude');
      expect(opts.projectPaths).toHaveLength(2);
      expect(opts.claudeConfigPath).toBeUndefined();
    });

    it('should accept optional claudeConfigPath override', () => {
      const opts: ScannerOptions = {
        claudePaths: {
          xdg: '/home/user/.config/claude',
          legacy: '/home/user/.claude',
        },
        projectPaths: [],
        claudeConfigPath: '/tmp/test-claude.json',
      };
      expect(opts.claudeConfigPath).toBe('/tmp/test-claude.json');
    });
  });

  describe('InvocationSummary', () => {
    it('should hold timestamp, count, and project set', () => {
      const summary: InvocationSummary = {
        lastTimestamp: '2026-04-01T12:00:00Z',
        count: 5,
        projects: new Set(['/Users/test/project-a', '/Users/test/project-b']),
      };
      expect(summary.lastTimestamp).toBe('2026-04-01T12:00:00Z');
      expect(summary.count).toBe(5);
      expect(summary.projects.size).toBe(2);
      expect(summary.projects.has('/Users/test/project-a')).toBe(true);
    });

    it('should allow empty projects set', () => {
      const summary: InvocationSummary = {
        lastTimestamp: '2026-04-01T00:00:00Z',
        count: 1,
        projects: new Set(),
      };
      expect(summary.projects.size).toBe(0);
    });
  });
}
