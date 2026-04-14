/**
 * Output mode resolution and JSON envelope builder.
 *
 * Resolves CLI flag combinations into a unified OutputMode object.
 * Handles --ci sugar (implies --json --quiet), conflict resolution
 * (json wins over csv, quiet wins over verbose), and JSON meta envelope.
 */

import { CCAUDIT_VERSION } from '../_version.ts';

export interface OutputMode {
  json: boolean;
  csv: boolean;
  quiet: boolean;
  verbose: boolean;
  privacy: boolean;
  /** True by default; false when --no-group-frameworks is set. Controls framework-grouping display + JSON envelope (D-22). */
  groupFrameworks: boolean;
}

/**
 * Resolve CLI flag values into a unified output mode.
 *
 * Rules:
 * - --ci implies --json --quiet (per D-14)
 * - If both json and csv are true, json wins (csv ignored)
 * - If both verbose and quiet are true, quiet wins (verbose becomes false)
 */
export function resolveOutputMode(values: {
  ci?: boolean;
  json?: boolean;
  csv?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  privacy?: boolean;
  noGroupFrameworks?: boolean;
}): OutputMode {
  let json = values.json ?? false;
  let csv = values.csv ?? false;
  let quiet = values.quiet ?? false;
  let verbose = values.verbose ?? false;
  const privacy = values.privacy ?? false;

  // --ci is sugar for --json --quiet
  if (values.ci) {
    json = true;
    quiet = true;
  }

  // json wins over csv
  if (json && csv) {
    csv = false;
  }

  // quiet wins over verbose
  if (quiet && verbose) {
    verbose = false;
  }

  const groupFrameworks = !(values.noGroupFrameworks ?? false);

  return { json, csv, quiet, verbose, privacy, groupFrameworks };
}

/**
 * Wrap command-specific data with a standardized JSON meta envelope.
 * Per D-16: every command's JSON output includes meta with command, version,
 * since, timestamp, and exitCode.
 */
export function buildJsonEnvelope<T extends Record<string, unknown>>(
  command: string,
  since: string,
  exitCode: number,
  data: T,
  extraMeta?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    meta: {
      ...extraMeta,
      command,
      version: CCAUDIT_VERSION,
      since,
      timestamp: new Date().toISOString(),
      exitCode,
    },
    ...data,
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('resolveOutputMode', () => {
    it('returns default mode (groupFrameworks=true) for empty values', () => {
      expect(resolveOutputMode({})).toEqual({
        json: false,
        csv: false,
        quiet: false,
        verbose: false,
        privacy: false,
        groupFrameworks: true,
      });
    });

    it('--privacy sets privacy=true', () => {
      const mode = resolveOutputMode({ privacy: true });
      expect(mode.privacy).toBe(true);
    });

    it('--ci sets json=true and quiet=true', () => {
      const mode = resolveOutputMode({ ci: true });
      expect(mode.json).toBe(true);
      expect(mode.quiet).toBe(true);
      expect(mode.csv).toBe(false);
      expect(mode.verbose).toBe(false);
    });

    it('--json and --verbose passes through', () => {
      const mode = resolveOutputMode({ json: true, verbose: true });
      expect(mode.json).toBe(true);
      expect(mode.quiet).toBe(false);
      expect(mode.csv).toBe(false);
      expect(mode.verbose).toBe(true);
    });

    it('--verbose --quiet: quiet wins, verbose becomes false', () => {
      const mode = resolveOutputMode({ verbose: true, quiet: true });
      expect(mode.quiet).toBe(true);
      expect(mode.verbose).toBe(false);
    });

    it('--ci --csv: json wins, csv ignored', () => {
      const mode = resolveOutputMode({ ci: true, csv: true });
      expect(mode.json).toBe(true);
      expect(mode.csv).toBe(false);
    });

    it('groupFrameworks defaults to true when noGroupFrameworks is not set', () => {
      expect(resolveOutputMode({}).groupFrameworks).toBe(true);
    });

    it('--no-group-frameworks sets groupFrameworks=false', () => {
      expect(resolveOutputMode({ noGroupFrameworks: true }).groupFrameworks).toBe(false);
    });

    it('groupFrameworks=false coexists with --json', () => {
      const mode = resolveOutputMode({ json: true, noGroupFrameworks: true });
      expect(mode.json).toBe(true);
      expect(mode.groupFrameworks).toBe(false);
    });

    it('groupFrameworks=false coexists with --ci (json + quiet)', () => {
      const mode = resolveOutputMode({ ci: true, noGroupFrameworks: true });
      expect(mode.json).toBe(true);
      expect(mode.quiet).toBe(true);
      expect(mode.groupFrameworks).toBe(false);
    });
  });

  describe('buildJsonEnvelope', () => {
    it('wraps data with meta envelope', () => {
      const data = { items: [1, 2, 3] };
      const envelope = buildJsonEnvelope('ghost', '7d', 1, data);
      expect(envelope).toHaveProperty('meta');
      expect(envelope).toHaveProperty('items');
      const meta = envelope.meta as Record<string, unknown>;
      expect(meta.command).toBe('ghost');
      expect(meta.since).toBe('7d');
      expect(meta.exitCode).toBe(1);
    });

    it('meta includes version as string', () => {
      const envelope = buildJsonEnvelope('ghost', '7d', 0, {});
      const meta = envelope.meta as Record<string, unknown>;
      expect(typeof meta.version).toBe('string');
    });

    it('meta includes timestamp as ISO 8601 string', () => {
      const envelope = buildJsonEnvelope('ghost', '7d', 0, {});
      const meta = envelope.meta as Record<string, unknown>;
      expect(typeof meta.timestamp).toBe('string');
      // ISO 8601 format check: YYYY-MM-DDTHH:mm:ss
      expect(meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('extraMeta fields merge into meta (not top-level)', () => {
      const envelope = buildJsonEnvelope(
        'ghost',
        '7d',
        0,
        { items: [1] },
        {
          mcpRegime: 'deferred',
          toolSearchOverhead: 1700,
        },
      );
      const meta = envelope.meta as Record<string, unknown>;
      expect(meta.mcpRegime).toBe('deferred');
      expect(meta.toolSearchOverhead).toBe(1700);
      expect(envelope.mcpRegime).toBeUndefined();
      expect(envelope.toolSearchOverhead).toBeUndefined();
      expect(envelope.items).toEqual([1]);
    });

    it('omitted extraMeta leaves meta unchanged', () => {
      const envelope = buildJsonEnvelope('ghost', '7d', 0, {});
      const meta = envelope.meta as Record<string, unknown>;
      expect(Object.keys(meta).sort()).toEqual([
        'command',
        'exitCode',
        'since',
        'timestamp',
        'version',
      ]);
    });

    it('extraMeta cannot override canonical meta fields', () => {
      const envelope = buildJsonEnvelope(
        'ghost',
        '7d',
        0,
        {},
        {
          command: 'evil',
          version: '0.0.0',
          exitCode: 99,
        },
      );
      const meta = envelope.meta as Record<string, unknown>;
      expect(meta.command).toBe('ghost');
      expect(meta.version).not.toBe('0.0.0');
      expect(meta.exitCode).toBe(0);
    });
  });
}
