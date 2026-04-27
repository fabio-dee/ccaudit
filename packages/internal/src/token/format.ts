import type { TokenEstimate } from './types.ts';
import type { ProjectGhostSummary } from '../report/types.ts';
import { CONTEXT_WINDOW_SIZE } from './mcp-estimates-data.ts';

/**
 * Format a token estimate for display.
 * Always prefixes with ~ (approximate) and appends the confidence tier.
 * Returns "unknown" for null estimates.
 *
 * Examples:
 * - { tokens: 15000 } -> "~15k tokens (estimated)"
 * - { tokens: 1500 }  -> "~1.5k tokens (measured)"
 * - { tokens: 350 }   -> "~350 tokens (community-reported)"
 * - null               -> "unknown"
 */
export function formatTokenEstimate(estimate: TokenEstimate | null): string {
  if (estimate === null) {
    return 'unknown';
  }

  const { tokens, confidence } = estimate;
  let formatted: string;

  if (tokens >= 10000) {
    formatted = `~${Math.round(tokens / 1000)}k tokens`;
  } else if (tokens >= 1000) {
    formatted = `~${(tokens / 1000).toFixed(1)}k tokens`;
  } else {
    formatted = `~${tokens} tokens`;
  }

  return `${formatted} (${confidence})`;
}

/**
 * Format total ghost overhead as absolute token count and percentage of context window.
 *
 * When worstProject is provided, appends a breakdown line showing how the total
 * is split between global and the single heaviest project — correcting the naive
 * "sum all projects" overcounting (a session loads global + ONE project, not all).
 *
 * Examples (no project):
 * - (30000, 30000, null, 200000) -> "~30k tokens (~15.0% of 200k context window)"
 *
 * Examples (with worst project):
 * - (93000, 45000, { displayPath: '~/nexus', totalTokens: 48000 }, 200000) ->
 *   "~93k tokens (~46.5% of 200k context window)\n(global: ~45k tokens + worst project ~/nexus: ~48k tokens)"
 */
export function formatTotalOverhead(
  total: number,
  globalCost: number,
  worstProject: ProjectGhostSummary | null,
  contextWindowSize: number = CONTEXT_WINDOW_SIZE,
): string {
  const percentage = ((total / contextWindowSize) * 100).toFixed(1);

  let formatted: string;
  if (total >= 10000) {
    formatted = `~${Math.round(total / 1000)}k`;
  } else if (total >= 1000) {
    formatted = `~${(total / 1000).toFixed(1)}k`;
  } else {
    formatted = `~${total}`;
  }

  let result = `${formatted} tokens (~${percentage}% of ${contextWindowSize / 1000}k context window)`;

  if (worstProject !== null) {
    const globalStr = formatTokensShort(globalCost);
    const projStr = formatTokensShort(worstProject.totalTokens);
    result += `\n(global: ${globalStr} + worst project ${worstProject.displayPath}: ${projStr})`;
  }

  return result;
}

export function formatSavingsLine(
  tokens: number,
  highlightCommand?: (cmd: string) => string,
): string {
  let formatted: string;
  if (tokens >= 10000) formatted = `~${Math.round(tokens / 1000)}k`;
  else if (tokens >= 1000) formatted = `~${(tokens / 1000).toFixed(1)}k`;
  else formatted = `~${tokens}`;
  const cmd = 'ccaudit --dangerously-bust-ghosts';
  const formattedCmd = highlightCommand ? highlightCommand(cmd) : `\`${cmd}\``;
  return `💡 Potential savings after ${formattedCmd}: ${formatted} tokens/session reclaimed`;
}

/** Format a raw token count as ~Xk or ~X (no confidence suffix). */
function formatTokensShort(tokens: number): string {
  if (tokens >= 10000) return `~${Math.round(tokens / 1000)}k tokens`;
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}

/**
 * Format a token count for the live picker footer (D4-10).
 *
 * Rules:
 *  - n === 0            → ''                  (caller decides whether to render)
 *  - 0 < n < 1000       → `{n} tokens`        (no approximation glyph)
 *  - n >= 1000          → `≈ {round(n/1000)}k tokens`
 *
 * The leading `≈ ` falls back to `~ ` when `opts.ascii === true` (D4-11 /
 * shouldUseAscii).
 *
 * Rounding is `Math.round(n / 1000)` for ALL n >= 1000 (not the 1.5k "toFixed(1)"
 * branch used by formatTokenEstimate / fmtK for 1000..9999). This is intentional:
 * the picker footer is a running tally that updates on every keystroke, and mixing
 * "≈ 1.5k" with "≈ 2k" as the user toggles across the 1500-token boundary reads
 * as a visual stutter. A single rounding rule produces a calmer counter.
 *
 * MH-04 (Phase 4 ↔ bust parity): for n >= 10_000 this helper's human-visible value
 * matches `fmtK(n)` in shareable-block.ts exactly, so the picker total at the
 * moment of Enter matches the post-bust "Freed: ~Xk" summary within ≤1k rounding
 * tolerance. The 1000..9999 band can differ by up to ~0.5k (picker shows "≈ 2k",
 * summary shows "~1.5k") — this is inside the tolerance quoted in MH-04.
 */
export function formatTokensApprox(n: number, opts: { ascii?: boolean } = {}): string {
  if (n === 0) return '';
  if (n < 1000) return `${n} tokens`;
  const glyph = opts.ascii === true ? '~' : '≈';
  return `${glyph} ${Math.round(n / 1000)}k tokens`;
}

/**
 * Sum the token estimate of every catalog item whose canonical id is present in
 * the selection Set (D4-12). Items not present in the catalog contribute 0
 * (defensive — the picker's Set should never contain a stale id, but a future
 * filter/sort refactor could leave stale entries briefly during a state
 * transition).
 *
 * O(n) per call. At human interaction speeds (<10 render/sec) and realistic
 * inventories (≤ 500 items), this is trivially in budget — matches D4-12.
 *
 * The caller is responsible for computing canonical ids and building the
 * catalog map (id → tokens, with null tokenEstimate collapsed to 0). Keeping
 * the helper map-based avoids a cross-directory import from token/ into
 * scanner/.
 */
export function sumSelectionTokens(
  ids: ReadonlySet<string>,
  catalog: ReadonlyMap<string, number>,
): number {
  if (ids.size === 0) return 0;
  let total = 0;
  for (const id of ids) {
    const t = catalog.get(id);
    if (t !== undefined) total += t;
  }
  return total;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('formatTokenEstimate', () => {
    it('should format 15000 tokens as ~15k with confidence', () => {
      const result = formatTokenEstimate({
        tokens: 15000,
        confidence: 'estimated',
        source: '',
      });
      expect(result).toBe('~15k tokens (estimated)');
    });

    it('should format 1500 tokens as ~1.5k with confidence', () => {
      const result = formatTokenEstimate({
        tokens: 1500,
        confidence: 'measured',
        source: '',
      });
      expect(result).toBe('~1.5k tokens (measured)');
    });

    it('should format 350 tokens without k suffix', () => {
      const result = formatTokenEstimate({
        tokens: 350,
        confidence: 'community-reported',
        source: '',
      });
      expect(result).toBe('~350 tokens (community-reported)');
    });

    it('should return "unknown" for null', () => {
      expect(formatTokenEstimate(null)).toBe('unknown');
    });

    it('should handle exact 1000 boundary', () => {
      const result = formatTokenEstimate({
        tokens: 1000,
        confidence: 'estimated',
        source: '',
      });
      expect(result).toBe('~1.0k tokens (estimated)');
    });

    it('should handle exact 10000 boundary', () => {
      const result = formatTokenEstimate({
        tokens: 10000,
        confidence: 'estimated',
        source: '',
      });
      expect(result).toBe('~10k tokens (estimated)');
    });

    it('should handle 0 tokens', () => {
      const result = formatTokenEstimate({
        tokens: 0,
        confidence: 'estimated',
        source: '',
      });
      expect(result).toBe('~0 tokens (estimated)');
    });
  });

  describe('formatTotalOverhead', () => {
    it('should format 30000 tokens with percentage (no project)', () => {
      const result = formatTotalOverhead(30000, 30000, null, 200000);
      expect(result).toBe('~30k tokens (~15.0% of 200k context window)');
    });

    it('should format 0 tokens with 0.0% (no project)', () => {
      const result = formatTotalOverhead(0, 0, null, 200000);
      expect(result).toBe('~0 tokens (~0.0% of 200k context window)');
    });

    it('should format 1500 tokens with correct percentage (no project)', () => {
      const result = formatTotalOverhead(1500, 1500, null, 200000);
      expect(result).toBe('~1.5k tokens (~0.8% of 200k context window)');
    });

    it('should use default context window size of 200000', () => {
      const result = formatTotalOverhead(100000, 100000, null);
      expect(result).toBe('~100k tokens (~50.0% of 200k context window)');
    });

    it('should handle small token counts (no project)', () => {
      const result = formatTotalOverhead(500, 500, null, 200000);
      expect(result).toBe('~500 tokens (~0.3% of 200k context window)');
    });

    it('appends breakdown line when worstProject is provided', () => {
      const worstProject: ProjectGhostSummary = {
        projectPath: '/home/user/nexus',
        displayPath: '~/nexus',
        totalTokens: 48000,
        ghostCount: 55,
        items: [],
      };
      const result = formatTotalOverhead(93000, 45000, worstProject, 200000);
      expect(result).toContain('~93k tokens (~46.5% of 200k context window)');
      expect(result).toContain('global: ~45k tokens + worst project ~/nexus: ~48k tokens');
    });

    it('does not append breakdown line when worstProject is null', () => {
      const result = formatTotalOverhead(45000, 45000, null, 200000);
      expect(result).not.toContain('global:');
      expect(result).not.toContain('worst project');
    });
  });

  describe('formatSavingsLine', () => {
    it('formats 93000 tokens as ~93k', () => {
      const result = formatSavingsLine(93000);
      expect(result).toContain('~93k');
    });

    it('formats 3500 tokens as ~3.5k', () => {
      const result = formatSavingsLine(3500);
      expect(result).toContain('~3.5k');
    });

    it('formats 250 tokens without k suffix', () => {
      const result = formatSavingsLine(250);
      expect(result).toContain('~250');
    });

    it('contains the command string', () => {
      const result = formatSavingsLine(1000);
      expect(result).toContain('ccaudit --dangerously-bust-ghosts');
    });
  });

  describe('formatTokensApprox', () => {
    it('returns empty string for 0 tokens', () => {
      expect(formatTokensApprox(0)).toBe('');
    });

    it('returns raw "1 tokens" for n=1 (no approximation glyph)', () => {
      expect(formatTokensApprox(1)).toBe('1 tokens');
    });

    it('returns raw "999 tokens" for n=999', () => {
      expect(formatTokensApprox(999)).toBe('999 tokens');
    });

    it('switches to "≈ 1k tokens" at the 1000 boundary', () => {
      expect(formatTokensApprox(1000)).toBe('≈ 1k tokens');
    });

    it('rounds 1499 down to "≈ 1k tokens"', () => {
      expect(formatTokensApprox(1499)).toBe('≈ 1k tokens');
    });

    it('rounds 1500 up to "≈ 2k tokens"', () => {
      expect(formatTokensApprox(1500)).toBe('≈ 2k tokens');
    });

    it('formats 47123 as "≈ 47k tokens"', () => {
      expect(formatTokensApprox(47123)).toBe('≈ 47k tokens');
    });

    it('ASCII mode swaps ≈ for ~ (D4-11 fallback)', () => {
      expect(formatTokensApprox(1500, { ascii: true })).toBe('~ 2k tokens');
    });

    it('ASCII mode still returns empty for 0', () => {
      expect(formatTokensApprox(0, { ascii: true })).toBe('');
    });

    it('ASCII mode keeps raw count for < 1000 (no glyph either way)', () => {
      expect(formatTokensApprox(500, { ascii: true })).toBe('500 tokens');
    });
  });

  describe('sumSelectionTokens', () => {
    it('empty selection sums to 0', () => {
      expect(sumSelectionTokens(new Set(), new Map())).toBe(0);
    });

    it("single-id selection returns that id's token value", () => {
      const cat = new Map([['id-a', 100]]);
      expect(sumSelectionTokens(new Set(['id-a']), cat)).toBe(100);
    });

    it('multi-id selection sums each id exactly once', () => {
      const cat = new Map([
        ['id-a', 100],
        ['id-b', 250],
        ['id-c', 75],
      ]);
      expect(sumSelectionTokens(new Set(['id-a', 'id-c']), cat)).toBe(175);
    });

    it('id present in set but missing from catalog contributes 0', () => {
      const cat = new Map([['id-a', 100]]);
      expect(sumSelectionTokens(new Set(['id-a', 'id-missing']), cat)).toBe(100);
    });

    it('empty catalog with non-empty selection returns 0', () => {
      expect(sumSelectionTokens(new Set(['id-a', 'id-b']), new Map())).toBe(0);
    });
  });
}
