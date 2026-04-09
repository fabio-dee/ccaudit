import type { TokenCostResult } from '../token/types.ts';
import type { ItemCategory, ItemScope } from '../types.ts';
import { calculateDryRunSavings } from './savings.ts';

/**
 * Action verbs grouping items in the change plan.
 * - archive: agents + skills (definite-ghost) -> moved to ccaudit/archived/ in Phase 8
 * - disable: MCP servers (definite-ghost OR likely-ghost per D-11a) -> key-renamed in Phase 8
 * - flag:    memory files (any stale tier) -> frontmatter added in Phase 8
 */
export type ChangePlanAction = 'archive' | 'disable' | 'flag';

/**
 * A single item that would be modified by --dangerously-bust-ghosts.
 * Category narrows what fields are meaningful: MCP servers carry the source
 * config path in `path`; agents/skills/memory carry a file path.
 */
export interface ChangePlanItem {
  action: ChangePlanAction;
  category: ItemCategory;
  scope: ItemScope;
  name: string;
  projectPath: string | null;
  path: string;
  tokens: number;
  tier: 'definite-ghost' | 'likely-ghost';
}

/**
 * The full change plan grouped by action and typed for both renderers
 * (renderChangePlan) and JSON emission (buildJsonEnvelope payload).
 */
export interface ChangePlan {
  archive: ChangePlanItem[];
  disable: ChangePlanItem[];
  flag: ChangePlanItem[];
  counts: {
    agents: number;
    skills: number;
    mcp: number;
    memory: number;
  };
  savings: {
    tokens: number;
  };
}

/**
 * Build a ChangePlan from enriched scan results.
 * Pure function -- no I/O, no global state.
 *
 * Filter rules (D-07, D-11a):
 *  - archive: agents + skills with tier === 'definite-ghost'
 *  - disable: MCP servers with tier !== 'used' (definite + likely per D-11a)
 *  - flag:    memory files with tier !== 'used' (any stale tier)
 *  - likely-ghost agents/skills are EXCLUDED (monitor-only per Phase 5 D-12)
 */
export function buildChangePlan(enriched: TokenCostResult[]): ChangePlan {
  const archive: ChangePlanItem[] = [];
  const disable: ChangePlanItem[] = [];
  const flag: ChangePlanItem[] = [];

  for (const r of enriched) {
    const base = {
      category: r.item.category,
      scope: r.item.scope,
      name: r.item.name,
      projectPath: r.item.projectPath,
      path: r.item.path,
      tokens: r.tokenEstimate?.tokens ?? 0,
      tier: r.tier as 'definite-ghost' | 'likely-ghost',
    };

    if (r.item.category === 'agent' || r.item.category === 'skill') {
      if (r.tier === 'definite-ghost') {
        archive.push({ action: 'archive', ...base });
      }
      continue;
    }
    if (r.item.category === 'mcp-server') {
      if (r.tier !== 'used') {
        disable.push({ action: 'disable', ...base });
      }
      continue;
    }
    if (r.item.category === 'memory') {
      if (r.tier !== 'used') {
        flag.push({ action: 'flag', ...base });
      }
      continue;
    }
  }

  const counts = {
    agents: archive.filter((i) => i.category === 'agent').length,
    skills: archive.filter((i) => i.category === 'skill').length,
    mcp: disable.length,
    memory: flag.length,
  };

  // Compute savings AFTER lists are built -- delegates to savings.ts
  const partial: ChangePlan = { archive, disable, flag, counts, savings: { tokens: 0 } };
  partial.savings.tokens = calculateDryRunSavings(partial);
  return partial;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Factory helper -- minimal valid TokenCostResult with one field overridden
  function makeResult(overrides: {
    category: ItemCategory;
    tier: 'used' | 'likely-ghost' | 'definite-ghost';
    tokens?: number | null;
    name?: string;
  }): TokenCostResult {
    const name = overrides.name ?? `${overrides.category}-test`;
    return {
      item: {
        name,
        path: `/tmp/${name}`,
        scope: 'global',
        category: overrides.category,
        projectPath: null,
      },
      tier: overrides.tier,
      lastUsed: overrides.tier === 'used' ? new Date() : null,
      invocationCount: overrides.tier === 'used' ? 1 : 0,
      tokenEstimate:
        overrides.tokens === null
          ? null
          : overrides.tokens !== undefined
            ? { tokens: overrides.tokens, confidence: 'estimated', source: 'test' }
            : { tokens: 100, confidence: 'estimated', source: 'test' },
    };
  }

  describe('buildChangePlan', () => {
    it('archives definite-ghost agents', () => {
      const plan = buildChangePlan([makeResult({ category: 'agent', tier: 'definite-ghost' })]);
      expect(plan.archive).toHaveLength(1);
      expect(plan.counts.agents).toBe(1);
      expect(plan.archive[0]!.action).toBe('archive');
    });

    it('archives definite-ghost skills', () => {
      const plan = buildChangePlan([makeResult({ category: 'skill', tier: 'definite-ghost' })]);
      expect(plan.archive).toHaveLength(1);
      expect(plan.counts.skills).toBe(1);
    });

    it('excludes likely-ghost agents (Phase 5 D-12 monitor-only)', () => {
      const plan = buildChangePlan([makeResult({ category: 'agent', tier: 'likely-ghost' })]);
      expect(plan.archive).toHaveLength(0);
      expect(plan.counts.agents).toBe(0);
    });

    it('excludes likely-ghost skills', () => {
      const plan = buildChangePlan([makeResult({ category: 'skill', tier: 'likely-ghost' })]);
      expect(plan.archive).toHaveLength(0);
    });

    it('disables likely-ghost MCP (D-11a widening)', () => {
      const plan = buildChangePlan([makeResult({ category: 'mcp-server', tier: 'likely-ghost' })]);
      expect(plan.disable).toHaveLength(1);
      expect(plan.counts.mcp).toBe(1);
      expect(plan.disable[0]!.action).toBe('disable');
    });

    it('disables definite-ghost MCP', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'mcp-server', tier: 'definite-ghost' }),
      ]);
      expect(plan.counts.mcp).toBe(1);
    });

    it('flags likely-ghost memory', () => {
      const plan = buildChangePlan([makeResult({ category: 'memory', tier: 'likely-ghost' })]);
      expect(plan.flag).toHaveLength(1);
      expect(plan.counts.memory).toBe(1);
    });

    it('flags definite-ghost memory', () => {
      const plan = buildChangePlan([makeResult({ category: 'memory', tier: 'definite-ghost' })]);
      expect(plan.flag).toHaveLength(1);
    });

    it('excludes used items from every tier', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'agent', tier: 'used' }),
        makeResult({ category: 'mcp-server', tier: 'used' }),
        makeResult({ category: 'memory', tier: 'used' }),
      ]);
      expect(plan.archive).toHaveLength(0);
      expect(plan.disable).toHaveLength(0);
      expect(plan.flag).toHaveLength(0);
    });

    it('applies tokens=0 when tokenEstimate is null', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'agent', tier: 'definite-ghost', tokens: null }),
      ]);
      expect(plan.archive[0]!.tokens).toBe(0);
    });

    it('passes through tokenEstimate.tokens', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'skill', tier: 'definite-ghost', tokens: 500 }),
      ]);
      expect(plan.archive[0]!.tokens).toBe(500);
    });

    it('mixed input produces correct counts', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'a1' }),
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'a2' }),
        makeResult({ category: 'agent', tier: 'likely-ghost', name: 'a3' }),
        makeResult({ category: 'agent', tier: 'used', name: 'a4' }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm1' }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm2' }),
        makeResult({ category: 'memory', tier: 'likely-ghost', name: 'mem1' }),
      ]);
      expect(plan.counts).toEqual({ agents: 2, skills: 0, mcp: 2, memory: 1 });
    });
  });
}
