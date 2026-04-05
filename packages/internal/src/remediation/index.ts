// @ccaudit/internal -- remediation module (Phase 7 + Phase 8)
// Pure functions + checkpoint I/O for --dry-run and --dangerously-bust-ghosts.

export { buildChangePlan } from './change-plan.ts';
export type { ChangePlan, ChangePlanItem, ChangePlanAction } from './change-plan.ts';

export { calculateDryRunSavings } from './savings.ts';

export { computeGhostHash, resolveCheckpointPath, writeCheckpoint, readCheckpoint } from './checkpoint.ts';
export type { Checkpoint, ReadCheckpointResult, StatFn } from './checkpoint.ts';

// Phase 8: atomic write primitive (D-18 extraction, reused by bust orchestrator)
export { atomicWriteJson, renameWithRetry } from './atomic-write.ts';
export type { AtomicWriteOptions } from './atomic-write.ts';
