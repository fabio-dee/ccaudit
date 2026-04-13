import type { GhostItem } from '../types.ts';
import type { Framework, FrameworkGroup, GroupedInventory } from './types.ts';
import { detectFramework } from './detect.ts';
import { KNOWN_FRAMEWORKS } from './known-frameworks.ts';
import { STOP_PREFIXES } from './stop-lists.ts';
import { computeFrameworkStatus } from './status.ts';

/** Minimum number of shared-prefix items required to form a heuristic cluster (DETECT-03). */
const HEURISTIC_MIN_CLUSTER_SIZE = 2;

/** Minimum prefix length for heuristic clustering (DETECT-03 — rejects 'ai-', 'ab-'). */
const HEURISTIC_MIN_PREFIX_LENGTH = 3;

/**
 * Computes per-group totals from member list, including real token costs
 * read from each member's `tokenEstimate` field.
 *
 * - `totalTokenCost`: sum of `tokenEstimate.tokens` across ALL members
 *   (members without `tokenEstimate` contribute 0 via `?? 0`).
 * - `ghostTokenCost`: sum of `tokenEstimate.tokens` for members where
 *   `tier !== 'used'` (i.e., likely-ghost + definite-ghost).
 *
 * Token data is populated upstream by `toGhostItems` (Phase 2) which copies
 * `TokenCostResult.tokenEstimate` onto each materialized `GhostItem`.
 * Discharges Phase 1's "Phase 2 will provide a token-enriched variant" note.
 */
function computeTotals(members: GhostItem[]): FrameworkGroup['totals'] {
  let used = 0;
  let likelyGhost = 0;
  let definiteGhost = 0;
  let ghostTokenCost = 0;
  let totalTokenCost = 0;
  for (const m of members) {
    if (m.tier === 'used') used++;
    else if (m.tier === 'likely-ghost') likelyGhost++;
    else if (m.tier === 'definite-ghost') definiteGhost++;
    const tokens = m.tokenEstimate?.tokens ?? 0;
    totalTokenCost += tokens;
    if (m.tier !== 'used') ghostTokenCost += tokens;
  }
  return {
    defined: members.length,
    used,
    likelyGhost,
    definiteGhost,
    ghostTokenCost,
    totalTokenCost,
  };
}

/**
 * One-pass heuristic prefix clustering (DETECT-03). Operates ONLY on
 * items that did not match any curated registry entry (Tier 1 residue).
 *
 * Rules:
 *   - Extract prefix via `name.split(/[-:_]/)[0].toLowerCase()`
 *   - Skip if prefix length < HEURISTIC_MIN_PREFIX_LENGTH (3)
 *   - Skip if prefix is in STOP_PREFIXES
 *   - Form a cluster only when >= HEURISTIC_MIN_CLUSTER_SIZE (2) items share a prefix
 *
 * Returns a Map<prefix, members[]>. Single-item buckets are dropped before return.
 */
function buildHeuristicGroups(
  ungrouped: GhostItem[],
  stopPrefixes: Set<string>,
): Map<string, GhostItem[]> {
  const buckets = new Map<string, GhostItem[]>();

  for (const item of ungrouped) {
    // DETECT-09: heuristic clustering only applies to agents and skills.
    // Memory/mcp-server items pass through (they'll end up in `ungrouped` below).
    if (item.category !== 'agent' && item.category !== 'skill') continue;

    const prefix = item.name.split(/[-:_]/)[0]?.toLowerCase() ?? '';
    if (prefix.length < HEURISTIC_MIN_PREFIX_LENGTH) continue;
    if (stopPrefixes.has(prefix)) continue;
    const bucket = buckets.get(prefix) ?? [];
    bucket.push(item);
    buckets.set(prefix, bucket);
  }

  // Drop singletons — a heuristic group requires >= 2 items.
  for (const [prefix, items] of buckets) {
    if (items.length < HEURISTIC_MIN_CLUSTER_SIZE) buckets.delete(prefix);
  }
  return buckets;
}

/**
 * Groups items by framework using the 3-tier hybrid algorithm.
 *
 * Tier 1: curated registry via `detectFramework` (first-match-wins, D-04).
 * Tier 2: heuristic prefix clustering over Tier 1 residue (DETECT-03).
 * Tier 3: remaining items are placed in `ungrouped`.
 *
 * Deterministic output: `frameworks[]` is sorted by `id` ascending (OUT-04).
 *
 * Token totals are zeroed in Phase 1 (see `computeTotals` note above).
 *
 * @param items - Full inventory snapshot.
 * @param registry - Curated registry to consult. Defaults to KNOWN_FRAMEWORKS.
 * @returns `{ frameworks, ungrouped }` — the former sorted deterministically.
 */
export function groupByFramework(
  items: GhostItem[],
  registry: Framework[] = KNOWN_FRAMEWORKS,
): GroupedInventory {
  // Tier 1: curated detection. Bucket items by matched framework id.
  const curatedBuckets = new Map<string, GhostItem[]>();
  const tier1Unmatched: GhostItem[] = [];

  for (const item of items) {
    const match = detectFramework(item, items, registry);
    if (match !== null) {
      const bucket = curatedBuckets.get(match.id) ?? [];
      bucket.push(item);
      curatedBuckets.set(match.id, bucket);
    } else {
      tier1Unmatched.push(item);
    }
  }

  // Tier 2: heuristic clustering over Tier 1 residue ONLY.
  // Pitfall 5 guard: do NOT pass `items` to buildHeuristicGroups — only the
  // items for which detectFramework returned null are eligible.
  const heuristicBuckets = buildHeuristicGroups(tier1Unmatched, STOP_PREFIXES);

  // Compute the set of item names that landed in a heuristic cluster.
  // Any tier1Unmatched item NOT in this set becomes part of `ungrouped`.
  const heuristicItemIdentities = new Set<GhostItem>();
  for (const members of heuristicBuckets.values()) {
    for (const m of members) heuristicItemIdentities.add(m);
  }

  const ungrouped = tier1Unmatched.filter((i) => !heuristicItemIdentities.has(i));

  // Build curated FrameworkGroup[] from buckets.
  const curatedGroups: FrameworkGroup[] = [];
  for (const [id, members] of curatedBuckets) {
    const fw = registry.find((f) => f.id === id);
    if (!fw) continue; // defensive — should never happen (id came from the registry)
    curatedGroups.push({
      id,
      displayName: fw.displayName,
      source_type: 'curated',
      members,
      totals: computeTotals(members),
      status: computeFrameworkStatus(members),
    });
  }

  // Build heuristic FrameworkGroup[] from buckets.
  const heuristicGroups: FrameworkGroup[] = [];
  for (const [prefix, members] of heuristicBuckets) {
    heuristicGroups.push({
      id: prefix,
      displayName: prefix.charAt(0).toUpperCase() + prefix.slice(1),
      source_type: 'heuristic',
      members,
      totals: computeTotals(members),
      status: computeFrameworkStatus(members),
    });
  }

  // OUT-04: deterministic sort by id asc.
  const frameworks = [...curatedGroups, ...heuristicGroups].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  return { frameworks, ungrouped };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function makeItem(overrides: Partial<GhostItem> = {}): GhostItem {
    return {
      name: 'test-item',
      path: '/home/user/.claude/agents/test-item.md',
      scope: 'global',
      category: 'agent',
      tier: 'definite-ghost',
      lastUsed: null,
      urgencyScore: 50,
      daysSinceLastUse: null,
      framework: null,
      ...overrides,
    };
  }

  describe('groupByFramework — ROADMAP SC#1 curated prefix', () => {
    it('detects gsd-planner as a curated gsd framework group', () => {
      const item = makeItem({ name: 'gsd-planner' });
      const result = groupByFramework([item]);
      expect(result.frameworks).toHaveLength(1);
      expect(result.frameworks[0]?.id).toBe('gsd');
      expect(result.frameworks[0]?.source_type).toBe('curated');
      expect(result.frameworks[0]?.members).toHaveLength(1);
      expect(result.ungrouped).toHaveLength(0);
    });
  });

  describe('groupByFramework — ROADMAP SC#2 domain folder negative', () => {
    it('does NOT promote engineering/engineering-agent to a framework', () => {
      const item = makeItem({
        name: 'engineering-agent',
        path: '/home/user/.claude/agents/engineering/engineering-agent.md',
      });
      const result = groupByFramework([item]);
      expect(result.frameworks).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(1);
      expect(result.ungrouped[0]?.name).toBe('engineering-agent');
    });
  });

  describe('groupByFramework — ROADMAP SC#3 heuristic Tier 2', () => {
    it('clusters 3 foo-* items into a heuristic foo group', () => {
      const items = [
        makeItem({ name: 'foo-one' }),
        makeItem({ name: 'foo-two' }),
        makeItem({ name: 'foo-three' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(1);
      expect(result.frameworks[0]?.id).toBe('foo');
      expect(result.frameworks[0]?.source_type).toBe('heuristic');
      expect(result.frameworks[0]?.displayName).toBe('Foo');
      expect(result.frameworks[0]?.members).toHaveLength(3);
      expect(result.ungrouped).toHaveLength(0);
    });

    it('does NOT cluster a singleton bar-solo', () => {
      const items = [makeItem({ name: 'bar-solo' })];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(1);
    });

    it('clusters exactly 2 scrape-* items (min cluster size = 2)', () => {
      const items = [makeItem({ name: 'scrape-today' }), makeItem({ name: 'scrape-weekly' })];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(1);
      expect(result.frameworks[0]?.id).toBe('scrape');
      expect(result.frameworks[0]?.source_type).toBe('heuristic');
      expect(result.frameworks[0]?.members).toHaveLength(2);
    });

    it('rejects STOP_PREFIXES clusters (api-caller + api-client stay ungrouped)', () => {
      const items = [makeItem({ name: 'api-caller' }), makeItem({ name: 'api-client' })];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(2);
    });

    it('rejects prefix length < 3 (ai-X items stay ungrouped even with many siblings)', () => {
      const items = [
        makeItem({ name: 'ai-one' }),
        makeItem({ name: 'ai-two' }),
        makeItem({ name: 'ai-three' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(3);
    });

    it('recognizes -, :, _ as separators for prefix extraction', () => {
      const items = [
        makeItem({ name: 'widget-one' }),
        makeItem({ name: 'widget:two' }),
        makeItem({ name: 'widget_three' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(1);
      expect(result.frameworks[0]?.id).toBe('widget');
      expect(result.frameworks[0]?.members).toHaveLength(3);
    });
  });

  describe('groupByFramework — ROADMAP SC#4 totals and status', () => {
    it('computes correct totals and partially-used status for mixed tiers (D-14: real token sums)', () => {
      const items = [
        makeItem({
          name: 'gsd-planner',
          tier: 'used',
          lastUsed: new Date(),
          daysSinceLastUse: 2,
          urgencyScore: 5,
          tokenEstimate: { tokens: 25, confidence: 'estimated', source: 'file size' },
        }),
        makeItem({
          name: 'gsd-executor',
          tier: 'definite-ghost',
          tokenEstimate: { tokens: 25, confidence: 'estimated', source: 'file size' },
        }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(1);
      const gsd = result.frameworks[0]!;
      expect(gsd.id).toBe('gsd');
      expect(gsd.totals).toEqual({
        defined: 2,
        used: 1,
        likelyGhost: 0,
        definiteGhost: 1,
        ghostTokenCost: 25,
        totalTokenCost: 50,
      });
      expect(gsd.status).toBe('partially-used');
      // Real-token assertion: ghost cost is strictly less than total cost
      // because the used member's tokens are excluded from ghost cost.
      expect(gsd.totals.ghostTokenCost).toBeLessThan(gsd.totals.totalTokenCost);
    });

    it('reports ghostTokenCost === totalTokenCost when all members are ghost (D-14)', () => {
      const items = [
        makeItem({
          name: 'gsd-a',
          tier: 'definite-ghost',
          tokenEstimate: { tokens: 30, confidence: 'estimated', source: 'file size' },
        }),
        makeItem({
          name: 'gsd-b',
          tier: 'likely-ghost',
          tokenEstimate: { tokens: 20, confidence: 'estimated', source: 'file size' },
        }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(1);
      const gsd = result.frameworks[0]!;
      expect(gsd.totals.ghostTokenCost).toBe(50);
      expect(gsd.totals.totalTokenCost).toBe(50);
      expect(gsd.totals.ghostTokenCost).toBe(gsd.totals.totalTokenCost);
    });

    it('reports fully-used when all members are used', () => {
      const items = [
        makeItem({
          name: 'gsd-a',
          tier: 'used',
          lastUsed: new Date(),
          urgencyScore: 5,
          daysSinceLastUse: 1,
        }),
        makeItem({
          name: 'gsd-b',
          tier: 'used',
          lastUsed: new Date(),
          urgencyScore: 5,
          daysSinceLastUse: 2,
        }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks[0]?.status).toBe('fully-used');
      expect(result.frameworks[0]?.totals.used).toBe(2);
    });

    it('reports ghost-all when all members are definite-ghost', () => {
      const items = [
        makeItem({ name: 'gsd-a', tier: 'definite-ghost' }),
        makeItem({ name: 'gsd-b', tier: 'definite-ghost' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks[0]?.status).toBe('ghost-all');
      expect(result.frameworks[0]?.totals.definiteGhost).toBe(2);
    });
  });

  describe('groupByFramework — OUT-04 deterministic sort', () => {
    it('sorts framework groups by id ascending', () => {
      const items = [
        makeItem({ name: 'sc:build', category: 'skill' }),
        makeItem({ name: 'gsd-planner' }),
        makeItem({ name: 'widget-one' }),
        makeItem({ name: 'widget-two' }),
      ];
      const result = groupByFramework(items);
      const ids = result.frameworks.map((f) => f.id);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });
  });

  describe('groupByFramework — Pitfall 5 guard (no double-counting)', () => {
    it('does not create a heuristic gsd group when curated gsd already matched', () => {
      const items = [makeItem({ name: 'gsd-planner' }), makeItem({ name: 'gsd-executor' })];
      const result = groupByFramework(items);
      // Exactly one framework group (curated gsd), not two (curated + heuristic).
      expect(result.frameworks).toHaveLength(1);
      expect(result.frameworks[0]?.id).toBe('gsd');
      expect(result.frameworks[0]?.source_type).toBe('curated');
      expect(result.frameworks[0]?.members).toHaveLength(2);
      expect(result.ungrouped).toHaveLength(0);
    });
  });

  describe('groupByFramework — mixed scenario (curated + heuristic + ungrouped)', () => {
    it('produces correct buckets for a mixed inventory', () => {
      const items = [
        makeItem({ name: 'gsd-planner' }),
        makeItem({ name: 'gsd-exec' }),
        makeItem({ name: 'quark-one' }),
        makeItem({ name: 'quark-two' }),
        makeItem({ name: 'solo-agent' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(2);
      const gsd = result.frameworks.find((f) => f.id === 'gsd');
      const quark = result.frameworks.find((f) => f.id === 'quark');
      expect(gsd?.source_type).toBe('curated');
      expect(gsd?.members).toHaveLength(2);
      expect(quark?.source_type).toBe('heuristic');
      expect(quark?.members).toHaveLength(2);
      expect(result.ungrouped).toHaveLength(1);
      expect(result.ungrouped[0]?.name).toBe('solo-agent');
    });
  });

  describe('groupByFramework — DETECT-09 scope limit (mcp-server passthrough)', () => {
    it('leaves mcp-server items ungrouped even when name matches a curated prefix', () => {
      const items = [
        makeItem({ name: 'gsd-server', category: 'mcp-server' }),
        makeItem({ name: 'gsd-notes', category: 'memory' }),
      ];
      const result = groupByFramework(items);
      expect(result.frameworks).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(2);
    });
  });

  describe('groupByFramework — STOP_PREFIXES exhaustive Tier 2 rejection (DETECT-06 regression guard)', () => {
    // Table-driven: one negative test case per STOP_PREFIXES entry. For each
    // stop prefix, build a 2-item cluster of `${prefix}-one` / `${prefix}-two`
    // and assert that buildHeuristicGroups drops it. This is the exhaustive
    // regression guard mirroring DOMAIN_STOP_FOLDERS.forEach in Plan 02's
    // detect.ts. STOP_PREFIXES is already imported at the top of this file
    // — no additional import required.
    STOP_PREFIXES.forEach((stopPrefix) => {
      it(`does not heuristically cluster items prefixed "${stopPrefix}-"`, () => {
        const items = [
          makeItem({ name: `${stopPrefix}-one` }),
          makeItem({ name: `${stopPrefix}-two` }),
        ];
        const result = groupByFramework(items);
        expect(result.frameworks).toHaveLength(0);
        expect(result.ungrouped).toHaveLength(2);
      });
    });
  });

  describe('groupByFramework — TEST-03 empty-input (Phase 5)', () => {
    it('groupByFramework([]) returns empty frameworks + ungrouped (TEST-03 empty-input)', () => {
      expect(groupByFramework([])).toEqual({ frameworks: [], ungrouped: [] });
    });
  });
}
