// apps/ccaudit/src/cli/commands/purge-archive.ts -- Phase 9 SC6
//
// Gunshi subcommand: `ccaudit purge-archive [--dry-run | --yes] [--json]`
//
// Drains ~/.claude/ccaudit/archived/ via the Plan 09-03 domain core.
// Default behavior is dry-run; a real purge REQUIRES an explicit --yes
// gate (no prompt fallback, per CONTEXT D6).
//
// Scope is archive ops ONLY — flag (memory frontmatter) and disable (MCP
// re-enable) ops are ignored by classifyArchiveOps and never touched.
//
// Exit codes:
//   0  success OR partial failure (partial is reported in failures[], not fatal)
//   1  classification-level failure (manifest dir unreadable, executePurge Result.err,
//      flag mutual-exclusion violation)
//   2  safe-mode abort (unused on this command today — kept for parity with other subcommands)

import { readdir, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { define } from 'gunshi';
import { Result } from '@praha/byethrow';
import {
  classifyArchiveOps,
  executePurge,
  discoverManifests,
  readManifest,
  openPurgeManifestWriter,
  recordHistory,
} from '@ccaudit/internal';
import type {
  ExecutePurgeDeps,
  PurgePlan,
  PurgeResult,
  ManifestOp,
  ArchivePurgeOp,
} from '@ccaudit/internal';
import { initColor, colorize } from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';
import { CCAUDIT_VERSION } from '../../_version.ts';

// -- Production deps builder ----------------------------------------

function buildProductionExecutePurgeDeps(): ExecutePurgeDeps {
  return {
    pathExists: async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    mkdirRecursive: (dir: string) => mkdir(dir, { recursive: true }).then(() => undefined),
    renameFile: (from: string, to: string) => rename(from, to),
    unlinkFile: (p: string) => unlink(p),
    createPurgeManifestWriter: (input) =>
      openPurgeManifestWriter({
        ccaudit_version: input.ccaudit_version,
        purge_timestamp: input.purge_timestamp,
      }),
    ccauditVersion: CCAUDIT_VERSION,
    now: () => new Date(),
  };
}

// -- Gunshi command definition -------------------------------------

export const purgeArchiveCommand = define({
  name: 'purge-archive',
  description:
    'Drain ~/.claude/ccaudit/archived/ via reclaim-if-free / drop-if-occupied / drop-if-stale (archive ops only)',
  toKebab: true,
  // Suppress gunshi's decorative pre-run banner — same pattern as restore/reclaim
  // so --json output is pure JSON on stdout.
  renderHeader: null,
  args: {
    ...outputArgs,
    json: {
      type: 'boolean' as const,
      short: 'j',
      description: 'JSON output (docs/JSON-SCHEMA.md §Purge)',
      default: false,
    },
    'dry-run': {
      type: 'boolean' as const,
      description: 'Classify without mutating the filesystem (default)',
      default: false,
    },
    yes: {
      type: 'boolean' as const,
      description: 'Execute the classified plan (required for real purge)',
      default: false,
    },
  },
  async run(ctx) {
    initColor();
    const outMode = resolveOutputMode(ctx.values);

    // -- Argument parsing + validation ----------------------------
    const dryRunFlag = ctx.values['dry-run'] === true;
    const yesFlag = ctx.values.yes === true;

    // D6 safety gate: --yes and --dry-run are mutually exclusive.
    if (dryRunFlag && yesFlag) {
      process.stderr.write('flags are mutually exclusive: --dry-run, --yes\n');
      process.exit(1);
    }

    // Effective mode: dry-run unless --yes is explicitly set.
    const dryRun = !yesFlag;

    // -- History instrumentation ---------------------------------
    const historyStartMs = Date.now();
    const argv = process.argv.slice(2);
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
    const safeRecordHistory = async (
      entry: Omit<Parameters<typeof recordHistory>[0], 'privacy'>,
    ): Promise<void> => {
      if (process.env.CCAUDIT_NO_HISTORY === '1') return;
      try {
        await recordHistory({ ...entry, privacy: outMode.privacy });
      } catch (err) {
        process.stderr.write(
          `[ccaudit] warning: failed to record history: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    };

    // -- Load manifest union + classify ---------------------------
    let plan: PurgePlan;
    const manifestErrors: { path: string; reason: string }[] = [];
    try {
      const entries = await discoverManifests({
        readdir: (dir: string) => readdir(dir),
        stat: async (p: string) => {
          const s = await stat(p);
          return { mtime: s.mtime };
        },
      });
      const allOps: ManifestOp[] = [];
      for (const entry of entries) {
        try {
          const parsed = await readManifest(entry.path);
          allOps.push(...parsed.ops);
        } catch (mErr) {
          const reason = mErr instanceof Error ? mErr.message : String(mErr);
          manifestErrors.push({ path: entry.path, reason });
          process.stderr.write(
            `[ccaudit] warning: skipping unreadable manifest ${entry.path}: ${reason}\n`,
          );
        }
      }
      // Probe disk via the same injected pathExists the executor uses.
      const pathExists = async (p: string): Promise<boolean> => {
        try {
          await stat(p);
          return true;
        } catch {
          return false;
        }
      };
      plan = await classifyArchiveOps(allOps, pathExists);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope('purge-archive', 'n/a', 1, {
              purge: {
                summary: {
                  purgedCount: 0,
                  reclaimedCount: 0,
                  skippedOccupiedCount: 0,
                  staleFilteredCount: 0,
                },
                failures: [{ path: '', reason: message }],
                dryRun,
              },
            }),
          ) + '\n',
        );
      } else {
        process.stderr.write(`ccaudit purge-archive failed: ${message}\n`);
      }
      await safeRecordHistory({
        homeDir,
        command: 'purge-archive',
        argv,
        exitCode: 1,
        durationMs: Date.now() - historyStartMs,
        cwd: process.cwd(),
        result: null,
        errors: [message],
        ccauditVersion: CCAUDIT_VERSION,
      });
      process.exit(1);
    }

    // -- Execute (dry-run or real) --------------------------------
    const deps = buildProductionExecutePurgeDeps();
    const execResult = await executePurge(plan, deps, { dryRun });

    if (Result.isFailure(execResult)) {
      // All items failed OR (theoretically) an internal error. Treat as
      // exit 1 since at least one item was requested and none succeeded.
      const message = execResult.error.message;
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope('purge-archive', 'n/a', 1, {
              purge: {
                summary: {
                  purgedCount: 0,
                  reclaimedCount: 0,
                  skippedOccupiedCount: 0,
                  staleFilteredCount: 0,
                },
                failures: [{ path: '', reason: message }],
                dryRun,
              },
            }),
          ) + '\n',
        );
      } else {
        process.stderr.write(`ccaudit purge-archive: ${message}\n`);
      }
      await safeRecordHistory({
        homeDir,
        command: 'purge-archive',
        argv,
        exitCode: 1,
        durationMs: Date.now() - historyStartMs,
        cwd: process.cwd(),
        result: {
          purgedCount: 0,
          reclaimedCount: 0,
          skippedOccupiedCount: 0,
          staleFilteredCount: 0,
          dryRun,
          failures: 1,
        },
        errors: [message],
        ccauditVersion: CCAUDIT_VERSION,
      });
      process.exit(1);
    }

    const result = execResult.value;

    // Exit code: 0 (partial failures are NOT fatal per the plan's INV table).
    const exitCode = 0;

    if (outMode.json) {
      process.stdout.write(
        JSON.stringify(
          buildJsonEnvelope('purge-archive', 'n/a', exitCode, {
            purge: {
              summary: result.summary,
              failures: result.failures.map((f) => ({ path: f.path, reason: f.reason })),
              ...(manifestErrors.length > 0 ? { manifestErrors } : {}),
              dryRun,
              manifestPath: result.manifestPath,
            },
          }),
        ) + '\n',
      );
    } else {
      process.stdout.write(renderPurgeHuman(plan, result, dryRun));
    }

    await safeRecordHistory({
      homeDir,
      command: 'purge-archive',
      argv,
      exitCode,
      durationMs: Date.now() - historyStartMs,
      cwd: process.cwd(),
      result: {
        purgedCount: result.summary.purgedCount,
        reclaimedCount: result.summary.reclaimedCount,
        skippedOccupiedCount: result.summary.skippedOccupiedCount,
        staleFilteredCount: result.summary.staleFilteredCount,
        dryRun,
        failures: result.failures.length,
      },
      errors: result.failures.map((f) => `${f.path}: ${f.reason}`),
      ccauditVersion: CCAUDIT_VERSION,
    });
    process.exit(exitCode);
  },
});

// -- Human-readable rendering --------------------------------------

function renderPurgeHuman(plan: PurgePlan, result: PurgeResult, dryRun: boolean): string {
  const lines: string[] = [];
  const headerLabel = dryRun ? 'Purge archive (dry-run)' : 'Purge archive';
  lines.push(headerLabel);
  lines.push('');

  const reclaimCount = plan.reclaim.length;
  const dropOccupied = plan.drop.filter((d) => d.reason === 'source_occupied').length;
  const dropStale = plan.drop.filter((d) => d.reason === 'stale_archive_missing').length;
  const skipCount = plan.skip.length;

  const totalConsidered = reclaimCount + dropOccupied + dropStale + skipCount;
  if (totalConsidered === 0) {
    lines.push('Archive is empty or already reconciled — nothing to do.');
    return lines.join('\n') + '\n';
  }

  // Section 1: To reclaim
  if (reclaimCount > 0) {
    lines.push(`To reclaim: ${reclaimCount} item(s)`);
    for (const { op } of plan.reclaim) {
      const name = path.basename(op.archive_path, path.extname(op.archive_path));
      lines.push(`  ${name.padEnd(28)} → ${op.source_path}`);
    }
    lines.push('');
  }

  // Section 2: To drop (with reason column)
  const totalDrop = dropOccupied + dropStale;
  if (totalDrop > 0) {
    lines.push(`To drop: ${totalDrop} item(s)`);
    for (const { op, reason } of plan.drop) {
      const name = path.basename(op.archive_path, path.extname(op.archive_path));
      lines.push(`  ${name.padEnd(28)} [${reason}]`);
    }
    lines.push('');
  }

  // Section 3: Skipped (broken state)
  if (skipCount > 0) {
    lines.push(`Skipped (broken state): ${skipCount} item(s)`);
    for (const { op } of plan.skip) {
      const name = path.basename(op.archive_path, path.extname(op.archive_path));
      lines.push(`  ${name.padEnd(28)} [both_missing]`);
    }
    lines.push('');
  }

  // Section 4: failures (real-run only)
  if (!dryRun && result.failures.length > 0) {
    lines.push(colorize.yellow(`Failures: ${result.failures.length}`));
    for (const f of result.failures) {
      lines.push(`  ${f.path}  [${f.reason}]`);
    }
    lines.push('');
  }

  // Summary
  const summaryParts: string[] = [];
  if (dryRun) {
    summaryParts.push(`${result.summary.reclaimedCount} would be reclaimed`);
    summaryParts.push(`${result.summary.purgedCount} would be purged`);
    if (result.summary.skippedOccupiedCount > 0) {
      summaryParts.push(`${result.summary.skippedOccupiedCount} drop-source-occupied`);
    }
    if (result.summary.staleFilteredCount > 0) {
      summaryParts.push(`${result.summary.staleFilteredCount} drop-stale`);
    }
    if (skipCount > 0) {
      summaryParts.push(`${skipCount} skipped`);
    }
    lines.push(`Summary (dry-run): ${summaryParts.join(', ')}.`);
    lines.push('');
    lines.push('Dry-run. Pass --yes to execute.');
  } else {
    summaryParts.push(`${result.summary.reclaimedCount} reclaimed`);
    summaryParts.push(`${result.summary.purgedCount} purged`);
    if (result.summary.skippedOccupiedCount > 0) {
      summaryParts.push(`${result.summary.skippedOccupiedCount} drop-source-occupied`);
    }
    if (result.summary.staleFilteredCount > 0) {
      summaryParts.push(`${result.summary.staleFilteredCount} drop-stale`);
    }
    if (result.failures.length > 0) {
      summaryParts.push(`${result.failures.length} failed`);
    }
    const summaryLine = `Summary: ${summaryParts.join(', ')}.`;
    lines.push(
      result.failures.length > 0 ? colorize.yellow(summaryLine) : colorize.green(summaryLine),
    );
    if (result.manifestPath !== null) {
      lines.push('');
      lines.push(`Follow-up manifest: ${result.manifestPath}`);
    }
  }

  return lines.join('\n') + '\n';
}

// Inert re-export to keep some unused import warnings quiet in narrower lint
// configs; ArchivePurgeOp is part of the public type surface consumed by the
// JSON envelope shape via executePurge's return type.
export type { ArchivePurgeOp };
