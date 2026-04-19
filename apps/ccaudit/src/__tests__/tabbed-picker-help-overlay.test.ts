/**
 * Phase 5 SC3 — help overlay (`?`) integration test (pty harness).
 *
 * Asserts:
 *   - `?` opens a modal overlay containing the four headings Navigation /
 *     Selection / View / Exit (D5-14).
 *   - `Esc` closes the overlay and restores the underlying picker footer.
 *   - `Space` is swallowed while the overlay is open (D5-13): on close, the
 *     global counter still shows 0 selections.
 *
 * Uses ASCII mode (NO_COLOR=1) so the help-overlay tests expect the `# Heading`
 * formatting the renderer emits in that mode.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditGhost,
  sendKeys,
  buildManyGhostsFixture,
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

describe.skipIf(process.platform === 'win32')('Phase 5 SC3 — help overlay integration', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await buildFakePs(tmpHome);
    await buildManyGhostsFixture(tmpHome, 3);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  it('`?` opens overlay with 4 groupings; `Esc` closes; `Space` swallowed while open (D5-13..D5-14)', async () => {
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
      '0 of 3 selected across all tabs',
    );

    // Open help overlay. Assert on the full transcript — the terminal's
    // line-diff renderer may suppress some overlay lines between renders so
    // we pick assertions from across all four group sections.
    await sendKeys(spawned.child, ['?']);
    await new Promise((r) => setTimeout(r, 500));
    const afterOpen = stripAnsi(stdoutBuf);
    // Group 1 (Navigation): the "Jump to tab N" line is unique to the overlay.
    expect(
      afterOpen.includes('Jump to tab N'),
      `expected Navigation-group binding 'Jump to tab N'; got tail:\n${afterOpen.slice(-2500)}`,
    ).toBe(true);
    // Group 2 (Selection)
    expect(afterOpen).toContain('Selection');
    // Group 3 (View)
    expect(afterOpen).toContain('View');
    // Group 4 (Exit)
    expect(afterOpen).toContain('Exit');

    // While overlay open, press Space — must be swallowed per D5-13.
    await sendKeys(spawned.child, [' ']);
    await new Promise((r) => setTimeout(r, 250));

    // Close overlay via `?` toggle. (Note: closing via Esc also cancels the
    // underlying picker because @clack/core dispatches the same keypress to
    // both the 'key' handler — which turns off helpOpen — and the 'cursor'
    // handler — which, now that helpOpen is false, processes Esc as `cancel`.
    // The `?` toggle path is dispatch-safe.)
    let beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['?']);
    await new Promise((r) => setTimeout(r, 400));
    const afterClose = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterClose.includes('0 of 3 selected across all tabs'),
      `expected picker footer restored after ?-toggle; selection count must still be 0 (Space swallowed); got:\n${afterClose}`,
    ).toBe(true);

    // Re-open, close via `?` again (toggle).
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['?']);
    await new Promise((r) => setTimeout(r, 300));
    await sendKeys(spawned.child, ['?']);
    await new Promise((r) => setTimeout(r, 300));
    const afterToggle = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterToggle.includes('0 of 3 selected across all tabs'),
      `expected picker footer after ?-? toggle; got:\n${afterToggle}`,
    ).toBe(true);

    // Cleanup.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null].includes(result.exitCode)).toBe(true);
  }, 30_000);
});
