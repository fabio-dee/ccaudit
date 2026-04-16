/**
 * Safety-invariant integration tests for INV-S6: framework-as-unit bust protection.
 *
 * Spawns the built binary (apps/ccaudit/dist/index.js) with HOME overridden to a
 * tmpdir fixture. Uses the Phase 3 helpers from _test-helpers.ts:
 *   - createFrameworkFixture: partial-use GSD framework (1 used + 2 ghost agents)
 *   - buildFakePs: fake `ps` shim so preflight passes inside a Claude Code session
 *   - runCcauditGhost: subprocess runner returning live child + done promise
 *   - agentItemId: canonical ID for a global agent file
 *
 * Coverage:
 *   INV-S6 Test A: framework protection is enforced by default — ghost member of a
 *                  partially-used framework is NOT archived; source file survives;
 *                  dry-run JSON envelope carries changePlan.protected[]; bust JSON
 *                  envelope carries bust.protectionWarnings[].
 *   INV-S6 Test B: --force-partial unlocks protection — ghost member IS archived;
 *                  manifest planned_ops.archive === 1.
 *   INV-S6 Test C: TUI picker locking is a deferred placeholder (Phase 6 TUI-05).
 *
 * Local-vs-CI note
 * ─────────────────
 * Same fake-ps shim as bust-command.test.ts: each test writes a FAKE `ps` script
 * into `<tmpHome>/bin/ps` so the bust preflight finds no running Claude Code
 * process and proceeds. Without it, tests run from inside a Claude Code session
 * would fail with exit 3 every time.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFakePs,
  createFrameworkFixture,
  runCcauditGhost,
  agentItemId,
} from './_test-helpers.ts';

// ── Resolve dist path ──────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Guard: dist must exist before any test runs ────────────────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── INV-S6 framework protection tests ─────────────────────────────────────

// Windows: fake `ps` shell scripts require /bin/sh — skip on win32.
describe.skipIf(process.platform === 'win32')(
  'INV-S6: framework-as-unit bust protection',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-inv-s6-'));
      // Install fake-ps shim so the bust preflight passes when run inside
      // a Claude Code session (same pattern as bust-command.test.ts).
      await buildFakePs(tmpHome);
      // Build the partial-use GSD framework fixture:
      //   gsd-planner.md  → used (recent mtime + Task invocation in session JSONL)
      //   gsd-researcher.md → ghost (60-day-old mtime)
      //   gsd-verifier.md   → ghost (60-day-old mtime)
      await createFrameworkFixture(tmpHome);
    });

    afterEach(async () => {
      await rm(tmpHome, { recursive: true, force: true });
    });

    // ── Test A: protection enforced by default ─────────────────────────────

    it('Test A — INV-S6: protected ghost is excluded by default; source file survives', async () => {
      // Compute the canonical ID for the ghost we want to select.
      const ghostId = agentItemId(tmpHome, 'gsd-researcher.md');

      // Step 1: dry-run to create the checkpoint.
      // Protected items appear in changePlan.protected[]; archive count is 0.
      const dryResult = await runCcauditGhost(
        tmpHome,
        ['--dry-run', '--json'],
        {},
      ).done;
      expect(dryResult.exitCode, `dry-run stderr: ${dryResult.stderr}`).toBe(0);

      const dryEnvelope = JSON.parse(dryResult.stdout) as {
        dryRun: boolean;
        changePlan: {
          archive: unknown[];
          counts: { agents: number };
          protected?: Array<{ name: string; tier: string }>;
          protectionWarnings?: Array<{ frameworkId: string; status: string }>;
        };
      };

      // The dry-run archive list is empty — the ghosts are protected.
      expect(dryEnvelope.dryRun).toBe(true);
      expect(dryEnvelope.changePlan.counts.agents).toBe(0);
      expect(dryEnvelope.changePlan.archive).toHaveLength(0);

      // changePlan.protected[] is populated with the two framework-protected ghosts.
      expect(dryEnvelope.changePlan.protected).toBeDefined();
      expect(dryEnvelope.changePlan.protected!.length).toBeGreaterThanOrEqual(1);
      const protectedNames = dryEnvelope.changePlan.protected!.map((p) => p.name);
      expect(protectedNames).toContain('gsd-researcher');

      // protectionWarnings[] carries the framework audit trail.
      expect(dryEnvelope.changePlan.protectionWarnings).toBeDefined();
      expect(dryEnvelope.changePlan.protectionWarnings!).toHaveLength(1);
      expect(dryEnvelope.changePlan.protectionWarnings![0]!.frameworkId).toBe('gsd');
      expect(dryEnvelope.changePlan.protectionWarnings![0]!.status).toBe('partially-used');

      // Step 2: bust — select the protected ghost via CCAUDIT_SELECT_IDS.
      // Without --force-partial the item is removed from the eligible set before
      // reaching runBust, so it is never archived.
      const bustResult = await runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: ghostId } },
      ).done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      const bustEnvelope = JSON.parse(bustResult.stdout) as {
        bust: {
          status: string;
          counts: { archive: { agents: number } };
          protectionWarnings?: Array<{ frameworkId: string; status: string }>;
        };
      };
      expect(bustEnvelope.bust.status).toBe('success');

      // No agents were archived — protection held.
      expect(bustEnvelope.bust.counts.archive.agents).toBe(0);

      // The bust JSON envelope emits protectionWarnings for the audit trail.
      expect(bustEnvelope.bust.protectionWarnings).toBeDefined();
      expect(bustEnvelope.bust.protectionWarnings!).toHaveLength(1);
      expect(bustEnvelope.bust.protectionWarnings![0]!.frameworkId).toBe('gsd');

      // Source file is still on disk — nothing was moved.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'gsd-researcher.md')),
        'gsd-researcher.md must still exist after protection-blocked bust',
      ).toBe(true);
    });

    // ── Test B: --force-partial unlocks protection ─────────────────────────

    it('Test B — INV-S6: --force-partial unlocks protected ghost; file is archived', async () => {
      // Compute the canonical ID for the ghost we want to select.
      const ghostId = agentItemId(tmpHome, 'gsd-researcher.md');

      // Step 1: dry-run WITH --force-partial so the checkpoint hash covers the
      // expanded eligible set (protection bypassed at dry-run time too).
      const dryResult = await runCcauditGhost(
        tmpHome,
        ['--dry-run', '--force-partial', '--json'],
        {},
      ).done;
      expect(dryResult.exitCode, `dry-run stderr: ${dryResult.stderr}`).toBe(0);

      const dryEnvelope = JSON.parse(dryResult.stdout) as {
        dryRun: boolean;
        changePlan: { counts: { agents: number } };
      };
      // With --force-partial both ghost agents are eligible → counts > 0.
      expect(dryEnvelope.dryRun).toBe(true);
      expect(dryEnvelope.changePlan.counts.agents).toBeGreaterThanOrEqual(1);

      // Step 2: bust WITH --force-partial and CCAUDIT_SELECT_IDS targeting the researcher.
      const bustResult = await runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--force-partial', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: ghostId } },
      ).done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      const bustEnvelope = JSON.parse(bustResult.stdout) as {
        bust: {
          status: string;
          counts: { archive: { agents: number } };
          manifestPath: string;
        };
      };
      expect(bustEnvelope.bust.status).toBe('success');

      // Exactly 1 agent was archived — the force-partial override worked.
      expect(bustEnvelope.bust.counts.archive.agents).toBe(1);

      // Source file moved to archive; no longer at original path.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'gsd-researcher.md')),
        'gsd-researcher.md must NOT exist at original path after --force-partial bust',
      ).toBe(false);

      // Archive destination exists.
      expect(
        existsSync(
          path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'gsd-researcher.md'),
        ),
        'gsd-researcher.md must exist in the archive directory after --force-partial bust',
      ).toBe(true);
    });

    // ── Test C: TUI picker locking (deferred) ──────────────────────────────

    it.todo('TUI picker locks framework-protected items without --force-partial (Phase 6 — TUI-05)');
  },
);
