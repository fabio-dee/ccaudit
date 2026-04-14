import { colorize } from '../color.ts';
import type {
  CategorySummary,
  ProjectGhostSummary,
  TokenCostResult,
  ItemCategory,
} from '@ccaudit/internal';
import { formatTokenEstimate } from '@ccaudit/internal';
import {
  stripAnsi,
  getTerminalWidth,
  truncateAnsi,
  wordWrap,
  wrapCell,
  buildDividerRow,
} from '../utils/table-utils.ts';

/**
 * Wrap a pre-assembled multi-line string in a Unicode box.
 * Width is capped at terminal width (or provided maxWidth) with truncation.
 */
function wrapInBox(content: string, padding = 1, maxWidth?: number): string {
  const termWidth = maxWidth ?? getTerminalWidth();
  const lines = content.split('\n');
  const naturalMax = Math.max(...lines.map((l) => stripAnsi(l).length), 0);
  // maxLen = max visible content chars per line
  // Total box width = maxLen + padding*2 + 2 (borders)
  const maxContentWidth = termWidth - 2 - padding * 2;
  const maxLen = Math.min(naturalMax, Math.max(maxContentWidth, 20));
  const innerWidth = maxLen + padding * 2;
  const top = '┌' + '─'.repeat(innerWidth) + '┐';
  const bottom = '└' + '─'.repeat(innerWidth) + '┘';
  const pad = ' '.repeat(padding);
  const body = lines.map((line) => {
    const visLen = stripAnsi(line).length;
    if (visLen > maxLen) {
      const truncated = truncateAnsi(line, maxLen - 1) + '…';
      const truncVisLen = stripAnsi(truncated).length;
      const rightPad = ' '.repeat(Math.max(0, maxLen - truncVisLen + padding));
      return '│' + pad + truncated + rightPad + '│';
    }
    const rightPad = ' '.repeat(maxLen - visLen + padding);
    return '│' + pad + line + rightPad + '│';
  });
  return [top, ...body, bottom].join('\n');
}

/**
 * Category display names for the summary table.
 * Order: agent, skill, mcp-server, memory, command, hook
 */
const CATEGORY_DISPLAY: Record<string, string> = {
  agent: 'Agents',
  skill: 'Skills',
  'mcp-server': 'MCP Servers',
  memory: 'Memory Files',
  command: 'Commands',
  hook: 'Hooks',
};

/** Padded category column width -- longest is "Memory Files" (12 chars), padded to 13 */
const CATEGORY_PAD = 13;

/**
 * Render the ghost summary table with column-aligned plain text (NOT cli-table3 borders).
 * Per D-02: one row per category.
 *
 * Format:
 *   Agents        Defined: 140   Used:  12   Ghost: 128   ~47k tokens/session
 *   Memory Files  Loaded:    9   Active:  3  Stale:   6   ~12k tokens/session
 */
export function renderGhostSummary(
  summaries: CategorySummary[],
  frameworkGhostsByCategory?: Partial<Record<ItemCategory, number>>,
): string {
  const lines: string[] = [];

  for (const s of summaries) {
    const catName = (CATEGORY_DISPLAY[s.category] ?? s.category).padEnd(CATEGORY_PAD);
    const isMemory = s.category === 'memory';

    // Per D-04: Memory uses Loaded/Active/Stale; others use Defined/Used/Ghost
    const label1 = isMemory ? 'Loaded:' : 'Defined:';
    const label2 = isMemory ? 'Active:' : 'Used:';
    const label3 = isMemory ? 'Stale:' : 'Ghost:';

    const val1 = String(s.defined).padStart(3);
    const val2 = String(s.used).padStart(3);
    const val3 = String(s.ghost).padStart(3);
    const tokenStr = formatTokenShort(s.tokenCost);

    const fwInCat = frameworkGhostsByCategory?.[s.category as ItemCategory] ?? 0;
    const ghostCell =
      fwInCat > 0 ? `${label3} ${val3} (${fwInCat} in frameworks above)` : `${label3} ${val3}`;

    lines.push(`${catName} ${label1} ${val1}   ${label2} ${val2}   ${ghostCell}   ${tokenStr}`);
  }

  return lines.join('\n');
}

/**
 * Render the top-N ghosts by token cost as a 4-column Unicode-bordered table.
 * Per D-03 and D-10.
 *
 * Column layout (5 border chars + 3 + nameW + 14 + 18 = tw):
 *   col0 (#)       : 3 chars
 *   col1 (Name)    : Math.max(15, tw - 40)  — flexible
 *   col2 (~Tokens) : 14 chars
 *   col3 (Cat,Age) : 18 chars
 *
 * Returns empty string if no global ghosts.
 */
export function renderTopGhosts(ghosts: TokenCostResult[], maxItems: number = 5): string {
  if (ghosts.length === 0) return '';

  // Filter to global-scope items only. Global ghosts waste tokens in EVERY
  // session regardless of project; project-specific ghosts are covered by
  // the per-project breakdown table below.
  const globalGhosts = ghosts.filter((g) => g.item.scope === 'global');
  if (globalGhosts.length === 0) return '';

  // Sort by token cost descending (nulls last)
  const sorted = [...globalGhosts].sort((a, b) => {
    const aTokens = a.tokenEstimate?.tokens ?? 0;
    const bTokens = b.tokenEstimate?.tokens ?? 0;
    return bTokens - aTokens;
  });

  const top = sorted.slice(0, maxItems);

  const tw = getTerminalWidth();
  // Guard: if the terminal is too narrow to render the table, fall back to
  // plain-text so output is never unreadable.
  if (tw < 40) return '';

  const nameW = Math.max(15, tw - 40);
  const colWidths = [3, nameW, 14, 18] as const;
  // innerWidth = sum(colWidths) + (ncols - 1) inner border chars = nameW + 3 + 14 + 18 + 3 = nameW + 38
  // tw = 2 outer caps + 3 inner seps + sum(colWidths) = 5 + (3 + nameW + 14 + 18) = nameW + 40 ✓
  const innerWidth = tw - 2;

  const titleText = '\u{1F6A8} Top global ghosts by token cost:';
  const titleVisible = stripAnsi(titleText);
  const titleContent = titleVisible.length > tw - 4 ? truncateAnsi(titleText, tw - 4) : titleText;
  const titleRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(titleContent).length));

  const clampRow = (row: string): string => {
    if (row.length <= tw) return row;
    return row.slice(0, tw - 1) + row[row.length - 1]!;
  };

  const lines: string[] = [];

  // Top border (full-width, no column dividers in title span)
  lines.push('┌' + '─'.repeat(innerWidth) + '┐');
  // Title row
  lines.push('│ ' + titleContent + titleRightPad + ' │');
  // Transition row: introduces column dividers (┬)
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┬', '┤')));

  // Column header row
  const hNum = ' # '.padEnd(3);
  const hName = wrapCell('Name', nameW)[0]!;
  const hTokens = wrapCell('~Tokens', 14)[0]!;
  const hCat = wrapCell('(Category, Age)', 18)[0]!;
  lines.push(clampRow('│' + hNum + '│' + hName + '│' + hTokens + '│' + hCat + '│'));

  // Divider between header and data rows (┼)
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

  // Data rows
  for (let i = 0; i < top.length; i++) {
    const g = top[i]!;
    // Use the short plain formatter (~15k tokens / ~500 tokens) to stay within
    // the 14-char column. formatTokenEstimate appends "(confidence)" which
    // is too wide.
    const tokenDisplay = formatTokensShortPlain(g.tokenEstimate?.tokens ?? 0);
    const category = g.item.category;
    const lastUsed = formatLastUsed(g.lastUsed);
    const catAge = `(${category}, ${lastUsed})`;

    // col0: right-align "N." within width 3
    const numStr = `${i + 1}.`;
    const c0 = numStr.padStart(2) + ' '; // e.g. " 1."
    // col1: name with word-wrap (usually 1 line)
    const c1Lines = wrapCell(g.item.name, nameW);
    // col2: right-align token display within width 14 (1 space pad each side = 12 content)
    const tokenStr = tokenDisplay.padStart(12);
    const c2 = ' ' + tokenStr + ' '; // 1 + 12 + 1 = 14
    // col3: catAge left-aligned in width 18
    const c3Lines = wrapCell(catAge, 18);

    const rowHeight = Math.max(c1Lines.length, c3Lines.length, 1);
    for (let r = 0; r < rowHeight; r++) {
      const cell1 = c1Lines[r] ?? ' '.repeat(nameW);
      const cell3 = c3Lines[r] ?? ' '.repeat(18);
      // Only emit col0 and col2 on the first sub-line of a multi-line row
      const cell0 = r === 0 ? c0 : '   ';
      const cell2 = r === 0 ? c2 : ' '.repeat(14);
      lines.push(clampRow('│' + cell0 + '│' + cell1 + '│' + cell2 + '│' + cell3 + '│'));
    }

    // No between-row dividers for a cleaner compact look — the column borders
    // provide sufficient visual separation between ghost entries.
  }

  // Bottom border
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  return lines.join('\n');
}

/**
 * Render the ghost command footer with two hint lines (dim per UI-SPEC).
 *
 * When `options.dryRunActive` is true (Phase 7, D-05), the bust hint is
 * suppressed because the dry-run caller emits its own checkpoint-confirmation footer.
 */
export function renderGhostFooter(
  _sinceWindow: string,
  options?: { dryRunActive?: boolean },
): string {
  const hint1 = colorize.dim('Run ccaudit inventory for the full breakdown.');
  if (options?.dryRunActive) return hint1;
  const hint2 = colorize.dim('Ready to reclaim tokens? Start here: ccaudit --dry-run');
  return `${hint1}\n${hint2}`;
}

/**
 * Format a last-used date as "Nd ago" or "never".
 */
export function formatLastUsed(lastUsed: Date | null): string {
  if (lastUsed === null) return 'never';
  const now = Date.now();
  const diffMs = now - lastUsed.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

/**
 * Format a token count for the summary row: ~Xk tokens/session.
 */
function formatTokenShort(tokens: number): string {
  if (tokens >= 10000) {
    return `~${Math.round(tokens / 1000)}k tokens/session`;
  }
  if (tokens >= 1000) {
    return `~${(tokens / 1000).toFixed(1)}k tokens/session`;
  }
  return `~${tokens} tokens/session`;
}

/**
 * Render the global baseline section as a 2-column Unicode-bordered table.
 * Full-width title row at top, then key-value data rows below.
 *
 * Column layout (3 border chars + 14 + valueW = tw):
 *   col0 (Key)   : 14 chars  (fixed)
 *   col1 (Value) : Math.max(10, tw - 17)  — flexible
 *
 * Formula: 3 borders + 14 = 17 fixed → valueW = tw - 17.
 */
export function renderGlobalBaseline(global: ProjectGhostSummary): string {
  const tw = getTerminalWidth();
  const valueW = Math.max(10, tw - 17);
  const colWidths = [14, valueW] as const;
  const innerWidth = tw - 2;

  const titleText = colorize.bold('\u{1F310} Global Baseline (loads every session):');
  const titleVisible = stripAnsi(titleText);
  const titleContent = titleVisible.length > tw - 4 ? truncateAnsi(titleText, tw - 4) : titleText;
  const titleRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(titleContent).length));

  const clampRow = (row: string): string => {
    if (row.length <= tw) return row;
    return row.slice(0, tw - 1) + row[row.length - 1]!;
  };

  const rows: Array<[string, string]> = [
    ['Ghosts', String(global.ghostCount)],
    ['Session Cost', formatTokensShortPlain(global.totalTokens)],
  ];

  const lines: string[] = [];

  // Top border (full-width, no column dividers in title span)
  lines.push('┌' + '─'.repeat(innerWidth) + '┐');
  // Title row
  lines.push('│ ' + titleContent + titleRightPad + ' │');
  // Transition row: introduces column dividers (┬)
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┬', '┤')));

  // Data rows (no between-row dividers — dense key-value layout)
  for (const [key, value] of rows) {
    const keyLines = wrapCell(key, 14);
    const valLines = wrapCell(value, valueW);
    const rowHeight = Math.max(keyLines.length, valLines.length, 1);
    for (let r = 0; r < rowHeight; r++) {
      const c0 = keyLines[r] ?? ' '.repeat(14);
      const c1 = valLines[r] ?? ' '.repeat(valueW);
      lines.push(clampRow('│' + c0 + '│' + c1 + '│'));
    }
  }

  // Bottom border
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  return lines.join('\n');
}

/**
 * Render a ranked projects table showing ghost overhead by project.
 * Top-N projects follow, sorted by token cost. Each row shows the combined
 * cost (global baseline + project-specific overhead).
 *
 * Format:
 *   🏗️  Per-Project Overhead (added on top of global):   ← bold title ABOVE the box
 *   ┌──────────────────────────────────────┬────────┬──────────────┐
 *   │ Scope                               │ Ghosts │ Session Cost │
 *   ├──────────────────────────────────────┼────────┼──────────────┤
 *   │ (global)                            │     55 │  ~48k tokens │
 *   └──────────────────────────────────────┴────────┴──────────────┘
 *   ... and N more projects               ← overflow BELOW the box
 *
 * Column layout: 4 borders + 8 (Ghosts) + 14 (Session Cost) = 26 fixed
 *   col0 (Scope)        : Math.max(20, tw - 26)  — flexible
 *   col1 (Ghosts)       : 8  chars
 *   col2 (Session Cost) : 14 chars
 */
export function renderProjectsTable(
  global: ProjectGhostSummary,
  projects: ProjectGhostSummary[],
  topN: number = 5,
): string {
  const tw = getTerminalWidth();
  const scopeW = Math.max(20, tw - 26);
  const colWidths = [scopeW, 8, 14] as const;

  const clampRow = (row: string): string => {
    if (tw < 26) return row.slice(0, tw);
    if (row.length <= tw) return row;
    return row.slice(0, tw - 1) + row[row.length - 1]!;
  };

  const lines: string[] = [];

  // Bold title ABOVE the box (not inside it — preserves existing bold styling)
  lines.push(colorize.bold('\u{1F3D7}\uFE0F  Per-Project Overhead (added on top of global):'));

  // Top border
  lines.push(clampRow(buildDividerRow([...colWidths], '┌', '┬', '┐')));

  // Column header row
  const hScope = wrapCell('Scope', scopeW)[0]!;
  const hGhosts = ' Ghosts '; // 8 chars: 1 + 6 + 1
  const hCost = ' Session Cost '; // 14 chars: 1 + 12 + 1
  lines.push(clampRow('│' + hScope + '│' + hGhosts + '│' + hCost + '│'));

  // Divider between header and data rows
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

  // Global row first, then top-N project rows
  const shown = projects.slice(0, topN);
  const allRows = [
    {
      ...global,
      // global row: display global totals as-is (no additions)
    },
    ...shown.map((proj) => ({
      ...proj,
      totalTokens: global.totalTokens + proj.totalTokens,
      ghostCount: global.ghostCount + proj.ghostCount,
    })),
  ];

  for (const row of allRows) {
    const scopeLines = wrapCell(row.displayPath, scopeW);
    const ghostsStr = String(row.ghostCount).padStart(6);
    const costStr = formatTokensShortPlain(row.totalTokens).padStart(12);
    const c1 = ' ' + ghostsStr + ' '; // 8 chars
    const c2 = ' ' + costStr + ' '; // 14 chars
    const rowHeight = scopeLines.length;
    for (let r = 0; r < rowHeight; r++) {
      const c0 = scopeLines[r] ?? ' '.repeat(scopeW);
      const ghostCell = r === 0 ? c1 : ' '.repeat(8);
      const costCell = r === 0 ? c2 : ' '.repeat(14);
      lines.push(clampRow('│' + c0 + '│' + ghostCell + '│' + costCell + '│'));
    }
  }

  // Bottom border
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  // Overflow line BELOW the box
  const remaining = projects.length - shown.length;
  if (remaining > 0) {
    lines.push(`... and ${remaining} more project${remaining === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}

/**
 * Render full per-project ghost item lists for verbose mode.
 * Global section first, then projects sorted by total token cost.
 * Each section is its own Unicode-bordered 3-column box.
 *
 * Format per section:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ 📁 (global)  (~45k tokens, 38 ghosts)                   │
 *   ├──────────────────────────────────┬──────────────┬──────────┤
 *   │ Name                             │ ~Tokens      │ Last Used│
 *   ├──────────────────────────────────┼──────────────┼──────────┤
 *   │ nexus-strategy [global]          │  ~14k tokens │    never │
 *   │ ... 52 more                      │              │          │  ← overflow full-width row
 *   └──────────────────────────────────┴──────────────┴──────────┘
 *
 * Column layout: 4 borders + 14 (~Tokens) + 10 (Last Used) = 28 fixed
 *   col0 (Name)      : Math.max(20, tw - 28)  — flexible
 *   col1 (~Tokens)   : 14 chars
 *   col2 (Last Used) : 10 chars
 */
export function renderProjectsVerbose(
  global: ProjectGhostSummary,
  projects: ProjectGhostSummary[],
  maxItemsPerProject: number = 10,
): string {
  // Build cross-scope name set (names in BOTH global AND any project)
  const globalNames = new Set(global.items.map((i) => i.item.name));
  const projectNames = new Set(projects.flatMap((p) => p.items.map((i) => i.item.name)));
  const crossScopeNames = new Set([...globalNames].filter((n) => projectNames.has(n)));

  const tw = getTerminalWidth();
  const nameW = Math.max(20, tw - 28);
  const colWidths = [nameW, 14, 10] as const;
  const innerWidth = tw - 2;

  const clampRow = (row: string): string => {
    if (tw < 28) return row.slice(0, tw);
    if (row.length <= tw) return row;
    return row.slice(0, tw - 1) + row[row.length - 1]!;
  };

  const sections: string[] = [];
  const allSections = [global, ...projects];

  for (const summary of allSections) {
    const isGlobal = summary.projectPath === null;
    const tokenStr = formatTokensShortPlain(summary.totalTokens);
    const titleText = `\u{1F4C1} ${summary.displayPath}  (~${tokenStr.replace('~', '')}, ${summary.ghostCount} ghost${summary.ghostCount === 1 ? '' : 's'})`;
    const titleVisible = stripAnsi(titleText);
    const titleContent = titleVisible.length > tw - 4 ? truncateAnsi(titleText, tw - 4) : titleText;
    const titleRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(titleContent).length));

    const sectionLines: string[] = [];

    // Top border (full-width, no column dividers in title span)
    sectionLines.push('┌' + '─'.repeat(innerWidth) + '┐');
    // Title row (spans full width)
    sectionLines.push('│ ' + titleContent + titleRightPad + ' │');
    // Transition row: introduces column dividers (┬)
    sectionLines.push(clampRow(buildDividerRow([...colWidths], '├', '┬', '┤')));

    // Column header row
    const hName = wrapCell('Name', nameW)[0]!;
    const hTokens = wrapCell('~Tokens', 14)[0]!;
    const hLastUsed = wrapCell('Last Used', 10)[0]!;
    sectionLines.push(clampRow('│' + hName + '│' + hTokens + '│' + hLastUsed + '│'));

    // Divider between column headers and data rows
    sectionLines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

    // Data rows
    const shown = summary.items.slice(0, maxItemsPerProject);
    for (const item of shown) {
      let label = item.item.name;
      if (crossScopeNames.has(label)) {
        label = isGlobal ? `${label} [global]` : `${label} [project]`;
      }
      // T43: indent import-chain rows by 2×importDepth spaces in the Name column.
      const nameIndent = ' '.repeat(2 * (item.item.importDepth ?? 0));
      label = nameIndent + label;
      const tokenDisplay = formatTokenEstimate(item.tokenEstimate);
      const lastUsed = formatLastUsed(item.lastUsed);

      const nameLines = wrapCell(label, nameW);
      // ~Tokens: right-align within 12 content chars (1 pad each side = 14 total)
      const tokenStr2 = tokenDisplay.padStart(12);
      const c1 = ' ' + tokenStr2 + ' '; // 14 chars
      // Last Used: right-align within 8 content chars (1 pad each side = 10 total)
      const lastUsedStr = lastUsed.padStart(8);
      const c2 = ' ' + lastUsedStr + ' '; // 10 chars

      const rowHeight = nameLines.length;
      for (let r = 0; r < rowHeight; r++) {
        const c0 = nameLines[r] ?? ' '.repeat(nameW);
        const tokenCell = r === 0 ? c1 : ' '.repeat(14);
        const lastUsedCell = r === 0 ? c2 : ' '.repeat(10);
        sectionLines.push(clampRow('│' + c0 + '│' + tokenCell + '│' + lastUsedCell + '│'));
      }
    }

    // Overflow row: full-width single-cell row (no column dividers) just above bottom border
    const overflow = summary.items.length - shown.length;
    if (overflow > 0) {
      const overflowText = `... ${overflow} more`;
      const overflowRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - overflowText.length));
      sectionLines.push('│ ' + overflowText + overflowRightPad + ' │');
    }

    // Bottom border
    sectionLines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

    sections.push(sectionLines.join('\n'));
  }

  return sections.join('\n\n');
}

/** Format token count as ~Xk or ~X without confidence suffix. */
export function formatTokensShortPlain(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}

/**
 * Render a 50-char ASCII/Unicode progress bar for context window usage.
 * Color: red >50%, yellow 25-50%, green <25%.
 * Respects NO_COLOR via colorize internally.
 */
export function renderProgressBar(pct: number, barWidth: number = 50): string {
  const clampedWidth = Math.max(10, Math.min(50, barWidth));
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * clampedWidth);
  const empty = clampedWidth - filled;

  const fillChar = '\u2588'; // █
  const emptyChar = '\u2591'; // ░

  const fillStr = fillChar.repeat(filled);
  const emptyStr = emptyChar.repeat(empty);

  let coloredFill: string;
  if (pct > 50) coloredFill = colorize.red(fillStr);
  else if (pct >= 25) coloredFill = colorize.yellow(fillStr);
  else coloredFill = colorize.green(fillStr);

  const coloredEmpty = colorize.dim(emptyStr);
  const pctLabel = colorize.bold(`${pct.toFixed(1)}%`);

  return `[${coloredFill}${coloredEmpty}] ${pctLabel}`;
}

/**
 * Wrap a pre-assembled content string in a Unicode box.
 * Used by the ghost command to render the header block.
 */
export function renderBoxed(content: string, maxWidth?: number): string {
  return wrapInBox(content, 1, maxWidth);
}

// ---------------------------------------------------------------------------
// Private helpers for responsive columnar rendering
// (wordWrap and wrapCell are imported from ../utils/table-utils.ts)
// ---------------------------------------------------------------------------

/**
 * Compute the four column widths for the responsive ghost table.
 * Fixed widths: col1=14, col2=14, col3=13. col4 absorbs the remaining space.
 * Total invariant: 1 + col1 + 1 + col2 + 1 + col3 + 1 + col4 + 1 = termWidth
 * (5 border chars + sum of colWidths = termWidth), so col4 = termWidth - 46.
 * Minimum col4=10; minimum effective termWidth=56.
 */
function computeColWidths(termWidth: number): [number, number, number, number] {
  const col1 = 14;
  const col2 = 14;
  const col3 = 13;
  const col4 = Math.max(10, termWidth - 46);
  return [col1, col2, col3, col4];
}

/**
 * Build the divider row used immediately after the header row.
 * Uses ┬ as inner column separators.
 * Total char count = 5 border chars + sum(colWidths) = termWidth.
 */
function buildAfterHeaderDivider(colWidths: [number, number, number, number]): string {
  return buildDividerRow([...colWidths], '├', '┬', '┤');
}

/**
 * Build the divider row drawn between data rows.
 * Uses ┼ as inner column separators.
 */
function buildBetweenRowDivider(colWidths: [number, number, number, number]): string {
  return buildDividerRow([...colWidths], '├', '┼', '┤');
}

/**
 * Build the divider row that closes the column separators (bottom of table body,
 * before any footer rows). Uses ┴ as inner column separators.
 */
function buildCloseColumnsDivider(colWidths: [number, number, number, number]): string {
  return buildDividerRow([...colWidths], '├', '┴', '┤');
}

/**
 * Render the category data rows for the responsive columnar ghost table.
 * Returns an array of full box-width strings (each line is a row like │...│).
 * Between-row dividers (┼) are inserted between categories but NOT after the last.
 */
function renderCategoryRows(
  summaries: CategorySummary[],
  colWidths: [number, number, number, number],
  frameworkGhostsByCategory?: Partial<Record<ItemCategory, number>>,
): string[] {
  const output: string[] = [];

  for (let idx = 0; idx < summaries.length; idx++) {
    const s = summaries[idx]!;
    const isMemory = s.category === 'memory';

    const col0Text = CATEGORY_DISPLAY[s.category] ?? s.category;
    const col1Text = isMemory
      ? 'Loaded: ' + String(s.defined).padStart(3)
      : 'Defined: ' + String(s.defined).padStart(3);
    const col2Text = isMemory
      ? 'Active: ' + String(s.used).padStart(3)
      : 'Used:   ' + String(s.used).padStart(3);
    const col3Text = isMemory
      ? 'Stale:  ' + String(s.ghost).padStart(3) + ' ' + formatTokenShort(s.tokenCost)
      : 'Ghost:  ' + String(s.ghost).padStart(3) + ' ' + formatTokenShort(s.tokenCost);

    const fwInCat = frameworkGhostsByCategory?.[s.category as ItemCategory] ?? 0;
    const col3TextWithFw = fwInCat > 0 ? `${col3Text} (${fwInCat} in frameworks above)` : col3Text;

    const cell0 = wrapCell(col0Text, colWidths[0]);
    const cell1 = wrapCell(col1Text, colWidths[1]);
    const cell2 = wrapCell(col2Text, colWidths[2]);
    const cell3 = wrapCell(col3TextWithFw, colWidths[3]);

    const rowHeight = Math.max(cell0.length, cell1.length, cell2.length, cell3.length);

    for (let r = 0; r < rowHeight; r++) {
      const c0 = cell0[r] ?? ' '.repeat(colWidths[0]);
      const c1 = cell1[r] ?? ' '.repeat(colWidths[1]);
      const c2 = cell2[r] ?? ' '.repeat(colWidths[2]);
      const c3 = cell3[r] ?? ' '.repeat(colWidths[3]);
      output.push('│' + c0 + '│' + c1 + '│' + c2 + '│' + c3 + '│');
    }

    // Insert between-row divider after every category except the last
    if (idx < summaries.length - 1) {
      output.push(buildBetweenRowDivider(colWidths));
    }
  }

  return output;
}

/**
 * Compute the minimum box width needed to display all content without wrapping.
 */
function computeNaturalWidth(
  header: string,
  summaries: CategorySummary[],
  bottomLines: string[],
  frameworkGhostsByCategory?: Partial<Record<ItemCategory, number>>,
): number {
  // Header row: "│ " + title + trailing_pad + " │" → 4 + visLen(title)
  let maxW = 4 + stripAnsi(header.split('\n')[0]!).length;

  // Data rows: 5 borders + col1(14) + col2(14) + col3(13) = 46 fixed chars
  // col4 content needs padding of 2 (1 space each side)
  for (const s of summaries) {
    const isMemory = s.category === 'memory';
    const baseCol4Text = isMemory
      ? 'Stale:  ' + String(s.ghost).padStart(3) + ' ' + formatTokenShort(s.tokenCost)
      : 'Ghost:  ' + String(s.ghost).padStart(3) + ' ' + formatTokenShort(s.tokenCost);
    const fwInCat = frameworkGhostsByCategory?.[s.category as ItemCategory] ?? 0;
    const col4Text =
      fwInCat > 0 ? `${baseCol4Text} (${fwInCat} in frameworks above)` : baseCol4Text;
    maxW = Math.max(maxW, 46 + stripAnsi(col4Text).length + 2);
  }

  // Bottom prose lines: "│ " + content + " │" = 4 + visLen(content)
  for (const line of bottomLines) {
    for (const sub of line.split('\n')) {
      maxW = Math.max(maxW, 4 + stripAnsi(sub).length);
    }
  }

  return Math.max(maxW, 60); // floor for pathological edge cases
}

export function renderGhostOutputBox(
  header: string,
  summaries: CategorySummary[],
  bottomLines: string[],
  progressPct: number | null,
  termWidth?: number,
  frameworkGhostsByCategory?: Partial<Record<ItemCategory, number>>,
): string {
  const tw = Math.min(
    termWidth ?? getTerminalWidth(),
    computeNaturalWidth(header, summaries, bottomLines, frameworkGhostsByCategory),
  );
  const innerWidth = tw - 2; // chars between outer │ and │
  const contentWidth = innerWidth - 2; // prose line content (1 pad each side)
  const colWidths = computeColWidths(tw);

  const lines: string[] = [];

  // Top border
  lines.push('┌' + '─'.repeat(innerWidth) + '┐');

  // Header: render all header lines (supports multi-line headers with tool name row)
  // When wastedTokens is provided, renderHeader() returns 4 lines:
  //   Line 0: CCAUDIT - ~7.0k tokens/session wasted
  //   Line 1: ━━━ divider (skip - we use box dividers instead)
  //   Line 2: 👻 Ghost Inventory — Last 7 days
  //   Line 3: ━━━ divider (skip)
  const headerLines = header.split('\n').filter((line) => !line.match(/^[━\u2501]+$/));
  for (const titleLine of headerLines) {
    const titleVisLen = stripAnsi(titleLine).length;
    const titleRightPad = ' '.repeat(Math.max(0, contentWidth - titleVisLen));
    lines.push('│ ' + titleLine + titleRightPad + ' │');
  }

  // Column section — clamp each row to tw chars so narrow terminals stay within bounds
  const clampRow = (row: string): string => {
    if (row.length <= tw) return row;
    // Hard-truncate to tw chars, restoring closing border char
    return row.slice(0, tw - 1) + row[row.length - 1]!;
  };
  lines.push(clampRow(buildAfterHeaderDivider(colWidths)));
  for (const row of renderCategoryRows(summaries, colWidths, frameworkGhostsByCategory)) {
    lines.push(clampRow(row));
  }
  lines.push(clampRow(buildCloseColumnsDivider(colWidths)));

  // Empty line before bottom prose
  lines.push('│' + ' '.repeat(innerWidth) + '│');

  // Bottom prose section
  for (const line of bottomLines) {
    const subLines = line.split('\n').flatMap((sub) => wordWrap(sub, contentWidth));
    for (const sub of subLines) {
      const visLen = stripAnsi(sub).length;
      const rightPad = ' '.repeat(Math.max(0, contentWidth - visLen));
      lines.push('│ ' + sub + rightPad + ' │');
    }
  }

  // Progress bar (adaptive width)
  if (progressPct !== null) {
    const barWidth = Math.max(10, Math.min(50, contentWidth - 8));
    const bar = renderProgressBar(progressPct, barWidth);
    const barVisLen = stripAnsi(bar).length;
    const barRightPad = ' '.repeat(Math.max(0, contentWidth - barVisLen));
    lines.push('│ ' + bar + barRightPad + ' │');
  }

  // Bottom border
  lines.push('└' + '─'.repeat(innerWidth) + '┘');

  return lines.join('\n');
}

/**
 * Render the hooks advisory section shown AFTER all other ghost output when
 * --include-hooks is NOT set (the default).
 *
 * Format (non-verbose):
 *   🪝 Hooks (advisory — not included in total)
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Hooks  │ Defined: N  │ Dormant: N  │ ~Xk tokens (upper-bound) │
 *   └─────────────────────────────────────────────┘
 *
 *   Hooks inject context only when they fire. ccaudit cannot observe
 *   firing events reliably, so dormant hooks are upper-bound estimates.
 *   Pass --include-hooks to include ~Xk in the total above.
 *
 * Returns empty string when hookCount is 0 (no hooks configured).
 * In verbose mode, also renders per-hook rows from the hookItems array.
 */
export function renderHooksAdvisory(
  hookCount: number,
  dormantCount: number,
  hookTokens: number,
  hookItems: TokenCostResult[],
  verbose: boolean,
): string {
  if (hookCount === 0) return '';

  const tokenLabel = formatTokenShort(hookTokens);
  const tw = getTerminalWidth();

  const lines: string[] = [];

  // Section heading (outside the box)
  lines.push(
    colorize.bold('\u{1FA9D} Hooks') + colorize.dim(' (advisory \u2014 not included in total)'),
  );
  lines.push('');

  // Summary box
  const summaryText = `Hooks  \u2502 Defined: ${hookCount}   \u2502 Dormant: ${dormantCount}  \u2502 ${tokenLabel} (upper-bound)`;
  const summaryVisLen = stripAnsi(summaryText).length;
  const boxInner = Math.max(summaryVisLen + 2, 40);
  const boxInnerClamped = Math.min(boxInner, tw - 2);
  const topBorder = '\u250C' + '\u2500'.repeat(boxInnerClamped) + '\u2510';
  const bottomBorder = '\u2514' + '\u2500'.repeat(boxInnerClamped) + '\u2518';
  const rightPad = ' '.repeat(Math.max(0, boxInnerClamped - summaryVisLen - 1));
  lines.push(topBorder);
  lines.push('\u2502 ' + summaryText + rightPad + '\u2502');
  lines.push(bottomBorder);

  // Per-hook rows in verbose mode
  if (verbose && hookItems.length > 0) {
    lines.push('');
    const nameW = Math.max(20, tw - 40);
    const colWidths = [nameW, 20, 14] as const;
    const innerWidth2 = tw - 2;
    const clampRow = (row: string): string => {
      if (row.length <= tw) return row;
      return row.slice(0, tw - 1) + row[row.length - 1]!;
    };
    lines.push(clampRow('\u250C' + '\u2500'.repeat(innerWidth2) + '\u2510'));
    lines.push(
      clampRow(
        '\u2502 ' +
          colorize.dim('Per-hook details') +
          ' '.repeat(Math.max(0, innerWidth2 - 2 - 'Per-hook details'.length)) +
          ' \u2502',
      ),
    );
    lines.push(clampRow(buildDividerRow([...colWidths], '\u251C', '\u252C', '\u2524')));
    const hName = wrapCell('Name', nameW)[0]!;
    const hEvent = wrapCell('Event / Tier', 20)[0]!;
    const hTokens2 = wrapCell('~Tokens', 14)[0]!;
    lines.push(clampRow('\u2502' + hName + '\u2502' + hEvent + '\u2502' + hTokens2 + '\u2502'));
    lines.push(clampRow(buildDividerRow([...colWidths], '\u251C', '\u253C', '\u2524')));
    for (const item of hookItems) {
      const nameLines = wrapCell(item.item.name, nameW);
      const eventStr = `${item.item.hookEvent ?? '?'} (${item.tier})`;
      const eventLines = wrapCell(eventStr, 20);
      const tokStr = formatTokensShortPlain(item.tokenEstimate?.tokens ?? 0).padStart(12);
      const c2 = ' ' + tokStr + ' ';
      const rowHeight = Math.max(nameLines.length, eventLines.length, 1);
      for (let r = 0; r < rowHeight; r++) {
        const c0 = nameLines[r] ?? ' '.repeat(nameW);
        const c1 = eventLines[r] ?? ' '.repeat(20);
        const c2r = r === 0 ? c2 : ' '.repeat(14);
        lines.push(clampRow('\u2502' + c0 + '\u2502' + c1 + '\u2502' + c2r + '\u2502'));
      }
    }
    lines.push(clampRow(buildDividerRow([...colWidths], '\u2514', '\u2534', '\u2518')));
  }

  lines.push('');

  // Explanatory prose
  const tokenLabelPlain = formatTokenShort(hookTokens);
  lines.push(colorize.dim('Hooks inject context only when they fire. ccaudit cannot observe'));
  lines.push(colorize.dim('firing events reliably, so dormant hooks are upper-bound estimates.'));
  lines.push(
    colorize.dim(`Pass --include-hooks to include ${tokenLabelPlain} in the total above.`),
  );

  return lines.join('\n');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderGhostSummary', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 140, used: 12, ghost: 128, tokenCost: 47000 },
      { category: 'skill', defined: 90, used: 8, ghost: 82, tokenCost: 18000 },
      { category: 'mcp-server', defined: 6, used: 2, ghost: 4, tokenCost: 32000 },
      { category: 'memory', defined: 9, used: 3, ghost: 6, tokenCost: 12000 },
    ];

    it('produces string with 4 lines for 4 categories', () => {
      const result = renderGhostSummary(summaries);
      const lines = result.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('contains "Defined:" for agents and "Loaded:" for memory', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Defined:');
      expect(result).toContain('Loaded:');
    });

    it('contains "Active:" for memory and "Used:" for agents', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Active:');
      expect(result).toContain('Used:');
    });

    it('contains "Stale:" for memory and "Ghost:" for agents', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Stale:');
      expect(result).toContain('Ghost:');
    });

    it('contains category display names', () => {
      const result = renderGhostSummary(summaries);
      expect(result).toContain('Agents');
      expect(result).toContain('Skills');
      expect(result).toContain('MCP Servers');
      expect(result).toContain('Memory Files');
    });
  });

  describe('renderGhostSummary — frameworkGhostsByCategory parenthetical', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 140, used: 12, ghost: 128, tokenCost: 47000 },
      { category: 'skill', defined: 90, used: 8, ghost: 82, tokenCost: 18000 },
    ];

    it('omits parenthetical when frameworkGhostsByCategory is undefined', () => {
      const out = renderGhostSummary(summaries);
      expect(out).not.toContain('in frameworks above');
    });

    it('omits parenthetical when value is zero', () => {
      const out = renderGhostSummary(summaries, { agent: 0 });
      expect(out).not.toContain('in frameworks above');
    });

    it('appends parenthetical to the agent row when count is non-zero', () => {
      const out = renderGhostSummary(summaries, { agent: 81 });
      expect(out).toContain('(81 in frameworks above)');
      // The parenthetical lives on the agent row, not the skill row
      const lines = out.split('\n');
      const agentLine = lines.find((l) => l.includes('Agents'));
      const skillLine = lines.find((l) => l.includes('Skills'));
      expect(agentLine).toContain('(81 in frameworks above)');
      expect(skillLine).not.toContain('in frameworks above');
    });

    it('appends parentheticals to multiple rows independently', () => {
      const out = renderGhostSummary(summaries, { agent: 81, skill: 12 });
      expect(out).toContain('(81 in frameworks above)');
      expect(out).toContain('(12 in frameworks above)');
    });
  });

  describe('renderTopGhosts', () => {
    /** Helper: build a minimal TokenCostResult for testing. */
    function makeGhost(name: string, tokens: number, category: string = 'agent'): TokenCostResult {
      return {
        item: {
          name,
          path: `/test/${name}`,
          scope: 'global',
          category: category as TokenCostResult['item']['category'],
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('returns only top 5 items when given 7', () => {
      const ghosts = Array.from({ length: 7 }, (_, i) => makeGhost(`ghost-${i}`, (i + 1) * 1000));
      const result = renderTopGhosts(ghosts);
      // Bordered table: top + title + ┬-divider + header + ┼-divider + 5 data rows + bottom = 10 lines
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(10);
    });

    it('returns empty string for empty array', () => {
      const result = renderTopGhosts([]);
      expect(result).toBe('');
    });

    it('items are sorted by token cost descending', () => {
      const ghosts = [makeGhost('low', 1000), makeGhost('high', 10000), makeGhost('mid', 5000)];
      const result = renderTopGhosts(ghosts);
      // With bordered table, use indexOf to verify order rather than line positions
      expect(result).toContain('high');
      expect(result).toContain('mid');
      expect(result).toContain('low');
      expect(result.indexOf('high')).toBeLessThan(result.indexOf('mid'));
      expect(result.indexOf('mid')).toBeLessThan(result.indexOf('low'));
    });

    it('contains the top global ghosts section header', () => {
      const ghosts = [makeGhost('test', 5000)];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('Top global ghosts by token cost:');
    });

    it('excludes project-scope items from top list', () => {
      const globalGhost = makeGhost('global-one', 100);
      const projectGhost: TokenCostResult = {
        item: {
          name: 'project-big',
          path: '/test/project-big',
          scope: 'project',
          category: 'agent',
          projectPath: '/repo/a',
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens: 99999, confidence: 'estimated', source: 'test' },
      };
      const result = renderTopGhosts([globalGhost, projectGhost]);
      expect(result).toContain('global-one');
      expect(result).not.toContain('project-big');
    });

    it('returns empty string when all ghosts are project-scope', () => {
      const projectGhost: TokenCostResult = {
        item: {
          name: 'proj-only',
          path: '/test/proj-only',
          scope: 'project',
          category: 'agent',
          projectPath: '/repo/a',
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens: 5000, confidence: 'estimated', source: 'test' },
      };
      const result = renderTopGhosts([projectGhost]);
      expect(result).toBe('');
    });

    it('contains category and last-used info', () => {
      const ghosts = [makeGhost('test', 5000, 'skill')];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('skill');
      expect(result).toContain('never');
    });

    it('output contains Unicode box-drawing top and bottom borders', () => {
      const ghosts = [makeGhost('border-test', 9000)];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('┌');
      expect(result).toContain('└');
      expect(result).toContain('│');
    });

    it('items are sorted and visible inside bordered table', () => {
      const ghosts = [makeGhost('zz-low', 1000), makeGhost('aa-high', 10000)];
      const result = renderTopGhosts(ghosts);
      // aa-high must appear before zz-low in the output
      expect(result.indexOf('aa-high')).toBeLessThan(result.indexOf('zz-low'));
    });
  });

  describe('renderTopGhosts scope labels (removed — top-5 is global-only now)', () => {
    function makeScopedGhost(
      name: string,
      tokens: number,
      scope: 'global' | 'project',
      projectPath: string | null = null,
    ): TokenCostResult {
      return {
        item: { name, path: `/test/${name}`, scope, category: 'agent', projectPath },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('never shows scope labels since only global items are included', () => {
      const ghosts = [
        makeScopedGhost('shared', 5000, 'global'),
        makeScopedGhost('shared', 4000, 'project', '/repos/a'),
      ];
      const result = renderTopGhosts(ghosts);
      // Only global item appears, no disambiguation needed
      expect(result).toContain('shared');
      expect(result).not.toContain('[global]');
      expect(result).not.toContain('[/repos/a]');
    });
  });

  describe('renderProjectsTable', () => {
    function makeSummary(
      displayPath: string,
      ghostCount: number,
      totalTokens: number,
    ): ProjectGhostSummary {
      return {
        projectPath: displayPath === '(global)' ? null : `/home/user/${displayPath}`,
        displayPath,
        totalTokens,
        ghostCount,
        items: [],
      };
    }

    it('contains the header', () => {
      const global = makeSummary('(global)', 10, 5000);
      const result = renderProjectsTable(global, []);
      expect(result).toContain('Per-Project Overhead');
    });

    it('project rows show combined session cost (global + project)', () => {
      const global = makeSummary('(global)', 10, 5000);
      const projects = [makeSummary('~/repo-a', 3, 2000)];
      const result = renderProjectsTable(global, projects);
      // Project row shows combined: 5000 + 2000 = 7000 tokens
      expect(result).toContain('~7.0k tokens');
      // Project row shows combined ghost count: 10 + 3 = 13
      const projLine = result.split('\n').find((l: string) => l.includes('~/repo-a'));
      expect(projLine).toContain('13');
    });

    it('uses Session Cost header', () => {
      const global = makeSummary('(global)', 10, 5000);
      const result = renderProjectsTable(global, []);
      expect(result).toContain('Session Cost');
    });

    it('shows only topN projects', () => {
      const global = makeSummary('(global)', 0, 0);
      const projects = Array.from({ length: 8 }, (_, i) => makeSummary(`~/repo-${i}`, 1, 1000));
      const result = renderProjectsTable(global, projects, 3);
      expect(result).toContain('~/repo-0');
      expect(result).toContain('~/repo-2');
      expect(result).not.toContain('~/repo-3');
      expect(result).toContain('and 5 more projects');
    });

    it('shows singular "project" when 1 remaining', () => {
      const global = makeSummary('(global)', 0, 0);
      const projects = Array.from({ length: 6 }, (_, i) => makeSummary(`~/repo-${i}`, 1, 1000));
      const result = renderProjectsTable(global, projects, 5);
      expect(result).toContain('and 1 more project');
      expect(result).not.toContain('and 1 more projects');
    });

    it('shows no overflow line when all projects fit', () => {
      const global = makeSummary('(global)', 0, 0);
      const projects = [makeSummary('~/repo', 5, 2000)];
      const result = renderProjectsTable(global, projects, 5);
      expect(result).not.toContain('more project');
    });

    it('output contains Unicode box-drawing top and bottom borders', () => {
      const global = makeSummary('(global)', 10, 5000);
      const projects = [makeSummary('~/repo-a', 3, 2000)];
      const result = renderProjectsTable(global, projects);
      expect(result).toContain('┌');
      expect(result).toContain('└');
      expect(result).toContain('│');
    });

    it('bold title appears above the box (before first border char)', () => {
      const global = makeSummary('(global)', 10, 5000);
      const result = renderProjectsTable(global, []);
      const titleIdx = result.indexOf('Per-Project Overhead');
      const borderIdx = result.indexOf('┌');
      expect(titleIdx).toBeLessThan(borderIdx);
    });
  });

  describe('renderGlobalBaseline', () => {
    function makeGlobal(ghostCount: number, totalTokens: number): ProjectGhostSummary {
      return { projectPath: null, displayPath: '(global)', totalTokens, ghostCount, items: [] };
    }

    it('renders the Global Baseline header', () => {
      const result = renderGlobalBaseline(makeGlobal(38, 45000));
      expect(result).toContain('Global Baseline');
    });

    it('contains ghost count and token cost', () => {
      const result = renderGlobalBaseline(makeGlobal(38, 45000));
      expect(result).toContain('38');
      expect(result).toContain('~45k tokens');
    });

    it('works gracefully with zero ghosts and zero tokens', () => {
      const result = renderGlobalBaseline(makeGlobal(0, 0));
      expect(result).toContain('Global Baseline');
      expect(result).toContain('~0 tokens');
    });

    it('output contains Unicode box-drawing top and bottom borders', () => {
      const result = renderGlobalBaseline(makeGlobal(38, 45000));
      expect(result).toContain('┌');
      expect(result).toContain('└');
      expect(result).toContain('│');
    });

    it('key-value rows are inside bordered table', () => {
      const result = renderGlobalBaseline(makeGlobal(7, 12000));
      expect(result).toContain('Ghosts');
      expect(result).toContain('Session Cost');
      expect(result).toContain('7');
      expect(result).toContain('~12k tokens');
    });
  });

  describe('renderProjectsVerbose', () => {
    function makeItem(name: string, tokens: number, scope: 'global' | 'project'): TokenCostResult {
      return {
        item: {
          name,
          path: `/test/${name}`,
          scope,
          category: 'agent',
          projectPath: scope === 'project' ? '/repo/a' : null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('renders global section first', () => {
      const global: ProjectGhostSummary = {
        projectPath: null,
        displayPath: '(global)',
        totalTokens: 5000,
        ghostCount: 1,
        items: [makeItem('g-agent', 5000, 'global')],
      };
      const projects: ProjectGhostSummary[] = [
        {
          projectPath: '/repo/a',
          displayPath: '~/repo/a',
          totalTokens: 3000,
          ghostCount: 1,
          items: [makeItem('p-agent', 3000, 'project')],
        },
      ];
      const result = renderProjectsVerbose(global, projects);
      const globalIdx = result.indexOf('(global)');
      const projIdx = result.indexOf('~/repo/a');
      expect(globalIdx).toBeLessThan(projIdx);
    });

    it('adds [global] and [project] labels for cross-scope names', () => {
      const sharedName = 'shared-agent';
      const global: ProjectGhostSummary = {
        projectPath: null,
        displayPath: '(global)',
        totalTokens: 5000,
        ghostCount: 1,
        items: [makeItem(sharedName, 5000, 'global')],
      };
      const projects: ProjectGhostSummary[] = [
        {
          projectPath: '/repo/a',
          displayPath: '~/repo/a',
          totalTokens: 3000,
          ghostCount: 1,
          items: [makeItem(sharedName, 3000, 'project')],
        },
      ];
      const result = renderProjectsVerbose(global, projects);
      expect(result).toContain(`${sharedName} [global]`);
      expect(result).toContain(`${sharedName} [project]`);
    });

    it('truncates long item lists with overflow message', () => {
      const items = Array.from({ length: 15 }, (_, i) => makeItem(`agent-${i}`, 100, 'global'));
      const global: ProjectGhostSummary = {
        projectPath: null,
        displayPath: '(global)',
        totalTokens: 1500,
        ghostCount: 15,
        items,
      };
      const result = renderProjectsVerbose(global, [], 5);
      expect(result).toContain('... 10 more');
    });

    it('output contains Unicode box-drawing top and bottom borders', () => {
      const global: ProjectGhostSummary = {
        projectPath: null,
        displayPath: '(global)',
        totalTokens: 5000,
        ghostCount: 1,
        items: [makeItem('g-agent', 5000, 'global')],
      };
      const result = renderProjectsVerbose(global, []);
      expect(result).toContain('┌');
      expect(result).toContain('└');
      expect(result).toContain('│');
    });

    it('each project section has its own bordered box', () => {
      const global: ProjectGhostSummary = {
        projectPath: null,
        displayPath: '(global)',
        totalTokens: 5000,
        ghostCount: 1,
        items: [makeItem('g-agent', 5000, 'global')],
      };
      const projects: ProjectGhostSummary[] = [
        {
          projectPath: '/repo/a',
          displayPath: '~/repo/a',
          totalTokens: 3000,
          ghostCount: 1,
          items: [makeItem('p-agent', 3000, 'project')],
        },
      ];
      const result = renderProjectsVerbose(global, projects);
      // Two sections → at least two top-border chars and two bottom-border chars
      const topBorders = result.split('┌').length - 1;
      const bottomBorders = result.split('└').length - 1;
      expect(topBorders).toBeGreaterThanOrEqual(2);
      expect(bottomBorders).toBeGreaterThanOrEqual(2);
    });
  });

  describe('renderGhostFooter', () => {
    it('contains inventory hint', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('Run ccaudit inventory for the full breakdown.');
    });

    it('contains dry-run hint when dryRunActive is false', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('Ready to reclaim tokens? Start here: ccaudit --dry-run');
    });

    it('omits dry-run hint when dryRunActive is true', () => {
      const result = renderGhostFooter('7 days', { dryRunActive: true });
      expect(result).not.toContain('ccaudit --dry-run');
      expect(result).toContain('Run ccaudit inventory for the full breakdown.');
    });
  });

  describe('formatLastUsed branches (via renderTopGhosts)', () => {
    /**
     * These tests exercise the private formatLastUsed helper through the
     * public renderTopGhosts renderer, covering the today / 1d ago / Nd ago
     * branches that null-only fixtures cannot reach.
     */
    function makeDatedGhost(name: string, tokens: number, lastUsed: Date | null): TokenCostResult {
      return {
        item: {
          name,
          path: `/test/${name}`,
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('renders "today" when lastUsed is now', () => {
      const ghosts = [makeDatedGhost('fresh', 500, new Date())];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('today');
    });

    it('renders "1d ago" when lastUsed is exactly 1 day old', () => {
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 - 60000);
      const ghosts = [makeDatedGhost('yesterday', 500, oneDayAgo)];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('1d ago');
    });

    it('renders "Nd ago" for multi-day-old lastUsed', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const ghosts = [makeDatedGhost('stale', 500, fiveDaysAgo)];
      const output = renderTopGhosts(ghosts);
      expect(output).toContain('5d ago');
    });
  });

  describe('formatTokenShort branches (via renderGhostSummary)', () => {
    /**
     * Exercise the private formatTokenShort helper through renderGhostSummary,
     * covering the mid-range (1000 <= tokens < 10000) and small (< 1000)
     * branches that the fixture summaries (all >= 10000) do not reach.
     */
    it('renders mid-range tokens as ~X.Yk tokens/session', () => {
      const summaries: CategorySummary[] = [
        { category: 'agent', defined: 5, used: 2, ghost: 3, tokenCost: 3500 },
      ];
      const output = renderGhostSummary(summaries);
      expect(output).toContain('~3.5k tokens/session');
    });

    it('renders small tokens as ~N tokens/session (no k suffix)', () => {
      const summaries: CategorySummary[] = [
        { category: 'skill', defined: 5, used: 3, ghost: 2, tokenCost: 250 },
      ];
      const output = renderGhostSummary(summaries);
      expect(output).toContain('~250 tokens/session');
    });
  });

  describe('renderBoxed', () => {
    it('wraps content with box-drawing borders', () => {
      const result = renderBoxed('hello', 80);
      expect(result).toContain('┌');
      expect(result).toContain('┐');
      expect(result).toContain('└');
      expect(result).toContain('┘');
      expect(result).toContain('│');
      expect(result).toContain('hello');
    });

    it('handles ANSI codes without breaking width', () => {
      const colored = '\x1b[32mhello\x1b[0m'; // green "hello"
      const plain = 'hello';
      const r1 = renderBoxed(colored, 80);
      const r2 = renderBoxed(plain, 80);
      // Both should produce same box width (5 visible chars)
      const width1 = r1.split('\n')[0]!.length;
      const width2 = r2.split('\n')[0]!.length;
      expect(width1).toBe(width2);
    });

    it('handles empty string', () => {
      const result = renderBoxed('', 80);
      expect(result).toContain('┌');
      expect(result).toContain('└');
    });

    it('handles multi-line content', () => {
      const result = renderBoxed('line one\nline two', 80);
      const lines = result.split('\n');
      // top + line1 + line2 + bottom = 4 lines
      expect(lines.length).toBe(4);
    });

    it('caps box width at provided maxWidth', () => {
      const content = 'short';
      const result = renderBoxed(content, 40);
      const topLine = result.split('\n')[0];
      expect(topLine.length).toBeLessThanOrEqual(40);
    });

    it('truncates long lines with ellipsis', () => {
      const longContent = 'a'.repeat(60);
      const result = renderBoxed(longContent, 30);
      expect(result).toContain('…');
    });

    it('defaults to 80 when stdout.columns unavailable', () => {
      const saved = process.stdout.columns;
      // @ts-expect-error — force undefined for test
      process.stdout.columns = undefined;
      const content = 'hello';
      const result = renderBoxed(content);
      const topLine = result.split('\n')[0];
      expect(topLine.length).toBeLessThanOrEqual(80);
      process.stdout.columns = saved;
    });
  });

  describe('private helpers', () => {
    describe('wordWrap', () => {
      it('returns single line when text fits', () => {
        const result = wordWrap('hello world', 20);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('hello world');
      });
      it('wraps at word boundary', () => {
        const result = wordWrap('hello world foo', 8);
        // 'hello' fits in 8, ' world' would exceed, so split
        expect(result.length).toBeGreaterThan(1);
        expect(result[0]).toBe('hello');
      });
      it('force-breaks single long word', () => {
        const result = wordWrap('abcdefghij', 5);
        expect(result[0]).toBe('abcde');
        expect(result[1]).toBe('fghij');
      });
      it('returns [""] for empty string', () => {
        expect(wordWrap('', 10)).toEqual(['']);
      });
    });

    describe('wrapCell', () => {
      it('returns lines of exactly cellWidth chars', () => {
        const lines = wrapCell('hello', 10);
        for (const line of lines) {
          expect(line.length).toBe(10);
        }
      });
      it('pads short content to cellWidth', () => {
        const lines = wrapCell('hi', 8);
        expect(lines[0]).toBe(' hi     '); // 1 + 2 + 5 spaces = 8
      });
    });

    describe('computeColWidths', () => {
      it('returns [14, 14, 13, 10] at termWidth=56', () => {
        expect(computeColWidths(56)).toEqual([14, 14, 13, 10]);
      });
      it('returns [14, 14, 13, 34] at termWidth=80', () => {
        expect(computeColWidths(80)).toEqual([14, 14, 13, 34]);
      });
      it('col4 is minimum 10 even at very narrow widths', () => {
        const [, , , col4] = computeColWidths(40);
        expect(col4).toBeGreaterThanOrEqual(10);
      });
      it('column widths sum to termWidth - 5', () => {
        const widths = computeColWidths(80);
        expect(widths.reduce((a, b) => a + b, 0)).toBe(80 - 5);
      });
    });

    describe('divider builders', () => {
      it('afterHeaderDivider has correct length', () => {
        const d = buildAfterHeaderDivider([14, 14, 13, 10]);
        expect(d.length).toBe(56); // 5 + 14 + 14 + 13 + 10
      });
      it('afterHeaderDivider uses ┬ separators', () => {
        const d = buildAfterHeaderDivider([14, 14, 13, 10]);
        expect(d).toContain('┬');
      });
      it('betweenRowDivider uses ┼ separators', () => {
        const d = buildBetweenRowDivider([14, 14, 13, 10]);
        expect(d).toContain('┼');
      });
      it('closeColumnsDivider uses ┴ separators', () => {
        const d = buildCloseColumnsDivider([14, 14, 13, 10]);
        expect(d).toContain('┴');
      });
    });
  });

  describe('renderCategoryRows', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 176, used: 13, ghost: 163, tokenCost: 47000 },
      { category: 'skill', defined: 81, used: 7, ghost: 74, tokenCost: 12000 },
      { category: 'mcp-server', defined: 4, used: 0, ghost: 4, tokenCost: 0 },
      { category: 'memory', defined: 9, used: 9, ghost: 0, tokenCost: 0 },
    ];

    it('returns string array with box pipe characters', () => {
      const colWidths: [number, number, number, number] = [14, 14, 13, 10];
      const lines = renderCategoryRows(summaries, colWidths);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^│.*│$/);
    });

    it('contains category names', () => {
      const colWidths: [number, number, number, number] = [14, 14, 13, 10];
      const lines = renderCategoryRows(summaries, colWidths);
      const combined = lines.join('\n');
      expect(combined).toContain('Agents');
      expect(combined).toContain('Skills');
      expect(combined).toContain('MCP Servers');
      expect(combined).toContain('Memory Files');
    });

    it('contains defined/used/ghost values', () => {
      const colWidths: [number, number, number, number] = [14, 14, 13, 10];
      const lines = renderCategoryRows(summaries, colWidths);
      const combined = lines.join('\n');
      expect(combined).toContain('176');
      expect(combined).toContain('163');
      expect(combined).toContain('Loaded:'); // memory
      expect(combined).toContain('Stale:'); // memory
      expect(combined).toContain('~47k'); // token cost for agent row
    });

    it('contains between-row dividers (┼) but not after last row', () => {
      const colWidths: [number, number, number, number] = [14, 14, 13, 10];
      const lines = renderCategoryRows(summaries, colWidths);
      const dividers = lines.filter((l) => l.includes('┼'));
      // 4 categories = 3 between-row dividers
      expect(dividers).toHaveLength(3);
      // Last line should NOT be a divider
      expect(lines[lines.length - 1]).not.toContain('┼');
    });

    it('uses Loaded:/Active:/Stale: for memory category', () => {
      const colWidths: [number, number, number, number] = [14, 14, 13, 10];
      const lines = renderCategoryRows(summaries, colWidths);
      const combined = lines.join('\n');
      expect(combined).toContain('Loaded:');
      expect(combined).toContain('Active:');
      expect(combined).toContain('Stale:');
    });
  });

  describe('renderProgressBar barWidth param', () => {
    it('respects custom barWidth', () => {
      const bar = renderProgressBar(50, 20);
      // Bar uses 20 chars for fill+empty, not 50
      // [filled+empty] part: 20 chars of █ and ░
      // eslint-disable-next-line no-control-regex
      const stripped = bar.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI
      // Content between [ and ] should be 20 chars
      const match = stripped.match(/\[(.+)\]/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBe(20);
    });

    it('defaults to barWidth=50 when not provided', () => {
      const bar = renderProgressBar(50);
      // eslint-disable-next-line no-control-regex
      const stripped = bar.replace(/\x1b\[[0-9;]*m/g, '');
      const match = stripped.match(/\[(.+)\]/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBe(50);
    });

    it('clamps barWidth to minimum 10', () => {
      const bar = renderProgressBar(50, 5);
      // eslint-disable-next-line no-control-regex
      const stripped = bar.replace(/\x1b\[[0-9;]*m/g, '');
      const match = stripped.match(/\[(.+)\]/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBe(10); // clamped from 5 to 10
    });
  });

  describe('renderGhostOutputBox', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 176, used: 13, ghost: 163, tokenCost: 0 },
      { category: 'skill', defined: 81, used: 7, ghost: 74, tokenCost: 0 },
      { category: 'mcp-server', defined: 4, used: 0, ghost: 4, tokenCost: 0 },
      { category: 'memory', defined: 9, used: 9, ghost: 0, tokenCost: 0 },
    ];
    const header = '👻 Ghost Inventory — Last 7 days\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const bottomLines = ['Total ghost overhead: ~7.0k tokens', 'Health grade: D (Poor)'];
    const progressPct = 4;

    for (const tw of [40, 56, 80]) {
      it(`no line exceeds termWidth=${tw}`, () => {
        const output = renderGhostOutputBox(header, summaries, bottomLines, progressPct, tw);
        for (const line of output.split('\n')) {
          // Strip ANSI codes before measuring
          // eslint-disable-next-line no-control-regex
          const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
          expect(visible.length).toBeLessThanOrEqual(tw);
        }
      });
    }

    it('uses only first line of header (drops ━━━ divider)', () => {
      const output = renderGhostOutputBox(header, summaries, bottomLines, progressPct, 80);
      expect(output).toContain('Ghost Inventory');
      // The ━ divider from the header should NOT appear (column table replaces it)
      expect(output).not.toContain('━');
    });

    it('contains ┬ in after-header divider', () => {
      const output = renderGhostOutputBox(header, summaries, bottomLines, progressPct, 80);
      expect(output).toContain('┬');
    });

    it('contains ┴ in close-columns divider', () => {
      const output = renderGhostOutputBox(header, summaries, bottomLines, progressPct, 80);
      expect(output).toContain('┴');
    });

    it('renders progress bar when progressPct is not null', () => {
      const output = renderGhostOutputBox(header, summaries, bottomLines, progressPct, 80);
      // Progress bar contains [ and ]
      expect(output).toContain('[');
      expect(output).toContain(']');
      expect(output).toContain('%');
    });

    it('omits progress bar when progressPct is null', () => {
      const output = renderGhostOutputBox(header, summaries, bottomLines, null, 80);
      // No % sign from progress bar
      expect(output).not.toContain('%');
    });

    it('wraps bottom prose lines within content width at narrow terminal', () => {
      const longLine = 'Total ghost overhead: ~7.0k tokens (~3.5% of 200k context)';
      const output = renderGhostOutputBox(header, summaries, [longLine], null, 56);
      for (const line of output.split('\n')) {
        // eslint-disable-next-line no-control-regex
        const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
        expect(visible.length).toBeLessThanOrEqual(56);
      }
    });

    it('progress bar width is at most contentWidth - 8', () => {
      // At termWidth=40: contentWidth = 40-4 = 36, barWidth = max(10, min(50, 36-8)) = 28
      const output = renderGhostOutputBox(header, summaries, [], 50, 40);
      const lines = output.split('\n');
      const barLine = lines.find((l) => l.includes('[') && l.includes('%'));
      expect(barLine).toBeDefined();
      // eslint-disable-next-line no-control-regex
      const stripped = barLine!.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(40);
    });

    it('renders parenthetical inside the box when frameworkGhostsByCategory is provided', () => {
      const summaries: CategorySummary[] = [
        { category: 'agent', defined: 140, used: 12, ghost: 128, tokenCost: 47000 },
      ];
      const out = renderGhostOutputBox('Test header', summaries, [], null, 120, { agent: 81 });
      expect(out).toContain('81 in frameworks above');
    });
  });
}
