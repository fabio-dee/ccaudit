import Table from 'cli-table3';
import { colorize, getTableStyle } from '../color.ts';
import type { TokenCostResult } from '@ccaudit/internal';
import { classifyRecommendation, formatTokenEstimate } from '@ccaudit/internal';

/**
 * Render the MCP servers table using cli-table3 bordered table.
 *
 * Columns (per UI-SPEC):
 *   Server | Scope | Tier | Invocations | Last Used | ~Token Cost | Action
 *
 * Returns the rendered table string.
 */
export function renderMcpTable(results: TokenCostResult[]): string {
  const table = new Table({
    head: ['Server', 'Scope', 'Tier', 'Invocations', 'Last Used', '~Token Cost', 'Action'],
    colAligns: ['left', 'left', 'center', 'right', 'right', 'right', 'center'],
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
      r.item.scope,
      tier,
      String(r.invocationCount),
      lastUsed,
      tokenCost,
      action,
    ]);
  }

  return table.toString();
}

/**
 * Format ghost tier as colored bracket label.
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

  describe('renderMcpTable', () => {
    it('produces string containing Server header for 1 item', () => {
      const results: TokenCostResult[] = [{
        item: {
          name: 'sequential-thinking',
          path: '/home/user/.claude.json',
          scope: 'global',
          category: 'mcp-server',
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens: 15000, confidence: 'estimated', source: 'test' },
      }];
      const output = renderMcpTable(results);
      expect(output).toContain('Server');
    });

    it('contains invocation count column', () => {
      const results: TokenCostResult[] = [{
        item: {
          name: 'context7',
          path: '/home/user/.claude.json',
          scope: 'global',
          category: 'mcp-server',
          projectPath: null,
        },
        tier: 'used',
        lastUsed: new Date(),
        invocationCount: 42,
        tokenEstimate: { tokens: 8000, confidence: 'measured', source: 'live' },
      }];
      const output = renderMcpTable(results);
      expect(output).toContain('42');
    });
  });
}
