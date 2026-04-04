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
  classifyRecommendation,
} from '@ccaudit/internal';
import type { InvocationRecord, TokenCostResult } from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderMcpTable,
  renderHealthScore,
} from '@ccaudit/terminal';

export const mcpCommand = define({
  name: 'mcp',
  description: 'Show MCP server token costs (use --live for exact counts)',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d, 2w)',
      default: '7d',
    },
    live: {
      type: 'boolean',
      short: 'l',
      description: 'Connect to MCP servers for exact token counts',
      default: false,
    },
    timeout: {
      type: 'string',
      short: 't',
      description: 'Timeout per server in ms (for --live)',
      default: '15000',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'Output as JSON',
      default: false,
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Show scan details',
      default: false,
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

    const timeoutMs = Number.parseInt(ctx.values.timeout ?? '15000', 10);

    if (ctx.values.verbose) {
      console.log(`Scanning sessions (window: ${sinceStr})...`);
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
    const mcpResults = results.filter(r => r.item.category === 'mcp-server');

    // Step 5: Enrich with token estimates
    let enriched: TokenCostResult[] = await enrichScanResults(mcpResults);

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
            const transport = (serverConfig as Record<string, unknown> | undefined)?.type ?? 'unknown';
            if (ctx.values.verbose) {
              console.log(`  ${r.item.name}: live measurement not available (${String(transport)} transport) -- using estimate`);
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
            if (ctx.values.verbose) {
              console.log(`  ${r.item.name}: measurement failed (${(err as Error).message}) -- using estimate`);
            }
            return r;
          }
        }),
      );
    }

    // Step 7: Display results
    if (ctx.values.json) {
      const totalTokens = calculateTotalOverhead(enriched);
      const healthScore = calculateHealthScore(enriched);
      console.log(JSON.stringify({
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
        items: enriched.map(r => ({
          name: r.item.name,
          scope: r.item.scope,
          tier: r.tier,
          invocations: r.invocationCount,
          lastUsed: r.lastUsed?.toISOString() ?? null,
          projectPath: r.item.projectPath,
          tokenEstimate: r.tokenEstimate ? {
            tokens: r.tokenEstimate.tokens,
            confidence: r.tokenEstimate.confidence,
            source: r.tokenEstimate.source,
          } : null,
          recommendation: classifyRecommendation(r.tier),
        })),
      }, null, 2));
    } else {
      console.log('');
      const modeLabel = ctx.values.live ? ' (live)' : '';
      console.log(renderHeader('\u{1F50C}', `MCP Servers${modeLabel}`, humanizeSinceWindow(sinceStr)));
      console.log('');

      if (enriched.length === 0) {
        console.log('No MCP servers found in inventory.');
      } else {
        console.log(renderMcpTable(enriched));
        console.log('');

        const totalOverhead = calculateTotalOverhead(enriched);
        if (totalOverhead > 0) {
          console.log(`Total MCP overhead: ${formatTotalOverhead(totalOverhead)}`);
        }
      }

      console.log('');
      console.log(renderHealthScore(calculateHealthScore(enriched)));
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
    });
  });
}
