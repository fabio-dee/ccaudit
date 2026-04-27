/**
 * Phase 08 Plan 06 — `--interactive`, `--name`, `--all-matching` mutual
 * exclusion (D8-11).
 *
 * Combining any two of the three mode-selecting flags is a hard error that
 * must exit 1 with a `flags are mutually exclusive` message on stderr
 * BEFORE any discovery, preflight, or filesystem access runs. No archive
 * listing is produced; no manifest is read; no fixture filesystem state
 * mutates.
 *
 * This test does NOT stage a manifest fixture — the error must fire even
 * on an empty home (the mutual-exclusion gate runs before discovery).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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

describe.skipIf(process.platform === 'win32')(
  'Phase 08 Plan 06 — restore flag mutual exclusion (D8-11)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await mkdir(path.join(tmpHome, '.claude'), { recursive: true });
      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('--interactive --name foo → exit 1, "flags are mutually exclusive" on stderr', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--interactive', '--name', 'foo'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('flags are mutually exclusive');
    });

    it('--name foo --all-matching foo → exit 1, "flags are mutually exclusive" on stderr', async () => {
      const r = await runCcauditCli(
        tmpHome,
        ['restore', '--name', 'foo', '--all-matching', 'foo'],
        { env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('flags are mutually exclusive');
    });

    it('--interactive --all-matching foo → exit 1, "flags are mutually exclusive" on stderr', async () => {
      const r = await runCcauditCli(
        tmpHome,
        ['restore', '--interactive', '--all-matching', 'foo'],
        { env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('flags are mutually exclusive');
    });
  },
);
