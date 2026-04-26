/**
 * Regression guard for the Phase 8.1 memory-restore blocker.
 *
 * The picker already surfaced MEMORY rows, but the subset executor still
 * resolved selected ids against dedupManifestOps(), which drops flag/refresh
 * ops. That let a mixed selection (agents + memory) confirm successfully while
 * silently discarding the memory op before execution.
 *
 * These end-to-end tests drive the real TUI and assert both the human-rendered
 * and --json paths execute the selected memory item for real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
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

interface RestoreJsonEnvelope {
  meta: { command: string; exitCode: number };
  status: string;
  counts: {
    unarchived: { moved: number; alreadyAtSource: number; failed: number };
    reenabled: { completed: number; failed: number };
    stripped: { completed: number; failed: number };
  };
  selection_filter: { mode: string; ids: string[] } | null;
}

function spawnRestoreInteractive(tmpHome: string, extraArgs: string[] = []): SpawnedRestore {
  const child = spawn(process.execPath, [distPath, 'restore', '--interactive', ...extraArgs], {
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

async function selectAgentsAndMemoryAndConfirm(child: ChildProcess): Promise<void> {
  // AGENTS tab is focused first. Toggle all 3 archived agents, move to MEMORY,
  // toggle the flagged memory row, submit, then flip clack's confirm from No → Yes.
  await sendKeys(child, ['a'], 100);
  await sendKeys(child, ['\x1b[C'], 125);
  await sendKeys(child, [' '], 100);
  await sendKeys(child, ['\r'], 200);
  await new Promise((r) => setTimeout(r, 300));
  await sendKeys(child, ['\x1b[D'], 100);
  await sendKeys(child, ['\r'], 100);
}

/* eslint-disable no-control-regex -- ANSI stripping requires literal escape bytes */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

function extractJsonLine(stdout: string): string {
  const lines = stripAnsi(stdout)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  const jsonLine = lines.at(-1);
  if (jsonLine === undefined) {
    throw new Error(`no JSON line found in interactive stdout:\n${stripAnsi(stdout).slice(-1000)}`);
  }
  return jsonLine;
}

describe.skipIf(process.platform === 'win32')('restore --interactive memory round-trip', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await stageRestoreInteractiveFixture(tmpHome);
    await buildFakePs(tmpHome);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('restores the selected memory item and preserves mtime in the rendered flow', async () => {
    const baselineManifests = await listManifestsDir(tmpHome);
    const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
    const beforeMemoryStat = await stat(memoryPath);

    const spawned = spawnRestoreInteractive(tmpHome);
    await waitForPicker(spawned.child);
    expect(spawned.child.exitCode, 'subprocess exited before we sent keystrokes').toBeNull();

    await selectAgentsAndMemoryAndConfirm(spawned.child);
    const result = await spawned.done;
    const plain = stripAnsi(result.stdout).replace(/\r/g, '\n');

    expect(
      result.exitCode,
      `restore --interactive exited with ${result.exitCode}\nstderr:\n${result.stderr.slice(-1000)}\nstdout:\n${plain.slice(-1000)}`,
    ).toBe(0);

    for (const fileName of ['pencil-dev.md', 'pencil-review.md', 'code-reviewer.md']) {
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', fileName))).toBe(true);
    }
    const archivedAfter = await readdir(
      path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents'),
    ).catch(() => [] as string[]);
    expect(archivedAfter).toEqual([]);

    const memoryAfter = await readFile(memoryPath, 'utf8');
    expect(memoryAfter).not.toContain('ccaudit-stale');
    expect(memoryAfter).not.toContain('ccaudit-flagged');
    const afterMemoryStat = await stat(memoryPath);
    expect(Math.abs(afterMemoryStat.mtimeMs - beforeMemoryStat.mtimeMs)).toBeLessThan(1);

    expect(plain).toContain('3 agents/skills restored to their original locations');
    expect(plain).toContain('1 memory files cleaned (ccaudit flags removed)');

    const postManifests = await listManifestsDir(tmpHome);
    expect(postManifests).toEqual(baselineManifests);
  }, 20_000);

  it('interactive --json keeps selection_filter aligned with executed memory ops', async () => {
    const baselineManifests = await listManifestsDir(tmpHome);
    const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');

    const spawned = spawnRestoreInteractive(tmpHome, ['--json']);
    await waitForPicker(spawned.child);
    expect(spawned.child.exitCode, 'subprocess exited before we sent keystrokes').toBeNull();

    await selectAgentsAndMemoryAndConfirm(spawned.child);
    const result = await spawned.done;
    expect(
      result.exitCode,
      `restore --interactive --json exited with ${result.exitCode}\nstderr:\n${result.stderr.slice(-1000)}\nstdout:\n${stripAnsi(result.stdout).slice(-1000)}`,
    ).toBe(0);

    const parsed = JSON.parse(extractJsonLine(result.stdout)) as RestoreJsonEnvelope;
    expect(parsed.meta.command).toBe('restore');
    expect(parsed.meta.exitCode).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.selection_filter).not.toBeNull();
    expect(parsed.selection_filter?.mode).toBe('subset');
    expect(parsed.selection_filter?.ids).toHaveLength(4);
    // M8: canonical_id for memory ops now includes op_type + op_id for uniqueness (INV-S3).
    // The fixture flag op has op_id='op-stale-memo-flag'; match by prefix to avoid
    // hardcoding the full id while still verifying the memory file is included.
    expect(
      parsed.selection_filter?.ids.some((id) => id.startsWith(`memory:flag:${memoryPath}:`)),
    ).toBe(true);
    expect(parsed.counts.unarchived.moved).toBe(3);
    expect(parsed.counts.stripped.completed).toBe(1);

    const memoryAfter = await readFile(memoryPath, 'utf8');
    expect(memoryAfter).not.toContain('ccaudit-stale');
    expect(memoryAfter).not.toContain('ccaudit-flagged');

    const postManifests = await listManifestsDir(tmpHome);
    expect(postManifests).toEqual(baselineManifests);
  }, 20_000);
});
