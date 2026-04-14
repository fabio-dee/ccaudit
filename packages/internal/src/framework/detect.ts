import type { GhostItem } from '../types.ts';
import type { DetectResult, DetectableItem, Framework } from './types.ts';
import { KNOWN_FRAMEWORKS } from './known-frameworks.ts';
import { DOMAIN_STOP_FOLDERS, STOP_PREFIXES } from './stop-lists.ts';

/**
 * Detection threshold for `knownItems[]`-based matching (REG-03).
 * When a framework has an empty `prefixes[]` (gstack), membership requires
 * at least this many `knownItems` entries to be present in the full inventory.
 */
export const KNOWN_ITEMS_THRESHOLD = 3;

// ─────────────────────────── Private helpers ───────────────────────────

/**
 * D-03 locked prefix match: case-insensitive startsWith + alphanumeric
 * boundary check. See .planning/phases/01-framework-module-data-model/01-CONTEXT.md §D-03.
 *
 * Returns true if `name` starts with `prefix` and the character immediately
 * following the prefix is alphanumeric (a-z, 0-9) — or the name length equals
 * the prefix length (exact match). Comparison is case-insensitive.
 *
 * Prefixes include their separator (e.g., 'gsd-', 'sc:'). The boundary check
 * prevents 'general-purpose' from matching a 'gen-' prefix, 'scpi' from
 * matching 'sc:', and bare 'gsd' from matching 'gsd-'. This closes Pitfall 1
 * from .planning/research/PITFALLS.md.
 */
function prefixMatches(name: string, prefix: string): boolean {
  const n = name.toLowerCase();
  const p = prefix.toLowerCase();
  if (!n.startsWith(p)) return false;
  if (n.length === p.length) return true;
  const next = n.charCodeAt(p.length);
  // Alphanumeric: 0-9 (48-57) or a-z (97-122) — lowercased
  return (next >= 48 && next <= 57) || (next >= 97 && next <= 122);
}

/**
 * Returns true if the normalized item path contains `/<folder>/` as an
 * exact path segment. Normalizes backslashes for cross-platform correctness
 * (Pitfall 4).
 */
function pathContainsFolder(itemPath: string, folder: string): boolean {
  return itemPath.replace(/\\/g, '/').includes(`/${folder}/`);
}

/**
 * REG-03 knownItems detection. Returns true when:
 *   1. `itemName` is in the framework's `knownItems[]` list, AND
 *   2. at least KNOWN_ITEMS_THRESHOLD (3) entries from `knownItems[]` are
 *      present in the full `allItems` inventory.
 *
 * Used exclusively by frameworks like gstack that ship items with no
 * consistent prefix. An item matching by knownItems but lacking the
 * cohort of 3+ siblings stays ungrouped — this avoids false positives
 * from single common names (e.g., `office-hours` collision).
 */
function knownItemsMatch(
  itemName: string,
  knownItems: string[],
  allItems: DetectableItem[],
  categories: Framework['categories'],
): boolean {
  if (knownItems.length === 0) return false;
  if (!knownItems.includes(itemName)) return false;
  // Count DISTINCT knownItems names present in the inventory, filtered to the
  // framework's own target categories.
  //
  // Why DISTINCT: an item like `office-hours` can legitimately exist in both
  // global (~/.claude/skills/office-hours.md) and project
  // (<proj>/.claude/skills/office-hours.md) scope — two DetectableItem
  // entries, same name. Counting raw entries would double-credit that single
  // sibling and let KNOWN_ITEMS_THRESHOLD be satisfied by as few as 2 unique
  // gstack names installed in both scopes, producing a false-positive match.
  //
  // Why category-filtered: each framework declares the categories it targets
  // (e.g., gstack.categories === ['skill']). An agent that happens to share
  // a gstack knownItem name must NOT inflate the skill cohort — otherwise a
  // user with a couple of gstack skills plus an unrelated `ship.md` agent
  // could over-count and trigger a false positive on an unrelated skill.
  const presentNames = new Set<string>();
  for (const candidate of allItems) {
    if (categories.includes(candidate.category) && knownItems.includes(candidate.name)) {
      presentNames.add(candidate.name);
    }
  }
  return presentNames.size >= KNOWN_ITEMS_THRESHOLD;
}

// ─────────────────────────── Public API ───────────────────────────

/**
 * Detects whether a single inventory item belongs to a curated framework.
 *
 * 3-tier resolution:
 *   Tier 1 (this function): curated registry iteration in first-match-wins
 *     order (D-04). For each entry, attempt prefix match, then folder match,
 *     then knownItems match. First success wins and returns
 *     `{ id, source_type: 'curated' }`.
 *   Tier 2 (heuristic prefix clustering): NOT implemented here. Handled by
 *     `groupByFramework` in group.ts because heuristic clustering operates
 *     on a collection of items, not a single item.
 *   Tier 3 (ungrouped): return null.
 *
 * Scope limit (DETECT-09): `category === 'agent' | 'skill' | 'command'`
 * items are eligible. Memory files and MCP servers always return null.
 * (v1.3.0: agent+skill only. v1.4.0 Phase 3 extended scope to include commands,
 * matching `categories: [..., 'command']` declared in the framework registry.)
 *
 * Purity (DETECT-08): zero I/O, zero async, zero filesystem access. All
 * operations are in-memory string matching on inputs.
 *
 * @param item - The candidate item to classify (any DetectableItem — InventoryItem and GhostItem both qualify).
 * @param allItems - Full inventory snapshot of detectable items (required for the knownItems threshold).
 * @param registry - Curated registry to consult. Defaults to `KNOWN_FRAMEWORKS`.
 * @returns `DetectResult` on match, or `null` when the item is not part of
 *          any curated framework.
 */
export function detectFramework(
  item: DetectableItem,
  allItems: DetectableItem[],
  registry: Framework[] = KNOWN_FRAMEWORKS,
): DetectResult | null {
  // DETECT-09: scope limit. Phase 3 widened to include 'command' — registry
  // entries for gsd/superclaude/ralph-loop/agent-council/greg-strategy/ideabrowser
  // already declare `categories: [..., 'command']`, so framework attribution
  // works transparently for slash commands. Memory and MCP still excluded
  // (frameworks don't target those categories).
  if (item.category !== 'agent' && item.category !== 'skill' && item.category !== 'command')
    return null;

  // Tier 1: curated list, first-match-wins (D-04). Iterate registry in
  // declaration order. Each entry tries prefix → folder → knownItems.
  for (const fw of registry) {
    // Respect per-framework category targeting. Each registry entry declares
    // `categories: Array<'agent'|'skill'|...>` — skipping frameworks that do
    // not target the current item's category prevents cross-category leaks
    // (e.g., an `agent` named `office-hours` classifying as `gstack`, which
    // declares `categories: ['skill']`).
    if (!fw.categories.includes(item.category)) continue;

    // Prefix match (DETECT-02 + D-03 boundary)
    for (const prefix of fw.prefixes) {
      if (prefixMatches(item.name, prefix)) {
        return { id: fw.id, source_type: 'curated' };
      }
    }
    // Folder match (DETECT-05 — curated-only)
    for (const folder of fw.folders) {
      if (pathContainsFolder(item.path, folder)) {
        return { id: fw.id, source_type: 'curated' };
      }
    }
    // knownItems match (REG-03). Pass fw.categories so the cohort count also
    // respects per-framework targeting (see knownItemsMatch for rationale).
    if (fw.knownItems && fw.knownItems.length > 0) {
      if (knownItemsMatch(item.name, fw.knownItems, allItems, fw.categories)) {
        return { id: fw.id, source_type: 'curated' };
      }
    }
  }

  // Tier 2 is handled by groupByFramework. Tier 3: return null.
  return null;
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  // DOMAIN_STOP_FOLDERS and STOP_PREFIXES are imported at the top of the
  // module. Bundle impact is negligible (<1KB of `Set<string>` constants)
  // and the project is ESM-only (no `require()` available in the vitest
  // runtime). Top-level imports are the correct pattern here.

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

  describe('detectFramework — Tier 1 curated prefix match (DETECT-02, D-03)', () => {
    it('matches gsd- prefix → gsd framework', () => {
      const item = makeItem({ name: 'gsd-planner' });
      expect(detectFramework(item, [item])).toEqual({ id: 'gsd', source_type: 'curated' });
    });

    it('matches gsd: prefix → gsd framework', () => {
      const item = makeItem({ name: 'gsd:executor', category: 'skill' });
      expect(detectFramework(item, [item])).toEqual({ id: 'gsd', source_type: 'curated' });
    });

    it('matches sc: prefix (SuperClaude)', () => {
      const item = makeItem({ name: 'sc:build', category: 'skill' });
      expect(detectFramework(item, [item])).toEqual({ id: 'superclaude', source_type: 'curated' });
    });

    it('is case-insensitive (uppercase still matches)', () => {
      const item = makeItem({ name: 'GSD-PLANNER' });
      expect(detectFramework(item, [item])).toEqual({ id: 'gsd', source_type: 'curated' });
    });

    it('does NOT match bare "gsd" — D-03 boundary check', () => {
      const item = makeItem({ name: 'gsd' });
      expect(detectFramework(item, [item])).toBeNull();
    });

    it('does NOT match "gsdrag" — no separator → boundary check rejects', () => {
      // 'gsd-' prefix is 4 chars; at position 4 we have 'r' (alphanumeric),
      // but name.startsWith('gsd-') is false because char[3] is 'r' not '-'.
      const item = makeItem({ name: 'gsdrag' });
      expect(detectFramework(item, [item])).toBeNull();
    });

    it('does NOT match "general-purpose" on a hypothetical "gen-" prefix — Pitfall 1 guard', () => {
      // Construct a synthetic registry with prefix 'gen-' and verify that
      // 'general-purpose' does NOT match ('e' at position 4, alphanumeric,
      // but 'gen-' is not a prefix of 'general-purpose' — 'general' != 'gen-').
      const syntheticRegistry: Framework[] = [
        {
          id: 'gen',
          displayName: 'Gen',
          description: 'synthetic',
          prefixes: ['gen-'],
          folders: [],
          categories: ['agent'],
          source: 'synthetic',
          source_type: 'curated',
        },
      ];
      const item = makeItem({ name: 'general-purpose' });
      expect(detectFramework(item, [item], syntheticRegistry)).toBeNull();
    });
  });

  describe('detectFramework — Tier 1 curated folder match (DETECT-05)', () => {
    it('matches /ralph/ path segment → ralph-loop framework', () => {
      const item = makeItem({
        name: 'some-skill',
        category: 'skill',
        path: '/home/user/.claude/skills/ralph/some-skill.md',
      });
      expect(detectFramework(item, [item])).toEqual({
        id: 'ralph-loop',
        source_type: 'curated',
      });
    });

    it('normalizes Windows backslash paths (Pitfall 4)', () => {
      const item = makeItem({
        name: 'some-skill',
        category: 'skill',
        path: 'C:\\Users\\dev\\.claude\\skills\\ralph\\some-skill.md',
      });
      expect(detectFramework(item, [item])).toEqual({
        id: 'ralph-loop',
        source_type: 'curated',
      });
    });

    it('does NOT match a path containing "/ralph-loop/" (not an exact segment for "ralph")', () => {
      // 'ralph' folder is declared by ralph-loop. A path with '/ralph-loop/' should NOT
      // match 'ralph' because the segment is 'ralph-loop' not 'ralph'.
      const item = makeItem({
        name: 'some-skill',
        category: 'skill',
        path: '/home/user/.claude/skills/ralph-loop/some-skill.md',
      });
      // Result may be null OR matched by a different rule — the invariant is
      // that it is NOT falsely promoted via the 'ralph' folder shortcut.
      const result = detectFramework(item, [item]);
      if (result !== null) {
        // If a match occurred, it must not be from the ralph folder shortcut
        // — and in the current registry 'ralph-loop' is not a declared folder.
        expect(result.id).not.toBe('ralph-loop');
      } else {
        expect(result).toBeNull();
      }
    });
  });

  describe('detectFramework — Tier 1 knownItems (REG-03 gstack)', () => {
    it('matches office-hours when ≥3 gstack knownItems present', () => {
      const items = [
        makeItem({ name: 'office-hours', category: 'skill' }),
        makeItem({ name: 'plan-ceo-review', category: 'skill' }),
        makeItem({ name: 'plan-eng-review', category: 'skill' }),
      ];
      expect(detectFramework(items[0]!, items)).toEqual({
        id: 'gstack',
        source_type: 'curated',
      });
    });

    it('does NOT match when only 2 gstack knownItems present (threshold=3)', () => {
      const items = [
        makeItem({ name: 'office-hours', category: 'skill' }),
        makeItem({ name: 'plan-ceo-review', category: 'skill' }),
      ];
      expect(detectFramework(items[0]!, items)).toBeNull();
    });

    it('does NOT match a random non-knownItems name even with 3+ gstack items present', () => {
      const items = [
        makeItem({ name: 'office-hours', category: 'skill' }),
        makeItem({ name: 'plan-ceo-review', category: 'skill' }),
        makeItem({ name: 'plan-eng-review', category: 'skill' }),
        makeItem({ name: 'random-other', category: 'skill' }),
      ];
      expect(detectFramework(items[3]!, items)).toBeNull();
    });

    it('does NOT count mcp-server/memory entries toward the knownItems cohort threshold', () => {
      // Regression: knownItemsMatch must filter by category='agent'|'skill' when
      // counting cohort presence. Three mcp-server entries sharing gstack
      // knownItem names must NOT push a non-knownItems agent over threshold.
      const items = [
        makeItem({ name: 'office-hours', category: 'mcp-server' }),
        makeItem({ name: 'plan-ceo-review', category: 'mcp-server' }),
        makeItem({ name: 'plan-eng-review', category: 'mcp-server' }),
        makeItem({ name: 'unrelated-agent', category: 'agent' }),
      ];
      expect(detectFramework(items[3]!, items)).toBeNull();
    });

    it('counts DISTINCT knownItems names — cross-scope duplicates do not inflate the cohort', () => {
      // Regression: a single knownItem installed in both global AND project
      // scope appears as TWO DetectableItem entries with the same `name`.
      // The cohort threshold must count distinct names (not raw entries), or
      // KNOWN_ITEMS_THRESHOLD=3 could be satisfied by just two actual gstack
      // items (one duplicated across scopes) — a false positive on a
      // prefix-less framework.
      const items = [
        // Same `office-hours` in both scopes (distinct paths).
        makeItem({
          name: 'office-hours',
          category: 'skill',
          path: '/Users/you/.claude/skills/office-hours.md',
        }),
        makeItem({
          name: 'office-hours',
          category: 'skill',
          path: '/proj/.claude/skills/office-hours.md',
        }),
        // Second distinct knownItem.
        makeItem({ name: 'plan-ceo-review', category: 'skill' }),
      ];
      // Only 2 DISTINCT knownItems names present → threshold (3) NOT met.
      expect(detectFramework(items[0]!, items)).toBeNull();
      expect(detectFramework(items[2]!, items)).toBeNull();
    });

    it('does NOT match an agent against a skill-only framework (per-fw category gate)', () => {
      // Regression: gstack declares `categories: ['skill']`. Before the
      // per-framework category gate, 3 gstack knownItems entries installed
      // as AGENTS could push an unrelated agent into gstack classification.
      // The outer gate (`if (!fw.categories.includes(item.category)) continue`)
      // and the mirrored filter inside knownItemsMatch both prevent this.
      const items = [
        makeItem({ name: 'office-hours', category: 'agent' }),
        makeItem({ name: 'plan-ceo-review', category: 'agent' }),
        makeItem({ name: 'plan-eng-review', category: 'agent' }),
      ];
      // Calling detectFramework on any of these AGENTS must return null:
      // gstack targets skills only, so the cohort never forms from agents.
      expect(detectFramework(items[0]!, items)).toBeNull();
      expect(detectFramework(items[1]!, items)).toBeNull();
      expect(detectFramework(items[2]!, items)).toBeNull();
    });

    it('matches when 3 DISTINCT knownItems names are present even with cross-scope duplicates', () => {
      // Positive guard for the fix: the unique-name cohort still matches when
      // the threshold is genuinely met, regardless of scope duplication noise.
      const items = [
        makeItem({
          name: 'office-hours',
          category: 'skill',
          path: '/Users/you/.claude/skills/office-hours.md',
        }),
        makeItem({
          name: 'office-hours',
          category: 'skill',
          path: '/proj/.claude/skills/office-hours.md',
        }),
        makeItem({ name: 'plan-ceo-review', category: 'skill' }),
        makeItem({ name: 'plan-eng-review', category: 'skill' }),
      ];
      expect(detectFramework(items[0]!, items)).toEqual({
        id: 'gstack',
        source_type: 'curated',
      });
    });
  });

  describe('detectFramework — DETECT-09 scope limit', () => {
    it('returns null for mcp-server category even if name matches gsd-', () => {
      const item = makeItem({ name: 'gsd-server', category: 'mcp-server' });
      expect(detectFramework(item, [item])).toBeNull();
    });

    it('returns null for memory category even if name matches gsd-', () => {
      const item = makeItem({ name: 'gsd-notes', category: 'memory' });
      expect(detectFramework(item, [item])).toBeNull();
    });

    it('Phase 3: returns framework for command category (e.g. sc:analyze → superclaude)', () => {
      const item = makeItem({ name: 'sc:analyze', category: 'command' });
      const result = detectFramework(item, [item]);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('superclaude');
    });

    it('Phase 3: returns framework for gsd command (e.g. gsd:plan-phase → gsd)', () => {
      const item = makeItem({ name: 'gsd:plan-phase', category: 'command' });
      const result = detectFramework(item, [item]);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('gsd');
    });
  });

  describe('detectFramework — D-04 first-match-wins ordering', () => {
    it('returns the FIRST declared registry entry when two entries share a prefix', () => {
      const synth: Framework[] = [
        {
          id: 'first',
          displayName: 'First',
          description: 'synthetic',
          prefixes: ['shared-'],
          folders: [],
          categories: ['agent'],
          source: 'synthetic',
          source_type: 'curated',
        },
        {
          id: 'second',
          displayName: 'Second',
          description: 'synthetic',
          prefixes: ['shared-'],
          folders: [],
          categories: ['agent'],
          source: 'synthetic',
          source_type: 'curated',
        },
      ];
      const item = makeItem({ name: 'shared-thing' });
      expect(detectFramework(item, [item], synth)).toEqual({
        id: 'first',
        source_type: 'curated',
      });
    });
  });

  describe('DOMAIN_STOP_FOLDERS regression guard (TEST-02 / DETECT-07)', () => {
    // Table-driven: one negative test case per DOMAIN_STOP_FOLDERS entry.
    // Fixture uses a generic item name with no curated-prefix match, so the
    // only way detection could succeed is via a folder shortcut — and that
    // is exactly what this regression test prevents.
    DOMAIN_STOP_FOLDERS.forEach((folder) => {
      it(`does not promote domain folder "${folder}" to a framework`, () => {
        const item = makeItem({
          name: 'generic-agent',
          category: 'agent',
          path: `/home/user/.claude/agents/${folder}/generic-agent.md`,
        });
        expect(detectFramework(item, [item])).toBeNull();
      });
    });
  });

  describe('STOP_PREFIXES do NOT short-circuit Tier 1 curated match', () => {
    it('curated entry with prefix "test-" still matches even though "test" is in STOP_PREFIXES', () => {
      // This proves STOP_PREFIXES is scoped to Tier 2 (heuristic) only, not Tier 1.
      const synth: Framework[] = [
        {
          id: 'testfw',
          displayName: 'Test FW',
          description: 'synthetic — test- prefix despite "test" being in STOP_PREFIXES',
          prefixes: ['test-'],
          folders: [],
          categories: ['agent'],
          source: 'synthetic',
          source_type: 'curated',
        },
      ];
      const item = makeItem({ name: 'test-agent' });
      // Pre-assert our assumption about stop-lists to keep the test honest
      expect(STOP_PREFIXES.has('test')).toBe(true);
      expect(detectFramework(item, [item], synth)).toEqual({
        id: 'testfw',
        source_type: 'curated',
      });
    });
  });

  describe('Purity invariants (DETECT-08)', () => {
    it('repeated calls with the same inputs return equal results (deterministic)', () => {
      const item = makeItem({ name: 'gsd-planner' });
      const a = detectFramework(item, [item]);
      const b = detectFramework(item, [item]);
      expect(a).toEqual(b);
    });

    it('does not mutate the input item or allItems array', () => {
      const item = makeItem({ name: 'gsd-planner' });
      const snapshot = JSON.parse(JSON.stringify(item));
      detectFramework(item, [item]);
      expect(JSON.parse(JSON.stringify(item))).toEqual(snapshot);
    });

    it('accepts an InventoryItem-shaped literal directly (D-08 narrowing regression guard)', () => {
      // Construct a literal matching the DetectableItem interface — the
      // structural superset of both InventoryItem and GhostItem. This call
      // must typecheck WITHOUT any cast. If a future change accidentally
      // re-narrows detectFramework to GhostItem, this test fails at compile
      // time, giving CI a hard stop.
      const item: DetectableItem = {
        name: 'gsd-planner',
        path: '/home/user/.claude/agents/gsd-planner.md',
        category: 'agent',
      };
      const result = detectFramework(item, [item], KNOWN_FRAMEWORKS);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('gsd');
      expect(result?.source_type).toBe('curated');
    });
  });
}
