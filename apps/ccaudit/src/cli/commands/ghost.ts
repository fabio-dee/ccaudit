import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateTotalOverhead,
  formatTotalOverhead,
  calculateHealthScore,
  classifyRecommendation,
} from '@ccaudit/internal';
import type { InvocationRecord, CategorySummary } from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderGhostSummary,
  renderTopGhosts,
  renderGhostFooter,
  renderHealthScore,
  initColor,
  csvTable,
  tsvRow,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  args: {
    ...outputArgs,
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d, 2w)',
      default: '7d',
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

    // Initialize color detection from process.argv (--no-color) and env (NO_COLOR)
    // Must be called before ANY rendering. Takes no arguments per D-07.
    initColor();

    // Resolve output mode from all flag values
    const mode = resolveOutputMode(ctx.values);

    if (mode.verbose) {
      console.error(`[ccaudit] Scanning sessions (window: ${sinceStr})...`);
    }

    // Step 1: Discover session files
    const files = await discoverSessionFiles({ sinceMs });

    if (mode.verbose) {
      console.error(`[ccaudit] Found ${files.length} session file(s)`);
    }

    if (files.length === 0) {
      if (!mode.quiet && !mode.json && !mode.csv) {
        console.log('No session files found. Check that Claude Code has been used recently.');
        console.log('Session files are stored in ~/.claude/projects/ and ~/.config/claude/projects/');
      }
      return;
    }

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
    if (mode.verbose) {
      console.error('[ccaudit] Scanning inventory...');
    }

    const { results } = await scanAll(allInvocations, {
      projectPaths: [...projectPaths],
    });

    // Step 3.5: Enrich with token estimates
    const enriched = await enrichScanResults(results);

    // Step 4: Calculate health score
    const healthScore = calculateHealthScore(enriched);

    // Step 5: Filter to ghosts only
    const ghosts = enriched.filter(r => r.tier !== 'used');

    // Step 6: Build category summaries
    const categories = ['agent', 'skill', 'mcp-server', 'memory'] as const;
    const summaries: CategorySummary[] = categories.map(cat => {
      const catItems = enriched.filter(r => r.item.category === cat);
      const catUsed = catItems.filter(r => r.tier === 'used');
      const catGhosts = catItems.filter(r => r.tier !== 'used');
      const tokenCost = catGhosts.reduce(
        (sum, r) => sum + (r.tokenEstimate?.tokens ?? 0),
        0,
      );
      return {
        category: cat,
        defined: catItems.length,
        used: catUsed.length,
        ghost: catGhosts.length,
        tokenCost,
      };
    });

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some(r => r.tier !== 'used');
    const exitCode = hasGhosts ? 1 : 0;

    // Output routing (in order of precedence per D-17)
    if (mode.json) {
      // JSON with meta envelope
      const totalTokens = calculateTotalOverhead(ghosts);
      const envelope = buildJsonEnvelope('ghost', sinceStr, exitCode, {
        window: sinceStr,
        files: files.length,
        projects: projectPaths.size,
        inventory: enriched.length,
        ghosts: {
          total: ghosts.length,
          likely: ghosts.filter(r => r.tier === 'likely-ghost').length,
          definite: ghosts.filter(r => r.tier === 'definite-ghost').length,
        },
        healthScore: {
          score: healthScore.score,
          grade: healthScore.grade,
          ghostPenalty: healthScore.ghostPenalty,
          tokenPenalty: healthScore.tokenPenalty,
        },
        totalOverhead: {
          tokens: totalTokens,
        },
        items: ghosts.map(r => ({
          name: r.item.name,
          category: r.item.category,
          scope: r.item.scope,
          tier: r.tier,
          lastUsed: r.lastUsed?.toISOString() ?? null,
          invocations: r.invocationCount,
          path: r.item.path,
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
      // Default rendered output (tables, headers, footer)
      console.log('');
      console.log(renderHeader('\u{1F47B}', 'Ghost Inventory', humanizeSinceWindow(sinceStr)));
      console.log('');
      console.log(renderGhostSummary(summaries));
      console.log('');

      const totalOverhead = calculateTotalOverhead(ghosts);
      if (totalOverhead > 0) {
        console.log(`Total ghost overhead: ${formatTotalOverhead(totalOverhead)}`);
        console.log('');
      }

      if (ghosts.length === 0) {
        console.log('No ghosts found. Your inventory is clean!');
      } else {
        const topGhostsStr = renderTopGhosts(ghosts, 5);
        if (topGhostsStr) {
          console.log(topGhostsStr);
          console.log('');
        }
      }

      console.log(renderHealthScore(healthScore));
      console.log('');
      console.log(renderGhostFooter(sinceStr));
    }

    // Set exit code: ghost/inventory/mcp exit 1 when ghosts found (per D-01, D-02, D-03)
    if (hasGhosts) {
      process.exitCode = 1;
    }
  },
});
