// @ccaudit/internal -- remediation module (Phase 7 + Phase 8)
// Pure functions + checkpoint I/O for --dry-run and --dangerously-bust-ghosts.

export { buildChangePlan, filterChangePlan } from './change-plan.ts';
export type { ChangePlan, ChangePlanItem, ChangePlanAction } from './change-plan.ts';

export { calculateDryRunSavings } from './savings.ts';

export {
  canonicalItemId,
  computeGhostHash,
  resolveCheckpointPath,
  writeCheckpoint,
  readCheckpoint,
} from './checkpoint.ts';
export type { Checkpoint, ReadCheckpointResult, StatFn, CanonicalItemInput } from './checkpoint.ts';

// Phase 8: atomic write primitive (D-18 extraction, reused by bust orchestrator)
export { atomicWriteJson, atomicWriteText, renameWithRetry } from './atomic-write.ts';
export type { AtomicWriteOptions } from './atomic-write.ts';

// Phase 8: collision helpers (D-05, D-06) + nested-path-preserving archive builder
export {
  timestampSuffixForFilename,
  timestampSuffixForJsonKey,
  buildArchivePath,
  buildDisabledMcpKey,
} from './collisions.ts';

// Phase 8: running-process detection for --dangerously-bust-ghosts preflight
// (D-02 spawn ps/tasklist, D-03 exit code 3 on detection, D-04 self-invocation)
export {
  detectClaudeProcesses,
  walkParentChain,
  parsePsComm,
  parseTasklistCsv,
  CLAUDE_NAME_REGEX,
} from './processes.ts';
export type { ClaudeProcess, DetectResult, ProcessDetectorDeps } from './processes.ts';

// Alias re-export: the default ProcessDetectorDeps implementation used by the
// Phase 8 CLI wiring (Plan 08-06). Renamed to `defaultProcessDeps` at the
// barrel so callers don't need a `defaultDeps` symbol name collision with
// other future modules.
export { defaultDeps as defaultProcessDeps } from './processes.ts';

// Phase 8: hand-rolled YAML frontmatter patcher for memory-file flagging
// (D-07 idempotent refresh, D-08 three-case handling: prepend / inject / skip)
export { patchFrontmatter } from './frontmatter.ts';
export type { FrontmatterPatchResult } from './frontmatter.ts';

// Phase 9 Plan 02: restore helpers for stripping/updating ccaudit frontmatter keys
export { removeFrontmatterKeys, setFrontmatterValue } from './frontmatter.ts';
export type { FrontmatterRemoveResult } from './frontmatter.ts';

// Phase 8: JSONL restore manifest writer + reader (D-09 / D-10 / D-11 / D-12)
// Append-only, fsync-per-op, header+footer bracket, crash-tolerant reader.
export {
  ManifestWriter,
  resolveManifestPath,
  readManifest,
  buildHeader,
  buildFooter,
  buildArchiveOp,
  buildDisableOp,
  buildFlagOp,
  buildRefreshOp,
  buildSkippedOp,
  buildArchivePurgeOp,
  buildPurgeManifestHeader,
  resolvePurgeManifestPath,
  writePurgeManifest,
  openPurgeManifestWriter,
  closePurgeManifestWriter,
  MANIFEST_VERSION,
} from './manifest.ts';
export type {
  ManifestHeader,
  ManifestFooter,
  ManifestOp,
  ManifestRecord,
  ArchiveOp,
  DisableOp,
  FlagOp,
  RefreshOp,
  SkippedOp,
  ArchivePurgeOp,
  ReadManifestResult,
  SelectionFilter,
} from './manifest.ts';

// Phase 8: bust orchestrator -- the Wave 1 pipeline that wires Wave 0
// primitives into the full --dangerously-bust-ghosts flow (D-01..D-18).
//
// NOTE: `patchMcpConfigText` is exported from bust.ts with `export function`
// solely to enable in-source unit tests (the vitest block at the bottom of
// bust.ts) — it is intentionally NOT re-exported here. External callers
// (e.g. restore.ts) should NOT import it directly from the subpath; if a
// future use case requires it, promote it to this barrel with a clear API
// contract first.
export { runBust, runConfirmationCeremony } from './bust.ts';
export type { BustResult, BustDeps, BustCounts, CeremonyResult, CeremonyIO } from './bust.ts';

// Phase 9: manifest discovery + restore orchestrator (D-01..D-15)
// Plan 01 delivers the scaffold: discover manifests + restore skeleton.
// Plan 02 wires the real op executors (unarchive, re-enable MCP, strip flags).
export {
  executeRestore,
  findManifestsForRestore,
  findManifestForName,
  extractServerName,
  restoreArchiveOp,
  reEnableMcpTransactional,
  restoreFlagOp,
  restoreRefreshOp,
  dedupManifestOps,
  collectRestoreableItems,
  matchByName,
  isStaleArchiveOp,
  filterRestoreableItems,
} from './restore.ts';
export type {
  RestoreDeps,
  RestoreResult,
  RestoreCounts,
  RestoreMode,
  ManifestListEntry,
  RestoreableOp,
} from './restore.ts';
export { discoverManifests, resolveManifestDir } from './manifest.ts';
export type { ManifestEntry, DiscoverManifestsDeps } from './manifest.ts';

// Phase 9 SC6: purge-archive domain core (classifier + executor).
// CLI subcommand is wired in Plan 09-04; this barrel re-export covers the
// pure-domain surface consumed by that wrapper.
export { classifyArchiveOps, executePurge } from './purge.ts';
export type {
  PurgePlan,
  PurgeResult,
  PurgeSummary,
  PurgeFailure,
  DropReason,
  ExecutePurgeDeps,
} from './purge.ts';

// Shared archive→source move helper (lifted from reclaim.ts for purge reuse).
export { moveArchiveToSource } from './archive-move.ts';
export type { ArchiveMoveDeps, MoveArchiveInput, MoveArchiveFailure } from './archive-move.ts';

// Phase 4: orphan reclaim command
export { reclaim } from './reclaim.ts';
export type {
  ReclaimOptions,
  ReclaimResult,
  ReclaimDeps,
  DirEntry,
  OrphanEntry,
} from './reclaim.ts';

// v1.3.0 Phase 4: framework-as-unit bust protection helper.
// Pure synchronous filter — runs at the CLI layer in BOTH the dry-run path
// and the bust path so checkpoint hashes stay stable. bust.ts is NOT touched.
export { applyFrameworkProtection } from './framework-bust.ts';
export type {
  FrameworkBustOptions,
  FrameworkBustResult,
  ProtectedFrameworkWarning,
} from './framework-bust.ts';
