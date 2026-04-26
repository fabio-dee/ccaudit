/**
 * Phase 9 Plan 02 (D3 / SC3) — 500+ synthetic ghost fixture factory.
 *
 * Produces deterministic `TokenCostResult[]` for pagination tests. No file
 * I/O, no filesystem state — the picker is driven in-process.
 *
 * Names are `agent-001..agent-500`, tokens decrement by 1 each (1000, 999, …)
 * so sort-by-tokens is unambiguous. Mtime is a fixed epoch so staleness
 * logic is deterministic.
 */

import type { TokenCostResult } from '@ccaudit/internal';

export interface BuildGhosts500Opts {
  /** Defaults to 500. Must be ≥ 1. */
  count?: number;
  /** Fixed mtimeMs baseline — offsets by i so each item has a unique mtime. */
  baseMtimeMs?: number;
  /** Name prefix. Defaults to 'agent'. */
  prefix?: string;
  /** Category. Defaults to 'agent'. */
  category?: TokenCostResult['item']['category'];
}

/**
 * Build N synthetic ghosts with zero-padded 3-digit names. 500 fits in 3
 * digits (001..500); the fixture rejects count > 999 to keep the naming
 * scheme stable.
 */
export function buildGhosts500(opts: BuildGhosts500Opts = {}): TokenCostResult[] {
  const count = opts.count ?? 500;
  if (count < 1 || count > 999) {
    throw new Error(`buildGhosts500: count must be 1..999 (got ${count})`);
  }
  const baseMtime = opts.baseMtimeMs ?? Date.UTC(2026, 0, 1);
  const prefix = opts.prefix ?? 'agent';
  const category = opts.category ?? 'agent';
  const out: TokenCostResult[] = [];
  for (let i = 1; i <= count; i++) {
    const name = `${prefix}-${String(i).padStart(3, '0')}`;
    out.push({
      item: {
        name,
        category,
        scope: 'global',
        projectPath: null,
        path: `/fake/${category}s/${name}.md`,
        mtimeMs: baseMtime + i, // unique per item
      },
      tier: 'definite-ghost',
      lastUsed: null,
      invocationCount: 0,
      tokenEstimate: { tokens: 1000 - i, confidence: 'estimated', source: 'test' },
    });
  }
  return out;
}
