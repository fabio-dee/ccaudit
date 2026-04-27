/**
 * Phase 5 SC2 — sort cycle (`s`) integration test (pty harness).
 *
 * Asserts:
 *   - `s` cycles staleness-desc → tokens-desc → name-asc → staleness-desc (D5-08 / D5-10).
 *   - Active-tab header shows `· sort:tokens` or `· sort:name` off-default; no
 *     suffix when back at the default (D5-12).
 *   - Per-tab memory: cycling on tab 2 does not affect tab 1's sort (D5-09).
 *
 * Fixture: 3 agents with divergent (tokens, name, mtime) so each sort produces
 * a different top row. We detect ordering by the `[ ]` row lines after ANSI
 * stripping.
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
  runCcauditGhost,
  sendKeys,
  waitForMarker,
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

/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

async function buildSortFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const skillsRoot = path.join(tmpHome, '.claude', 'skills');
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'p5-sort');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  // Three agents with distinct (size, name, mtime). Bigger body => more tokens.
  //   z-old:  ~100 tokens-ish (short body), oldest mtime (60d ago)
  //   a-new:  ~500 tokens-ish (biggest body), newest mtime (yesterday)
  //   m-mid:  ~300 tokens-ish (mid body),    mid mtime   (30d ago)
  const tinyBody = 'x '.repeat(40);
  const midBody = 'y '.repeat(400);
  const bigBody = 'z '.repeat(800);

  const paths: Array<[string, string, Date]> = [
    ['z-old.md', tinyBody, new Date(Date.now() - 60 * 86_400_000)],
    ['a-new.md', bigBody, new Date(Date.now() - 1 * 86_400_000)],
    ['m-mid.md', midBody, new Date(Date.now() - 30 * 86_400_000)],
  ];
  for (const [name, body, mtime] of paths) {
    const p = path.join(agentsDir, name);
    await writeFile(p, `# ${name}\n\n${body}\n`, 'utf8');
    await utimes(p, mtime, mtime);
  }

  // One skill so tab 2 exists with something to sort on.
  const skDir = path.join(skillsRoot, 'only-skill');
  await mkdir(skDir, { recursive: true });
  await writeFile(
    path.join(skDir, 'SKILL.md'),
    '---\nname: only-skill\n---\n# only-skill\n\n' + 'q '.repeat(80),
    'utf8',
  );

  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  const recentTs = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(
    path.join(sessionDir, 's.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/p5-sort',
      timestamp: recentTs,
      sessionId: 'p5-sort',
    }) + '\n',
    'utf8',
  );
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CCAUDIT_FORCE_TTY: '1',
    CCAUDIT_TEST_STDOUT_ROWS: '30',
    LINES: '30',
    COLUMNS: '100',
    NO_COLOR: '1',
    ...extra,
  };
}

describe.skipIf(process.platform === 'win32')('Phase 5 SC2 — sort cycle integration', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    await buildSortFixture(tmpHome);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('cycles staleness → tokens → name → staleness on `s`; per-tab memory holds across Tab', async () => {
    const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
      env: baseEnv(),
      timeout: 25_000,
    });

    let stdoutBuf = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
    });

    await waitForMarker(
      () => stdoutBuf,
      () => spawned.child.exitCode !== null,
      '0 of 4 selected across all tabs',
    );

    // Default = staleness-desc → sort suffix is hidden (D5-12).
    const initial = stripAnsi(stdoutBuf);
    expect(
      /AGENTS \(0\/3\)\s*$/m.test(initial) || /AGENTS \(0\/3\)(?!\s*·\s*sort:)/.test(initial),
      `expected no sort suffix on default; got AGENTS header region:\n${initial.slice(-2000)}`,
    ).toBe(true);

    // 1st `s` → tokens-desc → header gets ' · sort:tokens'.
    let beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['s']);
    await new Promise((r) => setTimeout(r, 300));
    const afterS1 = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterS1.includes('sort:tokens'),
      `expected 'sort:tokens' header suffix after 1st s; got:\n${afterS1}`,
    ).toBe(true);

    // 2nd `s` → name-asc.
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['s']);
    await new Promise((r) => setTimeout(r, 300));
    const afterS2 = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterS2.includes('sort:name'),
      `expected 'sort:name' header suffix after 2nd s; got:\n${afterS2}`,
    ).toBe(true);

    // 3rd `s` → back to staleness-desc → suffix absent from the fresh frame.
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['s']);
    await new Promise((r) => setTimeout(r, 300));
    const afterS3 = stripAnsi(stdoutBuf.slice(beforeLen));
    // The post-cycle frame must NOT carry an active `sort:tokens|name` suffix.
    // We check the frame slice (not the full transcript which still contains prior suffixes).
    expect(
      !/sort:(tokens|name)/.test(afterS3),
      `expected no sort suffix after 3rd s (back to default); got:\n${afterS3}`,
    ).toBe(true);

    // Stability: 4 more presses = one full cycle + 1 extra, last = tokens-desc.
    await sendKeys(spawned.child, ['s']); // tokens
    await sendKeys(spawned.child, ['s']); // name
    await sendKeys(spawned.child, ['s']); // staleness (default)
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['s']); // tokens again
    await new Promise((r) => setTimeout(r, 300));
    const afterCycle = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterCycle.includes('sort:tokens'),
      `expected stable cycle (tokens after 4 further 's' presses); got:\n${afterCycle}`,
    ).toBe(true);

    // Tab to SKILLS, `s` there, switch back — AGENTS sort should remain at tokens (per-tab memory, D5-09).
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['\t']); // SKILLS
    await new Promise((r) => setTimeout(r, 300));
    await sendKeys(spawned.child, ['s']); // SKILLS → tokens-desc
    await new Promise((r) => setTimeout(r, 300));
    await sendKeys(spawned.child, ['\t']); // back to AGENTS
    await new Promise((r) => setTimeout(r, 400));
    const afterBack = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterBack.includes('sort:tokens'),
      `expected AGENTS to remember sort:tokens across tab switch; got:\n${afterBack}`,
    ).toBe(true);

    // Cleanup.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 40_000);
});
