/**
 * groupMultiselect wrapper for the interactive ghost picker (D-02, D-09..D-13).
 *
 * Wraps @clack/prompts.groupMultiselect to produce a tagged-union outcome.
 * Empty inventory short-circuits without opening any prompt (D-13).
 * Cancellation (Ctrl+C / Esc / q) returns { kind: 'cancel' }.
 * Successful selection returns a Set<string> of canonicalItemId strings
 * ready for runBust (Phase 1 plumbing).
 *
 * v0.5 keybinds: Space/Enter/q/Esc/Ctrl-C only (groupMultiselect native).
 * Phase 5 will add: group collapse (g/G), filter (/), sort (s), help (?).
 */
import { groupMultiselect, isCancel } from '@clack/prompts';
import { canonicalItemId } from '@ccaudit/internal';
import type { TokenCostResult } from '@ccaudit/internal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SelectGhostsOutcome =
  | { kind: 'selected'; ids: Set<string> }
  | { kind: 'cancel' }
  | { kind: 'empty-inventory' };

export interface SelectGhostsInput {
  /** Items already filtered to ghost tier by caller. */
  ghosts: readonly TokenCostResult[];
  /** Injected for testability — defaults to Date.now() at call site. */
  now?: number;
  /** From shouldUseAscii() at CLI entry. */
  useAscii: boolean;
  /**
   * Optional clack dependency injection for tests.
   * In production the real @clack/prompts functions are used.
   */
  _clack?: {
    groupMultiselect: typeof groupMultiselect;
    isCancel: typeof isCancel;
  };
}

// ---------------------------------------------------------------------------
// Category label mapping (D-09 — stable order matches design doc §5.2)
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['agent', 'skill', 'mcp-server', 'memory', 'command', 'hook'] as const;

const CATEGORY_LABEL: Record<string, string> = {
  agent: 'AGENTS',
  skill: 'SKILLS',
  'mcp-server': 'MCP SERVERS',
  memory: 'MEMORY',
  command: 'COMMANDS',
  hook: 'HOOKS',
};

// ---------------------------------------------------------------------------
// Label formatting
// ---------------------------------------------------------------------------

/** Truncate a path to at most 40 chars with trailing ellipsis. */
function truncatePath(p: string): string {
  if (p.length <= 40) return p;
  return `${p.slice(0, 39)}…`;
}

/**
 * Format the label shown for a single ghost row.
 *
 * Format: `[glyph] <name>  <tokens> tok  <path>  [warning]`
 *
 * For memory items: glyph is [~] (recent ≤60d) or [≈] (stale >60d).
 * Under useAscii=true: [r] / [s] respectively.
 * Warning ⚠ (or ! for ascii) if item.item.referencedConfigs?.length > 1 (Phase 6 stub).
 */
export function formatRowLabel(item: TokenCostResult, useAscii: boolean, now: number): string {
  const { name, category, path, framework } = item.item;
  const tokens = item.tokenEstimate?.tokens ?? 0;
  const tokenStr = `${tokens} tok`;

  // Memory staleness glyph (D-14, D-15)
  let glyph = '';
  if (category === 'memory' && item.item.mtimeMs !== undefined) {
    const ageDays = (now - item.item.mtimeMs) / 86_400_000;
    const isStale = ageDays > 60;
    if (useAscii) {
      glyph = isStale ? '[s] ' : '[r] ';
    } else {
      glyph = isStale ? '[≈] ' : '[~] ';
    }
  }

  // Framework prefix if set (D-09 v0.5 simplification)
  const frameworkPrefix = framework ? `{${framework}} ` : '';

  // Path display (truncated)
  const pathDisplay = path ? truncatePath(path) : '';

  // Warning stub (Phase 6 populates referencedConfigs; Phase 2 just passes through)
  const referencedConfigs = (item.item as { referencedConfigs?: string[] }).referencedConfigs;
  const warn =
    referencedConfigs && referencedConfigs.length > 1 ? (useAscii ? ' !' : ' ⚠') : '';

  return `${glyph}${frameworkPrefix}${name}  ${tokenStr}  ${pathDisplay}${warn}`.trim();
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Opens the groupMultiselect picker for the provided ghost items.
 *
 * Returns:
 *  - { kind: 'empty-inventory' }  if ghosts.length === 0 (no prompt opened)
 *  - { kind: 'cancel' }           if user pressed Ctrl+C / Esc / q
 *  - { kind: 'selected', ids }    on Enter with 0..N items selected
 */
export async function selectGhosts(input: SelectGhostsInput): Promise<SelectGhostsOutcome> {
  const { ghosts, now: nowParam, useAscii, _clack } = input;
  const now = nowParam ?? Date.now();

  // D-13: Empty state — caller should skip picker
  if (ghosts.length === 0) {
    return { kind: 'empty-inventory' };
  }

  // Build grouped options
  const grouped: Record<string, TokenCostResult[]> = {};
  for (const cat of CATEGORY_ORDER) {
    grouped[cat] = [];
  }
  for (const g of ghosts) {
    const cat = g.item.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(g);
  }

  // D-12: Sort within each category by tokens desc
  for (const cat of CATEGORY_ORDER) {
    grouped[cat].sort(
      (a, b) => (b.tokenEstimate?.tokens ?? 0) - (a.tokenEstimate?.tokens ?? 0),
    );
  }

  // Build @clack/prompts options object (only include non-empty categories)
  const options: Record<string, Array<{ value: string; label: string }>> = {};
  for (const cat of CATEGORY_ORDER) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    const label = CATEGORY_LABEL[cat] ?? cat.toUpperCase();
    options[label] = items.map((item) => ({
      value: canonicalItemId(item.item),
      label: formatRowLabel(item, useAscii, now),
    }));
  }

  // Use injected or real clack
  const clack = _clack ?? { groupMultiselect, isCancel };

  const result = await clack.groupMultiselect({
    message: 'Select ghosts to archive:',
    options,
    required: false,
  });

  if (clack.isCancel(result)) {
    return { kind: 'cancel' };
  }

  return { kind: 'selected', ids: new Set(result as string[]) };
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  /** Build a minimal TokenCostResult for testing. */
  function makeGhost(overrides: {
    name: string;
    category?: string;
    path?: string;
    tokens?: number;
    mtimeMs?: number;
    framework?: string | null;
  }): TokenCostResult {
    return {
      item: {
        name: overrides.name,
        category: (overrides.category ?? 'agent') as TokenCostResult['item']['category'],
        scope: 'global',
        projectPath: null,
        path: overrides.path ?? `/fake/${overrides.name}`,
        ...(overrides.mtimeMs !== undefined ? { mtimeMs: overrides.mtimeMs } : {}),
        ...(overrides.framework !== undefined ? { framework: overrides.framework } : {}),
      },
      tier: 'definite-ghost',
      lastUsed: null,
      invocationCount: 0,
      tokenEstimate:
        overrides.tokens !== undefined
          ? { tokens: overrides.tokens, confidence: 'estimated', source: 'test' }
          : null,
    };
  }

  /** Make a fake @clack/prompts dependency. */
  function makeClack(returnValue: string[] | symbol) {
    const fakeCancelSymbol = Symbol('clack-cancel');
    return {
      groupMultiselect: vi.fn().mockResolvedValue(
        returnValue === fakeCancelSymbol ? fakeCancelSymbol : returnValue,
      ),
      isCancel: vi.fn((v: unknown) => v === fakeCancelSymbol),
      fakeCancelSymbol,
    };
  }

  describe('selectGhosts', () => {
    it('returns empty-inventory when ghosts array is empty (groupMultiselect NOT called)', async () => {
      const clackFns = makeClack([]);
      const result = await selectGhosts({
        ghosts: [],
        useAscii: false,
        _clack: clackFns,
      });
      expect(result.kind).toBe('empty-inventory');
      expect(clackFns.groupMultiselect).not.toHaveBeenCalled();
    });

    it('option values are canonicalItemId strings', async () => {
      const ghost1 = makeGhost({ name: 'my-agent', category: 'agent', path: '/a/my-agent.md', tokens: 100 });
      const ghost2 = makeGhost({ name: 'my-skill', category: 'skill', path: '/s/my-skill', tokens: 200 });

      const clackFns = makeClack(['agent|global||/a/my-agent.md', 'skill|global||/s/my-skill']);
      const result = await selectGhosts({
        ghosts: [ghost1, ghost2],
        useAscii: false,
        _clack: clackFns,
      });
      expect(result.kind).toBe('selected');
      if (result.kind === 'selected') {
        expect(result.ids.has('agent|global||/a/my-agent.md')).toBe(true);
        expect(result.ids.has('skill|global||/s/my-skill')).toBe(true);
      }
    });

    it('sorts items by tokens desc within category', async () => {
      const low = makeGhost({ name: 'low', category: 'agent', tokens: 100 });
      const high = makeGhost({ name: 'high', category: 'agent', tokens: 900 });
      const mid = makeGhost({ name: 'mid', category: 'agent', tokens: 500 });

      let capturedOptions: Record<string, Array<{ value: string; label: string }>> = {};
      const clack = {
        groupMultiselect: vi.fn((args: { message: string; options: typeof capturedOptions }) => {
          capturedOptions = args.options;
          return Promise.resolve([]);
        }),
        isCancel: vi.fn(() => false),
      };

      await selectGhosts({ ghosts: [low, high, mid], useAscii: false, _clack: clack });

      const agentOptions = capturedOptions['AGENTS'];
      expect(agentOptions).toBeDefined();
      // Should be sorted high(900) > mid(500) > low(100)
      expect(agentOptions[0].label).toContain('high');
      expect(agentOptions[1].label).toContain('mid');
      expect(agentOptions[2].label).toContain('low');
    });

    it('memory item renders [~] glyph when age ≤ 60 days (recent)', async () => {
      const now = Date.now();
      const recentMtime = now - 30 * 86_400_000; // 30 days ago
      const ghost = makeGhost({ name: 'CLAUDE.md', category: 'memory', mtimeMs: recentMtime, tokens: 50 });

      let capturedOptions: Record<string, Array<{ value: string; label: string }>> = {};
      const clack = {
        groupMultiselect: vi.fn((args: { message: string; options: typeof capturedOptions }) => {
          capturedOptions = args.options;
          return Promise.resolve([]);
        }),
        isCancel: vi.fn(() => false),
      };

      await selectGhosts({ ghosts: [ghost], useAscii: false, now, _clack: clack });

      const memOptions = capturedOptions['MEMORY'];
      expect(memOptions[0].label).toContain('[~]');
    });

    it('memory item renders [≈] glyph when age > 60 days (stale)', async () => {
      const now = Date.now();
      const staleMtime = now - 90 * 86_400_000; // 90 days ago
      const ghost = makeGhost({ name: 'old.md', category: 'memory', mtimeMs: staleMtime, tokens: 50 });

      let capturedOptions: Record<string, Array<{ value: string; label: string }>> = {};
      const clack = {
        groupMultiselect: vi.fn((args: { message: string; options: typeof capturedOptions }) => {
          capturedOptions = args.options;
          return Promise.resolve([]);
        }),
        isCancel: vi.fn(() => false),
      };

      await selectGhosts({ ghosts: [ghost], useAscii: false, now, _clack: clack });

      const memOptions = capturedOptions['MEMORY'];
      expect(memOptions[0].label).toContain('[≈]');
    });

    it('useAscii=true swaps [~] → [r] and [≈] → [s]', async () => {
      const now = Date.now();
      const recentMtime = now - 30 * 86_400_000;
      const staleMtime = now - 90 * 86_400_000;
      const recent = makeGhost({ name: 'recent.md', category: 'memory', mtimeMs: recentMtime, tokens: 100 });
      const stale = makeGhost({ name: 'stale.md', category: 'memory', mtimeMs: staleMtime, tokens: 50 });

      let capturedOptions: Record<string, Array<{ value: string; label: string }>> = {};
      const clack = {
        groupMultiselect: vi.fn((args: { message: string; options: typeof capturedOptions }) => {
          capturedOptions = args.options;
          return Promise.resolve([]);
        }),
        isCancel: vi.fn(() => false),
      };

      await selectGhosts({ ghosts: [recent, stale], useAscii: true, now, _clack: clack });

      const memOptions = capturedOptions['MEMORY'];
      // recent.md has more tokens, so it comes first (desc sort)
      expect(memOptions[0].label).toContain('[r]');
      expect(memOptions[1].label).toContain('[s]');
    });

    it('isCancel path returns cancel outcome', async () => {
      const ghost = makeGhost({ name: 'agent-x', tokens: 100 });
      const fakeCancelSymbol = Symbol('cancel');
      const clack = {
        groupMultiselect: vi.fn().mockResolvedValue(fakeCancelSymbol),
        isCancel: vi.fn((v: unknown) => v === fakeCancelSymbol),
      };

      const result = await selectGhosts({ ghosts: [ghost], useAscii: false, _clack: clack });
      expect(result.kind).toBe('cancel');
    });

    it('message passed to groupMultiselect is exactly "Select ghosts to archive:"', async () => {
      const ghost = makeGhost({ name: 'g', tokens: 1 });
      let capturedMessage = '';
      const clack = {
        groupMultiselect: vi.fn((args: { message: string }) => {
          capturedMessage = args.message;
          return Promise.resolve([]);
        }),
        isCancel: vi.fn(() => false),
      };

      await selectGhosts({ ghosts: [ghost], useAscii: false, _clack: clack });
      expect(capturedMessage).toBe('Select ghosts to archive:');
    });
  });
}
