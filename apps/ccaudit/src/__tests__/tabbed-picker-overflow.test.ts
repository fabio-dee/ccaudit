/**
 * Phase 3.1 — Terminal-overflow regression test (SC4, the ship-gate test for
 * Phase 3.1's core goal).
 *
 * Phase 2's flat `@clack/prompts.groupMultiselect` has no windowing — when the
 * ghost list exceeds terminal rows, the cursor disappears off-screen. Phase 3.1
 * replaces that flat picker with a bounded-viewport TabbedGhostPicker
 * (D3.1-05 / D3.1-06). This test locks the regression behind a subprocess
 * integration check:
 *
 *   1. Scaffold 60 ghost agents.
 *   2. Spawn `ccaudit ghost --interactive` with CCAUDIT_FORCE_TTY=1,
 *      LINES=24, COLUMNS=80 — so the viewport formula resolves deterministically
 *      to Math.max(8, 24-10) = 14 rows.
 *   3. Capture the initial render and assert:
 *      - Only a viewport-sized slice of agents is visible (10..20 matches).
 *      - The `N more below` indicator is rendered (either `↓ N more below` or
 *        the ASCII fallback `v N more below`).
 *      - The `more` copy is present.
 *   4. Send the `End` key (`'\x1b[F'`) → assert:
 *      - `agent-60` is now visible.
 *      - The above-indicator (`↑` or `^`) is present.
 *   5. Ctrl-C to clean up. Any exit code in [0, 130, null] is acceptable.
 *
 * ASCII-vs-Unicode note: under NO_COLOR=1 + piped stdio, `shouldUseAscii()`
 * returns true so the picker uses ASCII glyphs (`^` / `v` / `>` / `<-` / `->`).
 * Assertions accept both glyph sets for portability.
 *
 * This test is the regression harness for the Phase 2 manual-QA bug.
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

// ── Dist guard ─────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Helper: strip ANSI escape sequences from captured stdout ─────────────
// Covers the subset of codes the @clack/core + picocolors renderer emits:
// SGR (`\x1b[...m`), cursor-show/hide (`\x1b[?25l` / `\x1b[?25h`),
// cursor movement and line erase (`\x1b[NA`, `\x1b[NB`, `\x1b[K`, `\x1b[2K`,
// `\x1b[F`, `\x1b[G`, `\x1b[H`). Keeps the printable content intact so
// `.includes('agent-01')` and `.match(/agent-\d\d/g)` work on the result.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[\?25[lh]/g, '') // cursor show/hide
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '') // common CSI codes
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d*[JST]/g, ''); // erase display / scroll
}

// ── Test ───────────────────────────────────────────────────────────────────
// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 3.1 — Terminal-overflow regression (60 ghosts, LINES=24 → viewport 14)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildManyGhostsFixture(tmpHome, 60);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('renders a bounded viewport + `N more below` indicator on first frame; End jumps to last item + shows `N more above`', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: { CCAUDIT_FORCE_TTY: '1', LINES: '24', COLUMNS: '80' },
        timeout: 15_000,
      });

      // Accumulate stdout bytes.
      let stdoutBuf = '';
      spawned.child.stdout!.on('data', (c: Buffer) => {
        stdoutBuf += c.toString();
      });

      // Wait for picker to finish its first render. Poll with exponential
      // back-off (same pattern as safety-invariants-tui-abort.test.ts) until
      // stdout contains the initial render marker `AGENTS (0/60)`, or a
      // 5-second ceiling is reached.
      {
        const maxWaitMs = 5_000;
        const startMs = Date.now();
        let delayMs = 100;
        while (
          spawned.child.exitCode === null &&
          !stdoutBuf.includes('AGENTS (0/60)') &&
          Date.now() - startMs < maxWaitMs
        ) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 500);
        }
        // Final 200ms grace for any post-header viewport writes.
        await new Promise((r) => setTimeout(r, 200));
      }

      // Confirm the child didn't crash before rendering.
      expect(
        spawned.child.exitCode,
        `subprocess exited before first render\nstdout:\n${stdoutBuf.slice(-500)}`,
      ).toBeNull();

      const initialPlain = stripAnsi(stdoutBuf);

      // ── Assertion 1: out-of-view indicator rendered ──────────────────────
      // 60 items > 14-row viewport → expect a below-viewport indicator on the
      // first render (cursor starts at row 0 with 46 more below).
      expect(
        initialPlain.includes('↓') || initialPlain.includes('v '),
        `expected ↓ or 'v ' below-indicator; first frame:\n${initialPlain}`,
      ).toBe(true);
      // The indicator copy "more" is present.
      expect(initialPlain).toMatch(/\bmore\b/);

      // ── Assertion 2: only a viewport-sized slice of agents visible ───────
      const firstFrameMatches = initialPlain.match(/agent-\d\d/g) ?? [];
      expect(
        firstFrameMatches.length,
        `expected 10..20 agent-NN matches (viewport ≈ 14); got ${firstFrameMatches.length}\nframe:\n${initialPlain}`,
      ).toBeGreaterThanOrEqual(10);
      expect(firstFrameMatches.length).toBeLessThanOrEqual(20);

      // ── Assertion 3: End key jumps cursor to last item ──────────────────
      // Record stdout length before pressing End, then compare the delta.
      const beforeEndLen = stdoutBuf.length;
      spawned.child.stdin!.write('\x1b[F'); // End
      await new Promise((r) => setTimeout(r, 500));

      const afterEndRaw = stdoutBuf.slice(beforeEndLen);
      const afterEndPlain = stripAnsi(afterEndRaw);

      // agent-60 is visible (cursor at end).
      expect(
        afterEndPlain.includes('agent-60'),
        `expected 'agent-60' visible after End key; got:\n${afterEndPlain}`,
      ).toBe(true);

      // Above-viewport indicator is now present.
      expect(
        afterEndPlain.includes('↑') || afterEndPlain.includes('^'),
        `expected ↑ or '^' above-indicator after End; got:\n${afterEndPlain}`,
      ).toBe(true);

      // ── Tear down: Ctrl-C and await exit ─────────────────────────────────
      spawned.child.kill('SIGINT');
      const result = await spawned.done;
      expect(
        [0, 130, null].includes(result.exitCode),
        `unexpected exitCode ${result.exitCode}\nstderr:\n${result.stderr.slice(-500)}`,
      ).toBe(true);
    });
  },
);
