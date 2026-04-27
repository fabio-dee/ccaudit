/**
 * Phase 08 Plan 06 — INV-S3 round-trip via `ccaudit restore --interactive`
 * (D8-20).
 *
 * Stages the restore-interactive fixture (subset manifest archiving
 * pencil-dev + pencil-review, then a newer full manifest archiving
 * code-reviewer + a duplicate pencil-review entry), spawns
 * `ccaudit restore --interactive` under CCAUDIT_FORCE_TTY=1, scripts the
 * keystrokes that toggle every archived item across the agent tab, confirms
 * the picker and the follow-up "Restore N items?" prompt, and asserts:
 *
 *   - all three source paths (.claude/agents/{pencil-dev,pencil-review,code-reviewer}.md)
 *     are back at their original locations
 *   - the archive directory is empty of those items
 *   - manifests/ directory is unchanged (restore is a consumer, not a producer)
 *
 * Dedup behavior is exercised by construction: both manifests reference the
 * same archive_path for pencil-review.md; dedupManifestOps keeps newer-wins
 * and the picker sees it once. Thus pressing `a` (toggle-all-in-tab) on the
 * agent tab selects exactly 3 items — pencil-dev (from the older subset
 * manifest), pencil-review (from the newer full manifest, newer wins), and
 * code-reviewer (from the newer full manifest). End-to-end round-trip
 * succeeds only if both manifests contribute via a single restore session.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  stageRestoreInteractiveFixture,
  listManifestsDir,
  sendKeys,
  waitForPicker,
} from './_test-helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

interface SpawnedRestore {
  child: ChildProcess;
  done: Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

/**
 * Spawn `ccaudit restore --interactive` against `tmpHome`.
 * Mirror of runCcauditGhost but for the `restore` subcommand; inlined here
 * because the helper module's `runCcauditGhost` is hard-coded to prepend
 * `ghost`, and adding another helper for one test is overkill.
 */
function spawnRestoreInteractive(tmpHome: string): SpawnedRestore {
  const child = spawn(process.execPath, [distPath, 'restore', '--interactive'], {
    env: {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      NO_COLOR: '1',
      TZ: 'UTC',
      CCAUDIT_FORCE_TTY: '1',
      PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
      COLUMNS: '120',
      LINES: '40',
    },
    cwd: tmpHome,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const done = new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `spawnRestoreInteractive timed out after 15000ms\nstdout:\n${stdout.slice(-500)}\nstderr:\n${stderr.slice(-500)}`,
          ),
        );
      }, 15_000);
      child.stdout!.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });
    },
  );

  return { child, done };
}

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — INV-S3 subset + full manifest round-trip via restore --interactive',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await stageRestoreInteractiveFixture(tmpHome);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('picker toggles all 3 deduped items across both manifests → all 3 restored', async () => {
      const baselineManifests = await listManifestsDir(tmpHome);

      const spawned = spawnRestoreInteractive(tmpHome);

      // Wait for the picker to reach its blocking read loop.
      await waitForPicker(spawned.child);

      expect(
        spawned.child.exitCode,
        'subprocess exited before we sent keystrokes — dump:',
      ).toBeNull();

      // Keystroke script:
      //   'a'   — toggle-all-in-active-tab (D3.1-15). All 3 agents selected.
      //   '\r'  — Enter: submit picker selection.
      //   '\x1b[D' — ArrowLeft: toggle clack's confirm prompt from No → Yes
      //             (initialValue: false at select-restore.ts:120).
      //   '\r'  — Enter: confirm restore.
      await sendKeys(spawned.child, ['a'], 100);
      await sendKeys(spawned.child, ['\r'], 200);
      // Grace period so the picker closes and the confirm prompt mounts
      // before we try to toggle it.
      await new Promise((r) => setTimeout(r, 300));
      await sendKeys(spawned.child, ['\x1b[D'], 100);
      await sendKeys(spawned.child, ['\r'], 100);

      const result = await spawned.done;
      expect(
        result.exitCode,
        `restore --interactive exited with ${result.exitCode}\nstderr:\n${result.stderr.slice(-1000)}\nstdout:\n${result.stdout.slice(-1000)}`,
      ).toBe(0);

      // All three source paths present.
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-dev.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-review.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'code-reviewer.md'))).toBe(true);

      // Archive dir no longer holds the restored items.
      const archivedAfter = await readdir(
        path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents'),
      ).catch(() => [] as string[]);
      expect(archivedAfter).not.toContain('pencil-dev.md');
      expect(archivedAfter).not.toContain('pencil-review.md');
      expect(archivedAfter).not.toContain('code-reviewer.md');

      // INV-S2 mirror: restore does not create new manifest files.
      const postManifests = await listManifestsDir(tmpHome);
      expect(postManifests).toEqual(baselineManifests);

      // Phase 8.1 Plan 05 (D81-05) — footer wording + MEMORY tab visibility.
      // Footer template from D8-03 uses middle-dot U+00B7 separator.
      expect(result.stdout).toMatch(/\d+ selected \u00B7 \d+ archived/);
      // MEMORY tab appears because the full-bust manifest contains a FlagOp;
      // collectRestoreableItems surfaces memory ops in the picker (D81-01).
      expect(result.stdout).toContain('MEMORY');
    }, 20_000);
  },
);
