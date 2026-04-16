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
}): number {
  if (opts.rowsOverride !== undefined) return opts.rowsOverride;
  return Math.max(8, (opts.stdoutRows ?? 24) - 10);
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
}
