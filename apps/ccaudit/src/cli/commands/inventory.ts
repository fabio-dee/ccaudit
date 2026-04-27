import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateHealthScore,
  calculateUrgencyScore,
  classifyRecommendation,
  groupByFramework,
  toGhostItems,
  detectClaudeCodeVersion,
  resolveMcpRegime,
  regimeFlatOverhead,
  CONTEXT_WINDOW_SIZE,
} from '@ccaudit/internal';
import type {
  InvocationRecord,
  FrameworkGroup,
  GroupedInventory,
  McpRegime,
} from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderFrameworksSection,
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

    // Detect Claude Code version once (only needed when regime is 'auto').
    // Degrade gracefully on detection failure: null triggers the unknown-version path.
    let detectedCcVersion: string | null = null;
    if (regimeFlag === 'auto') {
      try {
        detectedCcVersion = await detectClaudeCodeVersion();
      } catch (err) {
        console.error(
          `[ccaudit] warning: version detection failed (${(err as Error).message ?? err}); defaulting to unknown-version regime`,
        );
        detectedCcVersion = null;
      }
    }

    // Initialize color detection from process.argv (--no-color) and env (NO_COLOR)
    initColor();

    // Resolve output mode from all flag values.
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
    const enriched = await enrichScanResults(results, {
      regime: regimeFlag,
      ccVersion: detectedCcVersion,
    });
    const healthScore = calculateHealthScore(enriched);

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some((r) => r.tier !== 'used');
    const exitCode = hasGhosts ? 1 : 0;

    // Framework grouping (v1.3.0 D-22). Computed once, reused by terminal +
    // JSON + CSV + TSV output paths.
    const grouped: GroupedInventory = mode.groupFrameworks
      ? groupByFramework(toGhostItems(enriched))
      : { frameworks: [], ungrouped: [] };

    // Sort frameworks by displayName ASC (case-insensitive) per OUT-04.
    const sortedFrameworks: FrameworkGroup[] = grouped.frameworks
      .slice()
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
      );

    // Build Map<itemPath, frameworkId | null> for renderInventoryTable D-21
    // (default-mode filter + verbose-mode column cell lookup). Populated only
    // when grouping is active so the render helper falls back to v1.2.1 layout
    // when --no-group-frameworks is set.
    //
    // Seed FIRST from grouped.frameworks[].members — annotateFrameworks only
    // sets item.framework for Tier-1 curated matches, but Tier-2 heuristic
    // groups (e.g., a `foo-*` cluster of 3+ items) assemble members whose
    // item.framework is still null. Keying off item.framework alone would
    // leak heuristic members past the default-mode filter. Then layer
    // item.framework on top for anything not already covered by an actual
    // group (should be empty in practice, but keeps the invariant explicit).
    let fwMap: Map<string, string | null> | undefined;
    if (mode.groupFrameworks) {
      fwMap = new Map();
      for (const fw of grouped.frameworks) {
        for (const m of fw.members) fwMap.set(m.path, fw.id);
      }
      for (const r of enriched) {
        if (!fwMap.has(r.item.path)) {
          fwMap.set(r.item.path, r.item.framework ?? null);
        }
      }
    }
    const resolveFramework = (r: (typeof enriched)[number]): string | null =>
      fwMap?.get(r.item.path) ?? r.item.framework ?? null;

    // Resolve final regime for JSON envelope meta (matches ghost.ts logic)
    let resolvedRegime: McpRegime;
    if (regimeFlag === 'auto') {
      const eagerMcpTotal = enriched
        .filter((r) => r.item.category === 'mcp-server')
        .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
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

    // Output routing (in order of precedence)
    if (mode.json) {
      const frameworksProjection =
        mode.groupFrameworks && sortedFrameworks.length > 0
          ? sortedFrameworks.map((f) => ({
              id: f.id,
              displayName: f.displayName,
              source_type: f.source_type,
              status: f.status,
              totals: f.totals,
              memberCount: f.totals.defined,
            }))
          : undefined;

      const envelope = buildJsonEnvelope(
        'inventory',
        sinceStr,
        exitCode,
        {
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
          ...(frameworksProjection !== undefined ? { frameworks: frameworksProjection } : {}),
          items: enriched.map((r) => ({
            name: r.item.name,
            category: r.item.category,
            scope: r.item.scope,
            tier: r.tier,
            lastUsed: r.lastUsed?.toISOString() ?? null,
            invocations: r.invocationCount,
            path: r.item.path,
            projectPath: r.item.projectPath,
            tokenEstimate: r.tokenEstimate
              ? {
                  tokens: r.tokenEstimate.tokens,
                  confidence: r.tokenEstimate.confidence,
                  source: r.tokenEstimate.source,
                }
              : null,
            recommendation: classifyRecommendation(r.tier),
            ...(mode.groupFrameworks ? { framework: resolveFramework(r) } : {}),
            ...calculateUrgencyScore(r.lastUsed, r.tokenEstimate),
            // Phase 5: import-chain additive fields (only emitted for import rows)
            ...(r.item.importDepth !== undefined
              ? {
                  importDepth: r.item.importDepth,
                  importRoot: r.item.importRoot,
                }
              : {}),
          })),
        },
        { mcpRegime: resolvedRegime, toolSearchOverhead },
      );
      const indent = mode.quiet ? 0 : 2;
      console.log(JSON.stringify(envelope, null, indent));
    } else if (mode.csv) {
      // CSV output (RFC 4180 per D-18, D-19)
      const appendFramework = mode.verbose && mode.groupFrameworks;
      const headers = [
        'name',
        'category',
        'tier',
        'lastUsed',
        'tokens',
        'recommendation',
        'confidence',
        ...(appendFramework ? ['framework'] : []),
      ];
      const rows = enriched.map((r) => [
        r.item.name,
        r.item.category,
        r.tier,
        r.lastUsed?.toISOString() ?? 'never',
        String(r.tokenEstimate?.tokens ?? 0),
        classifyRecommendation(r.tier),
        r.tokenEstimate?.confidence ?? 'none',
        ...(appendFramework ? [resolveFramework(r) ?? ''] : []),
      ]);
      console.log(csvTable(headers, rows, !mode.quiet));
    } else if (mode.quiet) {
      // TSV output (per D-09)
      const appendFramework = mode.verbose && mode.groupFrameworks;
      for (const r of enriched) {
        console.log(
          tsvRow([
            r.item.name,
            r.item.category,
            r.tier,
            r.lastUsed?.toISOString() ?? 'never',
            String(r.tokenEstimate?.tokens ?? 0),
            classifyRecommendation(r.tier),
            ...(appendFramework ? [resolveFramework(r) ?? ''] : []),
          ]),
        );
      }
    } else {
      console.log('');
      console.log(renderHeader('\u{1F4E6}', 'Inventory', humanizeSinceWindow(sinceStr)));
      console.log('');

      if (enriched.length === 0) {
        console.log('No items found in inventory.');
      } else {
        // D-18: Prepend Frameworks section when grouping is active and any
        // frameworks detected. Omitted in empty/null cases — the helper
        // returns '' when groups is empty.
        if (mode.groupFrameworks && sortedFrameworks.length > 0) {
          const frameworksOut = renderFrameworksSection(sortedFrameworks, {
            verbose: mode.verbose,
          });
          if (frameworksOut !== '') {
            console.log(frameworksOut);
            console.log('');
          }
        }

        // D-21: pass the framework-column map + verbose flag. When grouping
        // is disabled (fwMap === undefined), renderInventoryTable renders the
        // v1.2.1 7-column layout byte-identical to v1.2.1.
        console.log(
          renderInventoryTable(enriched, {
            verbose: mode.verbose,
            frameworkColumnValues: fwMap,
          }),
        );
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
