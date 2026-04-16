/**
 * Pure tab-bar renderer for the tabbed picker (D3.1-09).
 *
 * Renders a single-line horizontal tab bar such as:
 *   ` AGENTS │ SKILLS │ MCP SERVERS │ MEMORY `
 *
 * Styling:
 *   - Active tab: inverse + bold
 *   - Inactive tabs: dim
 *
 * Separator:
 *   - Unicode: ' │ ' (U+2502 with surrounding spaces)
 *   - ASCII:   ' | '
 *
 * Truncation:
 *   - If rendered visible length exceeds `terminalCols`, trailing tabs are
 *     dropped and an ellipsis is appended (`…` Unicode, `...` ASCII).
 *     Numeric keys (D3.1-02) remain the escape hatch for reaching truncated tabs.
 *
 * This module is pure — no @clack/core, no process.stdout side effects.
 */
import pc from 'picocolors';

export interface TabDescriptor {
  /** Uppercase label from CATEGORY_LABEL (e.g. 'AGENTS', 'MCP SERVERS'). */
  label: string;
}

/**
 * Render the tab bar as a single styled string.
 *
 * Returns the empty string when `tabs.length === 0` — the caller decides
 * whether to render a blank line or omit the bar.
 */
export function renderTabBar(input: {
  tabs: readonly TabDescriptor[];
  activeIndex: number;
  useAscii: boolean;
  terminalCols: number;
}): string {
  const { tabs, activeIndex, useAscii, terminalCols } = input;
  if (tabs.length === 0) return '';

  const sep = useAscii ? ' | ' : ' │ ';
  const sepVisible = useAscii ? 3 : 3; // both ' | ' and ' │ ' are 3 visible cols
  const ellipsis = useAscii ? '...' : '…';
  const ellipsisSuffixVisible = 1 + ellipsis.length; // leading space + ellipsis

  // Pre-style each tab label.
  const styled = tabs.map((t, i) => {
    if (i === activeIndex) return pc.inverse(pc.bold(t.label));
    return pc.dim(t.label);
  });
  const labelVisible = tabs.map((t) => t.label.length);

  // Plain tally of visible width as we go. We build an accepted prefix and
  // return either the full bar (if everything fits) or (prefix + ' ' + ellipsis)
  // when truncation happens.
  let out = '';
  let visibleSoFar = 0;

  for (let i = 0; i < styled.length; i++) {
    const segmentVisible = (i === 0 ? 0 : sepVisible) + labelVisible[i]!;
    // Remaining tabs after this one (i+1..end). If any remain, we must reserve
    // room for an ellipsis suffix in case they don't fit.
    const moreAfter = i < styled.length - 1;
    const reserve = moreAfter ? ellipsisSuffixVisible : 0;

    if (visibleSoFar + segmentVisible > terminalCols) {
      // This tab doesn't fit — truncate with ellipsis (if we have anything
      // accepted). If nothing is accepted yet, return just the ellipsis.
      if (out === '') return ellipsis;
      return out + ' ' + ellipsis;
    }

    // Optimistically accept this tab.
    const tentative = out === '' ? styled[i]! : out + sep + styled[i]!;
    const tentativeVisible = visibleSoFar + segmentVisible;

    // Edge case: accepting this tab leaves no room for the ellipsis suffix
    // needed to signal remaining tabs. If there's another tab after this one
    // AND that tab would NOT fit, we must NOT accept this tab as the last
    // visible — back off and emit ellipsis now.
    if (moreAfter) {
      const nextVisible = sepVisible + labelVisible[i + 1]!;
      const wouldNextFit = tentativeVisible + nextVisible <= terminalCols;
      const canFitEllipsisAfter = tentativeVisible + ellipsisSuffixVisible <= terminalCols;
      if (!wouldNextFit && !canFitEllipsisAfter) {
        // Accepting this tab traps us — can't show next tab and can't fit an
        // ellipsis after it. So do NOT accept; emit ellipsis from current
        // accepted prefix (if any).
        if (out === '') {
          // First tab is too wide even with ellipsis reserve — emit just ellipsis.
          return ellipsis;
        }
        return out + ' ' + ellipsis;
      }
    }

    out = tentative;
    visibleSoFar = tentativeVisible;
    void reserve; // reserve is encoded in the check above
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // ANSI SGR escape pattern used to strip picocolors styling for width math.
  // The control character \x1b is intentional.
  // eslint-disable-next-line no-control-regex
  const ANSI_STRIP = /\x1b\[[0-9;]*m/g;
  const stripAnsi = (s: string): string => s.replace(ANSI_STRIP, '');

  describe('renderTabBar', () => {
    it('4 Unicode tabs that all fit: output contains │ separator and no …', () => {
      const tabs = [
        { label: 'AGENTS' },
        { label: 'SKILLS' },
        { label: 'MCP' },
        { label: 'MEMORY' },
      ];
      const out = renderTabBar({ tabs, activeIndex: 0, useAscii: false, terminalCols: 100 });
      expect(out).toContain('│');
      expect(out).not.toContain('…');
      // All four labels are present when there's room.
      const plain = stripAnsi(out);
      expect(plain).toContain('AGENTS');
      expect(plain).toContain('SKILLS');
      expect(plain).toContain('MCP');
      expect(plain).toContain('MEMORY');
    });

    it('4 ASCII tabs that all fit: output contains | separator (not │), no ...', () => {
      const tabs = [
        { label: 'AGENTS' },
        { label: 'SKILLS' },
        { label: 'MCP' },
        { label: 'MEMORY' },
      ];
      const out = renderTabBar({ tabs, activeIndex: 0, useAscii: true, terminalCols: 100 });
      expect(out).not.toContain('│');
      expect(out).toContain(' | ');
      expect(out).not.toContain('...');
    });

    it('6 Unicode tabs at terminalCols=40 are truncated with … ellipsis', () => {
      const tabs = [
        { label: 'AGENTS' },
        { label: 'SKILLS' },
        { label: 'MCP SERVERS' },
        { label: 'MEMORY' },
        { label: 'COMMANDS' },
        { label: 'HOOKS' },
      ];
      const out = renderTabBar({ tabs, activeIndex: 0, useAscii: false, terminalCols: 40 });
      expect(out).toContain('…');
      const plain = stripAnsi(out);
      // Total plain text must respect the terminalCols budget.
      expect(plain.length).toBeLessThanOrEqual(40);
      // First tab must fit; later tabs may be dropped.
      expect(plain).toContain('AGENTS');
      expect(plain).not.toContain('HOOKS');
    });

    it('6 ASCII tabs at terminalCols=40 are truncated with ... ellipsis', () => {
      const tabs = [
        { label: 'AGENTS' },
        { label: 'SKILLS' },
        { label: 'MCP SERVERS' },
        { label: 'MEMORY' },
        { label: 'COMMANDS' },
        { label: 'HOOKS' },
      ];
      const out = renderTabBar({ tabs, activeIndex: 0, useAscii: true, terminalCols: 40 });
      expect(out).toContain('...');
      expect(out).not.toContain('…');
      expect(stripAnsi(out).length).toBeLessThanOrEqual(40);
    });

    it('activeIndex=2 places the 3rd tab label after the second separator', () => {
      // Note: picocolors honors NO_COLOR in the test environment, so we cannot
      // reliably assert on ANSI codes. Instead, verify the active tab label
      // appears in the stripped output after two separators (one before each of
      // tab 1 and tab 2). This confirms tab 2 (activeIndex) is rendered in the
      // correct position — styling happens via pc.inverse/pc.bold at runtime.
      const tabs = [{ label: 'A' }, { label: 'B' }, { label: 'CCC' }, { label: 'D' }];
      const out = renderTabBar({ tabs, activeIndex: 2, useAscii: true, terminalCols: 100 });
      const plain = stripAnsi(out);
      // 'CCC' appears after two ' | ' separators (index 2 in a 4-tab bar).
      expect(plain).toMatch(/A \| B \| CCC/);
    });

    it('empty tabs array returns empty string', () => {
      const out = renderTabBar({ tabs: [], activeIndex: 0, useAscii: false, terminalCols: 100 });
      expect(out).toBe('');
    });

    it('visibleLength helper (inline): truncation respects terminalCols for short budget', () => {
      // 3 x 8-char labels + 3-col separators = 8 + 3 + 8 + 3 + 8 = 30 cols for all.
      // With terminalCols=20, we can only fit AAAAAAAA (8) + ' | ' (3) + BBBBBBBB (8) = 19.
      // Next tab doesn't fit; emit " ..." suffix if it fits within budget.
      const tabs = [{ label: 'AAAAAAAA' }, { label: 'BBBBBBBB' }, { label: 'CCCCCCCC' }];
      const out = renderTabBar({ tabs, activeIndex: 0, useAscii: true, terminalCols: 20 });
      expect(stripAnsi(out).length).toBeLessThanOrEqual(20);
      expect(out).toContain('AAAAAAAA');
      expect(out).toContain('...');
    });
  });
}
