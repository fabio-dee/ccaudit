/**
 * Phase 3.1 — Tab-nav keys both-bindings integration test (SC2 belt-and-braces).
 *
 * Exercises the full interactive selection → bust → manifest-write pipeline
 * TWICE — once with Tab (`'\t'`), once with ArrowRight (`'\x1b[C'`) — to prove
 * that both forward tab-navigation bindings cycle tabs and that selection
 * survives the tab switch all the way to the written manifest.
 *
 * Task 3 (in-source tabbed-picker.ts) already proves cross-tab state at the
 * class level; this test is the end-to-end contract: the two bindings produce
 * the same observable manifest shape, plus the symmetric Shift-Tab / ArrowLeft
 * pair is transitively covered by Task 3's repeat-with-both-sequences
 * assertion.
 *
 * Per-test flow:
 *   1. Fixture: 2 agent files, 2 skill dirs with SKILL.md. Exactly two tabs open.
 *   2. Spawn ghost --interactive with CCAUDIT_FORCE_TTY=1, LINES=24, COLUMNS=80.
 *   3. Wait for picker ready (stdout contains `AGENTS (0/2)`).
 *   4. Send key sequence: Space → {Tab | ArrowRight} → Space → Enter.
 *   5. Confirmation prompt appears; send `y` + `\r`.
 *   6. Await exit; assert exit code 0.
 *   7. Read the single written manifest via @ccaudit/internal.readManifest and
 *      assert planned_ops.archive === 2 (one agent + one skill).
 *
 * ASCII-vs-Unicode: the subprocess sets NO_COLOR=1 so the picker uses the
 * ASCII-fallback glyphs; this test doesn't assert on visual glyphs, only on
 * the manifest contract — so ASCII/Unicode doesn't matter here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from '@ccaudit/internal';
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

// ── Shared fixture builder ────────────────────────────────────────────────

/**
 * Build a tiny two-tab fixture: 2 ghost agents + 2 ghost skills.
 * The scanner will partition these into exactly two non-empty tabs
 * (AGENTS, SKILLS), which is the minimum needed to exercise forward tab nav.
 */
async function buildTwoTabFixture(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

  // Minimal session jsonl.
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'tab-nav-keys-project');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'session-1.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/tab-nav-keys',
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionId: 'tab-nav-keys-session',
    }) + '\n',
    'utf8',
  );

  // 2 agents — these become the AGENTS tab.
  for (const name of ['a1', 'a2']) {
    await writeFile(path.join(tmpHome, '.claude', 'agents', `${name}.md`), `# ${name}\n`, 'utf8');
  }
  // 2 skills — directories with SKILL.md per the Skills schema.
  for (const name of ['sk1', 'sk2']) {
    const skillDir = path.join(tmpHome, '.claude', 'skills', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\n---\n# ${name}\n`,
      'utf8',
    );
  }
}

/**
 * Drive the picker + confirmation prompt with the provided `tabKey` as the
 * forward-nav byte sequence. Returns the result of the subprocess run plus
 * the written manifest's contents.
 */
async function runPickerWithTabKey(
  tmpHome: string,
  tabKey: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  manifestBase: string;
  manifest: Awaited<ReturnType<typeof readManifest>>;
}> {
  const spawned = runCcauditGhost(tmpHome, ['--interactive'], {
    env: { CCAUDIT_FORCE_TTY: '1', LINES: '24', COLUMNS: '80' },
    timeout: 20_000,
  });

  // Accumulate stdout to detect picker readiness.
  let stdoutBuf = '';
  spawned.child.stdout!.on('data', (c: Buffer) => {
    stdoutBuf += c.toString();
  });

  // Wait for the first frame: `AGENTS (0/2)` is emitted by the picker's
  // per-tab header and only appears once the picker has rendered.
  {
    const maxWaitMs = 5_000;
    const startMs = Date.now();
    let delayMs = 100;
    while (
      spawned.child.exitCode === null &&
      !stdoutBuf.includes('AGENTS (0/2)') &&
      Date.now() - startMs < maxWaitMs
    ) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }

  // Send: Space, <tabKey>, Space, Enter.
  await sendKeys(spawned.child, [' ', tabKey, ' ', '\r'], 120);

  // Wait for the confirmation prompt to render. runConfirmationPrompt writes
  // the box and then `@clack/prompts.confirm` adds its `◆  Proceed with archive?`
  // line. Detect readiness by polling for that line.
  {
    const maxWaitMs = 5_000;
    const startMs = Date.now();
    let delayMs = 100;
    while (
      spawned.child.exitCode === null &&
      !stdoutBuf.includes('Proceed with archive?') &&
      Date.now() - startMs < maxWaitMs
    ) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }

  // Send: y + Enter to confirm.
  await sendKeys(spawned.child, ['y', '\r'], 120);

  // After the bust completes and ccaudit prints its success box, the Node
  // event loop stays alive because @clack/core + @clack/prompts left a stdin
  // keypress listener registered. Close stdin so the subprocess can drain
  // and exit cleanly. Without this end() the subprocess hangs indefinitely
  // and the test hits its vitest timeout (discovered in Task 4 first run).
  spawned.child.stdin!.end();

  const result = await spawned.done;

  const manifestsAfter = await listManifestsDir(tmpHome);
  const jsonlManifests = manifestsAfter.filter((m) => m.endsWith('.jsonl'));
  if (jsonlManifests.length !== 1) {
    throw new Error(
      `expected exactly 1 manifest, got ${jsonlManifests.length}: ${jsonlManifests.join(', ')}\n` +
        `exitCode=${result.exitCode} confirmationReached=${result.stdout.includes('Proceed with archive?')}\n` +
        `stdout:\n${result.stdout.slice(-1500)}\nstderr:\n${result.stderr.slice(-500)}`,
    );
  }
  const manifestBase = jsonlManifests[0]!;
  const manifestPath = path.join(tmpHome, '.claude', 'ccaudit', 'manifests', manifestBase);
  const manifest = await readManifest(manifestPath);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    manifestBase,
    manifest,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────
// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'Phase 3.1 — Tab-nav both bindings (Tab + ArrowRight) through the interactive bust pipeline',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await buildTwoTabFixture(tmpHome);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it("Tab key ('\\t') cycles tabs forward and produces a manifest with exactly 2 planned ops", async () => {
      const { exitCode, manifest, stderr } = await runPickerWithTabKey(tmpHome, '\t');

      expect(exitCode, `stderr:\n${stderr.slice(-500)}`).toBe(0);
      expect(manifest.header).not.toBeNull();
      expect(manifest.header?.planned_ops.archive).toBe(2);
      // Defensive: the actual op records should also number 2.
      expect(manifest.ops.length).toBe(2);
      // Narrow to archive ops (only ArchiveOp + SkippedOp have `category`);
      // both planned ops are archives in this fixture.
      const archiveOps = manifest.ops.filter((o) => o.op_type === 'archive');
      expect(archiveOps.length).toBe(2);
      const cats = archiveOps.map((o) => o.category).sort();
      expect(cats).toEqual(['agent', 'skill']);
    }, 25_000);

    it("ArrowRight key ('\\x1b[C') cycles tabs forward and produces a manifest with exactly 2 planned ops", async () => {
      const { exitCode, manifest, stderr } = await runPickerWithTabKey(tmpHome, '\x1b[C');

      expect(exitCode, `stderr:\n${stderr.slice(-500)}`).toBe(0);
      expect(manifest.header).not.toBeNull();
      expect(manifest.header?.planned_ops.archive).toBe(2);
      expect(manifest.ops.length).toBe(2);
      const archiveOps = manifest.ops.filter((o) => o.op_type === 'archive');
      expect(archiveOps.length).toBe(2);
      const cats = archiveOps.map((o) => o.category).sort();
      expect(cats).toEqual(['agent', 'skill']);
    }, 25_000);
  },
);
