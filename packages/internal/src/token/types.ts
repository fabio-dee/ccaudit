import type { ConfidenceTier } from '../types.ts';
import type { ScanResult } from '../scanner/types.ts';

/**
 * Token cost estimate for a single inventory item.
 * All estimates carry confidence tier for honest attribution.
 */
export interface TokenEstimate {
  /** Estimated token count */
  tokens: number;
  /** Confidence tier: estimated, measured, or community-reported */
  confidence: ConfidenceTier;
  /** Human-readable source description (e.g., "file size", "mcp-token-estimates.json") */
  source: string;
}

/**
 * ScanResult enriched with token cost estimate.
 * Used as output of the token estimation pipeline.
 */
export interface TokenCostResult extends ScanResult {
  /** Token estimate, or null if estimation not possible */
  tokenEstimate: TokenEstimate | null;
}

/**
 * Entry in the bundled mcp-token-estimates.json data file.
 * Community-maintained estimates for popular MCP servers.
 */
export interface McpTokenEntry {
  /** MCP server name (e.g., "context7", "playwright") */
  name: string;
  /** Number of tools registered by this server */
  toolCount: number;
  /** Estimated tokens consumed by tool definitions */
  estimatedTokens: number;
  /** Confidence tier for this estimate */
  confidence: ConfidenceTier;
  /** ISO date string when estimate was last verified */
  lastUpdated?: string;
  /** Human-readable notes about the estimate source */
  notes?: string;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('TokenEstimate', () => {
    it('should have tokens, confidence, and source fields', () => {
      const estimate: TokenEstimate = {
        tokens: 1500,
        confidence: 'estimated',
        source: 'mcp-token-estimates.json',
      };
      expect(estimate.tokens).toBe(1500);
      expect(estimate.confidence).toBe('estimated');
      expect(estimate.source).toBe('mcp-token-estimates.json');
    });

    it('should accept all confidence tiers', () => {
      const tiers: ConfidenceTier[] = ['estimated', 'measured', 'community-reported'];
      for (const tier of tiers) {
        const estimate: TokenEstimate = { tokens: 100, confidence: tier, source: 'test' };
        expect(estimate.confidence).toBe(tier);
      }
    });
  });

  describe('TokenCostResult', () => {
    it('should extend ScanResult with tokenEstimate field', () => {
      const result: TokenCostResult = {
        item: {
          name: 'test-server',
          path: '/home/user/.claude.json',
          scope: 'global',
          category: 'mcp-server',
          projectPath: null,
        },
        tier: 'definite-ghost',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: {
          tokens: 1500,
          confidence: 'estimated',
          source: 'mcp-token-estimates.json',
        },
      };
      expect(result.tokenEstimate).not.toBeNull();
      expect(result.tokenEstimate!.tokens).toBe(1500);
      expect(result.tier).toBe('definite-ghost');
    });

    it('should allow null tokenEstimate', () => {
      const result: TokenCostResult = {
        item: {
          name: 'unknown-item',
          path: '/some/path',
          scope: 'global',
          category: 'agent',
          projectPath: null,
        },
        tier: 'used',
        lastUsed: new Date(),
        invocationCount: 5,
        tokenEstimate: null,
      };
      expect(result.tokenEstimate).toBeNull();
    });
  });

  describe('McpTokenEntry', () => {
    it('should have name, toolCount, estimatedTokens, and confidence', () => {
      const entry: McpTokenEntry = {
        name: 'context7',
        toolCount: 2,
        estimatedTokens: 1500,
        confidence: 'estimated',
      };
      expect(entry.name).toBe('context7');
      expect(entry.toolCount).toBe(2);
      expect(entry.estimatedTokens).toBe(1500);
      expect(entry.confidence).toBe('estimated');
    });

    it('should accept optional lastUpdated and notes', () => {
      const entry: McpTokenEntry = {
        name: 'playwright',
        toolCount: 20,
        estimatedTokens: 14000,
        confidence: 'community-reported',
        lastUpdated: '2026-04-01T00:00:00Z',
        notes: 'Browser automation tools',
      };
      expect(entry.lastUpdated).toBe('2026-04-01T00:00:00Z');
      expect(entry.notes).toBe('Browser automation tools');
    });
  });
}
