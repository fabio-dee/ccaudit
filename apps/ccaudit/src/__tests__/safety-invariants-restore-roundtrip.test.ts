/**
 * Phase 3 — INV-S3 (SAFETY-03): subset manifests + full manifests round-trip
 * cleanly through `ccaudit restore`.
 *
 * Strategy (CONTEXT D-10, D-11):
 *   1. Build a fixture with 3 ghost agents: alpha, beta, gamma.
 *   2. Subset-bust {alpha, beta} via CCAUDIT_SELECT_IDS=alphaId,betaId.
 *      → first manifest with planned_ops.archive=2, selection_filter.mode='subset'.
 *   3. Re-run dry-run (the inventory has changed: alpha+beta gone), then
 *      full-bust {gamma} (no CCAUDIT_SELECT_IDS).
 *      → second manifest with planned_ops.archive=1, selection_filter.mode='full'.
 *   4. Run `ccaudit restore --json`.
 *      → assert status='success', counts.unarchived.moved === 3.
 *      → assert all 3 source files exist at their original paths.
 *      → assert archived/agents/ does not contain any of {alpha,beta,gamma}.
 *
 * Per CONTEXT D-12 the dedup-newer-wins stress (re-bust same item, restore
 * dedups) is OUT of scope for Phase 3 — Phase 8 owns the restore TUI work
 * and will add the dedup test there. Phase 3 covers the happy path of two
 * manifests with disjoint contents.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditGhost,
  runCcauditCli,
  agentItemId,
} from './_test-helpers.ts';

// ── Dist guard ─────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 3 — INV-S3: subset + full manifests round-trip via `ccaudit restore` (SAFETY-03)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      // Base scaffold
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'inv-s3-session',
        }) + '\n',
        'utf8',
      );
      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

      // 3 ghost agents
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'alpha.md'),
        '# alpha\nNever invoked.\n',
        'utf8',
      );
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'beta.md'),
        '# beta\nNever invoked.\n',
        'utf8',
      );
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'gamma.md'),
        '# gamma\nNever invoked.\n',
        'utf8',
      );

      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    // Helper: run a sequence of CLI invocations against the fixture.
    // Each invocation uses runCcauditGhost (which exposes the ChildProcess).
    // We end stdin immediately and await `done` for non-interactive flows.
    async function runGhost(
      args: string[],
      env?: Record<string, string>,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
      const spawned = runCcauditGhost(tmpHome, args, env ? { env } : {});
      spawned.child.stdin?.end();
      const r = await spawned.done;
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    }

    it('subset bust {alpha, beta} + full bust {gamma} → restore restores all three', async () => {
      // Step 1: dry-run (writes checkpoint with all 3 agents in scope).
      const dry1 = await runGhost(['--dry-run', '--yes-proceed-busting', '--json']);
      expect(dry1.exitCode, `dry-run 1 stderr: ${dry1.stderr}`).toBe(0);

      // Step 2: subset-bust {alpha, beta}.
      const alphaId = agentItemId(tmpHome, 'alpha.md');
      const betaId = agentItemId(tmpHome, 'beta.md');
      const subsetBust = await runGhost(
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { CCAUDIT_SELECT_IDS: `${alphaId},${betaId}` },
      );
      expect(subsetBust.exitCode, `subset bust stderr: ${subsetBust.stderr}`).toBe(0);

      // Sanity: alpha + beta archived, gamma still at source.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'alpha.md')),
      ).toBe(true);
      expect(
        existsSync(path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'beta.md')),
      ).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(false);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(false);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md'))).toBe(true);

      // Step 3: (sleep removed) — resolveManifestPath now uses millisecond precision
      // plus a 4-char random suffix, so same-second busts no longer collide on the
      // manifest filename. The 1.1s sleep that used to work around the second-granularity
      // bug (WR-03) is no longer needed. See fix(03-review): WR-03 commit.

      // Re-run dry-run so the next bust's checkpoint matches the
      // current inventory (only gamma remains).
      const dry2 = await runGhost(['--dry-run', '--yes-proceed-busting', '--json']);
      expect(dry2.exitCode, `dry-run 2 stderr: ${dry2.stderr}`).toBe(0);

      // Step 4: full-bust {gamma}, no CCAUDIT_SELECT_IDS.
      const fullBust = await runGhost([
        '--dangerously-bust-ghosts',
        '--yes-proceed-busting',
        '--json',
      ]);
      expect(fullBust.exitCode, `full bust stderr: ${fullBust.stderr}`).toBe(0);

      // Sanity: gamma is now archived too.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'gamma.md')),
      ).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md'))).toBe(false);

      // Step 5: assert exactly 2 manifests exist (one subset, one full).
      const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
      const manifests = await readdir(manifestsDir);
      expect(
        manifests.filter((m) => m.endsWith('.jsonl')),
        `expected 2 manifests, got ${manifests.length}: ${manifests.join(', ')}`,
      ).toHaveLength(2);

      // Step 6: run `ccaudit restore --json`.
      // restore is its own gunshi subcommand — invoke via runCcauditCli with
      // ['restore', '--json'] (NOT runCcauditGhost which prepends 'ghost').
      // The PATH override ensures the fake-ps shim is on PATH for the restore
      // preflight (which also runs the running-Claude check).
      const restore = await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(restore.exitCode, `restore stderr: ${restore.stderr}`).toBe(0);

      const parsed = JSON.parse(restore.stdout) as {
        status: string;
        counts?: { unarchived: { moved: number; alreadyAtSource: number; failed: number } };
      };
      expect(parsed.status).toBe('success');
      expect(parsed.counts?.unarchived.moved).toBe(3);
      expect(parsed.counts?.unarchived.failed).toBe(0);

      // Step 7: assert all 3 source files are back at their original paths.
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md'))).toBe(true);

      // Step 8: assert archived/agents/ no longer contains any of the three.
      const archivedAgentsDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
      const archivedFiles = (await readdir(archivedAgentsDir).catch(() => [] as string[])).filter(
        (f) => ['alpha.md', 'beta.md', 'gamma.md'].includes(f),
      );
      expect(archivedFiles, `archived dir still contains: ${archivedFiles.join(', ')}`).toEqual([]);
    });
  },
);

// ── M8 — INV-S3: memory file flagged in bust1 + refreshed in bust2 → restore removes all ccaudit frontmatter ──

describe.skipIf(process.platform === 'win32')(
  'M8 — INV-S3: memory file flagged in bust1 then refreshed in bust2 → restore round-trip (SAFETY-M8)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
      await mkdir(manifestsDir, { recursive: true });

      // Session JSONL so the running-Claude preflight passes.
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'm8-session',
        }) + '\n',
        'utf8',
      );
      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

      await buildFakePs(tmpHome);

      // Write the memory file with BOTH ccaudit frontmatter keys so restore
      // has something to strip — simulating a file that was flagged and later
      // refreshed across two separate busts.
      const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
      const originalContent = '# Memory file\nSome important content.\n';
      await writeFile(
        memoryPath,
        `---\nccaudit-stale: "2026-04-17T10:00:00Z"\nccaudit-flagged: "2026-04-18T10:00:00Z"\n---\n${originalContent}`,
        'utf8',
      );

      // Bust 1 (older): flag op on the memory file.
      const bust1Mtime = new Date('2026-04-17T10:00:00.000Z');
      const bust1Header = {
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.5.0-test',
        checkpoint_ghost_hash: 'deadbeef-m8-1',
        checkpoint_timestamp: '2026-04-17T09-59-59-000Z',
        since_window: '30d',
        os: 'darwin',
        node_version: 'v20.0.0',
        planned_ops: { archive: 0, disable: 0, flag: 1 },
        selection_filter: { mode: 'full' },
      };
      const bust1FlagOp = {
        op_id: 'op-m8-flag-bust1',
        op_type: 'flag',
        timestamp: bust1Mtime.toISOString(),
        status: 'completed',
        file_path: memoryPath,
        scope: 'global',
        had_frontmatter: false,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale', 'ccaudit-flagged'],
        original_content_sha256: '0'.repeat(64),
      };
      const bust1Footer = {
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 0, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 1, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 10,
        exit_code: 0,
      };
      const bust1Body =
        [
          JSON.stringify(bust1Header),
          JSON.stringify(bust1FlagOp),
          JSON.stringify(bust1Footer),
        ].join('\n') + '\n';
      const bust1Path = path.join(manifestsDir, 'bust-2026-04-17T10-00-00-000Z-m8t1.jsonl');
      await writeFile(bust1Path, bust1Body, 'utf8');
      await utimes(bust1Path, bust1Mtime, bust1Mtime);

      // Bust 2 (newer): refresh op on the SAME memory file.
      const bust2Mtime = new Date('2026-04-18T10:00:00.000Z');
      const bust2Header = {
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.5.0-test',
        checkpoint_ghost_hash: 'deadbeef-m8-2',
        checkpoint_timestamp: '2026-04-18T09-59-59-000Z',
        since_window: '30d',
        os: 'darwin',
        node_version: 'v20.0.0',
        planned_ops: { archive: 0, disable: 0, flag: 1 },
        selection_filter: { mode: 'full' },
      };
      const bust2RefreshOp = {
        op_id: 'op-m8-refresh-bust2',
        op_type: 'refresh',
        timestamp: bust2Mtime.toISOString(),
        status: 'completed',
        file_path: memoryPath,
        scope: 'global',
        previous_flagged_at: bust1Mtime.toISOString(),
      };
      const bust2Footer = {
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 0, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 0, failed: 0, refreshed: 1, skipped: 0 },
        },
        duration_ms: 10,
        exit_code: 0,
      };
      const bust2Body =
        [
          JSON.stringify(bust2Header),
          JSON.stringify(bust2RefreshOp),
          JSON.stringify(bust2Footer),
        ].join('\n') + '\n';
      const bust2Path = path.join(manifestsDir, 'bust-2026-04-18T10-00-00-000Z-m8t2.jsonl');
      await writeFile(bust2Path, bust2Body, 'utf8');
      await utimes(bust2Path, bust2Mtime, bust2Mtime);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('M8: restore --json removes all ccaudit frontmatter from memory file flagged in bust1 and refreshed in bust2', async () => {
      const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');

      const restore = await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(restore.exitCode, `restore stderr: ${restore.stderr}`).toBe(0);

      const parsed = JSON.parse(restore.stdout) as {
        status: string;
        counts?: { stripped: { completed: number; failed: number } };
      };
      expect(parsed.status).toBe('success');
      // Both the flag op and the refresh op should result in 2 stripped operations.
      expect(parsed.counts?.stripped.completed).toBe(2);
      expect(parsed.counts?.stripped.failed).toBe(0);

      // Memory file must have no residual ccaudit frontmatter from either op.
      const afterContent = await readFile(memoryPath, 'utf8');
      expect(afterContent).not.toContain('ccaudit-stale');
      expect(afterContent).not.toContain('ccaudit-flagged');
      expect(afterContent).toContain('Some important content.');
    });
  },
);
