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

  // Phase 5 gap closure (D5-05, D5-06, D5-13): the three live tests below
  // replaced earlier `it.todo` markers once `TabbedGhostPicker.onKeypress`
  // was overridden to intercept escape/return while `filterMode` or
  // `helpOpen` is active, preventing `@clack/core`'s base dispatcher from
  // unconditionally flipping `state` to `'cancel'` / `'submit'`. The fix
  // is surgical: Ctrl+C still cancels (INV-S2), and escape/return outside
  // filter/help mode still cancel/submit per Phase 3.1 behavior.

  it('D5-05: Esc in filter mode clears the query and exits filter mode without canceling the picker', async () => {
    const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
      env: baseEnv(),
      timeout: 20_000,
    });

    let stdoutBuf = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
    });

    await waitForMarker(
      () => stdoutBuf,
      () => spawned.child.exitCode !== null,
      '0 of 6 selected across all tabs',
    );

    await sendKeys(spawned.child, ['/', 'p', 'e', 'n']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      'Filter: pen_',
    );
    const beforeEsc = stripAnsi(stdoutBuf);
    expect(beforeEsc).toContain('Filter: pen_');
    expect(/Filtered:\s*2\s+of\s+3\s+visible/.test(beforeEsc)).toBe(true);

    // Esc in filter mode: per D5-05 should clear the query AND exit filter
    // mode in one stroke. Critically, the picker must NOT cancel.
    const beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['\x1b']);
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned.child.exitCode).toBeNull();

    const afterEsc = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(afterEsc).not.toContain('No changes made');
    // Filter footer cleared → the full-inventory counter returns.
    expect(afterEsc.includes('0 of 6 selected across all tabs')).toBe(true);
    // And the `Filter: pen_` prompt is not reissued afterwards — the picker
    // is back in its normal (non-filter) state.
    expect(afterEsc).not.toContain('Filter: pen_');

    // Cleanup via Ctrl+C.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 30_000);

  it('D5-05: Enter in filter mode exits filter-input mode but keeps the narrowed view (query stays active)', async () => {
    const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
      env: baseEnv(),
      timeout: 20_000,
    });

    let stdoutBuf = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
    });

    await waitForMarker(
      () => stdoutBuf,
      () => spawned.child.exitCode !== null,
      '0 of 6 selected across all tabs',
    );

    await sendKeys(spawned.child, ['/', 'p', 'e', 'n']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      'Filter: pen_',
    );

    // Enter: exit filter-input mode, but the narrowed view (2 of 3) persists.
    // Picker must NOT submit.
    await sendKeys(spawned.child, ['\r']);
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned.child.exitCode).toBeNull();

    // Drive one more visible change (Space toggles the focused row) so the
    // renderer emits a new frame we can inspect. If Enter had (incorrectly)
    // submitted the picker, this Space keystroke would land on a closed
    // stdin and the exitCode would already be set.
    const beforeSpaceLen = stdoutBuf.length;
    await sendKeys(spawned.child, [' ']);
    await new Promise((r) => setTimeout(r, 400));
    const afterSpace = stripAnsi(stdoutBuf.slice(beforeSpaceLen));
    expect(spawned.child.exitCode).toBeNull();
    // The post-Space frame must still show the filter narrowing active
    // (`Filtered: 2 of 3 visible | 1 selected`), confirming Enter kept the
    // query live rather than submitting the picker.
    expect(stripAnsi(stdoutBuf)).not.toContain('No changes made');
    expect(/Filtered:\s*2\s+of\s+3\s+visible\s*\|\s*1\s+selected/.test(afterSpace)).toBe(true);

    // Cleanup via Ctrl+C.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 30_000);

  it('D5-06: after Enter-exits-filter-input, Space toggles the current visible row; selection preserved across Esc-clear', async () => {
    const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
      env: baseEnv(),
      timeout: 20_000,
    });

    let stdoutBuf = '';
    spawned.child.stdout!.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
    });

    await waitForMarker(
      () => stdoutBuf,
      () => spawned.child.exitCode !== null,
      '0 of 6 selected across all tabs',
    );

    // Enter filter, type, Enter to exit filter-input mode keeping query live.
    await sendKeys(spawned.child, ['/', 'p', 'e', 'n']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      'Filter: pen_',
    );
    await sendKeys(spawned.child, ['\r']);
    await new Promise((r) => setTimeout(r, 300));

    // Space toggles the row under the cursor in the narrowed list. While a
    // filter is active the footer renders `Filtered: M of N visible | X
    // selected` (per D5-01) — NOT the full-inventory `X of 6 selected` form.
    await sendKeys(spawned.child, [' ']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      'Filtered: 2 of 3 visible | 1 selected',
    );
    const afterSpace = stripAnsi(stdoutBuf);
    expect(afterSpace).toContain('Filtered: 2 of 3 visible | 1 selected');

    // Re-enter filter mode and Esc-clear from there; selection preserved
    // across the filter clear (D5-06).
    await sendKeys(spawned.child, ['/']);
    await new Promise((r) => setTimeout(r, 200));
    const beforeClearLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['\x1b']);
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned.child.exitCode).toBeNull();
    const afterClear = stripAnsi(stdoutBuf.slice(beforeClearLen));
    // Once filter is cleared, counter returns to `X of 6 selected` form;
    // selection of 1 item survives.
    expect(afterClear.includes('1 of 6 selected')).toBe(true);

    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 30_000);
});
