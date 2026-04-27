import type { Framework, DetectableItem } from '../framework/types.ts';
import type { TokenCostResult } from '../token/types.ts';
import type { GhostItem } from '../types.ts';
import type { InventoryItem, FrameworkProtection } from './types.ts';
import { detectFramework } from '../framework/detect.ts';
import { KNOWN_FRAMEWORKS } from '../framework/known-frameworks.ts';
import { groupByFramework } from '../framework/group.ts';

/**
 * Annotates agent and skill items with their `framework` field using the
 * Phase 1 `detectFramework` function. Pure transform — returns a NEW array
 * of NEW objects without mutating the input.
 *
 * Behavior:
 * - **Empty registry path (SCAN-04 byte-identical bypass):** When `registry`
 *   is an empty array, every item is shallow-cloned via `{ ...item }`
 *   WITHOUT setting the `framework` key. This preserves byte-identical
 *   v1.2.1 JSON output (verified: `JSON.stringify({framework: undefined})`
 *   omits the key, while `JSON.stringify({framework: null})` adds it).
 * - **Scope-excluded items (DETECT-09):** Memory and MCP-server items are
 *   shallow-cloned via `{ ...item }` WITHOUT setting the `framework` key,
 *   for the same byte-identical reason. Detection only runs for `agent`
 *   and `skill` categories per DETECT-09.
 * - **Agent/skill detection path:** For each eligible item, `detectFramework`
 *   is called with the full pre-filtered items array as `allItems` (the
 *   knownItems threshold semantic — gstack-style detection requires
 *   ≥3 known items present, scoped to agents+skills). The result either
 *   sets `framework: <id>` (curated match) or `framework: null` (no match).
 *   This is the ONLY branch that ADDS the `framework` key to the output.
 *
 * The pre-filtered `items` array is passed as `allItems` rather than a
 * separate full-inventory snapshot because the caller in `scan-all.ts`
 * (Plan 02-03) intentionally subsets to agents+skills before calling
 * annotate (per D-10), making the DETECT-09 scope visible at the call site.
 *
 * @param items - Array of inventory items to annotate. Typically the
 *   concatenation of `agentItems` and `skillItems` from `scan-all.ts`.
 * @param registry - Curated framework registry. Defaults to
 *   `KNOWN_FRAMEWORKS`. Pass `[]` to bypass detection (SCAN-04).
 * @returns A new array of new InventoryItem objects. Original input
 *   untouched.
 */
export function annotateFrameworks(
  items: InventoryItem[],
  registry: Framework[] = KNOWN_FRAMEWORKS,
): InventoryItem[] {
  // Empty-registry bypass (SCAN-04 byte-identical): shallow clones, no
  // framework key set. Preserves v1.2.1 JSON output exactly.
  if (registry.length === 0) {
    return items.map((item) => ({ ...item }));
  }

  // Pre-filter to agents+skills ONCE before the map. Defense-in-depth at
  // the caller layer: even though detectFramework's knownItemsMatch reducer
  // also filters by category, passing a clean cohort here keeps the intent
  // explicit and removes the unclean mixed-category cast previously used
  // inline (`items as DetectableItem[]`). Computed outside the loop so the
  // filter pass is O(n) rather than O(n) per iteration.
  const detectable = items.filter(
    (i) => i.category === 'agent' || i.category === 'skill',
  ) as DetectableItem[];

  return items.map((item) => {
    // DETECT-09 scope limit: memory and mcp-server items pass through
    // unchanged. Shallow clone WITHOUT a framework key keeps the
    // byte-identical invariant valid for mixed-category inputs.
    if (item.category !== 'agent' && item.category !== 'skill') {
      return { ...item };
    }
    const result = detectFramework(item, detectable, registry);
    return { ...item, framework: result?.id ?? null };
  });
}

/**
 * Materializes `GhostItem[]` from post-classification, token-enriched
 * `TokenCostResult[]`. Used by Phase 3 (display) and Phase 4 (bust) to
 * feed `groupByFramework`, which requires `GhostItem[]` per Phase 1's
 * locked signature (D-08 narrowed `detectFramework` only, not
 * `groupByFramework`).
 *
 * Field mapping:
 * - `name`, `path`, `scope`, `category`, `tier`, `lastUsed` — direct from
 *   the source `TokenCostResult` and its embedded `item`.
 * - `urgencyScore` — stubbed `0`. None of the framework code path consumers
 *   (`computeTotals`, `groupByFramework`, `computeFrameworkStatus`) read
 *   urgency. Avoiding a real call to `calculateUrgencyScore` keeps the
 *   scanner module free of `report/` imports (verified clean by grep).
 * - `daysSinceLastUse` — computed inline from `r.lastUsed` using the same
 *   formula as `report/urgency-score.ts`.
 * - `framework` — copied from `r.item.framework ?? null`. Reads the
 *   annotation done by `annotateFrameworks` earlier in the pipeline.
 * - `tokenEstimate` — direct from `r.tokenEstimate` (TokenCostResult
 *   already carries this from `enrichScanResults`).
 * - `projectPath` — silently dropped. `GhostItem` has no `projectPath`
 *   field, and v1.3.0 framework grouping is global-scope only.
 *
 * @param results - Token-enriched scan results from `enrichScanResults`.
 * @returns Newly constructed GhostItem array. Pure function.
 */
export function toGhostItems(results: TokenCostResult[]): GhostItem[] {
  // First pass: materialize plain GhostItems (no protection yet). Framework
  // grouping needs the tiered items, so we compute protection in a second
  // pass below.
  const base: GhostItem[] = results.map((r): GhostItem => {
    const item: GhostItem = {
      name: r.item.name,
      path: r.item.path,
      scope: r.item.scope,
      category: r.item.category,
      tier: r.tier,
      lastUsed: r.lastUsed,
      urgencyScore: 0,
      daysSinceLastUse:
        r.lastUsed === null ? null : Math.floor((Date.now() - r.lastUsed.getTime()) / 86_400_000),
      framework: r.item.framework ?? null,
      tokenEstimate: r.tokenEstimate,
    };
    // Phase 6 (D6-02): propagate configRefs from the InventoryItem to the
    // GhostItem so downstream TUI layers can read it directly. Only set
    // when present — keeps JSON output byte-identical for non-MCP items.
    if (r.item.configRefs !== undefined) {
      item.configRefs = r.item.configRefs;
    }
    return item;
  });

  // Second pass (Phase 6 / D6-01): compute framework-as-unit protection.
  // A member of a `partially-used` framework group (has BOTH used and
  // ghost members) carries `protection` — its ghost subset is what INV-S6
  // would block under a partial bust. `fully-used` / `ghost-all` groups
  // do NOT get the annotation because partial split is not possible (no
  // ghost members) or already implied (no used members to protect).
  //
  // Rationale for applying to all members of a protected framework (not
  // only ghosts): the picker needs to dim the whole framework row group
  // when `--force-partial` is off; the toggle guard rejects any toggle on
  // a protected item. Used members are effectively "locked in" too.
  const grouped = groupByFramework(base);
  const protectionByPath = new Map<string, FrameworkProtection>();
  for (const fw of grouped.frameworks) {
    if (fw.status !== 'partially-used') continue;
    const ghostCount = fw.totals.likelyGhost + fw.totals.definiteGhost;
    const protection: FrameworkProtection = {
      framework: fw.id,
      total: fw.totals.defined,
      ghostCount,
      // Canonical reason string — the picker row (plan 02) reads this
      // verbatim. Wording mirrors D6-05.
      reason: `Part of ${fw.displayName} (${fw.totals.used} used, ${ghostCount} ghost). --force-partial to override.`,
    };
    for (const m of fw.members) {
      protectionByPath.set(m.path, protection);
    }
  }

  if (protectionByPath.size === 0) return base;
  return base.map((g) => {
    const p = protectionByPath.get(g.path);
    return p === undefined ? g : { ...g, protection: p };
  });
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Reusable factory for InventoryItem fixtures
  function makeItem(
    overrides: Partial<InventoryItem> & Pick<InventoryItem, 'name' | 'category'>,
  ): InventoryItem {
    return {
      path: `/mock/${overrides.category}/${overrides.name}`,
      scope: 'global',
      projectPath: null,
      ...overrides,
    };
  }

  // Reusable factory for TokenCostResult fixtures
  function makeResult(
    name: string,
    tier: 'used' | 'likely-ghost' | 'definite-ghost',
    overrides?: Partial<TokenCostResult>,
  ): TokenCostResult {
    return {
      item: {
        name,
        path: `/mock/agent/${name}`,
        scope: 'global',
        category: 'agent',
        projectPath: null,
        ...overrides?.item,
      },
      tier,
      lastUsed: tier === 'used' ? new Date() : null,
      invocationCount: tier === 'used' ? 1 : 0,
      tokenEstimate: { tokens: 25, confidence: 'estimated', source: 'file size' },
      ...overrides,
    };
  }

  describe('annotateFrameworks — curated detection (Tier 1)', () => {
    it('annotates a gsd- prefixed agent with framework: "gsd"', () => {
      const items = [makeItem({ name: 'gsd-planner', category: 'agent' })];
      const result = annotateFrameworks(items);
      expect(result).toHaveLength(1);
      expect(result[0]?.framework).toBe('gsd');
    });

    it('annotates an sc: prefixed skill with framework: "superclaude"', () => {
      const items = [makeItem({ name: 'sc:build', category: 'skill' })];
      const result = annotateFrameworks(items);
      expect(result[0]?.framework).toBe('superclaude');
    });

    it('annotates a curated-folder match (e.g., gsd folder segment)', () => {
      const items = [
        makeItem({
          name: 'planner',
          category: 'agent',
          path: '/home/user/.claude/agents/gsd/planner.md',
        }),
      ];
      const result = annotateFrameworks(items);
      expect(result[0]?.framework).toBe('gsd');
    });
  });

  describe('annotateFrameworks — DETECT-09 scope limit + null detection', () => {
    it('passes mcp-server items through without setting framework key (byte-identical)', () => {
      const items = [
        makeItem({
          name: 'gsd-server',
          category: 'mcp-server',
          path: '/home/user/.claude.json',
        }),
      ];
      const result = annotateFrameworks(items);
      expect(result[0]?.framework).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result[0], 'framework')).toBe(false);
    });

    it('passes memory items through without setting framework key (byte-identical)', () => {
      const items = [
        makeItem({
          name: 'CLAUDE.md',
          category: 'memory',
          path: '/Users/test/project/CLAUDE.md',
        }),
      ];
      const result = annotateFrameworks(items);
      expect(result[0]?.framework).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result[0], 'framework')).toBe(false);
    });

    it('pre-filters mcp-server items out of the detectable cohort (caller-layer defense-in-depth)', () => {
      // Regression for the annotate.ts pre-filter: even when mcp-server
      // items share names with a known prefix-less framework's knownItems
      // (e.g. gstack: "ship", "qa", "review"), they must NOT be counted
      // toward an unrelated agent's knownItems threshold. The unrelated
      // agent has no curated signal of its own and must stay null.
      const items = [
        makeItem({ name: 'ship', category: 'mcp-server' }),
        makeItem({ name: 'qa', category: 'mcp-server' }),
        makeItem({ name: 'review', category: 'mcp-server' }),
        makeItem({ name: 'unrelated-helper', category: 'agent' }),
      ];
      const result = annotateFrameworks(items);
      const agent = result.find((r) => r.name === 'unrelated-helper');
      expect(agent?.framework).toBeNull();
      // mcp-server items still pass through with no framework key.
      const mcp = result.filter((r) => r.category === 'mcp-server');
      for (const r of mcp) {
        expect(Object.prototype.hasOwnProperty.call(r, 'framework')).toBe(false);
      }
    });

    it('sets framework: null on agent items that match neither curated prefix nor folder', () => {
      // foo- is a heuristic cluster — Phase 2 uses detectFramework only
      // (Tier 1 curated). Heuristic clustering belongs to groupByFramework.
      // With a populated registry, the agent path always SETS the key,
      // either to a framework id or to null.
      const items = [
        makeItem({ name: 'foo-one', category: 'agent' }),
        makeItem({ name: 'foo-two', category: 'agent' }),
        makeItem({ name: 'foo-three', category: 'agent' }),
      ];
      const result = annotateFrameworks(items);
      for (const r of result) {
        expect(r.framework).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(r, 'framework')).toBe(true);
      }
    });
  });

  describe('annotateFrameworks — empty-registry bypass (SCAN-04 byte-identical)', () => {
    it('returns shallow clones WITHOUT framework key for every item', () => {
      const items = [
        makeItem({ name: 'gsd-planner', category: 'agent' }),
        makeItem({ name: 'sc:build', category: 'skill' }),
        makeItem({ name: 'engineering-agent', category: 'agent' }),
        makeItem({ name: 'random-mcp', category: 'mcp-server' }),
        makeItem({ name: 'CLAUDE.md', category: 'memory' }),
      ];
      const result = annotateFrameworks(items, []);
      expect(result).toHaveLength(items.length);
      for (const r of result) {
        // CRITICAL: undefined, NOT null. The key must not exist.
        expect(r.framework).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(r, 'framework')).toBe(false);
      }
    });

    it('JSON.stringify of bypass output omits framework key entirely', () => {
      const items = [makeItem({ name: 'gsd-planner', category: 'agent' })];
      const result = annotateFrameworks(items, []);
      const json = JSON.stringify(result[0]);
      expect(json).not.toContain('framework');
      expect(json).not.toContain('"framework":null');
    });
  });

  describe('annotateFrameworks — pure transform invariant (D-16)', () => {
    it('does not mutate the input array or its items', () => {
      const original = [
        makeItem({ name: 'gsd-planner', category: 'agent' }),
        makeItem({ name: 'foo-bar', category: 'agent' }),
      ];
      const beforeSnapshot = JSON.parse(JSON.stringify(original));
      const result = annotateFrameworks(original);

      // Different array reference
      expect(result).not.toBe(original);
      // Different element references (pure transform constructs new objects)
      expect(result[0]).not.toBe(original[0]);
      expect(result[1]).not.toBe(original[1]);
      // Original array deep equality preserved
      expect(JSON.parse(JSON.stringify(original))).toEqual(beforeSnapshot);
      // Original items have no framework field after the call
      expect(Object.prototype.hasOwnProperty.call(original[0], 'framework')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(original[1], 'framework')).toBe(false);
    });
  });

  describe('toGhostItems — field mapping', () => {
    it('round-trips name/path/scope/category/tier/lastUsed/framework/tokenEstimate', () => {
      const lastUsed = new Date('2026-04-01T00:00:00Z');
      const result = toGhostItems([
        makeResult('gsd-planner', 'used', {
          item: {
            name: 'gsd-planner',
            path: '/home/user/.claude/agents/gsd-planner.md',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
          lastUsed,
          tokenEstimate: { tokens: 42, confidence: 'measured', source: 'live mcp' },
        }),
      ]);
      expect(result).toHaveLength(1);
      const g = result[0]!;
      expect(g.name).toBe('gsd-planner');
      expect(g.path).toBe('/home/user/.claude/agents/gsd-planner.md');
      expect(g.scope).toBe('global');
      expect(g.category).toBe('agent');
      expect(g.tier).toBe('used');
      expect(g.lastUsed).toBe(lastUsed);
      expect(g.framework).toBe('gsd');
      expect(g.tokenEstimate).toEqual({ tokens: 42, confidence: 'measured', source: 'live mcp' });
    });

    it("stubs urgencyScore to 0 (Claude's Discretion — no scanner→report dep)", () => {
      const result = toGhostItems([makeResult('any-agent', 'definite-ghost')]);
      expect(result[0]?.urgencyScore).toBe(0);
    });

    it('computes daysSinceLastUse from lastUsed (null when never used)', () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
      const used = toGhostItems([makeResult('used-agent', 'used', { lastUsed: tenDaysAgo })]);
      expect(used[0]?.daysSinceLastUse).toBe(10);

      const never = toGhostItems([makeResult('ghost-agent', 'definite-ghost')]);
      expect(never[0]?.daysSinceLastUse).toBeNull();
    });

    it('coerces undefined item.framework to null on the GhostItem', () => {
      // Empty-registry bypass produced an InventoryItem without the
      // framework key. toGhostItems must turn that into framework: null
      // on the GhostItem (because GhostItem's framework field is
      // declared as optional-or-nullable).
      const r = makeResult('mcp-thing', 'definite-ghost', {
        item: {
          name: 'mcp-thing',
          path: '/x',
          scope: 'global',
          category: 'mcp-server',
          projectPath: null,
          // no framework key
        },
      });
      const result = toGhostItems([r]);
      expect(result[0]?.framework).toBeNull();
    });

    it('returns empty array for empty input', () => {
      expect(toGhostItems([])).toEqual([]);
    });

    it('attaches protection to members of a partially-used framework (Phase 6, D6-01)', () => {
      // gsd framework: 1 used + 1 ghost member → partially-used → protection.
      const results: TokenCostResult[] = [
        makeResult('gsd-planner', 'used', {
          item: {
            name: 'gsd-planner',
            path: '/mock/agent/gsd-planner',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
        }),
        makeResult('gsd-executor', 'definite-ghost', {
          item: {
            name: 'gsd-executor',
            path: '/mock/agent/gsd-executor',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
        }),
      ];
      const ghostItems = toGhostItems(results);
      expect(ghostItems).toHaveLength(2);
      for (const g of ghostItems) {
        expect(g.protection).toBeDefined();
        expect(g.protection?.framework).toBe('gsd');
        expect(g.protection?.total).toBe(2);
        expect(g.protection?.ghostCount).toBe(1);
        expect(g.protection?.reason).toBe(
          'Part of GSD (Get Shit Done) (1 used, 1 ghost). --force-partial to override.',
        );
      }
    });

    it('does NOT attach protection when every member is ghost (ghost-all)', () => {
      const results: TokenCostResult[] = [
        makeResult('gsd-a', 'definite-ghost', {
          item: {
            name: 'gsd-a',
            path: '/mock/agent/gsd-a',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
        }),
        makeResult('gsd-b', 'definite-ghost', {
          item: {
            name: 'gsd-b',
            path: '/mock/agent/gsd-b',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
        }),
      ];
      const ghostItems = toGhostItems(results);
      for (const g of ghostItems) {
        expect(g.protection).toBeUndefined();
      }
    });

    it('does NOT attach protection when every member is used (fully-used)', () => {
      const used = new Date();
      const results: TokenCostResult[] = [
        makeResult('gsd-a', 'used', {
          item: {
            name: 'gsd-a',
            path: '/mock/agent/gsd-a',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
          lastUsed: used,
        }),
        makeResult('gsd-b', 'used', {
          item: {
            name: 'gsd-b',
            path: '/mock/agent/gsd-b',
            scope: 'global',
            category: 'agent',
            projectPath: null,
            framework: 'gsd',
          },
          lastUsed: used,
        }),
      ];
      const ghostItems = toGhostItems(results);
      for (const g of ghostItems) {
        expect(g.protection).toBeUndefined();
      }
    });

    it('propagates configRefs from InventoryItem onto the GhostItem (Phase 6, D6-02)', () => {
      const r: TokenCostResult = {
        item: {
          name: 'foo',
          path: '/mock/mcp/foo',
          scope: 'global',
          category: 'mcp-server',
          projectPath: null,
          configRefs: ['.mcp.json', '~/.claude.json'],
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'default' },
      };
      const [g] = toGhostItems([r]);
      expect(g?.configRefs).toEqual(['.mcp.json', '~/.claude.json']);
    });

    it('drops projectPath silently (GhostItem has no such field)', () => {
      const r = makeResult('proj-agent', 'definite-ghost', {
        item: {
          name: 'proj-agent',
          path: '/proj/agent',
          scope: 'project',
          category: 'agent',
          projectPath: '/Users/test/project',
        },
      });
      const result = toGhostItems([r]);
      // Type-level: GhostItem has no projectPath field. Runtime: it
      // simply isn't copied. Verify by checking the keys.
      expect(Object.prototype.hasOwnProperty.call(result[0], 'projectPath')).toBe(false);
    });
  });
}
