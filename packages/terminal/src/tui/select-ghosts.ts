/**
 * Thin adapter for the interactive ghost picker (D3.1-14).
 *
 * Phase 2 implemented this as a direct `groupMultiselect` wrapper. Phase 3.1
 * replaces the flat picker with a tabbed category view — this module becomes
 * a thin adapter that delegates to `openTabbedPicker` (from `tabbed-picker.ts`)
 * while preserving the public `SelectGhostsOutcome` contract so `ghost.ts`
 * callers remain untouched (Phase 2 SC7 invariant).
 *
 * Responsibilities of this file:
 *  - Define the public `SelectGhostsOutcome` tagged union and `SelectGhostsInput`.
 *  - Own the authoritative `CATEGORY_ORDER`, `CATEGORY_LABEL`, and `formatRowLabel`
 *    (shared with `tabbed-picker.ts`).
 *  - Enforce D3.1-16: refuse to open the picker on terminals with fewer than
 *    14 rows, with the exact stderr message and exit 1 before any prompt.
 *  - Delegate selection UX to `openTabbedPicker` — no clack UX lives here anymore.
 */
import type { TokenCostResult } from '@ccaudit/internal';
import { openTabbedPicker } from './tabbed-picker.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SelectGhostsOutcome =
  | { kind: 'selected'; ids: Set<string> }
  | { kind: 'cancel' }
  | { kind: 'empty-inventory' };

/**
 * Injectable picker dependency — test seam replacing the Phase 2 `_clack`
 * injection. Tests pass a `{ openTabbedPicker }` stub; production uses the
 * real `openTabbedPicker` imported above.
 */
export interface PickerDep {
  openTabbedPicker: typeof openTabbedPicker;
}

export interface SelectGhostsInput {
  /** Items already filtered to ghost tier by caller. */
  ghosts: readonly TokenCostResult[];
  /** Injected for testability — defaults to Date.now() at call site. */
  now?: number;
  /** From shouldUseAscii() at CLI entry. */
  useAscii: boolean;
  /**
   * Phase 6 Plan 03 (D6-13, D6-15, D6-16): when true, framework-protected
   * rows become selectable in the picker and a top-of-TUI banner renders on
   * every frame. Per-invocation only — not persisted, no env var, no config.
   * Plumbs straight through to `openTabbedPicker` / `TabbedGhostPicker`.
   * Defaults to `false` when omitted.
   */
  forcePartial?: boolean;
  /**
   * Optional picker dependency injection for tests.
   * In production the real openTabbedPicker is used.
   */
  _picker?: PickerDep;
}

// ---------------------------------------------------------------------------
// Category label mapping (D-09 — stable order matches design doc §5.2)
// Exported so tabbed-picker.ts (and any future consumer) shares a single
// authoritative source.
// ---------------------------------------------------------------------------

export const CATEGORY_ORDER = [
  'agent',
  'skill',
  'mcp-server',
  'memory',
  'command',
  'hook',
] as const;

export const CATEGORY_LABEL: Record<string, string> = {
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
  const warn = referencedConfigs && referencedConfigs.length > 1 ? (useAscii ? ' !' : ' ⚠') : '';

  return `${glyph}${frameworkPrefix}${name}  ${tokenStr}  ${pathDisplay}${warn}`.trim();
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Opens the tabbed ghost picker for the provided ghost items.
 *
 * Returns:
 *  - { kind: 'empty-inventory' }  if ghosts.length === 0 (no prompt opened)
 *  - { kind: 'cancel' }           if user pressed Ctrl+C / Esc / q
 *  - { kind: 'selected', ids }    on Enter with 0..N items selected
 *
 * Terminal-too-short gate (D3.1-16): on terminals with < 14 rows, writes a
 * helpful message to stderr and `process.exit(1)` BEFORE opening any prompt.
 * The floor is derived from the viewport formula
 * `Math.max(8, (stdoutRows ?? 24) - 10)` — at 13 rows the chrome budget
 * collapses and the tab bar / hints / row list cannot coexist.
 */
export async function selectGhosts(input: SelectGhostsInput): Promise<SelectGhostsOutcome> {
  const { ghosts, now: nowParam, useAscii, forcePartial, _picker } = input;
  const now = nowParam ?? Date.now();

  // D-13: Empty state — caller should skip picker.
  if (ghosts.length === 0) {
    return { kind: 'empty-inventory' };
  }

  // D3.1-16: terminal-too-short gate. Refuse to open the picker when
  // the terminal is shorter than 14 rows (floor viewport 8 + chrome ~5).
  //
  // TEST-ONLY escape hatch: CCAUDIT_TEST_STDOUT_ROWS overrides the
  // process.stdout.rows read so the Plan 04 integration test can exercise
  // this gate from a subprocess whose stdout is a pipe (where rows is
  // always undefined). The LINES env var is NOT honoured by Node's
  // readline/tty for non-TTY stdout, so this override is the simplest
  // way to drive the gate deterministically. NEVER documented in --help.
  // Mirrors the CCAUDIT_FORCE_TTY pattern in ghost.ts (Phase 3 D-21).
  const envOverride = process.env['CCAUDIT_TEST_STDOUT_ROWS'];
  const overrideRows =
    envOverride !== undefined && /^\d+$/.test(envOverride) ? Number(envOverride) : undefined;
  const stdoutRows = overrideRows ?? process.stdout.rows;
  if (stdoutRows !== undefined && stdoutRows < 14) {
    process.stderr.write(
      `Terminal too short (need ≥14 rows, got ${stdoutRows}). ` +
        `Resize your terminal or use \`--dangerously-bust-ghosts\` non-interactively.\n`,
    );
    process.exit(1);
  }

  const picker = _picker ?? { openTabbedPicker };
  const outcome = await picker.openTabbedPicker({
    ghosts,
    useAscii,
    now,
    ...(forcePartial === true ? { forcePartial: true } : {}),
  });
  // TabbedPickerOutcome shape is byte-identical to SelectGhostsOutcome —
  // pass through without translation.
  return outcome;
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

  describe('selectGhosts (thin adapter)', () => {
    // Terminal-too-short gate covered by integration test in Plan 04.

    it('empty inventory → returns { kind: empty-inventory } and openTabbedPicker is NOT called', async () => {
      const picker: PickerDep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'selected', ids: new Set() }),
      };
      const result = await selectGhosts({
        ghosts: [],
        useAscii: false,
        _picker: picker,
      });
      expect(result.kind).toBe('empty-inventory');
      expect(picker.openTabbedPicker).not.toHaveBeenCalled();
    });

    it('selected outcome from openTabbedPicker passes through unchanged', async () => {
      const selectedIds = new Set(['agent|global||/fake/my-agent']);
      const picker: PickerDep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'selected', ids: selectedIds }),
      };
      const ghost = makeGhost({ name: 'my-agent', category: 'agent', tokens: 100 });
      const result = await selectGhosts({
        ghosts: [ghost],
        useAscii: false,
        _picker: picker,
      });
      expect(result.kind).toBe('selected');
      if (result.kind === 'selected') {
        expect(result.ids).toBe(selectedIds);
        expect(result.ids.has('agent|global||/fake/my-agent')).toBe(true);
      }
      expect(picker.openTabbedPicker).toHaveBeenCalledTimes(1);
    });

    it('cancel outcome from openTabbedPicker passes through unchanged', async () => {
      const picker: PickerDep = {
        openTabbedPicker: vi.fn().mockResolvedValue({ kind: 'cancel' }),
      };
      const ghost = makeGhost({ name: 'g', tokens: 1 });
      const result = await selectGhosts({
        ghosts: [ghost],
        useAscii: false,
        _picker: picker,
      });
      expect(result.kind).toBe('cancel');
    });

    it('shared constants CATEGORY_ORDER + CATEGORY_LABEL + formatRowLabel remain exported', () => {
      // Compile-time checks via runtime assertions.
      expect(CATEGORY_ORDER).toContain('agent');
      expect(CATEGORY_ORDER).toContain('skill');
      expect(CATEGORY_LABEL['agent']).toBe('AGENTS');
      expect(CATEGORY_LABEL['mcp-server']).toBe('MCP SERVERS');
      const ghost = makeGhost({ name: 'x', category: 'agent', tokens: 100 });
      const label = formatRowLabel(ghost, false, Date.now());
      expect(label).toContain('x');
      expect(label).toContain('100 tok');
    });
  });
}
