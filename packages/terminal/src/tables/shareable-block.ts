import { colorize } from '../color.ts';
import type { HealthGrade } from '@ccaudit/internal';
import { letterForGrade } from './score.ts';
import { stripAnsi, getTerminalWidth, wordWrap } from '../utils/table-utils.ts';
import { renderProgressBar } from './ghost-table.ts';

export interface ShareableBlockParams {
  beforeTokens: number;
  afterTokens: number;
  freedTokens: number;
  pctWindow: number;
  healthBefore: number;
  healthAfter: number;
  gradeBefore: string; // e.g. 'Poor'
  gradeAfter: string; // e.g. 'Healthy'
  counts: {
    archivedAgents: number;
    archivedSkills: number;
    disabledMcp: number;
    flaggedMemory: number;
  };
  manifestPath: string;
  privacy?: boolean;
  /**
   * Provenance of the Before token count — set when Before was measured at
   * dry-run checkpoint time (not live). Renders as:
   *   "Before (from dry-run <at>): ~96k tokens loaded per session"
   * Omit for backward-compat (renders old format without hint).
   */
  beforeProvenance?: { source: 'dry-run'; at: string };
}

function fmtK(tokens: number): string {
  if (tokens >= 10_000) return `~${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `~${(tokens / 1000).toFixed(1)}k`;
  return `~${tokens}`;
}

function colorForGrade(grade: string, text: string): string {
  const g = grade as HealthGrade;
  if (g === 'Healthy') return colorize.green(colorize.bold(text));
  if (g === 'Fair') return colorize.yellow(colorize.bold(text));
  // Poor and Critical both get red
  return colorize.red(colorize.bold(text));
}

/**
 * Render the post-bust summary as a responsive Unicode box table,
 * matching the ghost command's rendering style.
 *
 * Width is clamped to terminal width (process.stdout.columns) and all
 * prose lines word-wrap rather than truncate.
 */
export function renderShareableBlock(p: ShareableBlockParams): string {
  const termWidth = getTerminalWidth();

  // Build the prose content lines (label + value pairs)
  const bLetter = letterForGrade(p.gradeBefore as HealthGrade);
  const aLetter = letterForGrade(p.gradeAfter as HealthGrade);

  // Header text lines (plain, for width measurement)
  const headerText1 = 'CCAUDIT --dangerously-bust-ghosts';
  const headerText3 = '\u{1F47B} Ghost Inventory \u2014 Cleared';

  // Content rows (plain text versions for width measurement, colored for render)
  const beforeLabel = p.beforeProvenance
    ? `Before (from dry-run ${p.beforeProvenance.at}):`
    : 'Before:  ';
  const beforeVal = `${fmtK(p.beforeTokens)} tokens loaded per session`;
  const afterVal = `${fmtK(p.afterTokens)} tokens`;
  const freedVal = `${fmtK(p.freedTokens)} tokens (${p.pctWindow}% of context window)`;
  const healthBefore = `${bLetter} (${p.gradeBefore})`;
  const healthAfter = `${aLetter} (${p.gradeAfter})`;
  const archivedVal = `${p.counts.archivedAgents} agents, ${p.counts.archivedSkills} skills`;
  const disabledVal = `${p.counts.disabledMcp} MCP servers`;
  const flaggedVal = `${p.counts.flaggedMemory} memory files`;

  // Plain content rows used for width computation
  const plainContentRows: string[] = [
    `${beforeLabel} ${beforeVal}`,
    `After:    ${afterVal}`,
    `Freed:    ${freedVal}`,
    '',
    `Health:   ${healthBefore} \u2192 ${healthAfter}`,
    '',
    `Archived: ${archivedVal}`,
    `Disabled: ${disabledVal}`,
    `Flagged:  ${flaggedVal}`,
  ];

  if (p.privacy) {
    plainContentRows.push('');
    plainContentRows.push('(paths redacted \u2014 safe to share)');
  }

  plainContentRows.push('');
  // Progress bar placeholder (measured later after we know contentWidth)
  plainContentRows.push(`Manifest: ${p.manifestPath}`);
  plainContentRows.push('Restore anytime: ccaudit restore');

  // Compute natural box width:
  // Include header text lines + content rows for width measurement
  const allTextLines = [headerText1, headerText3, ...plainContentRows];
  const naturalWidth = Math.max(
    ...allTextLines.map((l) => stripAnsi(l).length + 4),
    44, // minimum usable width
  );
  const tw = Math.min(termWidth, naturalWidth);
  const innerWidth = tw - 2; // chars between the two outer border │ chars
  const contentWidth = innerWidth - 2; // 1 pad each side

  // Build colored header rows
  // Divider width = max visible length of header text lines, clamped to contentWidth
  const dividerTextLen = Math.min(
    contentWidth,
    Math.max(stripAnsi(headerText1).length, stripAnsi(headerText3).length),
  );
  const headerRows: string[] = [
    colorize.bold(headerText1),
    colorize.cyan('\u2501'.repeat(dividerTextLen)),
    colorize.bold(headerText3),
    colorize.cyan('\u2501'.repeat(dividerTextLen)),
  ];

  // Build colored content rows for rendering
  const coloredHealthBefore = colorForGrade(p.gradeBefore, healthBefore);
  const coloredHealthAfter = colorForGrade(p.gradeAfter, healthAfter);

  const coloredContentRows: string[] = [
    `${beforeLabel} ${colorize.yellow(beforeVal)}`,
    `After:    ${colorize.greenBright(colorize.bold(afterVal))}`,
    `Freed:    ${colorize.greenBright(colorize.bold(freedVal))}`,
    '',
    `Health:   ${coloredHealthBefore} ${colorize.dim('\u2192')} ${coloredHealthAfter}`,
    '',
    `Archived: ${colorize.bold(String(p.counts.archivedAgents))} agents, ${colorize.bold(String(p.counts.archivedSkills))} skills`,
    `Disabled: ${colorize.bold(String(p.counts.disabledMcp))} MCP servers`,
    `Flagged:  ${colorize.bold(String(p.counts.flaggedMemory))} memory files`,
  ];

  if (p.privacy) {
    coloredContentRows.push('');
    coloredContentRows.push(colorize.dim('(paths redacted \u2014 safe to share)'));
  }

  // Progress bar row — afterPct as percentage of 200k context window
  const afterPct = Math.round((p.afterTokens / 200_000) * 100 * 10) / 10;
  const barWidth = Math.min(50, contentWidth - 8);
  const progressRow = renderProgressBar(afterPct, barWidth);

  coloredContentRows.push('');
  coloredContentRows.push(progressRow);
  coloredContentRows.push('');
  coloredContentRows.push(colorize.dim(`Manifest: ${p.manifestPath}`));
  coloredContentRows.push(colorize.dim('Restore anytime: ccaudit restore'));

  // Build the rendered lines
  const lines: string[] = [];

  // Top border
  lines.push('\u250c' + '\u2500'.repeat(innerWidth) + '\u2510');

  // Multi-line header block (all inside box, before the ├...┤ divider)
  for (const headerRow of headerRows) {
    const visLen = stripAnsi(headerRow).length;
    const rightPad = ' '.repeat(Math.max(0, contentWidth - visLen));
    lines.push('\u2502 ' + headerRow + rightPad + ' \u2502');
  }

  // Divider between header and body
  lines.push('\u251c' + '\u2500'.repeat(innerWidth) + '\u2524');

  // Body rows — word-wrap long lines (e.g. manifest path)
  for (const row of coloredContentRows) {
    if (row === '') {
      // Empty spacer line
      lines.push('\u2502' + ' '.repeat(innerWidth) + '\u2502');
      continue;
    }
    const wrapped = wordWrap(row, contentWidth);
    for (const sub of wrapped) {
      const visLen = stripAnsi(sub).length;
      const rightPad = ' '.repeat(Math.max(0, contentWidth - visLen));
      lines.push('\u2502 ' + sub + rightPad + ' \u2502');
    }
  }

  // Bottom border
  lines.push('\u2514' + '\u2500'.repeat(innerWidth) + '\u2518');

  return lines.join('\n');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const baseParams: ShareableBlockParams = {
    beforeTokens: 15_000,
    afterTokens: 5_000,
    freedTokens: 10_000,
    pctWindow: 5,
    healthBefore: 42,
    healthAfter: 88,
    gradeBefore: 'Poor',
    gradeAfter: 'Healthy',
    counts: {
      archivedAgents: 3,
      archivedSkills: 2,
      disabledMcp: 1,
      flaggedMemory: 4,
    },
    manifestPath: '/home/user/.claude/manifest.json',
  };

  describe('fmtK', () => {
    it('formats tokens >= 10k as ~Xk (rounded)', () => {
      const result = renderShareableBlock({ ...baseParams, beforeTokens: 15_000 });
      expect(result).toContain('~15k');
    });

    it('formats tokens >= 1k as ~X.Xk', () => {
      const result = renderShareableBlock({ ...baseParams, beforeTokens: 1_500 });
      expect(result).toContain('~1.5k');
    });

    it('formats tokens < 1k as ~X', () => {
      const result = renderShareableBlock({ ...baseParams, beforeTokens: 800 });
      expect(result).toContain('~800');
    });

    it('formats 10k exactly as ~10k', () => {
      const result = renderShareableBlock({ ...baseParams, beforeTokens: 10_000 });
      expect(result).toContain('~10k');
    });
  });

  describe('renderShareableBlock', () => {
    it('uses Unicode box-drawing border characters (not dashes)', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('\u250c'); // ┌
      expect(result).toContain('\u2510'); // ┐
      expect(result).toContain('\u2514'); // └
      expect(result).toContain('\u2518'); // ┘
      expect(result).toContain('\u2502'); // │
    });

    it('does NOT use the old dashed border', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).not.toContain('-'.repeat(46));
    });

    it('contains the command name', () => {
      const result = renderShareableBlock(baseParams);
      // Header uses uppercase CCAUDIT
      expect(result).toContain('CCAUDIT --dangerously-bust-ghosts');
    });

    it('contains the ghost inventory cleared header', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('Ghost Inventory');
      expect(result).toContain('Cleared');
    });

    it('contains CCAUDIT header line', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('CCAUDIT --dangerously-bust-ghosts');
    });

    it('contains cyan heavy dividers in header', () => {
      const result = renderShareableBlock(baseParams);
      // \u2501 is ━ (heavy horizontal), used in header dividers
      expect(result).toContain('\u2501');
    });

    it('does NOT contain npx install line', () => {
      // The shareable block no longer includes the install hint
      const result = renderShareableBlock(baseParams);
      expect(result).not.toContain('npx ccaudit@latest');
    });

    it('contains before/after/freed token lines', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('Before:');
      expect(result).toContain('After:');
      expect(result).toContain('Freed:');
    });

    it('contains grade-based health display', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('D (Poor)');
      expect(result).toContain('A+ (Healthy)');
      expect(result).toContain('\u2192');
      expect(result).not.toContain('/100');
    });

    it('contains counts', () => {
      const result = renderShareableBlock(baseParams);
      // eslint-disable-next-line no-control-regex
      const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('3 agents, 2 skills');
      expect(stripped).toContain('1 MCP servers');
      expect(stripped).toContain('4 memory files');
    });

    it('contains manifest path', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('/home/user/.claude/manifest.json');
    });

    it('contains restore hint', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).toContain('Restore anytime: ccaudit restore');
    });

    it('contains a progress bar', () => {
      const result = renderShareableBlock(baseParams);
      // Progress bar uses block characters
      expect(result).toContain('\u2591'); // ░ (empty fill)
    });

    it('omits privacy line when privacy is falsy', () => {
      const result = renderShareableBlock(baseParams);
      expect(result).not.toContain('paths redacted');
    });

    it('includes privacy line when privacy is true', () => {
      const result = renderShareableBlock({ ...baseParams, privacy: true });
      expect(result).toContain('paths redacted');
    });

    it('first line is the top border starting with ┌', () => {
      const result = renderShareableBlock(baseParams);
      const firstLine = result.split('\n')[0]!;
      expect(firstLine.startsWith('\u250c')).toBe(true);
    });

    it('Phase 5: beforeProvenance renders timestamp hint on Before line', () => {
      // When beforeProvenance is provided, the Before line must include
      // "(from dry-run <timestamp>)" to signal checkpoint provenance.
      const result = renderShareableBlock({
        ...baseParams,
        beforeProvenance: { source: 'dry-run', at: '2026-04-14T08:19:58.000Z' },
      });
      // Strip ANSI codes for assertion
      // eslint-disable-next-line no-control-regex
      const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toMatch(/Before\s*\(from dry-run 2026-04-14T08:19:58\.000Z\)/);
    });

    it('Phase 5: Before line without beforeProvenance uses existing format (backward compat)', () => {
      // When beforeProvenance is absent, Before line must still render in old format
      const result = renderShareableBlock(baseParams);
      // eslint-disable-next-line no-control-regex
      const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('Before:');
      expect(stripped).not.toContain('from dry-run');
    });

    it('last line is the bottom border starting with └', () => {
      const result = renderShareableBlock(baseParams);
      const lines = result.split('\n');
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.startsWith('\u2514')).toBe(true);
    });

    it('all box lines have consistent width', () => {
      const result = renderShareableBlock(baseParams);
      const lines = result.split('\n');
      // Strip ANSI to measure visual width
      const widths = lines.map((l) => stripAnsi(l).length);
      const expectedWidth = widths[0]!;
      for (const w of widths) {
        expect(w).toBe(expectedWidth);
      }
    });

    it('header has 4 rows before the body divider', () => {
      const result = renderShareableBlock(baseParams);
      const lines = result.split('\n');
      // Line 0: top border ┌
      // Lines 1-4: 4 header rows
      // Line 5: body divider ├
      const dividerLine = lines[5]!;
      expect(dividerLine.startsWith('\u251c')).toBe(true);
    });
  });
}
