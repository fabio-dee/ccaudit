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
}
