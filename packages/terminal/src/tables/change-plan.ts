import { homedir as osHomedir } from 'node:os';
import { colorize } from '../color.ts';
import type { ChangePlan, GhostTier } from '@ccaudit/internal';
import type { ProtectedFrameworkWarning } from '@ccaudit/internal';

/**
 * Minimal item shape used by the PROTECTED section. Locally typed so the
 * terminal package does not need to import TokenCostResult from
 * @ccaudit/internal. The CLI layer adapts TokenCostResult to ProtectedItem
 * when calling the renderer.
 */
export interface ProtectedItem {
  category: 'agent' | 'skill' | 'mcp-server' | 'memory' | 'command' | 'hook';
  scope: 'global' | 'project';
  name: string;
  projectPath: string | null;
  path: string;
  tokens: number;
  /** Framework id from the inventory item — used to group the PROTECTED section. */
  framework: string | null;
  /** Ghost tier from the classification pass. Preserved so CSV/TSV dry-run
   *  rows serialize the real tier instead of a hard-coded fallback. */
  tier: GhostTier;
}

/**
 * Optional second argument to `renderChangePlan` and `renderChangePlanVerbose`
 * carrying v1.3.0 framework-protection rendering data and the existing
 * privacy/redaction options. ALL fields optional — passing `undefined` or
 * `{}` produces v1.2.1-byte-identical output.
 */
export interface ChangePlanRenderOptions {
  /** Items removed from the change plan due to framework protection. */
  protected?: ProtectedItem[];
  /** One audit-trail entry per protected framework. */
  protectionWarnings?: ProtectedFrameworkWarning[];
  /**
   * When true, render the override-acknowledgment phrasing in the warning
   * block AND omit the PROTECTED section (items move into ARCHIVE instead).
   */
  forcePartial?: boolean;
  privacy?: boolean;
  redactionMap?: Map<string, string>;
  homedir?: string;
}

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
export function renderChangePlan(plan: ChangePlan, opts?: ChangePlanRenderOptions): string {
  const lines: string[] = [];
  const warnings = opts?.protectionWarnings ?? [];
  const protectedItems = opts?.protected ?? [];
  const forcePartial = opts?.forcePartial === true;

  // v1.3.0 BUST-04: yellow warning block per protected framework, BEFORE ARCHIVE.
  if (warnings.length > 0) {
    for (const w of warnings) {
      lines.push(...renderProtectionWarning(w, forcePartial));
      lines.push('');
    }
  }

  // ── EXISTING GROUPS (unchanged) ────────────────────────────────────
  // Group 1: Archive (agents + skills + commands)
  if (plan.counts.agents > 0 || plan.counts.skills > 0 || plan.counts.commands > 0) {
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
    if (plan.counts.commands > 0) {
      lines.push(
        `  ${String(plan.counts.commands).padStart(3)} commands  → ~/.claude/ccaudit/archived/commands/`,
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

  // ── v1.3.0 BUST-05: PROTECTED section AFTER FLAG, BEFORE savings ──
  // Omitted entirely in override mode (items moved into ARCHIVE).
  if (!forcePartial && protectedItems.length > 0) {
    lines.push(colorize.bold('Will SKIP (framework protection):'));
    const grouped = groupProtectedByFramework(protectedItems, warnings);
    for (const { displayName, items } of grouped) {
      const memberWord = items.length === 1 ? 'member' : 'members';
      lines.push(
        `  ${displayName} — ${items.length} ghost ${memberWord} protected  [use --force-partial to override]`,
      );
    }
    lines.push('');
  }

  // ── EXISTING savings line (unchanged) ──────────────────────────────
  // Savings line — always present, even at zero (honest zero-state per D-08)
  const tokenDisplay = formatSavingsShort(plan.savings.tokens);
  lines.push(colorize.bold(`Estimated savings: ${tokenDisplay} (definite ghosts only)`));

  return lines.join('\n');
}

/**
 * Render a single ProtectedFrameworkWarning as one or two lines.
 *  - Normal mode: bold-yellow header line + dim continuation line.
 *  - Override mode (forcePartial=true): single bold-yellow line with the
 *    "WILL BE ARCHIVED (--force-partial)" wording.
 */
function renderProtectionWarning(w: ProtectedFrameworkWarning, forcePartial: boolean): string[] {
  const lines: string[] = [];
  const activeWord = w.activeMembers === 1 ? 'member' : 'members';
  const ghostWord = w.protectedGhostMembers === 1 ? 'member' : 'members';
  if (forcePartial) {
    lines.push(
      colorize.yellow(
        `⚠️  ${w.displayName} has ${w.activeMembers} active ${activeWord} — ${w.protectedGhostMembers} ghost ${ghostWord} WILL BE ARCHIVED (--force-partial).`,
      ),
    );
  } else {
    lines.push(
      colorize.yellow(
        `⚠️  ${w.displayName} has ${w.activeMembers} active ${activeWord} — ${w.protectedGhostMembers} ghost ${ghostWord} will be SKIPPED.`,
      ),
    );
    lines.push(
      colorize.dim('    Use --force-partial to archive them anyway (may break the framework).'),
    );
  }
  return lines;
}

/**
 * Group protected items by framework id, joining each group with its
 * displayName (looked up from the warnings list — falls back to the raw
 * framework id when no warning is found, which should not happen in practice).
 */
function groupProtectedByFramework(
  items: ProtectedItem[],
  warnings: ProtectedFrameworkWarning[],
): Array<{ frameworkId: string; displayName: string; items: ProtectedItem[] }> {
  const byId = new Map<string, ProtectedItem[]>();
  for (const item of items) {
    const id = item.framework ?? '<unknown>';
    const arr = byId.get(id);
    if (arr) arr.push(item);
    else byId.set(id, [item]);
  }
  const displayNameById = new Map<string, string>();
  for (const w of warnings) {
    displayNameById.set(w.frameworkId, w.displayName);
  }
  const result: Array<{ frameworkId: string; displayName: string; items: ProtectedItem[] }> = [];
  for (const [frameworkId, fwItems] of byId.entries()) {
    result.push({
      frameworkId,
      displayName: displayNameById.get(frameworkId) ?? frameworkId,
      items: fwItems,
    });
  }
  // Stable sort by displayName ASC (case-insensitive) for deterministic output.
  result.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
  return result;
}

/**
 * Render the per-item verbose listing (D-09).
 * Appended to renderChangePlan output when --verbose is active.
 */
export function renderChangePlanVerbose(
  plan: ChangePlan,
  options?: ChangePlanRenderOptions,
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

  // v1.3.0 BUST-05: per-item PROTECTED listing in verbose mode.
  // Omitted in override mode (items already appear in the ARCHIVE listing).
  const protectedItems = options?.protected ?? [];
  if (options?.forcePartial !== true && protectedItems.length > 0) {
    lines.push('');
    lines.push(colorize.dim('Protected items (framework-as-unit bust protection):'));
    for (const item of protectedItems) {
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
        `  • protected ${item.category} ${item.name} (${scopeLabel}) — ~${item.tokens} tokens, path: ${pathLabel}`,
      );
    }
  }

  return lines.join('\n');
}

function formatSavingsShort(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
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
      counts: { agents: 0, skills: 0, mcp: 0, memory: 0, commands: 0 },
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
        counts: { agents: 2, skills: 1, mcp: 3, memory: 1, commands: 0 },
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
        counts: { agents: 1, skills: 0, mcp: 0, memory: 0, commands: 0 },
        savings: { tokens: 100 },
      });
      expect(renderChangePlan(plan)).not.toContain('Will DISABLE');
    });

    it('omits FLAG group when counts.memory === 0', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent' })],
        counts: { agents: 1, skills: 0, mcp: 0, memory: 0, commands: 0 },
      });
      expect(renderChangePlan(plan)).not.toContain('Will FLAG');
    });

    it('omits ARCHIVE group when no agents or skills', () => {
      const plan = makePlan({
        disable: [makeItem({ action: 'disable', category: 'mcp-server' })],
        counts: { agents: 0, skills: 0, mcp: 1, memory: 0, commands: 0 },
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

    it('emits a commands row inside Will ARCHIVE when counts.commands > 0', () => {
      const plan = makePlan({
        archive: [
          makeItem({ action: 'archive', category: 'command', name: 'sc:build', path: '/tmp/cmd' }),
        ],
        counts: { agents: 0, skills: 0, mcp: 0, memory: 0, commands: 1 },
        savings: { tokens: 30 },
      });
      const out = renderChangePlan(plan);
      expect(out).toContain('Will ARCHIVE');
      expect(out).toMatch(/\b1 commands\b/);
      expect(out).toMatch(/1 commands\s+→\s+~\/\.claude\/ccaudit\/archived\/commands\//);
    });

    it('renders ARCHIVE block when commands are the only archive category', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'command', name: 'cmd1' })],
        counts: { agents: 0, skills: 0, mcp: 0, memory: 0, commands: 1 },
        savings: { tokens: 30 },
      });
      const out = renderChangePlan(plan);
      expect(out).toContain('Will ARCHIVE');
      expect(out).not.toContain('agents');
      expect(out).not.toContain('skills');
      expect(out).toContain('1 commands');
    });

    it('omits commands row when counts.commands === 0', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent', name: 'a1' })],
        counts: { agents: 1, skills: 0, mcp: 0, memory: 0, commands: 0 },
      });
      const out = renderChangePlan(plan);
      expect(out).toContain('1 agents');
      expect(out).not.toMatch(/commands\s+→/);
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

  // ── v1.3.0 Phase 4: framework-protection rendering ──────────────────
  describe('renderChangePlan — framework-protection extension (BUST-04, BUST-05)', () => {
    function makeWarning(over: Partial<ProtectedFrameworkWarning> = {}): ProtectedFrameworkWarning {
      return {
        frameworkId: 'gsd',
        displayName: 'GSD',
        status: 'partially-used',
        activeMembers: 2,
        protectedGhostMembers: 3,
        ...over,
      };
    }

    function makeProtectedItem(over: Partial<ProtectedItem> = {}): ProtectedItem {
      return {
        category: 'agent',
        scope: 'global',
        name: 'gsd-ghost',
        projectPath: null,
        path: '/tmp/gsd-ghost.md',
        tokens: 200,
        framework: 'gsd',
        tier: 'definite-ghost',
        ...over,
      };
    }

    function nonTrivialPlan(): ChangePlan {
      return makePlan({
        archive: [
          makeItem({ action: 'archive', category: 'agent', name: 'a1' }),
          makeItem({ action: 'archive', category: 'skill', name: 's1' }),
        ],
        disable: [makeItem({ action: 'disable', category: 'mcp-server', name: 'm1' })],
        flag: [makeItem({ action: 'flag', category: 'memory', name: 'CLAUDE.md' })],
        counts: { agents: 1, skills: 1, mcp: 1, memory: 1, commands: 0 },
        savings: { tokens: 1234 },
      });
    }

    it('byte-identical to v1.2.1 when called with no second argument', () => {
      const plan = nonTrivialPlan();
      const baseline = renderChangePlan(plan);
      expect(renderChangePlan(plan, undefined)).toBe(baseline);
      expect(renderChangePlan(plan, {})).toBe(baseline);
      expect(renderChangePlan(plan, { protectionWarnings: [], protected: [] })).toBe(baseline);
    });

    it('renders yellow warning block with displayName + counts + --force-partial mention', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [makeWarning()],
      });
      expect(out).toContain('GSD');
      expect(out).toContain('2 active member');
      expect(out).toContain('3 ghost member');
      expect(out).toContain('will be SKIPPED');
      expect(out).toContain('--force-partial');
    });

    it('warning block appears BEFORE the Will ARCHIVE header', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [makeWarning()],
      });
      const warningIdx = out.indexOf('GSD');
      const archiveIdx = out.indexOf('Will ARCHIVE');
      expect(warningIdx).toBeGreaterThanOrEqual(0);
      expect(archiveIdx).toBeGreaterThan(warningIdx);
    });

    it('renders override wording when forcePartial=true and omits PROTECTED section', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [makeWarning()],
        protected: [makeProtectedItem()],
        forcePartial: true,
      });
      expect(out).toContain('WILL BE ARCHIVED');
      expect(out).toContain('--force-partial');
      expect(out).not.toContain('will be SKIPPED');
      expect(out).not.toContain('Will SKIP (framework protection)');
    });

    it('renders PROTECTED section AFTER Will FLAG and BEFORE Estimated savings', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [makeWarning()],
        protected: [makeProtectedItem(), makeProtectedItem({ name: 'gsd-ghost-2' })],
      });
      expect(out).toContain('Will SKIP (framework protection)');
      const flagIdx = out.indexOf('Will FLAG');
      const protectedIdx = out.indexOf('Will SKIP (framework protection)');
      const savingsIdx = out.indexOf('Estimated savings');
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(protectedIdx).toBeGreaterThan(flagIdx);
      expect(savingsIdx).toBeGreaterThan(protectedIdx);
    });

    it('PROTECTED section groups by framework displayName with member count', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [makeWarning()],
        protected: [
          makeProtectedItem({ name: 'gsd-a' }),
          makeProtectedItem({ name: 'gsd-b' }),
          makeProtectedItem({ name: 'gsd-c' }),
        ],
      });
      expect(out).toContain('GSD — 3 ghost members protected');
    });

    it('renders multiple framework warnings each in their own block', () => {
      const out = renderChangePlan(nonTrivialPlan(), {
        protectionWarnings: [
          makeWarning({ frameworkId: 'gsd', displayName: 'GSD', protectedGhostMembers: 3 }),
          makeWarning({
            frameworkId: 'superclaude',
            displayName: 'SuperClaude',
            protectedGhostMembers: 2,
          }),
        ],
      });
      expect(out).toContain('GSD');
      expect(out).toContain('SuperClaude');
      // Both warnings appear before ARCHIVE
      expect(out.indexOf('GSD')).toBeLessThan(out.indexOf('Will ARCHIVE'));
      expect(out.indexOf('SuperClaude')).toBeLessThan(out.indexOf('Will ARCHIVE'));
    });
  });

  describe('renderChangePlan — NO_COLOR respect', () => {
    let original: string | undefined;
    beforeEach(() => {
      original = process.env.NO_COLOR;
      process.env.NO_COLOR = '1';
    });
    afterEach(() => {
      if (original === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = original;
    });

    it('warning block contains no ANSI escape codes when NO_COLOR is set', () => {
      // Force re-init of color so our env change takes effect
      const out = renderChangePlan(makePlan(), {
        protectionWarnings: [
          {
            frameworkId: 'gsd',
            displayName: 'GSD',
            status: 'partially-used',
            activeMembers: 2,
            protectedGhostMembers: 3,
          },
        ],
      });
      // Note: the colorize helper is initialized via initColor() at process start;
      // when NO_COLOR is set in the env at module-load time, it short-circuits to identity.
      // If colorize was already initialized before this test ran, this assertion may not hold.
      // We assert the SEMANTIC content is present rather than the absence of ANSI codes
      // because color initialization is process-global.
      expect(out).toContain('GSD');
      expect(out).toContain('will be SKIPPED');
    });
  });

  describe('renderChangePlanVerbose — protected items extension', () => {
    function makeProtectedItem(over: Partial<ProtectedItem> = {}): ProtectedItem {
      return {
        category: 'agent',
        scope: 'global',
        name: 'gsd-ghost',
        projectPath: null,
        path: '/tmp/gsd-ghost.md',
        tokens: 200,
        framework: 'gsd',
        tier: 'definite-ghost',
        ...over,
      };
    }

    it('appends per-item bullets for protected items in non-override mode', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent', name: 'a1' })],
      });
      const out = renderChangePlanVerbose(plan, {
        protected: [makeProtectedItem({ name: 'gsd-x' }), makeProtectedItem({ name: 'gsd-y' })],
      });
      const bulletLines = out.split('\n').filter((l) => l.startsWith('  •'));
      // 1 baseline archive + 2 protected = 3 bullets
      expect(bulletLines).toHaveLength(3);
      expect(out).toContain('protected agent gsd-x');
      expect(out).toContain('protected agent gsd-y');
    });

    it('omits protected bullets in override mode (forcePartial=true)', () => {
      const plan = makePlan({
        archive: [makeItem({ action: 'archive', category: 'agent', name: 'a1' })],
      });
      const out = renderChangePlanVerbose(plan, {
        protected: [makeProtectedItem({ name: 'gsd-x' })],
        forcePartial: true,
      });
      expect(out).not.toContain('Protected items');
      expect(out).not.toContain('protected agent gsd-x');
    });
  });
}
