// @ccaudit/internal -- JSONL restore manifest writer (Phase 8 D-09 / D-10 / D-11 / D-12)
//
// Append-only JSONL restore manifest for --dangerously-bust-ghosts. Every
// operation the bust orchestrator executes is recorded as one JSON object per
// line, fsynced after every append (D-09), so the manifest survives
// crash-at-any-point with at most one truncated trailing line.
//
// File layout (D-10, D-12):
//   line 1               header record (manifest_version, ccaudit_version,
//                        checkpoint_ghost_hash, planned_ops, ...)
//   lines 2..N-1         one op record per line (archive / disable / flag /
//                        refresh / skipped per D-11 discriminated union)
//   line N (optional)    footer record -- written ONLY on successful bust
//                        completion. Phase 9 detects "header present + footer
//                        absent" as a partial bust and warns before restoring
//                        what was recorded.
//
// Path: ~/.claude/ccaudit/manifests/bust-<iso-dashed>.jsonl
// Mode: 0o600 (file), 0o700 (directory)
// Zero runtime deps -- uses only node:fs/promises, node:path, node:os,
// node:crypto and the local collisions.ts helper.

import { open, mkdir, chmod, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// -- Header type (D-12) ------------------------------------------

export const MANIFEST_VERSION = 1 as const;

/**
 * Discriminated union describing the selection scope of a bust manifest.
 * Written by buildHeader into every manifest; read by restore (Phase 8) and
 * auditors to distinguish full-inventory busts from subset busts.
 *
 * - `{ mode: 'full' }` — full-inventory bust (selectedItems === undefined)
 * - `{ mode: 'subset', ids: string[] }` — subset bust; ids are the
 *   canonicalItemId values of the selected items, sorted ascending so
 *   manifests diff deterministically.
 */
export type SelectionFilter = { mode: 'full' } | { mode: 'subset'; ids: string[] };

export interface ManifestHeader {
  record_type: 'header';
  manifest_version: typeof MANIFEST_VERSION;
  ccaudit_version: string;
  checkpoint_ghost_hash: string;
  checkpoint_timestamp: string;
  since_window: string;
  os: NodeJS.Platform;
  node_version: string;
  planned_ops: { archive: number; disable: number; flag: number };
  /**
   * Optional on reads (old manifests lack this field; default to { mode: 'full' }).
   * Always present on writes — buildHeader always sets it.
   */
  selection_filter?: SelectionFilter;
}

// -- Op types (D-11) ---------------------------------------------

export interface ArchiveOp {
  op_id: string;
  op_type: 'archive';
  timestamp: string;
  status: 'completed' | 'failed';
  error?: string;
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  source_path: string;
  archive_path: string;
  content_sha256: string;
}

export interface DisableOp {
  op_id: string;
  op_type: 'disable';
  timestamp: string;
  status: 'completed' | 'failed';
  error?: string;
  config_path: string;
  scope: 'global' | 'project';
  project_path: string | null;
  original_key: string;
  new_key: string;
  original_value: unknown;
}

export interface FlagOp {
  op_id: string;
  op_type: 'flag';
  timestamp: string;
  status: 'completed' | 'failed';
  error?: string;
  file_path: string;
  scope: 'global' | 'project';
  had_frontmatter: boolean;
  had_ccaudit_stale: boolean;
  patched_keys: ReadonlyArray<'ccaudit-stale' | 'ccaudit-flagged'>;
  original_content_sha256: string;
}

export interface RefreshOp {
  op_id: string;
  op_type: 'refresh';
  timestamp: string;
  status: 'completed' | 'failed';
  error?: string;
  file_path: string;
  scope: 'global' | 'project';
  previous_flagged_at: string;
}

export interface SkippedOp {
  op_id: string;
  op_type: 'skipped';
  timestamp: string;
  status: 'completed';
  file_path: string;
  category: 'agent' | 'skill' | 'memory' | 'mcp';
  reason: string;
}

export type ManifestOp = ArchiveOp | DisableOp | FlagOp | RefreshOp | SkippedOp;

// -- Footer type (D-12) ------------------------------------------

export interface ManifestFooter {
  record_type: 'footer';
  status: 'completed';
  actual_ops: {
    archive: { completed: number; failed: number };
    disable: { completed: number; failed: number };
    flag: { completed: number; failed: number; refreshed: number; skipped: number };
  };
  duration_ms: number;
  exit_code: number;
}

export type ManifestRecord = ManifestHeader | ManifestOp | ManifestFooter;

// -- Reader result ------------------------------------------------

export interface ReadManifestResult {
  header: ManifestHeader | null;
  ops: ManifestOp[];
  footer: ManifestFooter | null;
  truncated: boolean;
}

// -- Path resolver (D-10) -----------------------------------------

/**
 * Resolve the canonical manifest path for a new bust (D-10).
 *
 * Per-bust file keyed by UTC ISO timestamp (millisecond precision) with colons
 * and periods replaced by dashes for cross-platform filesystem safety (NTFS
 * forbids `:` in filenames), plus a 4-character random base-36 suffix to make
 * same-millisecond collisions vanishingly unlikely.
 *
 * Format: bust-<yyyy-MM-ddTHH-mm-ss-SSSZ>-<rand4>.jsonl
 *
 * The `bust-` prefix and `.jsonl` suffix are unchanged so `discoverManifests`
 * continues to find both old-format (second-granularity) and new-format
 * manifests transparently — the filter only checks `bust-*.jsonl`.
 *
 * @example
 *   resolveManifestPath(new Date('2026-04-05T18:30:00.123Z'))
 *   // -> '~/.claude/ccaudit/manifests/bust-2026-04-05T18-30-00-123Z-<rand>.jsonl'
 */
export function resolveManifestPath(now: Date = new Date()): string {
  // Millisecond-precision timestamp: keep ms digits, replace `:` and `.` with `-`
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return path.join(homedir(), '.claude', 'ccaudit', 'manifests', `bust-${stamp}-${rand}.jsonl`);
}

// -- Manifest discovery (Phase 9) --------------------------------

/**
 * Resolve the canonical manifests directory path.
 *
 * @returns ~/.claude/ccaudit/manifests
 */
export function resolveManifestDir(): string {
  return path.join(homedir(), '.claude', 'ccaudit', 'manifests');
}

/**
 * A discovered manifest entry with its filesystem metadata.
 */
export interface ManifestEntry {
  path: string;
  mtime: Date;
}

/**
 * Injectable deps for discoverManifests() -- Phase 7 D-17 StatFn precedent.
 * Using injected readdir + stat instead of direct node:fs/promises imports
 * enables unit tests without vi.mock (ESM module namespace non-configurable).
 */
export interface DiscoverManifestsDeps {
  readdir: (dir: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ mtime: Date }>;
  /** Override for tests -- defaults to resolveManifestDir() */
  manifestsDir?: string;
}

/**
 * Discover all bust-*.jsonl manifest files in the manifests directory,
 * sorted newest-first by mtime.
 *
 * Returns [] when the directory doesn't exist (no bust history).
 * Filters to only files matching the `bust-*.jsonl` pattern (T-09-01).
 *
 * @param deps Injectable readdir + stat (inject fakes in tests; production
 *             passes `readdir: (d) => fs.readdir(d), stat: (p) => fs.stat(p)`).
 */
export async function discoverManifests(deps: DiscoverManifestsDeps): Promise<ManifestEntry[]> {
  const dir = deps.manifestsDir ?? resolveManifestDir();
  let entries: string[];
  try {
    entries = await deps.readdir(dir);
  } catch {
    return []; // ENOENT = no bust history
  }
  const jsonlFiles = entries.filter((e) => e.startsWith('bust-') && e.endsWith('.jsonl'));
  const statted = await Promise.all(
    jsonlFiles.map(async (name) => {
      const p = path.join(dir, name);
      const s = await deps.stat(p);
      return { path: p, mtime: s.mtime };
    }),
  );
  return statted.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// -- Header / Footer builders (D-12) ------------------------------

export function buildHeader(
  input: Omit<ManifestHeader, 'record_type' | 'manifest_version' | 'selection_filter'> & {
    selection_filter?: SelectionFilter;
  },
): ManifestHeader {
  const sf = input.selection_filter ?? { mode: 'full' };
  const normalized: SelectionFilter =
    sf.mode === 'subset' ? { mode: 'subset', ids: [...sf.ids].sort() } : { mode: 'full' };
  return {
    record_type: 'header',
    manifest_version: MANIFEST_VERSION,
    ccaudit_version: input.ccaudit_version,
    checkpoint_ghost_hash: input.checkpoint_ghost_hash,
    checkpoint_timestamp: input.checkpoint_timestamp,
    since_window: input.since_window,
    os: input.os,
    node_version: input.node_version,
    planned_ops: input.planned_ops,
    selection_filter: normalized,
  };
}

export function buildFooter(input: Omit<ManifestFooter, 'record_type'>): ManifestFooter {
  return {
    record_type: 'footer',
    ...input,
  };
}

// -- Op builders (D-11) -------------------------------------------

function sha256Hex(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(buf).digest('hex');
}

export function buildArchiveOp(input: {
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  source_path: string;
  archive_path: string;
  content: Buffer | string;
  status?: 'completed' | 'failed';
  error?: string;
}): ArchiveOp {
  return {
    op_id: randomUUID(),
    op_type: 'archive',
    timestamp: new Date().toISOString(),
    status: input.status ?? 'completed',
    ...(input.error !== undefined ? { error: input.error } : {}),
    category: input.category,
    scope: input.scope,
    source_path: input.source_path,
    archive_path: input.archive_path,
    content_sha256: sha256Hex(input.content),
  };
}

export function buildDisableOp(input: {
  config_path: string;
  scope: 'global' | 'project';
  project_path: string | null;
  original_key: string;
  new_key: string;
  original_value: unknown;
  status?: 'completed' | 'failed';
  error?: string;
}): DisableOp {
  return {
    op_id: randomUUID(),
    op_type: 'disable',
    timestamp: new Date().toISOString(),
    status: input.status ?? 'completed',
    ...(input.error !== undefined ? { error: input.error } : {}),
    config_path: input.config_path,
    scope: input.scope,
    project_path: input.project_path,
    original_key: input.original_key,
    new_key: input.new_key,
    original_value: input.original_value,
  };
}

export function buildFlagOp(input: {
  file_path: string;
  scope: 'global' | 'project';
  had_frontmatter: boolean;
  had_ccaudit_stale: boolean;
  patched_keys: ReadonlyArray<'ccaudit-stale' | 'ccaudit-flagged'>;
  original_content: Buffer | string;
  status?: 'completed' | 'failed';
  error?: string;
}): FlagOp {
  return {
    op_id: randomUUID(),
    op_type: 'flag',
    timestamp: new Date().toISOString(),
    status: input.status ?? 'completed',
    ...(input.error !== undefined ? { error: input.error } : {}),
    file_path: input.file_path,
    scope: input.scope,
    had_frontmatter: input.had_frontmatter,
    had_ccaudit_stale: input.had_ccaudit_stale,
    patched_keys: input.patched_keys,
    original_content_sha256: sha256Hex(input.original_content),
  };
}

export function buildRefreshOp(input: {
  file_path: string;
  scope: 'global' | 'project';
  previous_flagged_at: string;
  status?: 'completed' | 'failed';
  error?: string;
}): RefreshOp {
  return {
    op_id: randomUUID(),
    op_type: 'refresh',
    timestamp: new Date().toISOString(),
    status: input.status ?? 'completed',
    ...(input.error !== undefined ? { error: input.error } : {}),
    file_path: input.file_path,
    scope: input.scope,
    previous_flagged_at: input.previous_flagged_at,
  };
}

export function buildSkippedOp(input: {
  file_path: string;
  category: 'agent' | 'skill' | 'memory' | 'mcp';
  reason: string;
}): SkippedOp {
  return {
    op_id: randomUUID(),
    op_type: 'skipped',
    timestamp: new Date().toISOString(),
    status: 'completed',
    file_path: input.file_path,
    category: input.category,
    reason: input.reason,
  };
}

// -- ManifestWriter (D-09) ----------------------------------------

/**
 * Append-only JSONL writer with per-op fsync (D-09).
 *
 * Lifecycle:
 * ```
 * const w = new ManifestWriter(resolveManifestPath());
 * await w.open(buildHeader(...));        // writes header + fsync
 * for (const op of ops) await w.writeOp(op);  // each append fsynced
 * await w.close(buildFooter(...));       // footer only on success
 * // on failure path: await w.close(null) -- closes without footer
 * ```
 *
 * Crash-survival contract (D-09): after `open()` returns, the header line is
 * durable on disk. After every `writeOp()`, the op line is durable on disk. If
 * the process is SIGKILL'd between ops, the manifest is truncated to the last
 * fsynced line; the worst case is a trailing partially-written line, which
 * `readManifest` tolerates.
 */
export class ManifestWriter {
  private fd: FileHandle | null = null;
  private startMs = 0;

  constructor(public readonly filePath: string) {}

  async open(header: ManifestHeader): Promise<void> {
    // D-10: parent directory created recursively with 0o700 (POSIX) mode.
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // D-10: file mode 0o600 via open()'s mode arg. Note: the mode is applied
    // ONLY when the file is created; on re-open of an existing file the
    // existing mode is preserved -- the chmod below is the belt-and-suspenders
    // safeguard (no-op on Windows, swallow errors silently).
    this.fd = await open(this.filePath, 'a', 0o600);
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // Windows doesn't honor POSIX modes; ignore EPERM/ENOTSUP.
    }
    this.startMs = Date.now();
    // Pitfall 5: single write, NOT separate stringify + newline, to avoid a
    // partial-line race between the two syscalls.
    await this.fd.write(JSON.stringify(header) + '\n');
    await this.fd.sync();
  }

  async writeOp(op: ManifestOp): Promise<void> {
    if (!this.fd) {
      throw new Error('ManifestWriter.writeOp: not opened (call open() first)');
    }
    // Pitfall 5: concatenate JSON + newline in ONE write.
    await this.fd.write(JSON.stringify(op) + '\n');
    await this.fd.sync();
  }

  /**
   * Close the manifest file. Pass a footer record on successful bust
   * completion; pass `null` on failure so Phase 9 sees the header-present +
   * footer-missing crash signature and can warn before restoring.
   */
  async close(footer: ManifestFooter | null): Promise<void> {
    if (!this.fd) return;
    if (footer !== null) {
      await this.fd.write(JSON.stringify(footer) + '\n');
      await this.fd.sync();
    }
    await this.fd.close();
    this.fd = null;
  }

  /** Milliseconds elapsed since {@link open} was called (for footer.duration_ms). */
  get elapsedMs(): number {
    return Date.now() - this.startMs;
  }
}

// -- Reader (crash-tolerant, D-09 contract) ----------------------

/**
 * Read a JSONL manifest file and parse each line as a discriminated record.
 *
 * Per D-09 crash-survival contract: a single trailing truncated line is
 * tolerated (SIGKILL after partial write). Phase 9 detection rules:
 *   - header present + footer present  -> clean bust, restore normally
 *   - header present + footer missing  -> partial bust, warn + best-effort
 *   - header missing                    -> corrupt manifest, refuse
 *
 * A mid-file parse error (a corrupt line that is NOT the last line) is raised
 * as an exception so callers know the manifest cannot be trusted.
 */
export async function readManifest(filePath: string): Promise<ReadManifestResult> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  // Strip trailing empty line from the final '\n' terminator of a clean manifest.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let header: ManifestHeader | null = null;
  const ops: ManifestOp[] = [];
  let footer: ManifestFooter | null = null;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Trailing truncated line is tolerable ONLY if it's the last line
      // (D-09 crash-survival contract -- SIGKILL after partial write).
      if (i === lines.length - 1) {
        truncated = true;
        continue;
      }
      throw new Error(`Manifest parse error at line ${i + 1}: invalid JSON`);
    }
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj['record_type'] === 'header') {
        header = obj as unknown as ManifestHeader;
      } else if (obj['record_type'] === 'footer') {
        footer = obj as unknown as ManifestFooter;
      } else if (typeof obj['op_type'] === 'string') {
        ops.push(obj as unknown as ManifestOp);
      }
    }
  }

  return { header, ops, footer, truncated };
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, rm, writeFile: wf, stat: fsStat, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  describe('resolveManifestPath', () => {
    it('returns bust-<iso-ms-dashed>-<rand4>.jsonl with ms precision and random suffix', () => {
      const d = new Date('2026-04-05T18:30:00.123Z');
      const p = resolveManifestPath(d);
      // Timestamp part: 2026-04-05T18-30-00-123Z (colons and dot replaced with dash)
      // Suffix: 4 base-36 characters
      expect(p).toMatch(
        /[/\\]\.claude[/\\]ccaudit[/\\]manifests[/\\]bust-2026-04-05T18-30-00-123Z-[a-z0-9]{4}\.jsonl$/,
      );
    });

    it('two calls with the same Date produce different paths (random suffix)', () => {
      const d = new Date('2026-04-05T18:30:00.000Z');
      const p1 = resolveManifestPath(d);
      const p2 = resolveManifestPath(d);
      // With a 4-char base-36 suffix (36^4 = 1,679,616 combinations) collision
      // probability per call pair is ~1/1.7M — safe to assert inequality in tests.
      expect(p1).not.toBe(p2);
    });

    it('result starts with bust- and ends with .jsonl (discoverManifests compat)', () => {
      const p = resolveManifestPath(new Date());
      const filename = p.split(/[/\\]/).at(-1)!;
      expect(filename.startsWith('bust-')).toBe(true);
      expect(filename.endsWith('.jsonl')).toBe(true);
    });
  });

  describe('buildArchiveOp', () => {
    it('fills required fields with uuid + timestamp + content hash', () => {
      const op = buildArchiveOp({
        category: 'agent',
        scope: 'global',
        source_path: '/a/foo.md',
        archive_path: '/a/ccaudit/archived/agents/foo.md',
        content: 'hello',
      });
      expect(op.op_type).toBe('archive');
      expect(op.status).toBe('completed');
      expect(op.category).toBe('agent');
      expect(op.scope).toBe('global');
      expect(op.source_path).toBe('/a/foo.md');
      expect(op.archive_path).toBe('/a/ccaudit/archived/agents/foo.md');
      expect(op.op_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(op.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(op.content_sha256).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('accepts Buffer content', () => {
      const op = buildArchiveOp({
        category: 'skill',
        scope: 'project',
        source_path: '/s/foo.md',
        archive_path: '/s/ccaudit/archived/skills/foo.md',
        content: Buffer.from('hello', 'utf8'),
      });
      expect(op.content_sha256).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('sets failed status when requested', () => {
      const op = buildArchiveOp({
        category: 'agent',
        scope: 'global',
        source_path: '/a/foo.md',
        archive_path: '/a/ccaudit/archived/agents/foo.md',
        content: '',
        status: 'failed',
        error: 'EPERM',
      });
      expect(op.status).toBe('failed');
      expect(op.error).toBe('EPERM');
    });
  });

  describe('buildDisableOp / buildFlagOp / buildRefreshOp / buildSkippedOp', () => {
    it('disable op has all D-11 fields', () => {
      const op = buildDisableOp({
        config_path: '/home/u/.claude.json',
        scope: 'global',
        project_path: null,
        original_key: 'playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: { command: 'npx', args: ['@playwright/mcp'] },
      });
      expect(op.op_type).toBe('disable');
      expect(op.original_key).toBe('playwright');
      expect(op.new_key).toBe('ccaudit-disabled:playwright');
    });

    it('flag op computes original_content_sha256', () => {
      const op = buildFlagOp({
        file_path: '/home/u/.claude/CLAUDE.md',
        scope: 'global',
        had_frontmatter: false,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale', 'ccaudit-flagged'] as const,
        original_content: 'hello',
      });
      expect(op.op_type).toBe('flag');
      expect(op.original_content_sha256).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('refresh op carries previous_flagged_at', () => {
      const op = buildRefreshOp({
        file_path: '/home/u/.claude/CLAUDE.md',
        scope: 'global',
        previous_flagged_at: '2026-01-01T00:00:00Z',
      });
      expect(op.op_type).toBe('refresh');
      expect(op.previous_flagged_at).toBe('2026-01-01T00:00:00Z');
    });

    it('skipped op carries reason', () => {
      const op = buildSkippedOp({
        file_path: '/home/u/.claude/rules/weird.md',
        category: 'memory',
        reason: 'exotic-yaml',
      });
      expect(op.op_type).toBe('skipped');
      expect(op.reason).toBe('exotic-yaml');
      expect(op.status).toBe('completed');
    });
  });

  describe('ManifestWriter', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'manifest-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    function sampleHeader(): ManifestHeader {
      return buildHeader({
        ccaudit_version: '0.0.1',
        checkpoint_ghost_hash: 'sha256:abc',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '7d',
        os: 'darwin',
        node_version: 'v22.20.0',
        planned_ops: { archive: 2, disable: 1, flag: 1 },
      });
    }

    function sampleFooter(): ManifestFooter {
      return buildFooter({
        status: 'completed',
        actual_ops: {
          archive: { completed: 2, failed: 0 },
          disable: { completed: 1, failed: 0 },
          flag: { completed: 1, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 1234,
        exit_code: 0,
      });
    }

    it('open creates file with header as line 1', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(sampleHeader());
      await w.close(sampleFooter());
      const s = await fsStat(p);
      expect(s.isFile()).toBe(true);
      const raw = await readFile(p, 'utf8');
      const line1 = raw.split('\n')[0]!;
      const parsed = JSON.parse(line1);
      expect(parsed.record_type).toBe('header');
      expect(parsed.manifest_version).toBe(1);
    });

    it('writeOp appends one line per call and fsyncs', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(sampleHeader());
      await w.writeOp(
        buildArchiveOp({
          category: 'agent',
          scope: 'global',
          source_path: '/a/foo.md',
          archive_path: '/a/ccaudit/archived/agents/foo.md',
          content: 'x',
        }),
      );
      await w.writeOp(
        buildArchiveOp({
          category: 'skill',
          scope: 'project',
          source_path: '/s/bar.md',
          archive_path: '/s/ccaudit/archived/skills/bar.md',
          content: 'y',
        }),
      );
      await w.close(sampleFooter());
      const raw = await readFile(p, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(4); // header + 2 ops + footer
    });

    it('close(null) omits footer', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(sampleHeader());
      await w.writeOp(
        buildArchiveOp({
          category: 'agent',
          scope: 'global',
          source_path: '/a/foo.md',
          archive_path: '/a/ccaudit/archived/agents/foo.md',
          content: 'x',
        }),
      );
      await w.close(null);
      const result = await readManifest(p);
      expect(result.header).toBeTruthy();
      expect(result.ops).toHaveLength(1);
      expect(result.footer).toBe(null);
    });

    it.skipIf(process.platform === 'win32')(
      'open creates dir with 0o700 and file with 0o600',
      async () => {
        const p = path.join(tmp, 'nested', 'deep', 'bust.jsonl');
        const w = new ManifestWriter(p);
        await w.open(sampleHeader());
        await w.close(sampleFooter());
        const fileStat = await fsStat(p);
        expect(fileStat.mode & 0o777).toBe(0o600);
        const dirStat = await fsStat(path.dirname(p));
        expect(dirStat.mode & 0o777).toBe(0o700);
      },
    );
  });

  describe('readManifest', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'manifest-read-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('full round-trip: header + 3 ops + footer', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(
        buildHeader({
          ccaudit_version: '0.0.1',
          checkpoint_ghost_hash: 'sha256:abc',
          checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
          since_window: '7d',
          os: 'linux',
          node_version: 'v22',
          planned_ops: { archive: 1, disable: 1, flag: 1 },
        }),
      );
      await w.writeOp(
        buildArchiveOp({
          category: 'agent',
          scope: 'global',
          source_path: '/a/foo.md',
          archive_path: '/a/ccaudit/archived/agents/foo.md',
          content: 'hello',
        }),
      );
      await w.writeOp(
        buildDisableOp({
          config_path: '/home/u/.claude.json',
          scope: 'global',
          project_path: null,
          original_key: 'playwright',
          new_key: 'ccaudit-disabled:playwright',
          original_value: {},
        }),
      );
      await w.writeOp(
        buildFlagOp({
          file_path: '/home/u/.claude/CLAUDE.md',
          scope: 'global',
          had_frontmatter: false,
          had_ccaudit_stale: false,
          patched_keys: ['ccaudit-stale', 'ccaudit-flagged'] as const,
          original_content: 'body',
        }),
      );
      await w.close(
        buildFooter({
          status: 'completed',
          actual_ops: {
            archive: { completed: 1, failed: 0 },
            disable: { completed: 1, failed: 0 },
            flag: { completed: 1, failed: 0, refreshed: 0, skipped: 0 },
          },
          duration_ms: 100,
          exit_code: 0,
        }),
      );

      const result = await readManifest(p);
      expect(result.header).toBeTruthy();
      expect(result.ops).toHaveLength(3);
      expect(result.ops[0]!.op_type).toBe('archive');
      expect(result.ops[1]!.op_type).toBe('disable');
      expect(result.ops[2]!.op_type).toBe('flag');
      expect(result.footer).toBeTruthy();
      expect(result.truncated).toBe(false);
    });

    it('tolerates trailing truncated line (crash survival)', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const header = JSON.stringify(
        buildHeader({
          ccaudit_version: '0.0.1',
          checkpoint_ghost_hash: 'sha256:abc',
          checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
          since_window: '7d',
          os: 'linux',
          node_version: 'v22',
          planned_ops: { archive: 0, disable: 0, flag: 0 },
        }),
      );
      // header + 1 good op + truncated partial line (NO trailing newline)
      await wf(
        p,
        header +
          '\n{"op_type":"archive","op_id":"x","timestamp":"t","status":"completed","category":"agent","scope":"global","source_path":"/a/foo","archive_path":"/a/_a/foo","content_sha256":"abc"}\n{"incomplete',
        'utf8',
      );
      const result = await readManifest(p);
      expect(result.header).toBeTruthy();
      expect(result.ops).toHaveLength(1);
      expect(result.footer).toBe(null);
      expect(result.truncated).toBe(true);
    });

    it('throws on mid-file corruption (not just trailing)', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const header = JSON.stringify(
        buildHeader({
          ccaudit_version: '0.0.1',
          checkpoint_ghost_hash: 'sha256:abc',
          checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
          since_window: '7d',
          os: 'linux',
          node_version: 'v22',
          planned_ops: { archive: 0, disable: 0, flag: 0 },
        }),
      );
      await wf(p, header + '\n{not json}\n{"op_type":"archive","op_id":"x"}\n', 'utf8');
      await expect(readManifest(p)).rejects.toThrow(/parse error/);
    });
  });

  describe('resolveManifestDir', () => {
    it('Test 5: returns path.join(homedir(), .claude, ccaudit, manifests)', () => {
      const dir = resolveManifestDir();
      expect(dir).toMatch(/[/\\]\.claude[/\\]ccaudit[/\\]manifests$/);
    });
  });

  describe('discoverManifests', () => {
    it('Test 1: returns only bust-*.jsonl entries, filters non-matching files', async () => {
      const fakeMtime = new Date('2026-04-05T18:30:00Z');
      const deps: DiscoverManifestsDeps = {
        manifestsDir: '/fake/manifests',
        readdir: async () => [
          'bust-2026-04-01T10-00-00Z.jsonl',
          'bust-2026-04-05T18-30-00Z.jsonl',
          'other.txt',
        ],
        stat: async () => ({ mtime: fakeMtime }),
      };
      const result = await discoverManifests(deps);
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.path.includes('bust-'))).toBe(true);
      expect(result.every((e) => e.path.endsWith('.jsonl'))).toBe(true);
    });

    it('Test 2: returns [] when readdir throws ENOENT', async () => {
      const deps: DiscoverManifestsDeps = {
        manifestsDir: '/nonexistent/manifests',
        readdir: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        stat: async () => ({ mtime: new Date() }),
      };
      const result = await discoverManifests(deps);
      expect(result).toEqual([]);
    });

    it('Test 3: sorts newest-first by mtime', async () => {
      const older = new Date('2026-04-01T00:00:00Z');
      const newer = new Date('2026-04-05T18:30:00Z');
      const mtimes: Record<string, Date> = {
        'bust-2026-04-01T10-00-00Z.jsonl': older,
        'bust-2026-04-05T18-30-00Z.jsonl': newer,
      };
      const deps: DiscoverManifestsDeps = {
        manifestsDir: '/fake/manifests',
        readdir: async () => ['bust-2026-04-01T10-00-00Z.jsonl', 'bust-2026-04-05T18-30-00Z.jsonl'],
        stat: async (p) => ({ mtime: mtimes[path.basename(p)]! }),
      };
      const result = await discoverManifests(deps);
      expect(result[0]!.path).toContain('2026-04-05');
      expect(result[0]!.mtime.getTime()).toBeGreaterThan(result[1]!.mtime.getTime());
    });

    it('Test 4: filters entries not matching bust-*.jsonl pattern', async () => {
      const fakeMtime = new Date('2026-04-05T18:30:00Z');
      const deps: DiscoverManifestsDeps = {
        manifestsDir: '/fake/manifests',
        readdir: async () => [
          'README.md',
          '.DS_Store',
          'bust-broken.txt',
          'nonbust.jsonl',
          'bust-2026-04-05T18-30-00Z.jsonl',
        ],
        stat: async () => ({ mtime: fakeMtime }),
      };
      const result = await discoverManifests(deps);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toContain('bust-2026-04-05T18-30-00Z.jsonl');
    });

    it('Test 6: ManifestEntry shape has path: string and mtime: Date', async () => {
      const fakeMtime = new Date('2026-04-05T18:30:00Z');
      const deps: DiscoverManifestsDeps = {
        manifestsDir: '/fake/manifests',
        readdir: async () => ['bust-2026-04-05T18-30-00Z.jsonl'],
        stat: async () => ({ mtime: fakeMtime }),
      };
      const result = await discoverManifests(deps);
      expect(result).toHaveLength(1);
      const entry = result[0]!;
      expect(typeof entry.path).toBe('string');
      expect(entry.mtime).toBeInstanceOf(Date);
      expect(entry.mtime.getTime()).toBe(fakeMtime.getTime());
    });
  });

  describe('buildHeader — selection_filter', () => {
    function baseInput() {
      return {
        ccaudit_version: '0.0.1',
        checkpoint_ghost_hash: 'sha256:abc',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '7d',
        os: 'darwin' as NodeJS.Platform,
        node_version: 'v22.20.0',
        planned_ops: { archive: 1, disable: 0, flag: 0 },
      };
    }

    it('Test 6: { mode: full } is stored as-is', () => {
      const header = buildHeader({ ...baseInput(), selection_filter: { mode: 'full' } });
      // buildHeader always sets selection_filter; non-null assertion is safe here
      expect(header.selection_filter!.mode).toBe('full');
    });

    it('Test 7: { mode: subset, ids } sorts ids ascending', () => {
      const header = buildHeader({
        ...baseInput(),
        selection_filter: { mode: 'subset', ids: ['b', 'a', 'c'] },
      });
      const sf = header.selection_filter!;
      expect(sf.mode).toBe('subset');
      if (sf.mode === 'subset') {
        expect(sf.ids).toEqual(['a', 'b', 'c']);
      }
    });

    it('Test 8: omitting selection_filter defaults to { mode: full }', () => {
      const header = buildHeader(baseInput());
      expect(header.selection_filter).toEqual({ mode: 'full' });
    });
  });
}
