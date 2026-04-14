/**
 * History module barrel (Phase 6).
 * Append-only audit trail for ccaudit invocations.
 */

export { HistoryWriter } from './writer.ts';
export { recordHistory } from './record.ts';
export type {
  HistoryHeader,
  HistoryEntry,
  HistoryRecord,
  CommandResult,
  GhostResult,
  DryRunResult,
  BustResult as HistoryBustResult,
  RestoreResult as HistoryRestoreResult,
  ReclaimResult as HistoryReclaimResult,
  GenericResult,
} from './types.ts';
export type { RecordHistoryOpts } from './record.ts';
