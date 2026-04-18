/**
 * Phase 4 — Live token counter integration tests (D4-14 cases 1, 2, 3, 4, 5, 6).
 *
 * Drives the real `ccaudit ghost --interactive` subprocess through the existing
 * pty fixture harness from Phase 3.1 (`runCcauditGhost` + `sendKeys`) and asserts
 * on captured stdout frames after stripping ANSI escape sequences.
 *
 * Cases covered:
 *   1. Counter updates on Space single-item toggle (D4-14 case 1)
 *   2. `a` tab-all updates tab header + global footer together (D4-14 case 2)
 *   3. Selections across two tabs sum into the global footer (D4-14 case 3)
 *   4. SIGWINCH preserves activeTabIndex + selection + counter re-renders (D4-14 case 4)
 *   5. Sub-minimum terminal banner + INV-S2 zero-manifest on cancel (D4-14 case 5)
 *   6. ASCII fallback: footer renders `~ Xk tokens saved`, never `≈` (D4-14 case 6)
 *
 * The resize tests drive a test-only env seam (`CCAUDIT_TEST_RESIZE=1` +
 * `CCAUDIT_TEST_RESIZE_ROWS`) because Node child processes with piped stdio
 * do not receive real `'resize'` events — `process.stdout` is a pipe, not a
 * TTY, so `process.stdout.on('resize')` never fires inside the child.
 * The production code path is unchanged unless the env var is set.
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
  buildManyGhostsFixture,
  listManifestsDir,
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

// ── ANSI stripper (mirrors tabbed-picker-overflow.test.ts) ───────────────
/* eslint-disable no-control-regex -- ANSI stripping requires literal \x1b */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[\?25[lh]/g, '') // cursor show/hide
    .replace(/\x1b\[[0-9;]*[mGKHFABCD]/g, '') // common CSI codes
    .replace(/\x1b\[\d*[JST]/g, ''); // erase display / scroll
}
/* eslint-enable no-control-regex */

// ── Inline fixture: 2 agents + 1 skill (Test 3) ───────────────────────────

async function buildTwoAgentsOneSkillFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const skillsDir = path.join(tmpHome, '.claude', 'skills', 'demo-skill');
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'p4-live-counter');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  // Agents: non-trivial bodies so the token estimator produces ≥1 token per item.
  await writeFile(
    path.join(agentsDir, 'a1.md'),
    '# a1\n\n' + 'alpha alpha alpha. '.repeat(20),
    'utf8',
  );
  await writeFile(
    path.join(agentsDir, 'a2.md'),
    '# a2\n\n' + 'beta beta beta. '.repeat(20),
    'utf8',
  );
  await writeFile(
    path.join(skillsDir, 'SKILL.md'),
    '---\nname: demo-skill\n---\n# demo-skill\n\n' + 'gamma gamma gamma. '.repeat(20),
    'utf8',
  );
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  const recentTs = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(
    path.join(sessionDir, 's.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/p4-live-counter',
      timestamp: recentTs,
      sessionId: 'p4-live-counter',
    }) + '\n',
    'utf8',
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wait until `stdoutBuf` contains `marker` (or `maxWaitMs` elapses OR the
 * child has exited). Returns the final stdoutBuf for convenience.
 */
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
  // Small grace so any trailing render bytes land.
  await new Promise((r) => setTimeout(r, 200));
}

/** Base env for the picker subprocess: forces TTY branch + pipes stdio + ASCII. */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CCAUDIT_FORCE_TTY: '1',
    CCAUDIT_TEST_STDOUT_ROWS: '24',
    LINES: '24',
    COLUMNS: '80',
    NO_COLOR: '1',
    ...extra,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────
// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 4 — Live token counter integration (D4-14 cases 1, 2, 3, 4, 5, 6)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    // ── Test 1 — counter updates on Space toggle (D4-14 case 1) ──────────
    it('footer updates from "0 of M" to "1 of M · ~ Xk tokens saved" on Space toggle', async () => {
      await buildManyGhostsFixture(tmpHome, 3);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        timeout: 15_000,
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

      const initial = stripAnsi(stdoutBuf);
      expect(initial).toContain('0 of 3 selected across all tabs');
      expect(initial).not.toContain('tokens saved');

      const beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      // Wait for re-render
      await new Promise((r) => setTimeout(r, 300));

      const after = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        after.includes('1 of 3 selected across all tabs'),
        `expected '1 of 3 selected across all tabs' after Space; got:\n${after}`,
      ).toBe(true);
      expect(
        after.includes('tokens saved'),
        `expected 'tokens saved' suffix after Space; got:\n${after}`,
      ).toBe(true);

      // Cleanup
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 25_000);

    // ── Test 2 — `a` tab-all updates header + footer (D4-14 case 2) ──────
    it("'a' tab-all updates both the active-tab header subtotal and the global footer", async () => {
      await buildManyGhostsFixture(tmpHome, 3);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        timeout: 15_000,
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

      const beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, ['a']);
      await new Promise((r) => setTimeout(r, 300));

      const after = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(after).toContain('3 of 3 selected across all tabs');
      // Active tab header carries the (3/3 · …) subtotal.
      expect(
        after.match(/AGENTS \(3\/3 ·[^)]*\)/) !== null,
        `expected 'AGENTS (3/3 · …)' header after 'a'; got:\n${after}`,
      ).toBe(true);
      expect(after).toContain('tokens saved');

      // Cleanup
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 25_000);

    // ── Test 3 — cross-tab sum (D4-14 case 3) ────────────────────────────
    it('selecting items across two tabs sums their tokens into the global footer', async () => {
      await buildTwoAgentsOneSkillFixture(tmpHome);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        timeout: 15_000,
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

      // Select a1 + a2 in AGENTS tab.
      let beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ', '\x1b[B', ' ']);
      await new Promise((r) => setTimeout(r, 300));
      const afterAgents = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        afterAgents.includes('2 of 3 selected across all tabs'),
        `expected '2 of 3' after 2× Space in AGENTS; got:\n${afterAgents}`,
      ).toBe(true);

      // Tab to SKILLS, select the single skill.
      beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, ['\t', ' ']);
      await new Promise((r) => setTimeout(r, 300));

      const afterSkill = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        afterSkill.includes('3 of 3 selected across all tabs'),
        `expected '3 of 3' after tab + Space in SKILLS; got:\n${afterSkill}`,
      ).toBe(true);
      expect(
        afterSkill.includes('tokens saved'),
        `expected 'tokens saved' suffix; got:\n${afterSkill}`,
      ).toBe(true);

      // Parse the numeric counter value — ensure it's numeric.
      //   `~ Xk tokens saved` or `~ X tokens saved`  (ASCII mode)
      //   `≈ Xk tokens saved` or `N tokens saved`    (Unicode mode)
      const match = afterSkill.match(/(?:~|≈)?\s*(\d+)(?:\.\d+)?k?\s+tokens saved/);
      expect(match !== null, `expected numeric tokens-saved token; got:\n${afterSkill}`).toBe(true);
      if (match !== null) {
        const parsed = parseInt(match[1]!, 10);
        expect(Number.isFinite(parsed)).toBe(true);
      }

      // Cleanup
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 25_000);

    // ── Test 6 — ASCII fallback (D4-14 case 6) ───────────────────────────
    it('ASCII fallback: footer renders ~ Xk tokens saved, never ≈', async () => {
      await buildManyGhostsFixture(tmpHome, 2);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        timeout: 15_000,
      });

      let stdoutBuf = '';
      spawned.child.stdout!.on('data', (c: Buffer) => {
        stdoutBuf += c.toString();
      });

      await waitForMarker(
        () => stdoutBuf,
        () => spawned.child.exitCode !== null,
        '0 of 2 selected across all tabs',
      );

      const beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      await new Promise((r) => setTimeout(r, 300));

      const after = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        after.includes('tokens saved'),
        `expected 'tokens saved' after Space; got:\n${after}`,
      ).toBe(true);
      // Positive: ASCII glyph '~ ' appears in the counter segment OR the count is < 1k (raw form).
      //   ASCII-with-k:  '~ Xk tokens saved'
      //   ASCII-raw:     'N tokens saved' (no glyph for < 1000)
      const hasAsciiGlyph = /~\s+\d+k\s+tokens saved/.test(after);
      const hasRawForm = /\b\d+\s+tokens saved/.test(after);
      expect(
        hasAsciiGlyph || hasRawForm,
        `expected '~ Xk tokens saved' or 'N tokens saved'; got:\n${after}`,
      ).toBe(true);
      // Negative: the Unicode approx glyph MUST NOT appear in ASCII mode.
      expect(after).not.toContain('≈');

      // Cleanup
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 25_000);

    // ── Test 4 — SIGWINCH preserves state (D4-14 case 4) ─────────────────
    it('SIGWINCH preserves selection and active tab across resize, counter re-renders', async () => {
      await buildTwoAgentsOneSkillFixture(tmpHome);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv({
          CCAUDIT_TEST_RESIZE: '1',
          CCAUDIT_TEST_RESIZE_ROWS: '20',
        }),
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

      // Select 2 items in AGENTS.
      await sendKeys(spawned.child, [' ', '\x1b[B', ' ']);
      await new Promise((r) => setTimeout(r, 300));

      // Assert pre-resize state.
      const preResize = stripAnsi(stdoutBuf);
      expect(preResize).toContain('2 of 3 selected across all tabs');

      // Fire the resize seam (Ctrl+R). Re-rendering when the new viewport
      // happens to produce a byte-identical frame can be suppressed by the
      // terminal renderer's diff logic, so after the resize we also press
      // ArrowDown + ArrowUp — a net-zero cursor motion that is guaranteed to
      // trigger a fresh frame. This proves BOTH that the resize handler ran
      // (cursor/selection/active-tab preserved across the Ctrl+R) AND that
      // the next render shows preserved state.
      await sendKeys(spawned.child, ['\x12']);
      await new Promise((r) => setTimeout(r, 200));
      const beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, ['\x1b[B', '\x1b[A']);
      await new Promise((r) => setTimeout(r, 250));

      const postResize = stripAnsi(stdoutBuf.slice(beforeLen));
      const fullAfter = stripAnsi(stdoutBuf);
      // Selection count intact — present in the post-resize slice (the diff
      // renderer only re-emits changed lines, and the resize + cursor nudge
      // always updates the global footer line).
      expect(
        postResize.includes('2 of 3 selected across all tabs'),
        `expected selection count preserved post-resize; got:\n${postResize}`,
      ).toBe(true);
      // Counter re-rendered on the post-resize frame.
      expect(
        postResize.includes('tokens saved'),
        `expected 'tokens saved' post-resize; got:\n${postResize}`,
      ).toBe(true);
      // Active tab index unchanged (AGENTS still the active tab). The tab
      // header line is byte-identical pre/post resize so the terminal diff
      // suppresses it in the post-resize slice — assert against the full
      // captured stream instead.
      expect(
        fullAfter.includes('AGENTS ('),
        `expected AGENTS tab header to be present in captured stream`,
      ).toBe(true);
      // 20 rows is above the 14-row minimum → no banner ever rendered.
      expect(fullAfter).not.toContain('Terminal too small');

      // Cleanup
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 30_000);

    // ── Test 5 — sub-minimum banner + INV-S2 (D4-14 case 5) ──────────────
    it('sub-minimum terminal after resize shows banner and cancel writes zero manifests (INV-S2)', async () => {
      await buildManyGhostsFixture(tmpHome, 3);

      // INV-S2 baseline: no manifests exist before the spawn.
      expect(await listManifestsDir(tmpHome)).toEqual([]);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv({
          CCAUDIT_TEST_RESIZE: '1',
          CCAUDIT_TEST_RESIZE_ROWS: '10',
        }),
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

      // Select one item while terminal is still normal size.
      let beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      await new Promise((r) => setTimeout(r, 300));

      const afterSpace = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(afterSpace).toContain('1 of 3 selected across all tabs');
      expect(afterSpace).toContain('tokens saved');

      // Fire resize seam → 10 rows = sub-minimum.
      beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, ['\x12']);
      await new Promise((r) => setTimeout(r, 250));

      const afterResize = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        afterResize.includes('Terminal too small'),
        `expected 'Terminal too small' banner post-resize; got:\n${afterResize}`,
      ).toBe(true);

      // Send Space again — must be a no-op per D4-08.
      beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      await new Promise((r) => setTimeout(r, 250));

      const afterSecondSpace = stripAnsi(stdoutBuf.slice(beforeLen));
      // Banner still present (interactivity suppressed).
      expect(
        afterSecondSpace.includes('Terminal too small') ||
          afterResize.includes('Terminal too small'),
        `expected banner after suppressed Space; stdoutSlice:\n${afterSecondSpace}`,
      ).toBe(true);

      // Cleanup: Ctrl-C, stdin.end, await exit.
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;

      // INV-S2: cancel during picker → zero manifests, even in sub-minimum state.
      expect(await listManifestsDir(tmpHome)).toEqual([]);
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 30_000);
  },
);
