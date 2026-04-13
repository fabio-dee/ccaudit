#!/usr/bin/env node
// apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs
// One-shot capture: runs the v1.3.0 binary with --no-group-frameworks against
// the canonical Phase 5 fixture and freezes the resulting envelope as
// v1-2-1-envelope.json. Run this ONCE (or whenever the fixture changes) and
// commit the output alongside the fixture.
//
// Usage:  node apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const distPath = path.join(repoRoot, 'apps', 'ccaudit', 'dist', 'index.js');
const fixtureSourceDir = path.join(
  repoRoot,
  'apps',
  'ccaudit',
  'src',
  '__tests__',
  '__fixtures__',
  'framework-integration',
);
const fixtureOutPath = path.join(fixtureSourceDir, 'v1-2-1-envelope.json');

const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit Phase 5 capture script.
case "$*" in
  *-A*)
    echo "    1 init"
    ;;
  *-o\\ ppid=*)
    echo "1"
    ;;
  *)
    echo "    1 init"
    ;;
esac
`;

async function main() {
  if (!existsSync(distPath)) {
    console.error('[capture] dist/index.js missing — run `pnpm -F ccaudit-cli build` first');
    process.exit(1);
  }
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-v121-capture-'));
  try {
    await cp(fixtureSourceDir, tmpHome, { recursive: true });

    // Rewrite session timestamps to recent (~1h ago) so gsd-planner/gsd-executor are
    // classified as 'used' rather than 'definite-ghost'. This mirrors the copyFixture()
    // helper in framework-integration.test.ts — envelope must reflect the same runtime
    // conditions as the test that verifies it.
    const recentTs = new Date(Date.now() - 3_600_000).toISOString();
    const sessionPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      'framework-fixture',
      'session-1.jsonl',
    );
    const freshSession =
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: '2024-04-01T12:00:00.000Z',
          sessionId: 'phase5-fixture',
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: recentTs,
          sessionId: 'phase5-fixture',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 't-gsd-planner',
                name: 'Task',
                input: { subagent_type: 'gsd-planner', prompt: 'plan phase 5' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: recentTs,
          sessionId: 'phase5-fixture',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 't-gsd-executor',
                name: 'Task',
                input: { subagent_type: 'gsd-executor', prompt: 'execute plan' },
              },
            ],
          },
        }),
      ].join('\n') + '\n';
    await writeFile(sessionPath, freshSession, 'utf-8');
    const binDir = path.join(tmpHome, 'bin');
    await mkdir(binDir, { recursive: true });
    const psPath = path.join(binDir, 'ps');
    await writeFile(psPath, FAKE_PS_SCRIPT, 'utf-8');
    await chmod(psPath, 0o755);

    const env = {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      NO_COLOR: '1',
      NODE_OPTIONS: '',
    };
    const args = ['ghost', '--json', '--no-group-frameworks', '--since', '3650d'];

    const result = await new Promise((resolve, reject) => {
      const child = spawn('node', [distPath, ...args], { env, cwd: tmpHome });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    if (result.code !== 1) {
      console.error('[capture] expected exit code 1 (ghosts found), got', result.code);
      console.error('stderr:', result.stderr);
      process.exit(2);
    }

    const parsed = JSON.parse(result.stdout);
    if (JSON.stringify(parsed).includes('"framework"')) {
      console.error('[capture] envelope unexpectedly contains the substring "framework"');
      console.error('--no-group-frameworks is not producing a clean v1.2.1-shape envelope');
      process.exit(3);
    }

    await writeFile(fixtureOutPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    console.log(`[capture] wrote ${fixtureOutPath}`);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[capture] failed:', err);
  process.exit(10);
});
