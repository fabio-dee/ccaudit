/**
 * Type definitions for the append-only history.jsonl audit trail (Phase 6).
 *
 * Schema version: 1 (hard constant — future readers must refuse > 1).
 *
 * File format: JSONL (one JSON object per line).
 * - Line 1 of a new file: HistoryHeader
 * - Each subsequent line: HistoryEntry
 *
 * Concurrent writes: two ccaudit processes appending simultaneously are
 * handled best-effort using POSIX 'a' mode (atomic for short writes on
 * most POSIX filesystems). No file locking is implemented in v1.
 */

// ── Header ────────────────────────────────────────────────────────

/**
 * Written exactly once per history.jsonl, as the first record.
 * Identifies the file version and the environment that created it.
 */
export interface HistoryHeader {
  record_type: 'header';
  history_version: 1;
  ccaudit_version: string;
  created_at: string; // ISO 8601
  host_os: string; // os.platform() value e.g. 'darwin', 'linux', 'win32'
  node_version: string; // process.version e.g. 'v22.0.0'
}

// ── Per-command result shapes ─────────────────────────────────────

/** ghost / inventory command result */
export interface GhostResult {
  totals: Record<string, number>;
  top_ghosts: string[];
}

/** dry-run command result */
export interface DryRunResult {
  planned_archive: number;
  planned_disable: number;
  planned_flag: number;
  checkpoint_hash: string | null;
}

/** bust command result -- discriminated on status */
export type BustResult =
  | {
      status: 'success';
      before_tokens: number;
      after_tokens: number;
      freed_tokens: number;
      archived_agents: number;
      archived_skills: number;
      disabled_mcp: number;
      flagged_memory: number;
      manifest_ref: string | null;
      health_before: string | null;
      health_after: string | null;
    }
  | {
      /** Non-success bust: only the status string is recorded. */
      status: Exclude<string, 'success'>;
    };

/** restore command result */
export interface RestoreResult {
  moved: number;
  already_at_source: number;
  failed: number;
  manifests_consumed: string[];
}

/** reclaim command result */
export interface ReclaimResult {
  orphans_detected: number;
  reclaimed: number;
  skipped: number;
}

/** Generic fallback for commands that don't produce structured result data */
export type GenericResult = Record<string, unknown> | null;

/** Union of all command-specific result shapes */
export type CommandResult =
  | GhostResult
  | DryRunResult
  | BustResult
  | RestoreResult
  | ReclaimResult
  | GenericResult;

// ── Entry ─────────────────────────────────────────────────────────

/**
 * One record per ccaudit invocation, appended after the header.
 */
export interface HistoryEntry {
  record_type: 'entry';
  /** ISO 8601 timestamp of invocation start */
  ts: string;
  /** Raw argv passed by the user (process.argv.slice(2)) */
  argv: string[];
  /** Normalized command name (e.g., 'ghost', 'bust', 'restore', 'reclaim', 'dry-run') */
  command: string;
  /** Process exit code at the end of the command */
  exit_code: number;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Working directory at invocation time (redacted if privacy mode) */
  cwd: string;
  /** True when --privacy was active and path fields are synthetic */
  privacy_redacted: boolean;
  /** Optional: sha256 hash over the ghost inventory seen by this command */
  ghost_inventory_hash?: string;
  /** Command-specific structured result. null on commands that produce no data (e.g., list) */
  result: CommandResult;
  /** Any errors encountered during execution (non-fatal warnings excluded) */
  errors: string[];
}

// ── Union ─────────────────────────────────────────────────────────

export type HistoryRecord = HistoryHeader | HistoryEntry;
