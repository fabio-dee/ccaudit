/**
 * Phase 9 D2 / SC2 — CCAUDIT_NO_INTERACTIVE env escape hatch.
 *
 *   - `ccaudit ghost --interactive` under CCAUDIT_NO_INTERACTIVE=1 | =true:
 *     exit 2, stderr contains "refusing: CCAUDIT_NO_INTERACTIVE is set".
 *   - `ccaudit restore --interactive` under CCAUDIT_NO_INTERACTIVE=1:
 *     same exit 2, same message.
 *   - CCAUDIT_NO_INTERACTIVE=0 does NOT trigger the refusal (control).
 *   - Plain `ccaudit ghost` on a non-empty fixture with NO_INTERACTIVE=1:
 *     exit 0 or 1 (ghosts present), no auto-open prompt in stdout.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditCli,
  runCcauditGhost,
  readJsonl,
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

/** Stage a home with 1 ghost agent so auto-open would normally trigger. */
async function stageHomeWithOneGhost(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  const agentPath = path.join(tmpHome, '.claude', 'agents', 'lonely-agent.md');
  await writeFile(agentPath, '# lonely-agent\n\nnever invoked\n', 'utf8');
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  await utimes(agentPath, sixtyDaysAgo, sixtyDaysAgo);

  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'ne');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'session-1.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/ne',
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionId: 'ne-session',
    }) + '\n',
    'utf8',
  );
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  await buildFakePs(tmpHome);
}

describe.skipIf(process.platform === 'win32')(
  'Phase 9 SC2 — CCAUDIT_NO_INTERACTIVE refuses --interactive and silences auto-open',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await stageHomeWithOneGhost(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('`ghost --interactive` with CCAUDIT_NO_INTERACTIVE=1: exit 2 + refusal on stderr', async () => {
      const result = await runCcauditCli(tmpHome, ['ghost', '--interactive'], {
        env: { CCAUDIT_NO_INTERACTIVE: '1', CCAUDIT_FORCE_TTY: '1' },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('refusing: CCAUDIT_NO_INTERACTIVE is set');
    });

    it('`ghost --interactive` with CCAUDIT_NO_INTERACTIVE=true (case-insensitive): exit 2', async () => {
      const result = await runCcauditCli(tmpHome, ['ghost', '--interactive'], {
        env: { CCAUDIT_NO_INTERACTIVE: 'TRUE', CCAUDIT_FORCE_TTY: '1' },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('refusing: CCAUDIT_NO_INTERACTIVE is set');
    });

    it('`ghost --interactive` with CCAUDIT_NO_INTERACTIVE=0: NOT refused (control)', async () => {
      // Without CCAUDIT_FORCE_TTY, the --interactive path hits the non-TTY
      // fallback (effectiveDryRun=true). What matters: no exit 2, no refusal.
      const result = await runCcauditCli(tmpHome, ['ghost', '--interactive'], {
        env: { CCAUDIT_NO_INTERACTIVE: '0' },
      });
      expect(result.exitCode, `stderr:\n${result.stderr}`).not.toBe(2);
      expect(result.stderr).not.toContain('refusing: CCAUDIT_NO_INTERACTIVE is set');
    });

    it('`restore --interactive` with CCAUDIT_NO_INTERACTIVE=1: exit 2 + refusal on stderr', async () => {
      const result = await runCcauditCli(tmpHome, ['restore', '--interactive'], {
        env: { CCAUDIT_NO_INTERACTIVE: '1', CCAUDIT_FORCE_TTY: '1' },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('refusing: CCAUDIT_NO_INTERACTIVE is set');
    });

    it('(M3) `ghost --interactive` with CCAUDIT_NO_INTERACTIVE=1: finally block runs and history.jsonl is written', async () => {
      // M3 fix: process.exitCode = 2; return; instead of process.exit(2).
      // The finally block must now execute, meaning recordHistory is called and
      // history.jsonl receives an entry for this ghost invocation.
      const result = await runCcauditCli(tmpHome, ['ghost', '--interactive'], {
        env: { CCAUDIT_NO_INTERACTIVE: '1', CCAUDIT_FORCE_TTY: '1' },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('refusing: CCAUDIT_NO_INTERACTIVE is set');

      // The finally block writes history — assert the file exists and has an entry.
      const historyPath = path.join(tmpHome, '.claude', 'ccaudit', 'history.jsonl');
      expect(existsSync(historyPath), `history.jsonl not found at ${historyPath}`).toBe(true);

      const lines = await readJsonl(historyPath);
      // history.jsonl format: line 0 is the HistoryHeader, line 1+ are HistoryEntry records.
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // The entry must record a 'ghost' command invocation.
      const entry = lines.find(
        (l) => (l as Record<string, unknown>)['record_type'] === 'entry',
      ) as Record<string, unknown>;
      expect(entry, 'expected a history entry record').toBeDefined();
      expect(entry['command']).toBe('ghost');
      expect(entry['exit_code']).toBe(2);
    });

    it('plain `ghost` with CCAUDIT_NO_INTERACTIVE=1: no auto-open prompt in stdout', async () => {
      const spawned = runCcauditGhost(tmpHome, [], {
        env: { CCAUDIT_NO_INTERACTIVE: '1' },
        timeout: 15_000,
      });
      spawned.child.stdin?.end();
      const result = await spawned.done;

      expect(result.stdout).not.toMatch(/open interactive picker/i);
      expect(result.stdout).not.toContain('[Y/n]');
      // Exit is 0 (no ghosts) or 1 (ghosts present); we only assert we did not refuse.
      expect(result.exitCode).not.toBe(2);
    });
  },
);
