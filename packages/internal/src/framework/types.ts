import * as v from 'valibot';
import type { GhostItem } from '../types.ts';

// ─────────────────────────── Valibot schemas ───────────────────────────

/**
 * Schema for a single entry in the curated KNOWN_FRAMEWORKS registry.
 *
 * Note: `source_type` is `v.literal('curated')` here because registry entries
 * are ALWAYS curated. The value `'heuristic'` is set dynamically in
 * DetectResult for Tier 2 matches only — it never appears in the registry.
 * See .planning/research/PITFALLS.md §Pitfall 7 for the rationale.
 */
export const frameworkSchema = v.object({
  id: v.string(),
  displayName: v.string(),
  description: v.string(),
  prefixes: v.array(v.string()),
  folders: v.array(v.string()),
  knownItems: v.optional(v.array(v.string())),
  categories: v.array(
    v.picklist(['agent', 'skill', 'command', 'hook', 'mcp-server', 'memory'] as const),
  ),
  source: v.string(),
  source_type: v.literal('curated'),
});

/** Schema for the full KNOWN_FRAMEWORKS array. */
export const registrySchema = v.array(frameworkSchema);

// ─────────────────────────── Public types ───────────────────────────

/**
 * A curated framework entry. `source_type` is always `'curated'` for registry
 * entries; the dynamic `DetectResult` (returned at detection time) widens to
 * `'curated' | 'heuristic'`.
 */
export interface Framework {
  /** Stable framework id used as the group key (e.g., 'gsd', 'superclaude'). */
  id: string;
  /** User-facing display name (e.g., 'GSD (Get Shit Done)'). */
  displayName: string;
  /** One-line description shown in documentation / diagnostics. */
  description: string;
  /** Prefix strings including separator (e.g., 'gsd-', 'sc:'). May be empty (gstack). */
  prefixes: string[];
  /** Folder names to match as path segments. Only fires via curated detection (DETECT-05). */
  folders: string[];
  /** Optional list of known item names for prefix-less frameworks (gstack). Detection requires ≥3 present. */
  knownItems?: string[];
  /** Categories the framework targets. */
  categories: Array<'agent' | 'skill' | 'command' | 'hook' | 'mcp-server' | 'memory'>;
  /** URL or the literal string 'unverified'. */
  source: string;
  /** Always 'curated' for registry entries (not widened). */
  source_type: 'curated';
}

/**
 * Result returned by `detectFramework(...)`. `source_type` widens to include
 * `'heuristic'` because Tier 2 heuristic clustering emits dynamic groups
 * whose source is not the curated registry.
 */
export interface DetectResult {
  id: string;
  source_type: 'curated' | 'heuristic';
}

/**
 * Minimum shape required by `detectFramework`. The framework module owns
 * its own input contract — `GhostItem`, `InventoryItem`, and
 * `Pick<GhostItem, 'name' | 'path' | 'category'>` are all structurally
 * assignable to this interface, so no casts are required at any call site.
 *
 * Phase 2 narrowing rationale (D-08): `detectFramework`'s body only ever
 * reads `name`, `path`, and `category`. Widening the parameter type to
 * `DetectableItem` keeps the function callable from the scanner layer
 * (which speaks `InventoryItem`) without forcing the framework module to
 * import scanner types — preserving the strict module boundary.
 */
export interface DetectableItem {
  name: string;
  path: string;
  category: 'agent' | 'skill' | 'mcp-server' | 'memory' | 'command' | 'hook';
}

/**
 * Status of a framework group derived from member tiers.
 * - 'fully-used':      every member has `tier === 'used'`
 * - 'partially-used':  at least one used and at least one non-used member
 * - 'ghost-all':       no member has `tier === 'used'`
 */
export type FrameworkStatus = 'fully-used' | 'partially-used' | 'ghost-all';

/**
 * A detected framework group with aggregated totals and status.
 * Phase 1 zeroes `ghostTokenCost` / `totalTokenCost`; Phase 2 will enrich
 * them when token data is available.
 */
export interface FrameworkGroup {
  id: string;
  displayName: string;
  source_type: 'curated' | 'heuristic';
  members: GhostItem[];
  totals: {
    defined: number;
    used: number;
    likelyGhost: number;
    definiteGhost: number;
    ghostTokenCost: number;
    totalTokenCost: number;
  };
  status: FrameworkStatus;
}

/** Return shape of `groupByFramework(...)`. */
export interface GroupedInventory {
  frameworks: FrameworkGroup[];
  ungrouped: GhostItem[];
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const VALID_ENTRY: Framework = {
    id: 'gsd',
    displayName: 'GSD (Get Shit Done)',
    description: 'Spec-driven development with atomic phases.',
    prefixes: ['gsd-', 'gsd:'],
    folders: ['gsd'],
    categories: ['agent', 'skill', 'command'],
    source: 'https://github.com/gsd-build/get-shit-done',
    source_type: 'curated',
  };

  describe('frameworkSchema', () => {
    it('accepts a valid entry', () => {
      const result = v.safeParse(frameworkSchema, VALID_ENTRY);
      expect(result.success).toBe(true);
    });

    it('accepts an entry with optional knownItems', () => {
      const withKnownItems = { ...VALID_ENTRY, id: 'gstack', prefixes: [], knownItems: ['a', 'b'] };
      const result = v.safeParse(frameworkSchema, withKnownItems);
      expect(result.success).toBe(true);
    });

    it('rejects an entry missing id', () => {
      const { id: _id, ...noId } = VALID_ENTRY;
      const result = v.safeParse(frameworkSchema, noId);
      expect(result.success).toBe(false);
    });

    it("rejects an entry with source_type: 'heuristic' (registry is curated-only)", () => {
      const bad = { ...VALID_ENTRY, source_type: 'heuristic' };
      const result = v.safeParse(frameworkSchema, bad);
      expect(result.success).toBe(false);
    });

    it('rejects an entry with an invalid category', () => {
      const bad = { ...VALID_ENTRY, categories: ['invalid-cat'] };
      const result = v.safeParse(frameworkSchema, bad);
      expect(result.success).toBe(false);
    });
  });

  describe('registrySchema', () => {
    it('accepts an array of valid entries', () => {
      const result = v.safeParse(registrySchema, [VALID_ENTRY, { ...VALID_ENTRY, id: 'sc' }]);
      expect(result.success).toBe(true);
    });

    it('rejects an array containing a malformed entry', () => {
      const result = v.safeParse(registrySchema, [VALID_ENTRY, { ...VALID_ENTRY, id: 123 }]);
      expect(result.success).toBe(false);
    });
  });

  describe('FrameworkStatus', () => {
    it('accepts all three literal values', () => {
      const states: FrameworkStatus[] = ['fully-used', 'partially-used', 'ghost-all'];
      expect(states).toHaveLength(3);
    });
  });
}
