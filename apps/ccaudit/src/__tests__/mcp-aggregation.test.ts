/**
 * E2E regression test for Gap #5: ccaudit mcp --csv cross-project duplicate rows.
 *
 * Scenario: when the same MCP server is declared in multiple .mcp.json files
 * (or in multiple ~/.claude.json projects entries), the scanner emits one
 * InventoryItem per (projectPath, serverName) pair for Phase 8 RMED-06
 * traceability. The presentation layer must collapse by name so CSV/table/JSON
 * show one row per server, not one per (server, project) pair.
 *
 * This test exercises aggregateMcpByName directly — the E2E filesystem fixture
 * for multi-.mcp.json cross-project setup would be significantly larger than
 * the fix itself, and the helper-level test gives the same coverage.
 */
import { describe, it, expect } from 'vitest';
import type { TokenCostResult } from '@ccaudit/internal';
import { aggregateMcpByName } from '../cli/commands/mcp.ts';

function makeResult(
  name: string,
  projectPath: string | null,
  tier: 'used' | 'likely-ghost' | 'definite-ghost',
  invocationCount: number,
  lastUsed: Date | null,
): TokenCostResult {
  return {
    item: {
      name,
      path: projectPath ? `${projectPath}/.mcp.json` : '/home/user/.claude.json',
      scope: projectPath ? 'project' : 'global',
      category: 'mcp-server',
      projectPath,
    },
    tier,
    lastUsed,
    invocationCount,
    tokenEstimate: { tokens: 1500, confidence: 'estimated', source: 'bundled' },
  };
}

describe('Gap #5 regression: mcp --csv cross-project duplicate rows', () => {
  it('collapses duplicate server name across two .mcp.json files into one row', () => {
    const input: TokenCostResult[] = [
      makeResult('supabase', '/home/user/projA', 'definite-ghost', 0, null),
      makeResult('supabase', '/home/user/projB', 'definite-ghost', 0, null),
    ];

    const result = aggregateMcpByName(input);

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.item.name).toBe('supabase');
    expect(row.item.projectPath).toBeNull();
    const projectPaths = (row.item as typeof row.item & { projectPaths: string[] }).projectPaths;
    expect(projectPaths).toHaveLength(2);
    expect(projectPaths).toContain('/home/user/projA');
    expect(projectPaths).toContain('/home/user/projB');
    expect(row.tier).toBe('definite-ghost');
  });

  it('keeps least-ghost tier when one instance is used and others are ghosts', () => {
    const recent = new Date('2026-03-20T10:00:00Z');
    const input: TokenCostResult[] = [
      makeResult('context7', '/home/user/projA', 'definite-ghost', 0, null),
      makeResult('context7', '/home/user/projB', 'used', 10, recent),
      makeResult('context7', '/home/user/projC', 'definite-ghost', 0, null),
    ];

    const result = aggregateMcpByName(input);

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.tier).toBe('used');
    expect(row.invocationCount).toBe(10);
    expect(row.lastUsed).toEqual(recent);
  });

  it('a mixed set of duplicates and uniques produces the correct collapsed row count', () => {
    const input: TokenCostResult[] = [
      makeResult('supabase', '/p/a', 'definite-ghost', 0, null),
      makeResult('supabase', '/p/b', 'definite-ghost', 0, null),
      makeResult('context7', '/p/a', 'likely-ghost', 1, new Date('2026-02-15T00:00:00Z')),
      makeResult('playwright', '/p/c', 'definite-ghost', 0, null),
      makeResult('playwright', '/p/d', 'definite-ghost', 0, null),
    ];

    const result = aggregateMcpByName(input);

    expect(result).toHaveLength(3);
    const names = result.map(r => r.item.name).sort();
    expect(names).toEqual(['context7', 'playwright', 'supabase']);

    // Regression check: no duplicate names after aggregation.
    const uniqueNames = new Set(result.map(r => r.item.name));
    expect(uniqueNames.size).toBe(result.length);
  });
});
