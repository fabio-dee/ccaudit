import { colorize } from '../color.ts';

/**
 * Render a branded header line for a CLI command.
 *
 * Format (per D-06, D-08):
 *   {emoji} {Title} \u2014 Last {sinceWindow}
 *   \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
 *
 * The sinceWindow parameter should be human-readable (e.g. "7 days").
 * When wastedTokens is provided, a tool name row is added above:
 *   CCAUDIT - ~7.0k tokens/session wasted
 *   \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
 *
 * Returns the header as a single string (2 or 4 lines depending on wastedTokens).
 */
export function renderHeader(
  emoji: string,
  title: string,
  sinceWindow: string,
  wastedTokens?: number,
): string {
  const headerText = `${emoji} ${title} \u2014 Last ${sinceWindow}`;
  // Strip ANSI codes to measure visual width
  const visualWidth = stripAnsi(headerText).length;
  const dividerWidth = Math.max(32, visualWidth);
  const divider = renderDivider(dividerWidth);

  if (wastedTokens !== undefined && wastedTokens > 0) {
    const toolLine = `CCAUDIT - ${formatTokensForHeader(wastedTokens)} tokens/session wasted`;
    const toolVisualWidth = stripAnsi(toolLine).length;
    const toolDividerWidth = Math.max(dividerWidth, toolVisualWidth);
    const toolDivider = renderDivider(toolDividerWidth);
    return `${colorize.bold(toolLine)}\n${toolDivider}\n${colorize.bold(headerText)}\n${renderDivider(toolDividerWidth)}`;
  }

  return `${colorize.bold(headerText)}\n${divider}`;
}

/**
 * Render a cyan heavy box-drawing divider of the specified width.
 * Uses U+2501 BOX DRAWINGS HEAVY HORIZONTAL.
 */
export function renderDivider(width: number): string {
  return colorize.cyan('\u2501'.repeat(width));
}

/**
 * Convert a raw --since duration string to a human-readable window label.
 *
 * Examples:
 *   "7d"  -> "7 days"
 *   "30d" -> "30 days"
 *   "2w"  -> "2 weeks"
 *   "1d"  -> "1 day"
 *   "1w"  -> "1 week"
 */
export function humanizeSinceWindow(sinceStr: string): string {
  const match = sinceStr.match(/^(\d+)([dw])$/i);
  if (!match) return sinceStr;

  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();

  if (unit === 'd') {
    return value === 1 ? '1 day' : `${value} days`;
  }
  if (unit === 'w') {
    return value === 1 ? '1 week' : `${value} weeks`;
  }

  return sinceStr;
}

/** Strip ANSI escape codes for width measurement. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * Format token count for header display (e.g., "~7.0k", "~47k", "~125k").
 * Uses tilde prefix to indicate estimate.
 */
function formatTokensForHeader(tokens: number): string {
  if (tokens < 1000) {
    return `~${tokens}`;
  }
  const k = tokens / 1000;
  // Show one decimal for values under 10k, otherwise round to integer
  if (k < 10) {
    return `~${k.toFixed(1)}k`;
  }
  return `~${Math.round(k)}k`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderHeader', () => {
    it('returns string containing emoji, title, and sinceWindow', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days');
      expect(result).toContain('\u{1F47B}');
      expect(result).toContain('Ghost Inventory');
      expect(result).toContain('7 days');
    });

    it('output contains U+2501 heavy horizontal box character', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days');
      expect(result).toContain('\u2501');
    });

    it('contains em dash separator', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days');
      expect(result).toContain('\u2014');
    });

    it('includes CCAUDIT tool name row when wastedTokens provided', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 7000);
      expect(result).toContain('CCAUDIT');
      expect(result).toContain('tokens/session wasted');
    });

    it('formats tokens correctly in tool name row', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 7000);
      expect(result).toContain('~7.0k');
    });

    it('has 4 lines when wastedTokens provided (tool + divider + header + divider)', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 7000);
      const lines = result.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('has 2 lines when wastedTokens not provided', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days');
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
    });

    it('skips tool name row when wastedTokens is 0', () => {
      const result = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 0);
      expect(result).not.toContain('CCAUDIT');
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
    });
  });

  describe('humanizeSinceWindow', () => {
    it("converts '7d' to '7 days'", () => {
      expect(humanizeSinceWindow('7d')).toBe('7 days');
    });

    it("converts '2w' to '2 weeks'", () => {
      expect(humanizeSinceWindow('2w')).toBe('2 weeks');
    });

    it("converts '30d' to '30 days'", () => {
      expect(humanizeSinceWindow('30d')).toBe('30 days');
    });

    it("converts '1d' to '1 day' (singular)", () => {
      expect(humanizeSinceWindow('1d')).toBe('1 day');
    });

    it("converts '1w' to '1 week' (singular)", () => {
      expect(humanizeSinceWindow('1w')).toBe('1 week');
    });

    it('returns raw string for unrecognized format', () => {
      expect(humanizeSinceWindow('unknown')).toBe('unknown');
    });
  });
}
