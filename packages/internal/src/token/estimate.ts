import {
  lookupMcpEstimate,
  DEFAULT_UNKNOWN_MCP_TOKENS,
  CONTEXT_WINDOW_SIZE,
} from './mcp-estimates-data.ts';
import { estimateFromFileSize } from './file-size-estimator.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { estimateSkillTokens } from './skill-estimator.ts';
import { estimateAgentTokens } from './agent-estimator.ts';
import { estimateMemoryTokens } from './memory-estimator.ts';
import { estimateCommandTokens } from './command-estimator.ts';
import { estimateHookTokens } from './hook-estimator.ts';
import { resolveMcpRegime, regimeFlatOverhead } from './mcp-regime.ts';
import type { McpRegime } from './mcp-regime.ts';
import { stat } from 'node:fs/promises';
import type { ScanResult } from '../scanner/types.ts';
import type { TokenCostResult, TokenEstimate } from './types.ts';
import type { ProjectGhostSummary } from '../report/types.ts';

/**
 * Default tool count assumption for MCP servers not in bundled data.
 * Used when computing deferred-regime token costs for unknown servers.
 * 8 tools is a conservative median across common MCP servers.
 */
export const DEFAULT_UNKNOWN_MCP_TOOL_COUNT = 8;

/**
 * Enrich scan results with token cost estimates.
 * Applies per-category estimation strategy:
 * - MCP servers: regime-aware lookup (eager uses bundled estimates, deferred uses per-tool math)
 * - Agents: frontmatter-aware eager formula (full description enters Task schema)
 * - Memory: file-size heuristic with recursive @-import resolution
 * - Skills: frontmatter-aware lazy formula (description truncated at 250 chars)
 *
 * The optional `opts` parameter controls MCP regime resolution:
 * - `opts.regime = 'auto'` (default): resolve based on ccVersion + token threshold heuristic.
 * - `opts.regime = 'eager' | 'deferred'`: explicit override, ignores ccVersion.
 * - `opts.ccVersion`: pass the detected Claude Code version (or null if unknown).
 *   When not provided and regime is 'auto', defaults to null -> 'unknown' regime.
 *
 * Two-pass strategy for 'auto' regime:
 *   Pass 1: compute eager-regime MCP total to determine if threshold is hit.
 *   Pass 2: resolve regime and apply correct per-tool costs.
 */
export async function enrichScanResults(
  results: ScanResult[],
  opts?: { regime?: McpRegime | 'auto'; ccVersion?: string | null },
): Promise<TokenCostResult[]> {
  const regimeOpt = opts?.regime ?? 'auto';
  const ccVersion = opts?.ccVersion ?? null;

  // Resolve the MCP regime to use for this enrichment pass.
  // For 'auto', compute an eager-estimate total first to check the 10% threshold.
  let resolvedRegime: McpRegime;
  if (regimeOpt === 'auto') {
    // Pass 1: compute eager-regime MCP total
    let eagerMcpTotal = 0;
    for (const r of results) {
      if (r.item.category === 'mcp-server') {
        const entry = lookupMcpEstimate(r.item.name);
        eagerMcpTotal += entry?.estimatedTokens ?? DEFAULT_UNKNOWN_MCP_TOKENS;
      }
    }
    // Pass 2: resolve regime using the eager total + version
    const resolved = resolveMcpRegime({
      totalMcpToolTokens: eagerMcpTotal,
      contextWindow: CONTEXT_WINDOW_SIZE,
      ccVersion,
      override: null,
    });
    resolvedRegime = resolved.regime;
  } else {
    // Explicit override — resolve with the given regime, version irrelevant
    const resolved = resolveMcpRegime({
      totalMcpToolTokens: 0,
      contextWindow: CONTEXT_WINDOW_SIZE,
      ccVersion,
      override: regimeOpt,
    });
    resolvedRegime = resolved.regime;
  }

  return Promise.all(
    results.map(async (result): Promise<TokenCostResult> => {
      let tokenEstimate: TokenEstimate | null = null;

      switch (result.item.category) {
        case 'mcp-server': {
          const entry = lookupMcpEstimate(result.item.name);
          const toolCount = entry?.toolCount ?? DEFAULT_UNKNOWN_MCP_TOOL_COUNT;

          if (resolvedRegime === 'deferred') {
            // Deferred regime: per-tool cost (15 tokens) + small per-server ToolSearch registry overhead
            const tokens = 15 * toolCount + 50;
            tokenEstimate = {
              tokens,
              confidence: 'estimated',
              source: `mcp:deferred (${toolCount} tools)`,
            };
          } else {
            // Eager or unknown regime: use bundled lookup or default fallback
            if (entry) {
              tokenEstimate = {
                tokens: entry.estimatedTokens,
                confidence: entry.confidence,
                source: `mcp:${resolvedRegime} (${entry.toolCount} tools)`,
              };
            } else {
              tokenEstimate = {
                tokens: DEFAULT_UNKNOWN_MCP_TOKENS,
                confidence: 'estimated',
                source: `mcp:${resolvedRegime} (default — server not in bundled data)`,
              };
            }
          }
          break;
        }
        case 'agent': {
          let fileSize: number | null = null;
          try {
            const s = await stat(result.item.path);
            fileSize = s.size;
          } catch {
            // file unreadable — leave fileSize null
          }
          const fm = await parseFrontmatter(result.item.path);
          const agentEst = estimateAgentTokens(fm, fileSize);
          if (agentEst) {
            tokenEstimate = {
              tokens: agentEst.tokens,
              confidence: 'estimated',
              source: `agent:${agentEst.formula} (desc=${agentEst.descriptionChars} chars)`,
            };
          }
          break;
        }
        case 'memory': {
          // T41: auto-memory (Claude Code's managed MEMORY.md) is truncated to
          // 25 KB by Claude Code itself. Cap the estimate at 6250 tokens (25KB/4).
          const AUTO_MEMORY_TOKEN_CAP = 6250;
          if (result.item.name === 'MEMORY.md (auto)') {
            const autoEst = await estimateFromFileSize(result.item.path);
            if (autoEst) {
              tokenEstimate = {
                tokens: Math.min(autoEst.tokens, AUTO_MEMORY_TOKEN_CAP),
                confidence: 'estimated',
                source: 'memory:auto (capped at 25KB)',
              };
            }
          } else if ((result.item.importDepth ?? 0) > 0) {
            // T40 import-chain row: estimate from file size directly (no recursive
            // walk needed — the root already accounts for the full chain).
            tokenEstimate = await estimateFromFileSize(result.item.path);
          } else {
            const memEst = await estimateMemoryTokens(result.item.path);
            if (memEst) {
              tokenEstimate = {
                tokens: memEst.tokens,
                confidence: 'estimated',
                source: `memory:resolved(depth=${memEst.depthReached}, files=${memEst.importChain.length})`,
              };
            } else {
              tokenEstimate = await estimateFromFileSize(result.item.path);
            }
          }
          break;
        }
        case 'skill': {
          // For skills, path is a directory; SKILL.md lives inside it.
          // Use the SKILL.md file size as the fallback (not the directory size).
          const skillMdPath = result.item.path.endsWith('SKILL.md')
            ? result.item.path
            : `${result.item.path}/SKILL.md`;
          let fileSize: number | null = null;
          try {
            const s = await stat(skillMdPath);
            fileSize = s.size;
          } catch {
            // SKILL.md absent or unreadable — leave fileSize null
          }
          const fm = await parseFrontmatter(skillMdPath);
          const skillEst = estimateSkillTokens(fm, fileSize);
          if (skillEst) {
            tokenEstimate = {
              tokens: skillEst.tokens,
              confidence: 'estimated',
              source: `skill:${skillEst.formula} (desc=${skillEst.descriptionChars} chars)`,
            };
          }
          break;
        }
        case 'command': {
          let fileSize: number | null = null;
          try {
            const s = await stat(result.item.path);
            fileSize = s.size;
          } catch {
            // file unreadable — leave fileSize null
          }
          const fm = await parseFrontmatter(result.item.path);
          const cmdEst = estimateCommandTokens(fm, fileSize);
          if (cmdEst) {
            tokenEstimate = {
              tokens: cmdEst.tokens,
              confidence: 'estimated',
              source: `command:${cmdEst.formula} (desc=${cmdEst.descriptionChars} chars)`,
            };
          }
          break;
        }
        case 'hook': {
          const fires = result.invocationCount; // from buildInvocationMaps routing
          const { tokens, confidence, source } = estimateHookTokens(
            result.item.injectCapable ?? false,
            fires,
          );
          tokenEstimate = { tokens, confidence, source };
          break;
        }
      }

      return { ...result, tokenEstimate };
    }),
  );
}

/**
 * T42: Shared dedup helper for total-overhead functions.
 *
 * When a CLAUDE.md is scanned, the estimator for its root item already follows
 * @-imports recursively and sums all transitive file sizes. The scanner (T40)
 * ALSO emits individual InventoryItems for each imported file so they show up
 * in tables — but those import-chain items must NOT be counted again in the
 * total, otherwise the same bytes would be billed twice.
 *
 * Rule: an item with importDepth > 0 contributes its file-size estimate
 * only for its own row display; it is SKIPPED in the aggregate total because
 * its tokens were already included by the root item's recursive walk.
 *
 * Additionally, if a rules/*.md file is imported by a CLAUDE.md (and therefore
 * appears both as a standalone rules item AND as an import-chain item), we
 * track counted paths and skip duplicates.
 */
function sumWithDedup(results: TokenCostResult[]): number {
  // Paths already counted — skip import-chain rows (importDepth > 0) that
  // would double-count content already summed in the root memory item.
  const countedPaths = new Set<string>();
  let total = 0;
  for (const r of results) {
    if (r.item.category === 'memory' && (r.item.importDepth ?? 0) > 0) {
      // Import-chain row: tokens already included by root's recursive walk.
      // Skip to avoid double-counting.
      continue;
    }
    // For memory items only, dedup by path to handle the edge case where the
    // same rules/*.md file is scanned both standalone and referenced via an
    // import chain at depth 0. Non-memory categories (hooks, commands, skills,
    // agents, MCP servers) legitimately share paths (e.g. all hooks live in
    // settings.json; multiple MCP servers live in mcp.json) and must NOT be
    // collapsed — every item contributes its own token cost independently.
    if (r.item.category === 'memory' && r.item.path && countedPaths.has(r.item.path)) {
      continue;
    }
    if (r.item.category === 'memory' && r.item.path) countedPaths.add(r.item.path);
    total += r.tokenEstimate?.tokens ?? 0;
  }
  return total;
}

/**
 * Calculate total token overhead from enriched results.
 * Sums all non-null tokenEstimate.tokens values, deduplicating import-chain
 * rows (importDepth > 0) whose tokens are already included by their root
 * memory item's recursive walk.
 */
export function calculateTotalOverhead(results: TokenCostResult[]): number {
  return sumWithDedup(results);
}

/**
 * Ghost-command-specific total: optionally excludes hook-category items.
 *
 * When includeHooks is false (default for the ghost command), hook tokens are
 * not aggregated into the headline total — they appear in the advisory section
 * instead. When true (--include-hooks pessimistic mode), hooks are included.
 *
 * Inventory and MCP callers continue using calculateTotalOverhead unchanged.
 * Both functions apply the same dedup logic via sumWithDedup.
 */
export function calculateGhostTotalOverhead(
  results: TokenCostResult[],
  includeHooks: boolean,
): number {
  const filtered = includeHooks ? results : results.filter((r) => r.item.category !== 'hook');
  return sumWithDedup(filtered);
}

/**
 * Sum token estimates for all hook-category items.
 * Used by the ghost advisory section to display "would add ~Xk" regardless
 * of aggregation mode.
 */
export function sumHookTokens(results: TokenCostResult[]): number {
  return results
    .filter((r) => r.item.category === 'hook')
    .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
}

/**
 * Calculate worst-case session overhead from grouped project summaries.
 *
 * A single Claude Code session loads: global inventory + ONE project's inventory.
 * Worst-case = global cost + the heaviest single project cost.
 * This corrects the naive sum-all-projects overcounting.
 *
 * The optional `regime` parameter enables ToolSearch overhead accounting:
 * - 'deferred': adds 1700 flat tokens (200 ToolSearch metadata + ~1500 instructions)
 * - 'eager' / 'unknown' / omitted: toolSearchOverhead = 0
 */
export function calculateWorstCaseOverhead(
  globalSummary: ProjectGhostSummary,
  projectSummaries: ProjectGhostSummary[],
  regime?: McpRegime,
): {
  total: number;
  globalCost: number;
  worstProject: ProjectGhostSummary | null;
  toolSearchOverhead: number;
} {
  const globalCost = globalSummary.totalTokens;
  const worstProject = projectSummaries[0] ?? null;
  const toolSearchOverhead = regimeFlatOverhead(regime ?? 'eager');
  const total = globalCost + (worstProject?.totalTokens ?? 0) + toolSearchOverhead;
  return { total, globalCost, worstProject, toolSearchOverhead };
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

    it('should get tokenEstimate from bundled data for MCP server context7 in eager regime (1500 tokens)', async () => {
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
      // Explicit eager regime: context7 has 1500 estimated tokens in bundled data
      const result = await enrichScanResults(input, { regime: 'eager' });
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(1500);
      expect(result[0].tokenEstimate!.confidence).toBe('estimated');
      expect(result[0].tokenEstimate!.source).toContain('mcp:eager');
    });

    it('should return default 2000-token fallback for unknown MCP server in eager regime', async () => {
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
      const result = await enrichScanResults(input, { regime: 'eager' });
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(2000);
      expect(result[0].tokenEstimate!.confidence).toBe('estimated');
      expect(result[0].tokenEstimate!.source).toContain('default');
    });

    it('context7 + deferred regime -> 15 * toolCount(2) + 50 = 80 tokens', async () => {
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
      // context7 has toolCount=2 per bundled data -> 15*2+50 = 80
      const result = await enrichScanResults(input, { regime: 'deferred' });
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(80);
      expect(result[0].tokenEstimate!.source).toContain('mcp:deferred');
      expect(result[0].tokenEstimate!.source).toContain('2 tools');
    });

    it('unknown MCP server + deferred regime -> 15 * DEFAULT_UNKNOWN_MCP_TOOL_COUNT(8) + 50 = 170', async () => {
      const input: ScanResult[] = [
        {
          item: {
            name: 'unknown-mcp-xyz',
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
      // unknown server -> DEFAULT_UNKNOWN_MCP_TOOL_COUNT=8 -> 15*8+50 = 170
      const result = await enrichScanResults(input, { regime: 'deferred' });
      expect(result[0].tokenEstimate).not.toBeNull();
      expect(result[0].tokenEstimate!.tokens).toBe(170);
      expect(result[0].tokenEstimate!.source).toContain('mcp:deferred');
    });

    it('should use frontmatter-aware formula for agent item (fallback-filesize when no frontmatter)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-enrich-'));
      const filePath = join(dir, 'agent.md');
      // 800 bytes, no frontmatter → fallback-filesize: min(ceil(800/4), 500) = 200
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
      expect(result[0].tokenEstimate!.tokens).toBe(200); // 800/4=200 (fallback-filesize, no frontmatter)
      expect(result[0].tokenEstimate!.confidence).toBe('estimated');
      expect(result[0].tokenEstimate!.source).toContain('agent:fallback-filesize');
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

    it('should cap skill tokenEstimate at 500 tokens (fallback-filesize, no frontmatter)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccaudit-enrich-'));
      const skillDir = join(dir, 'deploy');
      const { mkdir: mkdirFn } = await import('node:fs/promises');
      await mkdirFn(skillDir, { recursive: true });
      // 4000 bytes -> would be 1000 tokens uncapped, but skill cap = 500
      await writeFile(join(skillDir, 'SKILL.md'), 'y'.repeat(4000));

      const input: ScanResult[] = [
        {
          item: {
            name: 'deploy',
            path: skillDir,
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
      expect(result[0].tokenEstimate!.source).toContain('skill:fallback-filesize');
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

    it('returns global + worst project total (no regime -> toolSearchOverhead=0)', () => {
      const global = makeSummary(45000);
      const projects = [makeSummary(48000, '/repo/a'), makeSummary(22000, '/repo/b')];
      const { total, globalCost, worstProject, toolSearchOverhead } = calculateWorstCaseOverhead(
        global,
        projects,
      );
      expect(total).toBe(93000);
      expect(globalCost).toBe(45000);
      expect(worstProject?.totalTokens).toBe(48000);
      expect(toolSearchOverhead).toBe(0);
    });

    it('returns only global cost when no projects', () => {
      const global = makeSummary(45000);
      const { total, worstProject, toolSearchOverhead } = calculateWorstCaseOverhead(global, []);
      expect(total).toBe(45000);
      expect(worstProject).toBeNull();
      expect(toolSearchOverhead).toBe(0);
    });

    it('returns first project as worstProject (already sorted by caller)', () => {
      const global = makeSummary(0);
      const projects = [makeSummary(99000, '/big'), makeSummary(1000, '/small')];
      const { worstProject } = calculateWorstCaseOverhead(global, projects);
      expect(worstProject?.totalTokens).toBe(99000);
    });

    it('deferred regime -> toolSearchOverhead=1700 added to total', () => {
      const global = makeSummary(45000);
      const projects = [makeSummary(48000, '/repo/a')];
      const { total, toolSearchOverhead } = calculateWorstCaseOverhead(
        global,
        projects,
        'deferred',
      );
      expect(toolSearchOverhead).toBe(1700);
      expect(total).toBe(45000 + 48000 + 1700);
    });

    it('eager regime -> toolSearchOverhead=0', () => {
      const global = makeSummary(10000);
      const projects = [makeSummary(5000, '/repo/x')];
      const { total, toolSearchOverhead } = calculateWorstCaseOverhead(global, projects, 'eager');
      expect(toolSearchOverhead).toBe(0);
      expect(total).toBe(15000);
    });

    it('unknown regime -> toolSearchOverhead=0 (pessimistic but no flat overhead)', () => {
      const global = makeSummary(10000);
      const { toolSearchOverhead } = calculateWorstCaseOverhead(global, [], 'unknown');
      expect(toolSearchOverhead).toBe(0);
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

    it('T42 memory dedup: same path appearing twice as memory items is counted once', () => {
      // Simulates: rules/foo.md scanned standalone AND referenced as import-chain depth-0
      const input: TokenCostResult[] = [
        {
          item: {
            name: 'foo',
            path: '/rules/foo.md',
            scope: 'global',
            category: 'memory',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'test' },
        },
        {
          // Same path, same category → must be deduped (counted once)
          item: {
            name: 'foo (import)',
            path: '/rules/foo.md',
            scope: 'global',
            category: 'memory',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'test' },
        },
      ];
      // Only 1000 tokens, not 2000 — memory path dedup fires
      expect(calculateTotalOverhead(input)).toBe(1000);
    });

    it('T42 regression: hooks sharing a path are NOT deduped — each contributes independently', () => {
      // 3 hook items all backed by the same settings.json file (realistic scenario).
      // Each must contribute its own tokens — path dedup must NOT fire for non-memory categories.
      const sharedPath = '/home/user/.claude/settings.json';
      const hookItem = (name: string): TokenCostResult => ({
        item: { name, path: sharedPath, scope: 'global', category: 'hook', projectPath: null },
        tier: 'dormant',
        lastUsed: null,
        invocationCount: 0,
        tokenEstimate: { tokens: 2500, confidence: 'upper-bound', source: 'hook:upper-bound' },
      });
      const input: TokenCostResult[] = [
        hookItem('SessionStart/hook-1'),
        hookItem('PreToolUse/hook-2'),
        hookItem('PostToolUse/hook-3'),
      ];
      // All 3 × 2500 = 7500 — no dedup for hooks
      const total = calculateGhostTotalOverhead(input, true);
      expect(total).toBe(7500);
    });
  });
}
