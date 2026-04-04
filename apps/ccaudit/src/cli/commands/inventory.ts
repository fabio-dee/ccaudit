import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateHealthScore,
  classifyRecommendation,
} from '@ccaudit/internal';
import type { InvocationRecord } from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderInventoryTable,
  renderHealthScore,
} from '@ccaudit/terminal';

export const inventoryCommand = define({
  name: 'inventory',
  description: 'Show full inventory with usage statistics',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for analysis (e.g., 7d, 30d, 2w)',
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

    if (ctx.values.verbose) {
      console.log(`Scanning sessions (window: ${sinceStr})...`);
    }

    const files = await discoverSessionFiles({ sinceMs });
    if (ctx.values.verbose) {
      console.log(`Found ${files.length} session file(s)`);
    }

    const allInvocations: InvocationRecord[] = [];
    const projectPaths = new Set<string>();
    for (const file of files) {
      const result = await parseSession(file, sinceMs);
      allInvocations.push(...result.invocations);
      if (result.meta.projectPath) projectPaths.add(result.meta.projectPath);
    }

    if (ctx.values.verbose) console.log('Scanning inventory...');

    const { results } = await scanAll(allInvocations, { projectPaths: [...projectPaths] });
    const enriched = await enrichScanResults(results);
    const healthScore = calculateHealthScore(enriched);

    if (ctx.values.json) {
      console.log(JSON.stringify({
        window: sinceStr,
        files: files.length,
        projects: projectPaths.size,
        total: enriched.length,
        healthScore: {
          score: healthScore.score,
          grade: healthScore.grade,
          ghostPenalty: healthScore.ghostPenalty,
          tokenPenalty: healthScore.tokenPenalty,
        },
        items: enriched.map(r => ({
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
      }, null, 2));
    } else {
      console.log('');
      console.log(renderHeader('\u{1F4E6}', 'Inventory', humanizeSinceWindow(sinceStr)));
      console.log('');

      if (enriched.length === 0) {
        console.log('No items found in inventory.');
      } else {
        console.log(renderInventoryTable(enriched));
      }

      console.log('');
      console.log(renderHealthScore(healthScore));
    }
  },
});
