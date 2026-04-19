/**
 * Phase 5 D5-13..D5-16: modal help overlay render function.
 *
 * PURE: no state, no side effects, no ANSI styling. Deterministic output from
 * `{ useAscii, rows, cols }`. Consumed by `TabbedGhostPicker._renderFrame()`
 * when `helpOpen === true`.
 *
 * Content is grouped into four functional sections (D5-14):
 *   Navigation / Selection / View / Exit
 *
 * Unicode mode uses `──` framed headings; ASCII mode (D5-21) swaps to `#`
 * prefixes and replaces arrows (`↑↓←→`) with caret-slash ASCII equivalents.
 *
 * Sub-minimum viewport (`rows < 14`, D5-15) falls back to a one-column compact
 * list terminated by `(Press ? to close and resize terminal)`; the overlay
 * never crashes, never grows unbounded.
 */

export interface HelpOverlayInput {
  useAscii: boolean;
  /** Terminal rows — gates compact-mode fallback (D5-15). */
  rows: number;
  /** Terminal cols — hard truncation width. */
  cols: number;
}

interface Binding {
  readonly keys: string;
  readonly desc: string;
}

interface Group {
  readonly heading: string;
  readonly bindings: readonly Binding[];
}

// ---------------------------------------------------------------------------
// Binding catalog (D5-14) — same set rendered in both modes; glyphs swapped at
// render time based on useAscii.
// ---------------------------------------------------------------------------

function buildGroups(useAscii: boolean): readonly Group[] {
  const up = useAscii ? '^' : '↑';
  const down = useAscii ? 'v' : '↓';
  const left = useAscii ? '<-' : '←';
  const right = useAscii ? '->' : '→';
  return [
    {
      heading: 'Navigation',
      bindings: [
        { keys: `${up} ${down}`, desc: 'Move cursor within tab' },
        { keys: 'PgUp PgDn', desc: 'Page within tab' },
        { keys: 'Home End', desc: 'Jump to first / last row' },
        { keys: 'Tab Shift-Tab', desc: 'Cycle tabs forward / back' },
        { keys: `${left} ${right}`, desc: 'Cycle tabs (arrow aliases)' },
        { keys: '1 2 3 4 5 6', desc: 'Jump to tab N' },
      ],
    },
    {
      heading: 'Selection',
      bindings: [
        { keys: 'Space', desc: 'Toggle current row' },
        { keys: 'a', desc: 'Toggle all in active tab' },
        { keys: 'n', desc: 'Clear all selections' },
        { keys: 'i', desc: 'Invert selection in active tab' },
      ],
    },
    {
      heading: 'View',
      bindings: [
        { keys: '/', desc: 'Filter: case-insensitive substring on name' },
        { keys: 's', desc: 'Cycle sort (staleness / tokens / name)' },
        { keys: '?', desc: 'Toggle this help overlay' },
      ],
    },
    {
      heading: 'Exit',
      bindings: [
        { keys: 'Enter', desc: 'Confirm selection' },
        { keys: 'Esc', desc: 'Cancel / close overlay / clear filter' },
        { keys: 'Ctrl+C', desc: 'Cancel picker (q alias)' },
      ],
    },
  ];
}

const COMPACT_THRESHOLD_ROWS = 14;

function formatHeading(heading: string, useAscii: boolean): string {
  return useAscii ? `# ${heading}` : `── ${heading} ──`;
}

function truncate(line: string, cols: number): string {
  if (cols <= 0) return '';
  if (line.length <= cols) return line;
  return line.slice(0, cols);
}

/**
 * Render the help overlay as a newline-joined string. Pure: identical input
 * produces identical output. Never throws.
 */
export function renderHelpOverlay(input: HelpOverlayInput): string {
  const { useAscii, rows, cols } = input;
  const safeCols = Math.max(1, cols | 0);
  const groups = buildGroups(useAscii);
  const lines: string[] = [];

  lines.push(truncate('ccaudit keybindings', safeCols));
  lines.push('');

  if (rows < COMPACT_THRESHOLD_ROWS) {
    // Compact mode (D5-15): one-column plain list, prefixed by heading,
    // then all bindings flat, then the escape hint.
    for (const group of groups) {
      lines.push(truncate(formatHeading(group.heading, useAscii), safeCols));
      for (const b of group.bindings) {
        lines.push(truncate(`  ${b.keys}  ${b.desc}`, safeCols));
      }
    }
    lines.push('');
    lines.push(truncate('(Press ? to close and resize terminal)', safeCols));
    return lines.join('\n');
  }

  // Normal mode (D5-14): two-column-style binding list per group. We lay out
  // each binding on its own line with padded-key column so descriptions align.
  // This stays pure — no ANSI, just spaces.
  const keyColWidth = Math.min(
    22,
    Math.max(...groups.flatMap((g) => g.bindings.map((b) => b.keys.length))),
  );

  for (const group of groups) {
    lines.push(truncate(formatHeading(group.heading, useAscii), safeCols));
    for (const b of group.bindings) {
      const keys = b.keys.padEnd(keyColWidth, ' ');
      lines.push(truncate(`  ${keys}  ${b.desc}`, safeCols));
    }
    lines.push('');
  }
  lines.push(truncate('(Press ? or Esc to close)', safeCols));
  return lines.join('\n');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderHelpOverlay', () => {
    it('contains all four group headings and at least one binding each (D5-14)', () => {
      const out = renderHelpOverlay({ useAscii: false, rows: 30, cols: 100 });
      expect(out).toContain('Navigation');
      expect(out).toContain('Selection');
      expect(out).toContain('View');
      expect(out).toContain('Exit');
      // At least one representative keybind per group.
      expect(out).toContain('Tab Shift-Tab');
      expect(out).toContain('Space');
      expect(out).toContain('/');
      expect(out).toContain('Ctrl+C');
    });

    it('ASCII mode swaps heading frame to `#` and replaces arrow glyphs (D5-21)', () => {
      const ascii = renderHelpOverlay({ useAscii: true, rows: 30, cols: 100 });
      expect(ascii).toContain('# Navigation');
      expect(ascii).not.toContain('──');
      expect(ascii).not.toContain('↑');
      expect(ascii).not.toContain('↓');
      expect(ascii).not.toContain('←');
      expect(ascii).not.toContain('→');
      // ASCII arrow stand-ins present.
      expect(ascii).toMatch(/\^ v/);
      expect(ascii).toContain('<- ->');
    });

    it('Unicode mode uses framed headings with em-dash surrounds', () => {
      const uni = renderHelpOverlay({ useAscii: false, rows: 30, cols: 100 });
      expect(uni).toContain('── Navigation ──');
      expect(uni).toContain('── Exit ──');
    });

    it('sub-minimum rows renders compact mode with close-and-resize hint (D5-15)', () => {
      const compact = renderHelpOverlay({ useAscii: false, rows: 10, cols: 80 });
      expect(compact).toContain('(Press ? to close and resize terminal)');
      // Still lists every group heading.
      expect(compact).toContain('Navigation');
      expect(compact).toContain('Exit');
    });

    it('is deterministic: identical input => identical output (snapshot-friendly)', () => {
      const a = renderHelpOverlay({ useAscii: false, rows: 30, cols: 100 });
      const b = renderHelpOverlay({ useAscii: false, rows: 30, cols: 100 });
      expect(a).toBe(b);
      const c = renderHelpOverlay({ useAscii: true, rows: 10, cols: 40 });
      const d = renderHelpOverlay({ useAscii: true, rows: 10, cols: 40 });
      expect(c).toBe(d);
    });

    it('truncates every line to `cols` width (no line exceeds cols)', () => {
      const narrow = renderHelpOverlay({ useAscii: false, rows: 30, cols: 20 });
      for (const line of narrow.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(20);
      }
      const narrowCompact = renderHelpOverlay({ useAscii: true, rows: 8, cols: 15 });
      for (const line of narrowCompact.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(15);
      }
    });

    it('never throws on degenerate inputs (rows=0, cols=0, cols=1)', () => {
      expect(() => renderHelpOverlay({ useAscii: false, rows: 0, cols: 0 })).not.toThrow();
      expect(() => renderHelpOverlay({ useAscii: true, rows: 0, cols: 1 })).not.toThrow();
      const zero = renderHelpOverlay({ useAscii: false, rows: 0, cols: 0 });
      // cols=0 clamps to 1; every line empty or 1-char.
      for (const line of zero.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(1);
      }
    });
  });
}
