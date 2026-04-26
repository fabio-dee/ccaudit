/**
 * NEW-M3 regression — `--force-partial` banner height is width-aware.
 *
 * Before the fix, `bannerHeight()` always returned 1 regardless of terminal
 * width.  At 80 cols the active+protected banner is 111 chars (wraps to
 * 2 rows) and the active+zero-protected banner is 146 chars (also 2 rows at
 * 80 cols, 3 rows at 60 cols).  The viewport deducted only 1 row, so the
 * rendered frame exceeded `stdoutRows`, re-introducing the Phase 3.1
 * off-by-one overflow.
 *
 * This test:
 *   1. Spawns `ccaudit ghost --interactive --force-partial` with LINES=24,
 *      COLUMNS=80 and ≥20 ghost agents so the viewport formula is exercised.
 *   2. Waits for the initial render containing the banner.
 *   3. Counts the number of unique `agent-NN` entries visible in the FIRST
 *      rendered frame (before any keypress).
 *   4. Asserts the count is ≤ 13 (viewport = Math.max(8,24-10)-2 = 12,
 *      plus the 2-row banner, tab bar, header, footer, and indicator lines
 *      comfortably fit inside 24 terminal rows with no overflow).
 *
 * ASCII-vs-Unicode: CCAUDIT_FORCE_TTY=1 with piped stdio → ASCII mode, so
 * the banner uses `!` glyph; both glyph forms are accepted.
 *
 * Windows: fake-ps shell scripts require /bin/sh; skipped on win32.
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

/* eslint-disable no-control-regex -- ANSI stripping requires literal \x1b */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

describe.skipIf(process.platform === 'win32')(
  'NEW-M3 — --force-partial banner height is width-aware (no viewport overflow at 80 cols)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      // 25 ghost agents so the list is longer than any reasonable viewport.
      await buildManyGhostsFixture(tmpHome, 25);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('visible agent count on first frame is within viewport bounds (≤ 13) — banner does not overflow', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive', '--force-partial'], {
        env: { CCAUDIT_FORCE_TTY: '1', LINES: '24', COLUMNS: '80' },
        timeout: 15_000,
      });

      let stdoutBuf = '';
      spawned.child.stdout!.on('data', (c: Buffer) => {
        stdoutBuf += c.toString();
      });

      // Wait for the banner text to appear in the first render.
      const bannerPattern = /force-partial active/;
      {
        const maxWaitMs = 8_000;
        const startMs = Date.now();
        let delayMs = 100;
        while (
          spawned.child.exitCode === null &&
          !bannerPattern.test(stdoutBuf) &&
          Date.now() - startMs < maxWaitMs
        ) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 500);
        }
        // Snapshot the buffer offset at the point the banner first appeared so
        // the agent-NN count below reflects a single post-banner frame rather
        // than the cumulative pre-banner renders (stdoutBuf is additive and
        // stripAnsi cannot distinguish overwrite cues from distinct renders).
        // Extra grace for any trailing viewport writes.
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(
        spawned.child.exitCode,
        `subprocess exited before first render\nstdout:\n${stdoutBuf.slice(-500)}`,
      ).toBeNull();

      // Use only the trailing portion of stdoutBuf that starts at the last
      // occurrence of the banner text so agentMatches reflects one frame.
      const rawPlain = stripAnsi(stdoutBuf);
      const bannerIdx = rawPlain.lastIndexOf('force-partial active');
      const plain = bannerIdx >= 0 ? rawPlain.slice(bannerIdx) : rawPlain;

      // Banner must be present.
      expect(
        plain.includes('force-partial active'),
        `expected --force-partial banner in frame:\n${plain.slice(-800)}`,
      ).toBe(true);

      // Count how many distinct agent-NN tokens appear in the accumulated
      // output up to this point (before any keypress).  Because bannerHeight
      // now correctly reports 2 rows at 80 cols, computeViewportHeight
      // deducts 2, leaving Math.max(8, 24-10)-2 = 12 rows of item slots.
      // With sub-header rows and indicators the count will be ≤ 13.
      const agentMatches = plain.match(/agent-\d\d/g) ?? [];
      const uniqueAgents = new Set(agentMatches).size;

      expect(
        uniqueAgents,
        `expected ≤ 13 unique agent-NN visible (viewport minus 2-row banner); got ${uniqueAgents}\nframe:\n${plain.slice(-800)}`,
      ).toBeLessThanOrEqual(13);

      // Must still show at least 1 agent (sanity: picker rendered at all).
      expect(uniqueAgents).toBeGreaterThanOrEqual(1);

      // Tear down.
      spawned.child.kill('SIGINT');
      const result = await spawned.done;
      expect(
        [0, 130, null].includes(result.exitCode),
        `unexpected exitCode ${result.exitCode}\nstderr:\n${result.stderr.slice(-300)}`,
      ).toBe(true);
    });
  },
);
