/**
 * Phase 9 Plan 02 (D3 / SC3) — 500-item pagination integration test.
 *
 * Drives the TabbedGhostPicker in-process (no pty) because:
 *   (a) pty-driving 500 rows is flaky across CI terminals, and
 *   (b) the invariant under test is pure render + cursor state, not
 *       keystroke decoding — which existing Phase 3.1 / 5 tests already
 *       cover end-to-end.
 *
 * Asserts:
 *   1. With 500 ghosts and a bounded viewport, the rendered frame contains
 *      only a viewport-sized slice of agent rows (no terminal overflow).
 *   2. End jumps cursor to last row; an above-indicator is visible.
 *   3. The applyScroll reducer round-trips cursor position across filter
 *      on/off and clamps when the row set narrows below the saved cursor.
 *   4. Toggling many rows keeps the rendered frame bounded.
 */
import { describe, it, expect } from 'vitest';
import { TabbedGhostPicker } from '../../../../packages/terminal/src/tui/tabbed-picker.ts';
import { applyScroll } from '../../../../packages/terminal/src/tui/_viewport.ts';
import { buildGhosts500 } from './fixtures/ghost-500-items.ts';

// Strip ANSI — `_renderFrame()` returns strings with picocolors escapes.
/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
/* eslint-enable no-control-regex */

function makePicker(rows = 500): TabbedGhostPicker {
  return new TabbedGhostPicker({
    ghosts: buildGhosts500({ count: rows }),
    useAscii: true,
    stdoutRows: 24,
    terminalCols: 100,
  });
}

describe('Phase 9 Plan 02 — 500-item pagination (D3 / SC3)', () => {
  it('renders only a viewport-sized slice on a 500-item tab (no overflow)', () => {
    const picker = makePicker(500);
    const frame = stripAnsi(picker._renderFrame());
    // stdoutRows=24 → viewportHeight = max(8, 24-10) = 14.
    // De-dupe: each rendered row includes the name once in the label and
    // once in the path (/fake/agents/agent-NNN.md). Count unique names.
    const agentMatches = new Set(frame.match(/agent-\d{3}/g) ?? []);
    expect(agentMatches.size).toBeGreaterThanOrEqual(10);
    expect(agentMatches.size).toBeLessThanOrEqual(20);
    // "more below" indicator must be present (cursor at row 0, many below).
    expect(frame).toMatch(/\bmore\b/);
    expect(frame).toContain('v '); // ASCII "↓" fallback under useAscii=true
  });

  it('End jumps cursor to last row; above-indicator rendered', () => {
    const picker = makePicker(500);
    picker.cursorEnd();
    expect(picker.tabs[0]!.cursor).toBe(499);
    const frame = stripAnsi(picker._renderFrame());
    expect(frame).toContain('^ '); // ASCII "↑" fallback
    expect(frame).toMatch(/\bmore\b/);
  });

  it('applyScroll reducer round-trips cursor across filter on/off and clamps on narrowing', () => {
    const s0 = { cursor: 300, savedCursorPreFilter: null as number | null };
    const s1 = applyScroll(s0, { type: 'filterOn' });
    const s2 = applyScroll(s1, { type: 'filterQueryChange' });
    const s3 = applyScroll(s2, { type: 'filterOff', rowsLen: 500 });
    expect(s3.cursor).toBe(300);
    expect(s3.savedCursorPreFilter).toBeNull();

    const narrowed = applyScroll(s2, { type: 'filterOff', rowsLen: 50 });
    expect(narrowed.cursor).toBeLessThanOrEqual(49);
    expect(narrowed.savedCursorPreFilter).toBeNull();
  });

  it('toggling across 500 items keeps the rendered frame bounded', () => {
    // Regression: selecting many items must not bleed rows outside the viewport.
    const picker = makePicker(500);
    for (let i = 0; i < 250; i++) {
      picker.toggleCurrentRow();
      picker.cursorDown();
    }
    const frame = stripAnsi(picker._renderFrame());
    const lines = frame.split('\n');
    // Row lines are ≤ 14 (viewport) + a few chrome lines (tab bar, header,
    // footer, hint, above/below indicators). Overall line count must stay
    // well under 500 — bound generously at 30.
    expect(lines.length).toBeLessThan(30);
  });
});
