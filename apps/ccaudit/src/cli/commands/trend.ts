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
  initColor,
  csvTable,
  tsvRow,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

export const trendCommand = define({
  name: 'trend',
  description: 'Show invocation frequency over time',
  args: {
    ...outputArgs,
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for analysis (e.g., 7d, 30d, 2w)',
      default: '7d',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'Output as JSON (see docs/JSON-SCHEMA.md for schema)',
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
    initColor();

    // Resolve output mode from all flag values
    const mode = resolveOutputMode(ctx.values);

    if (mode.verbose) {
      console.error(`[ccaudit] Scanning sessions (window: ${sinceStr})...`);
    }

    const files = await discoverSessionFiles({ sinceMs });
    if (mode.verbose) {
      console.error(`[ccaudit] Found ${files.length} session file(s)`);
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

    // trend always exits 0 (per D-01) -- no ghost-based exit code
    const exitCode = 0;

    // Output routing (in order of precedence)
    if (mode.json) {
      const envelope = buildJsonEnvelope('trend', sinceStr, exitCode, {
        window: sinceStr,
        files: files.length,
        buckets,
        healthScore: {
          score: healthScore.score,
          grade: healthScore.grade,
          ghostPenalty: healthScore.ghostPenalty,
          tokenPenalty: healthScore.tokenPenalty,
        },
      });
      const indent = mode.quiet ? 0 : 2;
      console.log(JSON.stringify(envelope, null, indent));
    } else if (mode.csv) {
      // CSV output -- trend uses different schema per D-20
      const headers = ['date', 'bucket', 'agents', 'skills', 'mcp', 'total'];
      const rows = buckets.map(b => [
        b.period,
        b.period,
        String(b.agents),
        String(b.skills),
        String(b.mcp),
        String(b.total),
      ]);
      console.log(csvTable(headers, rows, !mode.quiet));
    } else if (mode.quiet) {
      // TSV output (per D-09)
      for (const b of buckets) {
        console.log(tsvRow([
          b.period,
          String(b.agents),
          String(b.skills),
          String(b.mcp),
          String(b.total),
        ]));
      }
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

    // trend NEVER sets exit code based on ghosts (per D-01)
    // (exit code remains whatever parseDuration may have set, or 0)
  },
});
