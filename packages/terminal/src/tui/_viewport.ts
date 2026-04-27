/**
 * Pure viewport-windowing helpers for the tabbed picker (D3.1-05..D3.1-07).
 *
 * Single source of truth for the viewport-height formula — the literal
 * `Math.max(8, (process.stdout.rows ?? 24) - 10)` lives here.
 *
 * No side effects; no @clack/core imports; no process.stdout access.
 * Callers pass `stdoutRows` explicitly so this module stays testable.
 */

export interface ViewportWindow<T> {
  /** The visible slice of rows. */
  slice: T[];
  /** Count of rows hidden above the slice (for "↑ N more" indicator). */
  aboveCount: number;
  /** Count of rows hidden below the slice (for "↓ N more" indicator). */
  belowCount: number;
  /** Absolute index of the first visible row (used to map cursor → slice-local index). */
  sliceStart: number;
}

/**
 * Compute viewport height per D3.1-05: `Math.max(8, (rows ?? 24) - 10)`.
 *
 * `rowsOverride` is a test-only escape hatch that bypasses the floor — used by
 * regression fixtures that need to force a small viewport (e.g., viewport=5 to
 * reproduce the long-list overflow bug on CI where stdout.rows is often 24).
 */
export function computeViewportHeight(opts: {
  rowsOverride?: number;
  stdoutRows?: number | undefined;
  /**
   * Phase 6 Plan 03 (D6-08): rows consumed by the top-of-TUI
   * `--force-partial` banner. Defaults to 0 so Phase 3.1/4/5 call sites
   * stay byte-identical. When `forcePartial` is ON the picker passes 1.
   */
  bannerRows?: number;
}): number {
  const bannerRows = opts.bannerRows ?? 0;
  if (opts.rowsOverride !== undefined) return Math.max(1, opts.rowsOverride - bannerRows);
  return Math.max(1, Math.max(8, (opts.stdoutRows ?? 24) - 10) - bannerRows);
}

/**
 * Return the viewport-windowed slice of rows, keeping the cursor inside the slice.
 *
 * Scroll strategy: centre-ish — when space allows, the cursor sits in the middle
 * of the slice; at list boundaries the slice clamps to the edge.
 *
 * Algorithm:
 *   sliceStart = clamp(cursor - floor(viewportHeight / 2), 0, rows.length - viewportHeight)
 *   slice      = rows.slice(sliceStart, sliceStart + viewportHeight)
 *   aboveCount = sliceStart
 *   belowCount = max(0, rows.length - sliceStart - viewportHeight)
 *
 * When rows.length <= viewportHeight, returns the full list with above/below=0.
 */
export function windowRows<T>(input: {
  rows: readonly T[];
  cursor: number;
  viewportHeight: number;
}): ViewportWindow<T> {
  const { rows, cursor, viewportHeight } = input;
  if (rows.length <= viewportHeight) {
    return { slice: [...rows], aboveCount: 0, belowCount: 0, sliceStart: 0 };
  }
  const half = Math.floor(viewportHeight / 2);
  const maxStart = rows.length - viewportHeight;
  const sliceStart = Math.max(0, Math.min(maxStart, cursor - half));
  const slice = rows.slice(sliceStart, sliceStart + viewportHeight);
  return {
    slice: [...slice],
    aboveCount: sliceStart,
    belowCount: Math.max(0, rows.length - sliceStart - viewportHeight),
    sliceStart,
  };
}

// ---------------------------------------------------------------------------
// Phase 9 Plan 02 (D3 / SC3) — scroll-state persistence reducer.
//
// The viewport is cursor-centered (see windowRows above), so preserving the
// scroll offset across filter/sort/tab events reduces to preserving the
// cursor across those events. We persist a per-tab cursor that the render
// path consumes; pre-filter cursor is saved so Esc restores it.
// ---------------------------------------------------------------------------

export interface ScrollState {
  /** Current cursor absolute index into the post-filter row list. */
  cursor: number;
  /** Cursor saved on filter-on; restored on filter-off (Esc). null when no save. */
  savedCursorPreFilter: number | null;
}

export function initialScrollState(): ScrollState {
  return { cursor: 0, savedCursorPreFilter: null };
}

export type ScrollAction =
  /** Arrow/j key — cursor + 1 (clamped). */
  | { type: 'cursorDown'; rowsLen: number }
  /** Arrow/k key — cursor - 1 (clamped). */
  | { type: 'cursorUp' }
  /** PgDn / End / Home — caller supplies the target index, reducer clamps. */
  | { type: 'cursorJump'; target: number; rowsLen: number }
  /** User pressed `/` to open filter. Saves cursor for later restore. */
  | { type: 'filterOn' }
  /** User pressed Esc to clear filter. Restores saved cursor (clamped). */
  | { type: 'filterOff'; rowsLen: number }
  /** Filter query mutated — visible slice changed. Caller typically wants cursor=0. */
  | { type: 'filterQueryChange' }
  /** `s` key — sort mode cycled within tab. Clamps cursor to rowsLen. */
  | { type: 'sortCycle'; rowsLen: number }
  /** Tab switched — leaves this tab's state alone (cursor is per-tab anyway). */
  | { type: 'tabChange' };

/**
 * Pure reducer for per-tab scroll state. Every return is a NEW object (never
 * mutates the input). Clamping is performed anywhere `rowsLen` is known, so
 * the render path can always pass the post-mutation state directly to
 * `windowRows` without further bounds work.
 */
export function applyScroll(state: ScrollState, action: ScrollAction): ScrollState {
  switch (action.type) {
    case 'cursorDown': {
      const max = Math.max(0, action.rowsLen - 1);
      return { ...state, cursor: Math.min(max, state.cursor + 1) };
    }
    case 'cursorUp':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'cursorJump': {
      const max = Math.max(0, action.rowsLen - 1);
      return { ...state, cursor: Math.max(0, Math.min(max, action.target)) };
    }
    case 'filterOn':
      // Don't double-save if the caller is idempotent.
      if (state.savedCursorPreFilter !== null) return state;
      return { ...state, savedCursorPreFilter: state.cursor };
    case 'filterOff': {
      const max = Math.max(0, action.rowsLen - 1);
      const restored = state.savedCursorPreFilter ?? state.cursor;
      return {
        cursor: Math.max(0, Math.min(max, restored)),
        savedCursorPreFilter: null,
      };
    }
    case 'filterQueryChange':
      // The filtered-row list has changed under the cursor; the caller's
      // convention (D5-01) is to reset to 0 so the new top row is visible.
      return { ...state, cursor: 0 };
    case 'sortCycle': {
      const max = Math.max(0, action.rowsLen - 1);
      return { ...state, cursor: Math.max(0, Math.min(max, state.cursor)) };
    }
    case 'tabChange':
      // Per-tab state is stored separately; nothing to do here. Caller uses
      // this action for symmetry / future-proofing (e.g., metric logging).
      return state;
  }
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('computeViewportHeight', () => {
    it('stdoutRows=24 → returns 14 (default terminal size)', () => {
      expect(computeViewportHeight({ stdoutRows: 24 })).toBe(14);
    });

    it('stdoutRows=20 → returns 10', () => {
      expect(computeViewportHeight({ stdoutRows: 20 })).toBe(10);
    });

    it('stdoutRows=12 → returns 8 (floor applied)', () => {
      expect(computeViewportHeight({ stdoutRows: 12 })).toBe(8);
    });

    it('stdoutRows=undefined → returns 14 (falls back to 24)', () => {
      expect(computeViewportHeight({ stdoutRows: undefined })).toBe(14);
    });

    it('stdoutRows=50 → returns 40 (no upper ceiling)', () => {
      expect(computeViewportHeight({ stdoutRows: 50 })).toBe(40);
    });

    it('rowsOverride=5 → returns 5 (test-injection bypasses floor)', () => {
      expect(computeViewportHeight({ rowsOverride: 5, stdoutRows: 24 })).toBe(5);
    });

    it('bannerRows=1 reduces viewport by 1 vs bannerRows=0 (Phase 6 D6-08)', () => {
      const without = computeViewportHeight({ stdoutRows: 30, bannerRows: 0 });
      const withBanner = computeViewportHeight({ stdoutRows: 30, bannerRows: 1 });
      expect(withBanner).toBe(without - 1);
    });

    it('bannerRows defaults to 0 (Phase 3.1/4/5 call sites stay byte-identical)', () => {
      expect(computeViewportHeight({ stdoutRows: 30 })).toBe(
        computeViewportHeight({ stdoutRows: 30, bannerRows: 0 }),
      );
    });

    it('bannerRows=1 also reduces rowsOverride path', () => {
      expect(computeViewportHeight({ rowsOverride: 10, bannerRows: 1 })).toBe(9);
    });

    it('bannerRows larger than base never produces a negative viewport (NEW-M3 clamp)', () => {
      // stdoutRows=12 → base=Math.max(8,2)=8; bannerRows=10 → without clamp = -2
      expect(computeViewportHeight({ stdoutRows: 12, bannerRows: 10 })).toBe(1);
      // rowsOverride=3, bannerRows=5 → rowsOverride path: Math.max(1, 3-5) = 1
      expect(computeViewportHeight({ rowsOverride: 3, bannerRows: 5 })).toBe(1);
    });
  });

  describe('windowRows', () => {
    it('100 rows, cursor=0, viewport=10 → sliceStart=0, aboveCount=0, belowCount=90', () => {
      const rows = Array.from({ length: 100 }, (_, i) => i);
      const w = windowRows({ rows, cursor: 0, viewportHeight: 10 });
      expect(w.sliceStart).toBe(0);
      expect(w.aboveCount).toBe(0);
      expect(w.belowCount).toBe(90);
      expect(w.slice).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('100 rows, cursor=50, viewport=10 → sliceStart=45, aboveCount=45, belowCount=45', () => {
      const rows = Array.from({ length: 100 }, (_, i) => i);
      const w = windowRows({ rows, cursor: 50, viewportHeight: 10 });
      expect(w.sliceStart).toBe(45);
      expect(w.aboveCount).toBe(45);
      expect(w.belowCount).toBe(45);
      expect(w.slice.length).toBe(10);
      expect(w.slice[0]).toBe(45);
    });

    it('100 rows, cursor=99, viewport=10 → sliceStart=90, aboveCount=90, belowCount=0', () => {
      const rows = Array.from({ length: 100 }, (_, i) => i);
      const w = windowRows({ rows, cursor: 99, viewportHeight: 10 });
      expect(w.sliceStart).toBe(90);
      expect(w.aboveCount).toBe(90);
      expect(w.belowCount).toBe(0);
      expect(w.slice).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    });

    it('5 rows (fewer than viewport=10), cursor=2 → full list returned, above/below=0', () => {
      const rows = [10, 20, 30, 40, 50];
      const w = windowRows({ rows, cursor: 2, viewportHeight: 10 });
      expect(w.sliceStart).toBe(0);
      expect(w.aboveCount).toBe(0);
      expect(w.belowCount).toBe(0);
      expect(w.slice.length).toBe(5);
      expect(w.slice).toEqual([10, 20, 30, 40, 50]);
    });
  });

  // Phase 9 Plan 02 (D3 / SC3) — scroll-state reducer tests.
  describe('applyScroll reducer', () => {
    it('cursorDown clamps to rowsLen-1', () => {
      const s: ScrollState = { cursor: 99, savedCursorPreFilter: null };
      const next = applyScroll(s, { type: 'cursorDown', rowsLen: 100 });
      expect(next.cursor).toBe(99);
      expect(applyScroll(next, { type: 'cursorDown', rowsLen: 100 }).cursor).toBe(99);
    });

    it('cursorUp clamps to 0', () => {
      const s: ScrollState = { cursor: 0, savedCursorPreFilter: null };
      expect(applyScroll(s, { type: 'cursorUp' }).cursor).toBe(0);
      const mid = applyScroll({ cursor: 3, savedCursorPreFilter: null }, { type: 'cursorUp' });
      expect(mid.cursor).toBe(2);
    });

    it('filterOn + filterOff round-trips the cursor (persistence across filter toggle)', () => {
      const initial: ScrollState = { cursor: 250, savedCursorPreFilter: null };
      const filtering = applyScroll(initial, { type: 'filterOn' });
      expect(filtering.savedCursorPreFilter).toBe(250);
      // User typed a query → cursor resets to 0 on new slice.
      const mid = applyScroll(filtering, { type: 'filterQueryChange' });
      expect(mid.cursor).toBe(0);
      // Esc → full list is back (500 rows) and saved cursor restored.
      const restored = applyScroll(mid, { type: 'filterOff', rowsLen: 500 });
      expect(restored.cursor).toBe(250);
      expect(restored.savedCursorPreFilter).toBeNull();
    });

    it('filterOff clamps restored cursor if post-filter rowsLen shrank', () => {
      const state: ScrollState = { cursor: 5, savedCursorPreFilter: 400 };
      const out = applyScroll(state, { type: 'filterOff', rowsLen: 10 });
      expect(out.cursor).toBe(9);
      expect(out.savedCursorPreFilter).toBeNull();
    });

    it('filterOn is idempotent — second call does not overwrite savedCursorPreFilter', () => {
      const s = applyScroll({ cursor: 40, savedCursorPreFilter: null }, { type: 'filterOn' });
      expect(s.savedCursorPreFilter).toBe(40);
      const s2 = applyScroll({ ...s, cursor: 5 }, { type: 'filterOn' });
      expect(s2.savedCursorPreFilter).toBe(40);
    });

    it('sortCycle clamps over-flow cursor when rowsLen shrinks', () => {
      const out = applyScroll(
        { cursor: 100, savedCursorPreFilter: null },
        { type: 'sortCycle', rowsLen: 20 },
      );
      expect(out.cursor).toBe(19);
    });

    it('sortCycle preserves an in-range cursor (scroll persistence across sort)', () => {
      const out = applyScroll(
        { cursor: 42, savedCursorPreFilter: null },
        { type: 'sortCycle', rowsLen: 100 },
      );
      expect(out.cursor).toBe(42);
    });

    it('cursorJump clamps target to rowsLen-1', () => {
      const out = applyScroll(
        { cursor: 0, savedCursorPreFilter: null },
        { type: 'cursorJump', target: 99999, rowsLen: 500 },
      );
      expect(out.cursor).toBe(499);
    });

    it('tabChange returns state unchanged (per-tab cursors live elsewhere)', () => {
      const s: ScrollState = { cursor: 7, savedCursorPreFilter: 42 };
      expect(applyScroll(s, { type: 'tabChange' })).toBe(s);
    });

    it('never mutates the input object', () => {
      const s: ScrollState = { cursor: 3, savedCursorPreFilter: null };
      Object.freeze(s);
      expect(() => applyScroll(s, { type: 'cursorDown', rowsLen: 10 })).not.toThrow();
    });
  });
}
