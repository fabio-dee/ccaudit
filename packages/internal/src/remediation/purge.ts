// @ccaudit/internal — purge-archive domain core (Phase 9 SC6)
//
// Pure classifier + executor for `ccaudit purge-archive`. The CLI wrapper
// (Plan 09-04) is intentionally NOT landed here — this module owns only
// the append-only, fs-probe-driven logic that decides what happens to
// each ArchiveOp in the manifest union.
//
// Classification rules (matching D6 in 09-CONTEXT.md):
//   - Source FREE + archive exists           → reclaim (move back)
//   - Source OCCUPIED + archive exists       → drop (unlink archive)
//   - Archive MISSING + source exists        → drop/stale (Phase 8.2 shape)
//   - Both missing                            → skip (preserve for diagnosis)
//
// Safety invariants:
//   - Dry-run writes NOTHING (no fs mutation, no manifest op). INV-S2 spirit.
//   - Real purge: per-item try/catch — one bad op does not abort the batch.
//   - Every successful mutation produces a single append-only archive_purge op.
//   - moveArchiveToSource refuses to overwrite existing source (helper
//     preserves the reclaim INV).

import type { ArchiveOp, ArchivePurgeOp, ManifestOp, ManifestWriter } from './manifest.ts';
import { buildArchivePurgeOp, closePurgeManifestWriter } from './manifest.ts';
import { isStaleArchiveOp } from './restore.ts';
import { moveArchiveToSource, type ArchiveMoveDeps } from './archive-move.ts';
import { Result } from '@praha/byethrow';

// -- Public types ---------------------------------------------------

export type DropReason = 'source_occupied' | 'stale_archive_missing';

export interface PurgePlan {
  reclaim: Array<{ op: ArchiveOp }>;
  drop: Array<{ op: ArchiveOp; reason: DropReason }>;
  skip: Array<{ op: ArchiveOp; reason: 'both_missing' }>;
}

export interface PurgeFailure {
  path: string;
  op_id: string;
  reason: string;
}

export interface PurgeSummary {
  purgedCount: number;
  reclaimedCount: number;
  skippedOccupiedCount: number;
  staleFilteredCount: number;
}

export interface PurgeResult {
  summary: PurgeSummary;
  failures: PurgeFailure[];
  /** Path of the follow-up manifest written (real runs only; null on dry-run / zero-mutation). */
  manifestPath: string | null;
  /** The archive_purge ops appended, for caller inspection/JSON envelope. */
  appendedOps: ArchivePurgeOp[];
}

// -- Executor deps --------------------------------------------------

/**
 * Dependency surface for {@link executePurge}. All fs + manifest I/O is
 * injected so unit tests can assert zero-write behavior on dry-runs and
 * verify per-item error paths without touching real disk.
 */
export interface ExecutePurgeDeps extends ArchiveMoveDeps {
  /** Unlink a file. Tests typically spy on this to assert archive removal. */
  unlinkFile: (p: string) => Promise<void>;
  /**
   * Open a per-op purge manifest writer. Called once before any mutations;
   * the returned writer is used to fsync each op immediately after its
   * mutation succeeds (NEW-C1 audit-trail invariant).
   *
   * Real callers pass a wrapper around {@link openPurgeManifestWriter};
   * tests inject a spy that returns a mock writer.
   */
  createPurgeManifestWriter: (input: {
    ccaudit_version: string;
    purge_timestamp: string;
  }) => Promise<{ writer: ManifestWriter; path: string }>;
  /** Runtime version string embedded in the purge manifest header. */
  ccauditVersion: string;
  /** Injectable clock (ISO 8601 UTC) — defaults to new Date(). */
  now?: () => Date;
}

// -- Classifier -----------------------------------------------------

/**
 * Pure classifier over an already-deduped manifest op list.
 *
 * Filters to `op_type === 'archive'` — flag/refresh/skipped/disable/
 * archive_purge ops are never touched by purge-archive (09-CONTEXT D6).
 *
 * Reuses {@link isStaleArchiveOp} from restore.ts for stale detection so
 * the predicate does not fork.
 */
export async function classifyArchiveOps(
  ops: ReadonlyArray<ManifestOp>,
  fsProbe: (path: string) => Promise<boolean>,
): Promise<PurgePlan> {
  const reclaim: PurgePlan['reclaim'] = [];
  const drop: PurgePlan['drop'] = [];
  const skip: PurgePlan['skip'] = [];
  const purgedOriginalOpIds = collectPurgedArchiveOpIds(ops);

  for (const op of ops) {
    if (op.op_type !== 'archive') continue;
    if (purgedOriginalOpIds.has(op.op_id)) continue;
    const [archiveExists, sourceExists] = await Promise.all([
      fsProbe(op.archive_path),
      fsProbe(op.source_path),
    ]);

    if (archiveExists && !sourceExists) {
      reclaim.push({ op });
      continue;
    }
    if (archiveExists && sourceExists) {
      drop.push({ op, reason: 'source_occupied' });
      continue;
    }
    // archive missing branch
    if (!archiveExists && sourceExists) {
      // Stale-archive shape per Phase 8.2 (archive_missing + source_exists).
      // Re-probe via the canonical predicate so we don't fork the check.
      const stale = await isStaleArchiveOp(op, fsProbe);
      if (stale) {
        drop.push({ op, reason: 'stale_archive_missing' });
        continue;
      }
    }
    // Both missing (or pathological mismatch) — preserve for diagnosis.
    skip.push({ op, reason: 'both_missing' });
  }

  return { reclaim, drop, skip };
}

/**
 * Follow-up purge manifests are append-only: the original ArchiveOp remains in
 * its bust manifest, while a completed ArchivePurgeOp references it by op_id.
 * Suppress those originals before probing disk so a second purge run is a no-op
 * instead of reclassifying them as stale_archive_missing.
 */
function collectPurgedArchiveOpIds(ops: ReadonlyArray<ManifestOp>): Set<string> {
  const purged = new Set<string>();
  for (const op of ops) {
    if (op.op_type === 'archive_purge' && op.status === 'completed' && op.purged === true) {
      purged.add(op.original_op_id);
    }
  }
  return purged;
}

// -- Executor -------------------------------------------------------

/**
 * Execute a classified {@link PurgePlan}.
 *
 * - `dryRun: true`  — computes the summary and writes nothing. Safe by
 *   default when callers forget to opt in (INV-S2 spirit: aborted/dry
 *   flows leave manifests untouched).
 * - `dryRun: false` — for each reclaim item, moves archive → source and
 *   appends an archive_purge op with reason='reclaimed'. For each drop
 *   item, unlinks the archive (if present) and appends archive_purge
 *   with the classifier's drop reason. Per-item try/catch: one failure
 *   is recorded and the batch continues.
 *
 * Returns Result.err only when every requested item failed. Otherwise
 * returns Result.ok with the partial-summary + failures array so the
 * CLI envelope can surface both.
 */
export async function executePurge(
  plan: PurgePlan,
  deps: ExecutePurgeDeps,
  opts: { dryRun: boolean },
): Promise<Result.Result<PurgeResult, Error>> {
  const summary: PurgeSummary = {
    purgedCount: 0,
    reclaimedCount: 0,
    skippedOccupiedCount: 0,
    staleFilteredCount: 0,
  };
  const failures: PurgeFailure[] = [];
  const appendedOps: ArchivePurgeOp[] = [];

  const totalRequested = plan.reclaim.length + plan.drop.length;

  if (opts.dryRun) {
    // Dry-run: compute counters from the plan; NO deps called at all.
    summary.reclaimedCount = plan.reclaim.length;
    for (const item of plan.drop) {
      summary.purgedCount += 1;
      if (item.reason === 'source_occupied') summary.skippedOccupiedCount += 1;
      else summary.staleFilteredCount += 1;
    }
    return Result.succeed({
      summary,
      failures: [],
      manifestPath: null,
      appendedOps: [],
    });
  }

  // Real purge path ---------------------------------------------------
  // NEW-C1: open the manifest writer BEFORE any mutations so that each
  // successful mutation is immediately followed by a fsynced journal entry.
  // If the open/header-write fails we abort before touching the filesystem.

  // Short-circuit: if the plan is empty there is nothing to do and we must
  // NOT create an empty purge-*.jsonl (would litter manifests/ on no-op runs).
  if (totalRequested === 0) {
    return Result.succeed({ summary, failures, manifestPath: null, appendedOps });
  }

  const nowDate = (deps.now ?? (() => new Date()))();
  let writer: ManifestWriter;
  let manifestPath: string;
  try {
    const opened = await deps.createPurgeManifestWriter({
      ccaudit_version: deps.ccauditVersion,
      purge_timestamp: nowDate.toISOString(),
    });
    writer = opened.writer;
    manifestPath = opened.path;
  } catch (err) {
    // Header-open failed before any disk mutation — safe to surface as failure.
    return Result.fail(err instanceof Error ? err : new Error(String(err)));
  }

  for (const { op } of plan.reclaim) {
    try {
      const moved = await moveArchiveToSource(
        { archivePath: op.archive_path, sourcePath: op.source_path },
        deps,
      );
      if (Result.isFailure(moved)) {
        failures.push({ path: op.archive_path, op_id: op.op_id, reason: moved.error.message });
        continue;
      }
      const purgeOp = buildArchivePurgeOp({ original_op_id: op.op_id, reason: 'reclaimed' });
      // NEW-C1: fsync the op entry immediately after the mutation succeeds.
      try {
        await writer.writeOp(purgeOp);
      } catch (writeErr) {
        failures.push({
          path: op.archive_path,
          op_id: op.op_id,
          reason: `manifest_write_failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        });
        continue;
      }
      appendedOps.push(purgeOp);
      summary.reclaimedCount += 1;
    } catch (err) {
      failures.push({
        path: op.archive_path,
        op_id: op.op_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const { op, reason } of plan.drop) {
    try {
      // Only unlink when archive is physically present. For
      // `stale_archive_missing` the file is already gone by definition —
      // we still write the follow-up op to suppress the stale entry
      // from future restore listings.
      if (reason === 'source_occupied') {
        await deps.unlinkFile(op.archive_path);
      }
      const purgeOp = buildArchivePurgeOp({ original_op_id: op.op_id, reason });
      // NEW-C1: fsync the op entry immediately after the mutation succeeds.
      try {
        await writer.writeOp(purgeOp);
      } catch (writeErr) {
        failures.push({
          path: op.archive_path,
          op_id: op.op_id,
          reason: `manifest_write_failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        });
        continue;
      }
      appendedOps.push(purgeOp);
      summary.purgedCount += 1;
      if (reason === 'source_occupied') summary.skippedOccupiedCount += 1;
      else summary.staleFilteredCount += 1;
    } catch (err) {
      failures.push({
        path: op.archive_path,
        op_id: op.op_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // If everything we attempted failed, surface it as Result.err so the
  // CLI can exit non-zero without having to count failures itself.
  if (totalRequested > 0 && failures.length === totalRequested) {
    // Best-effort close without footer (crash-signature: header present, footer absent).
    try {
      await closePurgeManifestWriter(writer, null);
    } catch {
      // ignore close errors on the all-failed path
    }
    return Result.fail(
      new Error(`all ${totalRequested} purge ops failed; see failures[] for per-item reasons`),
    );
  }

  // Close the manifest with a success footer.
  try {
    await closePurgeManifestWriter(writer, { durationMs: writer.elapsedMs });
  } catch (closeErr) {
    // Close failure is non-fatal — mutations + per-op entries already durable.
    failures.push({
      path: manifestPath,
      op_id: 'manifest-close',
      reason: `manifest_close_failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
    });
  }

  return Result.succeed({ summary, failures, manifestPath, appendedOps });
}

// -- In-source unit tests ------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  // Fixture factories ------------------------------------------------

  const archiveOp = (overrides: Partial<ArchiveOp> = {}): ArchiveOp => ({
    op_id: overrides.op_id ?? 'op-archive-1',
    op_type: 'archive',
    timestamp: '2026-04-10T00:00:00Z',
    status: 'completed',
    category: 'skill',
    scope: 'global',
    source_path: '/h/.claude/skills/foo.md',
    archive_path: '/h/.claude/ccaudit/archived/.claude/skills/foo.md',
    content_sha256: 'sha256:abc',
    ...overrides,
  });

  const flagOp = (): ManifestOp => ({
    op_id: 'op-flag-1',
    op_type: 'flag',
    timestamp: '2026-04-10T00:00:00Z',
    status: 'completed',
    file_path: '/h/.claude/CLAUDE.md',
    scope: 'global',
    had_frontmatter: false,
    had_ccaudit_stale: false,
    patched_keys: ['ccaudit-stale'],
    original_content_sha256: 'sha256:x',
  });

  // classifyArchiveOps -----------------------------------------------

  describe('classifyArchiveOps', () => {
    it('source_free + archive_exists → reclaim', async () => {
      const op = archiveOp();
      const fsProbe = async (p: string) => p === op.archive_path;
      const plan = await classifyArchiveOps([op], fsProbe);
      expect(plan.reclaim).toHaveLength(1);
      expect(plan.drop).toHaveLength(0);
      expect(plan.skip).toHaveLength(0);
    });

    it('source_exists + archive_exists → drop/source_occupied', async () => {
      const op = archiveOp();
      const fsProbe = async () => true;
      const plan = await classifyArchiveOps([op], fsProbe);
      expect(plan.drop).toHaveLength(1);
      expect(plan.drop[0]!.reason).toBe('source_occupied');
      expect(plan.reclaim).toHaveLength(0);
    });

    it('source_exists + archive_missing → drop/stale_archive_missing', async () => {
      const op = archiveOp();
      const fsProbe = async (p: string) => p === op.source_path;
      const plan = await classifyArchiveOps([op], fsProbe);
      expect(plan.drop).toHaveLength(1);
      expect(plan.drop[0]!.reason).toBe('stale_archive_missing');
    });

    it('both_missing → skip (preserved for diagnosis)', async () => {
      const op = archiveOp();
      const fsProbe = async () => false;
      const plan = await classifyArchiveOps([op], fsProbe);
      expect(plan.skip).toHaveLength(1);
      expect(plan.skip[0]!.reason).toBe('both_missing');
    });

    it('flag op is ignored (not touched by purge)', async () => {
      const plan = await classifyArchiveOps([flagOp()], async () => true);
      expect(plan.reclaim).toHaveLength(0);
      expect(plan.drop).toHaveLength(0);
      expect(plan.skip).toHaveLength(0);
    });

    it('archive_purge follow-up suppresses original archive op for idempotency', async () => {
      const original = archiveOp({ op_id: 'op-already-purged' });
      const plan = await classifyArchiveOps(
        [
          original,
          {
            op_id: 'purge-1',
            op_type: 'archive_purge',
            timestamp: '2026-04-22T09:01:00.000Z',
            status: 'completed',
            original_op_id: 'op-already-purged',
            purged: true,
            reason: 'stale_archive_missing',
          },
        ],
        async (p) => p === original.source_path,
      );
      expect(plan).toEqual({ reclaim: [], drop: [], skip: [] });
    });

    it('mixed batch classifies each op independently', async () => {
      const reclaimable = archiveOp({
        op_id: 'r',
        archive_path: '/a/r',
        source_path: '/s/r',
      });
      const occupied = archiveOp({
        op_id: 'o',
        archive_path: '/a/o',
        source_path: '/s/o',
      });
      const stale = archiveOp({
        op_id: 's',
        archive_path: '/a/s',
        source_path: '/s/s',
      });
      const broken = archiveOp({
        op_id: 'b',
        archive_path: '/a/b',
        source_path: '/s/b',
      });
      // Per-path probe map
      const existing = new Set(['/a/r', '/a/o', '/s/o', '/s/s']);
      const fsProbe = async (p: string) => existing.has(p);
      const plan = await classifyArchiveOps(
        [reclaimable, occupied, stale, broken, flagOp()],
        fsProbe,
      );
      expect(plan.reclaim.map((i) => i.op.op_id)).toEqual(['r']);
      expect(plan.drop.map((i) => ({ id: i.op.op_id, reason: i.reason }))).toEqual([
        { id: 'o', reason: 'source_occupied' },
        { id: 's', reason: 'stale_archive_missing' },
      ]);
      expect(plan.skip.map((i) => i.op.op_id)).toEqual(['b']);
    });
  });

  // executePurge -----------------------------------------------------

  /** Build a mock ManifestWriter whose writeOp / close methods are vi.fn(). */
  const makeMockWriter = (writeOpImpl?: (op: ManifestOp) => Promise<void>) => {
    const writeOp = vi.fn(writeOpImpl ?? (async () => undefined));
    const close = vi.fn(async () => undefined);
    const writer = {
      writeOp,
      close,
      filePath: '/fake/manifests/purge-test.jsonl',
      elapsedMs: 0,
    } as unknown as ManifestWriter;
    return { writer, writeOp, close };
  };

  const fakeDeps = (overrides: Partial<ExecutePurgeDeps> = {}): ExecutePurgeDeps => {
    const { writer } = makeMockWriter();
    return {
      pathExists: overrides.pathExists ?? (async () => false),
      mkdirRecursive: overrides.mkdirRecursive ?? (async () => undefined),
      renameFile: overrides.renameFile ?? (async () => undefined),
      unlinkFile: overrides.unlinkFile ?? (async () => undefined),
      createPurgeManifestWriter:
        overrides.createPurgeManifestWriter ??
        (async () => ({
          writer,
          path: '/fake/manifests/purge-test.jsonl',
        })),
      ccauditVersion: overrides.ccauditVersion ?? '1.5.0-test',
      now: overrides.now ?? (() => new Date('2026-04-22T12:00:00.000Z')),
    };
  };

  describe('executePurge — dry-run', () => {
    it('dry-run produces summary + writes nothing (no deps called)', async () => {
      const renameFile = vi.fn(async () => undefined);
      const unlinkFile = vi.fn(async () => undefined);
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer: makeMockWriter().writer,
        path: '/x',
      }));
      const plan: PurgePlan = {
        reclaim: [{ op: archiveOp({ op_id: 'r1' }) }],
        drop: [
          { op: archiveOp({ op_id: 'd1' }), reason: 'source_occupied' },
          { op: archiveOp({ op_id: 'd2' }), reason: 'stale_archive_missing' },
        ],
        skip: [{ op: archiveOp({ op_id: 's1' }), reason: 'both_missing' }],
      };
      const result = await executePurge(
        plan,
        fakeDeps({ renameFile, unlinkFile, createPurgeManifestWriter }),
        { dryRun: true },
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.reclaimedCount).toBe(1);
        expect(result.value.summary.purgedCount).toBe(2);
        expect(result.value.summary.skippedOccupiedCount).toBe(1);
        expect(result.value.summary.staleFilteredCount).toBe(1);
        expect(result.value.manifestPath).toBeNull();
        expect(result.value.appendedOps).toHaveLength(0);
      }
      expect(renameFile).not.toHaveBeenCalled();
      expect(unlinkFile).not.toHaveBeenCalled();
      expect(createPurgeManifestWriter).not.toHaveBeenCalled();
    });
  });

  describe('executePurge — real run happy paths', () => {
    it('reclaim: moves archive, appends archive_purge op reason=reclaimed', async () => {
      const op = archiveOp({ op_id: 'r1' });
      const renameFile = vi.fn(async () => undefined);
      const { writer, writeOp } = makeMockWriter();
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer,
        path: '/fake/manifests/purge.jsonl',
      }));
      const plan: PurgePlan = { reclaim: [{ op }], drop: [], skip: [] };
      const result = await executePurge(
        plan,
        fakeDeps({
          // helper re-probes: archive exists, source free
          pathExists: async (p: string) => p === op.archive_path,
          renameFile,
          createPurgeManifestWriter,
        }),
        { dryRun: false },
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.reclaimedCount).toBe(1);
        expect(result.value.appendedOps).toHaveLength(1);
        expect(result.value.appendedOps[0]!.reason).toBe('reclaimed');
        expect(result.value.appendedOps[0]!.original_op_id).toBe('r1');
        expect(result.value.manifestPath).toBe('/fake/manifests/purge.jsonl');
      }
      expect(renameFile).toHaveBeenCalledTimes(1);
      expect(createPurgeManifestWriter).toHaveBeenCalledTimes(1);
      // writeOp called once immediately after the mutation
      expect(writeOp).toHaveBeenCalledTimes(1);
    });

    it('drop/source_occupied: unlinks archive, appends archive_purge', async () => {
      const op = archiveOp({ op_id: 'd1' });
      const unlinkFile = vi.fn(async () => undefined);
      const { writer, writeOp } = makeMockWriter();
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer,
        path: '/fake/manifests/purge.jsonl',
      }));
      const plan: PurgePlan = {
        reclaim: [],
        drop: [{ op, reason: 'source_occupied' }],
        skip: [],
      };
      const result = await executePurge(plan, fakeDeps({ unlinkFile, createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.purgedCount).toBe(1);
        expect(result.value.summary.skippedOccupiedCount).toBe(1);
        expect(result.value.summary.staleFilteredCount).toBe(0);
        expect(result.value.appendedOps[0]!.reason).toBe('source_occupied');
      }
      expect(unlinkFile).toHaveBeenCalledWith(op.archive_path);
      expect(writeOp).toHaveBeenCalledTimes(1);
    });

    it('drop/stale_archive_missing: does NOT unlink (already gone); still writes op', async () => {
      const op = archiveOp({ op_id: 'd-stale' });
      const unlinkFile = vi.fn(async () => undefined);
      const { writer, writeOp } = makeMockWriter();
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer,
        path: '/fake/manifests/purge.jsonl',
      }));
      const plan: PurgePlan = {
        reclaim: [],
        drop: [{ op, reason: 'stale_archive_missing' }],
        skip: [],
      };
      const result = await executePurge(plan, fakeDeps({ unlinkFile, createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.purgedCount).toBe(1);
        expect(result.value.summary.staleFilteredCount).toBe(1);
        expect(result.value.summary.skippedOccupiedCount).toBe(0);
      }
      expect(unlinkFile).not.toHaveBeenCalled();
      // writeOp still called for the stale op so it's suppressed from future listings
      expect(writeOp).toHaveBeenCalledTimes(1);
    });

    it('skip items produce no mutations and no manifest open', async () => {
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer: makeMockWriter().writer,
        path: '/x',
      }));
      const plan: PurgePlan = {
        reclaim: [],
        drop: [],
        skip: [{ op: archiveOp(), reason: 'both_missing' }],
      };
      const result = await executePurge(plan, fakeDeps({ createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.purgedCount).toBe(0);
        expect(result.value.summary.reclaimedCount).toBe(0);
        expect(result.value.manifestPath).toBeNull();
      }
      expect(createPurgeManifestWriter).not.toHaveBeenCalled();
    });
  });

  describe('executePurge — partial failures', () => {
    it('one bad unlink does not abort batch; failures[] records path', async () => {
      const good = archiveOp({
        op_id: 'good',
        archive_path: '/a/good',
        source_path: '/s/good',
      });
      const bad = archiveOp({ op_id: 'bad', archive_path: '/a/bad', source_path: '/s/bad' });
      const unlinkFile = vi.fn(async (p: string) => {
        if (p === '/a/bad') throw new Error('EACCES');
      });
      const { writer } = makeMockWriter();
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer,
        path: '/fake/manifests/purge.jsonl',
      }));
      const plan: PurgePlan = {
        reclaim: [],
        drop: [
          { op: good, reason: 'source_occupied' },
          { op: bad, reason: 'source_occupied' },
        ],
        skip: [],
      };
      const result = await executePurge(plan, fakeDeps({ unlinkFile, createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.purgedCount).toBe(1);
        expect(result.value.failures).toHaveLength(1);
        expect(result.value.failures[0]!.path).toBe('/a/bad');
        expect(result.value.failures[0]!.reason).toContain('EACCES');
        // Manifest still opened and written for the successful op
        expect(result.value.manifestPath).toBe('/fake/manifests/purge.jsonl');
      }
    });

    it('all items failed → Result.err', async () => {
      const unlinkFile = vi.fn(async () => {
        throw new Error('boom');
      });
      const plan: PurgePlan = {
        reclaim: [],
        drop: [{ op: archiveOp({ op_id: 'd1' }), reason: 'source_occupied' }],
        skip: [],
      };
      const result = await executePurge(plan, fakeDeps({ unlinkFile }), { dryRun: false });
      expect(Result.isFailure(result)).toBe(true);
    });

    it('reclaim helper refuses on source_exists → failure captured, batch continues', async () => {
      const op = archiveOp({ op_id: 'r1' });
      const other = archiveOp({ op_id: 'r2', archive_path: '/a/r2', source_path: '/s/r2' });
      // For r1: helper re-probes archive + source → both exist → source_exists failure
      // For r2: archive exists, source free → success
      const pathExists = async (p: string) =>
        p === op.archive_path || p === op.source_path || p === other.archive_path;
      const { writer } = makeMockWriter();
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer,
        path: '/fake/manifests/purge.jsonl',
      }));
      const plan: PurgePlan = { reclaim: [{ op }, { op: other }], drop: [], skip: [] };
      const result = await executePurge(plan, fakeDeps({ pathExists, createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.value.summary.reclaimedCount).toBe(1);
        expect(result.value.failures).toHaveLength(1);
        expect(result.value.failures[0]!.reason).toContain('source');
      }
    });
  });

  describe('executePurge — manifest writer not opened when plan is empty', () => {
    it('zero successes + zero failures (empty plan): createPurgeManifestWriter not called', async () => {
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer: makeMockWriter().writer,
        path: '/x',
      }));
      const plan: PurgePlan = { reclaim: [], drop: [], skip: [] };
      const result = await executePurge(plan, fakeDeps({ createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isSuccess(result)).toBe(true);
      expect(createPurgeManifestWriter).not.toHaveBeenCalled();
    });
  });

  // M6: createPurgeManifestWriter (header-open) throwing must return Result.fail
  // before any disk mutation — because the throw happens BEFORE the loops.
  describe('executePurge — M6: header-open throw returns Result.fail before any mutation', () => {
    it('createPurgeManifestWriter throws → Result.isFailure, zero mutations', async () => {
      const op = archiveOp({ op_id: 'd1' });
      const unlinkFile = vi.fn(async () => undefined);
      const plan: PurgePlan = {
        reclaim: [],
        drop: [{ op, reason: 'source_occupied' }],
        skip: [],
      };
      const createPurgeManifestWriter = vi.fn(async () => {
        throw new Error('disk full');
      });
      const result = await executePurge(plan, fakeDeps({ unlinkFile, createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.message).toContain('disk full');
      }
      // No mutations because the open failed before the loops
      expect(unlinkFile).not.toHaveBeenCalled();
    });

    it('createPurgeManifestWriter rejects with a non-Error value → Result.fail wraps it', async () => {
      const op = archiveOp({ op_id: 'd2' });
      const plan: PurgePlan = {
        reclaim: [],
        drop: [{ op, reason: 'stale_archive_missing' }],
        skip: [],
      };
      const createPurgeManifestWriter = vi.fn(
        () =>
          Promise.reject('write error string') as Promise<{
            writer: ManifestWriter;
            path: string;
          }>,
      );
      const result = await executePurge(plan, fakeDeps({ createPurgeManifestWriter }), {
        dryRun: false,
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.message).toContain('write error string');
      }
    });
  });

  // NEW-C1: per-op manifest fsync semantics
  describe('executePurge — NEW-C1: per-op manifest fsync', () => {
    it('mid-batch writeOp throw leaves prior successful ops persisted in memory; mutation still completes', async () => {
      // 3 drop ops; writeOp throws on the 3rd call
      const ops = [
        archiveOp({ op_id: 'drop-1', archive_path: '/a/1', source_path: '/s/1' }),
        archiveOp({ op_id: 'drop-2', archive_path: '/a/2', source_path: '/s/2' }),
        archiveOp({ op_id: 'drop-3', archive_path: '/a/3', source_path: '/s/3' }),
      ];
      const unlinkFile = vi.fn(async () => undefined);

      let writeOpCallCount = 0;
      const writeOpFn = vi.fn(async () => {
        writeOpCallCount += 1;
        if (writeOpCallCount === 3) throw new Error('ENOSPC');
      });
      const closeFn = vi.fn(async () => undefined);
      const mockWriter = {
        writeOp: writeOpFn,
        close: closeFn,
        filePath: '/fake/manifests/purge-newc1.jsonl',
        elapsedMs: 0,
      } as unknown as ManifestWriter;

      const createPurgeManifestWriter = vi.fn(async () => ({
        writer: mockWriter,
        path: '/fake/manifests/purge-newc1.jsonl',
      }));

      const plan: PurgePlan = {
        reclaim: [],
        drop: ops.map((op) => ({ op, reason: 'source_occupied' as DropReason })),
        skip: [],
      };

      const result = await executePurge(plan, fakeDeps({ unlinkFile, createPurgeManifestWriter }), {
        dryRun: false,
      });

      // All 3 unlinks were attempted (mutation loop continues after writeOp failure)
      expect(unlinkFile).toHaveBeenCalledTimes(3);
      // writeOp was called 3 times (once per successful unlink)
      expect(writeOpFn).toHaveBeenCalledTimes(3);

      // Result is success (2 out of 3 succeeded)
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        // In-memory appendedOps only includes the 2 that wrote successfully
        expect(result.value.appendedOps).toHaveLength(2);
        // The 3rd op failure is recorded in failures[]
        expect(result.value.failures).toHaveLength(1);
        expect(result.value.failures[0]!.op_id).toBe('drop-3');
        expect(result.value.failures[0]!.reason).toContain('manifest_write_failed');
      }
    });

    it('header-open throw before any mutation leaves disk untouched', async () => {
      const unlinkFile = vi.fn(async () => undefined);
      const renameFile = vi.fn(async () => undefined);
      const createPurgeManifestWriter = vi.fn(async () => {
        throw new Error('EACCES: permission denied');
      });

      const plan: PurgePlan = {
        reclaim: [{ op: archiveOp({ op_id: 'r1' }) }],
        drop: [{ op: archiveOp({ op_id: 'd1' }), reason: 'source_occupied' }],
        skip: [],
      };

      const result = await executePurge(
        plan,
        fakeDeps({ unlinkFile, renameFile, createPurgeManifestWriter }),
        { dryRun: false },
      );

      // Zero mutations because open failed before any loop
      expect(unlinkFile).not.toHaveBeenCalled();
      expect(renameFile).not.toHaveBeenCalled();
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.message).toContain('EACCES');
      }
    });

    it('empty plan does not open the writer (no orphan empty manifest file)', async () => {
      const createPurgeManifestWriter = vi.fn(async () => ({
        writer: makeMockWriter().writer,
        path: '/fake/manifests/purge-should-not-exist.jsonl',
      }));

      const plan: PurgePlan = { reclaim: [], drop: [], skip: [] };

      const result = await executePurge(plan, fakeDeps({ createPurgeManifestWriter }), {
        dryRun: false,
      });

      expect(Result.isSuccess(result)).toBe(true);
      // createPurgeManifestWriter must NOT have been called
      expect(createPurgeManifestWriter).not.toHaveBeenCalled();
      if (Result.isSuccess(result)) {
        expect(result.value.manifestPath).toBeNull();
        expect(result.value.appendedOps).toHaveLength(0);
      }
    });
  });
}
