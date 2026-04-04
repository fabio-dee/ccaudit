import Table from 'cli-table3';
import { colorize, getTableStyle } from '../color.ts';
import type { TokenCostResult } from '@ccaudit/internal';
import { classifyRecommendation, formatTokenEstimate } from '@ccaudit/internal';

/**
 * Render the full inventory table using cli-table3 bordered table.
 *
 * Columns (per UI-SPEC):
 *   Name | Category | Scope | Tier | Last Used | ~Token Cost | Action
 *
 * Returns the rendered table string.
 */
export function renderInventoryTable(results: TokenCostResult[]): string {
  const table = new Table({
    head: ['Name', 'Category', 'Scope', 'Tier', 'Last Used', '~Token Cost', 'Action'],
    colAligns: ['left', 'left', 'left', 'center', 'right', 'right', 'center'],
    style: getTableStyle(),
    wordWrap: true,
  });

  for (const r of results) {
    const tier = formatTier(r.tier);
    const lastUsed = formatLastUsed(r.lastUsed);
    const tokenCost = formatTokenEstimate(r.tokenEstimate);
    const recommendation = classifyRecommendation(r.tier);
    const action = formatRecommendation(recommendation);

    table.push([
      r.item.name,
      r.item.category,
      r.item.scope,
      tier,
      lastUsed,
      tokenCost,
      action,
    ]);
  }

  return table.toString();
}

/**
 * Format ghost tier as colored bracket label.
 * Per UI-SPEC: [GHOST] red, [LIKELY] yellow, [ACTIVE] green.
 */
function formatTier(tier: string): string {
  switch (tier) {
    case 'definite-ghost': return colorize.red('[GHOST]');
    case 'likely-ghost': return colorize.yellow('[LIKELY]');
    case 'used': return colorize.green('[ACTIVE]');
    default: return tier;
  }
}

/**
 * Format recommendation as colored label.
 * Per UI-SPEC: Archive red, Monitor yellow, Keep green.
 */
function formatRecommendation(rec: string): string {
  switch (rec) {
    case 'archive': return colorize.red('Archive');
    case 'monitor': return colorize.yellow('Monitor');
    case 'keep': return colorize.green('Keep');
    default: return rec;
  }
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

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Helper: build a minimal TokenCostResult for testing. */
  function makeResult(
    name: string,
    tier: 'used' | 'likely-ghost' | 'definite-ghost',
    tokens: number | null = null,
  ): TokenCostResult {
    return {
      item: {
        name,
        path: `/test/${name}`,
        scope: 'global',
        category: 'agent',
        projectPath: null,
      },
      tier,
      lastUsed: tier === 'used' ? new Date() : null,
      invocationCount: tier === 'used' ? 1 : 0,
      tokenEstimate: tokens !== null
        ? { tokens, confidence: 'estimated', source: 'test' }
        : null,
    };
  }

  describe('renderInventoryTable', () => {
    it('produces string containing Name header for 2 items', () => {
      const results = [
        makeResult('agent-a', 'definite-ghost', 5000),
        makeResult('agent-b', 'used', 1000),
      ];
      const output = renderInventoryTable(results);
      expect(output).toContain('Name');
    });

    it('contains Archive for definite-ghost items', () => {
      const results = [makeResult('stale-agent', 'definite-ghost', 3000)];
      const output = renderInventoryTable(results);
      expect(output).toContain('Archive');
    });

    it('contains Keep for used items', () => {
      const results = [makeResult('active-agent', 'used', 1000)];
      const output = renderInventoryTable(results);
      expect(output).toContain('Keep');
    });

    it('contains Monitor for likely-ghost items', () => {
      const results = [makeResult('suspect-agent', 'likely-ghost', 2000)];
      const output = renderInventoryTable(results);
      expect(output).toContain('Monitor');
    });

    it('renders "today" when lastUsed is now (used tier with real Date)', () => {
      const results = [makeResult('active-agent', 'used', 1000)];
      const output = renderInventoryTable(results);
      expect(output).toContain('today');
    });

    it('renders "1d ago" for a 1-day-old lastUsed', () => {
      const result: TokenCostResult = {
        item: {
          name: 'yesterday-agent',
          path: '/x',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'used',
        lastUsed: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 - 60000),
        invocationCount: 1,
        tokenEstimate: null,
      };
      const output = renderInventoryTable([result]);
      expect(output).toContain('1d ago');
    });

    it('renders "Nd ago" for a multi-day-old lastUsed', () => {
      const result: TokenCostResult = {
        item: {
          name: 'week-old-agent',
          path: '/x',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'likely-ghost',
        lastUsed: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        invocationCount: 0,
        tokenEstimate: null,
      };
      const output = renderInventoryTable([result]);
      expect(output).toContain('7d ago');
    });
  });
}
