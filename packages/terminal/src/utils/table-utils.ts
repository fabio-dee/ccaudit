/** Strip ANSI escape codes to measure visible string length. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

export function truncateAnsi(str: string, maxVisible: number): string {
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  let result = '';
  let visibleCount = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ansiRegex.exec(str)) !== null) {
    const textBefore = str.slice(lastIndex, match.index);
    const remaining = maxVisible - visibleCount;
    if (textBefore.length <= remaining) {
      result += textBefore;
      visibleCount += textBefore.length;
    } else {
      result += textBefore.slice(0, remaining);
      result += '\x1b[0m';
      return result;
    }
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  const tail = str.slice(lastIndex);
  const remaining = maxVisible - visibleCount;
  if (tail.length <= remaining) {
    result += tail;
  } else {
    result += tail.slice(0, remaining);
    result += '\x1b[0m';
  }
  return result;
}

/**
 * Word-aware wrap. Returns an array of lines where each line's visible
 * length (ANSI-stripped) is ≤ maxVisible. Splits on spaces/hyphens;
 * force-breaks single tokens that exceed maxVisible.
 */
export function wordWrap(text: string, maxVisible: number): string[] {
  if (text === '') return [''];

  const lines: string[] = [];
  // Split on spaces; we re-add spaces by joining with ' '
  const words = text.split(' ');
  let current = '';

  for (const word of words) {
    // Handle words that individually exceed maxVisible (force-break)
    const parts: string[] = [];
    let remaining = word;
    while (stripAnsi(remaining).length > maxVisible) {
      parts.push(remaining.slice(0, maxVisible));
      remaining = remaining.slice(maxVisible);
    }
    if (remaining.length > 0) parts.push(remaining);

    for (const part of parts) {
      if (current === '') {
        current = part;
      } else {
        const candidate = current + ' ' + part;
        if (stripAnsi(candidate).length <= maxVisible) {
          current = candidate;
        } else {
          lines.push(current);
          current = part;
        }
      }
    }
  }

  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Wrap text to fit within a table cell of cellWidth characters.
 * Each returned line is exactly cellWidth chars: 1 space left pad + content + right pad.
 */
export function wrapCell(text: string, cellWidth: number): string[] {
  const innerWidth = cellWidth - 2; // 1 left pad + 1 right pad minimum
  const wrappedLines = wordWrap(text, innerWidth);
  return wrappedLines.map((line) => {
    const visLen = stripAnsi(line).length;
    const rightPad = ' '.repeat(Math.max(0, cellWidth - 1 - visLen));
    return ' ' + line + rightPad;
  });
}

/**
 * Build a single horizontal divider row for a multi-column box.
 * The caller supplies the exact cap/separator characters to produce
 * ┬, ┼, or ┴ style rows.
 *
 * @param colWidths  Width (in chars) of each column, excluding border chars.
 * @param leftCap    Left edge character, e.g. '├'
 * @param innerSep   Inner column separator, e.g. '┬', '┼', or '┴'
 * @param rightCap   Right edge character, e.g. '┤'
 */
export function buildDividerRow(
  colWidths: number[],
  leftCap: string,
  innerSep: string,
  rightCap: string,
): string {
  return leftCap + colWidths.map((w) => '─'.repeat(w)).join(innerSep) + rightCap;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('stripAnsi', () => {
    it('removes basic ANSI color codes', () => {
      expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    });

    it('leaves plain strings unchanged', () => {
      expect(stripAnsi('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('removes multiple consecutive codes', () => {
      expect(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m')).toBe('bold green');
    });
  });

  describe('getTerminalWidth', () => {
    it('returns a positive integer', () => {
      const w = getTerminalWidth();
      expect(typeof w).toBe('number');
      expect(w).toBeGreaterThan(0);
    });

    it('returns 80 when process.stdout.columns is 0 or falsy', () => {
      const origColumns = process.stdout.columns;
      process.stdout.columns = 0;
      expect(getTerminalWidth()).toBe(80);
      process.stdout.columns = origColumns;
    });
  });

  describe('truncateAnsi', () => {
    it('does not truncate when string fits', () => {
      expect(truncateAnsi('hello', 10)).toBe('hello');
    });

    it('truncates plain text to maxVisible chars', () => {
      const result = truncateAnsi('hello world', 5);
      // visible length must be exactly 5; result may carry a trailing reset code
      expect(stripAnsi(result)).toHaveLength(5);
      expect(stripAnsi(result)).toBe('hello');
    });

    it('preserves ANSI codes within budget', () => {
      const colored = '\x1b[31mhi\x1b[0m';
      const result = truncateAnsi(colored, 5);
      // visible portion is 'hi' (2 chars), well within 5
      expect(stripAnsi(result)).toBe('hi');
    });

    it('resets color when cutting mid-ANSI sequence', () => {
      const colored = '\x1b[31mlongword\x1b[0m';
      const result = truncateAnsi(colored, 4);
      // Should end with reset code
      expect(result).toContain('\x1b[0m');
      expect(stripAnsi(result).length).toBeLessThanOrEqual(4);
    });
  });

  describe('wordWrap', () => {
    it('returns single line for short text', () => {
      expect(wordWrap('hello', 20)).toEqual(['hello']);
    });

    it('wraps at word boundaries', () => {
      const lines = wordWrap('hello world foo bar', 10);
      for (const line of lines) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(10);
      }
    });

    it('returns [""] for empty string', () => {
      expect(wordWrap('', 10)).toEqual(['']);
    });

    it('force-breaks tokens longer than maxVisible', () => {
      const lines = wordWrap('superlongwordthatexceedsmax', 5);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('wrapCell', () => {
    it('pads content to cellWidth', () => {
      const lines = wrapCell('hi', 10);
      for (const line of lines) {
        expect(line).toHaveLength(10);
      }
    });

    it('starts each line with a space', () => {
      const lines = wrapCell('hello', 12);
      for (const line of lines) {
        expect(line[0]).toBe(' ');
      }
    });

    it('wraps long content into multiple lines all of cellWidth', () => {
      const lines = wrapCell('one two three four five', 10);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line).toHaveLength(10);
      }
    });
  });

  describe('buildDividerRow', () => {
    it('builds a ┬ style header divider', () => {
      const result = buildDividerRow([3, 3, 3], '├', '┬', '┤');
      expect(result).toBe('├───┬───┬───┤');
    });

    it('builds a ┼ style between-row divider', () => {
      const result = buildDividerRow([4, 4], '├', '┼', '┤');
      expect(result).toBe('├────┼────┤');
    });

    it('builds a ┴ style close-columns divider', () => {
      const result = buildDividerRow([2, 2, 2], '├', '┴', '┤');
      expect(result).toBe('├──┴──┴──┤');
    });

    it('handles a single column (no inner separator)', () => {
      const result = buildDividerRow([5], '├', '┼', '┤');
      expect(result).toBe('├─────┤');
    });

    it('produces correct total length', () => {
      const widths = [14, 14, 13, 20];
      const result = buildDividerRow(widths, '├', '┬', '┤');
      // 2 caps + 3 inner seps + sum(widths) = 2 + 3 + 61 = 66 chars
      expect(result.length).toBe(2 + (widths.length - 1) + widths.reduce((a, b) => a + b, 0));
    });
  });
}
