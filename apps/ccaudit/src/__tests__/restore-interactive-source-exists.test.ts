/**
 * Phase 08 Plan 06 — source-exists skip contract (D8-14, INV-S3 mirror).
 *
 * Pre-populates the source path for `pencil-review.md` before running
 * `ccaudit restore --all-matching pencil --json`. Asserts:
 *   - exit 0 (partial-skip is success, not failure — D8-18)
 *   - `data.status === 'success'`
 *   - `data.skipped` contains exactly one entry with
 *       `{ reason: 'source_exists', canonical_id: 'agent:.../pencil-review.md' }`
 *   - stderr contains `warning: skipped <path> — source already exists`
 *   - pencil-dev.md IS restored to its source path (the other match wasn't skipped)
 *   - the pre-existing pencil-review.md content is preserved byte-for-byte
 *     (restore NEVER overwrites)
 *   - manifests dir unchanged (INV-S2 mirror: restore is a consumer, not a producer)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
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

interface RestoreEnvelope {
  status: string;
  skipped: Array<{ reason: string; path: string; canonical_id: string }>;
}

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — source_exists skip (D8-14)',
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

    it('pre-populated source path → skipped with source_exists, other match restored', async () => {
      const baselineManifests = await listManifestsDir(tmpHome);

      // Pre-populate pencil-review.md at its source path BEFORE the restore.
      // This content must survive the restore (D8-14: never overwrite).
      const prePopulated = '# pencil-review PRE-EXISTING — MUST NOT be overwritten\n';
      const reviewSource = path.join(tmpHome, '.claude', 'agents', 'pencil-review.md');
      await writeFile(reviewSource, prePopulated, 'utf8');

      const r = await runCcauditCli(tmpHome, ['restore', '--all-matching', 'pencil', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      const parsed = JSON.parse(r.stdout.trim()) as RestoreEnvelope;
      expect(parsed.status).toBe('success');

      // Exactly one skipped entry for the pre-populated path.
      expect(parsed.skipped).toHaveLength(1);
      expect(parsed.skipped[0]?.reason).toBe('source_exists');
      expect(parsed.skipped[0]?.path).toBe(reviewSource);
      expect(parsed.skipped[0]?.canonical_id).toMatch(/^agent:.*pencil-review\.md$/);

      // stderr carries the human-readable warning (D8-14).
      expect(r.stderr).toContain('source already exists');
      expect(r.stderr).toContain(reviewSource);

      // pencil-dev.md was restored (the other match was not skipped).
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-dev.md'))).toBe(true);

      // Pre-populated content preserved byte-for-byte.
      const after = await readFile(reviewSource, 'utf8');
      expect(after).toBe(prePopulated);

      // INV-S2 mirror: restore does NOT write manifests.
      const postManifests = await listManifestsDir(tmpHome);
      expect(postManifests).toEqual(baselineManifests);
    });
  },
);
