import { rename, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { platform as osPlatform, homedir } from 'node:os';
import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateTotalOverhead,
  calculateWorstCaseOverhead,
  groupGhostsByProject,
  redactPaths,
  buildRedactionMap,
  formatTotalOverhead,
  formatSavingsLine,
  calculateHealthScore,
  calculateUrgencyScore,
  classifyRecommendation,
  buildChangePlan,
  computeGhostHash,
  writeCheckpoint,
  resolveCheckpointPath,
  runBust,
  runConfirmationCeremony,
  readCheckpoint,
  ManifestWriter,
  resolveManifestPath,
  patchFrontmatter,
  atomicWriteJson,
  defaultProcessDeps,
} from '@ccaudit/internal';
import type {
  InvocationRecord,
  CategorySummary,
  Checkpoint,
  BustResult,
  BustDeps,
} from '@ccaudit/internal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderTopGhosts,
  renderGhostFooter,
  renderGlobalBaseline,
  renderProjectsTable,
  renderProjectsVerbose,
  renderHealthScore,
  initColor,
  csvTable,
  tsvRow,
  renderChangePlan,
  renderChangePlanVerbose,
  renderShareableBlock,
  renderGhostOutputBox,
  colorize,
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
    dangerouslyBustGhosts: {
      type: 'boolean',
      description:
        'Execute the bust plan: archive ghost agents/skills, disable ghost MCP, flag stale memory. Requires a prior successful --dry-run and matching inventory hash.',
      default: false,
    },
    yesProceedBusting: {
      type: 'boolean',
      description:
        'Skip the confirmation ceremony (required for non-TTY/CI). Name is intentionally unwieldy — do not copy-paste from the internet.',
      default: false,
    },
    privacy: {
      type: 'boolean',
      description:
        'Redact real project paths from output (replaces with project-01, project-02, etc.)',
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
        console.error(`No session files found in the last ${sinceStr}.`);
        console.error('');
        console.error("Claude Code stores session logs in ~/.claude/projects/. If you've used");
        console.error('Claude Code recently, try a wider window: ccaudit --since 30d');
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

      // Compute worst-case session overhead for total_overhead checkpoint field.
      // Mirrors Step 5.5 logic: group ghosts, then sum global + worst project cost.
      const dryRunGhosts = enriched.filter((r) => r.tier !== 'used');
      const { global: dryRunGlobalSummary, projects: dryRunProjectSummaries } =
        groupGhostsByProject(dryRunGhosts, homedir());
      const dryRunRedactionMap = ctx.values.privacy
        ? buildRedactionMap(dryRunProjectSummaries)
        : null;
      const { total: dryRunWorstCaseTotal } = calculateWorstCaseOverhead(
        dryRunGlobalSummary,
        dryRunProjectSummaries,
      );

      // Build the checkpoint object (D-17 schema — all 7 fields mandatory + total_overhead)
      const checkpoint: Checkpoint = {
        checkpoint_version: 1,
        ccaudit_version: CCAUDIT_VERSION,
        timestamp: new Date().toISOString(),
        since_window: sinceStr,
        ghost_hash: ghostHash,
        item_count: plan.counts,
        savings: plan.savings,
        total_overhead: dryRunWorstCaseTotal,
      };

      const redactItem = <T extends { projectPath: string | null; path: string }>(item: T) => ({
        projectPath: item.projectPath
          ? (dryRunRedactionMap?.get(item.projectPath) ?? item.projectPath)
          : null,
        path:
          item.projectPath && dryRunRedactionMap?.has(item.projectPath)
            ? item.path.replace(item.projectPath, dryRunRedactionMap.get(item.projectPath)!)
            : item.path.replace(homedir(), '~'),
      });
      const redactItems = <T extends { projectPath: string | null; path: string }>(
        items: T[],
      ): T[] => (dryRunRedactionMap ? items.map((i) => ({ ...i, ...redactItem(i) })) : items);

      // Render to stdout FIRST per D-20 (user sees output even if checkpoint write fails)
      if (mode.json) {
        // D-02: dry-run honors --json. Envelope payload = { dryRun, changePlan, checkpoint }.
        const envelope = buildJsonEnvelope('ghost', sinceStr, 0, {
          dryRun: true,
          changePlan: {
            archive: redactItems(plan.archive),
            disable: redactItems(plan.disable),
            flag: redactItems(plan.flag),
            counts: plan.counts,
            savings: plan.savings,
          },
          checkpoint: {
            path:
              ctx.values.privacy === true
                ? resolveCheckpointPath().replace(homedir(), '~')
                : resolveCheckpointPath(),
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
        const rows = [...plan.archive, ...plan.disable, ...plan.flag].map((i) => {
          const r = dryRunRedactionMap ? redactItem(i) : i;
          return [
            i.action,
            i.category,
            i.name,
            i.scope,
            r.projectPath ?? '',
            r.path,
            String(i.tokens),
            i.tier,
          ];
        });
        console.log(csvTable(headers, rows, !mode.quiet));
      } else if (mode.quiet) {
        // D-02: dry-run honors --quiet. TSV with same 8 columns as CSV, no header.
        for (const item of [...plan.archive, ...plan.disable, ...plan.flag]) {
          const r = dryRunRedactionMap ? redactItem(item) : item;
          console.log(
            tsvRow([
              item.action,
              item.category,
              item.name,
              item.scope,
              r.projectPath ?? '',
              r.path,
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
          console.log(
            renderChangePlanVerbose(plan, {
              privacy: ctx.values.privacy === true,
              redactionMap: dryRunRedactionMap ?? undefined,
            }),
          );
          console.log('');
        }
        const checkpointDisplay =
          ctx.values.privacy === true
            ? resolveCheckpointPath().replace(homedir(), '~')
            : resolveCheckpointPath();
        console.log(`Checkpoint saved to ${checkpointDisplay}`);
        console.log(`Review the plan above. When ready: ccaudit --dangerously-bust-ghosts`);
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

    // Step 3.7: Bust branch (Phase 8, D-01 through D-18)
    // Runs AFTER the existing scan+enrich pipeline for the ghost command, but
    // drives its OWN scan+enrich via BustDeps.scanAndEnrich (self-contained,
    // no closure capture of the outer `enriched` variable — Issue 3 Option A
    // per 08-06-PLAN.md). Placed BEFORE the default ghost display path so
    // `ghost --dangerously-bust-ghosts` never falls through.
    if (ctx.values.dangerouslyBustGhosts) {
      // Rule #1: --csv is REJECTED on bust (08-RESEARCH Output Mode matrix)
      if (mode.csv) {
        console.error(
          '--csv is not supported on --dangerously-bust-ghosts; use --json for a structured report.',
        );
        process.exitCode = 1;
        return;
      }

      // Rule #2: --ci implies --yes-proceed-busting on bust (08-RESEARCH matrix, D-16).
      // This is the ONLY place where --ci implies destructive consent.
      //
      // Issue 2 fix: the expression is a direct ctx.values.ci check so it does
      // NOT couple to Phase 6's resolveOutputMode internals. An earlier draft
      // used a form that AND-gated the --ci check against the resolved json
      // mode, which was fragile — it conflated "--ci implies --json" with
      // "--ci implies --yes-proceed-busting" and would break silently if
      // resolveOutputMode ever changed how it derives json. The matrix says
      // --ci implies BOTH independently; check them independently.
      const yes = ctx.values.yesProceedBusting === true || ctx.values.ci === true;

      // Rule #3: Non-TTY without --yes-proceed-busting → exit 4 (D-17)
      // Detect via truthy check (pitfall 3: isTTY can be undefined in CI).
      const isTty = Boolean(process.stdin.isTTY);
      if (!isTty && !yes) {
        console.error(
          'This command requires an interactive terminal for the confirmation prompts.',
        );
        console.error('');
        console.error('To run in CI or a non-interactive shell, pass --yes-proceed-busting.');
        console.error('This flag skips all confirmation steps. Use it only if you have');
        console.error('reviewed the dry-run output and accept the changes.');
        process.exitCode = 4;
        return;
      }

      // Rule #4: Build BustDeps with a SELF-CONTAINED scanAndEnrich.
      // scanAndEnrich drives the FULL discover → parse → scan → enrich pipeline
      // internally rather than closing over the outer `enriched` variable. This
      // makes runBust's dependency on the scan+enrich pipeline explicit and
      // lets runBust be driven by test fixtures in unit tests without any
      // outer ghost-command state.
      //
      // Note: the real scanAll signature is `scanAll(invocations, { projectPaths })`,
      // not `scanAll(since)` — the Plan 06 text used a simplified shorthand.
      // See 08-06-SUMMARY.md for the deviation rationale.
      const deps: BustDeps = {
        readCheckpoint,
        checkpointPath: () => resolveCheckpointPath(),
        scanAndEnrich: async () => {
          const sessionFiles = await discoverSessionFiles({ sinceMs });
          const invocations: InvocationRecord[] = [];
          const projPaths = new Set<string>();
          for (const file of sessionFiles) {
            const result = await parseSession(file, sinceMs);
            invocations.push(...result.invocations);
            if (result.meta.projectPath) projPaths.add(result.meta.projectPath);
          }
          const { results: scanResults } = await scanAll(invocations, {
            projectPaths: [...projPaths],
          });
          return enrichScanResults(scanResults);
        },
        computeHash: (e) => computeGhostHash(e),
        processDetector: defaultProcessDeps,
        selfPid: process.pid,
        runCeremony: async ({ plan, yes: ceremonyYes }) => {
          // Print the change plan to stdout BEFORE the prompts (D-15) so the
          // user can read exactly what will be busted before they type `y`.
          if (!ceremonyYes && !mode.quiet) {
            console.log('');
            console.log(renderChangePlan(plan));
            console.log('');
          }
          return runConfirmationCeremony({ plan, yes: ceremonyYes });
        },
        renameFile: async (from, to) => {
          await rename(from, to);
        },
        mkdirRecursive: async (dir, modeArg) => {
          await mkdir(dir, { recursive: true, mode: modeArg });
        },
        readFileUtf8: (p) => readFile(p, 'utf8'),
        patchMemoryFrontmatter: patchFrontmatter,
        atomicWriteJson: (target, value) => atomicWriteJson(target, value),
        pathExistsSync: existsSync,
        createManifestWriter: (p) => new ManifestWriter(p),
        manifestPath: () => resolveManifestPath(),
        now: () => new Date(),
        ccauditVersion: CCAUDIT_VERSION,
        nodeVersion: process.version,
        sinceWindow: sinceStr,
        os: osPlatform(),
      };

      // Per-op verbose stderr log hook (wraps runCeremony to add progress output)
      if (mode.verbose) {
        console.error('[ccaudit] Starting bust pipeline...');
      }

      const result = await runBust({ yes, deps });

      // ── Output rendering per BustResult variant ────────────────
      if (mode.json) {
        const envelope = buildJsonEnvelope('ghost', sinceStr, bustResultToExitCode(result), {
          bust: bustResultToJson(result, ctx.values.privacy === true),
        });
        const indent = mode.quiet ? 0 : 2;
        console.log(JSON.stringify(envelope, null, indent));
      } else {
        // Human-readable rendering per BustResult discriminant.
        switch (result.status) {
          case 'success':
            if (!mode.quiet) {
              console.log('');
              console.log(
                renderShareableBlock({
                  beforeTokens: result.summary.beforeTokens,
                  afterTokens: result.summary.afterTokens,
                  freedTokens: result.summary.freedTokens,
                  pctWindow: result.summary.pctWindow,
                  healthBefore: result.summary.healthBefore,
                  healthAfter: result.summary.healthAfter,
                  gradeBefore: result.summary.gradeBefore,
                  gradeAfter: result.summary.gradeAfter,
                  counts: {
                    archivedAgents: result.counts.archive.completed,
                    archivedSkills: 0,
                    disabledMcp: result.counts.disable.completed,
                    flaggedMemory:
                      result.counts.flag.completed + (result.counts.flag.refreshed ?? 0),
                  },
                  manifestPath:
                    ctx.values.privacy === true
                      ? result.manifestPath.replace(homedir(), '~')
                      : result.manifestPath,
                  privacy: ctx.values.privacy === true,
                }),
              );
              console.log('');
            }
            break;
          case 'partial-success':
            if (!mode.quiet) {
              const mPath =
                ctx.values.privacy === true
                  ? result.manifestPath.replace(homedir(), '~')
                  : result.manifestPath;
              console.log('');
              console.log(
                `Done with failures. ${result.failed} op(s) failed — see manifest for details.`,
              );
              console.log(`Manifest: ${mPath}`);
            }
            break;
          case 'checkpoint-missing':
            console.error('No checkpoint found. You need to run a dry-run first.');
            console.error('');
            console.error('  ccaudit --dry-run');
            console.error('');
            console.error('This previews what will be changed and creates a checkpoint that');
            console.error('--dangerously-bust-ghosts requires before it will proceed.');
            break;
          case 'checkpoint-invalid':
            console.error(`Checkpoint file is invalid: ${result.reason}`);
            console.error('');
            console.error('Run ccaudit --dry-run to create a fresh checkpoint.');
            break;
          case 'hash-mismatch':
            console.error('Your inventory has changed since the last --dry-run.');
            console.error('');
            console.error('Something was added, removed, or modified in your agents, skills, MCP');
            console.error('servers, or memory files since the checkpoint was created. This is a');
            console.error('safety check -- the bust plan may no longer match your current setup.');
            console.error('');
            console.error('Run ccaudit --dry-run again to generate a fresh plan.');
            break;
          case 'running-process':
            if (result.selfInvocation) {
              console.error("You're running ccaudit from inside a Claude Code session.");
              console.error('');
              console.error('Open a separate terminal window and run the command from there.');
              console.error(
                "ccaudit cannot modify Claude Code's configuration while Claude Code is reading it.",
              );
            } else {
              console.error(`Claude Code is still running (pids: ${result.pids.join(', ')}).`);
              console.error('');
              console.error(colorize.red("Don't cross the streams!"));
              console.error('');
              console.error(
                'Close all Claude Code instances before running --dangerously-bust-ghosts.',
              );
              console.error(
                'Modifying configuration while Claude Code is active can corrupt session state.',
              );
            }
            break;
          case 'process-detection-failed':
            console.error(`Could not verify Claude Code is stopped: ${result.error}`);
            console.error(
              'Run from a clean shell where ps (Unix) or tasklist (Windows) is available.',
            );
            break;
          case 'user-aborted':
            if (!mode.quiet) console.log(`Aborted at ${result.stage}.`);
            break;
          case 'config-parse-error': {
            const p =
              ctx.values.privacy === true ? result.path.replace(homedir(), '~') : result.path;
            console.error(`Could not parse ${p}: ${result.error}`);
            console.error('Fix the file manually or restore from backup before re-running.');
            break;
          }
          case 'config-write-error': {
            const p =
              ctx.values.privacy === true ? result.path.replace(homedir(), '~') : result.path;
            console.error(`Could not write ${p}: ${result.error}`);
            break;
          }
        }
      }

      process.exitCode = bustResultToExitCode(result);
      return;
    }

    // Step 4: Calculate health score
    const healthScore = calculateHealthScore(enriched);

    // Step 5: Filter to ghosts only
    const ghosts = enriched.filter((r) => r.tier !== 'used');

    // Step 5.5: Group ghosts by project scope and compute worst-case session overhead.
    // A session loads global inventory + ONE project — never all projects simultaneously.
    const { global: globalSummary, projects: projectSummaries } = groupGhostsByProject(
      ghosts,
      homedir(),
    );
    const {
      total: worstCaseTotal,
      globalCost,
      worstProject,
    } = calculateWorstCaseOverhead(globalSummary, projectSummaries);

    // Apply path redaction for --privacy
    let displayProjectSummaries = projectSummaries;
    let displayWorstProject = worstProject;
    if (mode.privacy) {
      displayProjectSummaries = redactPaths(projectSummaries);
      displayWorstProject = displayProjectSummaries[0] ?? null;
    }

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
      // Build redaction map from already-redacted summaries
      const redactionMap = mode.privacy
        ? new Map(
            displayProjectSummaries
              .filter((s) => s.projectPath !== null)
              .map((s) => [s.projectPath!, s.displayPath]),
          )
        : null;
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
          path: redactionMap ? '[redacted]' : r.item.path,
          projectPath: redactionMap
            ? r.item.projectPath !== null
              ? (redactionMap.get(r.item.projectPath) ?? '[redacted]')
              : null
            : r.item.projectPath,
          tokenEstimate: r.tokenEstimate
            ? {
                tokens: r.tokenEstimate.tokens,
                confidence: r.tokenEstimate.confidence,
                source: r.tokenEstimate.source,
              }
            : null,
          recommendation: classifyRecommendation(r.tier),
          ...calculateUrgencyScore(r.lastUsed, r.tokenEstimate),
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
      // Empty inventory guard
      if (enriched.length === 0) {
        console.log('');
        console.log('No inventory found. ccaudit scans these locations:');
        console.log('');
        console.log('  Agents:  ~/.claude/commands/');
        console.log('  Skills:  ~/.claude/skills/');
        console.log('  MCP:     ~/.claude.json, .mcp.json');
        console.log('  Memory:  ~/.claude/CLAUDE.md, project CLAUDE.md files');
        console.log('');
        console.log("If you haven't customized Claude Code, there's nothing to audit.");
        return;
      }

      // Assemble columnar ghost output box
      const bottomLines: string[] = [];
      let progressPct: number | null = null;
      if (worstCaseTotal > 0) {
        bottomLines.push(
          colorize.bold(
            `Total ghost overhead: ${formatTotalOverhead(worstCaseTotal, globalCost, displayWorstProject)}`,
          ),
        );
        progressPct = Math.round((worstCaseTotal / 200_000) * 100);
        bottomLines.push(renderHealthScore(healthScore));
        bottomLines.push(formatSavingsLine(worstCaseTotal, colorize.greenBright));
      } else {
        bottomLines.push(renderHealthScore(healthScore));
      }

      // Calculate total wasted tokens from all categories
      const totalWastedTokens = summaries.reduce((sum, s) => sum + s.tokenCost, 0);

      console.log('');
      console.log(
        renderGhostOutputBox(
          renderHeader(
            '\u{1F47B}',
            'Ghost Inventory',
            humanizeSinceWindow(sinceStr),
            totalWastedTokens,
          ),
          summaries,
          bottomLines,
          progressPct,
        ),
      );
      console.log('');
      console.log(
        colorize.dim('use --privacy flag to redact project names and share a screenshot'),
      );
      console.log('');
      console.log('');

      if (ghosts.length === 0) {
        console.log(
          `No ghosts found -- every item in your inventory was used in the last ${humanizeSinceWindow(sinceStr)}.`,
        );
      } else {
        const topGhostsStr = renderTopGhosts(ghosts, 5);
        if (topGhostsStr) {
          console.log(topGhostsStr);
          console.log('');
        }

        // Global baseline always shown when ghosts exist
        console.log(renderGlobalBaseline(globalSummary));
        console.log('');

        // Projects table: only when project-scoped ghosts exist
        if (projectSummaries.length > 0) {
          console.log(renderProjectsTable(globalSummary, displayProjectSummaries));
          console.log('');
        }

        // Full per-project breakdown only in verbose mode
        if (mode.verbose && projectSummaries.length > 0) {
          console.log(renderProjectsVerbose(globalSummary, displayProjectSummaries));
          console.log('');
        }
      }

      console.log('');
      console.log(renderGhostFooter(sinceStr));
    }

    // Set exit code: ghost/inventory/mcp exit 1 when ghosts found (per D-01, D-02, D-03)
    if (hasGhosts) {
      process.exitCode = 1;
    }
  },
});

/**
 * Map BustResult to process exit code per the exit code ladder:
 *   0 = success (clean) or user-aborted (graceful abort is not a failure)
 *   1 = partial-success / checkpoint-missing / checkpoint-invalid / hash-mismatch / config errors
 *   2 = reserved (Phase 7 checkpoint write failure, not bust)
 *   3 = running-process / process-detection-failed
 *   4 = non-TTY without bypass (handled before runBust is called)
 *
 * Exhaustive switch — TypeScript will flag a missing case as a compile error
 * if a new BustResult variant is added upstream.
 */
function bustResultToExitCode(result: BustResult): number {
  switch (result.status) {
    case 'success':
      return 0;
    case 'user-aborted':
      return 0;
    case 'partial-success':
      return 1;
    case 'checkpoint-missing':
      return 1;
    case 'checkpoint-invalid':
      return 1;
    case 'hash-mismatch':
      return 1;
    case 'config-parse-error':
      return 1;
    case 'config-write-error':
      return 1;
    case 'running-process':
      return 3;
    case 'process-detection-failed':
      return 3;
  }
}

/**
 * Convert a BustResult to the JSON envelope payload shape. Every variant maps
 * to a consistent structure Phase 9 / automation can parse deterministically.
 */
function bustResultToJson(result: BustResult, privacy: boolean): Record<string, unknown> {
  const sanitizePath = (p: string) => (privacy ? p.replace(homedir(), '~') : p);
  const base: Record<string, unknown> = { status: result.status };
  switch (result.status) {
    case 'success':
      return {
        ...base,
        manifestPath: sanitizePath(result.manifestPath),
        counts: result.counts,
        duration_ms: result.duration_ms,
      };
    case 'partial-success':
      return {
        ...base,
        manifestPath: sanitizePath(result.manifestPath),
        counts: result.counts,
        duration_ms: result.duration_ms,
        failed: result.failed,
      };
    case 'checkpoint-missing':
      return { ...base, checkpointPath: sanitizePath(result.checkpointPath) };
    case 'checkpoint-invalid':
      return { ...base, reason: result.reason };
    case 'hash-mismatch':
      return { ...base, expected: result.expected, actual: result.actual };
    case 'running-process':
      return {
        ...base,
        pids: result.pids,
        selfInvocation: result.selfInvocation,
        message: result.message,
      };
    case 'process-detection-failed':
      return { ...base, error: result.error };
    case 'user-aborted':
      return { ...base, stage: result.stage };
    case 'config-parse-error':
      return { ...base, path: sanitizePath(result.path), error: result.error };
    case 'config-write-error':
      return { ...base, path: sanitizePath(result.path), error: result.error };
  }
}
