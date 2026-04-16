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
import { mkdir, writeFile, readdir } from 'node:fs/promises';
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
