import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateTotalOverhead,
  formatTotalOverhead,
  readClaudeConfig,
  measureMcpTokens,
  calculateHealthScore,
  calculateUrgencyScore,
  classifyRecommendation,
  detectClaudeCodeVersion,
  resolveMcpRegime,
  regimeFlatOverhead,
  CONTEXT_WINDOW_SIZE,
} from '@ccaudit/internal';
import type { InvocationRecord, TokenCostResult, McpRegime } from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderMcpTable,
  renderHealthScore,
  initColor,
  csvTable,
  tsvRow,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

/**
 * Aggregate enriched MCP results by server name for presentation output.
 *
 * Rationale (Gap #5 fix): scan-mcp.ts dedups per (projectPath::serverName) for Phase 8
 * RMED-06 traceability, producing 1 row per (server, project) pair. For the user-facing
 * mcp view, the same server in 2 .mcp.json files is 1 logical server with 2 source
 * configs — collapse by name here so CSV/table/JSON/TSV output shows one row per server.
 *
 * Merge semantics:
 *   tier            — least ghost wins: used > likely-ghost > definite-ghost
 *   lastUsed        — max (most recent) across the group
 *   invocationCount — sum across the group
 *   tokenEstimate   — identical per server name, take any representative
 *   projectPath     — null (aggregated view)
 *   projectPaths    — array of source projectPath values, for JSON traceability
 *   other item fields — any representative
 *
 * Scanner stays untouched — Phase 8 RMED-06 still knows which config key(s) to rewrite.
 */
export function aggregateMcpByName(enriched: TokenCostResult[]): TokenCostResult[] {
  const tierRank = { used: 0, 'likely-ghost': 1, 'definite-ghost': 2, dormant: 3 } as const;
  const groups = new Map<string, TokenCostResult[]>();
  for (const r of enriched) {
    const key = r.item.name;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      groups.set(key, [r]);
    }
  }

  const aggregated: TokenCostResult[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      // Single-instance server: pass through, but attach projectPaths for JSON traceability.
      const only = group[0]!;
      const projectPaths = only.item.projectPath ? [only.item.projectPath] : [];
      aggregated.push({
        ...only,
        item: { ...only.item, projectPaths } as typeof only.item & { projectPaths: string[] },
      });
      continue;
    }

    // Multi-instance: merge.
    let bestTier = group[0]!.tier;
    for (const r of group) {
      if (tierRank[r.tier] < tierRank[bestTier]) bestTier = r.tier;
    }

    let maxLastUsed: Date | null = null;
    for (const r of group) {
      if (r.lastUsed && (!maxLastUsed || r.lastUsed > maxLastUsed)) {
        maxLastUsed = r.lastUsed;
      }
    }

    const totalInvocations = group.reduce((sum, r) => sum + r.invocationCount, 0);
    const representative = group[0]!;
    const projectPaths = group
      .map((r) => r.item.projectPath)
      .filter((p): p is string => p !== null);

    aggregated.push({
      item: {
        ...representative.item,
        projectPath: null,
        projectPaths,
      } as typeof representative.item & { projectPaths: string[] },
      tier: bestTier,
      lastUsed: maxLastUsed,
      invocationCount: totalInvocations,
      tokenEstimate: representative.tokenEstimate,
    });
  }

  return aggregated;
}

export const mcpCommand = define({
  name: 'mcp',
  description:
    'Show MCP server token costs (use --live to run configured servers locally for exact counts)',
  args: {
    ...outputArgs,
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d, 2w)',
      default: '7d',
    },
    live: {
      type: 'boolean',
      short: 'l',
      description: 'Connect to locally configured MCP servers for exact token counts',
      default: false,
    },
    timeout: {
      type: 'string',
      short: 't',
      description: 'Timeout per locally configured server in ms (for --live)',
      default: '15000',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'JSON output (docs/JSON-SCHEMA.md)',
      default: false,
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Show scan details',
      default: false,
    },
    regime: {
      type: 'string',
      description:
        'MCP token regime: eager (full schemas), deferred (ToolSearch, cc >=2.1.7), or auto (detect). Default: auto.',
      default: 'auto',
    },
  },
  async run(ctx) {
    const sinceStr = ctx.values.since ?? '7d';
    let sinceMs: number;
    try {
      sinceMs = parseDuration(sinceStr);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    // Validate and resolve --regime flag
    const regimeRaw = ctx.values.regime ?? 'auto';
    if (regimeRaw !== 'eager' && regimeRaw !== 'deferred' && regimeRaw !== 'auto') {
      console.error(
        `error: invalid --regime value "${regimeRaw}". Must be one of: eager, deferred, auto`,
      );
      process.exitCode = 1;
      return;
    }
    const regimeFlag = regimeRaw as McpRegime | 'auto';

    // Detect Claude Code version once (only needed when regime is 'auto')
    let detectedCcVersion: string | null = null;
    if (regimeFlag === 'auto') {
      detectedCcVersion = await detectClaudeCodeVersion();
    }

    const timeoutMs = Number.parseInt(ctx.values.timeout ?? '15000', 10);

    // Initialize color detection from process.argv (--no-color) and env (NO_COLOR)
    initColor();

    // Resolve output mode from all flag values
    const mode = resolveOutputMode(ctx.values);

    if (mode.verbose) {
      console.error(`[ccaudit] Scanning sessions (window: ${sinceStr})...`);
    }

    // Step 1: Discover session files
    const files = await discoverSessionFiles({ sinceMs });

    // Step 2: Parse all session files
    const allInvocations: InvocationRecord[] = [];
    const projectPaths = new Set<string>();

    for (const file of files) {
      const result = await parseSession(file, sinceMs);
      allInvocations.push(...result.invocations);
      if (result.meta.projectPath) {
        projectPaths.add(result.meta.projectPath);
      }
    }

    // Step 3: Run inventory scanner
    const { results } = await scanAll(allInvocations, {
      projectPaths: [...projectPaths],
    });

    // Step 4: Filter to MCP server items only
    const mcpResults = results.filter((r) => r.item.category === 'mcp-server');

    // Step 5: Enrich with token estimates (regime-aware)
    let enriched: TokenCostResult[] = await enrichScanResults(mcpResults, {
      regime: regimeFlag,
      ccVersion: detectedCcVersion,
    });

    // Step 6: Live measurement (if --live flag)
    if (ctx.values.live) {
      const config = await readClaudeConfig();
      const allServerConfigs: Record<string, unknown> = {
        ...(config.mcpServers ?? {}),
      };
      // Merge per-project server configs
      for (const projConfig of Object.values(config.projects ?? {})) {
        Object.assign(allServerConfigs, projConfig.mcpServers ?? {});
      }

      enriched = await Promise.all(
        enriched.map(async (r) => {
          const serverConfig = allServerConfigs[r.item.name] as Record<string, unknown> | undefined;
          if (!serverConfig || typeof serverConfig.command !== 'string') {
            const transport =
              (serverConfig as Record<string, unknown> | undefined)?.type ?? 'unknown';
            if (mode.verbose) {
              console.error(
                `[ccaudit] ${r.item.name}: live measurement not available (${String(transport)} transport) -- using estimate`,
              );
            }
            return r;
          }

          try {
            const measured = await measureMcpTokens(
              {
                command: serverConfig.command as string,
                args: serverConfig.args as string[] | undefined,
                env: serverConfig.env as Record<string, string> | undefined,
                type: serverConfig.type as string | undefined,
              },
              timeoutMs,
            );
            return {
              ...r,
              tokenEstimate: {
                tokens: measured.tokens,
                confidence: measured.confidence,
                source: measured.source,
              },
            };
          } catch (err) {
            if (mode.verbose) {
              console.error(
                `[ccaudit] ${r.item.name}: measurement failed (${(err as Error).message}) -- using estimate`,
              );
            }
            return r;
          }
        }),
      );
    }

    // Gap #5 fix: aggregate per server name for presentation — scanner keeps per-project
    // dedup for Phase 8 RMED-06; this is the user-facing collapse so CSV/table/JSON/TSV
    // show one row per server, not one per (server, project) pair.
    enriched = aggregateMcpByName(enriched);

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some((r) => r.tier !== 'used');
    const exitCode = hasGhosts ? 1 : 0;

    // Resolve final regime for JSON envelope meta (matches ghost.ts logic)
    let resolvedRegime: McpRegime;
    if (regimeFlag === 'auto') {
      const eagerMcpTotal = enriched.reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
      resolvedRegime = resolveMcpRegime({
        totalMcpToolTokens: eagerMcpTotal,
        contextWindow: CONTEXT_WINDOW_SIZE,
        ccVersion: detectedCcVersion,
        override: null,
      }).regime;
    } else {
      resolvedRegime = regimeFlag;
    }
    const toolSearchOverhead = regimeFlatOverhead(resolvedRegime);

    // Step 7: Display results
    if (mode.json) {
      const totalTokens = calculateTotalOverhead(enriched);
      const healthScore = calculateHealthScore(enriched);
      const envelope = buildJsonEnvelope(
        'mcp',
        sinceStr,
        exitCode,
        {
          window: sinceStr,
          live: ctx.values.live ?? false,
          servers: enriched.length,
          totalOverhead: {
            tokens: totalTokens,
          },
          healthScore: {
            score: healthScore.score,
            grade: healthScore.grade,
            ghostPenalty: healthScore.ghostPenalty,
            tokenPenalty: healthScore.tokenPenalty,
          },
          items: enriched.map((r) => {
            const itemWithPaths = r.item as typeof r.item & { projectPaths?: string[] };
            return {
              name: r.item.name,
              scope: r.item.scope,
              tier: r.tier,
              invocations: r.invocationCount,
              lastUsed: r.lastUsed?.toISOString() ?? null,
              projectPath: r.item.projectPath,
              projectPaths:
                itemWithPaths.projectPaths ?? (r.item.projectPath ? [r.item.projectPath] : []),
              tokenEstimate: r.tokenEstimate
                ? {
                    tokens: r.tokenEstimate.tokens,
                    confidence: r.tokenEstimate.confidence,
                    source: r.tokenEstimate.source,
                  }
                : null,
              recommendation: classifyRecommendation(r.tier),
              ...calculateUrgencyScore(r.lastUsed, r.tokenEstimate),
            };
          }),
        },
        { mcpRegime: resolvedRegime, toolSearchOverhead },
      );
      const indent = mode.quiet ? 0 : 2;
      console.log(JSON.stringify(envelope, null, indent));
    } else if (mode.csv) {
      // CSV output (RFC 4180 per D-18, D-19)
      const headers = [
        'name',
        'category',
        'tier',
        'lastUsed',
        'tokens',
        'recommendation',
        'confidence',
      ];
      const rows = enriched.map((r) => [
        r.item.name,
        r.item.category,
        r.tier,
        r.lastUsed?.toISOString() ?? 'never',
        String(r.tokenEstimate?.tokens ?? 0),
        classifyRecommendation(r.tier),
        r.tokenEstimate?.confidence ?? 'none',
      ]);
      console.log(csvTable(headers, rows, !mode.quiet));
    } else if (mode.quiet) {
      // TSV output (per D-09)
      for (const r of enriched) {
        console.log(
          tsvRow([
            r.item.name,
            r.item.category,
            r.tier,
            r.lastUsed?.toISOString() ?? 'never',
            String(r.tokenEstimate?.tokens ?? 0),
            classifyRecommendation(r.tier),
          ]),
        );
      }
    } else {
      console.log('');
      const modeLabel = ctx.values.live ? ' (live)' : '';
      console.log(
        renderHeader('\u{1F50C}', `MCP Servers${modeLabel}`, humanizeSinceWindow(sinceStr)),
      );
      console.log('');

      if (enriched.length === 0) {
        console.log('No MCP servers found in inventory.');
      } else {
        console.log(renderMcpTable(enriched));
        console.log('');

        const totalOverhead = calculateTotalOverhead(enriched);
        if (totalOverhead > 0) {
          console.log(
            `Total MCP overhead: ${formatTotalOverhead(totalOverhead, totalOverhead, null)}`,
          );
        }
      }

      console.log('');
      console.log(renderHealthScore(calculateHealthScore(enriched)));
    }

    // Set exit code: mcp exits 1 when ghosts found (per D-01)
    if (hasGhosts) {
      process.exitCode = 1;
    }
  },
});

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('mcp command wiring', () => {
    it('renderMcpTable is callable', () => {
      expect(typeof renderMcpTable).toBe('function');
    });

    it('classifyRecommendation maps tiers correctly', () => {
      expect(classifyRecommendation('definite-ghost')).toBe('archive');
      expect(classifyRecommendation('likely-ghost')).toBe('monitor');
      expect(classifyRecommendation('used')).toBe('keep');
    });

    it('mcpCommand has correct name and args', () => {
      expect(mcpCommand.name).toBe('mcp');
      expect(mcpCommand.args).toBeDefined();
      const argKeys = Object.keys(mcpCommand.args!);
      expect(argKeys).toContain('since');
      expect(argKeys).toContain('json');
      expect(argKeys).toContain('verbose');
      expect(argKeys).toContain('live');
      expect(argKeys).toContain('quiet');
      expect(argKeys).toContain('csv');
      expect(argKeys).toContain('ci');
      expect(argKeys).toContain('regime');
    });
  });

  describe('aggregateMcpByName', () => {
    const makeResult = (
      name: string,
      projectPath: string | null,
      tier: 'used' | 'likely-ghost' | 'definite-ghost',
      invocationCount: number,
      lastUsed: Date | null,
    ): TokenCostResult => ({
      item: {
        name,
        path: '/fake/.mcp.json',
        scope: projectPath ? 'project' : 'global',
        category: 'mcp-server',
        projectPath,
      },
      tier,
      lastUsed,
      invocationCount,
      tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'bundled' },
    });

    it('merges duplicate server names, keeping max lastUsed and least-ghost tier', () => {
      const older = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-03-15T00:00:00Z');
      const input: TokenCostResult[] = [
        makeResult('context7', '/proj/a', 'definite-ghost', 0, null),
        makeResult('context7', '/proj/b', 'used', 5, newer),
        makeResult('context7', '/proj/c', 'likely-ghost', 1, older),
      ];

      const result = aggregateMcpByName(input);

      expect(result).toHaveLength(1);
      const row = result[0]!;
      expect(row.item.name).toBe('context7');
      expect(row.tier).toBe('used');
      expect(row.lastUsed).toEqual(newer);
      expect(row.invocationCount).toBe(6);
      expect(row.item.projectPath).toBeNull();
      const projectPaths = (row.item as typeof row.item & { projectPaths: string[] }).projectPaths;
      expect(projectPaths).toEqual(['/proj/a', '/proj/b', '/proj/c']);
    });

    it('passes through single-instance servers unchanged with projectPaths populated', () => {
      const when = new Date('2026-02-01T00:00:00Z');
      const input: TokenCostResult[] = [
        makeResult('playwright', '/proj/only', 'likely-ghost', 2, when),
      ];

      const result = aggregateMcpByName(input);

      expect(result).toHaveLength(1);
      const row = result[0]!;
      expect(row.item.name).toBe('playwright');
      expect(row.tier).toBe('likely-ghost');
      expect(row.lastUsed).toEqual(when);
      expect(row.invocationCount).toBe(2);
      const projectPaths = (row.item as typeof row.item & { projectPaths: string[] }).projectPaths;
      expect(projectPaths).toEqual(['/proj/only']);
    });
  });
}
