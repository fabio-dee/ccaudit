import { colorize } from '../color.ts';
import type { CategorySummary, ProjectGhostSummary, TokenCostResult } from '@ccaudit/internal';
import { formatTokenEstimate } from '@ccaudit/internal';

/**
 * Category display names for the summary table.
 * Order: agents, skills, mcp-server, memory -- matching the handoff mockup.
 */
const CATEGORY_DISPLAY: Record<string, string> = {
  agent: 'Agents',
  skill: 'Skills',
  'mcp-server': 'MCP Servers',
  memory: 'Memory Files',
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
export function renderGhostSummary(summaries: CategorySummary[]): string {
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

    lines.push(`${catName} ${label1} ${val1}   ${label2} ${val2}   ${label3} ${val3}   ${tokenStr}`);
  }

  return lines.join('\n');
}

/**
 * Render the top-N ghosts by token cost as a numbered plain-text list.
 * Per D-03 and D-10.
 *
 * Format:
 *   \u{1F6A8} Top ghosts by token cost:
 *     1. my-agent       ~15k tokens  (agent, 45d ago)
 *     2. unused-skill   ~8k tokens   (skill, never)
 *
 * Returns empty string if ghosts array is empty.
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
  const lines: string[] = [];

  lines.push(colorize.bold('\u{1F6A8} Top global ghosts by token cost:'));

  for (let i = 0; i < top.length; i++) {
    const g = top[i]!;
    const num = `${i + 1}.`;
    const tokenDisplay = formatTokenEstimate(g.tokenEstimate);
    const category = g.item.category;
    const lastUsed = formatLastUsed(g.lastUsed);

    lines.push(`  ${num} ${g.item.name}       ${tokenDisplay}  (${category}, ${lastUsed})`);
  }

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
  const hint1 = colorize.dim('See per-item details: ccaudit inventory');
  if (options?.dryRunActive) {
    return hint1;
  }
  const hint2 = colorize.dim('Ready to clean up? ccaudit ghost --dry-run');
  return `${hint1}\n${hint2}`;
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
 * Render the global baseline section — items that load in every session,
 * regardless of project context.
 *
 * Format:
 *   🌐 Global Baseline (loads every session):
 *
 *     Ghosts:  38    Session Cost: ~45k tokens
 */
export function renderGlobalBaseline(global: ProjectGhostSummary): string {
  const lines: string[] = [];
  lines.push(colorize.bold('\u{1F310} Global Baseline (loads every session):'));
  lines.push('');
  const ghosts = String(global.ghostCount).padStart(3);
  const cost = formatTokensShortPlain(global.totalTokens);
  lines.push(`  Ghosts: ${ghosts}    Session Cost: ${cost}`);
  return lines.join('\n');
}

/**
 * Render a ranked projects table showing ghost overhead by project.
 * Top-N projects follow, sorted by token cost. Each row shows the combined
 * cost (global baseline + project-specific overhead).
 *
 * Format:
 *   🏗️  Per-Project Overhead (added on top of global):
 *
 *     Scope              Ghosts    Session Cost
 *     ~/repos/nexus          55    ~48k tokens
 *     ... and 11 more projects
 */
export function renderProjectsTable(
  global: ProjectGhostSummary,
  projects: ProjectGhostSummary[],
  topN: number = 5,
): string {
  const lines: string[] = [];
  lines.push(colorize.bold('\u{1F3D7}\uFE0F  Per-Project Overhead (added on top of global):'));
  lines.push('');

  const header = '  ' + 'Scope'.padEnd(32) + 'Ghosts'.padStart(7) + '    Session Cost';
  lines.push(header);

  // Top-N project rows — each shows total session cost (global + project)
  const shown = projects.slice(0, topN);
  for (const proj of shown) {
    lines.push(formatProjectRow({
      ...proj,
      totalTokens: global.totalTokens + proj.totalTokens,
      ghostCount: global.ghostCount + proj.ghostCount,
    }));
  }

  // Overflow line
  const remaining = projects.length - shown.length;
  if (remaining > 0) {
    lines.push(`  ... and ${remaining} more project${remaining === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}

function formatProjectRow(summary: ProjectGhostSummary): string {
  const scope = summary.displayPath.padEnd(32);
  const ghosts = String(summary.ghostCount).padStart(7);
  const cost = formatTokensShortPlain(summary.totalTokens).padStart(14);
  return `  ${scope}${ghosts}    ${cost}`;
}

/**
 * Render full per-project ghost item lists for verbose mode.
 * Global section first, then projects sorted by total token cost.
 *
 * Format:
 *   📁 (global)  (~45k tokens, 38 ghosts)
 *      nexus-strategy [global]      ~14k tokens  (never)
 *      ...
 *
 *   📁 ~/repos/nexus  (~48k tokens, 55 ghosts)
 *      nexus-strategy [project]     ~14k tokens  (never)
 *      ... 52 more (run ccaudit inventory for full list)
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

  const sections: string[] = [];

  const allSections = [global, ...projects];
  for (const summary of allSections) {
    const isGlobal = summary.projectPath === null;
    const tokenStr = formatTokensShortPlain(summary.totalTokens);
    const header = `\u{1F4C1} ${summary.displayPath}  (~${tokenStr.replace('~', '')}, ${summary.ghostCount} ghost${summary.ghostCount === 1 ? '' : 's'})`;
    const sectionLines: string[] = [colorize.bold(header)];

    const shown = summary.items.slice(0, maxItemsPerProject);
    for (const item of shown) {
      let label = item.item.name;
      if (crossScopeNames.has(label)) {
        label = isGlobal ? `${label} [global]` : `${label} [project]`;
      }
      const truncated = label.length > 34 ? label.slice(0, 31) + '...' : label;
      const tokenCol = formatTokenEstimate(item.tokenEstimate).padStart(18);
      const lastUsed = formatLastUsed(item.lastUsed);
      sectionLines.push(`   ${truncated.padEnd(34)} ${tokenCol}  (${lastUsed})`);
    }

    const overflow = summary.items.length - shown.length;
    if (overflow > 0) {
      sectionLines.push(`   ... ${overflow} more`);
    }

    sections.push(sectionLines.join('\n'));
  }

  return sections.join('\n\n');
}

/** Format token count as ~Xk or ~X without confidence suffix. */
function formatTokensShortPlain(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
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
      const ghosts = Array.from({ length: 7 }, (_, i) =>
        makeGhost(`ghost-${i}`, (i + 1) * 1000),
      );
      const result = renderTopGhosts(ghosts);
      // Header line + 5 items = 6 lines
      const lines = result.split('\n');
      expect(lines).toHaveLength(6);
    });

    it('returns empty string for empty array', () => {
      const result = renderTopGhosts([]);
      expect(result).toBe('');
    });

    it('items are sorted by token cost descending', () => {
      const ghosts = [
        makeGhost('low', 1000),
        makeGhost('high', 10000),
        makeGhost('mid', 5000),
      ];
      const result = renderTopGhosts(ghosts);
      const lines = result.split('\n').slice(1); // Skip header
      expect(lines[0]).toContain('high');
      expect(lines[1]).toContain('mid');
      expect(lines[2]).toContain('low');
    });

    it('contains the top global ghosts section header', () => {
      const ghosts = [makeGhost('test', 5000)];
      const result = renderTopGhosts(ghosts);
      expect(result).toContain('Top global ghosts by token cost:');
    });

    it('excludes project-scope items from top list', () => {
      const globalGhost = makeGhost('global-one', 100);
      const projectGhost: TokenCostResult = {
        item: { name: 'project-big', path: '/test/project-big', scope: 'project', category: 'agent', projectPath: '/repo/a' },
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
        item: { name: 'proj-only', path: '/test/proj-only', scope: 'project', category: 'agent', projectPath: '/repo/a' },
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
      const projects = Array.from({ length: 8 }, (_, i) =>
        makeSummary(`~/repo-${i}`, 1, 1000),
      );
      const result = renderProjectsTable(global, projects, 3);
      expect(result).toContain('~/repo-0');
      expect(result).toContain('~/repo-2');
      expect(result).not.toContain('~/repo-3');
      expect(result).toContain('and 5 more projects');
    });

    it('shows singular "project" when 1 remaining', () => {
      const global = makeSummary('(global)', 0, 0);
      const projects = Array.from({ length: 6 }, (_, i) =>
        makeSummary(`~/repo-${i}`, 1, 1000),
      );
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
  });

  describe('renderProjectsVerbose', () => {
    function makeItem(
      name: string,
      tokens: number,
      scope: 'global' | 'project',
    ): TokenCostResult {
      return {
        item: { name, path: `/test/${name}`, scope, category: 'agent', projectPath: scope === 'project' ? '/repo/a' : null },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens, confidence: 'estimated', source: 'test' },
      };
    }

    it('renders global section first', () => {
      const global: ProjectGhostSummary = {
        projectPath: null, displayPath: '(global)', totalTokens: 5000, ghostCount: 1,
        items: [makeItem('g-agent', 5000, 'global')],
      };
      const projects: ProjectGhostSummary[] = [{
        projectPath: '/repo/a', displayPath: '~/repo/a', totalTokens: 3000, ghostCount: 1,
        items: [makeItem('p-agent', 3000, 'project')],
      }];
      const result = renderProjectsVerbose(global, projects);
      const globalIdx = result.indexOf('(global)');
      const projIdx = result.indexOf('~/repo/a');
      expect(globalIdx).toBeLessThan(projIdx);
    });

    it('adds [global] and [project] labels for cross-scope names', () => {
      const sharedName = 'shared-agent';
      const global: ProjectGhostSummary = {
        projectPath: null, displayPath: '(global)', totalTokens: 5000, ghostCount: 1,
        items: [makeItem(sharedName, 5000, 'global')],
      };
      const projects: ProjectGhostSummary[] = [{
        projectPath: '/repo/a', displayPath: '~/repo/a', totalTokens: 3000, ghostCount: 1,
        items: [makeItem(sharedName, 3000, 'project')],
      }];
      const result = renderProjectsVerbose(global, projects);
      expect(result).toContain(`${sharedName} [global]`);
      expect(result).toContain(`${sharedName} [project]`);
    });

    it('truncates long item lists with overflow message', () => {
      const items = Array.from({ length: 15 }, (_, i) => makeItem(`agent-${i}`, 100, 'global'));
      const global: ProjectGhostSummary = {
        projectPath: null, displayPath: '(global)', totalTokens: 1500, ghostCount: 15,
        items,
      };
      const result = renderProjectsVerbose(global, [], 5);
      expect(result).toContain('... 10 more');
    });
  });

  describe('renderGhostFooter', () => {
    it('contains inventory hint', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('See per-item details: ccaudit inventory');
    });

    it('contains dry-run hint', () => {
      const result = renderGhostFooter('7 days');
      expect(result).toContain('ccaudit ghost --dry-run');
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
}
