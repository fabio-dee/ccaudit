import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  buildTrendData,
  scanAll,
  enrichScanResults,
  calculateHealthScore,
} from '@ccaudit/internal';
import type { InvocationRecord } from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderTrendTable,
  renderHealthScore,
} from '@ccaudit/terminal';

export const trendCommand = define({
  name: 'trend',
  description: 'Show invocation frequency over time',
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
      if (result.meta.projectPath) {
        projectPaths.add(result.meta.projectPath);
      }
    }

    const buckets = buildTrendData(allInvocations, sinceMs);

    // Run inventory scan for health score calculation
    const { results } = await scanAll(allInvocations, {
      projectPaths: [...projectPaths],
    });
    const enriched = await enrichScanResults(results);
    const healthScore = calculateHealthScore(enriched);

    if (ctx.values.json) {
      console.log(JSON.stringify({
        window: sinceStr,
        files: files.length,
        buckets,
        healthScore: {
          score: healthScore.score,
          grade: healthScore.grade,
          ghostPenalty: healthScore.ghostPenalty,
          tokenPenalty: healthScore.tokenPenalty,
        },
      }, null, 2));
    } else {
      console.log('');
      console.log(renderHeader('\u{1F4C8}', 'Invocation Trend', humanizeSinceWindow(sinceStr)));
      console.log('');

      if (buckets.length === 0 || buckets.every(b => b.total === 0)) {
        console.log('No invocation data found for the selected window.');
        console.log('Try a longer window: ccaudit trend --since 30d');
      } else {
        console.log(renderTrendTable(buckets));
      }

      console.log('');
      console.log(renderHealthScore(healthScore));
    }
  },
});
