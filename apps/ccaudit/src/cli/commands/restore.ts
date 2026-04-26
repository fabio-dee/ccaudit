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
import { homedir } from 'node:os';
import path from 'node:path';
import { define } from 'gunshi';
import { Result } from '@praha/byethrow';
import { recordHistory } from '@ccaudit/internal';
import { CCAUDIT_VERSION } from '../../_version.ts';
import {
  executeRestore,
  discoverManifests,
  atomicWriteJson,
  readManifest,
  removeFrontmatterKeys,
  setFrontmatterValue,
  defaultProcessDeps,
  extractServerName,
  findManifestsForRestore,
  dedupManifestOps,
  collectRestoreableItems,
  filterRestoreableItems,
  matchByName,
  isNoInteractiveEnv,
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
import {
  initColor,
  colorize,
  renderHeader,
  openRestorePicker,
  type RestoreItem,
} from '@ccaudit/terminal';
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

// -- Pure helpers (Plan 08-03) ----------------------------------------------

/**
 * Format the D8-09 ambiguity block for `--name` matches.
 *
 * Returns `''` when there is no ambiguity (0 or 1 candidate). For ≥2
 * candidates returns the verbatim block (em-dash preserved) ending in a
 * trailing newline.
 */
export function formatAmbiguityError(pattern: string, candidates: string[]): string {
  if (candidates.length < 2) return '';
  const lines = [
    `"${pattern}" is ambiguous \u2014 candidates:`,
    ...candidates.map((c) => `  ${c}`),
    `Use --all-matching to restore every candidate.`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * D8-11 mutual-exclusion gate for the three restore mode flags.
 * Returns Err with a fixed message when ≥2 of {--interactive, --name,
 * --all-matching} are set; otherwise Ok.
 */
export function validateRestoreFlagExclusion(flags: {
  interactive?: boolean;
  name?: string;
  allMatching?: string;
}): Result.Result<void, string> {
  const active = [flags.interactive, flags.name, flags.allMatching].filter(
    (v) => v !== undefined && v !== false && v !== '',
  ).length;
  if (active >= 2) {
    return Result.fail('flags are mutually exclusive: --interactive, --name, --all-matching');
  }
  return Result.succeed();
}

// -- Preflight error -----------------------------------------------------------

/**
 * Typed error for pre-dispatch validation failures (mutual-exclusion check,
 * CCAUDIT_NO_INTERACTIVE refusal, TTY guard, no-match / ambiguity, empty
 * interactive archive). The catch block recognises this type and short-circuits
 * without printing a stack trace, emitting the JSON envelope when --json is
 * active and calling safeRecordHistory before exiting.
 */
class RestorePreflightError extends Error {
  constructor(
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RestorePreflightError';
  }
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
      description: 'JSON output (docs/JSON-SCHEMA.md)',
      default: false,
    },
    verbose: {
      type: 'boolean' as const,
      description: 'Show detailed output including warnings',
      default: false,
    },
    list: {
      type: 'boolean' as const,
      description: 'List all archived items across all busts (read-only)',
      default: false,
    },
    interactive: {
      type: 'boolean' as const,
      short: 'i',
      description: 'Open interactive picker to select items to restore',
      default: false,
    },
    name: {
      type: 'string' as const,
      metavar: 'pattern',
      description: 'Restore item matching this substring (fuzzy, case-insensitive)',
    },
    allMatching: {
      type: 'string' as const,
      metavar: 'pattern',
      description: 'Restore every item matching this substring (bulk)',
    },
  },
  async run(ctx) {
    initColor();
    const outMode = resolveOutputMode(ctx.values);
    // Phase 6: history instrumentation.
    const _historyStartMs = Date.now();
    const _argv = process.argv.slice(2);
    const _homeDir = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
    const _privacy = outMode.privacy;
    const safeRecordHistory = async (
      entry: Omit<Parameters<typeof recordHistory>[0], 'privacy'>,
    ): Promise<void> => {
      if (process.env.CCAUDIT_NO_HISTORY === '1') return;
      try {
        await recordHistory({ ...entry, privacy: _privacy });
      } catch (err) {
        process.stderr.write(
          `[ccaudit] warning: failed to record history: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    };

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
    const interactiveFlag = ctx.values.interactive === true;
    const nameFlag =
      typeof ctx.values.name === 'string' && ctx.values.name.length > 0
        ? ctx.values.name
        : undefined;
    const allMatchingFlag =
      typeof ctx.values.allMatching === 'string' && ctx.values.allMatching.length > 0
        ? ctx.values.allMatching
        : undefined;

    const warnings: string[] = [];
    const deps = buildProductionRestoreDeps(warnings);

    // M4: The outer try/catch covers ALL pre-dispatch flows including preflight
    // validation (mutual-exclusion, CCAUDIT_NO_INTERACTIVE, TTY guard) as well
    // as discovery (findManifestsForRestore, readManifest, openRestorePicker)
    // and executeRestore itself. RestorePreflightError is caught here and
    // short-circuits gracefully without a stack trace.
    let nameResolvedId: string | null = null;
    let allMatchingResolvedIds: string[] | null = null;
    let interactiveIds: string[] | null = null;
    let result: RestoreResult;
    try {
      // D8-11: mutual exclusion between --interactive / --name / --all-matching.
      const exclusion = validateRestoreFlagExclusion({
        interactive: interactiveFlag,
        name: nameFlag,
        allMatching: allMatchingFlag,
      });
      if (exclusion.type === 'Failure') {
        throw new RestorePreflightError(1, exclusion.error);
      }
      // --interactive + --list is also a hard error (list is read-only; picker
      // is an executing flow — no sensible combination).
      if (interactiveFlag && listFlag) {
        throw new RestorePreflightError(1, 'flags are mutually exclusive: --interactive, --list');
      }

      // Phase 9 D2 (SC2): CCAUDIT_NO_INTERACTIVE=1 hard-refuses explicit --interactive
      // with exit code 2. Mirrors the ghost.ts gate so refusal behavior is uniform.
      if (interactiveFlag && isNoInteractiveEnv()) {
        throw new RestorePreflightError(2, 'refusing: CCAUDIT_NO_INTERACTIVE is set');
      }

      // TTY guard (mirrors ghost.ts Site A). CCAUDIT_FORCE_TTY=1 is the
      // test-only hook; otherwise require a real interactive TTY on both
      // stdout and stdin.
      const forceTty = process.env['CCAUDIT_FORCE_TTY'] === '1';
      const isTty = forceTty || (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));
      if (interactiveFlag && !isTty) {
        throw new RestorePreflightError(
          1,
          '--interactive requires a TTY. Use --name <pattern> or --all-matching <pattern> in non-interactive contexts.',
        );
      }
      // --name client-side resolution (D8-09): exact 1 match → single-id
      // subset restore; 0 → no-match error; ≥2 → verbatim ambiguity block.
      // NEVER auto-picks the newest on ambiguity.
      if (nameFlag !== undefined) {
        const entries = await findManifestsForRestore(deps);
        const pairs = await Promise.all(
          entries.map(async (entry) => ({ entry, ops: (await readManifest(entry.path)).ops })),
        );
        const deduped = dedupManifestOps(pairs);
        const matches = matchByName(deduped, nameFlag);
        if (matches.length === 0) {
          throw new RestorePreflightError(1, `no archived item matches "${nameFlag}"`);
        }
        if (matches.length > 1) {
          throw new RestorePreflightError(
            1,
            formatAmbiguityError(
              nameFlag,
              matches.map((m) => m.canonical_id),
            ).trimEnd(),
          );
        }
        nameResolvedId = matches[0]!.canonical_id;
      }

      // D81-03: --all-matching CLI-side pre-dispatch gate mirroring --name.
      // 0 matches → stderr + exit 1 (fixes the legacy executor path that
      // mapped name-not-found → exit 0 silently succeeding on typos).
      // ≥1 match → collect canonical_ids and route through { kind:
      // 'interactive', ids: [...] }. The executor's all-matching branch
      // stays for API consumers but becomes CLI-unreachable.
      if (allMatchingFlag !== undefined) {
        const entries = await findManifestsForRestore(deps);
        const pairs = await Promise.all(
          entries.map(async (entry) => ({ entry, ops: (await readManifest(entry.path)).ops })),
        );
        const deduped = dedupManifestOps(pairs);
        const matches = matchByName(deduped, allMatchingFlag);
        if (matches.length === 0) {
          throw new RestorePreflightError(1, `no archived item matches "${allMatchingFlag}"`);
        }
        allMatchingResolvedIds = matches.map((m) => m.canonical_id);
      }

      // Plan 08-04: --interactive dispatch — discover archive inventory,
      // run the TUI picker, and translate confirmed selection into an
      // { kind: 'interactive', ids } RestoreMode. Cancelled/empty paths
      // must NOT reach executeRestore (INV-S2 mirror — zero manifest
      // writes on abort).
      if (interactiveFlag) {
        const entries = await findManifestsForRestore(deps);
        const pairs = await Promise.all(
          entries.map(async (entry) => ({ entry, ops: (await readManifest(entry.path)).ops })),
        );
        // Phase 8.1 D81-01 C1a: collectRestoreableItems (not dedupManifestOps)
        // so memory (flag/refresh) ops surface in the picker.
        // Phase 8.2: strip stale archive ops before populating the picker.
        const { kept: collected } = await filterRestoreableItems(
          collectRestoreableItems(pairs),
          deps.pathExists,
        );
        if (collected.length === 0) {
          throw new RestorePreflightError(0, 'Nothing to restore — archive is empty.');
        }
        const pickerItems: RestoreItem[] = collected.map((d) => {
          let category: RestoreItem['category'];
          if (d.op.op_type === 'archive') {
            category = d.op.category;
          } else if (d.op.op_type === 'disable') {
            category = 'mcp';
          } else {
            // flag / refresh — memory frontmatter ops
            category = 'memory';
          }
          return { canonical_id: d.canonical_id, op: d.op, category };
        });
        const outcome = await openRestorePicker(pickerItems);
        if (outcome.kind === 'cancelled') {
          process.stderr.write('No changes made.\n');
          process.exit(0);
        }
        interactiveIds = outcome.selectedIds;
      }

      const mode: RestoreMode = listFlag
        ? { kind: 'list' }
        : interactiveIds !== null
          ? { kind: 'interactive', ids: interactiveIds }
          : nameResolvedId !== null
            ? { kind: 'interactive', ids: [nameResolvedId] }
            : allMatchingResolvedIds !== null
              ? { kind: 'interactive', ids: allMatchingResolvedIds }
              : positionalName !== null
                ? { kind: 'single', name: String(positionalName) }
                : { kind: 'full' };

      result = await executeRestore(mode, deps);
    } catch (err) {
      // Defensive catch: covers both pre-dispatch flows (findManifestsForRestore,
      // readManifest, openRestorePicker) and executeRestore itself. Any failure
      // routes into the graceful degradation path: structured stderr/JSON output,
      // history write, and nonzero exit.
      //
      // RestorePreflightError: typed validation failures (mutual-exclusion,
      // CCAUDIT_NO_INTERACTIVE, TTY guard, no-match, ambiguity, empty archive).
      // Emit JSON envelope when --json is active; plain stderr otherwise.
      // No stack trace in either case.
      const isPreflight = err instanceof RestorePreflightError;
      const exitCode = isPreflight ? err.exitCode : 2;
      const message = err instanceof Error ? err.message : String(err);
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(buildJsonEnvelope('restore', 'n/a', exitCode, { error: message })) + '\n',
        );
      } else if (isPreflight) {
        process.stderr.write(message + '\n');
      } else {
        process.stderr.write(`ccaudit restore failed: ${message}\n`);
      }
      await safeRecordHistory({
        homeDir: _homeDir,
        command: 'restore',
        argv: _argv,
        exitCode,
        durationMs: Date.now() - _historyStartMs,
        cwd: process.cwd(),
        result: null,
        errors: [message],
        ccauditVersion: CCAUDIT_VERSION,
      });
      process.exit(exitCode);
    }

    const exitCode = restoreResultToExitCode(result);

    // Emit one stderr warning per skipped item BEFORE any stdout output so
    // --json / --csv / --quiet stdout streams remain pure (D8-16/17).
    if (result.status === 'success' || result.status === 'partial-success') {
      for (const entry of result.skipped ?? []) {
        process.stderr.write(`warning: skipped ${entry.path} — source already exists\n`);
      }
    }

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

    // Phase 6: build restore history result shape.
    const _historyResult =
      result.status === 'success' || result.status === 'partial-success'
        ? {
            moved: result.counts.unarchived.moved,
            already_at_source: result.counts.unarchived.alreadyAtSource,
            failed: result.counts.unarchived.failed,
            manifests_consumed: result.manifestPaths ?? [result.manifestPath],
          }
        : { status: result.status };
    await safeRecordHistory({
      homeDir: _homeDir,
      command: 'restore',
      argv: _argv,
      exitCode,
      durationMs: Date.now() - _historyStartMs,
      cwd: process.cwd(),
      result: _historyResult,
      errors: [],
      ccauditVersion: CCAUDIT_VERSION,
    });
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
        selection_filter: result.selectionFilter ?? null,
        skipped: result.skipped ?? [],
        filtered_stale_count: result.filteredStaleCount ?? 0,
      };
    case 'partial-success':
      return {
        ...base,
        status: result.status,
        counts: result.counts,
        manifest_path: result.manifestPath,
        duration_ms: result.duration_ms,
        failed: result.failed,
        selection_filter: result.selectionFilter ?? null,
        skipped: result.skipped ?? [],
        filtered_stale_count: result.filteredStaleCount ?? 0,
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
        filtered_stale_count: result.filteredStaleCount,
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
  const alreadyAtSourceNote =
    c.unarchived.alreadyAtSource > 0
      ? ` (${c.unarchived.alreadyAtSource} were already at source)`
      : '';
  const failedNote = c.unarchived.failed > 0 ? ` (${c.unarchived.failed} failed)` : '';
  lines.push(
    `${c.unarchived.moved} agents/skills restored to their original locations${alreadyAtSourceNote}${failedNote}`,
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
    return `restore\t${result.status}\t${c.unarchived.moved}\t${c.unarchived.alreadyAtSource}\t${c.reenabled.completed}\t${c.stripped.completed}\n`;
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
  const uOk = c.unarchived.moved + c.unarchived.alreadyAtSource;
  const uTotal = uOk + c.unarchived.failed;
  const rTotal = c.reenabled.completed + c.reenabled.failed;
  const sTotal = c.stripped.completed + c.stripped.failed;

  return (
    header +
    `restore,agents_skills,,all,,,${uOk}/${uTotal} ok,\n` +
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
            unarchived: { moved: 1, alreadyAtSource: 0, failed: 0 },
            reenabled: { completed: 0, failed: 0 },
            stripped: { completed: 0, failed: 0 },
          },
          manifestPath: '/p',
          manifestPaths: ['/p'],
          duration_ms: 10,
          skipped: [],
        },
        0,
      ],
      [{ status: 'no-manifests' }, 0],
      [{ status: 'name-not-found', name: 'x' }, 0],
      [{ status: 'list', entries: [], filteredStaleCount: 0 }, 0],
      [
        {
          status: 'partial-success',
          counts: {
            unarchived: { moved: 0, alreadyAtSource: 0, failed: 1 },
            reenabled: { completed: 0, failed: 0 },
            stripped: { completed: 0, failed: 0 },
          },
          failed: 1,
          manifestPath: '/p',
          manifestPaths: ['/p'],
          duration_ms: 5,
          skipped: [],
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
    it('success: emits tab-separated status + moved + alreadyAtSource + reenabled + stripped', () => {
      const result: RestoreResult = {
        status: 'success',
        counts: {
          unarchived: { moved: 2, alreadyAtSource: 1, failed: 0 },
          reenabled: { completed: 1, failed: 0 },
          stripped: { completed: 3, failed: 0 },
        },
        manifestPath: '/m',
        manifestPaths: ['/m'],
        duration_ms: 50,
        skipped: [],
      };
      expect(renderRestoreQuiet(result)).toBe('restore\tsuccess\t2\t1\t1\t3\n');
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
          unarchived: { moved: 1, alreadyAtSource: 0, failed: 0 },
          reenabled: { completed: 1, failed: 0 },
          stripped: { completed: 1, failed: 0 },
        },
        manifestPath: '/m',
        manifestPaths: ['/m'],
        duration_ms: 10,
        skipped: [],
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

  describe('formatAmbiguityError', () => {
    it('returns empty string for 0 candidates', () => {
      expect(formatAmbiguityError('pencil', [])).toBe('');
    });

    it('returns empty string for 1 candidate (no ambiguity)', () => {
      expect(formatAmbiguityError('pencil', ['agent:pencil-sharpener'])).toBe('');
    });

    it('renders the verbatim D8-09 block for 2 candidates (em-dash preserved)', () => {
      const out = formatAmbiguityError('pencil', ['agent:pencil-a', 'agent:pencil-b']);
      expect(out).toBe(
        '"pencil" is ambiguous \u2014 candidates:\n' +
          '  agent:pencil-a\n' +
          '  agent:pencil-b\n' +
          'Use --all-matching to restore every candidate.\n',
      );
    });

    it('includes every candidate on its own indented line for ≥3 matches', () => {
      const out = formatAmbiguityError('x', ['a', 'b', 'c']);
      const lines = out.split('\n');
      expect(lines[0]).toBe('"x" is ambiguous \u2014 candidates:');
      expect(lines[1]).toBe('  a');
      expect(lines[2]).toBe('  b');
      expect(lines[3]).toBe('  c');
      expect(lines[4]).toBe('Use --all-matching to restore every candidate.');
      expect(lines[5]).toBe('');
    });
  });

  describe('validateRestoreFlagExclusion', () => {
    const ERR = 'flags are mutually exclusive: --interactive, --name, --all-matching';
    it('Ok for no flags', () => {
      expect(validateRestoreFlagExclusion({}).type).toBe('Success');
    });
    it('Ok for --interactive alone', () => {
      expect(validateRestoreFlagExclusion({ interactive: true }).type).toBe('Success');
    });
    it('Ok for --name alone', () => {
      expect(validateRestoreFlagExclusion({ name: 'x' }).type).toBe('Success');
    });
    it('Ok for --all-matching alone', () => {
      expect(validateRestoreFlagExclusion({ allMatching: 'y' }).type).toBe('Success');
    });
    it('Err for interactive + name', () => {
      const r = validateRestoreFlagExclusion({ interactive: true, name: 'x' });
      expect(r.type).toBe('Failure');
      if (r.type === 'Failure') expect(r.error).toBe(ERR);
    });
    it('Err for interactive + allMatching', () => {
      const r = validateRestoreFlagExclusion({ interactive: true, allMatching: 'y' });
      expect(r.type).toBe('Failure');
      if (r.type === 'Failure') expect(r.error).toBe(ERR);
    });
    it('Err for name + allMatching', () => {
      const r = validateRestoreFlagExclusion({ name: 'x', allMatching: 'y' });
      expect(r.type).toBe('Failure');
      if (r.type === 'Failure') expect(r.error).toBe(ERR);
    });
    it('Err for all three set', () => {
      const r = validateRestoreFlagExclusion({
        interactive: true,
        name: 'x',
        allMatching: 'y',
      });
      expect(r.type).toBe('Failure');
      if (r.type === 'Failure') expect(r.error).toBe(ERR);
    });
  });
}
