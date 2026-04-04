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
  initColor,
  csvTable,
  tsvRow,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

export const inventoryCommand = define({
  name: 'inventory',
  description: 'Show full inventory with usage statistics',
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
      if (result.meta.projectPath) projectPaths.add(result.meta.projectPath);
    }

    if (mode.verbose) console.error('[ccaudit] Scanning inventory...');

    const { results } = await scanAll(allInvocations, { projectPaths: [...projectPaths] });
    const enriched = await enrichScanResults(results);
    const healthScore = calculateHealthScore(enriched);

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some(r => r.tier !== 'used');
    const exitCode = hasGhosts ? 1 : 0;

    // Output routing (in order of precedence)
    if (mode.json) {
      const envelope = buildJsonEnvelope('inventory', sinceStr, exitCode, {
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

    // Set exit code: inventory exits 1 when ghosts found (per D-01)
    if (hasGhosts) {
      process.exitCode = 1;
    }
  },
});
