// @ccaudit/internal -- bust orchestrator (Phase 8 Wave 1)
//
// runBust() is the brain of --dangerously-bust-ghosts. It wires Wave 0
// primitives (atomic-write, collisions, processes, frontmatter, manifest) into
// the full pipeline described in Phase 8 CONTEXT.md:
//
//   1. Verify dry-run checkpoint (D-01: two-gate, hash-only)
//   2. Preflight: running-process detection (D-02, D-03, D-04 self-invocation)
//   3. Fresh scan + plan + hash match (Gate 2 of D-01)
//   4. Confirmation ceremony (D-15: [1/2] y/N + [2/2] typed phrase)
//   5. Execute ops in D-13 order:
//        agents (archive) -> skills (archive) -> MCP (disable) -> memory (flag)
//   6. Hybrid failure policy (D-14):
//        - fs ops: continue-on-error
//        - ~/.claude.json AND .mcp.json: fail-fast transactional per config file
//   7. Write JSONL manifest with header/footer (D-09, D-12)
//
// Every dependency with real I/O is injectable via BustDeps so the entire
// pipeline can be unit-tested WITHOUT touching real fs, child_process, or
// stdin. Production callers build the deps with default implementations.
//
// Critical: disableMcpTransactional handles TWO DISTINCT SCHEMAS per
// packages/internal/src/scanner/scan-mcp.ts lines 84-106:
//   - `.mcp.json`      : FLAT top-level `{ mcpServers: {...} }` at doc root
//                        (NO `projects` wrapper) -- detect via basename
//   - `~/.claude.json` : NESTED `{ projects: { <path>: { mcpServers } } }`
//                        for project scope; top-level `mcpServers` for global

import { rename } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { TokenCostResult } from '../token/types.ts';
import { type ReadCheckpointResult } from './checkpoint.ts';
import {
  buildChangePlan,
  filterChangePlan,
  type ChangePlan,
  type ChangePlanItem,
} from './change-plan.ts';
import { calculateDryRunSavings } from './savings.ts';
import { buildArchivePath, buildDisabledMcpKey } from './collisions.ts';
import {
  detectClaudeProcesses,
  walkParentChain,
  type DetectResult,
  type ProcessDetectorDeps,
} from './processes.ts';
import { patchFrontmatter, type FrontmatterPatchResult } from './frontmatter.ts';
import { calculateHealthScore } from '../report/health-score.ts';
import {
  ManifestWriter,
  buildHeader,
  buildFooter,
  buildArchiveOp,
  buildDisableOp,
  buildFlagOp,
  buildRefreshOp,
  buildSkippedOp,
  type ManifestOp,
  type SelectionFilter,
} from './manifest.ts';

// -- Result types -------------------------------------------------

/**
 * Discriminated result of {@link runBust}. Every possible outcome of the
 * pipeline has a dedicated variant so callers (the CLI command handler) can
 * pattern-match on status to produce the correct exit code + stderr message.
 *
 * Exit code mapping (the CLI layer is responsible for translating):
 *   success            -> 0
 *   partial-success    -> 1 (D-14: any op failed)
 *   checkpoint-missing -> 1
 *   checkpoint-invalid -> 1
 *   hash-mismatch      -> 1
 *   running-process    -> 3 (D-03)
 *   process-detection-failed -> 3 (fail-closed per D-02)
 *   user-aborted       -> 0 (graceful abort, not a failure)
 *   config-parse-error -> 1 (D-14 fail-fast on ~/.claude.json / .mcp.json)
 *   config-write-error -> 1
 */
export type BustResult =
  | {
      status: 'success';
      manifestPath: string;
      counts: BustCounts;
      duration_ms: number;
      summary: {
        beforeTokens: number;
        freedTokens: number;
        /** Full-plan token figure preserved for consumers when a subset bust filtered the plan.
         *  Equals `freedTokens` on full-inventory bust. */
        totalPlannedTokens: number;
        afterTokens: number;
        pctWindow: number;
        healthBefore: number;
        healthAfter: number;
        gradeBefore: string;
        gradeAfter: string;
        /** ISO-8601 timestamp of the dry-run checkpoint (for provenance labelling). */
        checkpointTimestamp: string;
        /** MCP regime pinned from the checkpoint (for consistent enrichment). */
        checkpointMcpRegime: 'eager' | 'deferred' | 'unknown';
      };
    }
  | {
      status: 'partial-success';
      manifestPath: string;
      counts: BustCounts;
      failed: number;
      duration_ms: number;
    }
  | { status: 'checkpoint-missing'; checkpointPath: string }
  | { status: 'checkpoint-invalid'; reason: string }
  | { status: 'hash-mismatch'; expected: string; actual: string }
  | { status: 'running-process'; pids: number[]; selfInvocation: boolean; message: string }
  | { status: 'process-detection-failed'; error: string }
  | { status: 'user-aborted'; stage: 'prompt1' | 'prompt2' | 'prompt3' }
  | { status: 'config-parse-error'; path: string; error: string }
  | { status: 'config-write-error'; path: string; error: string };

/** Per-category op counters threaded through the pipeline for the manifest footer. */
export interface BustCounts {
  archive: { agents: number; skills: number; failed: number };
  disable: { completed: number; failed: number };
  flag: { completed: number; failed: number; refreshed: number; skipped: number };
}

/**
 * Result of {@link runConfirmationCeremony}. Maps 1:1 to the D-15 prompt
 * stages so the bust orchestrator can distinguish prompt1 vs prompt2 aborts
 * for telemetry / error messaging.
 */
export type CeremonyResult =
  | { status: 'accepted' }
  | { status: 'aborted'; stage: 'prompt1' | 'prompt2' | 'prompt3'; reason: string };

/**
 * Dependency injection surface for runBust. Every real I/O path is behind a
 * function on this object so unit tests can assert the full pipeline without
 * touching real fs, child_process, or stdin.
 *
 * Production callers build this with default implementations:
 *   - readCheckpoint        -> readCheckpoint from './checkpoint.ts'
 *   - checkpointPath        -> () => resolveCheckpointPath()
 *   - scanAndEnrich         -> () => enrichScanResults(await scanAll(...))
 *   - computeHash           -> (e) => computeGhostHash(e)
 *   - processDetector       -> defaultProcessDeps
 *   - selfPid               -> process.pid
 *   - runCeremony           -> (opts) => runConfirmationCeremony(opts)
 *   - renameFile            -> rename (from node:fs/promises)
 *   - mkdirRecursive        -> (d, m) => mkdir(d, { recursive: true, mode: m })
 *   - readFileUtf8          -> (p) => readFile(p, 'utf8')
 *   - patchMemoryFrontmatter-> patchFrontmatter
 *   - atomicWriteJson       -> atomicWriteJson (from './atomic-write.ts')
 *   - pathExistsSync        -> fs.existsSync
 *   - createManifestWriter  -> (p) => new ManifestWriter(p)
 *   - manifestPath          -> () => resolveManifestPath()
 */
export interface BustDeps {
  // Checkpoint + inventory
  readCheckpoint: (p: string) => Promise<ReadCheckpointResult>;
  checkpointPath: () => string;
  scanAndEnrich: () => Promise<TokenCostResult[]>;
  computeHash: (enriched: TokenCostResult[]) => Promise<string>;

  // Preflight
  processDetector: ProcessDetectorDeps;
  selfPid: number;

  // Confirmation
  runCeremony: (opts: { plan: ChangePlan; yes: boolean }) => Promise<CeremonyResult>;

  // Filesystem ops
  renameFile: (from: string, to: string) => Promise<void>;
  mkdirRecursive: (dir: string, mode?: number) => Promise<void>;
  readFileUtf8: (p: string) => Promise<string>;
  patchMemoryFrontmatter: (filePath: string, nowIso: string) => Promise<FrontmatterPatchResult>;
  atomicWriteJson: <T>(targetPath: string, value: T) => Promise<void>;
  pathExistsSync: (p: string) => boolean;

  // Manifest
  createManifestWriter: (filePath: string) => ManifestWriter;
  manifestPath: () => string;

  // Runtime context (stamped into the manifest header)
  now: () => Date;
  ccauditVersion: string;
  nodeVersion: string;
  sinceWindow: string;
  os: NodeJS.Platform;
}

// -- runBust orchestrator -----------------------------------------

/**
 * Execute the full --dangerously-bust-ghosts pipeline.
 *
 * See module JSDoc for the high-level flow. Each gate returns a tagged
 * BustResult without mutating anything when it fails, so the CLI layer can
 * cleanly print the error message and exit with the appropriate code.
 *
 * @param opts.yes   If true, both D-15 prompts are skipped (the
 *                   --yes-proceed-busting bypass flag from D-16).
 * @param opts.deps  Full dependency-injection surface. Tests pass a minimal
 *                   BustDeps with fakes for every I/O path; production passes
 *                   real implementations via a buildProductionDeps() helper
 *                   (defined at the CLI command layer, not here).
 */
export async function runBust(opts: {
  yes: boolean;
  deps: BustDeps;
  /**
   * Optional subset filter. `undefined` = full-inventory bust (v1.4.0 contract).
   * `Set<string>` of canonicalItemId values = subset bust: items whose id is not
   * in the set are excluded from the change plan AFTER hash verification.
   * `new Set()` (empty) = explicit "select nothing" no-op; manifest is written
   * with zero planned_ops and a warning is emitted. This is distinct from
   * `undefined` so Phase 2's TUI can deliver an empty selection cleanly.
   */
  selectedItems?: Set<string>;
}): Promise<BustResult> {
  const { yes, deps, selectedItems } = opts;
  const start = Date.now();

  // ── Gate 1: checkpoint exists (D-01) ─────────────────────────────
  const checkpointPath = deps.checkpointPath();
  const checkpointResult = await deps.readCheckpoint(checkpointPath);
  if (checkpointResult.status === 'missing') {
    return { status: 'checkpoint-missing', checkpointPath };
  }
  if (checkpointResult.status === 'parse-error') {
    return { status: 'checkpoint-invalid', reason: `parse-error: ${checkpointResult.message}` };
  }
  if (checkpointResult.status === 'unknown-version') {
    return {
      status: 'checkpoint-invalid',
      reason: `unknown checkpoint version ${checkpointResult.version}`,
    };
  }
  if (checkpointResult.status === 'schema-mismatch') {
    return {
      status: 'checkpoint-invalid',
      reason: `schema missing ${checkpointResult.missingField}`,
    };
  }
  const checkpoint = checkpointResult.checkpoint;

  // ── Preflight: running Claude Code detection (D-02, D-03, D-04) ──
  const detected: DetectResult = await detectClaudeProcesses(deps.selfPid, deps.processDetector);
  if (detected.status === 'spawn-failed') {
    // D-02 fail-closed: cannot verify Claude is stopped -> refuse.
    return { status: 'process-detection-failed', error: detected.error };
  }
  if (detected.processes.length > 0) {
    // D-04: walk our own parent chain; if any detected pid is an ancestor
    // of ccaudit (ccaudit was spawned from inside a Claude Code session,
    // typically via the Bash tool), emit the tailored self-invocation error.
    const chain = await walkParentChain(deps.selfPid, deps.processDetector);
    const detectedPids = new Set(detected.processes.map((p) => p.pid));
    const selfInvocationPid = chain.find((p) => detectedPids.has(p));
    const selfInvocation = selfInvocationPid !== undefined;
    const message = selfInvocation
      ? `You appear to be running ccaudit from inside a Claude Code session (parent pid: ${selfInvocationPid}). Open a standalone terminal and run this command there.`
      : `Claude Code is running (pids: ${detected.processes.map((p) => p.pid).join(', ')}). Close all Claude Code windows and re-run ccaudit --dangerously-bust-ghosts.`;
    return {
      status: 'running-process',
      pids: detected.processes.map((p) => p.pid),
      selfInvocation,
      message,
    };
  }

  // ── Gate 2: fresh scan + hash match (D-01) ───────────────────────
  const enriched = await deps.scanAndEnrich();
  const currentHash = await deps.computeHash(enriched);
  if (currentHash !== checkpoint.ghost_hash) {
    return { status: 'hash-mismatch', expected: checkpoint.ghost_hash, actual: currentHash };
  }

  const plan = buildChangePlan(enriched);

  // Preserve the full-plan figure for totalPlannedTokens (INV-S5).
  const fullPlanTokens = checkpoint.savings.tokens;

  // Approach A (D-03): filter AFTER hash verification, BEFORE manifest is serialized.
  // selectedItems === undefined → full bust (v1.4.0 behavior unchanged).
  // selectedItems is a Set → subset bust; items not in set are excluded.
  let filteredPlan = plan;
  if (selectedItems !== undefined) {
    filteredPlan = filterChangePlan(plan, selectedItems);
    if (selectedItems.size === 0) {
      console.warn(
        '[ccaudit] selectedItems is an empty set — no items will be archived. ' +
          'If you meant a full-inventory bust, omit selectedItems.',
      );
    }
  }

  const healthScoreBefore = calculateHealthScore(enriched);
  const healthBefore = healthScoreBefore.score;
  const gradeBefore = healthScoreBefore.grade;
  const beforeTokens = checkpoint.total_overhead ?? 0;

  // ── Confirmation ceremony (D-15, D-16) ───────────────────────────
  const ceremony = await deps.runCeremony({ plan: filteredPlan, yes });
  if (ceremony.status === 'aborted') {
    return { status: 'user-aborted', stage: ceremony.stage };
  }

  // ── Execute ops (D-13 order) with manifest (D-09..D-12) ──────────
  const manifestPath = deps.manifestPath();
  const writer = deps.createManifestWriter(manifestPath);

  const plannedOps = {
    archive: filteredPlan.archive.length,
    disable: filteredPlan.disable.length,
    flag: filteredPlan.flag.length,
  };

  const selectionFilter: SelectionFilter =
    selectedItems === undefined
      ? { mode: 'full' }
      : { mode: 'subset', ids: Array.from(selectedItems) }; // buildHeader sorts ids

  const header = buildHeader({
    ccaudit_version: deps.ccauditVersion,
    checkpoint_ghost_hash: checkpoint.ghost_hash,
    checkpoint_timestamp: checkpoint.timestamp,
    since_window: deps.sinceWindow,
    os: deps.os,
    node_version: deps.nodeVersion,
    planned_ops: plannedOps,
    selection_filter: selectionFilter,
  });

  try {
    await writer.open(header);
  } catch (err) {
    return { status: 'config-write-error', path: manifestPath, error: (err as Error).message };
  }

  const counts: BustCounts = {
    archive: { agents: 0, skills: 0, failed: 0 },
    disable: { completed: 0, failed: 0 },
    flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
  };

  // ── Step 1: Archive agents, then skills (D-13 order) ─────────────
  // Filesystem-only ops first per D-13 rationale: if a later step fails, the
  // archived files still have manifest entries Phase 9 can reverse. D-14 says
  // these are continue-on-error.
  const agentItems = filteredPlan.archive.filter((i) => i.category === 'agent');
  const skillItems = filteredPlan.archive.filter((i) => i.category === 'skill');

  for (const item of agentItems) {
    const op = await archiveOne(item, 'agent', deps, counts);
    await writer.writeOp(op);
  }
  for (const item of skillItems) {
    const op = await archiveOne(item, 'skill', deps, counts);
    await writer.writeOp(op);
  }

  // ── Step 2: Disable MCP (D-13, fail-fast per D-14) ───────────────
  // Transactional per config file: each `~/.claude.json` or `.mcp.json` is
  // read, mutated in memory, and atomically written back. A parse or write
  // error aborts the whole Disable MCP step WITHOUT committing any ops to
  // the manifest (the atomicWriteJson rename is the transaction boundary).
  if (filteredPlan.disable.length > 0) {
    const disableResult = await disableMcpTransactional(filteredPlan.disable, deps, counts);
    if (disableResult.status === 'parse-error') {
      await writer.close(null); // footer omitted -> Phase 9 partial-bust marker
      return {
        status: 'config-parse-error',
        path: disableResult.path,
        error: disableResult.error,
      };
    }
    if (disableResult.status === 'write-error') {
      await writer.close(null);
      return {
        status: 'config-write-error',
        path: disableResult.path,
        error: disableResult.error,
      };
    }
    // All disable ops succeeded -- write them to manifest in one pass.
    for (const op of disableResult.ops) {
      await writer.writeOp(op);
    }
  }

  // ── Step 3: Flag memory (D-13, continue-on-error per D-14) ───────
  for (const item of filteredPlan.flag) {
    const nowIso = deps.now().toISOString();
    try {
      // Read content BEFORE patching so the manifest's sha256 reflects the
      // pre-patch bytes for Phase 9 tamper detection.
      const originalBytes = await deps.readFileUtf8(item.path).catch(() => '');
      const result = await deps.patchMemoryFrontmatter(item.path, nowIso);
      if (result.status === 'patched') {
        counts.flag.completed += 1;
        await writer.writeOp(
          buildFlagOp({
            file_path: item.path,
            scope: item.scope,
            had_frontmatter: result.hadFrontmatter,
            had_ccaudit_stale: result.hadCcauditStale,
            patched_keys: ['ccaudit-stale', 'ccaudit-flagged'] as const,
            original_content: originalBytes,
          }),
        );
      } else if (result.status === 'refreshed') {
        counts.flag.refreshed += 1;
        await writer.writeOp(
          buildRefreshOp({
            file_path: item.path,
            scope: item.scope,
            previous_flagged_at: result.previousFlaggedAt,
          }),
        );
      } else {
        // status === 'skipped'
        counts.flag.skipped += 1;
        await writer.writeOp(
          buildSkippedOp({
            file_path: item.path,
            category: 'memory',
            reason: result.reason,
          }),
        );
      }
    } catch (err) {
      counts.flag.failed += 1;
      await writer.writeOp(
        buildFlagOp({
          file_path: item.path,
          scope: item.scope,
          had_frontmatter: false,
          had_ccaudit_stale: false,
          patched_keys: [] as const,
          original_content: '',
          status: 'failed',
          error: (err as Error).message,
        }),
      );
    }
  }

  // ── Footer + close ───────────────────────────────────────────────
  const duration_ms = Date.now() - start;
  const totalFailed = counts.archive.failed + counts.disable.failed + counts.flag.failed;
  const exitCode = totalFailed > 0 ? 1 : 0;
  const footer = buildFooter({
    status: 'completed',
    actual_ops: {
      archive: {
        completed: counts.archive.agents + counts.archive.skills,
        failed: counts.archive.failed,
      },
      disable: counts.disable,
      flag: counts.flag,
    },
    duration_ms,
    exit_code: exitCode,
  });
  await writer.close(footer);

  if (totalFailed > 0) {
    return { status: 'partial-success', manifestPath, counts, failed: totalFailed, duration_ms };
  }

  // INV-S5: freedTokens is subset-accurate; totalPlannedTokens preserves full figure.
  // For full bust (selectedItems === undefined): freedTokens === fullPlanTokens (v1.4.0 behavior).
  // For subset bust: freedTokens = sum of archive+disable tokens of selected items only.
  const freedTokens =
    selectedItems === undefined
      ? fullPlanTokens // v1.4.0 behavior: checkpoint figure
      : calculateDryRunSavings(filteredPlan); // subset figure
  const totalPlannedTokens = fullPlanTokens;
  const afterTokens = Math.max(0, beforeTokens - freedTokens);
  const pctWindow = Math.round((freedTokens / 200_000) * 100);

  // health after: remove definite-ghost agents/skills and all non-used MCPs
  const remainingEnriched = enriched.filter((r) => {
    if ((r.item.category === 'agent' || r.item.category === 'skill') && r.tier === 'definite-ghost')
      return false;
    if (r.item.category === 'mcp-server' && r.tier !== 'used') return false;
    return true;
  });
  const healthScoreAfter = calculateHealthScore(remainingEnriched);
  const healthAfter = healthScoreAfter.score;
  const gradeAfter = healthScoreAfter.grade;

  return {
    status: 'success',
    manifestPath,
    counts,
    duration_ms,
    summary: {
      beforeTokens,
      freedTokens,
      totalPlannedTokens,
      afterTokens,
      pctWindow,
      healthBefore,
      healthAfter,
      gradeBefore,
      gradeAfter,
      checkpointTimestamp: checkpoint.timestamp,
      checkpointMcpRegime: checkpoint.mcp_regime ?? 'unknown',
    },
  };
}

// -- Archive one agent/skill --------------------------------------

/**
 * Archive a single agent or skill file via the Plan 02 buildArchivePath
 * collision-resistant path builder. Preserves nested subdirectory structure
 * (e.g. agents/design/foo.md -> ccaudit/archived/agents/design/foo.md).
 * Archives land under the .claude/ccaudit/ namespace (outside Claude Code's
 * scanning paths) so archived items are truly invisible to Claude Code.
 *
 * Failure mode: any error (file read, mkdir, rename) returns a `failed`
 * manifest op and increments counts.archive.failed WITHOUT throwing, so the
 * outer loop can continue with remaining items per D-14 continue-on-error.
 */
async function archiveOne(
  item: ChangePlanItem,
  category: 'agent' | 'skill',
  deps: BustDeps,
  counts: BustCounts,
): Promise<ManifestOp> {
  try {
    // Locate the category root by walking UP from the source path past the
    // `agents` or `skills` segment, then derive the centralized archive dir
    // under the .claude/ccaudit/ namespace (outside Claude Code's scanning).
    // Example:
    //   sourcePath  = /home/u/.claude/agents/design/foo.md
    //   categoryRoot = /home/u/.claude/agents
    //   claudeRoot   = /home/u/.claude
    //   archivedDir  = /home/u/.claude/ccaudit/archived/agents
    const categoryRoot = findCategoryRoot(item.path, category);
    if (!categoryRoot) {
      counts.archive.failed += 1;
      return buildArchiveOp({
        category,
        scope: item.scope,
        source_path: item.path,
        archive_path: '',
        content: '',
        status: 'failed',
        error: `could not resolve ${category} root for ${item.path}`,
      });
    }
    const claudeRoot = path.dirname(categoryRoot);
    const categorySegment = category === 'agent' ? 'agents' : 'skills';
    const archivedDir = path.join(claudeRoot, 'ccaudit', 'archived', categorySegment);

    // Read the original bytes BEFORE the rename so the manifest's content
    // sha256 reflects the pre-archive content (Phase 9 tamper detection).
    // Skills are directories (not files), so readFileUtf8 would throw EISDIR.
    // For directories, hash the primary SKILL.md entry file if it exists.
    let content: string;
    try {
      content = await deps.readFileUtf8(item.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
        content = await deps.readFileUtf8(path.join(item.path, 'SKILL.md')).catch(() => '');
      } else {
        throw err;
      }
    }

    // Build a collision-resistant, nested-structure-preserving archive path.
    const archivePath = buildArchivePath({
      sourcePath: item.path,
      categoryRoot,
      archivedDir,
      collisionExists: deps.pathExistsSync,
      now: deps.now(),
    });

    // Ensure intermediate dirs exist (nested structure preservation).
    await deps.mkdirRecursive(path.dirname(archivePath), 0o700);

    // Rename is the archive operation itself.
    await deps.renameFile(item.path, archivePath);

    if (category === 'skill') {
      counts.archive.skills += 1;
    } else {
      counts.archive.agents += 1;
    }
    return buildArchiveOp({
      category,
      scope: item.scope,
      source_path: item.path,
      archive_path: archivePath,
      content,
    });
  } catch (err) {
    counts.archive.failed += 1;
    return buildArchiveOp({
      category,
      scope: item.scope,
      source_path: item.path,
      archive_path: '',
      content: '',
      status: 'failed',
      error: (err as Error).message,
    });
  }
}

/**
 * Walk UP from `sourcePath` until we find the `agents` or `skills` segment,
 * then return the directory containing that segment plus the segment itself
 * (i.e. the "category root" used by buildArchivePath).
 *
 * Returns null when the segment is absent (caller treats as a programming
 * bug and records a failed archive op).
 */
function findCategoryRoot(sourcePath: string, category: 'agent' | 'skill'): string | null {
  const segment = category === 'agent' ? 'agents' : 'skills';
  const parts = sourcePath.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === segment) {
      return parts.slice(0, i + 1).join(path.sep) || path.sep;
    }
  }
  return null;
}

// -- Disable MCP (dual-schema transactional mutator) --------------

/** Internal result of the Disable MCP step. Mapped to BustResult by runBust. */
type DisableMcpResult =
  | { status: 'ok'; ops: ManifestOp[] }
  | { status: 'parse-error'; path: string; error: string }
  | { status: 'write-error'; path: string; error: string };

/**
 * Disable ghost MCP servers via in-memory key-rename followed by atomic write.
 *
 * **Dual schema support** — critical correctness requirement:
 *
 *   `.mcp.json` files use a FLAT top-level schema:
 *     `{ "mcpServers": { "<name>": {...} } }`
 *   with NO `projects` wrapper. See scanMcpServers in scan-mcp.ts lines 84-106.
 *   These are discovered by `tinyglobby` inside each project directory and the
 *   scanner sets `scope: 'project'` + `path: <abs .mcp.json path>` +
 *   `projectPath: <project dir>`.
 *
 *   `~/.claude.json` uses a NESTED schema:
 *     global scope:  `{ "mcpServers": { "<name>": {...} } }`
 *     project scope: `{ "projects": { "<path>": { "mcpServers": {...} } } }`
 *
 *   The scanner reports `scope: 'project'` for BOTH `.mcp.json` entries AND
 *   `~/.claude.json` projects.<path>.mcpServers entries. The only way to
 *   distinguish at this layer is `path.basename(item.path) === '.mcp.json'`.
 *
 * **Transactionality** — per config file, not per bust:
 *
 *   Each distinct `configPath` is its own transaction. All rename ops for a
 *   single file are applied in memory, then the file is atomically written.
 *   If parse or write fails, NONE of that file's ops land in the manifest
 *   (fail-fast per D-14).
 *
 *   Cross-file atomicity is NOT guaranteed: if file A's write succeeds and
 *   file B's read fails, file A's renames ARE committed and do appear in the
 *   manifest. This is the intentional trade-off for supporting mixed sources
 *   (e.g. one `.mcp.json` + the global `~/.claude.json`) in a single bust.
 */
async function disableMcpTransactional(
  items: ChangePlanItem[],
  deps: BustDeps,
  counts: BustCounts,
): Promise<DisableMcpResult> {
  // Group by config file path -- each distinct file is its own transaction.
  const byConfigPath = new Map<string, ChangePlanItem[]>();
  for (const item of items) {
    const list = byConfigPath.get(item.path) ?? [];
    list.push(item);
    byConfigPath.set(item.path, list);
  }

  const ops: ManifestOp[] = [];

  for (const [configPath, configItems] of byConfigPath) {
    // Schema detection via basename. See module JSDoc for rationale.
    const isFlatMcpJson = path.basename(configPath) === '.mcp.json';

    // Read config with LOUD errors (D-14 fail-fast + RESEARCH Pitfall 6).
    // Unlike the scanner's readClaudeConfig (which swallows errors), the bust
    // path MUST surface parse/read failures so users know the file is broken
    // before we try to mutate it.
    let raw: string;
    try {
      raw = await deps.readFileUtf8(configPath);
    } catch (err) {
      return { status: 'parse-error', path: configPath, error: (err as Error).message };
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return { status: 'parse-error', path: configPath, error: (err as Error).message };
    }

    // Collect existing top-level keys for collision detection (D-06). The
    // disabled key namespace is the top level of this file, since both flat
    // `.mcp.json` and global `~/.claude.json` write the disabled key at doc
    // root. Per-project nested mutations use their own per-project key set.
    const existingKeys = new Set(Object.keys(config));

    const planOps: ManifestOp[] = [];
    for (const item of configItems) {
      if (isFlatMcpJson) {
        // FLAT `.mcp.json` schema. Mutate top-level `mcpServers`, write
        // disabled key at DOCUMENT ROOT (NOT nested under any `projects`
        // wrapper — .mcp.json has no `projects` key). Scope is reported as
        // 'project' for manifest traceability (matching what scanMcpServers
        // produces) but the mutation is flat.
        const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
        if (!(item.name in mcpServers)) continue; // already disabled or removed
        const originalValue = mcpServers[item.name];
        const newKey = buildDisabledMcpKey(item.name, existingKeys, deps.now());
        existingKeys.add(newKey);
        (config as Record<string, unknown>)[newKey] = originalValue;
        delete mcpServers[item.name];
        config.mcpServers = mcpServers;
        planOps.push(
          buildDisableOp({
            config_path: configPath,
            scope: 'project',
            project_path: item.projectPath,
            original_key: `mcpServers.${item.name}`,
            new_key: newKey,
            original_value: originalValue,
          }),
        );
      } else if (item.scope === 'global') {
        // NESTED `~/.claude.json` global scope -- mutate top-level `mcpServers`.
        const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
        if (!(item.name in mcpServers)) continue;
        const originalValue = mcpServers[item.name];
        const newKey = buildDisabledMcpKey(item.name, existingKeys, deps.now());
        existingKeys.add(newKey);
        (config as Record<string, unknown>)[newKey] = originalValue;
        delete mcpServers[item.name];
        config.mcpServers = mcpServers;
        planOps.push(
          buildDisableOp({
            config_path: configPath,
            scope: 'global',
            project_path: null,
            original_key: `mcpServers.${item.name}`,
            new_key: newKey,
            original_value: originalValue,
          }),
        );
      } else {
        // NESTED `~/.claude.json` project scope: mutate
        // `projects.<projectPath>.mcpServers`. The disabled key is stored at
        // the project level (sibling of the project's own `mcpServers`) so
        // Phase 9 can restore it by locating the matching project path.
        const projects = (config.projects ?? {}) as Record<
          string,
          { mcpServers?: Record<string, unknown> }
        >;
        const projKey = item.projectPath ?? '';
        const proj = projects[projKey] ?? { mcpServers: {} };
        const projMcp = (proj.mcpServers ?? {}) as Record<string, unknown>;
        if (!(item.name in projMcp)) continue;
        const originalValue = projMcp[item.name];
        // Use a per-project key set so parallel projects don't interfere.
        const projKeys = new Set(Object.keys(projMcp).concat(Object.keys(proj)));
        const newKey = buildDisabledMcpKey(item.name, projKeys, deps.now());
        delete projMcp[item.name];
        (proj as Record<string, unknown>)[newKey] = originalValue;
        proj.mcpServers = projMcp;
        projects[projKey] = proj;
        config.projects = projects;
        planOps.push(
          buildDisableOp({
            config_path: configPath,
            scope: 'project',
            project_path: item.projectPath,
            original_key: `projects.${projKey}.mcpServers.${item.name}`,
            new_key: newKey,
            original_value: originalValue,
          }),
        );
      }
    }

    // Atomic write back. Only committed ops for THIS file are appended to the
    // outer ops array; if the write throws, the file's planOps are discarded
    // and the caller returns {status:'write-error'} without writing any of
    // them to the manifest (fail-fast per D-14).
    try {
      await deps.atomicWriteJson(configPath, config);
    } catch (err) {
      return { status: 'write-error', path: configPath, error: (err as Error).message };
    }
    ops.push(...planOps);
  }

  counts.disable.completed += ops.length;
  return { status: 'ok', ops };
}

// -- Confirmation ceremony (D-15, D-16) ---------------------------

/**
 * Injectable I/O for the confirmation ceremony. Tests pass a fake with a
 * pre-seeded input queue + a line buffer; production uses the default
 * readline-based implementation.
 */
export interface CeremonyIO {
  readLine: (prompt: string) => Promise<string>;
  print: (s: string) => void;
}

/**
 * Three-prompt confirmation ceremony per D-15:
 *
 *   [1/3] This will modify your Claude Code configuration. Proceed? [y/N]
 *   [2/3] Are you sure? This archives agents, disables MCP servers, and flags memory files. [y/N]
 *   [3/3] Type exactly: I accept full responsibility  (case-sensitive, up to 3 attempts)
 *
 * The `yes` flag (from --yes-proceed-busting per D-16) bypasses all prompts
 * and returns `{status: 'accepted'}` immediately.
 */
export async function runConfirmationCeremony(opts: {
  plan: ChangePlan;
  yes: boolean;
  io?: CeremonyIO;
}): Promise<CeremonyResult> {
  if (opts.yes) return { status: 'accepted' };
  const io = opts.io ?? defaultCeremonyIo();

  // Prompt 1: y/N
  const a1 = await io.readLine(
    '\n[1/3] This will modify your Claude Code configuration. Proceed? [y/N]: ',
  );
  if (!/^[yY]$/.test(a1.trim())) {
    io.print('Bust cancelled. No changes made.');
    return { status: 'aborted', stage: 'prompt1', reason: 'y/N declined' };
  }

  // Prompt 2: second y/N
  const a2 = await io.readLine(
    '\n[2/3] Are you sure? This archives agents, disables MCP servers, and flags memory files. [y/N]: ',
  );
  if (!/^[yY]$/.test(a2.trim())) {
    io.print('Bust cancelled. No changes made.');
    return { status: 'aborted', stage: 'prompt2', reason: 'y/N declined' };
  }

  // Prompt 3: typed phrase, up to 3 attempts
  const PHRASE = 'I accept full responsibility';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const a3 = await io.readLine(`\n[3/3] Type exactly: ${PHRASE}\n> `);
    if (a3.trim() === PHRASE) return { status: 'accepted' };
    if (attempt < 3) io.print(`That didn't match. Type exactly: ${PHRASE}`);
  }
  io.print('Aborted after 3 attempts. Run the command again when ready.');
  return { status: 'aborted', stage: 'prompt3', reason: 'phrase mismatch after 3 attempts' };
}

/**
 * Default readline-based ceremony I/O for production. Tests never call this
 * helper; they pass a fake CeremonyIO with a pre-seeded input queue.
 *
 * Pitfall 4 (RESEARCH.md): if stdin is piped/EOF'd, readline's `close` event
 * fires without ever calling the question callback. The `rl.on('close', ...)`
 * safety net resolves with a sentinel so the prompt doesn't hang forever.
 * The caller (runConfirmationCeremony) then compares the sentinel against
 * the expected input and aborts cleanly.
 */
function defaultCeremonyIo(): CeremonyIO {
  return {
    readLine: (prompt) =>
      new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;
        rl.question(prompt, (answer) => {
          answered = true;
          rl.close();
          resolve(answer);
        });
        // Pitfall 4 safety net: on EOF (piped stdin), resolve with sentinel.
        // Guard with `answered` because rl.close() emits 'close' synchronously,
        // so the close handler fires before resolve(answer) if we don't gate it.
        rl.on('close', () => {
          if (!answered) resolve('__eof__');
        });
      }),
    print: (s) => {
      console.log(s);
    },
  };
}

// -- In-source tests ----------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, writeFile: wf, rm, readFile: rf, mkdir: mk } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { readManifest } = await import('./manifest.ts');
  const { canonicalItemId } = await import('./checkpoint.ts');
  const { existsSync } = await import('node:fs');
  type ArchiveOp = import('./manifest.ts').ArchiveOp;
  type DisableOp = import('./manifest.ts').DisableOp;

  // Factory: minimal BustDeps with all-passing defaults. Individual tests
  // spread `makeDeps(tmp, { ...overrides })` to vary one knob at a time.
  function makeDeps(tmp: string, overrides: Partial<BustDeps> = {}): BustDeps {
    const manifestPath = path.join(tmp, 'manifest.jsonl');
    const checkpointPath = path.join(tmp, '.last-dry-run');
    return {
      readCheckpoint: async () => ({
        status: 'ok',
        checkpoint: {
          checkpoint_version: 1,
          ccaudit_version: '0.0.1',
          timestamp: '2026-04-05T18:30:00.000Z',
          since_window: '7d',
          ghost_hash: 'sha256:test',
          item_count: { agents: 0, skills: 0, mcp: 0, memory: 0 },
          savings: { tokens: 0 },
          total_overhead: 0,
        },
      }),
      checkpointPath: () => checkpointPath,
      scanAndEnrich: async () => [],
      computeHash: async () => 'sha256:test',
      processDetector: {
        runCommand: async () => '',
        getParentPid: async () => null,
        platform: 'linux' as NodeJS.Platform,
      },
      selfPid: 999,
      runCeremony: async () => ({ status: 'accepted' }),
      renameFile: async (from, to) => {
        await rename(from, to);
      },
      mkdirRecursive: async (dir, mode) => {
        await mk(dir, { recursive: true, mode });
      },
      readFileUtf8: async (p) => rf(p, 'utf8'),
      patchMemoryFrontmatter: patchFrontmatter,
      atomicWriteJson: async (target, value) => {
        await wf(target, JSON.stringify(value, null, 2), 'utf8');
      },
      pathExistsSync: () => false,
      createManifestWriter: (p) => new ManifestWriter(p),
      manifestPath: () => manifestPath,
      now: () => new Date('2026-04-05T18:30:00.000Z'),
      ccauditVersion: '0.0.1',
      nodeVersion: 'v22',
      sinceWindow: '7d',
      os: 'linux' as NodeJS.Platform,
      ...overrides,
    };
  }

  // ── Gate verification ────────────────────────────────────────────
  describe('runBust — gate verification', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('returns checkpoint-missing when readCheckpoint reports missing', async () => {
      const result = await runBust({
        yes: true,
        deps: makeDeps(tmp, { readCheckpoint: async () => ({ status: 'missing' }) }),
      });
      expect(result.status).toBe('checkpoint-missing');
    });

    it('returns checkpoint-invalid on parse-error', async () => {
      const result = await runBust({
        yes: true,
        deps: makeDeps(tmp, {
          readCheckpoint: async () => ({ status: 'parse-error', message: 'bad json' }),
        }),
      });
      expect(result.status).toBe('checkpoint-invalid');
    });

    it('returns hash-mismatch when inventory hash differs from checkpoint', async () => {
      const result = await runBust({
        yes: true,
        deps: makeDeps(tmp, { computeHash: async () => 'sha256:different' }),
      });
      expect(result.status).toBe('hash-mismatch');
      if (result.status === 'hash-mismatch') {
        expect(result.expected).toBe('sha256:test');
        expect(result.actual).toBe('sha256:different');
      }
    });
  });

  // ── Preflight running-process detection (D-02/D-03/D-04) ────────
  describe('runBust — preflight running process detection', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-pre-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('returns running-process when detector finds Claude pids', async () => {
      const deps = makeDeps(tmp, {
        processDetector: {
          runCommand: async () => '  100 claude\n',
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.pids).toEqual([100]);
        expect(result.selfInvocation).toBe(false);
      }
    });

    it('detects self-invocation via parent chain (D-04)', async () => {
      // Parent tree: ccaudit (999) -> shell (500) -> claude (100) -> init (1)
      const tree: Record<number, number> = { 999: 500, 500: 100, 100: 1 };
      const deps = makeDeps(tmp, {
        selfPid: 999,
        processDetector: {
          runCommand: async () => '  100 claude\n',
          getParentPid: async (pid: number) => tree[pid] ?? null,
          platform: 'darwin',
        },
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('running-process');
      if (result.status === 'running-process') {
        expect(result.selfInvocation).toBe(true);
        expect(result.message).toMatch(/inside a Claude Code session/);
      }
    });

    it('returns process-detection-failed when spawn fails', async () => {
      const deps = makeDeps(tmp, {
        processDetector: {
          runCommand: async () => {
            throw new Error('ENOENT: ps not found');
          },
          getParentPid: async () => null,
          platform: 'linux',
        },
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('process-detection-failed');
    });
  });

  // ── Ceremony integration ─────────────────────────────────────────
  describe('runBust — ceremony', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-cer-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('returns user-aborted when ceremony rejects', async () => {
      const deps = makeDeps(tmp, {
        runCeremony: async () => ({ status: 'aborted', stage: 'prompt1', reason: 'declined' }),
      });
      const result = await runBust({ yes: false, deps });
      expect(result.status).toBe('user-aborted');
      if (result.status === 'user-aborted') {
        expect(result.stage).toBe('prompt1');
      }
    });

    it('happy path: empty plan yields success + header+footer manifest', async () => {
      const deps = makeDeps(tmp);
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
      const manifest = await readManifest(deps.manifestPath());
      expect(manifest.header).toBeTruthy();
      expect(manifest.footer).toBeTruthy();
      expect(manifest.ops).toHaveLength(0);
    });
  });

  // ── runConfirmationCeremony unit tests ───────────────────────────
  describe('runConfirmationCeremony', () => {
    function makeIo(inputs: string[]): { io: CeremonyIO; lines: string[] } {
      let idx = 0;
      const lines: string[] = [];
      return {
        lines,
        io: {
          readLine: async () => inputs[idx++] ?? '',
          print: (s) => {
            lines.push(s);
          },
        },
      };
    }

    function emptyPlan(): ChangePlan {
      return {
        archive: [],
        disable: [],
        flag: [],
        counts: { agents: 0, skills: 0, mcp: 0, memory: 0 },
        savings: { tokens: 0 },
      };
    }

    it('yes flag bypasses all prompts', async () => {
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: true });
      expect(result.status).toBe('accepted');
    });

    it('accepted path: y, y, "I accept full responsibility" → accepted', async () => {
      const { io } = makeIo(['y', 'y', 'I accept full responsibility']);
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: false, io });
      expect(result.status).toBe('accepted');
    });

    it('abort at prompt1: n → aborted at prompt1', async () => {
      const { io } = makeIo(['n']);
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: false, io });
      expect(result.status).toBe('aborted');
      if (result.status === 'aborted') expect(result.stage).toBe('prompt1');
    });

    it('abort at prompt2: y then n → aborted at prompt2', async () => {
      const { io } = makeIo(['y', 'n']);
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: false, io });
      expect(result.status).toBe('aborted');
      if (result.status === 'aborted') expect(result.stage).toBe('prompt2');
    });

    it('3× wrong phrase → aborted at prompt3', async () => {
      const { io } = makeIo(['y', 'y', 'wrong', 'still wrong', 'nope']);
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: false, io });
      expect(result.status).toBe('aborted');
      if (result.status === 'aborted') {
        expect(result.stage).toBe('prompt3');
        expect(result.reason).toMatch(/phrase mismatch/);
      }
    });

    it('case sensitive: "i accept full responsibility" does not match → aborted at prompt3', async () => {
      const { io } = makeIo([
        'y',
        'y',
        'i accept full responsibility',
        'i accept full responsibility',
        'i accept full responsibility',
      ]);
      const result = await runConfirmationCeremony({ plan: emptyPlan(), yes: false, io });
      expect(result.status).toBe('aborted');
      if (result.status === 'aborted') expect(result.stage).toBe('prompt3');
    });
  });

  // ── Execution order + failure policies ───────────────────────────
  describe('runBust — execution order and failure policies', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-exec-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('full pipeline: 2 agents + 1 MCP + 1 memory in correct order (D-13)', async () => {
      // Build a real fixture tree under tmp.
      const claudeRoot = path.join(tmp, '.claude');
      await mk(path.join(claudeRoot, 'agents'), { recursive: true });
      await mk(path.join(claudeRoot, 'skills'), { recursive: true });
      await wf(path.join(claudeRoot, 'agents', 'foo.md'), 'agent body', 'utf8');
      await wf(path.join(claudeRoot, 'skills', 'bar.md'), 'skill body', 'utf8');
      await wf(path.join(claudeRoot, 'CLAUDE.md'), '# Memory\nBody\n', 'utf8');
      const configPath = path.join(tmp, '.claude.json');
      await wf(
        configPath,
        JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }),
        'utf8',
      );

      // Synthetic enriched for the plan (real callers would use scanAll + enrichScanResults)
      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'foo',
            path: path.join(claudeRoot, 'agents', 'foo.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'bar',
            path: path.join(claudeRoot, 'skills', 'bar.md'),
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 50, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'playwright',
            path: configPath,
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 1000, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'CLAUDE.md',
            path: path.join(claudeRoot, 'CLAUDE.md'),
            scope: 'global',
            category: 'memory',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 20, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        // The default readCheckpoint returns ghost_hash 'sha256:test';
        // computeHash also returns 'sha256:test' by default, so Gate 2 passes.
      });

      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      const manifest = await readManifest(deps.manifestPath());
      expect(manifest.ops).toHaveLength(4);
      expect(manifest.ops.map((o) => o.op_type)).toEqual(['archive', 'archive', 'disable', 'flag']);
      // Archive agent before skill (D-13)
      expect((manifest.ops[0] as ArchiveOp).category).toBe('agent');
      expect((manifest.ops[1] as ArchiveOp).category).toBe('skill');

      // MCP was key-renamed in config
      const updatedConfig = JSON.parse(await rf(configPath, 'utf8'));
      expect(updatedConfig.mcpServers.playwright).toBeUndefined();
      expect(updatedConfig['ccaudit-disabled:playwright']).toBeTruthy();

      // Memory file has frontmatter stale key
      const memoryContent = await rf(path.join(claudeRoot, 'CLAUDE.md'), 'utf8');
      expect(memoryContent).toContain('ccaudit-stale: true');

      // Footer present; archive agent path is under ccaudit/archived/
      expect(manifest.footer).toBeTruthy();
      const archiveAgentOp = manifest.ops[0] as ArchiveOp;
      expect(archiveAgentOp.archive_path).toContain(path.join('ccaudit', 'archived', 'agents'));
      expect(archiveAgentOp.archive_path).toMatch(/foo\.md$/);
    });

    it('config-parse-error on malformed ~/.claude.json: fail-fast, no disable ops in manifest', async () => {
      const configPath = path.join(tmp, '.claude.json');
      await wf(configPath, 'not valid json {{{', 'utf8');
      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'playwright',
            path: configPath,
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
      ];
      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('config-parse-error');
    });

    it('archive continue-on-error: one failed rename does not stop remaining ops (D-14)', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      await mk(path.join(claudeRoot, 'agents'), { recursive: true });
      await wf(path.join(claudeRoot, 'agents', 'foo.md'), 'a', 'utf8');
      await wf(path.join(claudeRoot, 'agents', 'bar.md'), 'b', 'utf8');

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'foo',
            path: path.join(claudeRoot, 'agents', 'foo.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 10, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'bar',
            path: path.join(claudeRoot, 'agents', 'bar.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 10, confidence: 'estimated', source: 'test' },
        },
      ];

      let renameCalls = 0;
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        renameFile: async (from, to) => {
          renameCalls++;
          if (renameCalls === 1) throw new Error('EACCES: simulated failure');
          await rename(from, to);
        },
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('partial-success');
      if (result.status === 'partial-success') {
        // Both items are agents; one rename fails, one succeeds.
        expect(result.counts.archive.agents).toBe(1);
        expect(result.counts.archive.skills).toBe(0);
        expect(result.counts.archive.failed).toBe(1);
      }
      const manifest = await readManifest(deps.manifestPath());
      expect(manifest.ops).toHaveLength(2);
      expect((manifest.ops[0] as ArchiveOp).status).toBe('failed');
      expect((manifest.ops[1] as ArchiveOp).status).toBe('completed');
    });

    it('skill directories are archived correctly (not just files)', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const skillDir = path.join(claudeRoot, 'skills', 'my-skill');
      await mk(skillDir, { recursive: true });
      await wf(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\n# Skill body', 'utf8');
      await mk(path.join(skillDir, 'references'), { recursive: true });
      await wf(path.join(skillDir, 'references', 'ref.md'), 'ref content', 'utf8');

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'my-skill',
            path: skillDir,
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 50, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      const manifest = await readManifest(deps.manifestPath());
      expect(manifest.ops).toHaveLength(1);
      const archiveOp = manifest.ops[0] as ArchiveOp;
      expect(archiveOp.status).toBe('completed');
      expect(archiveOp.category).toBe('skill');
      expect(archiveOp.archive_path).toContain(path.join('ccaudit', 'archived', 'skills'));
      // content_sha256 should be non-empty (hashed from SKILL.md)
      expect(archiveOp.content_sha256).toBeTruthy();
      expect(archiveOp.content_sha256).not.toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256('')
      );
    });
  });

  // ── Issue 1 fix: .mcp.json flat schema disable ──────────────────
  describe('runBust — .mcp.json flat schema (Issue 1 fix)', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-mcpjson-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('.mcp.json disable: key moves to top level (NOT nested under projects), manifest op reflects path', async () => {
      // Create a project dir with a .mcp.json containing a ghost MCP server.
      // .mcp.json uses the FLAT top-level schema:
      //   { "mcpServers": { "ghost-server": {...} } }
      // with NO `projects` wrapper. See scanMcpServers in scan-mcp.ts lines 84-106.
      const projDir = path.join(tmp, 'proj');
      await mk(projDir, { recursive: true });
      const mcpJsonPath = path.join(projDir, '.mcp.json');
      const originalValue = { command: 'x' };
      await wf(
        mcpJsonPath,
        JSON.stringify({ mcpServers: { 'ghost-server': originalValue } }),
        'utf8',
      );

      // Synthetic enriched InventoryItem matching what scanMcpServers produces
      // for a .mcp.json-sourced ghost server: scope 'project', path pointing
      // AT the .mcp.json file, projectPath set to the project dir.
      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'ghost-server',
            path: mcpJsonPath,
            scope: 'project',
            category: 'mcp-server',
            projectPath: projDir,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 500, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      // Assert file mutation: FLAT schema, key at document root.
      const after = JSON.parse(await rf(mcpJsonPath, 'utf8'));
      // `ghost-server` removed from `mcpServers`.
      expect(after.mcpServers?.['ghost-server']).toBeUndefined();
      // Disabled key lives at TOP LEVEL (not nested under `projects`).
      expect(after['ccaudit-disabled:ghost-server']).toEqual(originalValue);
      // No `projects` key was synthesized -- .mcp.json is a flat document.
      expect(after.projects).toBeUndefined();

      // Assert manifest op.
      const manifest = await readManifest(deps.manifestPath());
      expect(manifest.ops).toHaveLength(1);
      const disableOp = manifest.ops[0] as DisableOp;
      expect(disableOp.op_type).toBe('disable');
      expect(disableOp.config_path).toBe(mcpJsonPath);
      expect(disableOp.original_key).toBe('mcpServers.ghost-server');
      expect(disableOp.new_key).toBe('ccaudit-disabled:ghost-server');
      expect(disableOp.original_value).toEqual(originalValue);
      expect(disableOp.scope).toBe('project');
      expect(disableOp.project_path).toBe(projDir);
    });

    it('mixed sources: .mcp.json AND ~/.claude.json disabled in same bust — each file is its own transaction', async () => {
      // Global server in ~/.claude.json
      const claudeJsonPath = path.join(tmp, '.claude.json');
      await wf(
        claudeJsonPath,
        JSON.stringify({ mcpServers: { 'global-ghost': { command: 'a' } } }),
        'utf8',
      );
      // Project server in .mcp.json
      const projDir = path.join(tmp, 'proj');
      await mk(projDir, { recursive: true });
      const mcpJsonPath = path.join(projDir, '.mcp.json');
      await wf(
        mcpJsonPath,
        JSON.stringify({ mcpServers: { 'proj-ghost': { command: 'b' } } }),
        'utf8',
      );

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'global-ghost',
            path: claudeJsonPath,
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'proj-ghost',
            path: mcpJsonPath,
            scope: 'project',
            category: 'mcp-server',
            projectPath: projDir,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      // ~/.claude.json: global server moved to top level
      const claudeAfter = JSON.parse(await rf(claudeJsonPath, 'utf8'));
      expect(claudeAfter.mcpServers?.['global-ghost']).toBeUndefined();
      expect(claudeAfter['ccaudit-disabled:global-ghost']).toEqual({ command: 'a' });

      // .mcp.json: project server moved to top level of THAT file (not ~/.claude.json)
      const mcpAfter = JSON.parse(await rf(mcpJsonPath, 'utf8'));
      expect(mcpAfter.mcpServers?.['proj-ghost']).toBeUndefined();
      expect(mcpAfter['ccaudit-disabled:proj-ghost']).toEqual({ command: 'b' });
      expect(mcpAfter.projects).toBeUndefined();

      // Manifest has one disable op per file
      const manifest = await readManifest(deps.manifestPath());
      const disableOps = manifest.ops.filter((o) => o.op_type === 'disable') as DisableOp[];
      expect(disableOps).toHaveLength(2);
      const paths = disableOps.map((o) => o.config_path).sort();
      expect(paths).toEqual([claudeJsonPath, mcpJsonPath].sort());
    });
  });

  // ── Phase 5: mcp_regime pinned in checkpoint (Bug #4) ──────────────
  describe('runBust — mcp_regime pinned from checkpoint, not re-resolved during bust (Phase 5)', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-regime-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('checkpoint with mcp_regime field loads without error and bust succeeds', async () => {
      // Checkpoint with the new mcp_regime + cc_version fields (Phase 5 green)
      const deps = makeDeps(tmp, {
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-14T08:19:58.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 0, skills: 0, mcp: 0, memory: 0 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
            mcp_regime: 'eager' as const,
            cc_version: '2.2.0',
          },
        }),
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
    });

    it('checkpoint without mcp_regime (old format) still loads — backward compat', async () => {
      // Old checkpoint without the new fields must still work
      const deps = makeDeps(tmp, {
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-14T08:00:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 0, skills: 0, mcp: 0, memory: 0 },
            savings: { tokens: 500 },
            total_overhead: 3000,
            // mcp_regime and cc_version intentionally absent (old format)
          },
        }),
      });
      const result = await runBust({ yes: true, deps });
      // Must succeed (no crash on missing fields)
      expect(result.status).toBe('success');
    });

    it('pinned beforeTokens equals checkpoint.total_overhead — regime not re-computed', async () => {
      // The bust result's beforeTokens must equal checkpoint.total_overhead exactly.
      // This proves the bust uses the pinned value, not a live re-scan.
      const deps = makeDeps(tmp, {
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-14T08:19:58.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 0, skills: 0, mcp: 0, memory: 0 },
            savings: { tokens: 2000 },
            total_overhead: 96_000,
            mcp_regime: 'eager' as const,
            cc_version: '2.2.0',
          },
        }),
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // beforeTokens must be exactly the pinned checkpoint value (96k)
        expect(result.summary.beforeTokens).toBe(96_000);
        // afterTokens must be beforeTokens - savings (96k - 2k = 94k)
        expect(result.summary.afterTokens).toBe(94_000);
      }
    });

    it('bust summary includes checkpointTimestamp for provenance labelling', async () => {
      // The bust summary must expose the checkpoint timestamp so the renderer
      // can display "Before (from dry-run 2026-04-14T08:19:58Z): ~96k tokens"
      const deps = makeDeps(tmp, {
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-14T08:19:58.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 0, skills: 0, mcp: 0, memory: 0 },
            savings: { tokens: 0 },
            total_overhead: 10_000,
            mcp_regime: 'eager' as const,
            cc_version: '2.2.0',
          },
        }),
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // summary must expose checkpointTimestamp for provenance
        expect(result.summary.checkpointTimestamp).toBe('2026-04-14T08:19:58.000Z');
      }
    });
  });

  // ── Bug #1 regression: archive.agents / archive.skills split ────────
  describe('runBust — archive agents/skills counted independently (Bug #1)', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-split-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('BustCounts.archive.agents and archive.skills increment independently', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      await mk(path.join(claudeRoot, 'agents'), { recursive: true });
      await mk(path.join(claudeRoot, 'skills'), { recursive: true });
      await wf(path.join(claudeRoot, 'agents', 'ghost-agent.md'), '# agent', 'utf8');
      await wf(path.join(claudeRoot, 'skills', 'ghost-skill.md'), '# skill', 'utf8');

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'ghost-agent',
            path: path.join(claudeRoot, 'agents', 'ghost-agent.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'ghost-skill',
            path: path.join(claudeRoot, 'skills', 'ghost-skill.md'),
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 50, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      if (result.status === 'success') {
        // archive.agents must be 1 (the agent), archive.skills must be 1 (the skill).
        expect(result.counts.archive.agents).toBe(1);
        expect(result.counts.archive.skills).toBe(1);
        expect(result.counts.archive.failed).toBe(0);
      }
    });

    it('archive.agents increments only for agents, archive.skills only for skills', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      await mk(path.join(claudeRoot, 'agents'), { recursive: true });
      await mk(path.join(claudeRoot, 'skills'), { recursive: true });
      await wf(path.join(claudeRoot, 'agents', 'a1.md'), '# a', 'utf8');
      await wf(path.join(claudeRoot, 'agents', 'a2.md'), '# a', 'utf8');
      await wf(path.join(claudeRoot, 'skills', 's1.md'), '# s', 'utf8');

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'a1',
            path: path.join(claudeRoot, 'agents', 'a1.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 10, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'a2',
            path: path.join(claudeRoot, 'agents', 'a2.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 10, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 's1',
            path: path.join(claudeRoot, 'skills', 's1.md'),
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 10, confidence: 'estimated', source: 'test' },
        },
      ];

      const deps = makeDeps(tmp, { scanAndEnrich: async () => enriched });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');

      if (result.status === 'success') {
        expect(result.counts.archive.agents).toBe(2);
        expect(result.counts.archive.skills).toBe(1);
        expect(result.counts.archive.failed).toBe(0);
      }
    });
  });

  // ── INV-S4 + INV-S5: selectedItems filter (Plan 01-02) ────────────
  describe('runBust — selectedItems subset filter (INV-S4 + INV-S5)', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'bust-subset-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    // Build a 5-item fixture: 2 agents, 1 skill, 1 mcp-server, 1 memory.
    // Tokens: agent1=100, agent2=200, skill1=300, mcp1=400, mem1=50.
    // Only archive/disable contribute to freedTokens (not flag/memory).
    async function makeFixture5(claudeRoot: string) {
      await mk(path.join(claudeRoot, 'agents'), { recursive: true });
      await mk(path.join(claudeRoot, 'skills'), { recursive: true });
      await wf(path.join(claudeRoot, 'agents', 'agent1.md'), '# agent1', 'utf8');
      await wf(path.join(claudeRoot, 'agents', 'agent2.md'), '# agent2', 'utf8');
      await wf(path.join(claudeRoot, 'skills', 'skill1.md'), '# skill1', 'utf8');
      await wf(path.join(claudeRoot, 'CLAUDE.md'), '# memory', 'utf8');
      const configPath = path.join(tmp, '.claude.json');
      await wf(configPath, JSON.stringify({ mcpServers: { mcp1: { command: 'x' } } }), 'utf8');

      const enriched: TokenCostResult[] = [
        {
          item: {
            name: 'agent1',
            path: path.join(claudeRoot, 'agents', 'agent1.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'agent2',
            path: path.join(claudeRoot, 'agents', 'agent2.md'),
            scope: 'global',
            category: 'agent',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 200, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'skill1',
            path: path.join(claudeRoot, 'skills', 'skill1.md'),
            scope: 'global',
            category: 'skill',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 300, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'mcp1',
            path: configPath,
            scope: 'global',
            category: 'mcp-server',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 400, confidence: 'estimated', source: 'test' },
        },
        {
          item: {
            name: 'CLAUDE.md',
            path: path.join(claudeRoot, 'CLAUDE.md'),
            scope: 'global',
            category: 'memory',
            projectPath: null,
          },
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
          tokenEstimate: { tokens: 50, confidence: 'estimated', source: 'test' },
        },
      ];
      return { enriched, configPath };
    }

    it('Test 1 (INV-S4): full bust — planned_ops sum equals full plan total, freedTokens === totalPlannedTokens', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      // Checkpoint savings = 100+200+300+400 = 1000 (agents+skills+mcp, no memory)
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-05T18:30:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 2, skills: 1, mcp: 1, memory: 1 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
          },
        }),
      });
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.summary.freedTokens).toBe(result.summary.totalPlannedTokens);
      }
      const manifest = await readManifest(deps.manifestPath());
      const ops = manifest.header!.planned_ops;
      expect(ops.archive + ops.disable + ops.flag).toBe(5);
    });

    it('Test 2 (INV-S4): subset bust with 2 of 5 selected — planned_ops sum equals 2', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      const agent1 = enriched[0]!.item;
      const agent2 = enriched[1]!.item;
      const selectedItems = new Set([canonicalItemId(agent1), canonicalItemId(agent2)]);
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-05T18:30:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 2, skills: 1, mcp: 1, memory: 1 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
          },
        }),
      });
      const result = await runBust({ yes: true, deps, selectedItems });
      expect(result.status).toBe('success');
      const manifest = await readManifest(deps.manifestPath());
      const ops = manifest.header!.planned_ops;
      // 2 agents selected → archive=2, disable=0, flag=0 → sum=2
      expect(ops.archive + ops.disable + ops.flag).toBe(2);
      // header + 2 ops + footer = 4 lines
      expect(manifest.ops).toHaveLength(2);
    });

    it('Test 3 (INV-S5): subset bust — freedTokens reflects selected items, totalPlannedTokens reflects full plan', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      // Select agent1 (100 tokens) and mcp1 (400 tokens) = freedTokens = 500
      const agent1 = enriched[0]!.item;
      const mcp1 = enriched[3]!.item;
      const selectedItems = new Set([canonicalItemId(agent1), canonicalItemId(mcp1)]);
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-05T18:30:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 2, skills: 1, mcp: 1, memory: 1 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
          },
        }),
      });
      const result = await runBust({ yes: true, deps, selectedItems });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // freedTokens = agent1(100) + mcp1(400) = 500 (subset)
        expect(result.summary.freedTokens).toBe(500);
        // totalPlannedTokens = checkpoint.savings.tokens = 1000 (full plan)
        expect(result.summary.totalPlannedTokens).toBe(1000);
      }
    });

    it('Test 4: selection_filter in manifest header — full bust sets mode=full, subset sets mode=subset', async () => {
      // Full bust: uses default makeDeps (empty scan) to verify mode=full
      const depsFull = makeDeps(tmp);
      const resultFull = await runBust({ yes: true, deps: depsFull });
      expect(resultFull.status).toBe('success');
      const manifestFull = await readManifest(depsFull.manifestPath());
      expect(manifestFull.header!.selection_filter?.mode).toBe('full');

      // Subset bust — fresh tmp, empty scan, just verify mode=subset + ids in header
      const tmp2 = await mkdtemp(path.join(tmpdir(), 'bust-sf-sub-'));
      try {
        const someId = 'agent|global||/some/path/agent.md';
        const depsSub = makeDeps(tmp2);
        const resultSub = await runBust({
          yes: true,
          deps: depsSub,
          selectedItems: new Set([someId]),
        });
        expect(resultSub.status).toBe('success');
        const manifestSub = await readManifest(depsSub.manifestPath());
        const sf = manifestSub.header!.selection_filter;
        expect(sf?.mode).toBe('subset');
        if (sf?.mode === 'subset') {
          expect(sf.ids).toContain(someId);
        }
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    });

    it('Test 5: empty selectedItems — planned_ops all 0, freedTokens=0, totalPlannedTokens from checkpoint', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-05T18:30:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 2, skills: 1, mcp: 1, memory: 1 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
          },
        }),
      });
      const warnSpy: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnSpy.push(String(args[0]));
      };
      try {
        const result = await runBust({ yes: true, deps, selectedItems: new Set() });
        expect(result.status).toBe('success');
        if (result.status === 'success') {
          expect(result.summary.freedTokens).toBe(0);
          expect(result.summary.totalPlannedTokens).toBe(1000);
        }
        const manifest = await readManifest(deps.manifestPath());
        const ops = manifest.header!.planned_ops;
        expect(ops.archive).toBe(0);
        expect(ops.disable).toBe(0);
        expect(ops.flag).toBe(0);
        // Warning emitted
        expect(warnSpy.some((w) => w.includes('empty set'))).toBe(true);
      } finally {
        console.warn = origWarn;
      }
    });

    it('Test 6 (backward-compat): selectedItems=undefined produces same manifest counts as pre-Plan-02', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        readCheckpoint: async () => ({
          status: 'ok',
          checkpoint: {
            checkpoint_version: 1,
            ccaudit_version: '0.0.1',
            timestamp: '2026-04-05T18:30:00.000Z',
            since_window: '7d',
            ghost_hash: 'sha256:test',
            item_count: { agents: 2, skills: 1, mcp: 1, memory: 1 },
            savings: { tokens: 1000 },
            total_overhead: 5000,
          },
        }),
      });
      // No selectedItems → full bust
      const result = await runBust({ yes: true, deps });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // freedTokens = checkpoint.savings.tokens = 1000 (v1.4.0 behavior)
        expect(result.summary.freedTokens).toBe(1000);
        expect(result.summary.totalPlannedTokens).toBe(1000);
      }
      const manifest = await readManifest(deps.manifestPath());
      // 5 total planned ops (2 archive + 1 archive + 1 disable + 1 flag)
      const ops = manifest.header!.planned_ops;
      expect(ops.archive + ops.disable + ops.flag).toBe(5);
    });

    it('Test 7 (approach A — hash gate): subset bust with mismatched hash returns hash-mismatch, no manifest file', async () => {
      const claudeRoot = path.join(tmp, '.claude');
      const { enriched } = await makeFixture5(claudeRoot);
      const agent1 = enriched[0]!.item;
      const selectedItems = new Set([canonicalItemId(agent1)]);
      const deps = makeDeps(tmp, {
        scanAndEnrich: async () => enriched,
        computeHash: async () => 'sha256:different', // mismatch
      });
      const result = await runBust({ yes: true, deps, selectedItems });
      expect(result.status).toBe('hash-mismatch');
      // Manifest must NOT exist (hash gate aborted before any disk write)
      expect(existsSync(deps.manifestPath())).toBe(false);
    });
  });
}
