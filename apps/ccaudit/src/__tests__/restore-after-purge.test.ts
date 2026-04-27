/**
 * RE-M9 follow-up — full-mode `restore` must skip archive ops whose op_id
 * was referenced by an `archive_purge` op in a purge manifest.
 *
 * Before this fix, `executeRestore` full-mode did NOT call collectPurgedOpIds,
 * so after a purge it would attempt to restore already-drained archives, fail
 * with "archive file missing", and report `partial-success` instead of `success`.
 *
 * Fixture:
 *   - One bust manifest: archive ops for items A, B, C.
 *     A and B archive files are GONE from disk (purged).
 *     C archive file is present on disk.
 *   - One purge manifest: archive_purge ops referencing op_ids of A and B.
 *
 * Expected behaviour after fix:
 *   - restore --json exits 0 with status === 'success'
 *   - counts.unarchived.moved === 1 (only C was attempted and moved)
 *   - counts.unarchived.failed === 0 (A and B are silently skipped, not failed)
 *   - The archive file for C is restored to its source path.
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

interface RestoreEnvelope {
  meta: { command: string; exitCode: number };
  status: string;
  manifest_path?: string;
  counts?: {
    unarchived: { moved: number; alreadyAtSource: number; failed: number };
    reenabled: { completed: number; failed: number };
    stripped: { completed: number; failed: number };
  };
}

describe.skipIf(process.platform === 'win32')(
  'RE-M9 follow-up — full-mode restore skips purged archive ops',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);

      const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
      // Archive dir layout mirrors the actual bust output structure.
      const archivedAgentsDir = path.join(
        tmpHome,
        '.claude',
        'ccaudit',
        'archived',
        '.claude',
        'agents',
      );
      const agentsDir = path.join(tmpHome, '.claude', 'agents');
      await mkdir(manifestsDir, { recursive: true });
      await mkdir(archivedAgentsDir, { recursive: true });
      await mkdir(agentsDir, { recursive: true });

      const bustMtime = new Date('2026-04-20T10:00:00.000Z');
      const purgeMtime = new Date('2026-04-21T10:00:00.000Z');

      // Three items: A and B were purged (archive files absent), C is present.
      const items = ['item-a', 'item-b', 'item-c'] as const;
      const archivePaths: Record<string, string> = {};
      const sourcePaths: Record<string, string> = {};
      for (const name of items) {
        archivePaths[name] = path.join(archivedAgentsDir, `${name}.md`);
        sourcePaths[name] = path.join(agentsDir, `${name}.md`);
      }

      // Only C's archive file exists on disk; A and B were purged.
      await writeFile(archivePaths['item-c']!, '# item-c (archived)\n', 'utf8');

      // Bust manifest: archive ops for A, B, C.
      const bustHeader = {
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.5.0-test',
        checkpoint_ghost_hash: 'deadbeef-rem9',
        checkpoint_timestamp: '2026-04-20T10:00:00.000Z',
        since_window: '30d',
        os: 'darwin',
        node_version: 'v20.0.0',
        planned_ops: { archive: 3, disable: 0, flag: 0 },
        selection_filter: { mode: 'full' },
      };
      const bustOps = items.map((name) => ({
        op_id: `op-${name}-rem9`,
        op_type: 'archive',
        timestamp: bustMtime.toISOString(),
        status: 'completed',
        category: 'agent',
        scope: 'global',
        source_path: sourcePaths[name],
        archive_path: archivePaths[name],
        content_sha256: '0'.repeat(64),
      }));
      const bustFooter = {
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 3, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 10,
        exit_code: 0,
      };
      const bustBody =
        [bustHeader, ...bustOps, bustFooter].map((r) => JSON.stringify(r)).join('\n') + '\n';
      const bustManifestPath = path.join(manifestsDir, 'bust-2026-04-20T10-00-00-000Z-rem9.jsonl');
      await writeFile(bustManifestPath, bustBody, 'utf8');
      await utimes(bustManifestPath, bustMtime, bustMtime);

      // Purge manifest: archive_purge ops for A and B only.
      const purgeHeader = {
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.5.0-test',
        checkpoint_ghost_hash: `purge:${purgeMtime.toISOString()}`,
        checkpoint_timestamp: purgeMtime.toISOString(),
        since_window: 'n/a',
        os: 'darwin',
        node_version: 'v20.0.0',
        planned_ops: { archive: 0, disable: 0, flag: 0 },
        selection_filter: { mode: 'full' },
      };
      const purgeOps = (['item-a', 'item-b'] as const).map((name) => ({
        op_id: `purge-op-${name}-rem9`,
        op_type: 'archive_purge',
        timestamp: purgeMtime.toISOString(),
        status: 'completed',
        original_op_id: `op-${name}-rem9`,
        purged: true,
        reason: 'reclaimed',
      }));
      const purgeFooter = {
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 0, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 5,
        exit_code: 0,
      };
      const purgeBody =
        [purgeHeader, ...purgeOps, purgeFooter].map((r) => JSON.stringify(r)).join('\n') + '\n';
      const purgeManifestPath = path.join(
        manifestsDir,
        'purge-2026-04-21T10-00-00-000Z-rem9.jsonl',
      );
      await writeFile(purgeManifestPath, purgeBody, 'utf8');
      await utimes(purgeManifestPath, purgeMtime, purgeMtime);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('exits 0 with status=success when purged ops are skipped (not failed)', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      const parsed = JSON.parse(r.stdout.trim()) as RestoreEnvelope;
      expect(parsed.meta.command).toBe('restore');
      expect(parsed.meta.exitCode).toBe(0);

      // Must be 'success', not 'partial-success' — purged ops are skipped silently.
      expect(
        parsed.status,
        `expected 'success' but got '${parsed.status}'; spurious failures mean purged ops were attempted`,
      ).toBe('success');
      expect(path.basename(parsed.manifest_path ?? '')).toMatch(/^bust-/);
    });

    it('counts reflect only C being restored (moved=1, failed=0)', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      const parsed = JSON.parse(r.stdout.trim()) as RestoreEnvelope;
      expect(parsed.counts).toBeDefined();

      // Only C was attempted — A and B were suppressed by the purged-op-id check.
      expect(parsed.counts!.unarchived.moved, 'expected exactly 1 item moved (item-c)').toBe(1);

      // No spurious failures from attempting to restore missing archives for A and B.
      expect(
        parsed.counts!.unarchived.failed,
        'expected 0 failures — purged ops must be skipped, not attempted',
      ).toBe(0);
    });

    it('item-c archive file is moved back to its source path', async () => {
      const agentsDir = path.join(tmpHome, '.claude', 'agents');
      const archivedAgentsDir = path.join(
        tmpHome,
        '.claude',
        'ccaudit',
        'archived',
        '.claude',
        'agents',
      );

      await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });

      // item-c should now be at its source path.
      const sourcePath = path.join(agentsDir, 'item-c.md');
      expect(existsSync(sourcePath), `item-c.md should have been restored to ${sourcePath}`).toBe(
        true,
      );

      // item-c archive should be gone (it was moved, not copied).
      const archivePath = path.join(archivedAgentsDir, 'item-c.md');
      expect(
        existsSync(archivePath),
        `item-c.md archive should no longer exist at ${archivePath}`,
      ).toBe(false);
    });
  },
);
