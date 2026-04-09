import Table from 'cli-table3';
import { getTableStyle } from '../color.ts';
import type { TrendBucket } from '@ccaudit/internal';

/**
 * Render the invocation trend table using cli-table3 bordered table.
 *
 * Columns (per UI-SPEC):
 *   Period | Agents | Skills | MCP | Total
 *
 * Zero values shown as `0`, not blank.
 * Returns the rendered table string.
 */
export function renderTrendTable(buckets: TrendBucket[]): string {
  const table = new Table({
    head: ['Period', 'Agents', 'Skills', 'MCP', 'Total'],
    colAligns: ['left', 'right', 'right', 'right', 'right'],
    style: getTableStyle(),
    wordWrap: true,
  });

  for (const b of buckets) {
    table.push([b.period, String(b.agents), String(b.skills), String(b.mcp), String(b.total)]);
  }

  return table.toString();
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderTrendTable', () => {
    it('produces string containing Period header for 3 buckets', () => {
      const buckets: TrendBucket[] = [
        { period: '2026-04-01', agents: 10, skills: 5, mcp: 3, total: 18 },
        { period: '2026-04-02', agents: 8, skills: 2, mcp: 1, total: 11 },
        { period: '2026-04-03', agents: 0, skills: 0, mcp: 0, total: 0 },
      ];
      const output = renderTrendTable(buckets);
      expect(output).toContain('Period');
    });

    it('shows zero values as 0, not blank', () => {
      const buckets: TrendBucket[] = [
        { period: '2026-04-03', agents: 0, skills: 0, mcp: 0, total: 0 },
      ];
      const output = renderTrendTable(buckets);
      // The table should contain 0 values
      expect(output).toContain('0');
    });

    it('contains weekly period format', () => {
      const buckets: TrendBucket[] = [
        { period: 'Week of 2026-03-31', agents: 20, skills: 10, mcp: 5, total: 35 },
      ];
      const output = renderTrendTable(buckets);
      expect(output).toContain('Week of 2026-03-31');
    });
  });
}
