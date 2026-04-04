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
  initColor,
  csvTable,
  tsvRow,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

export const mcpCommand = define({
  name: 'mcp',
  description: 'Show MCP server token costs (use --live for exact counts)',
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
            if (mode.verbose) {
              console.error(`[ccaudit] ${r.item.name}: live measurement not available (${String(transport)} transport) -- using estimate`);
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
              console.error(`[ccaudit] ${r.item.name}: measurement failed (${(err as Error).message}) -- using estimate`);
            }
            return r;
          }
        }),
      );
    }

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some(r => r.tier !== 'used');
    const exitCode = hasGhosts ? 1 : 0;

    // Step 7: Display results
    if (mode.json) {
      const totalTokens = calculateTotalOverhead(enriched);
      const healthScore = calculateHealthScore(enriched);
      const envelope = buildJsonEnvelope('mcp', sinceStr, exitCode, {
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
      });
      const indent = mode.quiet ? 0 : 2;
      console.log(JSON.stringify(envelope, null, indent));
    } else if (mode.csv) {
      // CSV output (RFC 4180 per D-18, D-19)
      const headers = ['name', 'category', 'tier', 'lastUsed', 'tokens', 'recommendation', 'confidence'];
      const rows = enriched.map(r => [
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
        console.log(tsvRow([
          r.item.name,
          r.item.category,
          r.tier,
          r.lastUsed?.toISOString() ?? 'never',
          String(r.tokenEstimate?.tokens ?? 0),
          classifyRecommendation(r.tier),
        ]));
      }
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
    });
  });
}
