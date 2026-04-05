// @ccaudit/internal -- JSONL restore manifest writer (Phase 8 D-09 / D-10 / D-11 / D-12)
//
// RED-phase stub: types, exports, and in-source tests. Implementation intentionally
// throws so the test suite fails loudly until the GREEN commit lands.

// -- Header type (D-12) ------------------------------------------

export const MANIFEST_VERSION = 1 as const;

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

// -- Stubs (RED phase -- intentionally fail) ---------------------

export function resolveManifestPath(_now: Date = new Date()): string {
  throw new Error('resolveManifestPath not implemented (RED phase stub)');
}

export function buildHeader(
  _input: Omit<ManifestHeader, 'record_type' | 'manifest_version'>,
): ManifestHeader {
  throw new Error('buildHeader not implemented (RED phase stub)');
}

export function buildFooter(_input: Omit<ManifestFooter, 'record_type'>): ManifestFooter {
  throw new Error('buildFooter not implemented (RED phase stub)');
}

export function buildArchiveOp(_input: {
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  source_path: string;
  archive_path: string;
  content: Buffer | string;
  status?: 'completed' | 'failed';
  error?: string;
}): ArchiveOp {
  throw new Error('buildArchiveOp not implemented (RED phase stub)');
}

export function buildDisableOp(_input: {
  config_path: string;
  scope: 'global' | 'project';
  project_path: string | null;
  original_key: string;
  new_key: string;
  original_value: unknown;
  status?: 'completed' | 'failed';
  error?: string;
}): DisableOp {
  throw new Error('buildDisableOp not implemented (RED phase stub)');
}

export function buildFlagOp(_input: {
  file_path: string;
  scope: 'global' | 'project';
  had_frontmatter: boolean;
  had_ccaudit_stale: boolean;
  patched_keys: ReadonlyArray<'ccaudit-stale' | 'ccaudit-flagged'>;
  original_content: Buffer | string;
  status?: 'completed' | 'failed';
  error?: string;
}): FlagOp {
  throw new Error('buildFlagOp not implemented (RED phase stub)');
}

export function buildRefreshOp(_input: {
  file_path: string;
  scope: 'global' | 'project';
  previous_flagged_at: string;
  status?: 'completed' | 'failed';
  error?: string;
}): RefreshOp {
  throw new Error('buildRefreshOp not implemented (RED phase stub)');
}

export function buildSkippedOp(_input: {
  file_path: string;
  category: 'agent' | 'skill' | 'memory' | 'mcp';
  reason: string;
}): SkippedOp {
  throw new Error('buildSkippedOp not implemented (RED phase stub)');
}

export class ManifestWriter {
  constructor(public readonly filePath: string) {}

  async open(_header: ManifestHeader): Promise<void> {
    throw new Error('ManifestWriter.open not implemented (RED phase stub)');
  }

  async writeOp(_op: ManifestOp): Promise<void> {
    throw new Error('ManifestWriter.writeOp not implemented (RED phase stub)');
  }

  async close(_footer: ManifestFooter | null): Promise<void> {
    throw new Error('ManifestWriter.close not implemented (RED phase stub)');
  }

  get elapsedMs(): number {
    return 0;
  }
}

export async function readManifest(_filePath: string): Promise<ReadManifestResult> {
  throw new Error('readManifest not implemented (RED phase stub)');
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, rm, writeFile: wf, stat: fsStat, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  describe('resolveManifestPath', () => {
    it('returns ~/.claude/ccaudit/manifests/bust-<iso-dashed>.jsonl', () => {
      const d = new Date('2026-04-05T18:30:00.000Z');
      const p = resolveManifestPath(d);
      expect(p).toMatch(/[/\\]\.claude[/\\]ccaudit[/\\]manifests[/\\]bust-2026-04-05T18-30-00Z\.jsonl$/);
    });
  });

  describe('buildArchiveOp', () => {
    it('fills required fields with uuid + timestamp + content hash', () => {
      const op = buildArchiveOp({
        category: 'agent',
        scope: 'global',
        source_path: '/a/foo.md',
        archive_path: '/a/_archived/foo.md',
        content: 'hello',
      });
      expect(op.op_type).toBe('archive');
      expect(op.status).toBe('completed');
      expect(op.category).toBe('agent');
      expect(op.scope).toBe('global');
      expect(op.source_path).toBe('/a/foo.md');
      expect(op.archive_path).toBe('/a/_archived/foo.md');
      expect(op.op_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(op.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(op.content_sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('accepts Buffer content', () => {
      const op = buildArchiveOp({
        category: 'skill',
        scope: 'project',
        source_path: '/s/foo.md',
        archive_path: '/s/_archived/foo.md',
        content: Buffer.from('hello', 'utf8'),
      });
      expect(op.content_sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('sets failed status when requested', () => {
      const op = buildArchiveOp({
        category: 'agent',
        scope: 'global',
        source_path: '/a/foo.md',
        archive_path: '/a/_archived/foo.md',
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
      expect(op.original_content_sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
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
    beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'manifest-')); });
    afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

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
      await w.writeOp(buildArchiveOp({
        category: 'agent', scope: 'global',
        source_path: '/a/foo.md', archive_path: '/a/_archived/foo.md',
        content: 'x',
      }));
      await w.writeOp(buildArchiveOp({
        category: 'skill', scope: 'project',
        source_path: '/s/bar.md', archive_path: '/s/_archived/bar.md',
        content: 'y',
      }));
      await w.close(sampleFooter());
      const raw = await readFile(p, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(4); // header + 2 ops + footer
    });

    it('close(null) omits footer', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(sampleHeader());
      await w.writeOp(buildArchiveOp({
        category: 'agent', scope: 'global',
        source_path: '/a/foo.md', archive_path: '/a/_archived/foo.md',
        content: 'x',
      }));
      await w.close(null);
      const result = await readManifest(p);
      expect(result.header).toBeTruthy();
      expect(result.ops).toHaveLength(1);
      expect(result.footer).toBe(null);
    });

    it.skipIf(process.platform === 'win32')('open creates dir with 0o700 and file with 0o600', async () => {
      const p = path.join(tmp, 'nested', 'deep', 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(sampleHeader());
      await w.close(sampleFooter());
      const fileStat = await fsStat(p);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const dirStat = await fsStat(path.dirname(p));
      expect(dirStat.mode & 0o777).toBe(0o700);
    });
  });

  describe('readManifest', () => {
    let tmp: string;
    beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'manifest-read-')); });
    afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

    it('full round-trip: header + 3 ops + footer', async () => {
      const p = path.join(tmp, 'bust.jsonl');
      const w = new ManifestWriter(p);
      await w.open(buildHeader({
        ccaudit_version: '0.0.1',
        checkpoint_ghost_hash: 'sha256:abc',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '7d',
        os: 'linux',
        node_version: 'v22',
        planned_ops: { archive: 1, disable: 1, flag: 1 },
      }));
      await w.writeOp(buildArchiveOp({
        category: 'agent', scope: 'global',
        source_path: '/a/foo.md', archive_path: '/a/_archived/foo.md',
        content: 'hello',
      }));
      await w.writeOp(buildDisableOp({
        config_path: '/home/u/.claude.json',
        scope: 'global',
        project_path: null,
        original_key: 'playwright',
        new_key: 'ccaudit-disabled:playwright',
        original_value: {},
      }));
      await w.writeOp(buildFlagOp({
        file_path: '/home/u/.claude/CLAUDE.md',
        scope: 'global',
        had_frontmatter: false,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale', 'ccaudit-flagged'] as const,
        original_content: 'body',
      }));
      await w.close(buildFooter({
        status: 'completed',
        actual_ops: {
          archive: { completed: 1, failed: 0 },
          disable: { completed: 1, failed: 0 },
          flag: { completed: 1, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 100,
        exit_code: 0,
      }));

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
      const header = JSON.stringify(buildHeader({
        ccaudit_version: '0.0.1',
        checkpoint_ghost_hash: 'sha256:abc',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '7d',
        os: 'linux',
        node_version: 'v22',
        planned_ops: { archive: 0, disable: 0, flag: 0 },
      }));
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
      const header = JSON.stringify(buildHeader({
        ccaudit_version: '0.0.1',
        checkpoint_ghost_hash: 'sha256:abc',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '7d',
        os: 'linux',
        node_version: 'v22',
        planned_ops: { archive: 0, disable: 0, flag: 0 },
      }));
      await wf(p, header + '\n{not json}\n{"op_type":"archive","op_id":"x"}\n', 'utf8');
      await expect(readManifest(p)).rejects.toThrow(/parse error/);
    });
  });
}
