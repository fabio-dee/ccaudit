/**
 * Phase 3.2 — Preflight retry loop + HOOKS hidden + advisory (SC5, SC5a/b, SC6, SC7).
 *
 *   SC5  (byte-identical stderr across BOTH CLI paths): The interactive entry
 *         preflight AND the non-interactive --dangerously-bust-ghosts switch
 *         case emit the SAME rendered copy — both assertions compare stderr
 *         against the SAME renderRunningProcessMessage(input) output using
 *         `.toContain(...)`, guaranteeing "A vs B" equivalence. A future
 *         reformatter that drifts the wording will break at least one of the
 *         two assertions.
 *   SC5b (selection preservation — BOTH entry and bust-time retry paths):
 *         After the picker opens and the user confirms, if bust-time preflight
 *         trips, retrying preserves the original selectedItems Set verbatim —
 *         no picker re-open, no selection loss. The test drives the wrapped
 *         detector through multiple fake-dirty invocations and asserts:
 *           (a) stderr contains "Retry preflight?" AND "Retry bust?"
 *           (b) diagnostic marker [PREFLIGHT_DIRTY] appears ≥ 4 times
 *           (c) final manifest's selection_filter.ids matches the original
 *               2-item selection verbatim (no picker re-open, no loss)
 *   SC6  (HOOKS hidden): A fixture with hook ghosts renders a tab bar that
 *         does NOT include "HOOKS".
 *   SC7  (advisory suppression): `ccaudit ghost` text mode prints the
 *         advisory once; --json/--csv/--quiet/--ci modes all suppress it.
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
  buildManyGhostsFixture,
  runCcauditGhost,
  runCcauditCli,
  sendKeys,
  listManifestsDir,
  agentItemId,
} from './_test-helpers.ts';
import { readManifest } from '@ccaudit/internal';
import { renderRunningProcessMessage, type RunningProcessInput } from '@ccaudit/terminal';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` first.`);
  }
});

/** Wait until the buffer matches `pattern` or timeout elapses. W1 fix — single-form. */
async function waitFor(getBuf: () => string, pattern: RegExp, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pattern.test(getBuf())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${pattern} after ${timeoutMs}ms. Got: ${getBuf().slice(-300)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.platform === 'win32')(
  'Phase 3.2 — preflight retry + HOOKS + advisory',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildFakePs(tmpHome); // default: empty processes output (preflight clear)
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    // ─────────────────────────────────────────────────────────────────────
    // SC5 — byte-identical preflight copy across BOTH CLI paths (B1 fix)
    // ─────────────────────────────────────────────────────────────────────
    it(
      'SC5: renderRunningProcessMessage output appears verbatim in BOTH the non-interactive and interactive entry preflight stderr',
      { timeout: 30_000 },
      async () => {
        // Seed ghosts so the plan is non-empty and the entry preflight runs before the picker.
        await buildManyGhostsFixture(tmpHome, 1);
        // Checkpoint for the non-interactive path.
        await runCcauditCli(tmpHome, ['ghost', '--dry-run', '--yes-proceed-busting', '--json']);

        // Expected bytes: the pure helper's output for a "pids: 99999" external-pid case.
        // CCAUDIT_TEST_PREFLIGHT_DIRTY=1 makes the wrapped runCommand return one synthetic
        // claude pid — matching exactly this input shape.
        const expectedInput: RunningProcessInput = { selfInvocation: false, pids: [99999] };
        const expected = renderRunningProcessMessage(expectedInput);

        // Path A — Non-interactive --dangerously-bust-ghosts:
        // Plan 04 EDIT 4 refactored the switch-case to call the helper.
        // CCAUDIT_TEST_PREFLIGHT_DIRTY makes runBust's internal preflight return
        // 'running-process' on the first call.
        const nonInteractive = await runCcauditCli(
          tmpHome,
          ['ghost', '--dangerously-bust-ghosts', '--yes-proceed-busting'],
          { env: { CCAUDIT_TEST_PREFLIGHT_DIRTY: '1', CCAUDIT_FORCE_TTY: '0' } },
        );
        // running-process is a failure exit code (per bustResultToExitCode) — non-zero expected.
        expect(nonInteractive.exitCode).not.toBe(0);
        expect(nonInteractive.stderr).toContain(expected);

        // Path B — Interactive entry preflight (plan 04 EDIT 2):
        // CCAUDIT_TEST_PREFLIGHT_DIRTY=1 drives the entry preflight to render the same copy.
        // NOTE: runCcauditGhost auto-injects `'ghost'` as argv[2] — pass flags only (B1 fix).
        const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
          env: {
            CCAUDIT_FORCE_TTY: '1',
            CCAUDIT_TEST_PREFLIGHT_DIRTY: '1',
            LINES: '24',
            COLUMNS: '80',
          },
          timeout: 20_000,
        });
        let bufStdout = '';
        let bufStderr = '';
        spawned.child.stdout!.on('data', (c: Buffer) => {
          bufStdout += c.toString();
        });
        spawned.child.stderr!.on('data', (c: Buffer) => {
          bufStderr += c.toString();
        });

        // Wait for the retry prompt — @clack/prompts.confirm writes to stdout,
        // while the preflight copy goes to stderr. When the stdout prompt is
        // visible the stderr copy has already been written.
        await waitFor(() => bufStdout, /Retry preflight\?/, 10_000);

        // Press 'n' to cancel — clack's ConfirmPrompt resolves on 'n' alone.
        await sendKeys(spawned.child, ['n']);
        spawned.child.stdin!.end(); // CRITICAL: prevent clack event-loop pin.

        const interactiveResult = await spawned.done;
        expect(interactiveResult.exitCode).toBe(0); // cancel → exit 0 ("No changes made.")
        // SC5 enforcement: the SAME expected string appears in BOTH paths' stderr.
        expect(bufStderr).toContain(expected);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // SC5b — selection preservation across BOTH entry AND bust-time retry (Option A)
    // ─────────────────────────────────────────────────────────────────────
    it(
      'SC5b: selectedItems survives across entry-preflight retry AND bust-time runBust retry; [PREFLIGHT_DIRTY] marker confirms runBust actually returned running-process',
      { timeout: 90_000 },
      async () => {
        // Fixture: 2 ghost agents.
        await buildManyGhostsFixture(tmpHome, 2);

        // Dry run to write the checkpoint.
        const dry = await runCcauditCli(tmpHome, [
          'ghost',
          '--dry-run',
          '--yes-proceed-busting',
          '--json',
        ]);
        expect(dry.exitCode, `dry-run stderr: ${dry.stderr}`).toBe(0);

        // Accounting — CCAUDIT_TEST_PREFLIGHT_DIRTY=<N> gives EACH layer's wrapped
        // detector its own counter of N synthetic dirty calls. With N=2 the entry
        // preflight: initial detect (call 1, dirty) → loop uses initialResult, prompts,
        // user confirms → re-detect (call 2, dirty), prompts, confirms → re-detect
        // (call 3, CLEAN) → clears. That exercises 2 confirms in the entry layer.
        // The bust-time layer (separate counter with N=2): runBust's internal detect
        // (call 1, dirty) → returns 'running-process' → CLI retry loop prompts, user
        // confirms → re-detect (call 2, dirty) → prompts, confirms → re-detect
        // (call 3, CLEAN) → returns 'clear' → runBust re-invoked, succeeds. Total
        // marker count across both layers: ≥ 4 (2 from entry + 2 from bust, not
        // counting the optional initial caller call in entry).
        const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
          env: {
            CCAUDIT_FORCE_TTY: '1',
            CCAUDIT_TEST_PREFLIGHT_DIRTY: '3',
            LINES: '24',
            COLUMNS: '80',
          },
          timeout: 60_000,
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        spawned.child.stdout!.on('data', (c: Buffer) => {
          stdoutBuf += c.toString();
        });
        spawned.child.stderr!.on('data', (c: Buffer) => {
          stderrBuf += c.toString();
        });

        // Drive the entry retry loop. Count "fresh prompt" events by the number
        // of `◆  Retry preflight?` markers in stdout — clack writes this exact
        // glyph when a NEW prompt becomes interactive (not a repaint). Each time
        // this count increments, press 'y\r' once. When the counter plateaus
        // either AGENTS appears (entry cleared, picker ready) or the test times
        // out.
        const activePromptRe = /◆\s+Retry preflight\?/g;
        const driveDeadline = Date.now() + 30_000;
        let entryRetryConfirms = 0;
        let lastPromptCount = 0;
        while (Date.now() < driveDeadline) {
          if (/AGENTS/.test(stdoutBuf)) break; // picker is ready
          const promptCount = (stdoutBuf.match(activePromptRe) ?? []).length;
          if (promptCount > lastPromptCount) {
            // clack's ConfirmPrompt resolves on 'y' alone (emits "confirm" with true);
            // sending '\r' in addition would leak Enter to the NEXT prompt and commit
            // its default value (No). Send ONLY 'y'.
            await sendKeys(spawned.child, ['y'], 120);
            entryRetryConfirms++;
            lastPromptCount = promptCount;
            // Wait a beat for the confirm to resolve and the next detect to fire.
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        expect(entryRetryConfirms).toBeGreaterThanOrEqual(1);
        await waitFor(() => stdoutBuf, /AGENTS/, 15_000);

        // Select the 2 agents: Space, ArrowDown, Space, Enter.
        await sendKeys(spawned.child, [' ', '\x1b[B', ' ', '\r']);

        // Wait for the "Proceed?" confirmation — fail loudly on timeout (WARNING fix).
        await waitFor(() => stdoutBuf, /Proceed\?|Archiving/, 10_000);
        // clack ConfirmPrompt resolves on 'y' alone. Do NOT send '\r' — that would
        // leak an Enter to the NEXT clack prompt ('Retry bust?') which commits its
        // default value (No).
        await sendKeys(spawned.child, ['y'], 120);

        // Bust runs. With remaining dirty calls, runBust's internal preflight returns
        // 'running-process' → CLI retry loop prompts "Retry bust?". Count fresh
        // prompt events via the `◆  Retry bust?` glyph, identical strategy to
        // the entry loop.
        const bustPromptRe = /◆\s+Retry bust\?/g;
        const bustDeadline = Date.now() + 30_000;
        let bustRetryConfirms = 0;
        let lastBustPromptCount = 0;
        while (Date.now() < bustDeadline) {
          const promptCount = (stdoutBuf.match(bustPromptRe) ?? []).length;
          if (promptCount > lastBustPromptCount) {
            // clack's ConfirmPrompt resolves on 'y' alone (emits "confirm" with true);
            // sending '\r' in addition would leak Enter to the NEXT prompt and commit
            // its default value (No). Send ONLY 'y'.
            await sendKeys(spawned.child, ['y'], 120);
            bustRetryConfirms++;
            lastBustPromptCount = promptCount;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (spawned.child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        expect(bustRetryConfirms).toBeGreaterThanOrEqual(1);

        spawned.child.stdin!.end(); // CRITICAL: prevent clack event-loop pin.

        const result = await spawned.done;
        expect(result.exitCode, `result stderr: ${stderrBuf.slice(-500)}`).toBe(0);

        // ── Assertions ─────────────────────────────────────────────────
        // (a) BOTH retry layers fired. clack-prompts writes the confirmation
        //     prompts to stdout; the preflight copy itself goes to stderr.
        expect(stdoutBuf).toContain('Retry preflight?');
        expect(stdoutBuf).toContain('Retry bust?');

        // (b) Diagnostic marker count (B2 fix): the wrapped detector fired at least 4
        //     times across both layers. Proves bust-time preflight inside runBust
        //     actually returned 'running-process' — without this, only the CLI-layer
        //     retry could have tripped.
        const markerCount = (stderrBuf.match(/\[PREFLIGHT_DIRTY\] synthetic dirty/g) ?? []).length;
        expect(markerCount).toBeGreaterThanOrEqual(4);

        // (c) Manifest reflects the original 2-item subset selection (no picker re-open
        //     between retries — selectedItems preserved through BOTH retry layers).
        const manifests = await listManifestsDir(tmpHome);
        expect(manifests.length).toBe(1);
        const manifestFullPath = path.join(
          tmpHome,
          '.claude',
          'ccaudit',
          'manifests',
          manifests[0]!,
        );
        const manifest = await readManifest(manifestFullPath);
        expect(manifest.header!.selection_filter!.mode).toBe('subset');
        const selection = manifest.header!.selection_filter as {
          mode: 'subset';
          ids: string[];
        };
        expect(selection.ids.length).toBe(2);
        const expected1 = agentItemId(tmpHome, 'agent-01.md');
        const expected2 = agentItemId(tmpHome, 'agent-02.md');
        const actualSorted = [...selection.ids].sort();
        const expectedSorted = [expected1, expected2].sort();
        expect(actualSorted).toEqual(expectedSorted);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // SC6 — HOOKS tab absent from the picker when hook ghosts exist
    // ─────────────────────────────────────────────────────────────────────
    it(
      'SC6: fixture with hook ghosts produces a tab bar that does NOT include HOOKS',
      { timeout: 30_000 },
      async () => {
        await buildManyGhostsFixture(tmpHome, 1);
        const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
        await writeFile(
          settingsPath,
          JSON.stringify({
            hooks: {
              PreToolUse: [
                { matcher: '.*', hooks: [{ type: 'command', command: 'echo stale-hook' }] },
              ],
            },
          }),
          'utf8',
        );

        await runCcauditCli(tmpHome, ['ghost', '--dry-run', '--yes-proceed-busting', '--json']);

        // NOTE: runCcauditGhost auto-injects `'ghost'` as argv[2] — pass flags only (B1 fix).
        const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
          env: { CCAUDIT_FORCE_TTY: '1', LINES: '24', COLUMNS: '100' },
          timeout: 15_000,
        });
        let stdoutBuf = '';
        spawned.child.stdout!.on('data', (c: Buffer) => {
          stdoutBuf += c.toString();
        });

        await waitFor(() => stdoutBuf, /AGENTS/, 8_000);

        expect(stdoutBuf).toMatch(/AGENTS/);
        expect(stdoutBuf).not.toMatch(/\bHOOKS\b/);

        await sendKeys(spawned.child, ['\x1b']); // Esc to cancel
        spawned.child.stdin!.end();
        const result = await spawned.done;
        expect(result.exitCode).toBe(0);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // SC7 — advisory surfaced once; suppressed under --json / --csv / --quiet / --ci (B4 fix)
    // ─────────────────────────────────────────────────────────────────────
    it(
      'SC7: "Hook archival deferred" appears in text-mode output; is ABSENT under --json, --csv, --quiet, AND --ci',
      { timeout: 60_000 },
      async () => {
        await mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
        await writeFile(
          path.join(tmpHome, '.claude', 'settings.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [
                { matcher: '.*', hooks: [{ type: 'command', command: 'echo stale-hook' }] },
              ],
            },
          }),
          'utf8',
        );
        const sessionDir = path.join(tmpHome, '.claude', 'projects', 'advisory-test');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          path.join(sessionDir, 'session-1.jsonl'),
          JSON.stringify({
            type: 'system',
            subtype: 'init',
            cwd: '/fake',
            timestamp: new Date().toISOString(),
            sessionId: 'adv',
          }) + '\n',
          'utf8',
        );

        // Text mode → advisory present.
        const text = await runCcauditCli(tmpHome, ['ghost']);
        expect(text.stdout).toContain(
          'Hook archival deferred — selectable archive coming in a future phase',
        );

        // JSON mode → advisory absent (stdout AND stderr).
        const json = await runCcauditCli(tmpHome, ['ghost', '--json']);
        expect(json.stdout).not.toContain('Hook archival deferred');
        expect(json.stderr).not.toContain('Hook archival deferred');

        // CSV mode → advisory absent (B4 fix: was missing).
        const csv = await runCcauditCli(tmpHome, ['ghost', '--csv']);
        expect(csv.stdout).not.toContain('Hook archival deferred');
        expect(csv.stderr).not.toContain('Hook archival deferred');

        // Quiet mode → advisory absent.
        const quiet = await runCcauditCli(tmpHome, ['ghost', '--quiet']);
        expect(quiet.stdout).not.toContain('Hook archival deferred');
        expect(quiet.stderr).not.toContain('Hook archival deferred');

        // CI mode → advisory absent (B4 fix: was missing).
        const ci = await runCcauditCli(tmpHome, ['ghost', '--ci']);
        expect(ci.stdout).not.toContain('Hook archival deferred');
        expect(ci.stderr).not.toContain('Hook archival deferred');
      },
    );
  },
);
