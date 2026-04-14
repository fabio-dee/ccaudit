/**
 * recordHistory() — high-level wrapper for appending one entry to history.jsonl.
 *
 * Design constraints (Phase 6):
 *  - NEVER crash the caller's main command on history write failure.
 *    All errors are caught and emitted as a single stderr warning.
 *  - CCAUDIT_NO_HISTORY=1 short-circuits BEFORE any filesystem work.
 *    No directory is created; the opt-out is checked first.
 *  - Header is written once per file (when the file is new or empty).
 *  - Privacy redaction: when privacy is active, apply the redactionMap
 *    recursively across all string-valued fields in result + cwd.
 *  - Rotation advisory: if file size exceeds 10 MB, emit a once-per-session
 *    stderr advisory suggesting manual archival.
 *  - Append-only: NEVER truncate or rewrite history.jsonl.
 *
 * Schema version: HistoryHeader.history_version = 1 (hard constant).
 * Future readers must refuse history_version > 1.
 */

import { platform as osPlatform } from 'node:os';
import path from 'node:path';
import { HistoryWriter } from './writer.ts';
import type { CommandResult, HistoryHeader, HistoryEntry } from './types.ts';

// ── Module-level state (once-per-session advisory) ────────────────

/** Set to true once the 10 MB advisory has been emitted this session. */
let _rotationAdvisoryEmitted = false;

/** For testing: reset the advisory flag. Not exported from barrel. */
export function _resetRotationAdvisory(): void {
  _rotationAdvisoryEmitted = false;
}

// ── Options ───────────────────────────────────────────────────────

export interface RecordHistoryOpts {
  /**
   * Absolute path to the home directory. Used to resolve the history file
   * path: <homeDir>/.claude/ccaudit/history.jsonl
   */
  homeDir: string;
  /** Normalized command name (e.g., 'ghost', 'bust', 'restore', 'reclaim', 'dry-run'). */
  command: string;
  /** Raw argv (process.argv.slice(2) or equivalent). */
  argv: string[];
  /** Exit code the command is about to return. */
  exitCode: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Working directory at invocation time (process.cwd()). */
  cwd: string;
  /** Whether --privacy was active. */
  privacy: boolean;
  /**
   * Redaction map from buildRedactionMap(). Required when privacy is true.
   * Maps real project paths to synthetic labels (e.g. ~/projects/project-01).
   */
  redactionMap?: Map<string, string> | null;
  /** Command-specific structured result. null is valid. */
  result: CommandResult;
  /** Non-fatal errors to record. Default []. */
  errors?: string[];
  /** ccaudit version string (CCAUDIT_VERSION from _version.ts). */
  ccauditVersion: string;
}

// ── Privacy redaction ─────────────────────────────────────────────

/**
 * Recursively walk an arbitrary value and replace any string that contains
 * a key from redactionMap with the synthetic label.
 *
 * This handles unexpected path-shaped fields in result shapes without
 * needing to enumerate every field name by hand.
 */
function applyRedactionMap(value: unknown, redactionMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const [real, synthetic] of redactionMap) {
      if (s.includes(real)) {
        s = s.replaceAll(real, synthetic);
      }
    }
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyRedactionMap(item, redactionMap));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyRedactionMap(v, redactionMap);
    }
    return out;
  }
  return value;
}

/**
 * Redact cwd when no redaction map is available (full --privacy path):
 * replace any substring matching homeDir with ~/
 *
 * On macOS, tmpdir paths may be returned as /var/... (symlink) by mkdtemp but
 * process.cwd() resolves the symlink to /private/var/... . We check both the
 * raw homeDir and any prefix it shares with cwd to handle this.
 */
function redactCwdFallback(cwd: string, homeDir: string): string {
  if (cwd.startsWith(homeDir)) {
    return '~' + cwd.slice(homeDir.length);
  }
  // Try replacing anywhere in the path (handles /private prefix symlink on macOS).
  if (cwd.includes(homeDir)) {
    return cwd.replaceAll(homeDir, '~');
  }
  return cwd;
}

// ── Main API ──────────────────────────────────────────────────────

/**
 * Append one HistoryEntry to ~/.claude/ccaudit/history.jsonl.
 *
 * Safe to call from any command's finally block: any error during the write
 * is caught and emitted as a single stderr warning; the caller is unaffected.
 *
 * Short-circuits immediately (no FS work) when CCAUDIT_NO_HISTORY=1.
 */
export async function recordHistory(opts: RecordHistoryOpts): Promise<void> {
  // Opt-out: check BEFORE any filesystem work.
  if (process.env.CCAUDIT_NO_HISTORY === '1') {
    return;
  }

  try {
    const historyPath = path.join(opts.homeDir, '.claude', 'ccaudit', 'history.jsonl');

    // Apply privacy redaction.
    let redactedCwd = opts.cwd;
    let redactedResult = opts.result;

    if (opts.privacy) {
      if (opts.redactionMap && opts.redactionMap.size > 0) {
        redactedCwd = applyRedactionMap(opts.cwd, opts.redactionMap) as string;
        redactedResult = applyRedactionMap(opts.result, opts.redactionMap) as CommandResult;
      } else {
        // No project paths to redact, but still replace the homeDir prefix.
        redactedCwd = redactCwdFallback(opts.cwd, opts.homeDir);
      }
    }

    const writer = new HistoryWriter(historyPath);
    let fileSize: number;
    try {
      fileSize = await writer.open();
    } catch (openErr) {
      process.stderr.write(
        `[ccaudit] history: could not open history.jsonl for append: ${String(openErr)}\n`,
      );
      return;
    }

    try {
      // Rotation advisory (once per session).
      const TEN_MB = 10 * 1024 * 1024;
      if (fileSize > TEN_MB && !_rotationAdvisoryEmitted) {
        _rotationAdvisoryEmitted = true;
        process.stderr.write(
          `\u2139\uFE0F  ccaudit history.jsonl is >10 MB; archive it with: mv ~/.claude/ccaudit/history.jsonl{,.$(date +%Y%m%d).bak}\n`,
        );
      }

      // Write header if file is new or empty.
      if (fileSize === 0) {
        const header: HistoryHeader = {
          record_type: 'header',
          history_version: 1,
          ccaudit_version: opts.ccauditVersion,
          created_at: new Date().toISOString(),
          host_os: osPlatform(),
          node_version: process.version,
        };
        await writer.append(header);
      }

      // Write the entry.
      const entry: HistoryEntry = {
        record_type: 'entry',
        ts: new Date().toISOString(),
        argv: opts.argv,
        command: opts.command,
        exit_code: opts.exitCode,
        duration_ms: Math.round(opts.durationMs),
        cwd: redactedCwd,
        privacy_redacted: opts.privacy,
        result: redactedResult,
        errors: opts.errors ?? [],
      };
      await writer.append(entry);
    } finally {
      await writer.close();
    }
  } catch (err) {
    // Never propagate — history must never crash the main command.
    process.stderr.write(`[ccaudit] history: write failed (non-fatal): ${String(err)}\n`);
  }
}
