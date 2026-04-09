import { homedir as osHomedir } from 'node:os';
import { colorize } from '../color.ts';
import type { ChangePlan } from '@ccaudit/internal';

/**
 * Render the change plan as grouped-by-action plain text (D-06).
 * Matches the handoff mockup in docs/ccaudit-handoff-v6.md:127-143.
 *
 * Header (👻 Dry-Run — Last 7 days) is emitted by the caller via
 * renderHeader(). Footer (Checkpoint: ... / Next: ...) is also the
 * caller's responsibility because it depends on @ccaudit/internal's
 * resolveCheckpointPath() — passing the path through the renderer
 * would unnecessarily couple the packages.
 */
export function renderChangePlan(plan: ChangePlan): string {
  const lines: string[] = [];

  // Group 1: Archive (agents + skills)
  if (plan.counts.agents > 0 || plan.counts.skills > 0) {
    lines.push(colorize.bold('Will ARCHIVE (reversible via `ccaudit restore <name>`):'));
    if (plan.counts.agents > 0) {
      lines.push(
        `  ${String(plan.counts.agents).padStart(3)} agents  → ~/.claude/ccaudit/archived/agents/`,
      );
    }
    if (plan.counts.skills > 0) {
      lines.push(
        `  ${String(plan.counts.skills).padStart(3)} skills  → ~/.claude/ccaudit/archived/skills/`,
      );
    }
    lines.push('');
  }

  // Group 2: Disable (MCP servers)
  if (plan.counts.mcp > 0) {
    lines.push(colorize.bold('Will DISABLE in ~/.claude.json (key-rename, JSON-valid):'));
    lines.push(
      `  ${String(plan.counts.mcp).padStart(3)} MCP servers  (moved to \`ccaudit-disabled:<name>\` key)`,
    );
    lines.push('');
  }

  // Group 3: Flag (memory files)
  if (plan.counts.memory > 0) {
    lines.push(
      colorize.bold('Will FLAG in memory files (ccaudit-stale: true frontmatter, still load):'),
    );
    lines.push(`  ${String(plan.counts.memory).padStart(3)} stale files`);
    lines.push('');
  }

  // Savings line — always present, even at zero (honest zero-state per D-08)
  const tokenDisplay = formatSavingsShort(plan.savings.tokens);
  lines.push(colorize.bold(`Estimated savings: ${tokenDisplay} (definite ghosts only)`));

  return lines.join('\n');
}

/**
 * Render the per-item verbose listing (D-09).
 * Appended to renderChangePlan output when --verbose is active.
 */
export function renderChangePlanVerbose(
  plan: ChangePlan,
  options?: {
    privacy?: boolean;
    redactionMap?: Map<string, string>;
    homedir?: string;
  },
): string {
  const lines: string[] = [];
  const home = options?.homedir ?? osHomedir();
  lines.push(colorize.dim('Per-item listing:'));
  for (const item of [...plan.archive, ...plan.disable, ...plan.flag]) {
    let scopeLabel: string;
    let pathLabel: string;

    if (options?.privacy && options.redactionMap) {
      const synthetic = item.projectPath
        ? (options.redactionMap.get(item.projectPath) ?? null)
        : null;
      scopeLabel = item.scope === 'project' && synthetic ? `project:${synthetic}` : 'global';
      pathLabel =
        item.projectPath && synthetic
          ? item.path.replace(item.projectPath, synthetic)
          : item.path.replace(home, '~');
    } else {
      scopeLabel =
        item.scope === 'project' && item.projectPath ? `project:${item.projectPath}` : 'global';
      pathLabel = item.path;
    }

    lines.push(
      `  • ${item.action} ${item.category} ${item.name} (${scopeLabel}) — ~${item.tokens} tokens, path: ${pathLabel}`,
    );
  }
  return lines.join('\n');
}

function formatSavingsShort(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  type Item = ChangePlan['archive'][number];

  function makeItem(over: Partial<Item> & Pick<Item, 'action' | 'category'>): Item {
    return {
      scope: 'global',
      name: `${over.category}-test`,
      projectPath: null,
      path: `/tmp/${over.category}-test`,
      tokens: 100,
      tier: 'definite-ghost',
      ...over,
    };
  }

  function makePlan(parts: Partial<ChangePlan> = {}): ChangePlan {
    return {
      archive: [],
      disable: [],
      flag: [],
      counts: { agents: 0, skills: 0, mcp: 0, memory: 0 },
      savings: { tokens: 0 },
      ...parts,
    };
  }

  describe('renderChangePlan', () => {
    it('produces grouped-by-action layout matching D-06', () => {
      const plan = makePlan({
        archive: [
          makeItem({ action: 'archive', category: 'agent', name: 'a1' }),
          makeItem({ action: 'archive', category: 'agent', name: 'a2' }),
          makeItem({ action: 'archive', category: 'skill', name: 's1' }),
        ],
        disable: [
          makeItem({ action: 'disable', category: 'mcp-server', name: 'm1' }),
          makeItem({ action: 'disable', category: 'mcp-server', name: 'm2' }),
          makeItem({ action: 'disable', category: 'mcp-server', name: 'm3' }),
        ],
        flag: [makeItem({ action: 'flag', category: 'memory', name: 'CLAUDE.md' })],
        counts: { agents: 2, skills: 1, mcp: 3, memory: 1 },
        savings: { tokens: 94000 },
      });
      const out = renderChangePlan(plan);
      expect(out).toContain('Will ARCHIVE');
      expect(out).toContain('Will DISABLE');
      expect(out).toContain('Will FLAG');
      expect(out).toContain('Estimated savings: ~94k tokens (definite ghosts only)');
      expect(out).toContain('  2 agents');
      expect(out).toContain('  1 skills');
      expect(out).toContain('  3 MCP servers');
      expect(out).toContain('  1 stale files');
    });

    it('omits DISABLE group when counts.mcp === 0', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent' })],
        counts: { agents: 1, skills: 0, mcp: 0, memory: 0 },
        savings: { tokens: 100 },
      });
      expect(renderChangePlan(plan)).not.toContain('Will DISABLE');
    });

    it('omits FLAG group when counts.memory === 0', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent' })],
        counts: { agents: 1, skills: 0, mcp: 0, memory: 0 },
      });
      expect(renderChangePlan(plan)).not.toContain('Will FLAG');
    });

    it('omits ARCHIVE group when no agents or skills', () => {
      const plan = makePlan({
        disable: [makeItem({ action: 'disable', category: 'mcp-server' })],
        counts: { agents: 0, skills: 0, mcp: 1, memory: 0 },
      });
      expect(renderChangePlan(plan)).not.toContain('Will ARCHIVE');
    });

    it('always emits Estimated savings line even when savings=0', () => {
      const out = renderChangePlan(makePlan());
      expect(out).toContain('Estimated savings:');
      expect(out).toContain('definite ghosts only');
    });

    it('formats savings as ~Xk tokens for >=10000', () => {
      const out = renderChangePlan(makePlan({ savings: { tokens: 94000 } }));
      expect(out).toContain('~94k tokens');
    });

    it('formats savings as ~X.Xk tokens for 1000-9999', () => {
      const out = renderChangePlan(makePlan({ savings: { tokens: 2500 } }));
      expect(out).toContain('~2.5k tokens');
    });

    it('formats savings as ~X tokens for <1000', () => {
      const out = renderChangePlan(makePlan({ savings: { tokens: 500 } }));
      expect(out).toContain('~500 tokens');
    });
  });

  describe('renderChangePlanVerbose', () => {
    it('appends one line per item across all three tiers', () => {
      const plan = makePlan({
        archive: [
          makeItem({ action: 'archive', category: 'agent', name: 'a1' }),
          makeItem({ action: 'archive', category: 'skill', name: 's1' }),
        ],
        disable: [makeItem({ action: 'disable', category: 'mcp-server', name: 'm1' })],
        flag: [makeItem({ action: 'flag', category: 'memory', name: 'CLAUDE.md' })],
      });
      const out = renderChangePlanVerbose(plan);
      const bulletLines = out.split('\n').filter((l) => l.startsWith('  •'));
      expect(bulletLines).toHaveLength(4);
    });

    it('includes action, category, name, scope, tokens, path on each line', () => {
      const plan = makePlan({
        archive: [
          makeItem({
            action: 'archive',
            category: 'agent',
            name: 'reviewer',
            tokens: 420,
            path: '/x/y.md',
          }),
        ],
      });
      const out = renderChangePlanVerbose(plan);
      expect(out).toMatch(/• archive agent reviewer \(global\) — ~420 tokens, path: \/x\/y\.md/);
    });

    it('formats project-scoped items as project:<path>', () => {
      const plan = makePlan({
        archive: [
          makeItem({
            action: 'archive',
            category: 'agent',
            name: 'proj-agent',
            scope: 'project',
            projectPath: '/Users/f/p1',
            path: '/Users/f/p1/.claude/agents/proj-agent.md',
          }),
        ],
      });
      expect(renderChangePlanVerbose(plan)).toContain('project:/Users/f/p1');
    });

    it('redacts project-scoped items with synthetic labels when privacy is enabled', () => {
      const plan = makePlan({
        archive: [
          makeItem({
            action: 'archive',
            category: 'agent',
            name: 'proj-agent',
            scope: 'project',
            projectPath: '/Users/f/work/p1',
            path: '/Users/f/work/p1/.claude/agents/proj-agent.md',
          }),
        ],
      });
      const out = renderChangePlanVerbose(plan, {
        privacy: true,
        redactionMap: new Map([['/Users/f/work/p1', '~/projects/project-01']]),
        homedir: '/Users/f',
      });
      expect(out).toContain('project:~/projects/project-01');
      expect(out).toContain('path: ~/projects/project-01/.claude/agents/proj-agent.md');
    });

    it('redacts global item paths to ~ when privacy is enabled', () => {
      const plan = makePlan({
        flag: [
          makeItem({
            action: 'flag',
            category: 'memory',
            name: 'CLAUDE.md',
            path: '/Users/f/.claude/CLAUDE.md',
          }),
        ],
      });
      const out = renderChangePlanVerbose(plan, {
        privacy: true,
        redactionMap: new Map(),
        homedir: '/Users/f',
      });
      expect(out).toContain('path: ~/.claude/CLAUDE.md');
    });
  });
}
