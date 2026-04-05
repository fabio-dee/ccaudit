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

import { readFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { TokenCostResult } from '../token/types.ts';
import {
  readCheckpoint,
  computeGhostHash,
  resolveCheckpointPath,
  type Checkpoint,
  type ReadCheckpointResult,
} from './checkpoint.ts';
import { buildChangePlan, type ChangePlan, type ChangePlanItem } from './change-plan.ts';
import { calculateDryRunSavings } from './savings.ts';
import { atomicWriteJson } from './atomic-write.ts';
import { buildArchivePath, buildDisabledMcpKey } from './collisions.ts';
import {
  detectClaudeProcesses,
  walkParentChain,
  defaultDeps as defaultProcessDeps,
  type DetectResult,
  type ProcessDetectorDeps,
} from './processes.ts';
import { patchFrontmatter, type FrontmatterPatchResult } from './frontmatter.ts';
import {
  ManifestWriter,
  resolveManifestPath,
  buildHeader,
  buildFooter,
  buildArchiveOp,
  buildDisableOp,
  buildFlagOp,
  buildRefreshOp,
  buildSkippedOp,
  type ManifestOp,
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
  | { status: 'success'; manifestPath: string; counts: BustCounts; duration_ms: number }
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
  | { status: 'user-aborted'; stage: 'prompt1' | 'prompt2' }
  | { status: 'config-parse-error'; path: string; error: string }
  | { status: 'config-write-error'; path: string; error: string };

/** Per-category op counters threaded through the pipeline for the manifest footer. */
export interface BustCounts {
  archive: { completed: number; failed: number };
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
  | { status: 'aborted'; stage: 'prompt1' | 'prompt2'; reason: string };

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
export async function runBust(opts: { yes: boolean; deps: BustDeps }): Promise<BustResult> {
  const { yes, deps } = opts;
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
    return { status: 'checkpoint-invalid', reason: `unknown checkpoint version ${checkpointResult.version}` };
  }
  if (checkpointResult.status === 'schema-mismatch') {
    return { status: 'checkpoint-invalid', reason: `schema missing ${checkpointResult.missingField}` };
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

  // ── Confirmation ceremony (D-15, D-16) ───────────────────────────
  const ceremony = await deps.runCeremony({ plan, yes });
  if (ceremony.status === 'aborted') {
    return { status: 'user-aborted', stage: ceremony.stage };
  }

  // ── Execute ops (D-13 order) with manifest (D-09..D-12) ──────────
  const manifestPath = deps.manifestPath();
  const writer = deps.createManifestWriter(manifestPath);

  const plannedOps = {
    archive: plan.archive.length,
    disable: plan.disable.length,
    flag: plan.flag.length,
  };

  const header = buildHeader({
    ccaudit_version: deps.ccauditVersion,
    checkpoint_ghost_hash: checkpoint.ghost_hash,
    checkpoint_timestamp: checkpoint.timestamp,
    since_window: deps.sinceWindow,
    os: deps.os,
    node_version: deps.nodeVersion,
    planned_ops: plannedOps,
  });

  try {
    await writer.open(header);
  } catch (err) {
    return { status: 'config-write-error', path: manifestPath, error: (err as Error).message };
  }

  const counts: BustCounts = {
    archive: { completed: 0, failed: 0 },
    disable: { completed: 0, failed: 0 },
    flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
  };

  // ── Step 1: Archive agents, then skills (D-13 order) ─────────────
  // Filesystem-only ops first per D-13 rationale: if a later step fails, the
  // archived files still have manifest entries Phase 9 can reverse. D-14 says
  // these are continue-on-error.
  const agentItems = plan.archive.filter((i) => i.category === 'agent');
  const skillItems = plan.archive.filter((i) => i.category === 'skill');

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
  if (plan.disable.length > 0) {
    const disableResult = await disableMcpTransactional(plan.disable, deps, counts);
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
  for (const item of plan.flag) {
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
    actual_ops: counts,
    duration_ms,
    exit_code: exitCode,
  });
  await writer.close(footer);

  if (totalFailed > 0) {
    return { status: 'partial-success', manifestPath, counts, failed: totalFailed, duration_ms };
  }
  return { status: 'success', manifestPath, counts, duration_ms };
}

// -- Archive one agent/skill --------------------------------------

/**
 * Archive a single agent or skill file via the Plan 02 buildArchivePath
 * collision-resistant path builder. Preserves nested subdirectory structure
 * (e.g. agents/design/foo.md -> agents/_archived/design/foo.md) per RESEARCH
 * Open Question 1.
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
    // `agents` or `skills` segment. Example:
    //   sourcePath  = /home/u/.claude/agents/design/foo.md
    //   categoryRoot = /home/u/.claude/agents
    //   archivedDir  = /home/u/.claude/agents/_archived
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
    const archivedDir = path.join(categoryRoot, '_archived');

    // Read the original bytes BEFORE the rename so the manifest's content
    // sha256 reflects the pre-archive content (Phase 9 tamper detection).
    const content = await deps.readFileUtf8(item.path);

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

    counts.archive.completed += 1;
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
 * Two-prompt confirmation ceremony per D-15:
 *
 *   [1/2] Proceed busting? [y/N]:        (y/Y accepts; anything else aborts)
 *   [2/2] Type exactly: proceed busting  (case-sensitive, 3 retries)
 *
 * The `yes` flag (from --yes-proceed-busting per D-16) bypasses both prompts
 * and returns `{status: 'accepted'}` immediately.
 *
 * Case sensitivity is intentional: `Proceed Busting` does NOT match, so
 * users who habit-capitalize the first letter get a typo message. This
 * matches the screenshot-friendly "this CLI made me type 'proceed busting'"
 * UX from handoff §145-150 (reworked from the original 3-prompt design).
 */
export async function runConfirmationCeremony(opts: {
  plan: ChangePlan;
  yes: boolean;
  io?: CeremonyIO;
}): Promise<CeremonyResult> {
  if (opts.yes) return { status: 'accepted' };
  const io = opts.io ?? defaultCeremonyIo();

  // Prompt 1: y/N -- default on Enter is N.
  const a1 = await io.readLine('\n[1/2] Proceed busting? [y/N]: ');
  if (!/^[yY]$/.test(a1.trim())) {
    io.print('Aborted by user.');
    return { status: 'aborted', stage: 'prompt1', reason: 'y/N declined' };
  }

  // Prompt 2: typed phrase, up to 3 attempts.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const a2 = await io.readLine('\n[2/2] Type exactly: proceed busting\n> ');
    if (a2.trim() === 'proceed busting') {
      return { status: 'accepted' };
    }
    if (attempt < 3) io.print('(typo — try again)');
  }
  io.print('Aborted — confirmation phrase mismatch');
  return { status: 'aborted', stage: 'prompt2', reason: 'phrase mismatch after 3 attempts' };
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
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
        // Pitfall 4 safety net: on EOF (piped stdin), resolve with sentinel.
        rl.on('close', () => resolve('__eof__'));
      }),
    print: (s) => {
      // eslint-disable-next-line no-console
      console.log(s);
    },
  };
}
