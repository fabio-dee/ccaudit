/**
 * Phase 3.2 — Commands archival round-trip (SC1, SC3).
 *
 * Validates the Bug #1 fix: a command ghost selected via CCAUDIT_SELECT_IDS
 * (the non-interactive analog of the picker's Space + Enter flow) is
 * archived to ~/.claude/ccaudit/archived/commands/<slug>.md, the manifest
 * records the op with category='command', and `ccaudit restore` reverses
 * the move back to the source path.
 *
 * Pre-3.2 behavior: command ghosts fell through every buildChangePlan
 * branch and were silently excluded. This test protects against regression.
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
  runCcauditCli,
  commandItemId,
} from './_test-helpers.ts';
import { readManifest } from '@ccaudit/internal';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` first.`);
  }
});

describe.skipIf(process.platform === 'win32')('Phase 3.2 — command archival (SC1, SC3)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await mkdir(path.join(tmpHome, '.claude', 'commands', 'sc'), { recursive: true });
    await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
    await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

    // Minimal session JSONL so discoverSessionFiles returns ≥1 file.
    const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'session-1.jsonl'),
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/fake/project',
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        sessionId: 'cmd-archival',
      }) + '\n',
      'utf8',
    );
    await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

    // One ghost command (never referenced in any session → definite-ghost).
    await writeFile(
      path.join(tmpHome, '.claude', 'commands', 'sc', 'build.md'),
      '---\nname: sc:build\ndescription: ghost command\n---\n# sc:build\n',
      'utf8',
    );

    // One ghost agent, so SC3 has a mixed selection to assert on.
    await writeFile(
      path.join(tmpHome, '.claude', 'agents', 'ghost-agent.md'),
      '---\nname: ghost-agent\n---\n# ghost-agent\nunused\n',
      'utf8',
    );

    await buildFakePs(tmpHome);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  function manifestPathFromEnvelope(stdout: string): string {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const bust = parsed.bust as { manifestPath?: string } | undefined;
    if (!bust?.manifestPath) {
      throw new Error(`bust.manifestPath missing from JSON envelope: ${stdout.slice(0, 500)}`);
    }
    return bust.manifestPath;
  }

  it('SC1: command selected via CCAUDIT_SELECT_IDS archives end-to-end and restores', async () => {
    // Step 1: dry-run to write checkpoint
    const dry = await runCcauditCli(
      tmpHome,
      ['ghost', '--dry-run', '--yes-proceed-busting', '--json'],
      {
        env: {
          CCAUDIT_FORCE_TTY: '0',
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      },
    );
    expect(dry.exitCode, `dry-run stderr: ${dry.stderr}`).toBe(0);

    // Step 2: subset-bust with ONLY the command selected.
    const cmdId = commandItemId(tmpHome, 'sc/build.md', 'sc:build');
    const bust = await runCcauditCli(
      tmpHome,
      ['ghost', '--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
      {
        env: {
          CCAUDIT_SELECT_IDS: cmdId,
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      },
    );
    expect(bust.exitCode, `bust stderr: ${bust.stderr}`).toBe(0);

    // Source .md gone, archive location populated.
    expect(existsSync(path.join(tmpHome, '.claude', 'commands', 'sc', 'build.md'))).toBe(false);
    const archivedDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'commands');
    expect(existsSync(archivedDir)).toBe(true);
    const manifestPath = manifestPathFromEnvelope(bust.stdout);
    const manifest = await readManifest(manifestPath);
    expect(manifest.header!.planned_ops.archive).toBe(1);
    const archiveOp = (manifest.ops ?? []).find(
      (o: { op_type?: string }) => o.op_type === 'archive',
    ) as
      | {
          op_type: 'archive';
          category: 'agent' | 'skill' | 'command';
          source_path: string;
          archive_path: string;
        }
      | undefined;
    expect(archiveOp).toBeDefined();
    expect(archiveOp!.category).toBe('command');
    expect(archiveOp!.source_path).toBe(
      path.join(tmpHome, '.claude', 'commands', 'sc', 'build.md'),
    );
    expect(existsSync(archiveOp!.archive_path)).toBe(true);

    // Step 3: restore, assert source reinstated.
    const restore = await runCcauditCli(tmpHome, ['restore', '--json'], {
      env: { PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}` },
    });
    expect(restore.exitCode, `restore stderr: ${restore.stderr}`).toBe(0);
    expect(existsSync(path.join(tmpHome, '.claude', 'commands', 'sc', 'build.md'))).toBe(true);
    expect(existsSync(archiveOp!.archive_path)).toBe(false);
  });

  it('SC3a: --dry-run --json envelope counts.commands is populated', async () => {
    const dry = await runCcauditCli(
      tmpHome,
      ['ghost', '--dry-run', '--yes-proceed-busting', '--json'],
      {
        env: {
          CCAUDIT_FORCE_TTY: '0',
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      },
    );
    expect(dry.exitCode, `dry-run stderr: ${dry.stderr}`).toBe(0);
    const dryEnvelope = JSON.parse(dry.stdout) as Record<string, unknown>;
    const dryPlan = dryEnvelope.changePlan as { counts?: Record<string, number> } | undefined;
    expect(dryPlan?.counts).toBeDefined();
    expect(typeof dryPlan!.counts!.commands).toBe('number');
    expect(dryPlan!.counts!.commands).toBeGreaterThanOrEqual(1);
  });

  it('M5: full-bust healthAfter > healthBefore when ghost commands are archived', async () => {
    // Step 1: dry-run checkpoint (no CCAUDIT_SELECT_IDS → full plan)
    const dry = await runCcauditCli(
      tmpHome,
      ['ghost', '--dry-run', '--yes-proceed-busting', '--json'],
      {
        env: {
          CCAUDIT_FORCE_TTY: '0',
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      },
    );
    expect(dry.exitCode, `dry-run stderr: ${dry.stderr}`).toBe(0);

    // Step 2: full-bust (no CCAUDIT_SELECT_IDS)
    const bust = await runCcauditCli(
      tmpHome,
      ['ghost', '--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
      {
        env: {
          CCAUDIT_FORCE_TTY: '0',
          PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
      },
    );
    expect(bust.exitCode, `bust stderr: ${bust.stderr}`).toBe(0);

    const envelope = JSON.parse(bust.stdout) as {
      bust: {
        status: string;
        summary: { healthBefore: number; healthAfter: number };
      };
    };
    expect(envelope.bust.status).toBe('success');
    // M5: healthAfter must be strictly better than healthBefore after archiving ghosts
    // (previously full-bust left command entries in remainingEnriched, keeping
    // healthAfter artificially low and equal to healthBefore).
    expect(envelope.bust.summary.healthAfter).toBeGreaterThan(envelope.bust.summary.healthBefore);
  });

  it('SC3b: --dry-run text-mode output contains a tight commands row matching the locked regex', async () => {
    // Produces the renderChangePlan text output (Plan 01 Task 4 extended this
    // renderer to emit a `N commands  → ~/.claude/ccaudit/archived/commands/` row).
    // This regex is deliberately tight so future drift is caught — the label must
    // be "commands", singular or plural, the arrow must be → or -> (NO_COLOR
    // equivalence), and the destination must be ~/.claude/ccaudit/archived/commands/.
    const dryText = await runCcauditCli(tmpHome, ['ghost', '--dry-run', '--yes-proceed-busting'], {
      env: {
        CCAUDIT_FORCE_TTY: '0',
        PATH: `${path.join(tmpHome, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });
    expect(dryText.exitCode, `dry-run text stderr: ${dryText.stderr}`).toBe(0);
    // Combined stream — renderChangePlan goes to stdout; we search stdout+stderr
    // to survive any future relocation of the dry-run ceremony.
    const combined = `${dryText.stdout}\n${dryText.stderr}`;
    // Tight regex (B3 fix): require the `commands` token adjacent to the archived/commands/ path.
    // Test asserts the literal `~/.claude/ccaudit/archived/commands/` as the locked path shape.
    expect(combined).toMatch(
      /\b1 commands?\b\s+(→|->)\s+~\/\.claude\/ccaudit\/archived\/commands\//,
    );
    // Also assert the surrounding ARCHIVE block header is present — sanity.
    expect(combined).toContain('Will ARCHIVE');
  });
});
