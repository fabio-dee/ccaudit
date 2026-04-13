/**
 * Render the "Frameworks" section of the ghost/inventory report as a bordered
 * Unicode table (cli-table3-compatible manual box drawing, matching the style
 * of `renderTopGhosts` and `renderProjectsTable` in `ghost-table.ts`).
 *
 * Supersedes Phase 3 D-18 which originally specified "plain padded columns —
 * NO cli-table3 borders". UAT against a live 20+ framework inventory showed
 * the plain-column rendering was visually inconsistent with every other
 * section of the ghost report (ghost box, Top Ghosts, Global Baseline,
 * Per-Project Overhead — all bordered). This renderer brings the Frameworks
 * section into visual parity.
 *
 * v1.3.x UI polish: verbose mode now emits **two stacked bordered tables**
 * (a roll-up table plus a member drilldown table) instead of interleaving
 * tree-glyph rows (`+ N used`, `|- leaf`, `` `- ... `` continuation) inside
 * the roll-up box. The member table only appears in verbose mode and only
 * includes members of partially-used and ghost-all frameworks — fully-used
 * frameworks are omitted from the drilldown since there is nothing
 * actionable to show. Non-verbose mode output is unchanged from the prior
 * bordered-table rewrite.
 *
 * Roll-up column layout (6 border chars + name + 7 + 8 + 9 + 14 = tw):
 *   col0 (Name)    : Math.max(20, tw - 44)  — flexible
 *   col1 (Def)     : 7 chars
 *   col2 (Used)    : 8 chars
 *   col3 (Ghost)   : 9 chars
 *   col4 (~Tokens) : 14 chars
 *
 * Member column layout (5 border chars + frameworkW + memberW + 10 + 14 = tw):
 *   col0 (Framework) : clamped between 10 and 20 chars
 *   col1 (Member)    : tw - (5 + frameworkW + 10 + 14)  — flexible
 *   col2 (Tier)      : 10 chars
 *   col3 (~Tokens)   : 14 chars
 *
 * Behaviors preserved from the plain-text predecessor:
 * - `renderFrameworksSection([], opts)` returns '' so callers can skip the
 *   trailing blank line without extra special-casing.
 * - Heuristic (non-curated) frameworks append '~' to displayName as the
 *   sole visual marker. Earlier revisions additionally wrapped the entire
 *   row in `colorize.dim`, but that inflated the rendered byte length past
 *   `clampRow`'s width budget (the 9-byte `\x1b[2m`…`\x1b[22m` envelope is
 *   invisible but still counted by `row.length`), causing the trailing `│`
 *   border to be sliced off and replaced by the closing `m` of the SGR
 *   reset. The dim wrap has been dropped; the `~` suffix is now the only
 *   heuristic indicator, which also keeps the Frameworks section visually
 *   consistent with every other bordered table in the report (where rows
 *   are never whole-row dimmed).
 * - Token count column uses `ghostTokenCost` (not `totalTokenCost`) in the
 *   roll-up table; per-member token estimates in the member table.
 *
 * Caller is responsible for sorting `groups` (Phase 3 callers sort by
 * displayName ASC per OUT-04). The renderer emits in input order; members
 * within a group are emitted sorted by tier (used → likely-ghost →
 * definite-ghost), then by name ASC.
 */

import type { FrameworkGroup, GhostItem } from '@ccaudit/internal';
import * as colorModule from '../color.ts';
import {
  getTerminalWidth,
  stripAnsi,
  truncateAnsi,
  wrapCell,
  buildDividerRow,
} from '../utils/table-utils.ts';
import { formatTokensShortPlain } from './ghost-table.ts';

const { colorize } = colorModule;

/** Fixed width of the three integer columns + the tokens column (col1..col4). */
const DEF_W = 7;
const USED_W = 8;
const GHOST_W = 9;
const TOKENS_W = 14;

/** Minimum flexible width for the Name column in the roll-up table. */
const NAME_MIN_W = 20;

/** Fixed width of the Tier column in the member table (matches inventory-table.ts). */
const TIER_W = 10;

/** Framework column width in the member table — fixed, clamped for narrow terminals. */
const MEMBER_FRAMEWORK_W_DEFAULT = 20;
const MEMBER_FRAMEWORK_W_MIN = 10;

/** Minimum flexible width for the Member name column in the member table. */
const MEMBER_NAME_MIN_W = 15;

/**
 * Render the Frameworks section. Returns '' when groups is empty.
 *
 * In non-verbose mode this emits a single bordered roll-up table (one row
 * per framework). In verbose mode it emits the same roll-up table followed
 * by a blank line and a second bordered table listing every member of each
 * partially-used and ghost-all framework.
 */
export function renderFrameworksSection(
  groups: FrameworkGroup[],
  opts: { verbose: boolean },
): string {
  if (groups.length === 0) return '';

  const rollup = renderFrameworksRollupTable(groups);
  if (!opts.verbose) return rollup;

  const members = renderFrameworksMemberTable(groups);
  if (members === '') return rollup;

  return rollup + '\n' + members;
}

/** Render the roll-up table (one row per framework). */
function renderFrameworksRollupTable(groups: FrameworkGroup[]): string {
  const tw = getTerminalWidth();

  // Fixed = 6 border chars + DEF_W + USED_W + GHOST_W + TOKENS_W = 6 + 38 = 44
  // nameW = tw - 44, floored at NAME_MIN_W
  const nameW = Math.max(NAME_MIN_W, tw - (6 + DEF_W + USED_W + GHOST_W + TOKENS_W));
  const colWidths = [nameW, DEF_W, USED_W, GHOST_W, TOKENS_W] as const;
  const innerWidth = nameW + DEF_W + USED_W + GHOST_W + TOKENS_W + 4; // 4 inner seps

  // Guard: if the terminal is so narrow that even the minimum-width columns
  // overflow, we still render — clamping happens row-by-row below.
  const clampRow = (row: string): string => {
    const visLen = stripAnsi(row).length;
    if (visLen <= tw) return row;
    return truncateAnsi(row, tw - 1) + row[row.length - 1]!;
  };

  const lines: string[] = [];

  // Title row (full-width, no inner column separators)
  const titleText = colorize.bold('\u{1F9E9} Frameworks:');
  const titleVisible = stripAnsi(titleText);
  const titleContent =
    titleVisible.length > innerWidth - 2 ? truncateAnsi(titleText, innerWidth - 2) : titleText;
  const titleRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(titleContent).length));

  // Top border (full-width, no column dividers in the title span)
  lines.push('┌' + '─'.repeat(innerWidth) + '┐');
  lines.push('│ ' + titleContent + titleRightPad + ' │');
  // Transition row: introduces column dividers (┬)
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┬', '┤')));

  // Column header row
  const hName = wrapCell('Name', nameW)[0]!;
  const hDef = wrapCell('Def', DEF_W)[0]!;
  const hUsed = wrapCell('Used', USED_W)[0]!;
  const hGhost = wrapCell('Ghost', GHOST_W)[0]!;
  const hTokens = wrapCell('~Tokens', TOKENS_W)[0]!;
  lines.push(clampRow('│' + hName + '│' + hDef + '│' + hUsed + '│' + hGhost + '│' + hTokens + '│'));

  // Divider between header and data rows (┼)
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

  for (const group of groups) {
    renderOneRollupGroup(group, nameW, lines, clampRow);
  }

  // Bottom border (┴)
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  return lines.join('\n');
}

/** Render a single FrameworkGroup as one (or a few wrapped) rows in the roll-up table. */
function renderOneRollupGroup(
  group: FrameworkGroup,
  nameW: number,
  lines: string[],
  clampRow: (row: string) => string,
): void {
  // Heuristic frameworks are marked solely via the '~' suffix on rawName.
  // Do NOT wrap the emitted row in colorize.dim — clampRow measures byte
  // length, and the dim SGR envelope (9 invisible bytes) would push the
  // row over the width budget and get the trailing '│' sliced off.
  const isHeuristic = group.source_type === 'heuristic';
  const totalGhost = group.totals.likelyGhost + group.totals.definiteGhost;
  const rawName = isHeuristic ? `${group.displayName}~` : group.displayName;

  // Name cell: wrapCell handles padding + wrapping to width.
  const nameLines = wrapCell(rawName, nameW);

  // Numeric cells: right-align within inner width (cellW - 2), 1 pad each side.
  const defCell = ' ' + String(group.totals.defined).padStart(DEF_W - 2) + ' ';
  const usedCell = ' ' + String(group.totals.used).padStart(USED_W - 2) + ' ';
  const ghostCell = ' ' + String(totalGhost).padStart(GHOST_W - 2) + ' ';

  // ~Tokens cell: right-align token string within TOKENS_W - 2.
  const tokenStr = formatTokensShortPlain(group.totals.ghostTokenCost);
  const tokensCell = ' ' + tokenStr.padStart(TOKENS_W - 2) + ' ';

  // Emit one or more sub-rows if the framework name wrapped onto multiple lines.
  const rowHeight = nameLines.length;
  for (let r = 0; r < rowHeight; r++) {
    const n = nameLines[r] ?? ' '.repeat(nameW);
    const c1 = r === 0 ? defCell : ' '.repeat(DEF_W);
    const c2 = r === 0 ? usedCell : ' '.repeat(USED_W);
    const c3 = r === 0 ? ghostCell : ' '.repeat(GHOST_W);
    const c4 = r === 0 ? tokensCell : ' '.repeat(TOKENS_W);
    const row = '│' + n + '│' + c1 + '│' + c2 + '│' + c3 + '│' + c4 + '│';
    // No colorize.dim wrap: isHeuristic is reflected by the '~' suffix
    // baked into rawName above. Dimming the whole row inflates byte
    // length beyond clampRow's width budget and slices the trailing '│'.
    lines.push(clampRow(row));
  }
}

/**
 * Render the member drilldown table (verbose-only). Returns '' when no
 * partially-used or ghost-all frameworks exist (i.e., all frameworks are
 * fully-used — nothing to drill down on).
 */
function renderFrameworksMemberTable(groups: FrameworkGroup[]): string {
  // Only drill into frameworks that have at least one non-used member —
  // fully-used frameworks contribute no actionable detail.
  const drilldownGroups = groups.filter((g) => g.status !== 'fully-used');
  if (drilldownGroups.length === 0) return '';

  const tw = getTerminalWidth();

  // Fixed = 5 border chars + TIER_W + TOKENS_W = 5 + 24 = 29
  // Remaining for frameworkW + memberW = tw - 29.
  // Clamp frameworkW between MIN and DEFAULT; memberW absorbs the rest.
  const budgetForNames = tw - (5 + TIER_W + TOKENS_W);
  const frameworkW = Math.max(
    MEMBER_FRAMEWORK_W_MIN,
    Math.min(MEMBER_FRAMEWORK_W_DEFAULT, budgetForNames - MEMBER_NAME_MIN_W),
  );
  const memberW = Math.max(MEMBER_NAME_MIN_W, budgetForNames - frameworkW);
  const colWidths = [frameworkW, memberW, TIER_W, TOKENS_W] as const;
  const innerWidth = frameworkW + memberW + TIER_W + TOKENS_W + 3; // 3 inner seps

  const clampRow = (row: string): string => {
    const visLen = stripAnsi(row).length;
    if (visLen <= tw) return row;
    return truncateAnsi(row, tw - 1) + row[row.length - 1]!;
  };

  const lines: string[] = [];

  // Title row (full-width, no inner column separators)
  const titleText = colorize.bold('\u{1F9E9} Framework members (verbose):');
  const titleVisible = stripAnsi(titleText);
  const titleContent =
    titleVisible.length > innerWidth - 2 ? truncateAnsi(titleText, innerWidth - 2) : titleText;
  const titleRightPad = ' '.repeat(Math.max(0, innerWidth - 2 - stripAnsi(titleContent).length));

  lines.push('┌' + '─'.repeat(innerWidth) + '┐');
  lines.push('│ ' + titleContent + titleRightPad + ' │');
  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┬', '┤')));

  // Column header row
  const hFramework = wrapCell('Framework', frameworkW)[0]!;
  const hMember = wrapCell('Member', memberW)[0]!;
  const hTier = wrapCell('Tier', TIER_W)[0]!;
  const hTokens = wrapCell('~Tokens', TOKENS_W)[0]!;
  lines.push(clampRow('│' + hFramework + '│' + hMember + '│' + hTier + '│' + hTokens + '│'));

  lines.push(clampRow(buildDividerRow([...colWidths], '├', '┼', '┤')));

  // Data rows — one row per member, grouped by framework. The framework
  // column prints only on the first row of each group (blank for repeats)
  // to reduce visual noise. Heuristic frameworks keep the '~' suffix on
  // their frameworkLabel as the sole visual marker — rows are NOT wrapped
  // in colorize.dim (doing so inflates byte length past clampRow's width
  // budget and slices off the trailing '│' border).
  for (const group of drilldownGroups) {
    const isHeuristic = group.source_type === 'heuristic';
    const frameworkLabel = isHeuristic ? `${group.displayName}~` : group.displayName;

    const sortedMembers = sortMembersForDrilldown(group.members);
    for (let i = 0; i < sortedMembers.length; i++) {
      const member = sortedMembers[i]!;
      // Framework column only on first row of each group.
      const frameworkCellLines =
        i === 0 ? wrapCell(frameworkLabel, frameworkW) : [' '.repeat(frameworkW)];
      const memberCellLines = wrapCell(member.name, memberW);
      const tierCell = buildColoredTierCell(member.tier, TIER_W);
      const tokenStr = formatTokensShortPlain(member.tokenEstimate?.tokens ?? 0);
      const tokensCell = ' ' + tokenStr.padStart(TOKENS_W - 2) + ' ';

      const rowHeight = Math.max(frameworkCellLines.length, memberCellLines.length, 1);
      for (let r = 0; r < rowHeight; r++) {
        const fw = frameworkCellLines[r] ?? ' '.repeat(frameworkW);
        const mb = memberCellLines[r] ?? ' '.repeat(memberW);
        const tr = r === 0 ? tierCell : ' '.repeat(TIER_W);
        const tk = r === 0 ? tokensCell : ' '.repeat(TOKENS_W);
        const row = '│' + fw + '│' + mb + '│' + tr + '│' + tk + '│';
        lines.push(clampRow(row));
      }
    }
  }

  // Bottom border (┴)
  lines.push(clampRow(buildDividerRow([...colWidths], '└', '┴', '┘')));

  return lines.join('\n');
}

/**
 * Sort members for the drilldown table:
 *   1. tier order: used → likely-ghost → definite-ghost
 *   2. name ASC (case-insensitive tiebreak)
 */
function sortMembersForDrilldown(members: GhostItem[]): GhostItem[] {
  const tierRank = (tier: string): number => {
    switch (tier) {
      case 'used':
        return 0;
      case 'likely-ghost':
        return 1;
      case 'definite-ghost':
        return 2;
      default:
        return 3;
    }
  };
  return members.slice().sort((a, b) => {
    const ta = tierRank(a.tier);
    const tb = tierRank(b.tier);
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Render a colored tier label cell ([ACTIVE] / [LIKELY] / [GHOST]) padded
 * to `cellWidth` chars. Matches the convention used in inventory-table.ts
 * so both tables share the same visual tier markers.
 */
function buildColoredTierCell(tier: string, cellWidth: number): string {
  const label = formatTierLabel(tier);
  const visible = stripAnsi(label);
  const total = cellWidth - 1; // 1 left pad already included
  const rightPad = Math.max(0, total - visible.length);
  return ' ' + label + ' '.repeat(rightPad);
}

function formatTierLabel(tier: string): string {
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

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;

  function makeMember(
    name: string,
    tier: 'used' | 'likely-ghost' | 'definite-ghost',
    tokens: number,
    daysAgo: number | null = null,
  ): GhostItem {
    return {
      name,
      path: `/test/${name}`,
      scope: 'global',
      category: 'agent',
      tier,
      lastUsed: daysAgo === null ? null : new Date(Date.now() - daysAgo * 86_400_000),
      urgencyScore: 0,
      daysSinceLastUse: daysAgo,
      framework: 'gsd',
      tokenEstimate: { tokens, confidence: 'estimated', source: 'file size' },
    };
  }

  function makeGroup(
    id: string,
    displayName: string,
    members: GhostItem[],
    sourceType: 'curated' | 'heuristic' = 'curated',
  ): FrameworkGroup {
    const used = members.filter((m) => m.tier === 'used');
    const likely = members.filter((m) => m.tier === 'likely-ghost');
    const definite = members.filter((m) => m.tier === 'definite-ghost');
    const ghostTokenCost = members
      .filter((m) => m.tier !== 'used')
      .reduce((sum, m) => sum + (m.tokenEstimate?.tokens ?? 0), 0);
    const totalTokenCost = members.reduce((sum, m) => sum + (m.tokenEstimate?.tokens ?? 0), 0);
    return {
      id,
      displayName,
      source_type: sourceType,
      members,
      totals: {
        defined: members.length,
        used: used.length,
        likelyGhost: likely.length,
        definiteGhost: definite.length,
        ghostTokenCost,
        totalTokenCost,
      },
      status:
        used.length === 0
          ? 'ghost-all'
          : likely.length + definite.length === 0
            ? 'fully-used'
            : 'partially-used',
    };
  }

  describe('renderFrameworksSection — empty input', () => {
    it('returns empty string for empty groups array', () => {
      expect(renderFrameworksSection([], { verbose: false })).toBe('');
      expect(renderFrameworksSection([], { verbose: true })).toBe('');
    });
  });

  describe('renderFrameworksSection — collapsed mode', () => {
    it('renders the Frameworks title and a bordered table with one row per group', () => {
      const groups = [
        makeGroup('gsd', 'GSD (Get Shit Done)', [
          makeMember('gsd-planner', 'definite-ghost', 3200, 90),
          makeMember('gsd-runner', 'used', 2000, 1),
        ]),
        makeGroup('sc', 'SuperClaude', [makeMember('sc:design', 'definite-ghost', 1800, 120)]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      // Title row
      expect(stripAnsi(out)).toContain('Frameworks:');
      // Column headers
      expect(out).toContain('Name');
      expect(out).toContain('Def');
      expect(out).toContain('Used');
      expect(out).toContain('Ghost');
      expect(out).toContain('~Tokens');
      // Data rows for both groups
      expect(out).toContain('GSD (Get Shit Done)');
      expect(out).toContain('SuperClaude');
      // Bordered output: must contain box-drawing chars
      expect(out).toContain('┌');
      expect(out).toContain('┐');
      expect(out).toContain('└');
      expect(out).toContain('┘');
      expect(out).toContain('│');
    });

    it('renders defined / used / ghost counts as right-padded numbers in their cells', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-a', 'used', 1000, 1),
          makeMember('gsd-b', 'used', 1000, 1),
          makeMember('gsd-c', 'definite-ghost', 1000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      // Numeric cells contain the right-aligned values.
      // DEF_W=7 inner 5: "    3" surrounded by │
      expect(out).toMatch(/│ {5}3 │/);
      // USED_W=8 inner 6: "     2"
      expect(out).toMatch(/│ {6}2 │/);
      // GHOST_W=9 inner 7: "      1"
      expect(out).toMatch(/│ {7}1 │/);
    });

    it('uses ghostTokenCost for the ~Tokens column (not totalTokenCost)', () => {
      // 1 used (5000) + 1 ghost (3000) → ghost cost = 3000 → "~3.0k tokens"
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-used', 'used', 5000, 1),
          makeMember('gsd-ghost', 'definite-ghost', 3000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      expect(out).toContain('~3.0k tokens');
      expect(out).not.toContain('~8.0k tokens');
    });

    it('does NOT include verbose tree lines or member drilldown in collapsed mode', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-a', 'definite-ghost', 1000, 90),
          makeMember('gsd-b', 'definite-ghost', 1000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      // No interleaved tree glyphs (replaced by two-table layout in v1.3.x).
      expect(out).not.toContain('|-');
      expect(out).not.toMatch(/\+ \d+ used member/);
      // No member drilldown title in collapsed mode.
      expect(out).not.toContain('Framework members');
    });
  });

  describe('renderFrameworksSection — verbose mode (member table)', () => {
    it('emits a second bordered table with Framework/Member/Tier/~Tokens columns', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-used', 'used', 1000, 1),
          makeMember('gsd-ghost', 'definite-ghost', 2000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      // The member table title identifies the drilldown section.
      expect(stripAnsi(out)).toContain('Framework members');
      // Member-table column headers.
      expect(out).toContain('Framework');
      expect(out).toContain('Member');
      expect(out).toContain('Tier');
      // Both tables are present → at least two top borders.
      const topBorderCount = (out.match(/┌/g) ?? []).length;
      expect(topBorderCount).toBeGreaterThanOrEqual(2);
    });

    it('lists every non-fully-used member in the drilldown table', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-a', 'used', 1000, 1),
          makeMember('gsd-b', 'definite-ghost', 2000, 90),
          makeMember('gsd-c', 'likely-ghost', 1500, 45),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      expect(out).toContain('gsd-a');
      expect(out).toContain('gsd-b');
      expect(out).toContain('gsd-c');
    });

    it('sorts members within a group by tier (used → likely → ghost) then name ASC', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-zzz', 'used', 1000, 1),
          makeMember('gsd-aaa', 'definite-ghost', 2000, 90),
          makeMember('gsd-mmm', 'likely-ghost', 1500, 45),
          makeMember('gsd-bbb', 'definite-ghost', 1800, 120),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      // Split off the drilldown table so we only inspect member rows.
      const drilldown = out.slice(out.indexOf('Framework members'));
      const idxZzz = drilldown.indexOf('gsd-zzz');
      const idxMmm = drilldown.indexOf('gsd-mmm');
      const idxAaa = drilldown.indexOf('gsd-aaa');
      const idxBbb = drilldown.indexOf('gsd-bbb');
      // used first
      expect(idxZzz).toBeGreaterThan(-1);
      expect(idxZzz).toBeLessThan(idxMmm);
      // likely next
      expect(idxMmm).toBeLessThan(idxAaa);
      // definite-ghost last, name ASC → aaa before bbb
      expect(idxAaa).toBeGreaterThan(-1);
      expect(idxBbb).toBeGreaterThan(idxAaa);
    });

    it('omits fully-used frameworks from the drilldown entirely', () => {
      const groups = [
        makeGroup('fully-used-fw', 'FullyUsedFW', [
          makeMember('fu-a', 'used', 1000, 1),
          makeMember('fu-b', 'used', 1000, 1),
        ]),
        makeGroup('ghosty', 'GhostyFW', [makeMember('gh-a', 'definite-ghost', 1000, 90)]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      // Roll-up table still lists FullyUsedFW.
      expect(out).toContain('FullyUsedFW');
      // Drilldown table omits FullyUsedFW (no member rows for it).
      const drilldown = out.slice(out.indexOf('Framework members'));
      expect(drilldown).not.toContain('fu-a');
      expect(drilldown).not.toContain('fu-b');
      expect(drilldown).toContain('gh-a');
    });

    it('skips emitting the drilldown table entirely when every framework is fully-used', () => {
      const groups = [
        makeGroup('fully', 'Fully', [
          makeMember('a', 'used', 1000, 1),
          makeMember('b', 'used', 1000, 1),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      expect(out).not.toContain('Framework members');
      // Only one bordered table (the roll-up).
      const topBorderCount = (out.match(/┌/g) ?? []).length;
      expect(topBorderCount).toBe(1);
    });

    it('prints the framework column only once per group (blank for repeats)', () => {
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-a', 'definite-ghost', 1000, 90),
          makeMember('gsd-b', 'definite-ghost', 1000, 90),
          makeMember('gsd-c', 'definite-ghost', 1000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      const drilldown = out.slice(out.indexOf('Framework members'));
      // "GSD" as the framework label appears on the first data row only.
      // The word "GSD" can still appear in member names, so we only guard
      // against double-printing the framework label by counting lines that
      // start with "│ GSD " (the framework column is the leftmost).
      const labelRowCount = (drilldown.match(/│ GSD\s/g) ?? []).length;
      expect(labelRowCount).toBe(1);
    });

    it('renders colored tier label cells for members', () => {
      delete process.env.NO_COLOR;
      colorModule.initColor();
      const groups = [
        makeGroup('gsd', 'GSD', [
          makeMember('gsd-a', 'used', 1000, 1),
          makeMember('gsd-b', 'likely-ghost', 1000, 45),
          makeMember('gsd-c', 'definite-ghost', 1000, 90),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      // Bracket-label form is always present (colors optional).
      expect(stripAnsi(out)).toContain('[ACTIVE]');
      expect(stripAnsi(out)).toContain('[LIKELY]');
      expect(stripAnsi(out)).toContain('[GHOST]');
    });
  });

  describe('renderFrameworksSection — heuristic marker', () => {
    beforeEach(() => {
      delete process.env.NO_COLOR;
      colorModule.initColor();
    });

    it('appends ~ suffix to displayName for heuristic framework', () => {
      const groups = [
        makeGroup('foo', 'Foo', [makeMember('foo-a', 'definite-ghost', 1000, 90)], 'heuristic'),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      // Strip ANSI to check the literal characters
      expect(stripAnsi(out)).toContain('Foo~');
    });

    it('does NOT append ~ for curated framework', () => {
      const groups = [makeGroup('gsd', 'GSD', [makeMember('gsd-a', 'definite-ghost', 1000, 90)])];
      const out = renderFrameworksSection(groups, { verbose: false });
      expect(stripAnsi(out)).not.toContain('GSD~');
    });

    it('carries the ~ suffix into the verbose member table', () => {
      const groups = [
        makeGroup(
          'foo',
          'Foo',
          [
            makeMember('foo-a', 'definite-ghost', 1000, 90),
            makeMember('foo-b', 'definite-ghost', 500, 80),
          ],
          'heuristic',
        ),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      const drilldown = out.slice(out.indexOf('Framework members'));
      expect(stripAnsi(drilldown)).toContain('Foo~');
      expect(stripAnsi(drilldown)).toContain('foo-a');
      expect(stripAnsi(drilldown)).toContain('foo-b');
    });

    // ── Regression: border integrity on heuristic rows (quick task 260411-x0r) ───
    //
    // Earlier revisions wrapped heuristic rows in `colorize.dim(row)` before
    // handing them to clampRow. clampRow compares raw byte length to the
    // terminal width, and the 9-byte `\x1b[2m`…`\x1b[22m` envelope pushed the
    // row over the width budget — the truncation branch then sliced off the
    // trailing '│' border and appended the closing 'm' of the SGR reset,
    // producing `~121 tokm` where `~121 tokens │` should have been. These
    // tests lock in the fix (drop the dim wrap; keep the '~' suffix only).
    describe('heuristic row border integrity at width 100', () => {
      const original = process.stdout.columns;

      beforeEach(() => {
        delete process.env.NO_COLOR;
        colorModule.initColor();
        (process.stdout as { columns: number }).columns = 100;
      });

      afterEach(() => {
        (process.stdout as { columns: number | undefined }).columns = original;
      });

      function makeHeuristicGroups(): FrameworkGroup[] {
        return [
          makeGroup(
            'foo',
            'Foo Heuristic Framework',
            [
              makeMember('foo-agent-a', 'definite-ghost', 121_000, 90),
              makeMember('foo-agent-b', 'definite-ghost', 84_000, 75),
              makeMember('foo-used', 'used', 1000, 1),
            ],
            'heuristic',
          ),
        ];
      }

      it('collapsed mode: every line starting with │ also ends with │', () => {
        const out = renderFrameworksSection(makeHeuristicGroups(), { verbose: false });
        const lines = out.split('\n');
        // Sanity: we actually produced rendered rows starting with '│'.
        const borderRowCount = lines.filter((l) => l.startsWith('│')).length;
        expect(borderRowCount).toBeGreaterThan(0);
        for (const line of lines) {
          if (line.startsWith('│')) {
            expect(line.endsWith('│')).toBe(true);
          }
        }
      });

      it('verbose mode: every line starting with │ also ends with │', () => {
        const out = renderFrameworksSection(makeHeuristicGroups(), { verbose: true });
        const lines = out.split('\n');
        const borderRowCount = lines.filter((l) => l.startsWith('│')).length;
        expect(borderRowCount).toBeGreaterThan(0);
        for (const line of lines) {
          if (line.startsWith('│')) {
            expect(line.endsWith('│')).toBe(true);
          }
        }
      });

      it('collapsed mode: contains zero \\x1b[2m (dim SGR) sequences on heuristic rows', () => {
        const out = renderFrameworksSection(makeHeuristicGroups(), { verbose: false });
        // eslint-disable-next-line no-control-regex
        expect(out).not.toMatch(/\u001b\[2m/);
      });

      it('verbose mode: contains zero \\x1b[2m (dim SGR) sequences on heuristic rows', () => {
        const out = renderFrameworksSection(makeHeuristicGroups(), { verbose: true });
        // eslint-disable-next-line no-control-regex
        expect(out).not.toMatch(/\u001b\[2m/);
      });
    });
  });

  describe('renderFrameworksSection — NO_COLOR fallback', () => {
    let prevNoColor: string | undefined;

    beforeEach(() => {
      prevNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = '1';
      colorModule.initColor();
    });

    afterEach(() => {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      colorModule.initColor();
    });

    it('still emits ~ suffix on heuristic displayName', () => {
      const groups = [
        makeGroup('foo', 'Foo', [makeMember('foo-a', 'definite-ghost', 1000, 90)], 'heuristic'),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      expect(out).toContain('Foo~');
    });

    it('contains zero ANSI escape sequences when NO_COLOR is set', () => {
      const groups = [
        makeGroup('foo', 'Foo', [makeMember('foo-a', 'definite-ghost', 1000, 90)], 'heuristic'),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      // eslint-disable-next-line no-control-regex
      expect(/\u001b\[/.test(out)).toBe(false);
    });
  });

  describe.each([80, 100, 120])('renderFrameworksSection — %d col width', (width) => {
    const original = process.stdout.columns;
    beforeEach(() => {
      (process.stdout as { columns: number }).columns = width;
    });
    afterEach(() => {
      (process.stdout as { columns: number | undefined }).columns = original;
    });

    it(`collapsed row visible length <= ${width}`, () => {
      const groups = [
        makeGroup('gsd', 'GSD (Get Shit Done) Long Name', [
          makeMember('gsd-a', 'definite-ghost', 208000, 90),
          makeMember('gsd-b', 'used', 1000, 1),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      for (const line of out.split('\n')) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    });

    it(`verbose member rows visible length <= ${width}`, () => {
      const groups = [
        makeGroup('gsd', 'GSD (Get Shit Done) Long Name', [
          makeMember('gsd-alpha-really-long-member-name', 'definite-ghost', 208000, 90),
          makeMember('gsd-b', 'used', 1000, 1),
        ]),
      ];
      const out = renderFrameworksSection(groups, { verbose: true });
      for (const line of out.split('\n')) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    });
  });

  describe('renderFrameworksSection — sort order is caller-determined', () => {
    it('emits frameworks in input order regardless of displayName', () => {
      const groups = [
        makeGroup('zzz', 'Zzz', [makeMember('zzz-a', 'definite-ghost', 1000, 90)]),
        makeGroup('aaa', 'Aaa', [makeMember('aaa-a', 'definite-ghost', 1000, 90)]),
      ];
      const out = renderFrameworksSection(groups, { verbose: false });
      const idxZzz = out.indexOf('Zzz');
      const idxAaa = out.indexOf('Aaa');
      expect(idxZzz).toBeLessThan(idxAaa);
    });
  });
}
