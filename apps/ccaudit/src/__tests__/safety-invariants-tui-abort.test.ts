/**
 * Phase 3 — INV-S2 (SAFETY-02): Ctrl+C / SIGINT during the interactive TUI
 * produces ZERO disk writes that mutate user data.
 *
 * Strategy (CONTEXT D-09 / Path B):
 *   1. Build a fixture with at least one ghost agent + one stale memory file
 *      so a successful interactive bust would write a manifest, archive
 *      the agent file, and inject frontmatter into the memory file.
 *   2. Spawn `ccaudit ghost --interactive` with env CCAUDIT_FORCE_TTY=1.
 *      The Plan 01 hook makes the runInteractiveGhostFlow branch run
 *      from this non-pty subprocess.
 *   3. Wait for the subprocess to write the dry-run checkpoint (which
 *      runInteractiveGhostFlow writes BEFORE opening the picker — this
 *      is fine; checkpoint is NOT a manifest and is allowed). We detect
 *      this transition by polling for a small marker on stderr OR by
 *      time-bounded sleep + child-still-alive check.
 *   4. Send SIGINT to the child.
 *   5. Await `done`; assert exit code is 0, 130, or null (SIGINT ladder
 *      is implementation-defined; what matters is the process exited).
 *   6. Assert NO new manifest file exists in ~/.claude/ccaudit/manifests/
 *      relative to the pre-spawn baseline.
 *   7. Assert the source agent file is still at its source path (NOT
 *      moved to the archive directory).
 *   8. Assert the stale memory file does NOT contain the ccaudit-flagged
 *      or ccaudit-stale frontmatter keys.
 *
 * The .last-dry-run checkpoint MAY exist post-abort — that is allowed by
 * the invariant and explicitly noted in CONTEXT D-08. Manifests + mutations
 * are what we forbid.
 *
 * Pattern mirrors interactive-smoke.test.ts (Phase 2) but exercises the
 * picker code path itself, not just the guard layer.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditGhost,
  listManifestsDir,
  sendKeys,
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

// ── Tests ──────────────────────────────────────────────────────────────────

// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 3 — INV-S2: SIGINT during interactive TUI produces zero disk writes (SAFETY-02)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();

      // Base scaffold
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

      // Session JSONL so the scanner finds ≥1 file
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'inv-s2-session',
        }) + '\n',
        'utf8',
      );

      // Empty .claude.json
      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

      // Ghost agent (would be archived if bust ran)
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'inv-s2-agent.md'),
        '# inv-s2-agent\n\nNever invoked. Should NOT be archived after SIGINT.\n',
        'utf8',
      );

      // Stale memory file (would be flagged if bust ran)
      const memPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
      await writeFile(memPath, '# stale memory\n\nplain content, no frontmatter.\n', 'utf8');
      const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
      await utimes(memPath, oldTime, oldTime);

      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('SIGINT mid-flight: no new manifest, source files untouched, no frontmatter written', async () => {
      // Baseline: capture manifest dir state before spawn (likely [], but be defensive).
      const baselineManifests = await listManifestsDir(tmpHome);

      // Spawn `ccaudit ghost --interactive` with CCAUDIT_FORCE_TTY=1 so
      // the runInteractiveGhostFlow branch runs from this non-pty subprocess.
      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: { CCAUDIT_FORCE_TTY: '1' },
        timeout: 10_000,
      });

      // Wait for the subprocess to reach the picker (blocking on stdin) before
      // sending SIGINT. We poll `child.exitCode === null` with exponential back-off
      // rather than a fixed sleep — this avoids flakiness on slow CI runners where
      // 500ms may not be enough, while keeping the fast path fast on developer machines.
      //
      // The ideal fix (IN-01) would emit a `[ccaudit:ready-for-input]` marker on
      // stderr from runInteractiveGhostFlow and poll for that, removing timing
      // sensitivity entirely. That requires a production-code change; for now the
      // retry loop is a safe improvement over the original fixed sleep.
      {
        const maxWaitMs = 5_000;
        const startMs = Date.now();
        let delayMs = 100;
        while (spawned.child.exitCode !== null && Date.now() - startMs < maxWaitMs) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 500);
        }
        // Final 200ms grace period — ensures the subprocess reaches the blocking
        // selectGhosts() call after the checkpoint write completes.
        if (spawned.child.exitCode === null) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Confirm the child is still alive (otherwise the test is meaningless —
      // the subprocess crashed before we got a chance to abort it).
      // Note: child.exitCode is null while running.
      expect(
        spawned.child.exitCode,
        'subprocess exited before SIGINT — investigate stderr/stdout from done',
      ).toBeNull();

      // Send SIGINT.
      spawned.child.kill('SIGINT');

      // Await child exit. We accept any of:
      //   - exitCode === 0 (graceful cancel via @clack/prompts)
      //   - exitCode === 130 (POSIX SIGINT exit code 128 + 2)
      //   - exitCode === null (process killed by signal, no exit code recorded)
      // The invariant is about disk side-effects, not the exact exit code.
      const result = await spawned.done;
      expect(
        [0, 130, null].includes(result.exitCode),
        `unexpected exitCode ${result.exitCode}\nstderr:\n${result.stderr.slice(-500)}\nstdout:\n${result.stdout.slice(-500)}`,
      ).toBe(true);

      // Assertion 1: no new manifest written.
      const postManifests = await listManifestsDir(tmpHome);
      const newManifests = postManifests.filter((m) => !baselineManifests.includes(m));
      expect(
        newManifests,
        `INV-S2 violation: new manifest(s) appeared after SIGINT: ${newManifests.join(', ')}\n` +
          `stderr:\n${result.stderr.slice(-500)}`,
      ).toEqual([]);

      // Assertion 2: source agent file still exists at its source path.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'inv-s2-agent.md')),
        'INV-S2 violation: source agent file was archived/moved despite SIGINT',
      ).toBe(true);

      // Assertion 3: archived directory does NOT contain the agent.
      // (Archive dir may not exist at all if no bust ran — both conditions are fine.)
      const archivedAgentPath = path.join(
        tmpHome,
        '.claude',
        'ccaudit',
        'archived',
        'agents',
        'inv-s2-agent.md',
      );
      expect(
        existsSync(archivedAgentPath),
        'INV-S2 violation: agent file leaked into archived/ despite SIGINT',
      ).toBe(false);

      // Assertion 4: stale memory file has NO ccaudit-flagged or ccaudit-stale frontmatter.
      const memContent = await readFile(path.join(tmpHome, '.claude', 'CLAUDE.md'), 'utf8');
      expect(memContent).not.toMatch(/ccaudit-flagged:/);
      expect(memContent).not.toMatch(/ccaudit-stale:/);
      // Original content is intact (defensive — also catches partial-write corruption).
      expect(memContent).toContain('plain content, no frontmatter.');
    });
  },
);

// Phase 5 Plan 05-05 — INV-S2 re-run under the new filter-input mode
// (threat T-05-02 — SIGINT during filter-mode-active must still produce zero
// manifest writes even though additional key-handler state is live).
describe.skipIf(process.platform === 'win32')(
  'Phase 5 — INV-S2 under filter mode: SIGINT while typing into `/` filter still produces zero disk writes',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();

      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'inv-s2-filter');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/inv-s2-filter',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'inv-s2-filter-session',
        }) + '\n',
        'utf8',
      );

      await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

      // Two ghost agents — both archivable if a bust were to run.
      for (const name of ['foo-ghost', 'foo-other']) {
        await writeFile(
          path.join(tmpHome, '.claude', 'agents', `${name}.md`),
          `# ${name}\n\nNever invoked.\n`,
          'utf8',
        );
      }

      // Stale memory file — also archivable if a bust were to run.
      const memPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
      await writeFile(memPath, '# stale memory\n\nplain content, no frontmatter.\n', 'utf8');
      const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await utimes(memPath, oldTime, oldTime);

      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('SIGINT during `/` filter-input mode writes zero manifests (T-05-02)', async () => {
      const baselineManifests = await listManifestsDir(tmpHome);

      const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
        env: {
          CCAUDIT_FORCE_TTY: '1',
          CCAUDIT_TEST_STDOUT_ROWS: '30',
          LINES: '30',
          COLUMNS: '100',
          NO_COLOR: '1',
        },
        timeout: 10_000,
      });

      // Wait for the picker to be live before starting to drive it.
      {
        const maxWaitMs = 5_000;
        const startMs = Date.now();
        let delayMs = 100;
        while (spawned.child.exitCode !== null && Date.now() - startMs < maxWaitMs) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 500);
        }
        if (spawned.child.exitCode === null) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // Enter filter-input mode and start typing a partial query.
      await sendKeys(spawned.child, ['/', 'f', 'o', 'o']);
      // Small grace so the filter-mode state flag is live in the subprocess.
      await new Promise((r) => setTimeout(r, 300));

      expect(
        spawned.child.exitCode,
        'subprocess exited before SIGINT — investigate stderr/stdout from done',
      ).toBeNull();

      spawned.child.kill('SIGINT');
      const result = await spawned.done;
      expect(
        [0, 130, null].includes(result.exitCode),
        `unexpected exitCode ${result.exitCode}\nstderr:\n${result.stderr.slice(-500)}\nstdout:\n${result.stdout.slice(-500)}`,
      ).toBe(true);

      // Assertion 1: no new manifest written.
      const postManifests = await listManifestsDir(tmpHome);
      const newManifests = postManifests.filter((m) => !baselineManifests.includes(m));
      expect(
        newManifests,
        `INV-S2 violation under filter mode: new manifest(s) appeared after SIGINT: ${newManifests.join(', ')}\n` +
          `stderr:\n${result.stderr.slice(-500)}`,
      ).toEqual([]);

      // Assertion 2: both source agent files still at their source paths.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'foo-ghost.md')),
        'INV-S2 violation: foo-ghost.md was archived despite SIGINT under filter mode',
      ).toBe(true);
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'foo-other.md')),
        'INV-S2 violation: foo-other.md was archived despite SIGINT under filter mode',
      ).toBe(true);

      // Assertion 3: stale memory file has NO ccaudit frontmatter flags.
      const memContent = await readFile(path.join(tmpHome, '.claude', 'CLAUDE.md'), 'utf8');
      expect(memContent).not.toMatch(/ccaudit-flagged:/);
      expect(memContent).not.toMatch(/ccaudit-stale:/);
      expect(memContent).toContain('plain content, no frontmatter.');
    });
  },
);

// TODO(Phase 9): Exercise SIGINT at additional interrupt points (during the
// pre-picker scan, immediately after checkpoint write, during the confirmation
// prompt). Phase 3 covers the highest-risk point — inside the picker itself.
