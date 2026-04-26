/**
 * Phase 8.2 — `restore --list --json` drops stale archive ops.
 *
 * Fixture: two manifest JSONL files in `<tmpHome>/.claude/ccaudit/manifests/`:
 *   - STALE manifest → archives `stale-agent` but archive_path is missing
 *     on disk AND source_path DOES exist on disk → already-restored /
 *     test-residue. Must be suppressed from `restore --list`.
 *   - LIVE manifest → archives `live-agent`, archive_path present on disk,
 *     source_path absent → genuinely restoreable. Must remain listed.
 *
 * Asserts:
 *   - `restore --list --json` exits 0 and lists only `live-agent`
 *   - envelope.filtered_stale_count === 1
 *   - INV-S3 is not regressed: fixture mirrors the mixed-manifest shape
 *     that restore-interactive-roundtrip.test.ts guards
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
    items: Array<{
      category: string;
      name: string;
      source_path?: string;
      archive_path?: string;
    }>;
  }>;
  filtered_stale_count: number;
}

/**
 * Build a single JSONL manifest with one archive op. `archiveOnDisk` controls
 * whether the archive_path file is actually present; `sourceOnDisk` controls
 * whether source_path exists (simulating either an already-restored item or
 * a genuinely-restoreable archive).
 */
async function buildManifestFixture(
  tmpHome: string,
  opts: {
    manifestName: string;
    agentName: string;
    archiveOnDisk: boolean;
    sourceOnDisk: boolean;
    mtime: Date;
  },
): Promise<void> {
  const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
  const archivedAgentsDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  await mkdir(manifestsDir, { recursive: true });
  await mkdir(archivedAgentsDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  const archivePath = path.join(archivedAgentsDir, `${opts.agentName}.md`);
  const sourcePath = path.join(agentsDir, `${opts.agentName}.md`);

  const header = {
    record_type: 'header',
    manifest_version: 1,
    ccaudit_version: '1.5.0-test',
    checkpoint_ghost_hash: `deadbeef-${opts.agentName}`,
    checkpoint_timestamp: opts.mtime.toISOString().replace(/[:.]/g, '-'),
    since_window: '30d',
    os: 'darwin',
    node_version: 'v20.0.0',
    planned_ops: { archive: 1, disable: 0, flag: 0 },
    selection_filter: { mode: 'full' },
  };
  const op = {
    op_id: `op-${opts.agentName}`,
    op_type: 'archive',
    timestamp: opts.mtime.toISOString(),
    status: 'completed',
    category: 'agent',
    scope: 'global',
    source_path: sourcePath,
    archive_path: archivePath,
    content_sha256: '0000000000000000000000000000000000000000000000000000000000000001',
  };
  const footer = {
    record_type: 'footer',
    status: 'completed',
    actual_ops: {
      archive: { completed: 1, failed: 0 },
      disable: { completed: 0, failed: 0 },
      flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
    },
    duration_ms: 42,
    exit_code: 0,
  };
  const body =
    [JSON.stringify(header), JSON.stringify(op), JSON.stringify(footer)].join('\n') + '\n';
  const manifestPath = path.join(manifestsDir, opts.manifestName);
  await writeFile(manifestPath, body, 'utf8');
  await utimes(manifestPath, opts.mtime, opts.mtime);

  if (opts.archiveOnDisk) {
    await writeFile(archivePath, `# ${opts.agentName} (archived)\n`, 'utf8');
  }
  if (opts.sourceOnDisk) {
    await writeFile(sourcePath, `# ${opts.agentName} (at source)\n`, 'utf8');
  }
}

describe.skipIf(process.platform === 'win32')(
  'Phase 8.2 — restore --list drops stale archive ops (archive_missing + source_exists)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);

      // STALE: archive_path missing, source_path present → should be filtered.
      await buildManifestFixture(tmpHome, {
        manifestName: 'bust-2026-04-20T10-00-00-000Z-stale.jsonl',
        agentName: 'stale-agent',
        archiveOnDisk: false,
        sourceOnDisk: true,
        mtime: new Date('2026-04-20T10:00:00.000Z'),
      });

      // LIVE: archive_path present, source_path missing → should remain listed.
      await buildManifestFixture(tmpHome, {
        manifestName: 'bust-2026-04-21T10-00-00-000Z-live.jsonl',
        agentName: 'live-agent',
        archiveOnDisk: true,
        sourceOnDisk: false,
        mtime: new Date('2026-04-21T10:00:00.000Z'),
      });
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('restore --list --json lists only the live item and reports filtered_stale_count=1', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--list', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      const parsed = JSON.parse(r.stdout.trim()) as RestoreListEnvelope;
      expect(parsed.meta.command).toBe('restore');
      expect(parsed.meta.exitCode).toBe(0);
      expect(parsed.status).toBe('list');

      // filtered_stale_count reflects the suppressed stale archive op.
      expect(parsed.filtered_stale_count).toBe(1);

      // Aggregate archive-op items across all entries: exactly one (live-agent).
      const allItems = parsed.entries.flatMap((e) => e.items);
      const archiveItems = allItems.filter((i) => i.category === 'agent');
      expect(archiveItems).toHaveLength(1);
      expect(archiveItems[0]!.name).toBe('live-agent');

      // Defensive: the stale item must NOT appear anywhere in the listing.
      const names = archiveItems.map((i) => i.name);
      expect(names).not.toContain('stale-agent');
    });

    it.todo(
      'filter propagates to subset restore via interactive CLI path — covered by Task 1 in-source tests',
    );
  },
);
