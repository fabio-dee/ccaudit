import type { TokenEstimate } from './types.ts';

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
 * Examples:
 * - (30000, 200000)  -> "~30k tokens (~15.0% of 200k context window)"
 * - (0, 200000)      -> "~0 tokens (~0.0% of 200k context window)"
 * - (1500, 200000)   -> "~1.5k tokens (~0.8% of 200k context window)"
 */
export function formatTotalOverhead(
  totalTokens: number,
  contextWindowSize: number = 200_000,
): string {
  const percentage = ((totalTokens / contextWindowSize) * 100).toFixed(1);

  let formatted: string;
  if (totalTokens >= 10000) {
    formatted = `~${Math.round(totalTokens / 1000)}k`;
  } else if (totalTokens >= 1000) {
    formatted = `~${(totalTokens / 1000).toFixed(1)}k`;
  } else {
    formatted = `~${totalTokens}`;
  }

  return `${formatted} tokens (~${percentage}% of ${contextWindowSize / 1000}k context window)`;
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
    it('should format 30000 tokens with percentage', () => {
      const result = formatTotalOverhead(30000, 200000);
      expect(result).toBe('~30k tokens (~15.0% of 200k context window)');
    });

    it('should format 0 tokens with 0.0%', () => {
      const result = formatTotalOverhead(0, 200000);
      expect(result).toBe('~0 tokens (~0.0% of 200k context window)');
    });

    it('should format 1500 tokens with correct percentage', () => {
      const result = formatTotalOverhead(1500, 200000);
      expect(result).toBe('~1.5k tokens (~0.8% of 200k context window)');
    });

    it('should use default context window size of 200000', () => {
      const result = formatTotalOverhead(100000);
      expect(result).toBe('~100k tokens (~50.0% of 200k context window)');
    });

    it('should handle small token counts', () => {
      const result = formatTotalOverhead(500, 200000);
      expect(result).toBe('~500 tokens (~0.3% of 200k context window)');
    });
  });
}
