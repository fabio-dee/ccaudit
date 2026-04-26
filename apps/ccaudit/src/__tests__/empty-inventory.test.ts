/**
 * Phase 9 D1 / SC1 — empty-inventory short-circuit.
 *
 * When the ghost scan finds zero ghosts across all categories:
 *   - `ccaudit ghost --interactive` exits 0, prints a single clean line
 *     to stdout, and writes no manifest.
 *   - `ccaudit ghost` (plain) exits 0 with no auto-open prompt in stdout.
 *
 * Fixture: tmp HOME with no agents, no skills, no MCP servers, no memory,
 * no commands, no hooks. Minimal session JSONL so the scanner's session
 * discovery does not crash, and fake `ps` so the TUI preflight passes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditGhost,
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

async function stageEmptyHome(tmpHome: string): Promise<void> {
  // Empty .claude scaffolding — no agents / skills / memory / commands / hooks.
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  // Minimal session JSONL so discoverSessionFiles returns ≥1 file.
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'empty');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'session-1.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/empty',
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionId: 'empty-inventory',
    }) + '\n',
    'utf8',
  );
  // Empty .claude.json so MCP scanner loads cleanly with zero servers.
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  await buildFakePs(tmpHome);
}

describe.skipIf(process.platform === 'win32')(
  'Phase 9 SC1 — empty inventory short-circuits --interactive and silences auto-open',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await stageEmptyHome(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('`ghost --interactive` on empty inventory: exit 0, clean message, no manifest', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: { CCAUDIT_FORCE_TTY: '1' },
        timeout: 15_000,
      });
      spawned.child.stdin?.end();
      const result = await spawned.done;

      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Inventory is clean');
      expect(await listManifestsDir(tmpHome)).toEqual([]);
    });

    it('plain `ghost` on empty inventory: exit 0, no auto-open prompt', async () => {
      const spawned = runCcauditGhost(tmpHome, [], {
        env: { CCAUDIT_FORCE_TTY: '1' },
        timeout: 15_000,
      });
      spawned.child.stdin?.end();
      const result = await spawned.done;

      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).not.toMatch(/open interactive picker/i);
      expect(result.stdout).not.toContain('[Y/n]');
    });
  },
);
