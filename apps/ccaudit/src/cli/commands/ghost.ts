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
  buildChangePlan,
  computeGhostHash,
  writeCheckpoint,
  resolveCheckpointPath,
} from '@ccaudit/internal';
import type { InvocationRecord, CategorySummary, Checkpoint } from '@ccaudit/internal';
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
  renderChangePlan,
  renderChangePlanVerbose,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';
import { CCAUDIT_VERSION } from '../../_version.ts';

export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  // Convert camelCase arg keys to kebab-case on the CLI so `dryRun` is
  // exposed as `--dry-run` (the documented flag name in Phase 7 contracts
  // and in the SUMMARY/RESEARCH docs). Without this, gunshi preserves the
  // literal key name and the flag would be `--dryRun`, which is unusable
  // for end users and contradicts the Plan 02 contract.
  toKebab: true,
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
      description: 'Output as JSON (see docs/JSON-SCHEMA.md for schema)',
      default: false,
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Show scan details',
      default: false,
    },
    dryRun: {
      type: 'boolean',
      description:
        'Preview changes without mutating files (writes checkpoint to ~/.claude/ccaudit/.last-dry-run)',
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
        console.log(
          'Session files are stored in ~/.claude/projects/ and ~/.config/claude/projects/',
        );
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

    // Step 3.6: Dry-run branch (Phase 7, D-01 through D-20)
    // Lifted before the inventory rendering chain per RESEARCH §CLI Integration —
    // single decision point, four output modes per command mode (8 test cases total).
    if (ctx.values.dryRun) {
      const plan = buildChangePlan(enriched);

      // Compute the hash over archive-eligible items (D-10 through D-16)
      const ghostHash = await computeGhostHash(enriched);

      // Build the checkpoint object (D-17 schema — all 7 fields mandatory)
      const checkpoint: Checkpoint = {
        checkpoint_version: 1,
        ccaudit_version: CCAUDIT_VERSION,
        timestamp: new Date().toISOString(),
        since_window: sinceStr,
        ghost_hash: ghostHash,
        item_count: plan.counts,
        savings: plan.savings,
      };

      // Render to stdout FIRST per D-20 (user sees output even if checkpoint write fails)
      if (mode.json) {
        // D-02: dry-run honors --json. Envelope payload = { dryRun, changePlan, checkpoint }.
        const envelope = buildJsonEnvelope('ghost', sinceStr, 0, {
          dryRun: true,
          changePlan: {
            archive: plan.archive,
            disable: plan.disable,
            flag: plan.flag,
            counts: plan.counts,
            savings: plan.savings,
          },
          checkpoint: {
            path: resolveCheckpointPath(),
            ghost_hash: ghostHash,
            timestamp: checkpoint.timestamp,
            ccaudit_version: checkpoint.ccaudit_version,
            checkpoint_version: checkpoint.checkpoint_version,
          },
        });
        const indent = mode.quiet ? 0 : 2;
        console.log(JSON.stringify(envelope, null, indent));
      } else if (mode.csv) {
        // D-02: dry-run honors --csv. Schema: action,category,name,scope,projectPath,path,tokens,tier
        const headers = [
          'action',
          'category',
          'name',
          'scope',
          'projectPath',
          'path',
          'tokens',
          'tier',
        ];
        const rows = [...plan.archive, ...plan.disable, ...plan.flag].map((i) => [
          i.action,
          i.category,
          i.name,
          i.scope,
          i.projectPath ?? '',
          i.path,
          String(i.tokens),
          i.tier,
        ]);
        console.log(csvTable(headers, rows, !mode.quiet));
      } else if (mode.quiet) {
        // D-02: dry-run honors --quiet. TSV with same 8 columns as CSV, no header.
        for (const item of [...plan.archive, ...plan.disable, ...plan.flag]) {
          console.log(
            tsvRow([
              item.action,
              item.category,
              item.name,
              item.scope,
              item.projectPath ?? '',
              item.path,
              String(item.tokens),
              item.tier,
            ]),
          );
        }
      } else {
        // Default rendered output (D-05, D-06): header + grouped body + verbose + checkpoint footer
        console.log('');
        console.log(renderHeader('\u{1F47B}', 'Dry-Run', humanizeSinceWindow(sinceStr)));
        console.log('');
        console.log(renderChangePlan(plan));
        console.log('');
        if (mode.verbose) {
          console.log(renderChangePlanVerbose(plan));
          console.log('');
        }
        // Footer (D-05): replaces the Phase 5 "Dry-run coming in v1.1" line
        console.log(`Checkpoint: ${resolveCheckpointPath()}`);
        console.log(`Next: ccaudit --dangerously-bust-ghosts`);
      }

      // Checkpoint write happens LAST. Any error converts to exit code 2 (D-20).
      try {
        await writeCheckpoint(checkpoint, resolveCheckpointPath());
      } catch (err) {
        console.error(`[ccaudit] Failed to write checkpoint: ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }

      // D-03, D-04: dry-run exits 0 on success even when plan is empty
      return;
    }

    // Step 4: Calculate health score
    const healthScore = calculateHealthScore(enriched);

    // Step 5: Filter to ghosts only
    const ghosts = enriched.filter((r) => r.tier !== 'used');

    // Step 6: Build category summaries
    const categories = ['agent', 'skill', 'mcp-server', 'memory'] as const;
    const summaries: CategorySummary[] = categories.map((cat) => {
      const catItems = enriched.filter((r) => r.item.category === cat);
      const catUsed = catItems.filter((r) => r.tier === 'used');
      const catGhosts = catItems.filter((r) => r.tier !== 'used');
      const tokenCost = catGhosts.reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
      return {
        category: cat,
        defined: catItems.length,
        used: catUsed.length,
        ghost: catGhosts.length,
        tokenCost,
      };
    });

    // Determine exit code: 1 if ghosts found (per D-01)
    const hasGhosts = enriched.some((r) => r.tier !== 'used');
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
          likely: ghosts.filter((r) => r.tier === 'likely-ghost').length,
          definite: ghosts.filter((r) => r.tier === 'definite-ghost').length,
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
        items: ghosts.map((r) => ({
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
        })),
      });
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
