// apps/ccaudit/src/cli/commands/restore.ts -- Phase 9 Plan 03
//
// Gunshi subcommand that routes three invocations:
//   ccaudit restore          → full restore (most recent manifest)
//   ccaudit restore <name>   → single-item restore by name
//   ccaudit restore --list   → read-only listing of all archived items
//
// Production RestoreDeps are built from real node:fs/promises + Phase 8 helpers.
// Output modes: rendered (default) / --quiet / --json / --verbose.
// Exit ladder: 0 (success/no-op/list), 1 (failures), 3 (running-process), 4 (detection-failed).

import { readFile, rename, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { define } from 'gunshi';
import {
  executeRestore,
  discoverManifests,
  atomicWriteJson,
  readManifest,
  removeFrontmatterKeys,
  setFrontmatterValue,
  defaultProcessDeps,
  extractServerName,
} from '@ccaudit/internal';
import type {
  RestoreDeps,
  RestoreResult,
  RestoreMode,
  ManifestListEntry,
  ArchiveOp,
  DisableOp,
  ManifestOp,
} from '@ccaudit/internal';
import { initColor, colorize, renderHeader } from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';

// -- Production deps builder -----------------------------------------------

/**
 * Wire all RestoreDeps fields to real production implementations.
 *
 * `warnings` is a mutable array that the onWarning sink appends to; the CLI
 * command captures the array reference and renders it under --verbose after
 * executeRestore returns.
 */
function buildProductionRestoreDeps(warnings: string[]): RestoreDeps {
  return {
    discoverManifests: () =>
      discoverManifests({
        readdir: (dir: string) => readdir(dir),
        stat: async (p: string) => {
          const s = await stat(p);
          return { mtime: s.mtime };
        },
      }),
    readManifest: (p: string) => readManifest(p),

    processDetector: defaultProcessDeps,
    selfPid: process.pid,

    renameFile: (from: string, to: string) => rename(from, to),
    mkdirRecursive: (dir: string, mode = 0o755) =>
      mkdir(dir, { recursive: true, mode }).then(() => undefined),
    readFileBytes: (p: string) => readFile(p),
    pathExists: async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },

    removeFrontmatterKeys: (filePath: string, keys: string[]) =>
      removeFrontmatterKeys(filePath, keys),
    setFrontmatterValue: (filePath: string, key: string, value: string) =>
      setFrontmatterValue(filePath, key, value),

    readFileUtf8: (p: string) => readFile(p, 'utf8'),
    atomicWriteJson: <T>(targetPath: string, value: T) => atomicWriteJson(targetPath, value),

    now: () => new Date(),

    onWarning: (msg: string) => {
      warnings.push(msg);
    },
  };
}

// -- Gunshi command definition -----------------------------------------------

export const restoreCommand = define({
  name: 'restore',
  description: 'Restore items archived by a previous --dangerously-bust-ghosts run',
  // Expose camelCase keys as kebab-case flags (e.g. --list stays --list;
  // required for consistent flag UX across the CLI — Phase 7 Plan 02 precedent).
  toKebab: true,
  // Suppress gunshi's decorative pre-run banner for structured output modes
  // (--json, --quiet, --ci). Without this the banner leaks into JSON payloads.
  // Phase 7 Plan 02 established this pattern; all Phase 8/9 commands follow it.
  renderHeader: null,
  args: {
    ...outputArgs,
    json: {
      type: 'boolean' as const,
      short: 'j',
      description: 'Output as JSON (see docs/JSON-SCHEMA.md for schema)',
      default: false,
    },
    verbose: {
      type: 'boolean' as const,
      short: 'v',
      description: 'Show detailed output including warnings',
      default: false,
    },
    list: {
      type: 'boolean' as const,
      description: 'List all archived items across all busts (read-only)',
      default: false,
    },
  },
  async run(ctx) {
    initColor();
    const outMode = resolveOutputMode(ctx.values);

    // Parse invocation mode:
    //   positional arg → single restore by name
    //   --list flag    → listing mode
    //   (default)      → full restore
    //
    // ctx.positionals includes ALL positionals from the full argv, meaning
    // ctx.positionals[0] = 'restore' (the subcommand name). The user-supplied
    // name (e.g., `ccaudit restore code-reviewer`) is at index [commandPath.length].
    // ctx.commandPath = ['restore'] when called as a subcommand, so depth = 1.
    // ctx._ is the FULL argv — same indexing issue, do NOT use ctx._[0] either.
    const positionalName = ctx.positionals[ctx.commandPath.length] ?? null;
    const listFlag = ctx.values.list === true;

    const mode: RestoreMode = listFlag
      ? { kind: 'list' }
      : positionalName !== null
        ? { kind: 'single', name: String(positionalName) }
        : { kind: 'full' };

    const warnings: string[] = [];
    const deps = buildProductionRestoreDeps(warnings);

    let result: RestoreResult;
    try {
      result = await executeRestore(mode, deps);
    } catch (err) {
      // Defensive catch: executeRestore uses injectable deps that shouldn't
      // throw outside their own error paths, but guard against unexpected errors.
      const message = err instanceof Error ? err.message : String(err);
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(buildJsonEnvelope('restore', 'n/a', 2, { error: message })) + '\n',
        );
      } else {
        process.stderr.write(`ccaudit restore failed: ${message}\n`);
      }
      process.exit(2);
    }

    const exitCode = restoreResultToExitCode(result);

    // Output mode matrix (precedence: json > csv > quiet > rendered)
    if (outMode.json) {
      process.stdout.write(
        JSON.stringify(
          buildJsonEnvelope('restore', 'n/a', exitCode, restoreResultToJson(result, warnings)),
        ) + '\n',
      );
    } else if (outMode.csv) {
      process.stdout.write(renderRestoreCsv(result));
    } else if (outMode.quiet) {
      process.stdout.write(renderRestoreQuiet(result));
    } else {
      process.stdout.write(renderRestoreRendered(result, warnings, outMode.verbose ?? false));
    }

    process.exit(exitCode);
  },
});

// -- Exit code ladder --------------------------------------------------------

/**
 * Map RestoreResult to exit code per CONTEXT.md D-15:
 *   0 = success | no-manifests | name-not-found | list
 *   1 = partial-success | manifest-corrupt | config-parse-error | config-write-error
 *   3 = running-process | process-detection-failed
 *
 * Exhaustive switch: TypeScript will flag a missing variant as a compile error.
 */
function restoreResultToExitCode(result: RestoreResult): number {
  switch (result.status) {
    case 'success':
      return 0;
    case 'no-manifests':
      return 0;
    case 'name-not-found':
      return 0;
    case 'list':
      return 0;
    case 'partial-success':
      return 1;
    case 'manifest-corrupt':
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

// -- JSON payload shape -------------------------------------------------------

/**
 * Build the data portion of the JSON envelope payload for each RestoreResult
 * variant. Included in `buildJsonEnvelope('restore', ...)` data spread.
 */
function restoreResultToJson(result: RestoreResult, warnings: string[]): Record<string, unknown> {
  const base = { warnings };
  switch (result.status) {
    case 'success':
      return {
        ...base,
        status: result.status,
        counts: result.counts,
        manifest_path: result.manifestPath,
        duration_ms: result.duration_ms,
        failed: 0,
      };
    case 'partial-success':
      return {
        ...base,
        status: result.status,
        counts: result.counts,
        manifest_path: result.manifestPath,
        duration_ms: result.duration_ms,
        failed: result.failed,
      };
    case 'no-manifests':
      return {
        ...base,
        status: 'no-manifests',
        message: 'No bust history found. Run ccaudit --dangerously-bust-ghosts first.',
      };
    case 'name-not-found':
      return {
        ...base,
        status: 'name-not-found',
        name: result.name,
        message: `No archived item named '${result.name}' found.`,
      };
    case 'manifest-corrupt':
      return { ...base, status: 'manifest-corrupt', path: result.path };
    case 'list':
      return {
        ...base,
        status: 'list',
        entries: result.entries.map(summarizeListEntry),
      };
    case 'running-process':
      return {
        ...base,
        status: 'running-process',
        pids: result.pids,
        self_invocation: result.selfInvocation,
        message: result.message,
      };
    case 'process-detection-failed':
      return {
        ...base,
        status: 'process-detection-failed',
        error: result.error,
      };
    case 'config-parse-error':
      return {
        ...base,
        status: result.status,
        path: result.path,
        error: result.error,
      };
    case 'config-write-error':
      return {
        ...base,
        status: result.status,
        path: result.path,
        error: result.error,
      };
  }
}

function summarizeListEntry(entry: ManifestListEntry): Record<string, unknown> {
  return {
    path: entry.path,
    mtime: entry.mtime.toISOString(),
    is_partial: entry.isPartial,
    op_count: entry.opCount,
    items: entry.ops
      .filter((o): o is ArchiveOp | DisableOp => o.op_type === 'archive' || o.op_type === 'disable')
      .map(summarizeOp),
  };
}

function summarizeOp(op: ArchiveOp | DisableOp): Record<string, unknown> {
  if (op.op_type === 'archive') {
    return {
      category: op.category,
      name: path.basename(op.archive_path, path.extname(op.archive_path)),
      source_path: op.source_path,
      archive_path: op.archive_path,
    };
  }
  return {
    category: 'mcp',
    name: extractServerName(op.original_key),
    config_path: op.config_path,
    disabled_key: op.new_key,
  };
}

// -- Human-readable rendering -------------------------------------------------

/**
 * Default rendered output for human consumption.
 * Dispatches to sub-renderers based on RestoreResult status.
 */
function renderRestoreRendered(
  result: RestoreResult,
  warnings: string[],
  verbose: boolean,
): string {
  // Handle special non-success statuses with concise messages
  switch (result.status) {
    case 'no-manifests':
      return 'No bust history found. Run ccaudit --dangerously-bust-ghosts first.\n';
    case 'name-not-found':
      return `No archived item named '${result.name}' found.\n`;
    case 'list':
      return renderListOutput(result.entries);
    case 'running-process':
      return result.message + '\n';
    case 'process-detection-failed':
      return `Process detection failed: ${result.error}\n`;
    case 'manifest-corrupt':
      return `Manifest is corrupt (no header record). Cannot restore from ${path.basename(result.path)}.\n`;
    case 'config-parse-error':
      return `Failed to parse ${result.path}: ${result.error}\n`;
    case 'config-write-error':
      return `Failed to write ${result.path}: ${result.error}\n`;
  }

  // success / partial-success: structured output with header + counts
  const lines: string[] = [];
  const header = renderHeader('\u{1F504}', 'Restore', new Date().toISOString());
  lines.push(header);
  lines.push('');

  const c = result.counts;
  lines.push(
    `${c.unarchived.completed} agents/skills restored to their original locations${c.unarchived.failed > 0 ? ` (${c.unarchived.failed} failed)` : ''}`,
  );
  lines.push(
    `${c.reenabled.completed} MCP servers re-enabled in configuration${c.reenabled.failed > 0 ? ` (${c.reenabled.failed} failed)` : ''}`,
  );
  lines.push(
    `${c.stripped.completed} memory files cleaned (ccaudit flags removed)${c.stripped.failed > 0 ? ` (${c.stripped.failed} failed)` : ''}`,
  );

  if (verbose && warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of warnings) lines.push(`  ${w}`);
  }

  lines.push('');
  if (result.status === 'success') {
    lines.push(
      colorize.green('\u2713 Restore complete. Your configuration is back to its pre-bust state.'),
    );
  } else {
    lines.push(
      colorize.yellow(
        `\u26A0 Restore finished with ${result.failed} failure(s). Check the manifest for details.`,
      ),
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Render grouped listing of all archived items for --list mode.
 * Per D-04: each bust entry shows timestamp, clean/partial label, item count,
 * and per-op detail lines.
 */
function renderListOutput(entries: ManifestListEntry[]): string {
  if (entries.length === 0) {
    return 'No bust history found.\n';
  }

  const lines: string[] = [];
  lines.push(`Archived items \u2014 ${entries.length} bust${entries.length === 1 ? '' : 's'}`);
  lines.push('');

  for (const entry of entries) {
    const isoName = path.basename(entry.path, '.jsonl').replace(/^bust-/, '');
    const statusLabel = entry.isPartial ? 'partial bust' : 'clean bust';
    lines.push(`\u25CF ${isoName}  (${statusLabel}, ${entry.opCount} item(s))`);

    for (const op of entry.ops) {
      lines.push(renderOpLine(op));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a single per-op detail line for --list output.
 * Skipped ops are omitted per RESEARCH Q3 (not actionable by restore).
 */
function renderOpLine(op: ManifestOp): string {
  if (op.op_type === 'archive') {
    const name = path.basename(op.archive_path, path.extname(op.archive_path));
    return `  ${op.category.padEnd(8)}${name.padEnd(28)}${op.archive_path}`;
  }
  if (op.op_type === 'disable') {
    const server = extractServerName(op.original_key);
    return `  mcp     ${server.padEnd(28)}${op.config_path} (key: ${op.new_key})`;
  }
  if (op.op_type === 'flag' || op.op_type === 'refresh') {
    return `  memory  ${path.basename(op.file_path).padEnd(28)}${op.file_path} (frontmatter)`;
  }
  // skipped ops: omit from list
  return '';
}

// -- Quiet TSV output ---------------------------------------------------------

/**
 * Machine-readable TSV summary line for --quiet mode.
 * Full/single restore: status + per-category counts.
 * Other statuses: status only.
 */
function renderRestoreQuiet(result: RestoreResult): string {
  if (result.status === 'success' || result.status === 'partial-success') {
    const c = result.counts;
    return `restore\t${result.status}\t${c.unarchived.completed}\t${c.reenabled.completed}\t${c.stripped.completed}\n`;
  }
  return `restore\t${result.status}\n`;
}

// -- CSV output ---------------------------------------------------------------

/**
 * CSV output for --csv mode.
 *
 * v1.2 limitation: success/partial-success emit category-level summary rows
 * (not per-op rows) because executeRestore does not carry individual op details
 * in RestoreResult. Per-op granularity requires manifest access which is outside
 * the result shape scope for this plan. Documented as known limitation.
 */
function renderRestoreCsv(result: RestoreResult): string {
  const header = 'action,category,name,scope,source_path,archive_path,status,error\n';

  if (result.status !== 'success' && result.status !== 'partial-success') {
    const error =
      'error' in result
        ? String((result as { error?: string }).error ?? '').replace(/,/g, ';')
        : '';
    return header + `restore,meta,${result.status},,,,${result.status},${error}\n`;
  }

  // Summary rows per category (not per-op — v1.2 limitation)
  const c = result.counts;
  const uTotal = c.unarchived.completed + c.unarchived.failed;
  const rTotal = c.reenabled.completed + c.reenabled.failed;
  const sTotal = c.stripped.completed + c.stripped.failed;

  return (
    header +
    `restore,agents_skills,,all,,,${c.unarchived.completed}/${uTotal} ok,\n` +
    `restore,mcp,,all,,,${c.reenabled.completed}/${rTotal} ok,\n` +
    `restore,memory,,all,,,${c.stripped.completed}/${sTotal} ok,\n`
  );
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('restoreResultToExitCode', () => {
    const cases: Array<[RestoreResult, number]> = [
      [
        {
          status: 'success',
          counts: {
            unarchived: { completed: 1, failed: 0 },
            reenabled: { completed: 0, failed: 0 },
            stripped: { completed: 0, failed: 0 },
          },
          manifestPath: '/p',
          duration_ms: 10,
        },
        0,
      ],
      [{ status: 'no-manifests' }, 0],
      [{ status: 'name-not-found', name: 'x' }, 0],
      [{ status: 'list', entries: [] }, 0],
      [
        {
          status: 'partial-success',
          counts: {
            unarchived: { completed: 0, failed: 1 },
            reenabled: { completed: 0, failed: 0 },
            stripped: { completed: 0, failed: 0 },
          },
          failed: 1,
          manifestPath: '/p',
          duration_ms: 5,
        },
        1,
      ],
      [{ status: 'manifest-corrupt', path: '/p' }, 1],
      [{ status: 'config-parse-error', path: '/p', error: 'e' }, 1],
      [{ status: 'config-write-error', path: '/p', error: 'e' }, 1],
      [{ status: 'running-process', pids: [1], selfInvocation: false, message: 'm' }, 3],
      [{ status: 'process-detection-failed', error: 'e' }, 3],
    ];

    for (const [result, expected] of cases) {
      it(`${result.status} → exit ${expected}`, () => {
        expect(restoreResultToExitCode(result)).toBe(expected);
      });
    }
  });

  describe('renderRestoreQuiet', () => {
    it('success: emits tab-separated status + counts', () => {
      const result: RestoreResult = {
        status: 'success',
        counts: {
          unarchived: { completed: 2, failed: 0 },
          reenabled: { completed: 1, failed: 0 },
          stripped: { completed: 3, failed: 0 },
        },
        manifestPath: '/m',
        duration_ms: 50,
      };
      expect(renderRestoreQuiet(result)).toBe('restore\tsuccess\t2\t1\t3\n');
    });

    it('no-manifests: emits status only', () => {
      expect(renderRestoreQuiet({ status: 'no-manifests' })).toBe('restore\tno-manifests\n');
    });
  });

  describe('renderRestoreCsv', () => {
    it('includes header row', () => {
      const result: RestoreResult = { status: 'no-manifests' };
      const csv = renderRestoreCsv(result);
      expect(csv.startsWith('action,category')).toBe(true);
    });

    it('success emits 3 summary rows', () => {
      const result: RestoreResult = {
        status: 'success',
        counts: {
          unarchived: { completed: 1, failed: 0 },
          reenabled: { completed: 1, failed: 0 },
          stripped: { completed: 1, failed: 0 },
        },
        manifestPath: '/m',
        duration_ms: 10,
      };
      const rows = renderRestoreCsv(result).trim().split('\n');
      expect(rows.length).toBe(4); // header + 3 rows
    });
  });

  describe('extractServerName (re-export check)', () => {
    it('handles flat mcpServers.name key', () => {
      expect(extractServerName('mcpServers.playwright')).toBe('playwright');
    });

    it('handles nested projects path key', () => {
      expect(extractServerName('projects./foo.mcpServers.my.server')).toBe('my.server');
    });
  });
}
