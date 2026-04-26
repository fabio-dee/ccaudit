/**
 * M4 — `restore` pre-dispatch flows covered by the outer try/catch.
 *
 * When `findManifestsForRestore` or `readManifest` encounters a corrupt or
 * unreadable manifest, the CLI must emit structured stderr/JSON output and
 * exit non-zero — NOT crash with an uncaught exception / stack trace.
 *
 * This test injects a JSONL file whose first line is not valid JSON so that
 * `readManifest` throws during the pre-dispatch --name / --all-matching /
 * default-full flows. The outer try/catch (M4 fix) must intercept the error
 * and route it into the graceful degradation path.
 *
 * Note: `restore --list` silently skips corrupt manifests (header===null) by
 * design (that code path is unchanged). The crash risk M4 addresses is in the
 * pre-dispatch dedup flows that call readManifest then iterate the ops.
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

/**
 * Write a manifest file whose header line is syntactically invalid JSON so
 * that readManifest() throws a SyntaxError during JSON.parse.
 */
async function writeCorruptManifest(tmpHome: string): Promise<string> {
  const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
  await mkdir(manifestsDir, { recursive: true });
  const manifestPath = path.join(manifestsDir, 'bust-2026-04-20T10-00-00-000Z-m4tt.jsonl');
  // First line is not valid JSON — will cause readManifest to throw.
  await writeFile(manifestPath, 'THIS IS NOT JSON\n{"op_type":"archive"}\n', 'utf8');
  return manifestPath;
}

describe.skipIf(process.platform === 'win32')(
  'M4 — corrupt manifest in pre-dispatch path emits structured error (not stack trace)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
      await writeCorruptManifest(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('restore (full) with corrupt manifest: exits non-zero, no stack trace on stderr', async () => {
      const r = await runCcauditCli(tmpHome, ['restore'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      // Must exit non-zero (1 from manifest-corrupt or 2 from caught error)
      expect(r.exitCode, `stdout:\n${r.stdout}`).not.toBe(0);
      // Must NOT emit a raw Node.js stack trace
      expect(r.stderr).not.toContain('at Object.');
      expect(r.stderr).not.toContain('Error: ');
      // stdout must be empty (not a stack trace dump)
      expect(r.stdout.trim()).toBe('');
    });

    it('restore --json with corrupt manifest: emits structured JSON envelope, exits non-zero', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--json'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      // Must exit non-zero
      expect(r.exitCode, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(0);
      // stdout must be a parseable JSON object (structured envelope or error envelope)
      const stdout = r.stdout.trim();
      expect(stdout.length, 'stdout must not be empty for --json').toBeGreaterThan(0);
      let parsed: Record<string, unknown>;
      expect(() => {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      }, `stdout must be valid JSON, got:\n${stdout}`).not.toThrow();
      // The envelope must have a meta block (standard ccaudit JSON envelope shape)
      expect(parsed!).toHaveProperty('meta');
      // Must not be a raw stack trace in stdout
      expect(stdout).not.toContain('at Object.');
    });

    it('restore --name foo with corrupt manifest: exits non-zero with structured output', async () => {
      const r = await runCcauditCli(tmpHome, ['restore', '--name', 'foo'], {
        env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
      });
      expect(r.exitCode, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(0);
      expect(r.stderr).not.toContain('at Object.');
      expect(r.stdout).not.toContain('at Object.');
    });
  },
);
