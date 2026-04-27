/**
 * Phase 08 Plan 06 — `ccaudit restore --all-matching <pattern> --json`
 * envelope contract (D8-16, D8-17).
 *
 * Restore JSON envelope shape — what the tests below assert:
 *
 *   - meta.command       // e.g. "restore"
 *   - meta.exitCode      // camelCase number
 *   - status             // top-level enum string ("success" on happy path)
 *   - selectionFilter    // top-level object describing applied filter
 *                        //   .mode === "subset"
 *                        //   .ids  has exactly 2 entries (pencil-dev + pencil-review)
 *   - skipped[]          // top-level array of items skipped at restore time
 *                        //   (empty on the happy path, but present)
 *
 * See docs/JSON-SCHEMA.md for the full envelope contract. Source-exists skip
 * + skipped[] contents are covered by restore-interactive-source-exists.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  stageRestoreInteractiveFixture,
  runCcauditCli,
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
  meta: { command: string; exitCode: number };
  status: string;
  selectionFilter: { mode: string; ids: string[] } | null;
  skipped: unknown[];
}

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — restore --all-matching --json envelope (D8-16/17)',
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

    it('envelope carries selectionFilter (subset, 2 ids) + skipped[] on success', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--all-matching', 'pencil', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

      // Parse the single JSON line from stdout.
      const parsed = JSON.parse(r.stdout.trim()) as RestoreEnvelope;

      expect(parsed.meta.command).toBe('restore');
      expect(parsed.meta.exitCode).toBe(0);
      expect(parsed.status).toBe('success');

      // selectionFilter is the v1.5 additive field (D8-16).
      expect(parsed.selectionFilter).not.toBeNull();
      expect(parsed.selectionFilter?.mode).toBe('subset');
      expect(parsed.selectionFilter?.ids).toHaveLength(2);
      // ids reference the two pencil archive paths (agent:<abs>).
      for (const id of parsed.selectionFilter!.ids) {
        expect(id).toMatch(/^agent:.*pencil-(dev|review)\.md$/);
      }

      // skipped[] present (D8-17) — empty on the happy path.
      expect(Array.isArray(parsed.skipped)).toBe(true);
      expect(parsed.skipped).toHaveLength(0);
    });
  },
);
