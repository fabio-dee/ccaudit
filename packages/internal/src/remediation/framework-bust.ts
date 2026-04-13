import type { TokenCostResult } from '../token/types.ts';
import type { FrameworkStatus, FrameworkGroup } from '../framework/types.ts';
import { groupByFramework } from '../framework/index.ts';
import { toGhostItems } from '../scanner/annotate.ts';

/**
 * Options controlling framework-as-unit bust protection.
 *
 * Both fields are required (not optional) so callers must explicitly state
 * intent — there is no implicit default that could silently change semantics
 * across releases.
 */
export interface FrameworkBustOptions {
  /**
   * If true, bypass protection for `partially-used` frameworks. Ghost members
   * of partially-used frameworks flow through to `filtered` and the warnings
   * list is still populated for the audit trail. Default: false.
   */
  forcePartial: boolean;
  /**
   * If false, framework grouping (and therefore protection) is disabled
   * entirely — the helper short-circuits to a pass-through. Mirrors the
   * Phase 3 D-22 `--no-group-frameworks` escape hatch.
   */
  groupFrameworks: boolean;
}

/**
 * One audit-trail entry per framework that triggered protection. Carries no
 * filesystem paths so it requires no privacy-mode redaction (OUT-05).
 */
export interface ProtectedFrameworkWarning {
  /** Stable framework registry id (e.g., 'gsd', 'superclaude'). */
  frameworkId: string;
  /** Human-readable display name from the curated registry. */
  displayName: string;
  /** Always 'partially-used' for v1.3.0. fully-used frameworks are excluded. */
  status: FrameworkStatus;
  /** Number of members with `tier === 'used'`. */
  activeMembers: number;
  /** Number of ghost members removed from the filtered list. */
  protectedGhostMembers: number;
}

/**
 * Result of applying framework-as-unit bust protection.
 *
 * `filtered` is the eligible set that downstream consumers
 * (`buildChangePlan`, `computeGhostHash`) operate on. Both the dry-run and
 * bust paths must pass `filtered` (NOT the original `enriched`) into those
 * consumers so checkpoint hashes match between preview and execution.
 */
export interface FrameworkBustResult {
  /** `enriched` with protected items removed. Pass this to buildChangePlan + computeGhostHash. */
  filtered: TokenCostResult[];
  /**
   * Items REMOVED from `filtered` because their framework was protected.
   * Always `tier !== 'used'`. Used by the CLI to render the PROTECTED section
   * and emit the JSON envelope `changePlan.protected[]` field.
   */
  protectedItems: TokenCostResult[];
  /** One warning per protected framework. Sorted by frameworkId ASC. */
  warnings: ProtectedFrameworkWarning[];
}

/**
 * Filter `enriched` so that ghost members of partially-used frameworks are
 * removed from the eligible bust set. Pure synchronous function — no I/O,
 * no async, no mutation of inputs.
 *
 * Algorithm (RESEARCH §1.2):
 *  1. If `opts.groupFrameworks === false` → pass-through (escape hatch).
 *  2. Materialize `GhostItem[]` via `toGhostItems(enriched)` over the FULL
 *     enriched list (used + ghost — needed for status computation).
 *  3. Call `groupByFramework(ghostItems)` to compute framework groups + status.
 *  4. Build a `protectedFrameworks` index of `partially-used` framework ids
 *     (fully-used has zero ghost members so it needs no protection;
 *     ghost-all has zero used members so the framework is already at risk
 *     by user choice — protection does not apply).
 *  5. If `opts.forcePartial === true` → pass-through but still emit warnings
 *     for the audit trail.
 *  6. Otherwise partition `enriched`: items whose framework id is in
 *     `protectedFrameworks` AND whose tier is NOT 'used' go to `protectedItems`;
 *     all others go to `filtered`.
 *  7. Build sorted warnings list (ASC by frameworkId, case-insensitive).
 *
 * @param enriched - Full token-enriched scan results (used + ghost tiers).
 * @param opts - `forcePartial` (override) and `groupFrameworks` (escape hatch).
 * @returns `{ filtered, protectedItems, warnings }` — see FrameworkBustResult.
 */
export function applyFrameworkProtection(
  enriched: TokenCostResult[],
  opts: FrameworkBustOptions,
): FrameworkBustResult {
  // Step 1 — escape hatch (D-39)
  if (!opts.groupFrameworks) {
    return { filtered: enriched, protectedItems: [], warnings: [] };
  }

  // Step 2-3 — materialize and group
  const ghostItems = toGhostItems(enriched);
  const grouped = groupByFramework(ghostItems);

  // Step 4 — index of frameworks that need protection.
  // ONLY partially-used per RESEARCH §5.6: fully-used has 0 ghost members,
  // ghost-all has 0 active members so protection cannot apply.
  const protectedFrameworks = new Map<string, FrameworkGroup>();
  for (const fw of grouped.frameworks) {
    if (fw.status === 'partially-used') {
      protectedFrameworks.set(fw.id, fw);
    }
  }

  // No frameworks need protection → pass-through (no warnings).
  if (protectedFrameworks.size === 0) {
    return { filtered: enriched, protectedItems: [], warnings: [] };
  }

  // Step 5 — forcePartial override: items pass through, warnings still emitted.
  if (opts.forcePartial) {
    const warnings = buildWarnings(protectedFrameworks, enriched);
    return { filtered: enriched, protectedItems: [], warnings };
  }

  // Step 6 — partition enriched into filtered vs. protectedItems.
  const filtered: TokenCostResult[] = [];
  const protectedItems: TokenCostResult[] = [];
  for (const r of enriched) {
    const fwId = r.item.framework ?? null;
    if (fwId !== null && protectedFrameworks.has(fwId) && r.tier !== 'used') {
      protectedItems.push(r);
    } else {
      filtered.push(r);
    }
  }

  // Step 7 — sorted warnings.
  const warnings = buildWarnings(protectedFrameworks, enriched);
  return { filtered, protectedItems, warnings };
}

/**
 * Build the sorted warnings array for the protected frameworks. Helper kept
 * private (not exported) since it is only used internally by
 * applyFrameworkProtection.
 */
function buildWarnings(
  protectedFrameworks: Map<string, FrameworkGroup>,
  enriched: TokenCostResult[],
): ProtectedFrameworkWarning[] {
  const entries: ProtectedFrameworkWarning[] = [];
  for (const fw of protectedFrameworks.values()) {
    const protectedGhostMembers = enriched.filter(
      (r) => (r.item.framework ?? null) === fw.id && r.tier !== 'used',
    ).length;
    entries.push({
      frameworkId: fw.id,
      displayName: fw.displayName,
      status: fw.status,
      activeMembers: fw.totals.used,
      protectedGhostMembers,
    });
  }
  // Stable sort: case-insensitive ASC by frameworkId.
  entries.sort((a, b) =>
    a.frameworkId.localeCompare(b.frameworkId, undefined, { sensitivity: 'base' }),
  );
  return entries;
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Factory mirrors change-plan.ts and annotate.ts patterns.
  function makeResult(overrides: {
    name: string;
    category: 'agent' | 'skill' | 'mcp-server' | 'memory';
    tier: 'used' | 'likely-ghost' | 'definite-ghost';
    framework?: string | null;
    tokens?: number;
  }): TokenCostResult {
    return {
      item: {
        name: overrides.name,
        path: `/tmp/${overrides.name}`,
        scope: 'global',
        category: overrides.category,
        projectPath: null,
        ...(overrides.framework !== undefined ? { framework: overrides.framework } : {}),
      },
      tier: overrides.tier,
      lastUsed: overrides.tier === 'used' ? new Date() : null,
      invocationCount: overrides.tier === 'used' ? 1 : 0,
      tokenEstimate: {
        tokens: overrides.tokens ?? 100,
        confidence: 'estimated',
        source: 'test',
      },
    };
  }

  // Build a partially-used GSD fixture: 2 used + 3 ghost gsd-* agents + 2 unrelated ghosts.
  function partiallyUsedGsdFixture(): TokenCostResult[] {
    return [
      makeResult({ name: 'gsd-planner', category: 'agent', tier: 'used', framework: 'gsd' }),
      makeResult({ name: 'gsd-executor', category: 'agent', tier: 'used', framework: 'gsd' }),
      makeResult({
        name: 'gsd-researcher',
        category: 'agent',
        tier: 'definite-ghost',
        framework: 'gsd',
      }),
      makeResult({
        name: 'gsd-verifier',
        category: 'agent',
        tier: 'definite-ghost',
        framework: 'gsd',
      }),
      makeResult({
        name: 'gsd-reviewer',
        category: 'agent',
        tier: 'definite-ghost',
        framework: 'gsd',
      }),
      makeResult({
        name: 'unrelated-1',
        category: 'agent',
        tier: 'definite-ghost',
        framework: null,
      }),
      makeResult({
        name: 'unrelated-2',
        category: 'agent',
        tier: 'definite-ghost',
        framework: null,
      }),
    ];
  }

  describe('applyFrameworkProtection — escape hatch (D-39)', () => {
    it('returns enriched unchanged when groupFrameworks=false (forcePartial=false)', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: false,
      });
      expect(result.filtered).toBe(enriched);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('returns enriched unchanged when groupFrameworks=false (forcePartial=true)', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: true,
        groupFrameworks: false,
      });
      expect(result.filtered).toBe(enriched);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('applyFrameworkProtection — partially-used framework', () => {
    it('removes ghost members of partially-used framework when forcePartial=false', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      // 2 gsd-used + 2 unrelated ghosts pass through
      expect(result.filtered).toHaveLength(4);
      // 3 gsd ghosts protected
      expect(result.protectedItems).toHaveLength(3);
      const protectedNames = result.protectedItems.map((r) => r.item.name).sort();
      expect(protectedNames).toEqual(['gsd-researcher', 'gsd-reviewer', 'gsd-verifier']);
    });

    it('emits one warning per protected framework with correct counts', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        frameworkId: 'gsd',
        status: 'partially-used',
        activeMembers: 2,
        protectedGhostMembers: 3,
      });
      expect(result.warnings[0]?.displayName).toBeTruthy();
    });

    it('passes all members through when forcePartial=true but still emits warnings', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: true,
        groupFrameworks: true,
      });
      expect(result.filtered).toHaveLength(7);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.frameworkId).toBe('gsd');
      expect(result.warnings[0]?.protectedGhostMembers).toBe(3);
    });

    it('used members of a protected framework are never in protectedItems', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      const usedNames = result.protectedItems
        .filter((r) => r.tier === 'used')
        .map((r) => r.item.name);
      expect(usedNames).toEqual([]);
    });
  });

  describe('applyFrameworkProtection — ghost-all framework', () => {
    it('lets all ghost members of a ghost-all framework flow into filtered', () => {
      // All 3 gsd members are ghost → status 'ghost-all' → no protection.
      const enriched = [
        makeResult({ name: 'gsd-a', category: 'agent', tier: 'definite-ghost', framework: 'gsd' }),
        makeResult({ name: 'gsd-b', category: 'agent', tier: 'definite-ghost', framework: 'gsd' }),
        makeResult({ name: 'gsd-c', category: 'agent', tier: 'definite-ghost', framework: 'gsd' }),
      ];
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.filtered).toBe(enriched);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('applyFrameworkProtection — fully-used framework', () => {
    it('emits no warning when every framework member is tier=used', () => {
      // Per RESEARCH §5.6, fully-used has 0 ghost members so protection is meaningless.
      const enriched = [
        makeResult({ name: 'gsd-a', category: 'agent', tier: 'used', framework: 'gsd' }),
        makeResult({ name: 'gsd-b', category: 'agent', tier: 'used', framework: 'gsd' }),
        makeResult({ name: 'gsd-c', category: 'agent', tier: 'used', framework: 'gsd' }),
      ];
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.filtered).toBe(enriched);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('applyFrameworkProtection — degenerate inputs', () => {
    it('handles empty input', () => {
      const result = applyFrameworkProtection([], {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.filtered).toEqual([]);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('passes through ungrouped inventory unchanged', () => {
      const enriched = [
        makeResult({
          name: 'unrelated-1',
          category: 'agent',
          tier: 'definite-ghost',
          framework: null,
        }),
        makeResult({
          name: 'unrelated-2',
          category: 'skill',
          tier: 'definite-ghost',
          framework: null,
        }),
        makeResult({
          name: 'mcp-x',
          category: 'mcp-server',
          tier: 'definite-ghost',
          framework: null,
        }),
      ];
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.filtered).toBe(enriched);
      expect(result.protectedItems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('applyFrameworkProtection — purity invariant', () => {
    it('does not mutate the input array or its items', () => {
      const enriched = partiallyUsedGsdFixture();
      const beforeSnapshot = JSON.parse(JSON.stringify(enriched));
      applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(JSON.parse(JSON.stringify(enriched))).toEqual(beforeSnapshot);
      expect(enriched).toHaveLength(7);
    });
  });

  describe('applyFrameworkProtection — privacy-safe warning shape', () => {
    it('ProtectedFrameworkWarning carries no path or projectPath fields', () => {
      const enriched = partiallyUsedGsdFixture();
      const result = applyFrameworkProtection(enriched, {
        forcePartial: false,
        groupFrameworks: true,
      });
      expect(result.warnings).toHaveLength(1);
      const keys = Object.keys(result.warnings[0]!).sort();
      expect(keys).toEqual([
        'activeMembers',
        'displayName',
        'frameworkId',
        'protectedGhostMembers',
        'status',
      ]);
    });
  });
}
