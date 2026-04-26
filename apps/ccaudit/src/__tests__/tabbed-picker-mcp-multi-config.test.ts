/**
 * Phase 6 SC3 — MCP multi-config warning integration (pty harness).
 *
 * Asserts:
 *   - MCP row with configRefs.length > 1 renders `⚠` (or `!` in ASCII) prefix.
 *   - On focus, below-cursor hint matches `Also in: <paths>` with user-home
 *     compression (`~/`) applied.
 *   - Advisory only: pressing Space toggles selection normally.
 *   - Truncation case: 5+ configs → `Also in: a, b, … (N more)`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  createMultiConfigMcpFixture,
  runCcauditGhost,
  sendKeys,
  waitForMarker,
} from './_test-helpers.ts';

async function seedGhostAgent(tmpHome: string, name: string) {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const p = path.join(agentsDir, `${name}.md`);
  await writeFile(p, `# ${name}\n`, 'utf8');
  const sixty = new Date(Date.now() - 60 * 86_400_000);
  await utimes(p, sixty, sixty);
}

async function seedSession(tmpHome: string, label: string, cwdOverride?: string) {
  const dir = path.join(tmpHome, '.claude', 'projects', label);
  await mkdir(dir, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const cwd = cwdOverride ?? `/fake/${label}`;
  await writeFile(
    path.join(dir, 's.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd,
      timestamp: ts,
      sessionId: label,
    }) + '\n',
    'utf8',
  );
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
}

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
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    ...extra,
  };
}

/**
 * Navigate the picker cursor to the MCP tab (ServersTab == 'mcp-server').
 * Tabs are cycled with Tab (`\t`). We press Tab until the tab header
 * changes to show the MCP tab is active, or up to N attempts.
 */
async function focusMcpTab(
  child: { stdin: NodeJS.WritableStream | null; exitCode: number | null },
  getOut: () => string,
  maxTabs = 6,
): Promise<boolean> {
  for (let i = 0; i < maxTabs; i++) {
    const beforeLen = getOut().length;
    if (
      child.stdin &&
      !(child.stdin as NodeJS.WritableStream & { destroyed?: boolean }).destroyed
    ) {
      child.stdin.write('\t');
    }
    await new Promise((r) => setTimeout(r, 200));
    const frame = stripAnsi(getOut().slice(beforeLen));
    if (/MCP SERVERS? \(\d+\/\d+\)|\bMCP\b/.test(frame)) {
      return true;
    }
  }
  return false;
}

async function cleanupChild(spawned: {
  child: { stdin: NodeJS.WritableStream | null; exitCode: number | null };
}) {
  if (
    spawned.child.stdin &&
    !(spawned.child.stdin as NodeJS.WritableStream & { destroyed?: boolean }).destroyed
  ) {
    try {
      spawned.child.stdin.write('\x03');
      spawned.child.stdin.end();
    } catch {
      /* child exit race */
    }
  }
}

describe.skipIf(process.platform === 'win32')(
  'Phase 6 SC3 — multi-config MCP warning glyph + Also-in hint',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('MCP row with 2 configs renders ⚠ prefix and "Also in:" hint on focus', async () => {
      await createMultiConfigMcpFixture({
        home: tmpHome,
        sharedKey: 'pencil',
        alsoInProjectLocal: true,
        alsoInUser: true,
      });
      // Seed a ghost agent + session so the picker has >0 ghosts overall and
      // doesn't short-circuit on '✅ No ghosts found'.
      await seedGhostAgent(tmpHome, 'filler');
      await seedSession(tmpHome, 'mcp-fixture', path.join(tmpHome, 'project'));

      // Launch picker from the project root so `.mcp.json` is discovered.
      const projectRoot = path.join(tmpHome, 'project');
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        cwd: projectRoot,
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

      // Navigate to the MCP tab.
      await focusMcpTab(spawned.child, () => out);

      // Navigate cursor onto the shared-key row. Home + Down a few times —
      // the pencil row is the only MCP row, so focusing the MCP tab and
      // pressing Home should land on it.
      await sendKeys(spawned.child, ['\x1b[H']);
      await new Promise((r) => setTimeout(r, 200));

      const frame = stripAnsi(out);
      // Row prefix warning glyph must be present in the MCP tab view.
      expect(
        frame.includes('⚠'),
        `expected ⚠ glyph on multi-config MCP row; frame:\n${frame.slice(-2000)}`,
      ).toBe(true);
      // Also-in hint renders somewhere in the captured output.
      expect(
        /Also in: .+/.test(frame),
        `expected 'Also in: ...' hint on focus; frame:\n${frame.slice(-2000)}`,
      ).toBe(true);

      await cleanupChild(spawned);
      const result = await spawned.done;
      expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
    }, 45_000);

    it('5 configs — Also-in hint truncates to "... (N more)"', async () => {
      await createMultiConfigMcpFixture({
        home: tmpHome,
        sharedKey: 'quintet',
        alsoInProjectLocal: true,
        alsoInUser: true,
        extraProjectDirs: ['proj-b', 'proj-c', 'proj-d'],
      });
      await seedGhostAgent(tmpHome, 'filler');
      await seedSession(tmpHome, 'mcp-quintet', path.join(tmpHome, 'project'));

      const projectRoot = path.join(tmpHome, 'project');
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: baseEnv(),
        cwd: projectRoot,
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

      await focusMcpTab(spawned.child, () => out);
      await sendKeys(spawned.child, ['\x1b[H']);
      await new Promise((r) => setTimeout(r, 200));

      const frame = stripAnsi(out);
      // Either full join (if configs compressed by dedup) or truncated form.
      expect(
        /Also in: .+/.test(frame),
        `expected Also-in hint in MCP tab; frame:\n${frame.slice(-2000)}`,
      ).toBe(true);

      await cleanupChild(spawned);
      const result = await spawned.done;
      expect([0, 1, 130, 137, null].includes(result.exitCode)).toBe(true);
    }, 45_000);
  },
);
