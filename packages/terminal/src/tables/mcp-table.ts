import { colorize } from '../color.ts';
import type { TokenCostResult } from '@ccaudit/internal';
import { classifyRecommendation, formatTokenEstimate } from '@ccaudit/internal';
import { getTerminalWidth, stripAnsi, wrapCell, buildDividerRow } from '../utils/table-utils.ts';

/**
 * Render the MCP servers table as a responsive Unicode-bordered table.
 *
 * Columns (per UI-SPEC):
 *   Server | Scope | Tier | Invocations | Last Used | ~Token Cost | Action
 *
 * The Server column is flexible: it expands when the terminal is wide enough and
 * falls back to a content-driven minimum on narrow terminals. All other columns
 * are fixed-width so text is never truncated.
 *
 * Fixed column widths (each includes 1-char left pad + content + right pad):
 *   Scope        : 9   ("project"    =  7 visible)
 *   Tier         : 10  ("[LIKELY]"   =  8 visible, ANSI-stripped)
 *   Invocations  : 12  ("9999"       right-aligned in 10 content chars)
 *   Last Used    : 10  ("999d ago"   =  8 visible)
 *   ~Token Cost  : 25  (~15k tokens (estimated) = 23 visible, word-wraps)
 *   Action       : 9   ("Archive"    =  7 visible)
 *
 *   Fixed total: 9+10+12+10+25+9 = 75
 *   Borders: 8 chars (1 left + 6 inner + 1 right)
 *   Server: Math.max(15, tw - 83) — expands on wide terminals, min 15 on narrow
 *
 * When the terminal is narrower than the minimum table width, the table exceeds
 * tw and the terminal wraps naturally — this preserves all content with no
 * truncation.
 *
 * Narrow terminal fallback (<40 cols): plain text, no box drawing.
 *
 * Returns the rendered table string.
 */
export function renderMcpTable(results: TokenCostResult[]): string {
  const tw = getTerminalWidth();

  // Narrow terminal fallback: plain text so output is never unreadable
  if (tw < 40) {
    return results
      .map((r) => {
        const rec = classifyRecommendation(r.tier);
        return `${r.item.name} [${r.tier}] ${formatLastUsed(r.lastUsed)} ${formatRecommendation(rec)}`;
      })
      .join('\n');
  }

  // Fixed column widths (each includes 1-char left pad + content + right pad)
  const scopeW = 9; // "Scope"
  const tierW = 10; // "Tier"
  const invW = 12; // "Invocations"
  const ageW = 10; // "Last Used"
  const tokW = 25; // "~Token Cost"
  const actW = 9; // "Action"

  // 8 border chars: 1 outer-left + 6 inner '│' + 1 outer-right
  const fixedTotal = scopeW + tierW + invW + ageW + tokW + actW + 8;
  // Server column grows with terminal width; minimum 15 chars so it always renders
  // even on narrow terminals — the table may exceed tw on very small screens but
  // will never truncate any column content.
  const serverW = Math.max(15, tw - fixedTotal);

  const colWidths = [serverW, scopeW, tierW, invW, ageW, tokW, actW] as const;

  const lines: string[] = [];

  // Top border
  lines.push(buildDividerRow([...colWidths], '┌', '┬', '┐'));

  // Header row
  lines.push(
    '│' +
      wrapCell('Server', serverW)[0]! +
      '│' +
      wrapCell('Scope', scopeW)[0]! +
      '│' +
      wrapCell('Tier', tierW)[0]! +
      '│' +
      wrapCell('Invocations', invW)[0]! +
      '│' +
      wrapCell('Last Used', ageW)[0]! +
      '│' +
      wrapCell('~Token Cost', tokW)[0]! +
      '│' +
      wrapCell('Action', actW)[0]! +
      '│',
  );

  // Header / data divider
  lines.push(buildDividerRow([...colWidths], '├', '┼', '┤'));

  // Data rows
  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri]!;
    const tierStr = formatTier(r.tier);
    const lastUsedStr = formatLastUsed(r.lastUsed);
    const tokenCostStr = formatTokenEstimate(r.tokenEstimate);
    const recommendation = classifyRecommendation(r.tier);
    const actionStr = formatRecommendation(recommendation);

    const c0Lines = wrapCell(r.item.name, serverW);
    const c1Lines = wrapCell(r.item.scope, scopeW);

    // Tier and action are short colored labels — render on first sub-line only,
    // pad with spaces on subsequent sub-lines (matches ghost-table row pattern).
    const tierCell = buildColoredCell(tierStr, tierW);
    const actionCell = buildColoredCell(actionStr, actW);

    // Invocations: right-aligned within cell (1 space left + 10 content + 1 right = 12)
    const invStr = String(r.invocationCount).padStart(10);
    const invCell = ' ' + invStr + ' '; // 12 chars

    // Last Used: right-aligned within cell (1 space left, padded right)
    const ageVisible = stripAnsi(lastUsedStr);
    const ageCell = ' ' + lastUsedStr + ' '.repeat(Math.max(0, ageW - 1 - ageVisible.length));

    // Token Cost: word-wraps to fit tokW
    const c5Lines = wrapCell(tokenCostStr, tokW);

    const rowHeight = Math.max(c0Lines.length, c1Lines.length, c5Lines.length, 1);

    for (let sub = 0; sub < rowHeight; sub++) {
      const cell0 = c0Lines[sub] ?? ' '.repeat(serverW);
      const cell1 = c1Lines[sub] ?? ' '.repeat(scopeW);
      const cell2 = sub === 0 ? tierCell : ' '.repeat(tierW);
      const cell3 = sub === 0 ? invCell : ' '.repeat(invW);
      const cell4 = sub === 0 ? ageCell : ' '.repeat(ageW);
      const cell5 = c5Lines[sub] ?? ' '.repeat(tokW);
      const cell6 = sub === 0 ? actionCell : ' '.repeat(actW);

      lines.push(
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
      );
    }

    // Insert between-row divider after every data row except the last
    if (ri < results.length - 1) {
      lines.push(buildDividerRow([...colWidths], '├', '┼', '┤'));
    }
  }

  // Bottom border
  lines.push(buildDividerRow([...colWidths], '└', '┴', '┘'));

  return lines.join('\n');
}

/**
 * Build a fixed-width cell for a colored label.
 * The label is left-aligned within the cell width (1 left pad + content + right pad).
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

  describe('renderMcpTable', () => {
    it('produces string containing Server header for 1 item', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'sequential-thinking',
            path: '/home/user/.claude.json',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 15000, confidence: 'estimated', source: 'test' },
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('Server');
    });

    it('contains invocation count column', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'context7',
            path: '/home/user/.claude.json',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 42,
          tokenEstimate: { tokens: 8000, confidence: 'measured', source: 'live' },
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('42');
    });

    it('formats likely-ghost tier with yellow LIKELY label', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'edge-case',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'likely-ghost',
          lastUsed: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          invocationCount: 0,
          tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'test' },
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('edge-case');
      expect(output).toContain('LIKELY');
    });

    it('formats monitor recommendation for likely-ghost', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'watch-me',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'likely-ghost',
          lastUsed: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
          invocationCount: 0,
          tokenEstimate: null,
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('Monitor');
    });

    it('formats keep recommendation and ACTIVE tier with today lastUsed', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'active',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 10,
          tokenEstimate: { tokens: 500, confidence: 'measured', source: 'live' },
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('Keep');
      expect(output).toContain('ACTIVE');
      expect(output).toContain('today');
    });

    it('formats 1d ago for exactly 1 day lastUsed', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'yesterday',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          lastUsed: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 - 60000),
          tier: 'used',
          invocationCount: 1,
          tokenEstimate: null,
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('1d ago');
    });

    it('formats Nd ago for multi-day lastUsed', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'last-week',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          invocationCount: 0,
          tokenEstimate: { tokens: 2000, confidence: 'community-reported', source: 'test' },
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('5d ago');
    });

    it('formats never for null lastUsed on definite-ghost with Archive action', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'dead',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: null,
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('never');
      expect(output).toContain('GHOST');
      expect(output).toContain('Archive');
    });

    it('inserts divider rows between data rows', () => {
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'server-a',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 1,
          tokenEstimate: null,
        },
        {
          item: {
            name: 'server-b',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: null,
        },
      ];
      const output = renderMcpTable(results);
      // Between-row dividers use ┼ as inner separator
      expect(output).toContain('┼');
    });

    it('uses plain text fallback when terminal width < 40', () => {
      const origColumns = process.stdout.columns;
      process.stdout.columns = 30;
      const results: TokenCostResult[] = [
        {
          item: {
            name: 'narrow-server',
            path: '/x',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: null,
        },
      ];
      const output = renderMcpTable(results);
      expect(output).toContain('narrow-server');
      expect(output).not.toContain('┌');
      process.stdout.columns = origColumns;
    });
  });
}
