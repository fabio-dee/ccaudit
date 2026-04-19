/**
 * Phase 5 SC1 — filter (`/`) integration test (pty harness).
 *
 * Drives `ccaudit ghost --interactive` via the existing subprocess harness and
 * asserts that:
 *   - `/` opens filter input mode, footer shows `Filter: {q}_`.
 *   - typing narrows the active tab (footer: `Filtered: M of N visible | X selected`).
 *   - Space toggles a visible row; selection count reflects it.
 *   - `Esc` clears the filter AND exits filter mode (D5-05); selection preserved (D5-06).
 *   - Tab switch clears the filter (D5-03); SKILLS tab then shows all rows.
 *
 * ASCII mode (`NO_COLOR=1`) is assumed per the helper env; the separator between
 * `visible` and `selected` is `|` (not `·`) per D5-22 fallback.
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
  sendKeys,
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

/* eslint-disable no-control-regex -- ANSI stripping requires literal \x1b */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

async function buildPencilFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const skillsRoot = path.join(tmpHome, '.claude', 'skills');
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'p5-filter');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  // 3 agents — 2 with `pencil` in name, 1 with `compass`.
  for (const name of ['pencil-dev', 'pencil-prod', 'compass-dev']) {
    await writeFile(
      path.join(agentsDir, `${name}.md`),
      `# ${name}\n\n` + 'content content content. '.repeat(8),
      'utf8',
    );
  }

  // 3 skills — 2 without `pencil`, 1 with.
  for (const sk of ['foo', 'bar', 'pencil-note']) {
    const dir = path.join(skillsRoot, sk);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${sk}\n---\n# ${sk}\n\n` + 'body body body. '.repeat(8),
      'utf8',
    );
  }

  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  const recentTs = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(
    path.join(sessionDir, 's.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/p5-filter',
      timestamp: recentTs,
      sessionId: 'p5-filter',
    }) + '\n',
    'utf8',
  );
}

async function waitForMarker(
  getStdout: () => string,
  isExited: () => boolean,
  marker: string,
  maxWaitMs = 5_000,
): Promise<void> {
  const startMs = Date.now();
  let delayMs = 100;
  while (!isExited() && !getStdout().includes(marker) && Date.now() - startMs < maxWaitMs) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 500);
  }
  await new Promise((r) => setTimeout(r, 200));
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

describe.skipIf(process.platform === 'win32')('Phase 5 SC1 — filter integration', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    await buildPencilFixture(tmpHome);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('narrows visible rows when `/` + query typed; footer shows "Filter:" + "Filtered: M of N visible" (D5-01, D5-02)', async () => {
    const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
      env: baseEnv(),
      timeout: 20_000,
    });

    let stdoutBuf = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
    });

    // Initial render: total is 6 ghosts across 2 tabs.
    await waitForMarker(
      () => stdoutBuf,
      () => spawned.child.exitCode !== null,
      '0 of 6 selected across all tabs',
    );

    // Open filter + type "pencil". Assert on the cumulative transcript because
    // the terminal diff renderer suppresses unchanged lines between keystrokes;
    // the final `Filter: pen_` frame lives in the full stream.
    await sendKeys(spawned.child, ['/', 'p', 'e', 'n']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      'Filter: pen_',
    );

    const afterFilter = stripAnsi(stdoutBuf);
    expect(
      afterFilter.includes('Filter: pen_'),
      `expected filter prompt 'Filter: pen_'; got tail:\n${afterFilter.slice(-2000)}`,
    ).toBe(true);
    // AGENTS tab: 2 of 3 visible (pencil-dev, pencil-prod).
    expect(
      /Filtered:\s*2\s+of\s+3\s+visible/.test(afterFilter),
      `expected 'Filtered: 2 of 3 visible'; got tail:\n${afterFilter.slice(-2000)}`,
    ).toBe(true);

    // Tab key in filter-input mode exits filter-mode + switches tab AND clears
    // the departing tab's filter state per D5-03 — and unlike Enter/Esc it is
    // not aliased to submit/cancel by @clack/core's base dispatcher, so it is
    // safe to drive through a pty here.
    const beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['\t']);
    await new Promise((r) => setTimeout(r, 400));
    const afterTab = stripAnsi(stdoutBuf.slice(beforeLen));
    // SKILLS tab — 3 rows total. No `Filtered:` suffix (SKILLS is a fresh tab).
    expect(afterTab).not.toContain('Filtered:');
    expect(
      afterTab.includes('0 of 6 selected across all tabs'),
      `expected '0 of 6 selected …' on SKILLS tab; got:\n${afterTab}`,
    ).toBe(true);

    // Cleanup via Ctrl+C (Esc is aliased to cancel by @clack/core — see the
    // D5-05 / D5-13 KNOWN-GAP note below; Ctrl+C is the spec'd cancel key).
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 30_000);

  // KNOWN-GAP (two pre-existing Phase 5 bugs surfaced by pty coverage):
  //
  //   1. D5-05 "Esc in filter mode clears query + exits filter mode":
  //      @clack/core's base `onKeypress` unconditionally sets `state='cancel'`
  //      after running subclass key/cursor handlers (it maps escape→cancel via
  //      `u.aliases`, then runs `V([t, e?.name, e?.sequence],"cancel") &&
  //      (this.state="cancel")` at the end of onKeypress). Our subclass's
  //      `state='active'` re-assignments are overwritten, so Esc cancels the
  //      picker even while filter-input or help overlay is open.
  //
  //   2. D5-05 "Enter exits filter mode but keeps query active":
  //      Same defect class — @clack/core's base onKeypress unconditionally sets
  //      `state='submit'` on key name 'return'. Enter inside filter-input mode
  //      therefore submits the picker instead of closing the input while keeping
  //      the query live. Observed via a pty probe on Plan 05-05 Phase 4 dist:
  //      Enter after `/pen` submits the (empty) selection and prints "No changes
  //      made." on stderr.
  //
  //   Plan 05-05 Task 2 stipulates that test-revealed bugs be raised as gap-
  //   closure work, not fixed inline. The tests below mark those SC1 sub-cases
  //   as `.todo` pending a subsequent wave that overrides `onKeypress` in
  //   `TabbedGhostPicker` (or re-aliases escape/return via `updateSettings`
  //   from @clack/core) while helpOpen or filterMode is active.
  //
  //   In-source handler-level tests (tabbed-picker.ts:1648/1661) still pass
  //   because they drive the handler directly and bypass `onKeypress`.
  it.todo(
    'D5-05: Esc in filter mode clears query, exits filter mode, and preserves selection (BLOCKED by @clack/core escape→cancel alias)',
  );
  it.todo(
    'D5-05: Enter in filter mode exits filter mode but keeps query active (BLOCKED by @clack/core base onKeypress setting state=submit on return)',
  );
  it.todo(
    "D5-06: Space in filter-narrowed list toggles the current row (BLOCKED — requires exiting filter mode first, which currently either cancels (Esc) or submits (Enter) the picker)",
  );
});
