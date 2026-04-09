import { lookupMcpEstimate } from './mcp-estimates-data.ts';
import { estimateFromFileSize } from './file-size-estimator.ts';
import type { ScanResult } from '../scanner/types.ts';
import type { TokenCostResult, TokenEstimate } from './types.ts';
import type { ProjectGhostSummary } from '../report/types.ts';

/**
 * Per-session overhead for a single agent registry index entry.
 * Claude Code uses a lazy-loading BM25 registry: the full .md content is NOT
 * injected into the parent session context. Only a lightweight index entry
 * (~20-25 tokens: name + short description) is present per session.
 * Full content loads only when the agent is actually spawned as a sub-session.
 * Source: Claude Code agent registry research (~20-25 tokens/agent in index).
 */
const AGENT_REGISTRY_ENTRY_TOKENS = 25;

/**
 * Enrich scan results with token cost estimates.
 * Applies per-category estimation strategy:
 * - MCP servers: lookup from bundled mcp-token-estimates.json
 * - Agents: fixed ~25 tokens/agent (lazy-loaded registry index entry cost only)
 * - Memory: file-size-based estimation (full content loaded into context)
 * - Skills: file-size-based estimation, capped at 500 tokens (only SKILL.md description loaded)
 */
export async function enrichScanResults(results: ScanResult[]): Promise<TokenCostResult[]> {
  return Promise.all(
    results.map(async (result): Promise<TokenCostResult> => {
      let tokenEstimate: TokenEstimate | null = null;

      switch (result.item.category) {
        case 'mcp-server': {
          const entry = lookupMcpEstimate(result.item.name);
          if (entry) {
            tokenEstimate = {
              tokens: entry.estimatedTokens,
              confidence: entry.confidence,
              source: `mcp-token-estimates.json (${entry.toolCount} tools)`,
            };
          }
          break;
        }
        case 'agent': {
          // Agents use Claude Code's lazy-loading registry. Per-session overhead is
          // ~25 tokens per agent (index entry), not the full file size (spawn overhead).
          tokenEstimate = {
            tokens: AGENT_REGISTRY_ENTRY_TOKENS,
            confidence: 'estimated',
            source: 'agent registry index entry (lazy-loaded, ~25 tokens/agent)',
          };
          break;
        }
        case 'memory': {
          tokenEstimate = await estimateFromFileSize(result.item.path);
          break;
        }
        case 'skill': {
          const estimate = await estimateFromFileSize(result.item.path);
          if (estimate) {
            tokenEstimate = {
              tokens: Math.min(estimate.tokens, 500),
              confidence: estimate.confidence,
              source:
                estimate.tokens > 500
                  ? 'skill description estimate (capped at ~2KB)'
                  : estimate.source,
            };
          }
          break;
        }
      }

      return { ...result, tokenEstimate };
    }),
  );
}

/**
 * Calculate total token overhead from enriched results.
 * Sums all non-null tokenEstimate.tokens values.
 */
export function calculateTotalOverhead(results: TokenCostResult[]): number {
  return results.reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
}

/**
 * Calculate worst-case session overhead from grouped project summaries.
 *
 * A single Claude Code session loads: global inventory + ONE project's inventory.
 * Worst-case = global cost + the heaviest single project cost.
 * This corrects the naive sum-all-projects overcounting.
 */
export function calculateWorstCaseOverhead(
  globalSummary: ProjectGhostSummary,
  projectSummaries: ProjectGhostSummary[],
): {
  total: number;
  globalCost: number;
  worstProject: ProjectGhostSummary | null;
} {
  const globalCost = globalSummary.totalTokens;
  const worstProject = projectSummaries[0] ?? null;
  const total = globalCost + (worstProject?.totalTokens ?? 0);
  return { total, globalCost, worstProject };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  describe('enrichScanResults', () => {
    it('should return TokenCostResult[] same length as input ScanResult[]', async () => {
      const input: ScanResult[] = [
        {
          item: {
            name: 'test-agent',
            path: '/tmp/test.md',
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
        {
          item: {
            name: 'test-skill',
            path: '/tmp/skill.md',
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'likely-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result).toHaveLength(2);
    });

    it('should get tokenEstimate from lookupMcpEstimate for MCP server (context7 -> 1500 tokens)', async () => {
      const input: ScanResult[] = [
        {
          item: {
            name: 'context7',
            path: '/home/user/.claude.json',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(1500);
      expect(result[0].tokenEstimate!.confidence).toBe('estimated');
      expect(result[0].tokenEstimate!.source).toContain('mcp-token-estimates.json');
    });

    it('should return tokenEstimate = null for unknown MCP server', async () => {
      const input: ScanResult[] = [
        {
          item: {
            name: 'unknown-server-xyz',
            path: '/home/user/.claude.json',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result[0].tokenEstimate).toBeNull();
    });

    it('should use fixed registry entry cost for agent item (not file size)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-enrich-'));
      const filePath = join(dir, 'agent.md');
      // Large file — must NOT influence estimate; agent overhead is fixed registry cost
      await writeFile(filePath, 'x'.repeat(800));

      const input: ScanResult[] = [
        {
          item: {
            name: 'test-agent',
            path: filePath,
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(25); // fixed registry entry overhead
      expect(result[0].tokenEstimate!.confidence).toBe('estimated');
      expect(result[0].tokenEstimate!.source).toContain('registry');
      await rm(dir, { recursive: true, force: true });
    });

    it('should get tokenEstimate from file size for memory item', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-enrich-'));
      const filePath = join(dir, 'CLAUDE.md');
      await writeFile(filePath, 'z'.repeat(400));

      const input: ScanResult[] = [
        {
          item: {
            name: 'CLAUDE.md',
            path: filePath,
            scope: 'project',
            category: 'memory',
            projectPath: '/test/proj',
          },
          tier: 'likely-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(100); // 400 / 4 = 100
      await rm(dir, { recursive: true, force: true });
    });

    it('should cap skill tokenEstimate at 500 tokens', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-enrich-'));
      const filePath = join(dir, 'SKILL.md');
      // 4000 bytes -> would be 1000 tokens uncapped, but skill cap = 500
      await writeFile(filePath, 'y'.repeat(4000));

      const input: ScanResult[] = [
        {
          item: {
            name: 'deploy',
            path: filePath,
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];
      const result = await enrichScanResults(input);
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(500);
      expect(result[0].tokenEstimate!.source).toContain('capped');
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('calculateWorstCaseOverhead', () => {
    function makeSummary(
      totalTokens: number,
      projectPath: string | null = null,
    ): ProjectGhostSummary {
      return {
        projectPath,
        displayPath: projectPath ?? '(global)',
        totalTokens,
        ghostCount: 0,
        items: [],
      };
    }

    it('returns global + worst project total', () => {
      const global = makeSummary(45000);
      const projects = [makeSummary(48000, '/repo/a'), makeSummary(22000, '/repo/b')];
      const { total, globalCost, worstProject } = calculateWorstCaseOverhead(global, projects);
      expect(total).toBe(93000);
      expect(globalCost).toBe(45000);
      expect(worstProject?.totalTokens).toBe(48000);
    });

    it('returns only global cost when no projects', () => {
      const global = makeSummary(45000);
      const { total, worstProject } = calculateWorstCaseOverhead(global, []);
      expect(total).toBe(45000);
      expect(worstProject).toBeNull();
    });

    it('returns first project as worstProject (already sorted by caller)', () => {
      const global = makeSummary(0);
      const projects = [makeSummary(99000, '/big'), makeSummary(1000, '/small')];
      const { worstProject } = calculateWorstCaseOverhead(global, projects);
      expect(worstProject?.totalTokens).toBe(99000);
    });
  });

  describe('calculateTotalOverhead', () => {
    it('should sum all non-null tokenEstimate.tokens', () => {
      const input: TokenCostResult[] = [
        {
          item: { name: 'a', path: '/a', scope: 'global', category: 'agent', projectPath: null },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'b',
            path: '/b',
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 500, confidence: 'measured', source: 'test' },
        },
        {
          item: { name: 'c', path: '/c', scope: 'global', category: 'skill', projectPath: null },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: null,
        },
      ];
      expect(calculateTotalOverhead(input)).toBe(1500);
    });

    it('should return 0 for empty array', () => {
      expect(calculateTotalOverhead([])).toBe(0);
    });
  });
}
