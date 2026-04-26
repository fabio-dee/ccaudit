/**
 * Phase 08 Plan 06 — `ccaudit restore --all-matching <pattern>` happy path
 * (D8-10, RESTORE-03).
 *
 * Stages the restore-interactive fixture (subset manifest + full manifest
 * with an overlapping archive_path for pencil-review), runs
 * `ccaudit restore --all-matching pencil`, and asserts:
 *   - exit 0
 *   - both pencil-dev.md and pencil-review.md are back at their source paths
 *   - code-reviewer.md (not matching "pencil") remains in archived/
 *   - no new manifest was written by the restore run
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  stageRestoreInteractiveFixture,
  runCcauditCli,
  listManifestsDir,
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

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — restore --all-matching <pattern> happy path (RESTORE-03)',
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

    it('restores every pencil-* item and leaves code-reviewer in archived/', async () => {
      const baselineManifests = await listManifestsDir(tmpHome);

      const r = await runCcauditCli(tmpHome, ['restore', '--all-matching', 'pencil'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      // Both pencil items back at source.
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-dev.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-review.md'))).toBe(true);

      // code-reviewer unchanged (never matched the pattern).
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'code-reviewer.md'))).toBe(false);
      expect(
        existsSync(
          path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'code-reviewer.md'),
        ),
      ).toBe(true);

      // Archive directory no longer contains the restored pencil items.
      const archivedAfter = await readdir(
        path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents'),
      ).catch(() => [] as string[]);
      expect(archivedAfter).not.toContain('pencil-dev.md');
      expect(archivedAfter).not.toContain('pencil-review.md');

      // Restore MUST NOT write new manifests (restore is a consumer, not a producer).
      const postManifests = await listManifestsDir(tmpHome);
      expect(postManifests).toEqual(baselineManifests);
    });

    // Phase 8.1 Plan 05 (D81-05): pins the CLI-side pre-dispatch gate added in
    // plan 08.1-03 — `--all-matching <pattern>` with zero matches exits 1 with
    // stderr wording and empty stdout. Fixture has pencil-* + code-reviewer;
    // 'no-such-thing-xyz' matches nothing.
    it('no-match: exits 1 with stderr wording, no stdout', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--all-matching', 'no-such-thing-xyz'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no archived item matches "no-such-thing-xyz"');
      expect(r.stdout).toBe('');
    });
  },
);
