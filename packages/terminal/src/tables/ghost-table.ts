import { colorize } from '../color.ts';
import type { CategorySummary, TokenCostResult } from '@ccaudit/internal';
import { formatTokenEstimate } from '@ccaudit/internal';

/**
 * Category display names for the summary table.
 * Order: agents, skills, mcp-server, memory -- matching the handoff mockup.
 */
const CATEGORY_DISPLAY: Record<string, string> = {
  agent: 'Agents',
  skill: 'Skills',
  'mcp-server': 'MCP Servers',
  memory: 'Memory Files',
};

/** Padded category column width -- longest is "Memory Files" (12 chars), padded to 13 */
const CATEGORY_PAD = 13;

/**
 * Render the ghost summary table with column-aligned plain text (NOT cli-table3 borders).
 * Per D-02: one row per category.
 *
 * Format:
 *   Agents        Defined: 140   Used:  12   Ghost: 128   ~47k tokens/session
 *   Memory Files  Loaded:    9   Active:  3  Stale:   6   ~12k tokens/session
 */
export function renderGhostSummary(summaries: CategorySummary[]): string {
  const lines: string[] = [];

  for (const s of summaries) {
    const catName = (CATEGORY_DISPLAY[s.category] ?? s.category).padEnd(CATEGORY_PAD);
    const isMemory = s.category === 'memory';

    // Per D-04: Memory uses Loaded/Active/Stale; others use Defined/Used/Ghost
    const label1 = isMemory ? 'Loaded:' : 'Defined:';
    const label2 = isMemory ? 'Active:' : 'Used:';
    const label3 = isMemory ? 'Stale:' : 'Ghost:';

    const val1 = String(s.defined).padStart(3);
    const val2 = String(s.used).padStart(3);
    const val3 = String(s.ghost).padStart(3);
    const tokenStr = formatTokenShort(s.tokenCost);

    lines.push(`${catName} ${label1} ${val1}   ${label2} ${val2}   ${label3} ${val3}   ${tokenStr}`);
  }

  return lines.join('\n');
}

/**
 * Render the top-N ghosts by token cost as a numbered plain-text list.
 * Per D-03 and D-10.
 *
 * Format:
 *   \u{1F6A8} Top ghosts by token cost:
 *     1. my-agent       ~15k tokens  (agent, 45d ago)
 *     2. unused-skill   ~8k tokens   (skill, never)
 *
 * Returns empty string if ghosts array is empty.
 */
export function renderTopGhosts(ghosts: TokenCostResult[], maxItems: number = 5): string {
  if (ghosts.length === 0) return '';

  // Sort by token cost descending (nulls last)
  const sorted = [...ghosts].sort((a, b) => {
    const aTokens = a.tokenEstimate?.tokens ?? 0;
    const bTokens = b.tokenEstimate?.tokens ?? 0;
    return bTokens - aTokens;
  });

  const top = sorted.slice(0, maxItems);
  const lines: string[] = [];

  lines.push(colorize.bold('\u{1F6A8} Top ghosts by token cost:'));

  for (let i = 0; i < top.length; i++) {
    const g = top[i]!;
    const num = `${i + 1}.`;
    const name = g.item.name;
    const tokenDisplay = formatTokenEstimate(g.tokenEstimate);
    const category = g.item.category;
    const lastUsed = formatLastUsed(g.lastUsed);

    lines.push(`  ${num} ${name}       ${tokenDisplay}  (${category}, ${lastUsed})`);
  }

  return lines.join('\n');
}

/**
 * Render the ghost command footer with two hint lines (dim per UI-SPEC).
 */
export function renderGhostFooter(_sinceWindow: string): string {
  const hint1 = colorize.dim('See per-item details: ccaudit inventory');
  const hint2 = colorize.dim('Dry-run coming in v1.1: npx ccaudit@latest --dry-run');
  return `${hint1}\n${hint2}`;
}

/**
 * Format a last-used date as "Nd ago" or "never".
 */
function formatLastUsed(lastUsed: Date | null): string {
  if (lastUsed === null) return 'never';
  const now = Date.now();
  const diffMs = now - lastUsed.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

/**
 * Format a token count for the summary row: ~Xk tokens/session.
 */
function formatTokenShort(tokens: number): string {
  if (tokens >= 10000) {
    return `~${Math.round(tokens / 1000)}k tokens/session`;
  }
  if (tokens >= 1000) {
    return `~${(tokens / 1000).toFixed(1)}k tokens/session`;
  }
  return `~${tokens} tokens/session`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderGhostSummary', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 140, used: 12, ghost: 128, tokenCost: 47000 },
      { category: 'skill', defined: 90, used: 8, ghost: 82, tokenCost: 18000 },
      { category: 'mcp-server', defined: 6, used: 2, ghost: 4, tokenCost: 32000 },
      { category: 'memory', defined: 9, used: 3, ghost: 6, tokenCost: 12000 },
    ];

    it('produces string with 4 lines for 4 categories', () => {
      const result = renderGhostSummary(summaries);
      const lines = result.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('contains "Defined:" for agents and "Loaded:" for memory', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Defined:');
      expect(result).toContain('Loaded:');
    });

    it('contains "Active:" for memory and "Used:" for agents', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Active:');
      expect(result).toContain('Used:');
    });

    it('contains "Stale:" for memory and "Ghost:" for agents', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Stale:');
      expect(result).toContain('Ghost:');
    });

    it('contains category display names', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Agents');
      expect(result).toContain('Skills');
      expect(result).toContain('MCP Servers');
      expect(result).toContain('Memory Files');
    });
  });

  describe('renderTopGhosts', () => {
    /** Helper: build a minimal TokenCostResult for testing. */
    function makeGhost(name: string, tokens: number, category: string = 'agent'): TokenCostResult {
      return {
        item: {
          name,
          path: `/test/${name}`,
          scope: 'global',
          category: category as TokenCostResult['item']['category'],
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('returns only top 5 items when given 7', () => {
      const ghosts = Array.from({ length: 7 }, (_, i) =>
        makeGhost(`ghost-${i}`, (i + 1) * 1000),
      );
      const result = renderTopGhosts(ghosts);
      // Header line + 5 items = 6 lines
      const lines = result.split('\n');
      expect(lines).toHaveLength(6);
    });

    it('returns empty string for empty array', () => {
      const result = renderTopGhosts([]);
      expect(result).toBe('');
    });

    it('items are sorted by token cost descending', () => {
      const ghosts = [
        makeGhost('low', 1000),
        makeGhost('high', 10000),
        makeGhost('mid', 5000),
      ];
      const result = renderTopGhosts(ghosts);
      const lines = result.split('\n').slice(1); // Skip header
      expect(lines[0]).toContain('high');
      expect(lines[1]).toContain('mid');
      expect(lines[2]).toContain('low');
    });

    it('contains the top ghosts section header', () => {
      const ghosts = [makeGhost('test', 5000)];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('Top ghosts by token cost:');
    });

    it('contains category and last-used info', () => {
      const ghosts = [makeGhost('test', 5000, 'skill')];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('skill');
      expect(result).toContain('never');
    });
  });

  describe('renderGhostFooter', () => {
    it('contains inventory hint', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('See per-item details: ccaudit inventory');
    });

    it('contains dry-run hint', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('Dry-run coming in v1.1');
    });
  });

  describe('formatLastUsed branches (via renderTopGhosts)', () => {
    /**
     * These tests exercise the private formatLastUsed helper through the
     * public renderTopGhosts renderer, covering the today / 1d ago / Nd ago
     * branches that null-only fixtures cannot reach.
     */
    function makeDatedGhost(name: string, tokens: number, lastUsed: Date | null): TokenCostResult {
      return {
        item: {
          name,
          path: `/test/${name}`,
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('renders "today" when lastUsed is now', () => {
      const ghosts = [makeDatedGhost('fresh', 500, new Date())];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('today');
    });

    it('renders "1d ago" when lastUsed is exactly 1 day old', () => {
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 - 60000);
      const ghosts = [makeDatedGhost('yesterday', 500, oneDayAgo)];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('1d ago');
    });

    it('renders "Nd ago" for multi-day-old lastUsed', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const ghosts = [makeDatedGhost('stale', 500, fiveDaysAgo)];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('5d ago');
    });
  });

  describe('formatTokenShort branches (via renderGhostSummary)', () => {
    /**
     * Exercise the private formatTokenShort helper through renderGhostSummary,
     * covering the mid-range (1000 <= tokens < 10000) and small (< 1000)
     * branches that the fixture summaries (all >= 10000) do not reach.
     */
    it('renders mid-range tokens as ~X.Yk tokens/session', () => {
      const summaries: CategorySummary[] = [
        { category: 'agent', defined: 5, used: 2, ghost: 3, tokenCost: 3500 },
      ];
      const output = renderGhostSummary(summaries);
      expect(output).toContain('~3.5k tokens/session');
    });

    it('renders small tokens as ~N tokens/session (no k suffix)', () => {
      const summaries: CategorySummary[] = [
        { category: 'skill', defined: 5, used: 3, ghost: 2, tokenCost: 250 },
      ];
      const output = renderGhostSummary(summaries);
      expect(output).toContain('~250 tokens/session');
    });
  });
}
