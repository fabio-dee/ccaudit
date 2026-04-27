/**
 * Pre-dispatch preflight errors must emit a JSON envelope on stdout (not raw
 * stderr) when `--json` is active.
 *
 * Covers the five hard-fail sites replaced by RestorePreflightError:
 *   1. Mutual-exclusion (--interactive --name) → exit 1
 *   2. CCAUDIT_NO_INTERACTIVE refusal → exit 2
 *   3. TTY guard (no TTY, no CCAUDIT_FORCE_TTY) → exit 1
 *   4. --name no-match → exit 1
 *   5. --all-matching no-match → exit 1
 *
 * The envelope shape from buildJsonEnvelope is `{ meta: {...}, ...data }` —
 * the data fields are spread at the top level, so `error` lives at
 * `envelope.error`, not `envelope.data.error`.
 *
 * For each case the stdout must be a valid JSON object with
 * `meta.command === 'restore'` and `meta.exitCode` matching the expected code,
 * and `error` containing the expected message fragment.
 * stderr must be empty (no leakage of raw text alongside JSON).
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

// buildJsonEnvelope spreads data at the top level: { meta: {...}, ...data }
interface Envelope {
  meta: { command: string; exitCode: number };
  error?: string;
  [key: string]: unknown;
}

function parseEnvelope(stdout: string): Envelope {
  return JSON.parse(stdout.trim()) as Envelope;
}

describe.skipIf(process.platform === 'win32')(
  'restore preflight errors emit JSON envelope when --json is active',
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

    it('mutual-exclusion (--interactive --name) --json → JSON envelope on stdout, exit 1', async () => {
      const r = await runCcauditCli(
        tmpHome,
        ['restore', '--interactive', '--name', 'foo', '--json'],
        { env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` } },
      );
      expect(r.exitCode).toBe(1);
      const env = parseEnvelope(r.stdout);
      expect(env.meta.command).toBe('restore');
      expect(env.meta.exitCode).toBe(1);
      expect(env.error).toContain('mutually exclusive');
      // No raw text on stderr alongside JSON
      expect(r.stderr).toBe('');
    });

    it('CCAUDIT_NO_INTERACTIVE=1 --interactive --json → JSON envelope on stdout, exit 2', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--interactive', '--json'], {
        env: {
          CCAUDIT_NO_INTERACTIVE: '1',
          CCAUDIT_FORCE_TTY: '1',
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      });
      expect(r.exitCode).toBe(2);
      const env = parseEnvelope(r.stdout);
      expect(env.meta.command).toBe('restore');
      expect(env.meta.exitCode).toBe(2);
      expect(env.error).toContain('CCAUDIT_NO_INTERACTIVE');
      expect(r.stderr).toBe('');
    });

    it('TTY guard (no TTY) --interactive --json → JSON envelope on stdout, exit 1', async () => {
      // No CCAUDIT_FORCE_TTY — subprocess has no TTY by default in CI/subprocess context.
      const r = await runCcauditCli(tmpHome, ['restore', '--interactive', '--json'], {
        env: {
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      });
      expect(r.exitCode).toBe(1);
      const env = parseEnvelope(r.stdout);
      expect(env.meta.command).toBe('restore');
      expect(env.meta.exitCode).toBe(1);
      expect(env.error).toContain('--interactive requires a TTY');
      expect(r.stderr).toBe('');
    });

    it('--name no-match --json → JSON envelope on stdout, exit 1', async () => {
      const r = await runCcauditCli(
        tmpHome,
        ['restore', '--name', 'nonexistent-ghost-xyz', '--json'],
        { env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` } },
      );
      expect(r.exitCode).toBe(1);
      const env = parseEnvelope(r.stdout);
      expect(env.meta.command).toBe('restore');
      expect(env.meta.exitCode).toBe(1);
      expect(env.error).toContain('nonexistent-ghost-xyz');
      expect(r.stderr).toBe('');
    });

    it('--all-matching no-match --json → JSON envelope on stdout, exit 1', async () => {
      const r = await runCcauditCli(
        tmpHome,
        ['restore', '--all-matching', 'nonexistent-ghost-xyz', '--json'],
        { env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` } },
      );
      expect(r.exitCode).toBe(1);
      const env = parseEnvelope(r.stdout);
      expect(env.meta.command).toBe('restore');
      expect(env.meta.exitCode).toBe(1);
      expect(env.error).toContain('nonexistent-ghost-xyz');
      expect(r.stderr).toBe('');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'restore preflight errors emit plain stderr (not JSON) without --json',
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

    it('mutual-exclusion without --json → plain stderr, no JSON on stdout', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--interactive', '--name', 'foo'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('mutually exclusive');
      expect(r.stdout).toBe('');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'restore preflight empty-archive --interactive --json → JSON envelope exit 0',
  () => {
    it('empty archive under --interactive --json → JSON envelope on stdout, exit 0', async () => {
      // Use a fresh home with no manifests: findManifestsForRestore returns []
      // → collectRestoreableItems returns [] → RestorePreflightError(0, ...).
      const emptyHome = await makeTmpHome();
      try {
        await mkdir(path.join(emptyHome, '.claude'), { recursive: true });
        await writeFile(path.join(emptyHome, '.claude.json'), '{}', 'utf8');
        await buildFakePs(emptyHome);

        const r = await runCcauditCli(emptyHome, ['restore', '--interactive', '--json'], {
          env: {
            CCAUDIT_FORCE_TTY: '1',
            PATH: `${path.join(emptyHome, 'bin')}:${process.env.PATH ?? ''}`,
          },
        });
        expect(r.exitCode).toBe(0);
        const env = parseEnvelope(r.stdout);
        expect(env.meta.command).toBe('restore');
        expect(env.meta.exitCode).toBe(0);
        expect(env.error).toContain('archive is empty');
        expect(r.stderr).toBe('');
      } finally {
        await cleanupTmpHome(emptyHome);
      }
    });
  },
);
