/**
 * M9 — `restore --list` must not surface purge manifests as restore entries.
 *
 * Fixture: two manifest JSONL files in `<tmpHome>/.claude/ccaudit/manifests/`:
 *   - BUST manifest  (bust-*.jsonl)  → one archive op for `live-agent`
 *   - PURGE manifest (purge-*.jsonl) → one archive_purge op referencing the bust op
 *
 * `restore --list --json` must return exactly one entry whose `path` ends with
 * the bust manifest filename. The purge manifest must be silently skipped and
 * must NOT appear in the entries array.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpHome, cleanupTmpHome, buildFakePs, runCcauditCli } from './_test-helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

interface RestoreListEnvelope {
  meta: { command: string; exitCode: number };
  status: string;
  entries: Array<{
    path: string;
    mtime: string;
    is_partial: boolean;
    op_count: number;
    items: Array<{ category: string; name: string }>;
  }>;
  filtered_stale_count: number;
}

describe.skipIf(process.platform === 'win32')('M9 — restore --list skips purge manifests', () => {
  let tmpHome: string;
  let bustManifestName: string;
  let purgeManifestName: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);

    const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
    const archivedAgentsDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
    await mkdir(manifestsDir, { recursive: true });
    await mkdir(archivedAgentsDir, { recursive: true });

    const archivePath = path.join(archivedAgentsDir, 'live-agent.md');
    const sourcePath = path.join(tmpHome, '.claude', 'agents', 'live-agent.md');
    const bustMtime = new Date('2026-04-20T10:00:00.000Z');
    const purgeMtime = new Date('2026-04-21T10:00:00.000Z');

    bustManifestName = 'bust-2026-04-20T10-00-00-000Z-m9tt.jsonl';
    purgeManifestName = 'purge-2026-04-21T10-00-00-000Z-m9tt.jsonl';

    // Bust manifest: one archive op for live-agent (archive present on disk)
    const bustHeader = {
      record_type: 'header',
      manifest_version: 1,
      ccaudit_version: '1.5.0-test',
      checkpoint_ghost_hash: 'deadbeef-m9',
      checkpoint_timestamp: '2026-04-20T10-00-00-000Z',
      since_window: '30d',
      os: 'darwin',
      node_version: 'v20.0.0',
      planned_ops: { archive: 1, disable: 0, flag: 0 },
      selection_filter: { mode: 'full' },
    };
    const bustOp = {
      op_id: 'op-live-agent-m9',
      op_type: 'archive',
      timestamp: bustMtime.toISOString(),
      status: 'completed',
      category: 'agent',
      scope: 'global',
      source_path: sourcePath,
      archive_path: archivePath,
      content_sha256: '0'.repeat(64),
    };
    const bustFooter = {
      record_type: 'footer',
      status: 'completed',
      actual_ops: {
        archive: { completed: 1, failed: 0 },
        disable: { completed: 0, failed: 0 },
        flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
      },
      duration_ms: 10,
      exit_code: 0,
    };
    const bustBody =
      [JSON.stringify(bustHeader), JSON.stringify(bustOp), JSON.stringify(bustFooter)].join('\n') +
      '\n';
    const bustPath = path.join(manifestsDir, bustManifestName);
    await writeFile(bustPath, bustBody, 'utf8');
    await utimes(bustPath, bustMtime, bustMtime);

    // Seed the archive file so restore doesn't filter it as stale
    await writeFile(archivePath, '# live-agent (archived)\n', 'utf8');

    // Purge manifest: one archive_purge op referencing the bust op
    const purgeHeader = {
      record_type: 'header',
      manifest_version: 1,
      ccaudit_version: '1.5.0-test',
      purge_timestamp: purgeMtime.toISOString(),
    };
    const purgeOp = {
      op_id: 'purge-op-m9',
      op_type: 'archive_purge',
      timestamp: purgeMtime.toISOString(),
      status: 'completed',
      original_op_id: 'op-live-agent-m9',
      purged: true,
      reason: 'reclaimed',
    };
    const purgeBody = [JSON.stringify(purgeHeader), JSON.stringify(purgeOp)].join('\n') + '\n';
    const purgePath = path.join(manifestsDir, purgeManifestName);
    await writeFile(purgePath, purgeBody, 'utf8');
    await utimes(purgePath, purgeMtime, purgeMtime);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('restore --list --json returns exactly 1 entry for the bust manifest (not the purge)', async () => {
    const r = await runCcauditCli(tmpHome, ['restore', '--list', '--json'], {
      env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
    });
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

    const parsed = JSON.parse(r.stdout.trim()) as RestoreListEnvelope;
    expect(parsed.meta.command).toBe('restore');
    expect(parsed.meta.exitCode).toBe(0);
    expect(parsed.status).toBe('list');

    // Exactly one entry — only the bust manifest
    expect(
      parsed.entries,
      `expected 1 entry (bust only), got ${parsed.entries.length}: ${parsed.entries.map((e) => path.basename(e.path)).join(', ')}`,
    ).toHaveLength(1);

    // The entry must point to the bust manifest, not the purge manifest
    expect(path.basename(parsed.entries[0]!.path)).toBe(bustManifestName);
    expect(path.basename(parsed.entries[0]!.path).startsWith('bust-')).toBe(true);

    // Defensive: purge manifest must not appear anywhere
    const allPaths = parsed.entries.map((e) => path.basename(e.path));
    expect(allPaths.every((p) => !p.startsWith('purge-'))).toBe(true);
  });
});
