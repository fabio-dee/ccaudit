/**
 * Phase 08 Plan 06 — `ccaudit restore --name <pattern>` ambiguity contract
 * (D8-09, RESTORE-02).
 *
 * With two pencil-* items in the deduped archive inventory,
 * `--name pencil` matches both and MUST exit 1 with the verbatim D8-09
 * candidate block on stderr. Stdout MUST be empty (ambiguity short-circuits
 * before dispatch — no JSON envelope is produced). No items are restored;
 * the archive directory remains intact.
 *
 * The em-dash `\u2014` is load-bearing — the CLI contract pins the string
 * exactly so downstream tooling can parse deterministically.
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

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — restore --name ambiguity emits D8-09 block and exits 1 (RESTORE-02)',
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

    it('--name pencil with 2 candidates → exit 1, verbatim block on stderr, empty stdout', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--name', 'pencil'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });

      expect(r.exitCode).toBe(1);

      // D8-09: verbatim header with em-dash (U+2014) — grep-visible.
      // "pencil" is ambiguous — candidates:
      expect(r.stderr).toContain('"pencil" is ambiguous \u2014 candidates:');
      // Both candidate canonical_ids appear, each indented by 2 spaces.
      expect(r.stderr).toMatch(/\n {2}agent:.*pencil-dev\.md\n/);
      expect(r.stderr).toMatch(/\n {2}agent:.*pencil-review\.md\n/);
      // Suggestion line at the end.
      expect(r.stderr).toContain('Use --all-matching to restore every candidate.');

      // stdout is empty — ambiguity short-circuits before any dispatch
      // (D8-09: no JSON envelope is produced).
      expect(r.stdout).toBe('');

      // No items were restored — archive directory intact.
      const archivedDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
      expect(existsSync(path.join(archivedDir, 'pencil-dev.md'))).toBe(true);
      expect(existsSync(path.join(archivedDir, 'pencil-review.md'))).toBe(true);
      expect(existsSync(path.join(archivedDir, 'code-reviewer.md'))).toBe(true);

      // Source paths remain empty.
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-dev.md'))).toBe(false);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'pencil-review.md'))).toBe(false);
    });
  },
);
