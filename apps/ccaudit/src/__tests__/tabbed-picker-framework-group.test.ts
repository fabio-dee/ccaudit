/**
 * Phase 5 SC4 — framework-group toggle integration test (pty harness).
 *
 * Outcome A per 05-04-SUMMARY.md — `InventoryItem.framework` is populated by the
 * framework scanner. We seed AGENTS with 2 curated-framework prefixes (gsd-*,
 * sc-*, each with 2 items) so the AGENTS tab visible slice spans ≥ 2 distinct
 * framework values and the `TabbedGhostPicker` renders sub-header rows.
 *
 * Asserts:
 *   - Sub-header row `-- gsd (…) --` (or `-- superclaude (…) --`) appears in ASCII mode.
 *   - Navigating the cursor onto a sub-header and pressing Space selects all 2
 *     members of that framework (D5-17). The global footer reports `2 of 4`.
 *   - Pressing Space again on the sub-header deselects them (select-or-clear).
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

async function buildMultiFrameworkAgentsFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'p5-fwk');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  // 2 curated-framework prefixes × 2 items each. All ghosts (no session usage).
  for (const name of ['gsd-foo', 'gsd-bar', 'sc-baz', 'sc-qux']) {
    await writeFile(
      path.join(agentsDir, `${name}.md`),
      `# ${name}\n\n` + 'body body body. '.repeat(10),
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
      cwd: '/fake/p5-fwk',
      timestamp: recentTs,
      sessionId: 'p5-fwk',
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

describe.skipIf(process.platform === 'win32')(
  'Phase 5 SC4 — framework-group toggle integration (Outcome A)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
      await buildMultiFrameworkAgentsFixture(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('sub-header renders; Space on sub-header selects/deselects whole group (D5-17)', async () => {
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

      // Sub-header rows render in ASCII mode as `-- <framework> --`. At least one
      // of the two known curated display names must appear somewhere in the frame.
      const initial = stripAnsi(stdoutBuf);
      const hasAnySubHeader = /--\s+\S.*--/m.test(initial);
      if (!hasAnySubHeader) {
        // Scanner framework attribution didn't fire — surface this as a blocker
        // for the verifier/human rather than proceeding with a meaningless test.
        throw new Error(
          '[SC4] Expected framework sub-header rows in AGENTS tab but none rendered. ' +
            'Outcome A pty path requires the scanner to populate InventoryItem.framework. ' +
            `Captured (tail):\n${initial.slice(-2000)}`,
        );
      }

      // Cursor starts at row 0 (top of rows list). Move cursor up to land on
      // the first row; the first row emitted by assembleRowsForTab for a
      // multi-framework tab is a sub-header. We rely on that (per Plan 04).
      // Press Home to clamp cursor at row 0.
      await sendKeys(spawned.child, ['\x1b[H']); // Home
      await new Promise((r) => setTimeout(r, 200));

      // Space on sub-header → select whole group (2 items).
      let beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      await new Promise((r) => setTimeout(r, 400));
      const afterSelect = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        afterSelect.includes('2 of 4 selected across all tabs'),
        `expected '2 of 4 selected' after Space on sub-header; got:\n${afterSelect}`,
      ).toBe(true);

      // Space again → deselect whole group.
      beforeLen = stdoutBuf.length;
      await sendKeys(spawned.child, [' ']);
      await new Promise((r) => setTimeout(r, 300));
      const afterDeselect = stripAnsi(stdoutBuf.slice(beforeLen));
      expect(
        afterDeselect.includes('0 of 4 selected across all tabs'),
        `expected '0 of 4 selected' after 2nd Space on sub-header; got:\n${afterDeselect}`,
      ).toBe(true);

      // Cleanup.
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;
      expect([0, 130, null].includes(result.exitCode)).toBe(true);
    }, 40_000);
  },
);
