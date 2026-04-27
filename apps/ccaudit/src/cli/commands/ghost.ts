import { rename, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { platform as osPlatform, homedir } from 'node:os';
import { dirname } from 'node:path';
import { define } from 'gunshi';
import { recordHistory } from '@ccaudit/internal';
import type { CommandResult } from '@ccaudit/internal';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
  enrichScanResults,
  calculateGhostTotalOverhead,
  sumHookTokens,
  calculateWorstCaseOverhead,
  groupGhostsByProject,
  groupByFramework,
  toGhostItems,
  redactPaths,
  buildRedactionMap,
  formatTotalOverhead,
  formatSavingsLine,
  calculateHealthScore,
  calculateUrgencyScore,
  classifyRecommendation,
  buildChangePlan,
  filterChangePlan,
  calculateDryRunSavings,
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
  atomicWriteText,
  defaultProcessDeps,
  detectClaudeProcesses,
  walkParentChain,
  applyFrameworkProtection,
  detectClaudeCodeVersion,
  resolveMcpRegime,
  CONTEXT_WINDOW_SIZE,
  isNoInteractiveEnv,
} from '@ccaudit/internal';
import type {
  InvocationRecord,
  CategorySummary,
  Checkpoint,
  BustResult,
  BustDeps,
  FrameworkGroup,
  GroupedInventory,
  ItemCategory,
  FrameworkBustResult,
  TokenCostResult,
  McpRegime,
} from '@ccaudit/internal';
import type { ProtectedItem } from '@ccaudit/terminal';
import {
  renderHeader,
  humanizeSinceWindow,
  renderFrameworksSection,
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
  renderHooksAdvisory,
  colorize,
  checkTuiGuards,
  shouldUseAscii,
  selectGhosts,
  runConfirmationPrompt,
  promptAutoOpen,
  renderRunningProcessMessage,
  runPreflightRetryLoop,
  type RunningProcessInput,
} from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';
import { CCAUDIT_VERSION } from '../../_version.ts';

// ---------------------------------------------------------------------------
// TEST-ONLY: CCAUDIT_TEST_PREFLIGHT_DIRTY=<N> wraps ProcessDetectorDeps.runCommand
// so the first N process-listing invocations (`ps -A ...` on Unix, `tasklist`
// on Windows) return synthetic "one claude pid" output; subsequent calls
// delegate to the real detector. Used by BOTH the interactive flow
// (bustDeps.processDetector + CLI retry-loop detectFn) and the non-interactive
// --dangerously-bust-ghosts bust path (runBust's internal preflight) so ONE
// env value drives every preflight layer. Regex-guarded (/^\d+$/) — not
// documented in --help, README, or CHANGELOG. Mirrors the CCAUDIT_FORCE_TTY
// pattern.
//
// A per-invocation counter is required so that within a single subprocess
// execution the first N calls fake and subsequent calls delegate; each CLI
// invocation builds a fresh wrapper with a fresh counter.
// ---------------------------------------------------------------------------
function buildWrappedProcessDeps(): typeof defaultProcessDeps {
  const dirtyRaw = process.env['CCAUDIT_TEST_PREFLIGHT_DIRTY'];
  const dirtyCount = dirtyRaw && /^\d+$/.test(dirtyRaw) ? Number.parseInt(dirtyRaw, 10) : 0;
  if (dirtyCount <= 0) return defaultProcessDeps;
  let dirtyRemaining = dirtyCount;
  return {
    runCommand: async (cmd: string, args: string[], timeoutMs: number): Promise<string> => {
      // Only fake the process-listing commands (`ps -A ...` on Unix,
      // `tasklist /FO ...` on Windows). All other runCommand calls
      // (e.g., `ps -o ppid=` used by getParentPid) delegate to the real
      // runCommand so walkParentChain continues to work correctly against
      // the real process tree.
      const isListCmd =
        (cmd === 'ps' && args[0] === '-A') || (cmd === 'tasklist' && args.includes('/FO'));
      if (isListCmd && dirtyRemaining > 0) {
        dirtyRemaining -= 1;
        // Diagnostic marker (B2): proves the hook fired inside runBust's
        // preflight. Integration test asserts this appears at least N times.
        process.stderr.write(`[PREFLIGHT_DIRTY] synthetic dirty #${dirtyCount - dirtyRemaining}\n`);
        if (cmd === 'ps') {
          // Unix ps -A -o pid=,comm= shape: "  <pid> <comm>"
          return '  99999 claude\n';
        }
        // Windows tasklist /FO CSV /NH shape: quoted CSV row.
        return '"claude.exe","99999","Console","1","45,000 K"\r\n';
      }
      return defaultProcessDeps.runCommand(cmd, args, timeoutMs);
    },
    getParentPid: defaultProcessDeps.getParentPid,
    platform: defaultProcessDeps.platform,
  };
}

// ---------------------------------------------------------------------------
// buildInteractivePickerFeed — Phase 6 (D6-01 / D6-09 runtime wiring)
//
// `applyFrameworkProtection` strips framework-protected ghosts out of
// `filtered` when --force-partial is OFF. Phase 6 wants those rows to
// still RENDER in the picker (dimmed + [🔒]) so the user understands
// why they cannot be selected. This helper merges the protected items
// back into the picker feed and attaches `InventoryItem.protection` to
// each merged item so `isProtected()` returns true and the toggle guard
// blocks selection. The server-side INV-S6 gate (hash-matched checkpoint)
// still enforces correctness regardless of UI behavior.
//
// When `--force-partial` is ON, `filtered` already contains every ghost
// (applyFrameworkProtection pass-through), so we return it unchanged —
// no protected row is locked in that mode by design (D6-13).
//
// When `groupFrameworks` is false, no protection grouping runs upstream,
// so this helper is a pass-through filter for tier !== 'used'.
// ---------------------------------------------------------------------------
function buildInteractivePickerFeed(
  interactiveProtection: FrameworkBustResult,
  enriched: TokenCostResult[],
  groupFrameworks: boolean,
): TokenCostResult[] {
  const filtered = interactiveProtection.filtered.filter((r) => r.tier !== 'used');
  if (!groupFrameworks || interactiveProtection.protectedItems.length === 0) {
    return filtered;
  }

  // Recompute the per-path protection annotation from the same grouping
  // applyFrameworkProtection used internally. Reuse toGhostItems/groupByFramework
  // so behavior stays in lockstep with scanner annotate.ts without exposing new
  // API surface from the remediation package.
  const ghostItems = toGhostItems(enriched);
  const grouped = groupByFramework(ghostItems);
  const protectionByPath = new Map<
    string,
    { framework: string; total: number; ghostCount: number; reason: string }
  >();
  for (const fw of grouped.frameworks) {
    if (fw.status !== 'partially-used') continue;
    const ghostCount = fw.totals.likelyGhost + fw.totals.definiteGhost;
    const reason = `Part of ${fw.displayName} (${fw.totals.used} used, ${ghostCount} ghost). --force-partial to override.`;
    const protection = {
      framework: fw.id,
      total: fw.totals.defined,
      ghostCount,
      reason,
    };
    for (const m of fw.members) protectionByPath.set(m.path, protection);
  }

  const annotatedProtected = interactiveProtection.protectedItems.map((r) => {
    const p = protectionByPath.get(r.item.path);
    if (p === undefined) return r;
    return { ...r, item: { ...r.item, protection: p } };
  });

  // Preserve filtered ordering, then append protected items (stable).
  return [...filtered, ...annotatedProtected];
}

// ---------------------------------------------------------------------------
// runInteractiveGhostFlow — private module helper (Plan 03, D-05..D-21, D-26)
//
// Orchestrates the full interactive archive flow on a TTY:
//   guard check → empty-inventory short-circuit → checkpoint write →
//   selectGhosts picker → runConfirmationPrompt → runBust (ceremony skipped)
//
// Plan 04 will add a SECOND call site (the auto-open 'y' branch). This
// function MUST remain module-scoped — do NOT inline or nest inside run(ctx).
// ---------------------------------------------------------------------------
async function runInteractiveGhostFlow(args: {
  /** Full enriched inventory (all tiers) from the outer scan+enrich step. */
  enriched: TokenCostResult[];
  /** Pre-filtered to tier !== 'used' (ghost items only). */
  ghosts: TokenCostResult[];
  /** Resolved since window string (e.g. "7d") for checkpoint + BustDeps. */
  sinceStr: string;
  /** Resolved regime flag ('eager' | 'deferred' | 'auto'). */
  regimeFlag: McpRegime | 'auto';
  /** Claude Code version detected at startup (null if regime != 'auto'). */
  detectedCcVersion: string | null;
  /** The output mode object resolved by resolveOutputMode, plus raw ci flag. */
  mode: {
    json: boolean;
    csv: boolean;
    quiet: boolean;
    /** Raw --ci flag value (not absorbed into mode.json/mode.quiet yet for guard check). */
    ci: boolean;
    groupFrameworks: boolean;
    verbose: boolean;
    privacy: boolean;
  };
  /** Whether --force-partial was passed. */
  forcePartial: boolean;
  /** Pre-resolved MCP regime (computed by caller after enrichScanResults). */
  resolvedRegime: McpRegime;
  /** Pre-computed worst-case session overhead for checkpoint.total_overhead. */
  totalOverhead: number;
}): Promise<void> {
  const {
    enriched,
    ghosts,
    sinceStr,
    regimeFlag,
    detectedCcVersion,
    mode,
    forcePartial,
    resolvedRegime,
    totalOverhead,
  } = args;

  // ── Guard: narrow terminal (D-08, D-23) ──────────────────────────────────
  // Note: non-TTY + explicit --interactive is already handled by the caller
  // (which sets effectiveDryRun=true and falls through). If we somehow reach
  // here with a non-TTY, the guard will catch it defensively.
  // TEST-ONLY: CCAUDIT_FORCE_TTY=1 — see ghost.ts Site A in run() for full rationale.
  const forceTty = process.env['CCAUDIT_FORCE_TTY'] === '1';
  const isTty = forceTty || (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));
  const ttyCols = process.stdout.columns;
  const guard = checkTuiGuards({
    mode: {
      json: mode.json,
      csv: mode.csv,
      quiet: mode.quiet,
      ci: mode.ci,
      dryRun: false, // interactive path already bypassed dry-run branch
      dangerouslyBustGhosts: false, // interactive path is distinct
    },
    isTty,
    ttyCols,
    isExplicitInteractive: true,
  });

  switch (guard.kind) {
    case 'hard-error':
      // Unreachable: D-06 is caught before the scan at the flag-parse stage.
      console.error(guard.message);
      process.exitCode = guard.exitCode;
      return;
    case 'fallback-dry-run':
      // Non-TTY path — caller should have handled this, but defensive guard.
      console.error(guard.reason);
      return;
    case 'refuse-narrow':
      console.error(guard.message);
      process.exitCode = 1;
      return;
    case 'suppress-auto-open':
      // Unreachable when isExplicitInteractive=true — defensive.
      return;
    case 'ok':
      break;
  }

  // TEST-ONLY wrapped detectors — see buildWrappedProcessDeps() docstring.
  // CCAUDIT_TEST_PREFLIGHT_DIRTY=<N> gives EACH layer its own counter of N
  // synthetic dirty calls. `entryProcessDeps` drives the entry preflight;
  // `bustProcessDeps` drives bustDeps.processDetector AND the bust-time CLI
  // retry loop's detectFn. Separate counters are required so exhausting the
  // entry counter does not starve the bust-time layer — the SC5b integration
  // test exercises BOTH layers in a single subprocess run.
  const entryProcessDeps = buildWrappedProcessDeps();
  const bustProcessDeps = buildWrappedProcessDeps();

  // ── Phase 3.2 SC4: running-Claude preflight BEFORE picker opens ───────
  // Mirrors the preflight that runBust runs at bust.ts:265, hoisted to run
  // BEFORE the user invests selection time. Also determines self-invocation
  // via walkParentChain (same logic as bust.ts:274) so the entry retry loop
  // can short-circuit cleanly when ccaudit is spawned from inside Claude.
  {
    // DIRTY-counter accounting (CCAUDIT_TEST_PREFLIGHT_DIRTY): this initial
    // detectClaudeProcesses call consumes ONE counter tick on entryProcessDeps;
    // each user-confirmed retry inside runPreflightRetryLoop consumes one more.
    const detected = await detectClaudeProcesses(process.pid, entryProcessDeps);
    let initialResult: RunningProcessInput | undefined;
    if (detected.status === 'spawn-failed') {
      // Fail-closed (D-02 invariant, matches bust.ts:268): cannot verify → refuse.
      console.error(`Could not verify Claude Code is stopped: ${detected.error}`);
      console.error('Run from a clean shell where ps (Unix) or tasklist (Windows) is available.');
      process.exitCode = 2;
      return;
    }
    if (detected.processes.length > 0) {
      const chain = await walkParentChain(process.pid, entryProcessDeps);
      const detectedPids = new Set(detected.processes.map((p) => p.pid));
      const selfInvocation = chain.some((p) => detectedPids.has(p));
      initialResult = {
        selfInvocation,
        pids: detected.processes.map((p) => p.pid),
      };
    }
    if (initialResult !== undefined) {
      const outcome = await runPreflightRetryLoop({
        detectFn: () => detectClaudeProcesses(process.pid, entryProcessDeps),
        phase: 'entry',
        initialResult,
      });
      if (outcome.status === 'cancelled') {
        console.error('No changes made.');
        return; // exit 0 — INV-S2 compatible: no checkpoint written yet
      }
      if (outcome.status === 'spawn-failed') {
        console.error(`Could not verify Claude Code is stopped: ${outcome.error}`);
        console.error('Run from a clean shell where ps (Unix) or tasklist (Windows) is available.');
        process.exitCode = 2;
        return;
      }
      // outcome.status === 'clear' → Claude was closed during the retry prompt.
      // Fall through to normal flow.
    }
    // detected.processes.length === 0 → preflight clear; fall through.
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── D-13: empty inventory → skip picker entirely ──────────────────────────
  if (ghosts.length === 0) {
    console.log('✅ No ghosts found. Your inventory is clean.');
    return;
  }

  // ── Write dry-run checkpoint BEFORE opening picker (D-26) ────────────────
  // Apply framework protection first so the checkpoint hash matches runBust.
  const interactiveProtection = applyFrameworkProtection(enriched, {
    forcePartial,
    groupFrameworks: mode.groupFrameworks,
  });
  const interactivePlan = buildChangePlan(interactiveProtection.filtered);
  const ghostHash = await computeGhostHash(interactiveProtection.filtered);

  const checkpoint = {
    checkpoint_version: 1 as const,
    ccaudit_version: CCAUDIT_VERSION,
    timestamp: new Date().toISOString(),
    since_window: sinceStr,
    ghost_hash: ghostHash,
    item_count: interactivePlan.counts,
    savings: interactivePlan.savings,
    total_overhead: totalOverhead,
    mcp_regime: resolvedRegime,
    cc_version: detectedCcVersion,
  };

  try {
    await writeCheckpoint(checkpoint, resolveCheckpointPath());
  } catch (err) {
    console.error(`[ccaudit] Failed to write checkpoint: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  // ── Open picker (D-02, D-09..D-13) ───────────────────────────────────────
  const useAscii = shouldUseAscii(process.env, process.stdout, ttyCols);
  // Only ghost-tier items go into the picker (D-11). Phase 6 (D6-01/D6-09):
  // when --force-partial is OFF, also render protected rows (dimmed + [🔒])
  // so users can see WHY the rows cannot be selected. The picker's toggle
  // guard prevents selection; the server-side INV-S6 gate (hash-matched
  // checkpoint written above) is the real enforcer.
  const pickerGhosts = buildInteractivePickerFeed(
    interactiveProtection,
    enriched,
    mode.groupFrameworks,
  );
  const pickOutcome = await selectGhosts({
    ghosts: pickerGhosts,
    now: Date.now(),
    useAscii,
    forcePartial,
  });

  if (pickOutcome.kind === 'cancel') {
    console.error('No changes made.');
    return; // exit 0 (D-08)
  }
  if (pickOutcome.kind === 'empty-inventory') {
    console.log('✅ No ghosts found. Your inventory is clean.');
    return;
  }

  const selectedItems = pickOutcome.ids;
  if (selectedItems.size === 0) {
    console.error('No changes made.');
    return;
  }

  // ── Confirmation screen + prompt (D-17..D-21, boolean-only per D-21) ──────
  const filteredPlan = filterChangePlan(interactivePlan, selectedItems);
  const estSavings = calculateDryRunSavings(filteredPlan);
  const manifestDir = dirname(resolveManifestPath());

  const confirmOutcome = await runConfirmationPrompt({
    plan: filteredPlan,
    estSavings,
    manifestDir,
    useAscii,
  });

  // v0.5: ConfirmationOutcome is { kind: 'proceed' } | { kind: 'cancel' } only (D-21).
  if (confirmOutcome.kind === 'cancel') {
    console.error('No changes made.');
    return; // exit 0 (D-08)
  }
  // confirmOutcome.kind === 'proceed' — fall through to bust.

  // ── Execute bust with ceremony skipped (D-19, D-20) ──────────────────────
  const sinceMs = parseDuration(sinceStr);
  const bustDeps: BustDeps = {
    readCheckpoint,
    checkpointPath: () => resolveCheckpointPath(),
    scanAndEnrich: async () => {
      const sessionFiles = await discoverSessionFiles({ sinceMs });
      const invocations: InvocationRecord[] = [];
      const projPaths = new Set<string>();
      for (const file of sessionFiles) {
        const r2 = await parseSession(file, sinceMs);
        invocations.push(...r2.invocations);
        if (r2.meta.projectPath) projPaths.add(r2.meta.projectPath);
      }
      const { results: scanResults } = await scanAll(invocations, {
        projectPaths: [...projPaths],
      });
      const rawEnriched = await enrichScanResults(scanResults, {
        regime: regimeFlag,
        ccVersion: detectedCcVersion,
      });
      const protection = applyFrameworkProtection(rawEnriched, {
        forcePartial,
        groupFrameworks: mode.groupFrameworks,
      });
      return protection.filtered;
    },
    computeHash: (e) => computeGhostHash(e),
    processDetector: bustProcessDeps,
    selfPid: process.pid,
    // runCeremony is unused when skipCeremony=true, but the dep is required
    // by BustDeps shape. Provide a no-op to satisfy the interface.
    runCeremony: async () => ({ status: 'accepted' as const }),
    renameFile: async (from, to) => {
      await rename(from, to);
    },
    mkdirRecursive: async (dir, modeArg) => {
      await mkdir(dir, { recursive: true, mode: modeArg });
    },
    readFileUtf8: (p) => readFile(p, 'utf8'),
    patchMemoryFrontmatter: patchFrontmatter,
    atomicWriteJson: (target, value) => atomicWriteJson(target, value),
    atomicWriteText: (target, text) => atomicWriteText(target, text),
    pathExistsSync: existsSync,
    createManifestWriter: (p) => new ManifestWriter(p),
    manifestPath: () => resolveManifestPath(),
    now: () => new Date(),
    ccauditVersion: CCAUDIT_VERSION,
    nodeVersion: process.version,
    sinceWindow: sinceStr,
    os: osPlatform(),
  };

  let result = await runBust({
    yes: true,
    deps: bustDeps,
    selectedItems,
    skipCeremony: true,
  });

  // ── Phase 3.2 SC5b: bust-time running-process retry loop ──────────────────
  // runBust still runs the authoritative preflight at bust.ts:264-286; if it
  // returns { status: 'running-process' }, we reuse the shared retry helper
  // and re-invoke runBust with the SAME selectedItems Set — identity preserved
  // across every retry, no picker re-open. Self-invocation short-circuits via
  // runPreflightRetryLoop (closing the parent session would kill ccaudit).
  while (result.status === 'running-process') {
    const retryOutcome = await runPreflightRetryLoop({
      detectFn: () => detectClaudeProcesses(process.pid, bustProcessDeps),
      phase: 'bust',
      initialResult: { selfInvocation: result.selfInvocation, pids: result.pids },
    });
    if (retryOutcome.status === 'cancelled') {
      console.error('No changes made.');
      return; // exit 0 — no checkpoint mutation, selectedItems still valid
    }
    if (retryOutcome.status === 'spawn-failed') {
      console.error(`Could not verify Claude Code is stopped: ${retryOutcome.error}`);
      console.error('Run from a clean shell where ps (Unix) or tasklist (Windows) is available.');
      process.exitCode = 2;
      return;
    }
    // retryOutcome.status === 'clear' → re-invoke runBust with SAME selectedItems.
    result = await runBust({
      yes: true,
      deps: bustDeps,
      selectedItems, // <-- identity preserved (SC5b)
      skipCeremony: true,
    });
  }

  // ── D-26: hash-mismatch is terminal informational (no [y/N] prompt) ───────
  if (result.status === 'hash-mismatch') {
    console.error('Filesystem changed since scan. Re-run ccaudit ghost --interactive to re-scan.');
    console.error('No changes made.');
    return; // exit 0 — informational, not an error (D-26)
  }

  // ── Render outcome ────────────────────────────────────────────────────────
  if (result.status === 'success' && !mode.quiet) {
    const displayManifestPath = mode.privacy
      ? result.manifestPath.replace(homedir(), '~')
      : result.manifestPath;
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
          archivedAgents: result.counts.archive.agents,
          archivedSkills: result.counts.archive.skills,
          disabledMcp: result.counts.disable.completed,
          flaggedMemory: result.counts.flag.completed + (result.counts.flag.refreshed ?? 0),
        },
        manifestPath: displayManifestPath,
        privacy: mode.privacy,
        beforeProvenance: { source: 'dry-run', at: result.summary.checkpointTimestamp },
      }),
    );
    console.log('');
  } else if (result.status === 'partial-success' && !mode.quiet) {
    const partialManifestPath = mode.privacy
      ? result.manifestPath.replace(homedir(), '~')
      : result.manifestPath;
    console.log('');
    console.log(`Done with failures. ${result.failed} op(s) failed — see manifest for details.`);
    console.log(`Manifest: ${partialManifestPath}`);
  } else if (result.status !== 'success' && result.status !== 'partial-success') {
    // running-process was consumed by the retry loop above; this branch now
    // handles checkpoint-missing / checkpoint-invalid / process-detection-failed /
    // user-aborted / config-parse-error / config-write-error.
    console.error(`[ccaudit] Interactive bust failed: ${result.status}`);
    process.exitCode = bustResultToExitCode(result);
  }
}

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
      description: 'JSON output (docs/JSON-SCHEMA.md)',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Show scan details',
      default: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview changes without mutating files (writes checkpoint)',
      default: false,
    },
    interactive: {
      type: 'boolean',
      short: 'i',
      description:
        'Open interactive TUI picker to archive a subset of ghosts. Requires a TTY; non-TTY falls back to --dry-run.',
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
      description: 'Skip confirmation prompts (required for non-TTY/CI).',
      default: false,
    },
    privacy: {
      type: 'boolean',
      description:
        'Redact real project paths from output (replaces with project-01, project-02, etc.)',
      default: false,
    },
    forcePartial: {
      type: 'boolean',
      description:
        'Allow partial-framework busts. Also changes dry-run eligibility and checkpoint hash, so both runs must use the same value. Under --interactive, unlocks protected rows for the current run.',
      default: false,
    },
    regime: {
      type: 'string',
      description:
        'MCP token regime: eager (full schemas), deferred (ToolSearch, cc >=2.1.7), or auto (detect). Default: auto.',
      default: 'auto',
    },
    includeHooks: {
      type: 'boolean',
      description:
        'Include hook upper-bound tokens in the grand total (pessimistic mode — assumes every inject-capable hook fires). Default: hooks shown as advisory section, not aggregated.',
      default: false,
    },
  },
  async run(ctx) {
    // Phase 6: history instrumentation — measure wall-clock duration for audit trail.
    const _historyStartMs = Date.now();
    // Determine command name from argv: dry-run, bust, or ghost (default).
    const _argv = process.argv.slice(2);
    const _isDryRun = ctx.values.dryRun === true;
    const _isBust = ctx.values.dangerouslyBustGhosts === true;
    const _isInteractive = ctx.values.interactive === true;

    // D-06: --interactive + --json is a hard error at parse time, before any scan.
    if (_isInteractive && ctx.values.json === true) {
      console.error('Error: --interactive cannot be combined with --json.');
      process.exitCode = 2;
      return;
    }

    // D-07: effectiveDryRun is set to true when --interactive is passed but no TTY
    // is available. The --interactive branch below sets this; the dry-run branch
    // below checks it so the non-TTY fallback path runs correctly.
    let effectiveDryRun = false;

    // historyResult accumulates structured result for the history entry.
    // Each branch populates this before returning.
    let _historyResult: CommandResult = null;
    const _historyErrors: string[] = [];

    const _recordGhostHistory = async (command: string): Promise<void> => {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
      // TODO(v1.5): build a real redactionMap from projectSummaries for deep path redaction.
      // For v1.4.0 the record.ts fallback redacts homeDir from cwd, which covers the stated guarantee.
      const redactionMap =
        ctx.values.privacy === true
          ? undefined // fallback in record.ts replaces homeDir prefix
          : undefined;
      await recordHistory({
        homeDir,
        command,
        argv: _argv,
        exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0,
        durationMs: Date.now() - _historyStartMs,
        cwd: process.cwd(),
        privacy: ctx.values.privacy === true,
        redactionMap,
        result: _historyResult,
        errors: _historyErrors,
        ccauditVersion: CCAUDIT_VERSION,
      });
    };

    try {
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

      // Detect Claude Code version once (only needed when regime is 'auto')
      let detectedCcVersion: string | null = null;
      if (regimeFlag === 'auto') {
        detectedCcVersion = await detectClaudeCodeVersion();
      }

      // Resolve --include-hooks flag (default false = hooks advisory section only)
      const includeHooks = ctx.values.includeHooks === true;

      // Initialize color detection from process.argv (--no-color) and env (NO_COLOR)
      // Must be called before ANY rendering. Takes no arguments per D-07.
      initColor();

      // Resolve output mode from all flag values.
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

      // Step 3.5: Enrich with token estimates (regime-aware)
      const enriched = await enrichScanResults(results, {
        regime: regimeFlag,
        ccVersion: detectedCcVersion,
      });

      // v1.3.0 Phase 4 helper: adapt TokenCostResult[] to the terminal package's
      // ProtectedItem[] shape used by renderChangePlan / renderChangePlanVerbose.
      const toProtectedItems = (items: TokenCostResult[]): ProtectedItem[] =>
        items.map((r) => ({
          category: r.item.category,
          scope: r.item.scope,
          name: r.item.name,
          projectPath: r.item.projectPath,
          path: r.item.path,
          tokens: r.tokenEstimate?.tokens ?? 0,
          framework: r.item.framework ?? null,
          tier: r.tier,
        }));

      // Step 3.55: Interactive branch (Phase 2, Plan 03)
      // Placed BEFORE the dry-run branch so --interactive short-circuits here.
      // Non-TTY path sets effectiveDryRun=true and falls through to Step 3.6.
      if (ctx.values.interactive === true) {
        // Phase 9 D2 (SC2): CCAUDIT_NO_INTERACTIVE=1 hard-refuses explicit --interactive
        // with exit code 2. Fails closed before TTY detection or any scan-derived state.
        if (isNoInteractiveEnv()) {
          process.stderr.write('refusing: CCAUDIT_NO_INTERACTIVE is set\n');
          process.exitCode = 2;
          return;
        }
        // Phase 9 D1 (SC1): zero-ghost short-circuit. Skip TUI entirely, print a
        // single clean line to stdout, exit 0. Applies uniformly to TTY + non-TTY.
        if (!enriched.some((r) => r.tier !== 'used')) {
          console.log('Inventory is clean — no ghosts to archive.');
          return;
        }
        // Site A: TEST-ONLY: CCAUDIT_FORCE_TTY=1 lets the Phase 3 INV-S2 integration test
        // exercise the runInteractiveGhostFlow path from a non-pty subprocess
        // (Phase 3 D-21 / CONTEXT.md). NEVER document in --help. This env var has
        // no effect on production usage because users on a real terminal already
        // have isTTY === true, and CI/non-TTY users would never set it.
        const forceTty = process.env['CCAUDIT_FORCE_TTY'] === '1';
        const isTty = forceTty || (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY));
        if (!isTty) {
          // D-07: non-TTY + explicit --interactive → fall back to dry-run with notice.
          console.error('No TTY detected — running in dry-run mode.');
          effectiveDryRun = true;
          // Fall through to the dry-run branch below.
        } else {
          // TTY path: delegate to the extracted interactive flow helper.
          const ghosts = enriched.filter((r) => r.tier !== 'used');
          // Pre-compute regime and worst-case overhead so the helper avoids duplicating
          // the expensive resolveMcpRegime + groupGhostsByProject calls.
          let interactiveResolvedRegime: McpRegime;
          if (regimeFlag === 'auto') {
            const eagerMcpTotal = enriched
              .filter((r) => r.item.category === 'mcp-server')
              .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
            interactiveResolvedRegime = resolveMcpRegime({
              totalMcpToolTokens: eagerMcpTotal,
              contextWindow: CONTEXT_WINDOW_SIZE,
              ccVersion: detectedCcVersion,
              override: null,
            }).regime;
          } else {
            interactiveResolvedRegime = regimeFlag;
          }
          const { global: iGlobal, projects: iProjects } = groupGhostsByProject(ghosts, homedir());
          const { total: iWorstCase } = calculateWorstCaseOverhead(iGlobal, iProjects);
          await runInteractiveGhostFlow({
            enriched,
            ghosts,
            sinceStr,
            regimeFlag,
            detectedCcVersion,
            mode: {
              json: mode.json,
              csv: mode.csv,
              quiet: mode.quiet,
              ci: ctx.values.ci === true,
              groupFrameworks: mode.groupFrameworks,
              verbose: mode.verbose,
              privacy: mode.privacy,
            },
            forcePartial: ctx.values.forcePartial === true,
            resolvedRegime: interactiveResolvedRegime,
            totalOverhead: iWorstCase,
          });
          return;
        }
      }

      // Step 3.6: Dry-run branch (Phase 7, D-01 through D-20)
      // Lifted before the inventory rendering chain per RESEARCH §CLI Integration —
      // single decision point, four output modes per command mode (8 test cases total).
      if (ctx.values.dryRun || effectiveDryRun) {
        // v1.3.0 Phase 4: framework-as-unit bust protection (D-27).
        // Filter must run BEFORE buildChangePlan and BEFORE computeGhostHash so
        // both dry-run and bust paths see the same eligible set (hashes match).
        const dryRunProtection = applyFrameworkProtection(enriched, {
          forcePartial: ctx.values.forcePartial === true,
          groupFrameworks: mode.groupFrameworks,
        });

        // D-39 informational warning: --force-partial is a no-op when grouping disabled.
        if (!mode.groupFrameworks && ctx.values.forcePartial === true) {
          console.error(
            'warning: --force-partial has no effect with --no-group-frameworks; framework protection is already disabled.',
          );
        }

        // Verbose stderr log for protection activity (Claude's Discretion / RESEARCH §1.4).
        if (mode.verbose && dryRunProtection.warnings.length > 0) {
          console.error(
            `[ccaudit] Framework protection: ${dryRunProtection.protectedItems.length} item(s) protected across ${dryRunProtection.warnings.length} framework(s)`,
          );
        }

        const plan = buildChangePlan(dryRunProtection.filtered);

        // Compute the hash over archive-eligible items (D-10 through D-16)
        // Pass the FILTERED list so dry-run and bust hashes match by construction.
        const ghostHash = await computeGhostHash(dryRunProtection.filtered);

        // Compute worst-case session overhead for total_overhead checkpoint field.
        // Mirrors Step 5.5 logic: group ghosts, then sum global + worst project cost.
        const dryRunGhosts = dryRunProtection.filtered.filter((r) => r.tier !== 'used');
        const { global: dryRunGlobalSummary, projects: dryRunProjectSummaries } =
          groupGhostsByProject(dryRunGhosts, homedir());
        const dryRunRedactionMap = ctx.values.privacy
          ? buildRedactionMap(dryRunProjectSummaries)
          : null;
        const { total: dryRunWorstCaseTotal } = calculateWorstCaseOverhead(
          dryRunGlobalSummary,
          dryRunProjectSummaries,
        );

        // Resolve the MCP regime at dry-run time and pin it in the checkpoint.
        // This eliminates Before/After drift caused by the 500ms subprocess timeout
        // in detectClaudeCodeVersion flipping regime between otherwise-identical runs.
        // Phase 5: regime is resolved once here and stored; bust reads the pinned value.
        let dryRunResolvedRegime: McpRegime;
        if (regimeFlag === 'auto') {
          const eagerMcpTotal = enriched
            .filter((r) => r.item.category === 'mcp-server')
            .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
          dryRunResolvedRegime = resolveMcpRegime({
            totalMcpToolTokens: eagerMcpTotal,
            contextWindow: CONTEXT_WINDOW_SIZE,
            ccVersion: detectedCcVersion,
            override: null,
          }).regime;
        } else {
          dryRunResolvedRegime = regimeFlag;
        }

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
          mcp_regime: dryRunResolvedRegime,
          cc_version: detectedCcVersion,
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
          // v1.3.0 Phase 4: protected items must be redacted via the same
          // helper as archive/disable/flag (privacy mode parity, OUT-05).
          const protectedItemsForEnvelope = mode.groupFrameworks
            ? toProtectedItems(dryRunProtection.protectedItems)
            : [];
          const envelope = buildJsonEnvelope('ghost', sinceStr, 0, {
            dryRun: true,
            changePlan: {
              archive: redactItems(plan.archive),
              disable: redactItems(plan.disable),
              flag: redactItems(plan.flag),
              counts: plan.counts,
              savings: plan.savings,
              // v1.3.0 Phase 4 (D-30): additive — omitted entirely when grouping
              // disabled or no frameworks were protected.
              ...(mode.groupFrameworks && dryRunProtection.protectedItems.length > 0
                ? { protected: redactItems(protectedItemsForEnvelope) }
                : {}),
              ...(mode.groupFrameworks && dryRunProtection.warnings.length > 0
                ? { protectionWarnings: dryRunProtection.warnings }
                : {}),
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
          // v1.3.0 Phase 4: append protected items as additional rows with
          // action='protected'. Omitted when grouping is disabled (v1.2.1 byte-identity).
          const csvProtectedRows = mode.groupFrameworks
            ? toProtectedItems(dryRunProtection.protectedItems).map((p) => {
                const r = dryRunRedactionMap ? redactItem(p) : p;
                return [
                  'protected',
                  p.category,
                  p.name,
                  p.scope,
                  r.projectPath ?? '',
                  r.path,
                  String(p.tokens),
                  p.tier,
                ];
              })
            : [];
          const rows = [
            ...[...plan.archive, ...plan.disable, ...plan.flag].map((i) => {
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
            }),
            ...csvProtectedRows,
          ];
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
          // v1.3.0 Phase 4: append protected rows with action='protected'.
          if (mode.groupFrameworks) {
            for (const p of toProtectedItems(dryRunProtection.protectedItems)) {
              const r = dryRunRedactionMap ? redactItem(p) : p;
              console.log(
                tsvRow([
                  'protected',
                  p.category,
                  p.name,
                  p.scope,
                  r.projectPath ?? '',
                  r.path,
                  String(p.tokens),
                  p.tier,
                ]),
              );
            }
          }
        } else {
          // Default rendered output (D-05, D-06): header + grouped body + verbose + checkpoint footer
          console.log('');
          console.log(renderHeader('\u{1F47B}', 'Dry-Run', humanizeSinceWindow(sinceStr)));
          console.log('');
          // v1.3.0 Phase 4 (D-29, D-34): pass framework-protection rendering data
          // so the yellow warning block + PROTECTED section appear above/below
          // the existing ARCHIVE/DISABLE/FLAG groups. The renderer omits both
          // when warnings/protectedItems are empty.
          const dryRunProtectedForRenderer = mode.groupFrameworks
            ? toProtectedItems(dryRunProtection.protectedItems).map((p) => ({
                ...p,
                ...redactItem(p),
              }))
            : [];
          console.log(
            renderChangePlan(plan, {
              protectionWarnings: mode.groupFrameworks ? dryRunProtection.warnings : [],
              protected: dryRunProtectedForRenderer,
              forcePartial: ctx.values.forcePartial === true,
              privacy: ctx.values.privacy === true,
              redactionMap: dryRunRedactionMap ?? undefined,
              homedir: homedir(),
            }),
          );
          console.log('');
          if (mode.verbose) {
            console.log(
              renderChangePlanVerbose(plan, {
                protected: dryRunProtectedForRenderer,
                protectionWarnings: mode.groupFrameworks ? dryRunProtection.warnings : [],
                forcePartial: ctx.values.forcePartial === true,
                privacy: ctx.values.privacy === true,
                redactionMap: dryRunRedactionMap ?? undefined,
                homedir: homedir(),
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
        // Phase 6: populate dry-run history result shape.
        _historyResult = {
          planned_archive: plan.archive.length,
          planned_disable: plan.disable.length,
          planned_flag: plan.flag.length,
          checkpoint_hash: ghostHash,
        };
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

        // v1.3.0 Phase 4 (D-39): same informational warning as dry-run when
        // --force-partial is combined with --no-group-frameworks.
        if (!mode.groupFrameworks && ctx.values.forcePartial === true) {
          console.error(
            'warning: --force-partial has no effect with --no-group-frameworks; framework protection is already disabled.',
          );
        }

        // v1.3.0 Phase 4 (D-33): captured FrameworkBustResult for the runCeremony
        // closure and the JSON envelope. Populated inside the scanAndEnrich
        // closure below.
        let bustProtection: FrameworkBustResult | null = null;

        /**
         * CCAUDIT_SELECT_IDS — internal integration-test hook (Phase 1, Plan 03).
         *
         * Comma-separated canonical item IDs (format: canonicalItemId(InventoryItem)).
         * When set, parses into a Set<string> passed to runBust so only the listed
         * items are archived/disabled. When absent, preserves the v1.4.0 full-inventory
         * behavior byte-for-byte (selectedItems === undefined).
         *
         * This env var is NOT a public flag and MUST NOT appear in --help output.
         * Phase 2's --interactive flag replaces this for user-facing subset selection.
         */
        let selectedItems: Set<string> | undefined;
        const rawSelectIds = process.env['CCAUDIT_SELECT_IDS'];
        if (rawSelectIds !== undefined) {
          const ids = rawSelectIds
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
          selectedItems = new Set(ids);
          if (mode.verbose) {
            console.error(
              `[ccaudit] CCAUDIT_SELECT_IDS set — subset bust with ${selectedItems.size} item(s)`,
            );
          }
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
            const rawEnriched = await enrichScanResults(scanResults, {
              regime: regimeFlag,
              ccVersion: detectedCcVersion,
            });
            // v1.3.0 Phase 4 (D-27): apply framework protection BEFORE returning
            // to runBust. runBust sees only the filtered set; protected items
            // never reach archiveOne. Hash matches dry-run by construction
            // because both paths apply the same pure filter.
            const protection = applyFrameworkProtection(rawEnriched, {
              forcePartial: ctx.values.forcePartial === true,
              groupFrameworks: mode.groupFrameworks,
            });
            if (mode.verbose && protection.warnings.length > 0) {
              console.error(
                `[ccaudit] Framework protection: ${protection.protectedItems.length} item(s) protected across ${protection.warnings.length} framework(s)`,
              );
            }
            bustProtection = protection;
            return protection.filtered;
          },
          computeHash: (e) => computeGhostHash(e),
          processDetector: buildWrappedProcessDeps(),
          selfPid: process.pid,
          runCeremony: async ({ plan, yes: ceremonyYes }) => {
            // Print the change plan to stdout BEFORE the prompts (D-15) so the
            // user can read exactly what will be busted before they type `y`.
            // v1.3.0 Phase 4 (D-34): identical rendering to dry-run — yellow
            // warning block + PROTECTED section visible at ceremony time.
            if (!ceremonyYes && !mode.quiet) {
              console.log('');
              console.log(
                renderChangePlan(plan, {
                  protectionWarnings:
                    mode.groupFrameworks && bustProtection ? bustProtection.warnings : [],
                  protected:
                    mode.groupFrameworks && bustProtection
                      ? toProtectedItems(bustProtection.protectedItems)
                      : [],
                  forcePartial: ctx.values.forcePartial === true,
                  // No redaction at ceremony time — paths are shown literally
                  // because the user is about to confirm them.
                }),
              );
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
          atomicWriteText: (target, text) => atomicWriteText(target, text),
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

        const result = await runBust({ yes, deps, selectedItems });

        // ── Output rendering per BustResult variant ────────────────
        // bustProtection is reassigned inside the scanAndEnrich closure, so
        // TS let-narrowing reads it as `null` at this point. Cast back to the
        // declared union so the subsequent truthy check narrows correctly.
        const bustProtectionResolved = bustProtection as FrameworkBustResult | null;
        if (mode.json) {
          const envelope = buildJsonEnvelope('ghost', sinceStr, bustResultToExitCode(result), {
            bust: {
              ...bustResultToJson(result, ctx.values.privacy === true),
              // v1.3.0 Phase 4 (D-30, D-33): informational warnings — omitted
              // when grouping is disabled or no warnings were emitted. Protected
              // items are NOT included here because they were never touched by
              // runBust (no manifest entry to reference).
              ...(mode.groupFrameworks &&
              bustProtectionResolved &&
              bustProtectionResolved.warnings.length > 0
                ? { protectionWarnings: bustProtectionResolved.warnings }
                : {}),
            },
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
                      archivedAgents: result.counts.archive.agents,
                      archivedSkills: result.counts.archive.skills,
                      disabledMcp: result.counts.disable.completed,
                      flaggedMemory:
                        result.counts.flag.completed + (result.counts.flag.refreshed ?? 0),
                    },
                    manifestPath:
                      ctx.values.privacy === true
                        ? result.manifestPath.replace(homedir(), '~')
                        : result.manifestPath,
                    privacy: ctx.values.privacy === true,
                    // Phase 5: provenance label — tells user Before was measured at
                    // dry-run checkpoint time, not live during this bust.
                    beforeProvenance: {
                      source: 'dry-run',
                      at: result.summary.checkpointTimestamp,
                    },
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
              console.error(
                'Something was added, removed, or modified in your agents, skills, MCP',
              );
              console.error('servers, or memory files since the checkpoint was created. This is a');
              console.error(
                'safety check -- the bust plan may no longer match your current setup.',
              );
              console.error('');
              // v1.3.0 Phase 4 (D-37): --force-partial changes which items are
              // eligible, which changes the hash. If the user added/removed
              // --force-partial between dry-run and bust, surface the hint.
              if (ctx.values.forcePartial === true) {
                console.error(
                  'Hint: you are running with --force-partial, which expands the eligible set.',
                );
                console.error(
                  'If --force-partial differs from the prior --dry-run, re-run dry-run with',
                );
                console.error('the same flag value to generate a matching checkpoint:');
                console.error('  ccaudit ghost --dry-run --force-partial');
                console.error('');
              }
              console.error('Run ccaudit --dry-run again to generate a fresh plan.');
              break;
            case 'running-process':
              // Phase 3.2 SC5: single source of truth for the preflight copy.
              // Byte-for-byte equal to the previous inline console.error block
              // (locked by the SC5 inline-snapshot test in _preflight-copy.ts).
              process.stderr.write(
                renderRunningProcessMessage({
                  selfInvocation: result.selfInvocation,
                  pids: result.pids,
                }),
              );
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
        // Phase 6: populate bust history result shape before returning.
        if (result.status === 'success') {
          _historyResult = {
            status: 'success' as const,
            before_tokens: result.summary.beforeTokens,
            after_tokens: result.summary.afterTokens,
            freed_tokens: result.summary.freedTokens,
            archived_agents: result.counts.archive.agents,
            archived_skills: result.counts.archive.skills,
            disabled_mcp: result.counts.disable.completed,
            flagged_memory: result.counts.flag.completed + (result.counts.flag.refreshed ?? 0),
            manifest_ref: result.manifestPath ?? null,
            health_before: result.summary.gradeBefore ?? null,
            health_after: result.summary.gradeAfter ?? null,
          };
        } else {
          _historyResult = { status: result.status };
        }
        return;
      }

      // Step 4: Calculate health score
      // Pass includeHooks so tokenPenalty matches the headline total.
      // ghostPenalty and dormantPenalty are unaffected (hooks still count as a health stat).
      const healthScore = calculateHealthScore(enriched, { includeHooks });

      // Step 5: Filter to ghosts only
      const ghosts = enriched.filter((r) => r.tier !== 'used');

      // Step 5.1: Framework grouping (v1.3.0 D-22). Computed once, reused by
      // terminal render path, JSON envelope, and CSV/TSV appenders.
      const grouped: GroupedInventory = mode.groupFrameworks
        ? groupByFramework(toGhostItems(enriched))
        : { frameworks: [], ungrouped: [] };

      // Step 5.1a: Build path → frameworkId lookup from the actual group membership.
      // annotateFrameworks only sets item.framework for Tier-1 curated matches;
      // Tier-2 heuristic groups assemble members whose item.framework is still
      // null. Downstream renderers that read r.item.framework directly would
      // treat heuristic members as ungrouped (duplicating them in the Top Ghosts
      // table that already lives inside the Frameworks section). Resolve
      // membership off grouped.frameworks[].members instead — mirrors the
      // pattern in packages/internal/src/remediation/framework-bust.ts.
      const frameworkByPath = new Map<string, string>();
      for (const fw of grouped.frameworks) {
        for (const m of fw.members) frameworkByPath.set(m.path, fw.id);
      }
      const resolveFramework = (r: TokenCostResult): string | null =>
        frameworkByPath.get(r.item.path) ?? r.item.framework ?? null;

      // Step 5.2: Sort frameworks by displayName ASC (case-insensitive) per OUT-04.
      const sortedFrameworks: FrameworkGroup[] = grouped.frameworks
        .slice()
        .sort((a, b) =>
          a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
        );

      // Step 5.3: Compute per-category ghost counts attributable to frameworks
      // for the D-19 parenthetical annotation. Only count tier !== 'used' members.
      const frameworkGhostsByCategory: Partial<Record<ItemCategory, number>> = {};
      if (mode.groupFrameworks) {
        for (const fg of grouped.frameworks) {
          for (const member of fg.members) {
            if (member.tier !== 'used') {
              const cat = member.category;
              frameworkGhostsByCategory[cat] = (frameworkGhostsByCategory[cat] ?? 0) + 1;
            }
          }
        }
      }

      // Step 5.4: Pre-compute hook advisory data (always computed, used in rendering + JSON).
      // hookItems: ALL hook-category ghosts (regardless of includeHooks flag).
      // hooksUpperBound: sum of hook tokens — always present in JSON regardless of mode.
      const hookItems = ghosts.filter((r) => r.item.category === 'hook');
      const hooksUpperBound = sumHookTokens(ghosts);

      // Step 5.5: Group ghosts by project scope and compute worst-case session overhead.
      // A session loads global inventory + ONE project — never all projects simultaneously.
      // When !includeHooks, exclude hook items so the project summaries match the headline total.
      const ghostsForGrouping = includeHooks
        ? ghosts
        : ghosts.filter((r) => r.item.category !== 'hook');
      const { global: globalSummary, projects: projectSummaries } = groupGhostsByProject(
        ghostsForGrouping,
        homedir(),
      );

      // Resolve the final regime for ToolSearch overhead accounting.
      // For 'auto', use the same two-pass logic enrichScanResults uses internally:
      // compute eager-total of MCP items, then resolve against version + threshold.
      let resolvedRegimeForOverhead: McpRegime;
      if (regimeFlag === 'auto') {
        const eagerMcpTotal = enriched
          .filter((r) => r.item.category === 'mcp-server')
          .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0);
        resolvedRegimeForOverhead = resolveMcpRegime({
          totalMcpToolTokens: eagerMcpTotal,
          contextWindow: CONTEXT_WINDOW_SIZE,
          ccVersion: detectedCcVersion,
          override: null,
        }).regime;
      } else {
        resolvedRegimeForOverhead = regimeFlag;
      }

      const {
        total: worstCaseTotal,
        globalCost,
        worstProject,
        toolSearchOverhead,
      } = calculateWorstCaseOverhead(globalSummary, projectSummaries, resolvedRegimeForOverhead);

      // Apply path redaction for --privacy
      let displayProjectSummaries = projectSummaries;
      let displayWorstProject = worstProject;
      if (mode.privacy) {
        displayProjectSummaries = redactPaths(projectSummaries);
        displayWorstProject = displayProjectSummaries[0] ?? null;
      }

      // Step 6: Build category summaries
      // Category order: agent, skill, mcp-server, memory, command, hook
      const categories = ['agent', 'skill', 'mcp-server', 'memory', 'command', 'hook'] as const;
      const allSummaries: CategorySummary[] = categories.map((cat) => {
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
      // When !includeHooks, filter hooks out of the main table summaries (they go to advisory).
      const summaries = includeHooks
        ? allSummaries
        : allSummaries.filter((s) => s.category !== 'hook');

      // Determine exit code: 1 if ghosts found (per D-01)
      const hasGhosts = enriched.some((r) => r.tier !== 'used');
      const exitCode = hasGhosts ? 1 : 0;

      // Output routing (in order of precedence per D-17)
      if (mode.json) {
        // JSON with meta envelope
        // Use ghost-specific total: excludes hooks by default, includes when --include-hooks
        const totalTokens = calculateGhostTotalOverhead(ghosts, includeHooks);
        // Build redaction map from already-redacted summaries
        const redactionMap = mode.privacy
          ? new Map(
              displayProjectSummaries
                .filter((s) => s.projectPath !== null)
                .map((s) => [s.projectPath!, s.displayPath]),
            )
          : null;
        // D-23: additive top-level frameworks field + per-item framework field.
        // Omitted when mode.groupFrameworks === false to preserve v1.2.1 byte-identity.
        // The members[] array is intentionally EXCLUDED from the projection —
        // consumers correlate via the per-item framework field in items[].
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
          'ghost',
          sinceStr,
          exitCode,
          {
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
              dormantPenalty: healthScore.dormantPenalty,
            },
            totalOverhead: {
              tokens: totalTokens,
              // hooksUpperBound: always present, always reflects hook token sum
              // regardless of aggregation mode. JSON consumers can pick either total.
              hooksUpperBound,
            },
            ...(frameworksProjection !== undefined ? { frameworks: frameworksProjection } : {}),
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
              ...(mode.groupFrameworks ? { framework: resolveFramework(r) } : {}),
              ...calculateUrgencyScore(r.lastUsed, r.tokenEstimate),
              // Phase 4: hook-specific additive fields (only emitted for hook items)
              ...(r.item.category === 'hook'
                ? {
                    hookEvent: r.item.hookEvent,
                    injectCapable: r.item.injectCapable,
                  }
                : {}),
              // Phase 5: import-chain additive fields (only emitted for import rows)
              ...(r.item.importDepth !== undefined
                ? {
                    importDepth: r.item.importDepth,
                    importRoot: redactionMap ? '[redacted]' : r.item.importRoot,
                  }
                : {}),
            })),
          },
          {
            mcpRegime: resolvedRegimeForOverhead,
            toolSearchOverhead,
            hooksAggregated: includeHooks,
          },
        );
        const indent = mode.quiet ? 0 : 2;
        console.log(JSON.stringify(envelope, null, indent));
      } else if (mode.csv) {
        // CSV output (RFC 4180 per D-18, D-19)
        // When !includeHooks, filter hook rows — mirrors the table/TSV/JSON total behaviour.
        const csvItems = includeHooks
          ? enriched
          : enriched.filter((r) => r.item.category !== 'hook');
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
        const rows = csvItems.map((r) => [
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
        // When !includeHooks, filter hook rows — mirrors the CSV/table/JSON total behaviour.
        const tsvItems = includeHooks
          ? enriched
          : enriched.filter((r) => r.item.category !== 'hook');
        const appendFramework = mode.verbose && mode.groupFrameworks;
        for (const r of tsvItems) {
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
            undefined, // termWidth — existing default
            mode.groupFrameworks ? frameworkGhostsByCategory : undefined,
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
          // Step 6.1: Top ghosts — filter out framework members when grouping is on
          // (they are already represented in the Frameworks section rendered below
          // per the v1.3.x UI reorder todo 2026-04-11). Uses resolveFramework so
          // heuristic Tier-2 members (item.framework still null but grouped via
          // groupByFramework) are also excluded from Top Ghosts — otherwise they
          // double-appear inside the Frameworks section AND Top Ghosts.
          const topGhostsInput = mode.groupFrameworks
            ? ghosts.filter((r) => resolveFramework(r) == null)
            : ghosts;
          const topGhostsStr = renderTopGhosts(topGhostsInput, 5);
          if (topGhostsStr) {
            console.log(topGhostsStr);
            console.log('');
          }

          // Step 6.2: Global baseline always shown when ghosts exist
          console.log(renderGlobalBaseline(globalSummary));
          console.log('');

          // Step 6.3: Frameworks section — rendered after the Global Baseline
          // block and before the per-project overhead table (v1.3.x UI polish,
          // supersedes D-18 which originally placed it above Top Ghosts).
          // Omitted when grouping is disabled or no frameworks detected.
          if (mode.groupFrameworks && sortedFrameworks.length > 0) {
            const frameworksOut = renderFrameworksSection(sortedFrameworks, {
              verbose: mode.verbose,
            });
            if (frameworksOut !== '') {
              console.log(frameworksOut);
              console.log('');
            }
          }

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

        // Advisory section: shown LAST when !includeHooks and hooks exist.
        // When includeHooks=true: hooks render in the main table; no advisory shown.
        // When zero hooks configured: renderHooksAdvisory returns '' and nothing is printed.
        if (!includeHooks) {
          const hookSummary = allSummaries.find((s) => s.category === 'hook');
          const hookDefined = hookSummary?.defined ?? 0;
          const hookDormant = hookItems.filter((r) => r.tier === 'dormant').length;
          const advisory = renderHooksAdvisory(
            hookDefined,
            hookDormant,
            hooksUpperBound,
            hookItems,
            mode.verbose,
          );
          if (advisory) {
            console.log('');
            console.log(advisory);
          }
        } else if (hooksUpperBound > 0) {
          // --include-hooks mode: hooks in main table, add footer annotation.
          console.log('');
          console.log(colorize.dim('Total includes hook upper-bound (worst case).'));
        }

        // Phase 3.2 SC7: hook archival is deferred — surface the status once so
        // users who came looking for hook support are not silently abandoned.
        // Explicit D-23 suppression gate (all four modes — structurally we are
        // already inside the text-mode arm of the json/csv/else branch, but we
        // also check !mode.json && !mode.csv defensively to make the gate
        // self-documenting and robust to future restructuring). --quiet is
        // NOT absorbed into the outer text-mode branch — it gates per-line.
        // --ci lives on ctx.values.ci, not on mode.
        if (
          hookItems.length > 0 &&
          !mode.json &&
          !mode.csv &&
          !mode.quiet &&
          ctx.values.ci !== true
        ) {
          console.log('');
          console.log(
            colorize.dim('Hook archival deferred — selectable archive coming in a future phase'),
          );
        }
      }

      // ── D-22 through D-25: auto-open interactive picker prompt ──────────────
      // Triggered only when:
      //   - no --interactive (that branch ran earlier and returned)
      //   - no --dry-run, no --dangerously-bust-ghosts (enforced by D-23 mode suppressors)
      //   - report mode is human (not --json/--csv/--quiet/--ci)
      //   - stdin + stdout are TTY
      //   - ≥1 ghost was found (hasGhosts)
      //   - terminal ≥ 60 cols
      //
      // Uses checkTuiGuards with isExplicitInteractive=false to apply D-23's full
      // 6-flag suppression matrix (json/csv/quiet/ci/dryRun/dangerouslyBustGhosts).
      if (hasGhosts && !isNoInteractiveEnv()) {
        const guardAutoOpen = checkTuiGuards({
          mode: {
            json: mode.json,
            csv: mode.csv,
            quiet: mode.quiet,
            ci: ctx.values.ci === true,
            dryRun: Boolean(ctx.values.dryRun),
            dangerouslyBustGhosts: Boolean(ctx.values.dangerouslyBustGhosts),
          },
          isTty: Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY),
          ttyCols: process.stdout.columns,
          isExplicitInteractive: false,
        });
        if (guardAutoOpen.kind === 'ok') {
          const autoOpenOutcome = await promptAutoOpen();
          if (autoOpenOutcome === 'open') {
            // 2nd call site of runInteractiveGhostFlow (Plan 03 defined it; Plan 04 reuses it).
            // Reuse the same enriched array — do NOT re-scan.
            const autoOpenGhosts = enriched.filter((r) => r.tier !== 'used');
            await runInteractiveGhostFlow({
              enriched,
              ghosts: autoOpenGhosts,
              sinceStr,
              regimeFlag,
              detectedCcVersion,
              mode: {
                json: mode.json,
                csv: mode.csv,
                quiet: mode.quiet,
                ci: ctx.values.ci === true,
                groupFrameworks: mode.groupFrameworks,
                verbose: mode.verbose,
                privacy: mode.privacy,
              },
              forcePartial: ctx.values.forcePartial === true,
              resolvedRegime: resolvedRegimeForOverhead,
              totalOverhead: worstCaseTotal,
            });
            return;
          }
          // autoOpenOutcome === 'decline' → fall through and exit 0 normally (report already printed)
        }
        // guardAutoOpen.kind === 'suppress-auto-open' → do nothing, exit normally (D-23)
      }

      // Set exit code: ghost/inventory/mcp exit 1 when ghosts found (per D-01, D-02, D-03)
      if (hasGhosts) {
        process.exitCode = 1;
      }
      // History result for ghost/inventory display branch
      _historyResult = {
        totals: Object.fromEntries(
          (['agent', 'skill', 'mcp-server', 'memory', 'command', 'hook'] as const).map((cat) => [
            cat,
            enriched.filter((r) => r.item.category === cat).length,
          ]),
        ),
        top_ghosts: ghosts.slice(0, 5).map((r) => r.item.name),
      };
    } finally {
      // Phase 6: record history entry for this invocation (ghost/dry-run/bust).
      const _command = _isBust ? 'bust' : _isDryRun ? 'dry-run' : 'ghost';
      await _recordGhostHistory(_command);
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
        summary: result.summary,
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
