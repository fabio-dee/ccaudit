/**
 * Phase 3.1 — Terminal-too-short gate integration test (D3.1-16).
 *
 * Spec: when the terminal is shorter than 14 rows, `ccaudit ghost --interactive`
 * writes an exact stderr message and exits 1 BEFORE opening any prompt.
 * The floor derives from the viewport formula
 * `Math.max(8, (stdoutRows ?? 24) - 10)` — at 13 rows the chrome budget
 * collapses and the tab bar / hints / row list cannot coexist.
 *
 * Mechanism choice:
 *   Under a piped-stdio subprocess, `process.stdout.rows` is always
 *   `undefined` regardless of the `LINES` env var (Node's readline/tty does
 *   NOT honour `LINES` for non-TTY streams). Rather than introduce a pty
 *   dependency (violates zero-runtime-deps invariant) or LD_PRELOAD a
 *   shim, this test uses the `CCAUDIT_TEST_STDOUT_ROWS` env var that
 *   select-ghosts.ts consults when resolving the stdoutRows gate input.
 *   The escape hatch is strictly test-only (never documented in --help),
 *   mirroring the CCAUDIT_FORCE_TTY pattern from Phase 3 (D-21).
 *
 * Assertions:
 *   1. exitCode === 1
 *   2. stderr contains the exact D3.1-16 message (both halves).
 *   3. No manifest file was written.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  runCcauditGhost,
  listManifestsDir,
  buildFakePs,
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

// ── Test ───────────────────────────────────────────────────────────────────
// Phase 3.2 note: the entry preflight (runInteractiveGhostFlow at ghost.ts
// after the TTY guard) now runs `detectClaudeProcesses` BEFORE the picker
// opens. That means the fake-ps shim IS needed on platforms that lack a
// real `ps` under PATH=<tmpHome>/bin; without it, the preflight fails
// closed with exit 2 ("Could not verify Claude Code is stopped…") before
// the D3.1-16 height gate inside selectGhosts can ever fire. The shim
// requires /bin/sh so we skip on Windows (same restriction as Phase 3).
describe.skipIf(process.platform === 'win32')(
  'Phase 3.1 — Terminal-too-short gate (D3.1-16): rows < 14 exits 1 with exact stderr',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      // Standard scaffold.
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
      // Session jsonl so discoverSessionFiles returns ≥1.
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'short-term-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/short',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'short-session',
        }) + '\n',
        'utf8',
      );
      // ≥1 ghost so the adapter does not early-exit via
      // { kind: 'empty-inventory' } before reaching the height gate.
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'short-agent.md'),
        '# short-agent\nNever invoked.\n',
        'utf8',
      );
      // Phase 3.2 added an entry-time preflight that runs `ps` BEFORE
      // selectGhosts (where the D3.1-16 height gate fires). Install the
      // fake-ps shim so the preflight returns "clear" and execution
      // reaches the height gate that this test is asserting on.
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('exits 1 with the exact D3.1-16 stderr message and writes no manifest when rows=10', async () => {
      // Baseline manifest directory — should remain empty throughout.
      const baselineManifests = await listManifestsDir(tmpHome);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: {
          CCAUDIT_FORCE_TTY: '1',
          // LINES is set too so the intent is visible to a reader even
          // though Node's non-TTY stdout ignores it.
          LINES: '10',
          COLUMNS: '80',
          CCAUDIT_TEST_STDOUT_ROWS: '10',
        },
        timeout: 5_000,
      });

      const result = await spawned.done;

      // Assertion 1: exit code is 1.
      expect(
        result.exitCode,
        `expected exitCode=1, got ${result.exitCode}\nstderr:\n${result.stderr}`,
      ).toBe(1);

      // Assertion 2a: first half of the exact D3.1-16 message (including "need ≥14 rows").
      expect(result.stderr).toContain('Terminal too short (need ≥14 rows, got 10)');

      // Assertion 2b: second half (resize/bust hint).
      expect(result.stderr).toContain(
        'Resize your terminal or use `--dangerously-bust-ghosts` non-interactively.',
      );

      // Assertion 3: no manifest was written.
      const postManifests = await listManifestsDir(tmpHome);
      const newManifests = postManifests.filter((m) => !baselineManifests.includes(m));
      expect(
        newManifests,
        `terminal-too-short gate violation: new manifest(s) appeared: ${newManifests.join(', ')}`,
      ).toEqual([]);
    });
  },
);
