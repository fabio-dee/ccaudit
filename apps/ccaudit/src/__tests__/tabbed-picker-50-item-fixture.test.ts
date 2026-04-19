/**
 * Phase 5 SC5 — 50-item fixture smoke test (pty harness).
 *
 * Drives ~50 ghosts across 3 tabs (20 agents, 20 skills, 10 MCP) through the
 * full Phase 5 keyboard model in sequence and asserts:
 *   - No crash, exit code ∈ {0, 130, null}.
 *   - Transcript is free of Node-thrown `TypeError` / `RangeError` / `undefined is not`
 *     error signatures.
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

async function buildBigFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const skillsRoot = path.join(tmpHome, '.claude', 'skills');
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'p5-big');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  // 20 agents
  for (let i = 1; i <= 20; i++) {
    const name = `agent-${String(i).padStart(2, '0')}`;
    await writeFile(
      path.join(agentsDir, `${name}.md`),
      `# ${name}\n\n` + 'content '.repeat(20),
      'utf8',
    );
  }

  // 20 skills
  for (let i = 1; i <= 20; i++) {
    const name = `skill-${String(i).padStart(2, '0')}`;
    const dir = path.join(skillsRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\n---\n# ${name}\n\n` + 'body '.repeat(20),
      'utf8',
    );
  }

  // 10 MCP servers in .claude.json
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (let i = 1; i <= 10; i++) {
    const name = `mcp-${String(i).padStart(2, '0')}`;
    mcpServers[name] = { command: 'npx', args: [`srv-${i}`] };
  }
  await writeFile(
    path.join(tmpHome, '.claude.json'),
    JSON.stringify({ mcpServers }, null, 2) + '\n',
    'utf8',
  );

  const recentTs = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(
    path.join(sessionDir, 's.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/p5-big',
      timestamp: recentTs,
      sessionId: 'p5-big',
    }) + '\n',
    'utf8',
  );
}

async function waitForMarker(
  getStdout: () => string,
  isExited: () => boolean,
  marker: string,
  maxWaitMs = 8_000,
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

describe.skipIf(process.platform === 'win32')(
  'Phase 5 SC5 — 50-item fixture smoke (all new bindings, no crash)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
      await buildBigFixture(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('exercises ?, /, s, a across tabs on a 50-item fixture without crashing', async () => {
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        timeout: 30_000,
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      spawned.child.stdout!.on('data', (c: Buffer) => {
        stdoutBuf += c.toString();
      });
      spawned.child.stderr!.on('data', (c: Buffer) => {
        stderrBuf += c.toString();
      });

      // Anchor on any `of NN selected` marker; total count depends on whether
      // all 50 items are recognized as ghosts, so match loosely.
      await waitForMarker(
        () => stdoutBuf,
        () => spawned.child.exitCode !== null,
        'selected across all tabs',
      );

      // Sanity: child must still be alive before we start driving it. If the
      // picker crashed during startup we surface stderr early rather than
      // letting `sendKeys` fail with a cryptic 'stdin destroyed'.
      if (spawned.child.exitCode !== null) {
        throw new Error(
          `[SC5] picker exited before first keystroke (code=${spawned.child.exitCode})\n` +
            `stdout tail:\n${stdoutBuf.slice(-1500)}\nstderr tail:\n${stderrBuf.slice(-1500)}`,
        );
      }

      // Sequence exercises all four new bindings without triggering the
      // @clack/core Esc→cancel alias bug (see KNOWN-GAP note in
      // tabbed-picker-filter.test.ts). We close the help overlay via the
      // `?` toggle and exit filter-input mode via Enter rather than Esc.
      await sendKeys(spawned.child, ['?']);
      await new Promise((r) => setTimeout(r, 250));
      await sendKeys(spawned.child, ['?']); // close help via toggle
      await new Promise((r) => setTimeout(r, 250));

      await sendKeys(spawned.child, ['/', 'a', 'g', 'e', 'n', 't']); // filter
      await new Promise((r) => setTimeout(r, 300));
      await sendKeys(spawned.child, ['\r']); // Enter: exit filter-input, keep query
      await new Promise((r) => setTimeout(r, 200));

      await sendKeys(spawned.child, ['s']);
      await new Promise((r) => setTimeout(r, 200));
      await sendKeys(spawned.child, ['s']);
      await new Promise((r) => setTimeout(r, 200));

      await sendKeys(spawned.child, ['\t']); // next tab
      await new Promise((r) => setTimeout(r, 300));
      await sendKeys(spawned.child, ['s']);
      await new Promise((r) => setTimeout(r, 200));
      await sendKeys(spawned.child, ['a']); // select all in tab
      await new Promise((r) => setTimeout(r, 300));

      // Cancel cleanly.
      await sendKeys(spawned.child, ['\x03']);
      spawned.child.stdin!.end();
      const result = await spawned.done;

      // Exit contract.
      expect(
        [0, 130, null].includes(result.exitCode),
        `unexpected exit code ${result.exitCode}\nstderr tail:\n${stderrBuf.slice(-500)}\nstdout tail:\n${stdoutBuf.slice(-500)}`,
      ).toBe(true);

      // No Node runtime errors surfaced.
      const full = stdoutBuf + '\n' + stderrBuf;
      expect(full).not.toMatch(/\bTypeError\b/);
      expect(full).not.toMatch(/\bRangeError\b/);
      expect(full).not.toMatch(/\bundefined is not\b/);
    }, 45_000);
  },
);
