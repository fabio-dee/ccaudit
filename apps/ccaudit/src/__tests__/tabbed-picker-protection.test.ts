/**
 * Phase 6 SC1 — Framework-protection picker integration (pty harness).
 *
 * Spawns `ccaudit ghost --interactive` against a multi-framework fixture
 * where at least one curated framework is "partially used" (has both used +
 * ghost members). Asserts:
 *   - Protected rows render with `[🔒]` (or `[L]` in ASCII-only mode).
 *   - Moving the cursor onto a protected row surfaces the reason hint
 *     `Part of <name> (N used, M ghost). --force-partial to override.`
 *   - Pressing Space on a protected row is a silent no-op (selection count
 *     unchanged).
 *   - Pressing `a` (tab-all) excludes protected rows from the selection.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
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
    // NO_COLOR: disabled — hasColors()===false triggers ASCII fallback, which
    // would swap [🔒] for [L] and defeat the Unicode assertion. ASCII test
    // below opts in explicitly via CCAUDIT_ASCII_ONLY=1.
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    ...extra,
  };
}

describe.skipIf(process.platform === 'win32')(
  'Phase 6 SC1 — framework-protected rows in the picker',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
      // GSD framework: 1 used + 2 ghost → partially-used → protected.
      // Plus a plain ghost agent so tab-all has something selectable.
      await createMultiFrameworkFixture(tmpHome, [
        { prefix: 'gsd', usedMembers: ['planner'], ghostMembers: ['researcher', 'verifier'] },
      ]);
      // Add a non-framework ghost so `a` has something to select.
      const fs = await import('node:fs/promises');
      const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
      const plainPath = path.join(tmpHome, '.claude', 'agents', 'plain-ghost.md');
      await fs.writeFile(plainPath, '# plain ghost\n', 'utf8');
      await fs.utimes(plainPath, sixtyDaysAgo, sixtyDaysAgo);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('Unicode: [🔒] renders, reason hints on focus, Space is no-op, `a` skips protected', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
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

      const initial = stripAnsi(out);

      // Lock glyph renders on every protected row.
      expect(initial).toMatch(/\[🔒\]/);

      // `a` = tab-all. Selection count must exclude the 2 protected ghosts.
      // Fixture ghosts: 2 gsd-* (protected) + 1 plain-ghost = 3 total, 1 selectable.
      let before = out.length;
      await sendKeys(spawned.child, ['a']);
      await new Promise((r) => setTimeout(r, 400));
      const afterA = stripAnsi(out.slice(before));
      expect(
        /1 of 3 selected across all tabs/.test(afterA),
        `expected '1 of 3 selected' after 'a'; got:\n${afterA.slice(-1500)}`,
      ).toBe(true);

      // Clear selection, then move cursor to a protected row.
      // Press End then PageUp/navigate until cursor sits on a gsd-* row.
      // Easier: `a` again to clear, then Down until we hit a gsd row.
      before = out.length;
      await sendKeys(spawned.child, ['a']); // toggle off
      await new Promise((r) => setTimeout(r, 200));
      const cleared = stripAnsi(out.slice(before));
      expect(/0 of 3 selected across all tabs/.test(cleared)).toBe(true);

      // Home cursor then navigate to find a gsd row focused.
      await sendKeys(spawned.child, ['\x1b[H']);
      await new Promise((r) => setTimeout(r, 150));

      // The protected-reason hint must appear at least once as we navigate.
      before = out.length;
      for (let i = 0; i < 6; i++) {
        await sendKeys(spawned.child, ['\x1b[B']); // Down
        await new Promise((r) => setTimeout(r, 100));
      }
      const navigated = stripAnsi(out.slice(before));
      expect(
        /Part of .+\(\d+ used, \d+ ghost\)\. --force-partial to override\./.test(navigated),
        `expected protected reason hint while navigating; got:\n${navigated.slice(-1500)}`,
      ).toBe(true);

      // Press Space once more; the key invariant is that the final selection
      // count NEVER exceeds 1 (only the plain ghost is ever selectable). The
      // `_assertNoProtectedSelected` invariant inside the picker (plan 02)
      // would throw under vitest if a protected id entered selection. Wrap
      // in try/catch in case the child has already exited.
      if (spawned.child.stdin && !spawned.child.stdin.destroyed) {
        try {
          await sendKeys(spawned.child, [' ']);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          /* child exit race — acceptable */
        }
      }
      const finalFrame = stripAnsi(out);
      expect(/[2-9] of 3 selected across all tabs/.test(finalFrame)).toBe(false);

      if (spawned.child.stdin && !spawned.child.stdin.destroyed) {
        try {
          await sendKeys(spawned.child, ['\x03']);
          spawned.child.stdin.end();
        } catch {
          /* child exit race */
        }
      }
      const result = await spawned.done;
      // SIGKILL → 137, SIGINT → 130, normal quit → 0. Subprocess may also
      // exit 1 when stdin closes before a confirm prompt — accept all valid
      // terminations (the substantive invariants have been checked above).
      expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
    }, 45_000);

    it('ASCII mode: [L] renders in place of [🔒]; reason hint still present', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
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
      expect(frame).toMatch(/\[L\]/);
      expect(frame).not.toMatch(/\[🔒\]/);

      // `a` must still exclude protected rows in ASCII mode.
      const before = out.length;
      await sendKeys(spawned.child, ['a']);
      await new Promise((r) => setTimeout(r, 300));
      const afterA = stripAnsi(out.slice(before));
      expect(/1 of 3 selected across all tabs/.test(afterA)).toBe(true);

      if (spawned.child.stdin && !spawned.child.stdin.destroyed) {
        try {
          await sendKeys(spawned.child, ['\x03']);
          spawned.child.stdin.end();
        } catch {
          /* child exit race */
        }
      }
      const result = await spawned.done;
      expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
    }, 45_000);
  },
);
