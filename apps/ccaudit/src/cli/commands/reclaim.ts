// apps/ccaudit/src/cli/commands/reclaim.ts -- Phase 4
//
// Gunshi subcommand: `ccaudit reclaim [--dry-run]`
//
// Enumerates every file under ~/.claude/ccaudit/archived/, identifies those
// NOT referenced by any manifest (orphans), and either:
//   --dry-run: reports what WOULD be done (no filesystem changes)
//   (default): restores orphans where the source path is missing (safe)
//              and skips orphans where the source already exists (safety invariant)
//
// Exit codes:
//   0  success / no orphans / dry-run
//   1  one or more orphans failed to be restored

import { readdir, stat, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { define } from 'gunshi';
import { discoverManifests, readManifest, recordHistory } from '@ccaudit/internal';
import type { DirEntry, ReclaimDeps, ReclaimResult } from '@ccaudit/internal';
import { reclaim } from '@ccaudit/internal';
import { initColor, colorize } from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { CCAUDIT_VERSION } from '../../_version.ts';

// -- Production deps builder ----------------------------------------

function buildProductionReclaimDeps(homeDir: string): ReclaimDeps {
  return {
    homeDir,
    discoverManifests: () =>
      discoverManifests({
        readdir: (dir: string) => readdir(dir),
        stat: async (p: string) => {
          const s = await stat(p);
          return { mtime: s.mtime };
        },
      }),
    readManifest: (p: string) => readManifest(p),
    readDirRecursive: async (dir: string): Promise<DirEntry[]> => {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries.map((e) => ({
        absolutePath: path.join(
          (e as unknown as { parentPath?: string; path?: string }).parentPath ??
            (e as unknown as { path?: string }).path ??
            dir,
          e.name,
        ),
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    },
    pathExists: async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    renameFile: (from: string, to: string) => rename(from, to),
    mkdirRecursive: (dir: string) => mkdir(dir, { recursive: true }).then(() => undefined),
    onWarning: (msg: string) => {
      process.stderr.write(`  warning: ${msg}\n`);
    },
  };
}

// -- Gunshi command definition ----------------------------------------

export const reclaimCommand = define({
  name: 'reclaim',
  description:
    'Recover orphaned files from ~/.claude/ccaudit/archived/ that are not tracked by any manifest',
  toKebab: true,
  renderHeader: null,
  args: {
    ...outputArgs,
    'dry-run': {
      type: 'boolean' as const,
      description: 'List orphans that would be restored, but do not mutate the filesystem',
      default: false,
    },
  },
  async run(ctx) {
    initColor();
    // Phase 6: history instrumentation.
    const _historyStartMs = Date.now();
    const _argv = process.argv.slice(2);
    const safeRecordHistory = async (
      entry: Omit<Parameters<typeof recordHistory>[0], 'privacy'>,
    ): Promise<void> => {
      if (process.env.CCAUDIT_NO_HISTORY === '1') return;
      try {
        await recordHistory({ ...entry, privacy: false });
      } catch (err) {
        process.stderr.write(
          `[ccaudit] warning: failed to record history: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    };

    const dryRun = ctx.values['dry-run'] === true;

    // Use HOME env var so subprocess tests can override it cleanly.
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? homedir();

    const deps = buildProductionReclaimDeps(homeDir);
    const warnings: string[] = [];
    const originalOnWarning = deps.onWarning;
    deps.onWarning = (msg: string) => {
      warnings.push(msg);
      if (originalOnWarning) originalOnWarning(msg);
    };

    let result: ReclaimResult;
    try {
      result = await reclaim({ dryRun, deps });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ccaudit reclaim failed: ${message}\n`);
      await safeRecordHistory({
        homeDir,
        command: 'reclaim',
        argv: _argv,
        exitCode: 2,
        durationMs: Date.now() - _historyStartMs,
        cwd: process.cwd(),
        result: null,
        errors: [message],
        ccauditVersion: CCAUDIT_VERSION,
      });
      process.exit(2);
    }

    process.stdout.write(renderResult(result, dryRun));

    // Phase 6: record reclaim history entry.
    const exitCode = result.failed.length > 0 ? 1 : 0;
    await safeRecordHistory({
      homeDir,
      command: 'reclaim',
      argv: _argv,
      exitCode,
      durationMs: Date.now() - _historyStartMs,
      cwd: process.cwd(),
      result: {
        orphans_detected: result.orphans.length,
        reclaimed: result.reclaimed,
        skipped: result.skippedSourceExists,
      },
      errors: result.failed.map((f) => `${f.archivePath}: ${f.error}`),
      ccauditVersion: CCAUDIT_VERSION,
    });
    process.exit(exitCode);
  },
});

// -- Rendering -------------------------------------------------------

function renderResult(result: ReclaimResult, dryRun: boolean): string {
  const lines: string[] = [];

  if (result.orphans.length === 0) {
    lines.push(`0 orphans detected — archived/ is fully reconciled with manifest records.`);
    return lines.join('\n') + '\n';
  }

  // Table header
  if (dryRun) {
    lines.push(`Dry-run — ${result.orphans.length} orphan(s) detected (no changes made):`);
  } else {
    lines.push(`${result.orphans.length} orphan(s) detected:`);
  }
  lines.push('');

  // Per-orphan table rows
  for (const orphan of result.orphans) {
    const tag = orphan.sourceExists ? 'source-exists' : 'source-missing';
    lines.push(`  ${orphan.archivePath}`);
    lines.push(`    → ${orphan.inferredSource}  [${tag}]`);
  }
  lines.push('');

  // Summary line
  if (dryRun) {
    const sourceMissing = result.orphans.filter((o) => !o.sourceExists).length;
    const sourceExists = result.orphans.filter((o) => o.sourceExists).length;
    lines.push(
      `Summary (dry-run): ${result.orphans.length} orphan(s) detected` +
        (sourceMissing > 0 ? `, ${sourceMissing} would be reclaimed` : '') +
        (sourceExists > 0 ? `, ${sourceExists} would be skipped (source exists)` : ''),
    );
  } else {
    const parts: string[] = [`${result.reclaimed} reclaimed`];
    if (result.skippedSourceExists > 0) {
      parts.push(`${result.skippedSourceExists} skipped (source exists)`);
    }
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} failed`);
    }
    const summaryLine = parts.join(', ');
    if (result.failed.length > 0) {
      lines.push(colorize.yellow(`Summary: ${summaryLine}`));
    } else {
      lines.push(colorize.green(`Summary: ${summaryLine}`));
    }
  }

  return lines.join('\n') + '\n';
}
