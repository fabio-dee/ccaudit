import type { TokenCostResult } from '../token/types.ts';
import type { ItemCategory, ItemScope } from '../types.ts';
import { calculateDryRunSavings } from './savings.ts';
import { canonicalItemId } from './checkpoint.ts';

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

/**
 * Apply an optional subset filter to a ChangePlan (Phase 1 / D-03).
 *
 * - `selectedItems === undefined`  → return the plan unchanged
 *   (full-inventory bust; v1.4.0 contract preserved byte-for-byte).
 * - `selectedItems === new Set([...])` → return a new ChangePlan whose
 *   archive/disable/flag arrays contain only items whose canonicalItemId
 *   is in the set. Counts + savings are recomputed from the filtered
 *   lists. Unknown ids in the set are silently ignored.
 *
 * The filter uses `canonicalItemId` (checkpoint.ts) for identity so the
 * ids produced by `computeGhostHash`'s key derivation, the TUI picker,
 * and the integration-test CCAUDIT_SELECT_IDS parser all line up.
 */
export function filterChangePlan(
  plan: ChangePlan,
  selectedItems: Set<string> | undefined,
): ChangePlan {
  if (selectedItems === undefined) {
    return plan;
  }

  // canonicalItemId now accepts CanonicalItemInput (a Pick of InventoryItem),
  // so ChangePlanItem satisfies it directly — no intermediate cast needed.
  const keep = (i: ChangePlanItem): boolean => selectedItems.has(canonicalItemId(i));

  const archive = plan.archive.filter(keep);
  const disable = plan.disable.filter(keep);
  const flag = plan.flag.filter(keep);

  const counts = {
    agents: archive.filter((i) => i.category === 'agent').length,
    skills: archive.filter((i) => i.category === 'skill').length,
    mcp: disable.length,
    memory: flag.length,
  };

  const filtered: ChangePlan = { archive, disable, flag, counts, savings: { tokens: 0 } };
  filtered.savings.tokens = calculateDryRunSavings(filtered);
  return filtered;
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

  describe('filterChangePlan', () => {
    // Build a plan with 3 items: agent A, agent B, mcp C
    function makePlan3() {
      return buildChangePlan([
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'agentA' }),
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'agentB' }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'mcpC' }),
      ]);
    }

    it('Test 1: undefined selectedItems returns the plan unchanged (reference-equal)', () => {
      const plan = makePlan3();
      const result = filterChangePlan(plan, undefined);
      expect(result).toBe(plan);
    });

    it('Test 2: Set with 2 of 3 ids returns only those items', () => {
      const plan = makePlan3();
      // Build canonical ids for agentA and agentB (category|scope|projectPath|path)
      const idA = `agent|global||/tmp/agentA`;
      const idB = `agent|global||/tmp/agentB`;
      const result = filterChangePlan(plan, new Set([idA, idB]));
      expect(result.archive).toHaveLength(2);
      expect(result.disable).toHaveLength(0);
      expect(result.archive.map((i) => i.name).sort()).toEqual(['agentA', 'agentB']);
    });

    it('Test 3: filtered plan has recomputed counts and savings', () => {
      const plan = buildChangePlan([
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'a1', tokens: 100 }),
        makeResult({ category: 'agent', tier: 'definite-ghost', name: 'a2', tokens: 200 }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm1', tokens: 500 }),
      ]);
      const idA1 = `agent|global||/tmp/a1`;
      // mcp-server canonical id: mcp-server|scope|projectPath|name|path
      // makeResult produces: name='m1', path='/tmp/m1', scope='global', projectPath=null
      const idM1 = `mcp-server|global||m1|/tmp/m1`;
      const result = filterChangePlan(plan, new Set([idA1, idM1]));
      // counts: 1 agent + 1 mcp
      expect(result.counts.agents).toBe(1);
      expect(result.counts.mcp).toBe(1);
      expect(result.counts.agents + result.counts.mcp).toBe(2); // == set.size
      // savings = archive(100) + disable(500) = 600
      expect(result.savings.tokens).toBe(600);
    });

    it('Test 4: empty Set returns zero-item plan with counts=0 and savings=0', () => {
      const plan = makePlan3();
      const result = filterChangePlan(plan, new Set());
      expect(result.archive).toHaveLength(0);
      expect(result.disable).toHaveLength(0);
      expect(result.flag).toHaveLength(0);
      expect(result.counts).toEqual({ agents: 0, skills: 0, mcp: 0, memory: 0 });
      expect(result.savings.tokens).toBe(0);
    });

    it('Test 5: unknown ids in the set are silently ignored (no throw)', () => {
      const plan = makePlan3();
      const unknownId = 'agent|global||/nonexistent/path';
      // Should not throw; the unknown id just matches nothing
      expect(() => filterChangePlan(plan, new Set([unknownId]))).not.toThrow();
      const result = filterChangePlan(plan, new Set([unknownId]));
      expect(result.archive).toHaveLength(0);
      expect(result.disable).toHaveLength(0);
    });
  });
}
