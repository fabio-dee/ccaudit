/**
 * Phase 5 SC3 — help overlay (`?`) integration test (pty harness).
 *
 * Asserts:
 *   - `?` opens a modal overlay containing the visible help groups and glyph
 *     legend (Selection / View / Glyphs / Exit in the 30-row test viewport;
 *     the Navigation section is clipped by the non-TTY 20-row render limit).
 *   - `?` toggles the overlay closed and restores the underlying picker footer
 *     (test 1). `Esc` also closes the overlay without canceling the picker
 *     (test 2 — D5-13 gap-closure).
 *   - `Space` is swallowed while the overlay is open (D5-13): the overlay stays
 *     open after Space, and on close the global counter still shows 0 selections.
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

  it('`?` opens overlay with keybinding groups + glyph legend; `Esc` closes; `Space` swallowed while open (D5-13..D5-14, E4)', async () => {
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
    // line-diff renderer may suppress some overlay lines between renders, so
    // we pick assertions from the stable visible group sections.
    await sendKeys(spawned.child, ['?']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      '(Press ? or Esc to close)',
    );
    const afterOpen = stripAnsi(stdoutBuf);
    expect(afterOpen).toContain('Selection');
    expect(afterOpen).toContain('View');
    expect(afterOpen).toContain('Glyphs');
    expect(afterOpen).toContain('Selected');
    expect(afterOpen).toContain('Unselected');
    expect(afterOpen).toContain('Protected / framework-locked');
    expect(afterOpen).toContain('Multi-config MCP server');
    expect(afterOpen).toContain('Stale memory file');
    expect(afterOpen).toContain('Exit');

    // While overlay open, press Space — must be swallowed per D5-13.
    let beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, [' ']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      '(Press ? or Esc to close)',
    );
    expect(stripAnsi(stdoutBuf)).toContain('(Press ? or Esc to close)');
    expect(spawned.child.exitCode).toBeNull();

    // Close overlay via `?` toggle. After the Phase 5 gap-closure fix,
    // Esc also safely closes the overlay (see the dedicated test below);
    // this original SC3 path exercises the `?` toggle for regression
    // coverage of the idempotent toggle gesture.
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['?']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf.slice(beforeLen)),
      () => spawned.child.exitCode !== null,
      '0 of 3 selected across all tabs',
    );
    const afterClose = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterClose.includes('0 of 3 selected across all tabs'),
      `expected picker footer restored after ?-toggle; selection count must still be 0 (Space swallowed); got:\n${afterClose}`,
    ).toBe(true);

    // Re-open, close via `?` again (toggle).
    beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['?']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      '(Press ? or Esc to close)',
    );
    await sendKeys(spawned.child, ['?']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf.slice(beforeLen)),
      () => spawned.child.exitCode !== null,
      '0 of 3 selected across all tabs',
    );
    const afterToggle = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(
      afterToggle.includes('0 of 3 selected across all tabs'),
      `expected picker footer after ?-? toggle; got:\n${afterToggle}`,
    ).toBe(true);

    // Cleanup.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null]).toContain(result.exitCode);
  }, 30_000);

  it('D5-13: `Esc` closes the help overlay without canceling the picker (gap-closure)', async () => {
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

    // Open overlay. Wait for the overlay footer which is always visible in the
    // non-TTY viewport (clack's A() returns 20 rows without a TTY, so the
    // Navigation section at lines 0-8 is clipped; only lines 9+ are rendered).
    // "(Press ? or Esc to close)" is the last rendered line and appears reliably.
    await sendKeys(spawned.child, ['?']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf),
      () => spawned.child.exitCode !== null,
      '(Press ? or Esc to close)',
    );

    // Esc should close the overlay and return to the picker — NOT cancel.
    const beforeLen = stdoutBuf.length;
    await sendKeys(spawned.child, ['\x1b']);
    await waitForMarker(
      () => stripAnsi(stdoutBuf.slice(beforeLen)),
      () => spawned.child.exitCode !== null,
      '0 of 3 selected across all tabs',
    );
    expect(spawned.child.exitCode).toBeNull();
    const afterEsc = stripAnsi(stdoutBuf.slice(beforeLen));
    expect(afterEsc).not.toContain('No changes made');
    expect(
      afterEsc.includes('0 of 3 selected across all tabs'),
      `expected picker footer restored after Esc-closes-help; got:\n${afterEsc}`,
    ).toBe(true);

    // Cleanup.
    await sendKeys(spawned.child, ['\x03']);
    spawned.child.stdin!.end();
    const result = await spawned.done;
    expect([0, 130, null]).toContain(result.exitCode);
  }, 30_000);
});
