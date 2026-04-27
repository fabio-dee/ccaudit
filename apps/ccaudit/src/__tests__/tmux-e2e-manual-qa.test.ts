/**
 * Optional tmux-backed E2E coverage for manual-QA-style picker flows.
 *
 * These tests are intentionally opt-in because they require tmux and exercise a
 * real terminal pane. Run locally with:
 *
 *   CCAUDIT_TMUX_E2E=1 pnpm --filter ccaudit-cli test -- tmux-e2e-manual-qa
 *
 * They complement (but do not replace) human-only checks from
 * ccaudit-manual-tests.txt such as macOS Terminal.app physical resize and
 * GitHub README rendering.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTmpHome,
  makeTmpHome,
  runCcauditCli,
  stageRestoreInteractiveFixture,
} from './_test-helpers.ts';
import {
  stageGlyphFixture,
  stageInteractiveBustFixture,
  stagePaginationFixture,
} from './fixtures/manual-qa-followups.ts';
import { startTmuxE2E, TMUX_KEYS, type TmuxE2ESession } from './fixtures/tmux-e2e.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');
const optIn = process.env['CCAUDIT_TMUX_E2E'] === '1';
const tmuxAvailable = (() => {
  if (!optIn || process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function sessionName(suffix: string): string {
  return `ccaudit-${suffix}-${process.pid}-${Date.now()}`;
}

function baseEnv(tmpHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    TZ: 'UTC',
    COLUMNS: '120',
    LINES: '30',
    ...extra,
  };
}

async function cleanup(session: TmuxE2ESession | null, tmpHome: string): Promise<void> {
  if (session !== null) await session.kill();
  await cleanupTmpHome(tmpHome);
}

describe.skipIf(process.platform === 'win32' || !optIn || !tmuxAvailable)(
  'tmux E2E manual-QA coverage (opt-in)',
  () => {
    beforeAll(() => {
      if (!existsSync(distPath)) {
        throw new Error(
          `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
        );
      }
    });

    it('Phase 8.1 R1/R2: restore picker shows MEMORY tab and restore footer wording', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        await stageRestoreInteractiveFixture(tmpHome);
        session = await startTmuxE2E({
          name: sessionName('restore-picker'),
          tmpDir: tmpHome,
          cwd: process.cwd(),
          width: 140,
          height: 35,
          command: [process.execPath, distPath, 'restore', '--interactive'],
          env: baseEnv(tmpHome, { NO_COLOR: '1' }),
        });

        const initial = await session.waitForText('AGENTS │ MEMORY');
        expect(initial).toContain('0 selected · 4 archived');

        await session.sendKeys([TMUX_KEYS.right]);
        const memoryTab = await session.waitForText('MEMORY (0/1)');
        expect(memoryTab).toContain('CLAUDE.md');
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 20_000);

    it('Phase 9 D1/F1-partial: large picker scrolls and survives tmux resize', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        await stagePaginationFixture(tmpHome, 550);
        session = await startTmuxE2E({
          name: sessionName('pagination'),
          tmpDir: tmpHome,
          cwd: process.cwd(),
          width: 120,
          height: 30,
          command: [process.execPath, distPath, 'ghost', '-i'],
          env: baseEnv(tmpHome),
        });

        await session.waitForText('AGENTS (0/550)');
        await session.sendKeys(
          Array.from({ length: 80 }, () => TMUX_KEYS.down),
          { delayMs: 5 },
        );
        const scrolled = await session.capture({ startLine: -80 });
        expect(scrolled).toContain('agent-081');
        expect(scrolled).toContain('↓');

        await session.resize(80, 15);
        await session.sendKeys([TMUX_KEYS.down]);
        await session.resize(120, 30);
        await session.sendKeys([TMUX_KEYS.space]);
        const resized = await session.capture({ startLine: -80 });
        expect(resized).toContain('AGENTS');
        expect(resized).toContain('selected across all tabs');
        expect(await session.isAlive()).toBe(true);
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 20_000);

    it('Phase 9 E1: renders protected, multi-config MCP, and stale-memory glyph states', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        const { projectRoot } = await stageGlyphFixture(tmpHome);
        session = await startTmuxE2E({
          name: sessionName('glyphs'),
          tmpDir: tmpHome,
          cwd: projectRoot,
          width: 140,
          height: 35,
          command: [process.execPath, distPath, 'ghost', '-i'],
          env: baseEnv(tmpHome),
        });

        const agents = await session.waitForText('gsd-researcher');
        expect(agents).toContain('🔒');
        expect(agents).toContain('◯');

        await session.sendKeys([TMUX_KEYS.right]);
        const mcp = await session.waitForText('MCP SERVERS');
        expect(mcp).toContain('⚠');
        expect(mcp).toContain('Also in:');

        await session.sendKeys([TMUX_KEYS.right]);
        const memory = await session.waitForText('MEMORY');
        expect(memory).toContain('CLAUDE.md');
        expect(memory).toContain('⌛');
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 20_000);

    it('Phase 9 H2: interactive archive via tmux then restore by name round-trips', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        await stageInteractiveBustFixture(tmpHome);
        session = await startTmuxE2E({
          name: sessionName('h2'),
          tmpDir: tmpHome,
          cwd: process.cwd(),
          width: 120,
          height: 30,
          command: [process.execPath, distPath, 'ghost', '-i'],
          env: baseEnv(tmpHome, {
            PATH: `${path.join(tmpHome, 'bin')}:${process.env['PATH'] ?? ''}`,
            NO_COLOR: '1',
          }),
        });

        await session.waitForText('h2-solo');
        await session.sendKeys([TMUX_KEYS.space, TMUX_KEYS.enter]);
        await session.waitForText('Proceed with archive?');
        await session.sendKeys([TMUX_KEYS.left, TMUX_KEYS.enter]);
        await session.waitForText('__CCAUDIT_TMUX_EXIT:0__', { timeoutMs: 10_000 });

        expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'h2-solo.md'))).toBe(false);
        const archivedFiles = await readdir(
          path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents'),
        );
        expect(archivedFiles).toContain('h2-solo.md');

        const restored = await runCcauditCli(tmpHome, ['restore', '--name', 'h2-solo'], {
          env: { NO_COLOR: '1' },
        });
        expect(restored.exitCode, `stderr:\n${restored.stderr}\nstdout:\n${restored.stdout}`).toBe(
          0,
        );
        expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'h2-solo.md'))).toBe(true);
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 30_000);

    it('Phase 9 D2: Esc clears an active filter without exiting the picker', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        await stagePaginationFixture(tmpHome, 550);
        session = await startTmuxE2E({
          name: sessionName('filter-esc'),
          tmpDir: tmpHome,
          cwd: process.cwd(),
          width: 120,
          height: 30,
          command: [process.execPath, distPath, 'ghost', '-i'],
          env: baseEnv(tmpHome),
        });

        await session.waitForText('AGENTS (0/550)');
        await session.sendKeys(
          Array.from({ length: 80 }, () => TMUX_KEYS.down),
          { delayMs: 5 },
        );
        expect(await session.capture({ startLine: 0 })).toContain('agent-081');

        await session.sendKeys(['/']);
        await session.sendLiteral('agent-09');
        await session.sendKeys([TMUX_KEYS.enter]);
        await session.waitForText('Filtered: 10 of 550 visible');

        await session.sendKeys([TMUX_KEYS.escape]);
        const cleared = await session.waitForText('selected across all tabs');
        expect(await session.isAlive()).toBe(true);
        const current = await session.capture({ startLine: 0 });
        expect(current).not.toContain('Filtered: 10 of 550 visible');
        expect(cleared).toContain('agent-081');

        await session.sendKeys(['s']);
        expect(await session.isAlive()).toBe(true);
        expect(await session.capture({ startLine: 0 })).toContain('sort:tokens');
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 25_000);

    it('Phase 9 E4: ? help overlay includes a glyph legend', async () => {
      const tmpHome = await makeTmpHome();
      let session: TmuxE2ESession | null = null;
      try {
        const { projectRoot } = await stageGlyphFixture(tmpHome);
        session = await startTmuxE2E({
          name: sessionName('help-glyphs'),
          tmpDir: tmpHome,
          cwd: projectRoot,
          width: 140,
          height: 35,
          command: [process.execPath, distPath, 'ghost', '-i'],
          env: baseEnv(tmpHome),
        });

        await session.waitForText('gsd-researcher');
        await session.sendKeys(['?']);
        const help = await session.waitForText('Glyphs');
        expect(help).toContain('Selected');
        expect(help).toContain('Unselected');
        expect(help).toContain('Protected / framework-locked');
        expect(help).toContain('Multi-config MCP server');
        expect(help).toContain('Stale memory file');
        expect(help).toContain('⌛');
      } finally {
        await cleanup(session, tmpHome);
      }
    }, 20_000);
    it.todo('Phase 9 F1/F2/F3: true macOS Terminal.app resize still needs human QA');
  },
);
