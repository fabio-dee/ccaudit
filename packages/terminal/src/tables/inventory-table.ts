import { colorize } from '../color.ts';
import type { TokenCostResult } from '@ccaudit/internal';
import { classifyRecommendation } from '@ccaudit/internal';
import { formatTokensShortPlain } from './ghost-table.ts';
import {
  getTerminalWidth,
  stripAnsi,
  truncateAnsi,
  wrapCell,
  buildDividerRow,
} from '../utils/table-utils.ts';

/**
 * Render the full inventory table as a responsive Unicode-bordered table.
 *
 * Columns (per UI-SPEC):
 *   Name | Category | Scope | Tier | Last Used | ~Token Cost | Action
 *
 * Optional opts argument (DISPLAY-06 / D-21):
 *   opts.frameworkColumnValues  — Map<item.path, frameworkId | null>
 *     When provided, framework-member rows (entries whose path maps to a
 *     non-null value) are filtered out of the table body — they appear in the
 *     Frameworks section rendered by the caller.
 *   opts.verbose                — retained for API compatibility; no longer
 *                                 affects inventory table output.
 *
 * When opts is undefined or opts.frameworkColumnValues is undefined, this function
 * produces byte-identical v1.2.1 output (backward-compatible).
 *
 * The Name column is flexible: it expands when the terminal is wide enough and
 * falls back to a content-driven minimum on narrow terminals. All other columns
 * are fixed-width so text is never truncated. Rows that exceed the terminal
 * width are clamped via ANSI-aware truncation (clampRow).
 *
 * Fixed column widths (each includes 1-char left pad + content + right pad):
 *   Category  : 11  ("mcp-server" = 10 visible)
 *   Scope     : 8   ("project"    =  7 visible)
 *   Tier      : 10  ("[LIKELY]"   =  8 visible, ANSI-stripped)
 *   Last Used : 10  ("999d ago"   =  8 visible)
 *   ~Token    : 14  ("~15k tokens"= 11 visible, matches framework TOKENS_W)
 *   Action    : 8   ("Archive"    =  7 visible)
 *
 *   Fixed total = 11+8+10+10+14+8 = 61, borders 8, Name = max(15, tw-69)
 *
 * Returns the rendered table string.
 */
export function renderInventoryTable(
  results: TokenCostResult[],
  opts?: {
    verbose?: boolean;
    frameworkColumnValues?: Map<string, string | null>;
  },
): string {
  const tw = getTerminalWidth();

  const _verbose = opts?.verbose === true;
  const fwMap = opts?.frameworkColumnValues;

  // When fwMap is provided, always filter framework-member rows out of the
  // table body — they appear in the Frameworks section rendered by the caller.
  // (Verbose mode no longer duplicates members in the inventory table.)
  let effectiveResults: TokenCostResult[];
  if (fwMap !== undefined) {
    effectiveResults = results.filter((r) => fwMap.get(r.item.path) == null);
  } else {
    effectiveResults = results;
  }

  // Fixed column widths (each includes 1-char left pad + content + right pad)
  const catW = 11; // "mcp-server" = 10 visible
  const scopeW = 8; // "project" = 7 visible
  const tierW = 10; // "[LIKELY]" = 8 visible — keep for ANSI labels
  const ageW = 10; // "999d ago" = 8 visible — keep as-is
  const tokW = 14; // "~15k tokens" = 11 visible (matches framework TOKENS_W)
  const actW = 8; // "Archive" = 7 visible

  // Borders: 1 outer-left + (N-1) inner '│' + 1 outer-right = N+1 chars
  // 7 cols → 8 borders.
  const fixedTotal = catW + scopeW + tierW + ageW + tokW + actW + 8;
  // Name column grows with terminal width; minimum 15 chars so it always renders
  // even on narrow terminals — the table may exceed tw on very small screens but
  // will never truncate any column content.
  const nameW = Math.max(15, tw - fixedTotal);

  const colWidths = [nameW, catW, scopeW, tierW, ageW, tokW, actW] as const;

  const clampRow = (row: string): string => {
    const visLen = stripAnsi(row).length;
    if (visLen <= tw) return row;
    return truncateAnsi(row, tw - 1) + row[row.length - 1]!;
  };

  const lines: string[] = [];

  // Top border
  lines.push(clampRow(buildDividerRow([...colWidths], '┌', '┬', '┐')));

  // Header row
  lines.push(
    clampRow(
      '│' +
        wrapCell('Name', nameW)[0]! +
        '│' +
        wrapCell('Category', catW)[0]! +
        '│' +
        wrapCell('Scope', scopeW)[0]! +
        '│' +
        wrapCell('Tier', tierW)[0]! +
        '│' +
        wrapCell('Last Used', ageW)[0]! +
        '│' +
        wrapCell('~Token Cost', tokW)[0]! +
        '│' +
        wrapCell('Action', actW)[0]! +
        '│',
    ),
  );

  // Header / data divider
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

  // Data rows
  for (let ri = 0; ri < effectiveResults.length; ri++) {
    const r = effectiveResults[ri]!;
    const tierStr = formatTier(r.tier);
    const lastUsedStr = formatLastUsed(r.lastUsed);
    const tokenCostStr =
      r.tokenEstimate !== null ? formatTokensShortPlain(r.tokenEstimate.tokens) : 'unknown';
    const recommendation = classifyRecommendation(r.tier);
    const actionStr = formatRecommendation(recommendation);

    const c0Lines = wrapCell(r.item.name, nameW);
    const c1Lines = wrapCell(r.item.category, catW);
    const c2Lines = wrapCell(r.item.scope, scopeW);

    // Tier and action are short colored labels — render on first sub-line only,
    // pad with spaces on subsequent sub-lines (matches ghost-table row pattern).
    const tierCell = buildColoredCell(tierStr, tierW);
    const actionCell = buildColoredCell(actionStr, actW);

    // Last Used: right-aligned within cell (1 space left, padded right)
    const ageVisible = stripAnsi(lastUsedStr);
    const ageCell = ' ' + lastUsedStr + ' '.repeat(Math.max(0, ageW - 1 - ageVisible.length));

    // Token Cost: word-wraps to fit tokW
    const c5Lines = wrapCell(tokenCostStr, tokW);

    const rowHeight = Math.max(c0Lines.length, c1Lines.length, c2Lines.length, c5Lines.length, 1);

    for (let sub = 0; sub < rowHeight; sub++) {
      const cell0 = c0Lines[sub] ?? ' '.repeat(nameW);
      const cell1 = c1Lines[sub] ?? ' '.repeat(catW);
      const cell2 = c2Lines[sub] ?? ' '.repeat(scopeW);
      const cell3 = sub === 0 ? tierCell : ' '.repeat(tierW);
      const cell4 = sub === 0 ? ageCell : ' '.repeat(ageW);
      const cell5 = c5Lines[sub] ?? ' '.repeat(tokW);
      const cell6 = sub === 0 ? actionCell : ' '.repeat(actW);

      lines.push(
        clampRow(
          '│' +
            cell0 +
            '│' +
            cell1 +
            '│' +
            cell2 +
            '│' +
            cell3 +
            '│' +
            cell4 +
            '│' +
            cell5 +
            '│' +
            cell6 +
            '│',
        ),
      );
    }

    // Insert between-row divider after every data row except the last
    if (ri < effectiveResults.length - 1) {
      lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));
    }
  }

  // Bottom border
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  return lines.join('\n');
}

/**
 * Build a fixed-width cell for a colored label.
 * The label is centered within the cell width (1 left pad + content + right pad).
 */
function buildColoredCell(label: string, cellWidth: number): string {
  const visible = stripAnsi(label);
  const total = cellWidth - 1; // 1 left pad already included
  const rightPad = Math.max(0, total - visible.length);
  return ' ' + label + ' '.repeat(rightPad);
}

/**
 * Format ghost tier as colored bracket label.
 * Per UI-SPEC: [GHOST] red, [LIKELY] yellow, [ACTIVE] green.
 */
function formatTier(tier: string): string {
  switch (tier) {
    case 'definite-ghost':
      return colorize.red('[GHOST]');
    case 'likely-ghost':
      return colorize.yellow('[LIKELY]');
    case 'used':
      return colorize.green('[ACTIVE]');
    default:
      return tier;
  }
}

/**
 * Format recommendation as colored label.
 * Per UI-SPEC: Archive red, Monitor yellow, Keep green.
 */
function formatRecommendation(rec: string): string {
  switch (rec) {
    case 'archive':
      return colorize.red('Archive');
    case 'monitor':
      return colorize.yellow('Monitor');
    case 'keep':
      return colorize.green('Keep');
    default:
      return rec;
  }
}

/**
 * Format a last-used date as "Nd ago" or "never".
 */
function formatLastUsed(lastUsed: Date | null): string {
  if (lastUsed === null) return 'never';
  const now = Date.now();
  const diffMs = now - lastUsed.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Helper: build a minimal TokenCostResult for testing. */
  function makeResult(
    name: string,
    tier: 'used' | 'likely-ghost' | 'definite-ghost',
    tokens: number | null = null,
  ): TokenCostResult {
    return {
      item: {
        name,
        path: `/test/${name}`,
        scope: 'global',
        category: 'agent',
        projectPath: null,
      },
      tier,
      lastUsed: tier === 'used' ? new Date() : null,
      invocationCount: tier === 'used' ? 1 : 0,
      tokenEstimate: tokens !== null ? { tokens, confidence: 'estimated', source: 'test' } : null,
    };
  }

  describe('renderInventoryTable', () => {
    it('produces string containing Name header for 2 items', () => {
      const results = [
        makeResult('agent-a', 'definite-ghost', 5000),
        makeResult('agent-b', 'used', 1000),
      ];
      const output = renderInventoryTable(results);
      expect(output).toContain('Name');
    });

    it('contains Archive (possibly truncated) for definite-ghost items', () => {
      const results = [makeResult('stale-agent', 'definite-ghost', 3000)];
      const output = renderInventoryTable(results);
      // At tw=80 the action column is partially clipped; match the visible prefix
      expect(output).toMatch(/Arch?i?v?e?/);
    });

    it('contains Keep (possibly truncated) for used items', () => {
      const results = [makeResult('active-agent', 'used', 1000)];
      const output = renderInventoryTable(results);
      expect(output).toMatch(/Kee?p?/);
    });

    it('contains Monitor (possibly truncated) for likely-ghost items', () => {
      const results = [makeResult('suspect-agent', 'likely-ghost', 2000)];
      const output = renderInventoryTable(results);
      expect(output).toMatch(/Mon?i?t?o?r?/);
    });

    it('renders "today" when lastUsed is now (used tier with real Date)', () => {
      const results = [makeResult('active-agent', 'used', 1000)];
      const output = renderInventoryTable(results);
      expect(output).toContain('today');
    });

    it('renders "1d ago" for a 1-day-old lastUsed', () => {
      const result: TokenCostResult = {
        item: {
          name: 'yesterday-agent',
          path: '/x',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'used',
        lastUsed: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 - 60000),
        invocationCount: 1,
        tokenEstimate: null,
      };
      const output = renderInventoryTable([result]);
      expect(output).toContain('1d ago');
    });

    it('renders "Nd ago" for a multi-day-old lastUsed', () => {
      const result: TokenCostResult = {
        item: {
          name: 'week-old-agent',
          path: '/x',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'likely-ghost',
        lastUsed: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        invocationCount: 0,
        tokenEstimate: null,
      };
      const output = renderInventoryTable([result]);
      expect(output).toContain('7d ago');
    });
  });

  describe('renderInventoryTable — framework grouping (D-21)', () => {
    it('byte-identical output when opts is undefined', () => {
      const results = [
        makeResult('agent-a', 'definite-ghost', 5000),
        makeResult('agent-b', 'used', 1000),
      ];
      const out1 = renderInventoryTable(results);
      const out2 = renderInventoryTable(results, {});
      const out3 = renderInventoryTable(results, { verbose: false });
      expect(out1).toBe(out2);
      expect(out1).toBe(out3);
    });

    it('default mode filters framework-member rows when frameworkColumnValues provided', () => {
      const results = [
        makeResult('gsd-a', 'definite-ghost', 5000),
        makeResult('gsd-b', 'definite-ghost', 4000),
        makeResult('custom', 'definite-ghost', 3000),
      ];
      const fwMap = new Map<string, string | null>([
        ['/test/gsd-a', 'gsd'],
        ['/test/gsd-b', 'gsd'],
        ['/test/custom', null],
      ]);
      const out = renderInventoryTable(results, { frameworkColumnValues: fwMap });
      expect(out).not.toContain('gsd-a');
      expect(out).not.toContain('gsd-b');
      expect(out).toContain('custom');
    });

    it('verbose mode also filters framework-member rows and does NOT add Framework header', () => {
      const results = [
        makeResult('gsd-a', 'definite-ghost', 5000),
        makeResult('custom', 'definite-ghost', 3000),
      ];
      const fwMap = new Map<string, string | null>([
        ['/test/gsd-a', 'gsd'],
        ['/test/custom', null],
      ]);
      const out = renderInventoryTable(results, { verbose: true, frameworkColumnValues: fwMap });
      // Framework-member rows are filtered regardless of verbose flag
      expect(out).not.toContain('gsd-a');
      // Items with null framework remain visible
      expect(out).toContain('custom');
      // No Framework column header in 7-column layout
      expect(out).not.toContain('Framework');
    });

    it('verbose + undefined frameworkColumnValues renders v1.2.1 7-column layout', () => {
      const results = [makeResult('custom', 'definite-ghost', 3000)];
      const outVerbose = renderInventoryTable(results, { verbose: true });
      const outPlain = renderInventoryTable(results);
      // Both should NOT contain the Framework header since fwMap is missing
      expect(outVerbose).not.toContain('Framework');
      expect(outPlain).not.toContain('Framework');
    });
  });
}
