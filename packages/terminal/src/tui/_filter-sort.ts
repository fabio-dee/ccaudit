/**
 * Pure filter + sort helpers for the tabbed picker's Phase 5 keyboard model.
 *
 * Separates correctness-critical logic from the stateful picker (Plan 02
 * wires these into `TabbedGhostPicker`). All functions here are pure: no
 * I/O, no process state, no mutation of input arrays.
 *
 * Decisions implemented:
 *  - D5-02: Match is case-insensitive substring on `item.name` only.
 *  - D5-08: Sort cycle is `staleness-desc → tokens-desc → name-asc → staleness-desc`.
 *           Default on picker entry is `staleness-desc`.
 *  - D5-10: Sort is stable (Node ≥20 Array.prototype.sort is stable).
 *  - T-05-01 mitigation: `sanitizeFilterQuery` strips ANSI CSI sequences +
 *    bare ESC + C0/DEL control chars before echoing into the render buffer,
 *    so pasted terminal-control payloads cannot inject cursor moves / colors
 *    / title changes through the filter echo.
 *
 * No imports from `tabbed-picker.ts` — this file is a leaf in the dep graph.
 */
import type { TokenCostResult } from '@ccaudit/internal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortMode = 'staleness-desc' | 'tokens-desc' | 'name-asc';

export interface FilterSortState {
  /** Current filter query (post-sanitization). Empty string = no narrowing. */
  query: string;
  /** True while the filter input row is focused (cursor visible). */
  active: boolean;
  /** Current per-tab sort mode. */
  sort: SortMode;
}

/** Factory for the initial per-tab state on picker entry (D5-08). */
export function defaultFilterSortState(): FilterSortState {
  return { query: '', active: false, sort: 'staleness-desc' };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match on the display name (D5-02).
 * Empty query matches everything (no-op filter).
 */
export function matchesQuery(name: string, query: string): boolean {
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Strip terminal-injection risks from a user-supplied filter query before
 * echoing it into the render buffer (threat T-05-01).
 *
 * Removes:
 *  - ANSI CSI sequences: `ESC [` followed by parameter/intermediate bytes
 *    terminated by a final byte (`@`–`~`).
 *  - Any remaining ESC (`\x1b`) bytes (OSC, raw escape, etc.).
 *  - C0 control characters (`\x00`–`\x1F`) and DEL (`\x7F`).
 *
 * Keeps all printable ASCII + Unicode letters/digits/punctuation/spaces.
 */
export function sanitizeFilterQuery(raw: string): string {
  // Strip CSI sequences first (ESC [ ... final-byte).
  // eslint-disable-next-line no-control-regex
  const noCsi = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Strip any residual ESC bytes and C0/DEL controls.
  // eslint-disable-next-line no-control-regex
  return noCsi.replace(/[\x00-\x1F\x7F]/g, '');
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/** D5-08 cycle: staleness-desc → tokens-desc → name-asc → staleness-desc. */
export function nextSort(current: SortMode): SortMode {
  switch (current) {
    case 'staleness-desc':
      return 'tokens-desc';
    case 'tokens-desc':
      return 'name-asc';
    case 'name-asc':
      return 'staleness-desc';
  }
}

/**
 * Return a sorted COPY of `items` according to `mode`. Never mutates input.
 *
 *  - `tokens-desc`: highest `tokenEstimate.tokens` first; null → 0.
 *  - `name-asc`: case-insensitive alphabetical by `item.name`.
 *  - `staleness-desc`: largest `now - item.mtimeMs` first. Items missing
 *    `mtimeMs` have age = `now` (largest), so they float to top as
 *    most-stale. Documented so Plan 02's integration test matches.
 *
 * Stable: ties preserve input order (Node ≥20 stable sort).
 */
export function sortItems(
  items: readonly TokenCostResult[],
  mode: SortMode,
  now: number,
): TokenCostResult[] {
  const copy = items.slice();
  switch (mode) {
    case 'tokens-desc':
      copy.sort((a, b) => (b.tokenEstimate?.tokens ?? 0) - (a.tokenEstimate?.tokens ?? 0));
      return copy;
    case 'name-asc':
      copy.sort((a, b) =>
        a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' }),
      );
      return copy;
    case 'staleness-desc':
      copy.sort((a, b) => {
        const aAge = now - (a.item.mtimeMs ?? 0);
        const bAge = now - (b.item.mtimeMs ?? 0);
        return bAge - aAge;
      });
      return copy;
  }
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  interface MakeItemOpts {
    name: string;
    tokens?: number | null;
    mtimeMs?: number;
  }
  const makeItem = ({ name, tokens = 0, mtimeMs }: MakeItemOpts): TokenCostResult => ({
    item: {
      name,
      category: 'agent',
      scope: 'global',
      projectPath: null,
      path: `/fake/${name}`,
      mtimeMs,
    },
    tier: 'definite-ghost',
    lastUsed: null,
    invocationCount: 0,
    tokenEstimate: tokens === null ? null : { tokens, confidence: 'estimated', source: 'test' },
  });

  describe('matchesQuery', () => {
    it('case-insensitive substring', () => {
      expect(matchesQuery('Pencil-Dev', 'pencil')).toBe(true);
      expect(matchesQuery('Pencil-Dev', 'PENCIL')).toBe(true);
      expect(matchesQuery('Pencil-Dev', 'cil-de')).toBe(true);
    });
    it('empty query matches everything', () => {
      expect(matchesQuery('foo', '')).toBe(true);
      expect(matchesQuery('', '')).toBe(true);
    });
    it('non-match returns false', () => {
      expect(matchesQuery('foo', 'bar')).toBe(false);
    });
  });

  describe('sanitizeFilterQuery', () => {
    it('strips ANSI SGR color escapes', () => {
      expect(sanitizeFilterQuery('\x1b[31mfoo\x1b[0m')).toBe('foo');
    });
    it('strips cursor-move CSI escapes', () => {
      expect(sanitizeFilterQuery('a\x1b[2Jb')).toBe('ab');
    });
    it('strips C0 control chars and DEL', () => {
      expect(sanitizeFilterQuery('a\x00b\x07c\x7Fd')).toBe('abcd');
    });
    it('strips bare ESC with no CSI', () => {
      expect(sanitizeFilterQuery('a\x1bb')).toBe('ab');
    });
    it('preserves unicode + spaces + punctuation', () => {
      expect(sanitizeFilterQuery('café test-1!')).toBe('café test-1!');
    });
  });

  describe('nextSort', () => {
    it('cycles staleness-desc → tokens-desc → name-asc → staleness-desc', () => {
      expect(nextSort('staleness-desc')).toBe('tokens-desc');
      expect(nextSort('tokens-desc')).toBe('name-asc');
      expect(nextSort('name-asc')).toBe('staleness-desc');
    });
    it('4 cycles from default lands on tokens-desc (D5-10 stability)', () => {
      let m: SortMode = 'staleness-desc';
      for (let i = 0; i < 4; i++) m = nextSort(m);
      expect(m).toBe('tokens-desc');
    });
  });

  describe('defaultFilterSortState', () => {
    it('returns empty/inactive/staleness-desc', () => {
      expect(defaultFilterSortState()).toEqual({
        query: '',
        active: false,
        sort: 'staleness-desc',
      });
    });
  });

  describe('sortItems', () => {
    const now = 1_000_000;
    const a = makeItem({ name: 'alpha', tokens: 100, mtimeMs: now - 1000 });
    const b = makeItem({ name: 'Bravo', tokens: 500, mtimeMs: now - 5000 });
    const c = makeItem({ name: 'charlie', tokens: null, mtimeMs: now - 200 });
    const d = makeItem({ name: 'delta', tokens: 50 /* mtimeMs missing */ });
    const items = [a, b, c, d];

    it('tokens-desc: highest tokens first; null counts as 0', () => {
      const out = sortItems(items, 'tokens-desc', now);
      expect(out.map((x) => x.item.name)).toEqual(['Bravo', 'alpha', 'delta', 'charlie']);
    });

    it('name-asc: case-insensitive alphabetical', () => {
      const out = sortItems(items, 'name-asc', now);
      expect(out.map((x) => x.item.name)).toEqual(['alpha', 'Bravo', 'charlie', 'delta']);
    });

    it('staleness-desc: missing mtimeMs is most-stale, then oldest first', () => {
      const out = sortItems(items, 'staleness-desc', now);
      expect(out.map((x) => x.item.name)).toEqual(['delta', 'Bravo', 'alpha', 'charlie']);
    });

    it('does not mutate input', () => {
      const before = items.map((x) => x.item.name);
      sortItems(items, 'tokens-desc', now);
      sortItems(items, 'name-asc', now);
      sortItems(items, 'staleness-desc', now);
      expect(items.map((x) => x.item.name)).toEqual(before);
    });

    it('repeated calls produce identical orderings (stable)', () => {
      const r1 = sortItems(items, 'tokens-desc', now).map((x) => x.item.name);
      const r2 = sortItems(items, 'tokens-desc', now).map((x) => x.item.name);
      const r3 = sortItems(items, 'tokens-desc', now).map((x) => x.item.name);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });

    it('ties in tokens preserve input order (stable sort)', () => {
      const x = makeItem({ name: 'x', tokens: 10 });
      const y = makeItem({ name: 'y', tokens: 10 });
      const z = makeItem({ name: 'z', tokens: 10 });
      const out = sortItems([x, y, z], 'tokens-desc', now);
      expect(out.map((i) => i.item.name)).toEqual(['x', 'y', 'z']);
    });
  });
}
