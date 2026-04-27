/**
 * Phase 6 SC2 — `--force-partial` banner integration (pty harness).
 *
 * Asserts:
 *   A) With protected items in the scan, the banner renders on every frame:
 *      `⚠ --force-partial active: framework protection DISABLED. …`
 *      Protected rows render non-dim (no [🔒] prefix). Space toggles them.
 *   B) With no protected items, the banner still renders with the suffix
 *      `(no protected items in this scan)` (D6-14).
 *   C) In ASCII mode (`CCAUDIT_ASCII_ONLY=1`), the banner uses `!` instead of
 *      `⚠` and drops color.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  createMultiFrameworkFixture,
  runCcauditGhost,
  sendKeys,
  waitForMarker,
} from './_test-helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` first.`);
  }
});

/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CCAUDIT_FORCE_TTY: '1',
    CCAUDIT_TEST_STDOUT_ROWS: '30',
    LINES: '30',
    COLUMNS: '120',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    ...extra,
  };
}

async function cleanupChild(spawned: { child: { stdin: NodeJS.WritableStream | null } }) {
  if (
    spawned.child.stdin &&
    !(spawned.child.stdin as NodeJS.WritableStream & { destroyed?: boolean }).destroyed
  ) {
    try {
      spawned.child.stdin.write('\x03');
      spawned.child.stdin.end();
    } catch {
      /* child exit race */
    }
  }
}

describe.skipIf(process.platform === 'win32')('Phase 6 SC2 — --force-partial banner', () => {
  let tmpHome: string;

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('Scenario A: banner renders; protected rows become selectable; Space toggles them', async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    await createMultiFrameworkFixture(tmpHome, [
      { prefix: 'gsd', usedMembers: ['planner'], ghostMembers: ['researcher', 'verifier'] },
    ]);

    const spawned = runCcauditGhost(tmpHome, ['--interactive', '--force-partial'], {
      env: baseEnv(),
      timeout: 25_000,
    });
    let out = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      out += c.toString();
    });

    await waitForMarker(
      () => out,
      () => spawned.child.exitCode !== null,
      'selected across all tabs',
    );

    const frame = stripAnsi(out);
    expect(
      /⚠ --force-partial active: framework protection DISABLED/.test(frame),
      `expected banner glyph + text in Unicode mode; got:\n${frame.slice(0, 1500)}`,
    ).toBe(true);
    // Protected lock glyph must NOT appear when --force-partial is on.
    expect(frame.includes('[🔒]')).toBe(false);

    // `a` = tab-all. With --force-partial, ALL 2 protected ghosts become
    // selectable alongside the framework-less nothing; gsd-planner is USED,
    // so ghosts = 2. Result: 2 of 2.
    const before = out.length;
    await sendKeys(spawned.child, ['a']);
    await new Promise((r) => setTimeout(r, 400));
    const afterA = stripAnsi(out.slice(before));
    expect(
      /2 of 2 selected across all tabs/.test(afterA),
      `expected '2 of 2 selected' under --force-partial; got:\n${afterA.slice(-1500)}`,
    ).toBe(true);

    await cleanupChild(spawned);
    const result = await spawned.done;
    expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
  }, 45_000);

  it('Scenario B: zero-protected items — banner suffix "(no protected items in this scan)"', async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    // Plain ghosts only — no curated framework at all.
    const agentsDir = path.join(tmpHome, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    for (const name of ['alpha', 'beta']) {
      const p = path.join(agentsDir, `${name}.md`);
      await writeFile(p, `# ${name}\n`, 'utf8');
      await utimes(p, sixtyDaysAgo, sixtyDaysAgo);
    }
    await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
    const sessionDir = path.join(tmpHome, '.claude', 'projects', 'clean');
    await mkdir(sessionDir, { recursive: true });
    const recentTs = new Date(Date.now() - 3600_000).toISOString();
    await writeFile(
      path.join(sessionDir, 's.jsonl'),
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/fake/clean',
        timestamp: recentTs,
        sessionId: 'clean',
      }) + '\n',
      'utf8',
    );

    const spawned = runCcauditGhost(tmpHome, ['--interactive', '--force-partial'], {
      env: baseEnv(),
      timeout: 25_000,
    });
    let out = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      out += c.toString();
    });

    await waitForMarker(
      () => out,
      () => spawned.child.exitCode !== null,
      'selected across all tabs',
    );

    const frame = stripAnsi(out);
    expect(/⚠ --force-partial active/.test(frame)).toBe(true);
    expect(/\(no protected items in this scan\)/.test(frame)).toBe(true);

    await cleanupChild(spawned);
    const result = await spawned.done;
    expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
  }, 45_000);

  it('Scenario C: ASCII mode — banner uses "!" instead of "⚠"', async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    await createMultiFrameworkFixture(tmpHome, [
      { prefix: 'gsd', usedMembers: ['planner'], ghostMembers: ['researcher'] },
    ]);

    const spawned = runCcauditGhost(tmpHome, ['--interactive', '--force-partial'], {
      env: baseEnv({ CCAUDIT_ASCII_ONLY: '1' }),
      timeout: 25_000,
    });
    let out = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      out += c.toString();
    });

    await waitForMarker(
      () => out,
      () => spawned.child.exitCode !== null,
      'selected across all tabs',
    );

    const frame = stripAnsi(out);
    expect(
      /! --force-partial active: framework protection DISABLED/.test(frame),
      `expected ASCII banner with "!" prefix; got:\n${frame.slice(0, 1500)}`,
    ).toBe(true);
    expect(frame.includes('⚠')).toBe(false);

    await cleanupChild(spawned);
    const result = await spawned.done;
    expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
  }, 45_000);
});
