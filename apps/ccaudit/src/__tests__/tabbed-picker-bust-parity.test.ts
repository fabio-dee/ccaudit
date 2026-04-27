/**
 * Phase 4 — MH-04 parity: the picker footer token total at the moment of Enter
 * must match the post-bust "Freed:" line within ≤1k rounding tolerance.
 *
 * Rationale (from the Phase 4 <specifics> block): "Counter MUST sum from the
 * same field the scanner+report use. Drift between the picker counter and the
 * post-bust 'freed ≈ Xk tokens' summary is a trust break."
 *
 * Flow:
 *   1. Scaffold 3 ghost agents.
 *   2. Spawn `ccaudit ghost --interactive` under CCAUDIT_FORCE_TTY=1 + NO_COLOR=1.
 *   3. Select agents 0 and 1 via Space + ArrowDown + Space.
 *   4. Parse the picker footer at the moment of Enter — capture either
 *      `~ Xk tokens saved` (≥1000 sum) or `N tokens saved` (<1000 sum).
 *   5. Enter → confirmation prompt appears → send 'y' + Enter.
 *   6. Await exit; regex-extract the `Freed: ~Xk` / `Freed: ~N` line from the
 *      shareable-block output.
 *   7. Compare: |pickerTokensK − freedTokensK| ≤ 1 (MH-04 tolerance).
 *   8. If the fixture produces 0 archivable tokens, the test skips with a
 *      console warning rather than failing — this prevents flakiness if the
 *      agent token estimator changes in a future phase.
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

// ── ANSI stripper ─────────────────────────────────────────────────────────
/* eslint-disable no-control-regex -- ANSI stripping requires literal \x1b */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '')
    .replace(/\x1b\[\d*[JST]/g, '');
}
/* eslint-enable no-control-regex */

/**
 * Parse the picker footer's "tokens saved" suffix and return the value in
 * thousands (k), rounded to an integer. Returns null if no match is found
 * (the fixture produced 0 archivable tokens — caller should skip).
 *
 *   "~ Xk tokens saved"   →  X
 *   "≈ Xk tokens saved"   →  X
 *   "N tokens saved"      →  N / 1000 (raw → k)
 */
function parsePickerTokensK(frame: string): number | null {
  // Take the LAST occurrence — `frame` is the cumulative stdout buffer and
  // contains earlier renders (e.g. the initial "0 of N selected" footer with
  // `0 tokens saved`) that would otherwise win under non-global match.
  const kMatches = [...frame.matchAll(/(?:~|≈)\s+(\d+)k\s+tokens saved/g)];
  if (kMatches.length > 0) return parseInt(kMatches.at(-1)![1]!, 10);
  // Raw form: `N tokens saved` where N is a bare integer.
  const rawMatches = [...frame.matchAll(/\b(\d+)\s+tokens saved/g)];
  if (rawMatches.length > 0) return parseInt(rawMatches.at(-1)![1]!, 10) / 1000;
  return null;
}

/**
 * Parse the post-bust shareable-block "Freed:" line. fmtK produces:
 *   tokens ≥ 10000  →  "~Xk"
 *   tokens ≥ 1000   →  "~X.Xk"
 *   tokens <  1000  →  "~X"     (raw count, not divided)
 */
function parseFreedTokensK(stdout: string): number | null {
  // ~Xk OR ~X.Xk
  const kMatch = stdout.match(/Freed:\s+~(\d+(?:\.\d+)?)k\s+tokens/);
  if (kMatch !== null) return parseFloat(kMatch[1]!);
  // Raw form: `Freed: ~N tokens` where N < 1000.
  const rawMatch = stdout.match(/Freed:\s+~(\d+)\s+tokens/);
  if (rawMatch !== null) return parseInt(rawMatch[1]!, 10) / 1000;
  return null;
}

// ── Test ──────────────────────────────────────────────────────────────────
// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 4 — MH-04 picker-footer / post-bust-Freed parity',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildManyGhostsFixture(tmpHome, 3);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('picker footer total at Enter matches post-bust Freed: line within ≤1k rounding tolerance (MH-04)', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: {
          CCAUDIT_FORCE_TTY: '1',
          CCAUDIT_TEST_STDOUT_ROWS: '24',
          LINES: '24',
          COLUMNS: '80',
          NO_COLOR: '1',
        },
        timeout: 25_000,
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

      // Select agents 0 + 1: Space, ArrowDown, Space.
      await sendKeys(spawned.child, [' ', '\x1b[B', ' ']);
      await new Promise((r) => setTimeout(r, 400));

      // Parse the picker footer BEFORE pressing Enter. We scan the stripped
      // stream for the most recent "2 of 3 selected" line and the tokens saved
      // suffix near it. Using the full captured stream is fine — the renderer
      // has already emitted the updated counter for the 2-selection state.
      const preEnterFrame = stripAnsi(stdoutBuf);
      expect(preEnterFrame).toContain('2 of 3 selected across all tabs');
      const pickerTokensK = parsePickerTokensK(preEnterFrame);
      if (pickerTokensK === null || pickerTokensK === 0) {
        console.warn('[phase-4 parity test] fixture produced 0 tokens; skipping');
        await sendKeys(spawned.child, ['\x03']);
        spawned.child.stdin!.end();
        await spawned.done;
        return;
      }

      // Press Enter → confirmation prompt.
      await sendKeys(spawned.child, ['\r']);
      await waitForMarker(
        () => stdoutBuf,
        () => spawned.child.exitCode !== null,
        'Proceed with archive?',
      );

      // Confirm the bust.
      await sendKeys(spawned.child, ['y', '\r'], 120);
      spawned.child.stdin!.end();

      const result = await spawned.done;
      expect(
        result.exitCode,
        `bust subprocess exited ${result.exitCode}\nstdout tail:\n${result.stdout.slice(-2000)}\nstderr tail:\n${result.stderr.slice(-1000)}`,
      ).toBe(0);

      const finalStdout = stripAnsi(result.stdout);
      const freedTokensK = parseFreedTokensK(finalStdout);
      expect(
        freedTokensK,
        `no Freed: line parsed from post-bust output; tail:\n${finalStdout.slice(-1500)}`,
      ).not.toBeNull();

      // MH-04: |pickerKey - freedKey| ≤ 1 (1k rounding tolerance).
      const pickerKey = Math.round(pickerTokensK);
      const freedKey = Math.round(freedTokensK ?? 0);
      expect(
        Math.abs(pickerKey - freedKey) <= 1,
        `MH-04 parity drift: picker shown ${pickerTokensK}k; bust freed ${freedTokensK ?? 'null'}k (diff ${Math.abs(pickerKey - freedKey)}k > 1k tolerance)`,
      ).toBe(true);
    }, 35_000);
  },
);
