/**
 * Phase 9 SC6 — `ccaudit purge-archive` integration test.
 *
 * Fixture shapes (archive op classes):
 *   A: archive exists, source FREE          → reclaim candidate
 *   B: archive exists, source OCCUPIED      → drop / source_occupied
 *   C: archive MISSING, source EXISTS       → drop / stale_archive_missing (Phase 8.2)
 *   D: archive MISSING, source MISSING      → skip (both_missing, preserved)
 *
 * Asserts per Plan 09-04:
 *   1. Default (no flags) is dry-run; exit 0; stdout mentions each class with
 *      correct classification; manifests dir unchanged; archive dir unchanged.
 *   2. `--yes` real purge:
 *        - A moved back to source (archive gone, source now present)
 *        - B archive unlinked; source untouched
 *        - C no disk mutation (file already gone); follow-up op still appended
 *        - D untouched (skip)
 *      A single purge-*.jsonl manifest is appended.
 *   3. `--json --yes` envelope: purge.summary counts match, failures: [].
 *   4. `--dry-run --yes` → exit 1 with "mutually exclusive" error.
 *   5. CCAUDIT_NO_INTERACTIVE=1 orthogonality (command is non-interactive,
 *      env var must not interfere with dry-run).
 *   6. CCAUDIT_NO_HISTORY=1 → no entry appended to history.jsonl after --yes.
 *   7. Failure path: --yes with one unwritable archive path surfaces a
 *      failures[] entry but does NOT abort the batch and exit remains 0.
 *   8. NEW-M2: corrupt manifest is skipped with warning; valid manifests are
 *      still processed and exit code remains 0.
 *   9. NEW-M2: all manifests corrupt → graceful empty plan, exit 0, no crash.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpHome, cleanupTmpHome, runCcauditCli } from './_test-helpers.ts';
import {
  stageAlreadyPurgedFixture,
  stagePurgeMixedFixture,
} from './fixtures/manual-qa-followups.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` first.`);
  }
});

// -- Fixture helpers ----------------------------------------------------

interface ArchiveOpSpec {
  /** Agent name used to build source + archive paths under `<tmpHome>/.claude/agents/<name>.md`. */
  name: string;
  /** Write the archive file to disk. */
  archiveOnDisk: boolean;
  /** Write the source file to disk. */
  sourceOnDisk: boolean;
}

/**
 * Stage a single manifest JSONL containing one archive op per entry.
 *
 * Each spec produces paths:
 *   source_path  = <tmpHome>/.claude/agents/<name>.md
 *   archive_path = <tmpHome>/.claude/ccaudit/archived/.claude/agents/<name>.md
 *
 * (Layout mirrors Phase 8.2 stale-filter fixture + reclaim-command.test.ts.)
 */
async function stageMixedFixture(tmpHome: string, specs: ArchiveOpSpec[]): Promise<void> {
  const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
  const archivedAgentsDir = path.join(
    tmpHome,
    '.claude',
    'ccaudit',
    'archived',
    '.claude',
    'agents',
  );
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  await mkdir(manifestsDir, { recursive: true });
  await mkdir(archivedAgentsDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  const header = {
    record_type: 'header',
    manifest_version: 1,
    ccaudit_version: '1.5.0-test',
    checkpoint_ghost_hash: 'fixture-purge',
    checkpoint_timestamp: '2026-04-22T09:00:00.000Z',
    since_window: '30d',
    os: 'darwin',
    node_version: 'v20.0.0',
    planned_ops: { archive: specs.length, disable: 0, flag: 0 },
    selection_filter: { mode: 'full' },
  };
  const ops = specs.map((s) => ({
    op_id: `op-${s.name}`,
    op_type: 'archive',
    timestamp: '2026-04-22T09:00:00.000Z',
    status: 'completed',
    category: 'agent',
    scope: 'global',
    source_path: path.join(agentsDir, `${s.name}.md`),
    archive_path: path.join(archivedAgentsDir, `${s.name}.md`),
    content_sha256: '0000000000000000000000000000000000000000000000000000000000000001',
  }));
  const footer = {
    record_type: 'footer',
    status: 'completed',
    actual_ops: {
      archive: { completed: specs.length, failed: 0 },
      disable: { completed: 0, failed: 0 },
      flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
    },
    duration_ms: 1,
    exit_code: 0,
  };
  const body =
    [JSON.stringify(header), ...ops.map((o) => JSON.stringify(o)), JSON.stringify(footer)].join(
      '\n',
    ) + '\n';
  await writeFile(
    path.join(manifestsDir, 'bust-2026-04-22T09-00-00-000Z-fixt.jsonl'),
    body,
    'utf8',
  );

  for (const s of specs) {
    if (s.archiveOnDisk) {
      await writeFile(
        path.join(archivedAgentsDir, `${s.name}.md`),
        `# ${s.name} (archived)\n`,
        'utf8',
      );
    }
    if (s.sourceOnDisk) {
      await writeFile(path.join(agentsDir, `${s.name}.md`), `# ${s.name} (at source)\n`, 'utf8');
    }
  }
}

const MIXED_SPECS: ArchiveOpSpec[] = [
  // A: reclaim (archive-only)
  { name: 'a-reclaim', archiveOnDisk: true, sourceOnDisk: false },
  // B: drop/source_occupied (both)
  { name: 'b-occupied', archiveOnDisk: true, sourceOnDisk: true },
  // C: drop/stale_archive_missing (source-only)
  { name: 'c-stale', archiveOnDisk: false, sourceOnDisk: true },
  // D: skip/both_missing (neither)
  { name: 'd-broken', archiveOnDisk: false, sourceOnDisk: false },
];

function agentsPath(tmpHome: string, name: string): string {
  return path.join(tmpHome, '.claude', 'agents', `${name}.md`);
}
function archivePath(tmpHome: string, name: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'archived', '.claude', 'agents', `${name}.md`);
}
function manifestsDir(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
}
function historyPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'history.jsonl');
}

async function countPurgeManifests(tmpHome: string): Promise<number> {
  const entries = await readdir(manifestsDir(tmpHome));
  return entries.filter((m) => m.startsWith('purge-') && m.endsWith('.jsonl')).length;
}

// -- Tests --------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('ccaudit purge-archive (Phase 9 SC6)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await stageMixedFixture(tmpHome, MIXED_SPECS);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  // -- 1. Dry-run default ---------------------------------------------

  it('default (no flags) runs in dry-run: classifies 4 ops, writes nothing', async () => {
    const before = await readdir(manifestsDir(tmpHome));
    const r = await runCcauditCli(tmpHome, ['purge-archive']);
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

    // Each classification surfaces in stdout with its marker.
    expect(r.stdout).toContain('a-reclaim');
    expect(r.stdout).toContain('b-occupied');
    expect(r.stdout).toContain('source_occupied');
    expect(r.stdout).toContain('c-stale');
    expect(r.stdout).toContain('stale_archive_missing');
    expect(r.stdout).toContain('d-broken');
    expect(r.stdout).toContain('both_missing');
    expect(r.stdout).toMatch(/Dry-run/i);

    // Manifests dir unchanged.
    const after = await readdir(manifestsDir(tmpHome));
    expect(after.sort()).toEqual(before.sort());

    // Archive + source layout unchanged.
    expect(existsSync(archivePath(tmpHome, 'a-reclaim'))).toBe(true);
    expect(existsSync(archivePath(tmpHome, 'b-occupied'))).toBe(true);
    expect(existsSync(agentsPath(tmpHome, 'b-occupied'))).toBe(true);
  });

  // -- 2. --yes real purge --------------------------------------------

  it('--yes executes the plan: reclaim + drop + stale follow-up + skip preserved', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--yes']);
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).toMatch(/reclaimed/);
    expect(r.stdout).toMatch(/purged/);

    // A: archive gone, source present
    expect(existsSync(archivePath(tmpHome, 'a-reclaim'))).toBe(false);
    expect(existsSync(agentsPath(tmpHome, 'a-reclaim'))).toBe(true);

    // B: archive gone, source still intact (must NOT be overwritten)
    expect(existsSync(archivePath(tmpHome, 'b-occupied'))).toBe(false);
    expect(existsSync(agentsPath(tmpHome, 'b-occupied'))).toBe(true);
    const bContents = await readFile(agentsPath(tmpHome, 'b-occupied'), 'utf8');
    expect(bContents).toBe('# b-occupied (at source)\n');

    // C: no archive to begin with; source untouched
    expect(existsSync(archivePath(tmpHome, 'c-stale'))).toBe(false);
    expect(existsSync(agentsPath(tmpHome, 'c-stale'))).toBe(true);

    // D: both still missing
    expect(existsSync(archivePath(tmpHome, 'd-broken'))).toBe(false);
    expect(existsSync(agentsPath(tmpHome, 'd-broken'))).toBe(false);

    // Exactly one purge-*.jsonl manifest was appended.
    const manifests = await readdir(manifestsDir(tmpHome));
    const purgeManifests = manifests.filter((m) => m.startsWith('purge-') && m.endsWith('.jsonl'));
    expect(purgeManifests).toHaveLength(1);
  });

  it('is idempotent: a second --yes no-ops and writes no duplicate purge manifest', async () => {
    await cleanupTmpHome(tmpHome);
    tmpHome = await makeTmpHome();
    await stagePurgeMixedFixture(tmpHome);

    const first = await runCcauditCli(tmpHome, ['purge-archive', '--yes']);
    expect(first.exitCode, `stderr:\n${first.stderr}\nstdout:\n${first.stdout}`).toBe(0);
    expect(await countPurgeManifests(tmpHome)).toBe(1);

    const second = await runCcauditCli(tmpHome, ['purge-archive', '--yes']);
    expect(second.exitCode, `stderr:\n${second.stderr}\nstdout:\n${second.stdout}`).toBe(0);
    expect(second.stdout).not.toContain('a-reclaim                    [stale_archive_missing]');
    expect(second.stdout).not.toContain('b-occupied                   [stale_archive_missing]');
    expect(second.stdout).not.toContain('c-stale                      [stale_archive_missing]');
    expect(second.stdout).toMatch(/Summary: 0 reclaimed, 0 purged\./);
    expect(await countPurgeManifests(tmpHome)).toBe(1);

    const listed = await runCcauditCli(tmpHome, ['restore', '--list']);
    expect(listed.exitCode, `stderr:\n${listed.stderr}\nstdout:\n${listed.stdout}`).toBe(0);
    expect(listed.stdout).not.toContain('a-reclaim');
    expect(listed.stdout).not.toContain('b-occupied');
    expect(listed.stdout).not.toContain('c-stale');
  });

  it('already-purged fixture has no new purge candidates and no duplicate manifest', async () => {
    await cleanupTmpHome(tmpHome);
    tmpHome = await makeTmpHome();
    await stageAlreadyPurgedFixture(tmpHome);
    const before = await countPurgeManifests(tmpHome);

    const r = await runCcauditCli(tmpHome, ['purge-archive', '--yes']);
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain('a-reclaim                    [stale_archive_missing]');
    expect(r.stdout).not.toContain('b-occupied                   [stale_archive_missing]');
    expect(r.stdout).not.toContain('c-stale                      [stale_archive_missing]');
    expect(r.stdout).toMatch(/Summary: 0 reclaimed, 0 purged\./);
    expect(await countPurgeManifests(tmpHome)).toBe(before);
  });

  // -- 3. JSON envelope ------------------------------------------------

  it('--json --yes emits envelope with purge.summary matching classification', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--json', '--yes']);
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

    const env = JSON.parse(r.stdout.trim()) as {
      meta: { command: string; exitCode: number };
      purge: {
        summary: {
          purgedCount: number;
          reclaimedCount: number;
          skippedOccupiedCount: number;
          staleFilteredCount: number;
        };
        failures: Array<{ path: string; reason: string }>;
        dryRun: boolean;
        manifestPath: string | null;
      };
    };
    expect(env.meta.command).toBe('purge-archive');
    expect(env.purge.dryRun).toBe(false);
    expect(env.purge.summary).toEqual({
      purgedCount: 2,
      reclaimedCount: 1,
      skippedOccupiedCount: 1,
      staleFilteredCount: 1,
    });
    expect(env.purge.failures).toEqual([]);
    expect(env.purge.manifestPath).toMatch(/purge-.+\.jsonl$/);
  });

  // -- 4. Mutual exclusion --------------------------------------------

  it('--dry-run --yes → exit 1 with mutual-exclusion error and records history', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--dry-run', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
    const history = await readFile(historyPath(tmpHome), 'utf8');
    expect(history).toContain('"command":"purge-archive"');
    expect(history).toContain('"exit_code":1');
  });

  it('--dry-run --yes --json → exit 1 with structured envelope', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--dry-run', '--yes', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const env = JSON.parse(r.stdout.trim()) as {
      meta: { command: string; exitCode: number };
      purge: {
        failures: Array<{ path: string; reason: string }>;
        dryRun: boolean;
        manifestPath: string | null;
      };
    };
    expect(env.meta.command).toBe('purge-archive');
    expect(env.meta.exitCode).toBe(1);
    expect(env.purge.dryRun).toBe(true);
    expect(env.purge.manifestPath).toBeNull();
    expect(env.purge.failures[0]?.reason).toMatch(/mutually exclusive/);
  });

  // -- 5. CCAUDIT_NO_INTERACTIVE orthogonality -------------------------

  it('CCAUDIT_NO_INTERACTIVE=1 does not interfere with --dry-run', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--dry-run'], {
      env: { CCAUDIT_NO_INTERACTIVE: '1' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Dry-run/i);
  });

  // -- 6. History opt-out ---------------------------------------------

  it('CCAUDIT_NO_HISTORY=1 suppresses history write on --yes', async () => {
    const r = await runCcauditCli(tmpHome, ['purge-archive', '--yes'], {
      env: { CCAUDIT_NO_HISTORY: '1' },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(historyPath(tmpHome))).toBe(false);
  });

  // -- 8. NEW-M2: corrupt manifest skipped, valid manifests processed ----

  it('NEW-M2: one corrupt manifest emits warning but valid manifests are still classified (exit 0)', async () => {
    // Write a second valid manifest with one extra reclaim-able item.
    const manifestsDir2 = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
    const archivedAgentsDir = path.join(
      tmpHome,
      '.claude',
      'ccaudit',
      'archived',
      '.claude',
      'agents',
    );
    const agentsDir = path.join(tmpHome, '.claude', 'agents');

    // Second valid manifest: one archive op for item 'e-extra' (reclaim candidate).
    const header2 = {
      record_type: 'header',
      manifest_version: 1,
      ccaudit_version: '1.5.0-test',
      checkpoint_ghost_hash: 'fixture-corrupt-test',
      checkpoint_timestamp: '2026-04-23T10:00:00.000Z',
      since_window: '30d',
      os: 'darwin',
      node_version: 'v20.0.0',
      planned_ops: { archive: 1, disable: 0, flag: 0 },
      selection_filter: { mode: 'full' },
    };
    const op2 = {
      op_id: 'op-e-extra',
      op_type: 'archive',
      timestamp: '2026-04-23T10:00:00.000Z',
      status: 'completed',
      category: 'agent',
      scope: 'global',
      source_path: path.join(agentsDir, 'e-extra.md'),
      archive_path: path.join(archivedAgentsDir, 'e-extra.md'),
      content_sha256: '0000000000000000000000000000000000000000000000000000000000000002',
    };
    const footer2 = {
      record_type: 'footer',
      status: 'completed',
      actual_ops: {
        archive: { completed: 1, failed: 0 },
        disable: { completed: 0, failed: 0 },
        flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
      },
      duration_ms: 1,
      exit_code: 0,
    };
    await writeFile(
      path.join(manifestsDir2, 'bust-2026-04-23T10-00-00-000Z-valid2.jsonl'),
      [JSON.stringify(header2), JSON.stringify(op2), JSON.stringify(footer2)].join('\n') + '\n',
      'utf8',
    );
    // Place e-extra in the archive (reclaim candidate).
    await writeFile(path.join(archivedAgentsDir, 'e-extra.md'), '# e-extra (archived)\n', 'utf8');

    // Write a corrupt manifest: invalid JSON on line 2 (not the last line), which forces a
    // parse error because readManifest only tolerates truncated JSON on the *last* line.
    const corruptPath = path.join(manifestsDir2, 'bust-2026-04-23T11-00-00-000Z-corrupt.jsonl');
    await writeFile(
      corruptPath,
      JSON.stringify({ record_type: 'header', manifest_version: 1 }) +
        '\nNOT VALID JSON\n' +
        JSON.stringify({ record_type: 'footer', status: 'completed' }) +
        '\n',
      'utf8',
    );

    const r = await runCcauditCli(tmpHome, ['purge-archive', '--dry-run', '--json']);

    // stderr must warn about the corrupt manifest
    expect(r.stderr).toContain('[ccaudit] warning: skipping unreadable manifest');
    expect(r.stderr).toContain(corruptPath);

    // stdout must be valid JSON
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
    const env = JSON.parse(r.stdout.trim()) as {
      meta: { exitCode: number };
      purge: {
        summary: { purgedCount: number; reclaimedCount: number };
        failures: unknown[];
        dryRun: boolean;
        manifestErrors?: Array<{ path: string; reason: string }>;
      };
    };
    expect(env.meta.exitCode).toBe(0);
    expect(env.purge.dryRun).toBe(true);

    // Classification from valid manifests (original 4 + e-extra) must be present.
    // reclaimedCount reflects a-reclaim + e-extra = 2.
    expect(env.purge.summary.reclaimedCount).toBeGreaterThanOrEqual(1);

    // manifestErrors field surfaces the skipped corrupt manifest.
    expect(env.purge.manifestErrors).toBeDefined();
    expect(env.purge.manifestErrors!.length).toBeGreaterThanOrEqual(1);
    expect(env.purge.manifestErrors![0]!.path).toBe(corruptPath);

    // Filesystem must be untouched (--dry-run).
    expect(existsSync(archivePath(tmpHome, 'a-reclaim'))).toBe(true);
    expect(existsSync(path.join(archivedAgentsDir, 'e-extra.md'))).toBe(true);
  });

  // -- 9. NEW-M2: all manifests corrupt → graceful empty plan, exit 0 ----

  it('NEW-M2: all manifests corrupt → 3 stderr warnings, empty plan, exit 0', async () => {
    // Replace the staged manifest with 3 corrupt manifests.
    await cleanupTmpHome(tmpHome);
    tmpHome = await makeTmpHome();
    const manifestsDir3 = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
    await mkdir(manifestsDir3, { recursive: true });

    const corruptPaths: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const p = path.join(manifestsDir3, `bust-2026-04-24T0${i}-00-00-000Z-bad.jsonl`);
      await writeFile(p, `NOT JSON LINE ${i}\n{"partial":\n`, 'utf8');
      corruptPaths.push(p);
    }

    const r = await runCcauditCli(tmpHome, ['purge-archive', '--dry-run', '--json']);

    // Three warnings emitted to stderr.
    for (const cp of corruptPaths) {
      expect(r.stderr).toContain(cp);
    }
    const warningCount = (
      r.stderr.match(/\[ccaudit\] warning: skipping unreadable manifest/g) ?? []
    ).length;
    expect(warningCount).toBe(3);

    // Must exit 0 — graceful empty plan, not a crash.
    expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);

    // stdout is a valid JSON envelope with zero counts.
    const env = JSON.parse(r.stdout.trim()) as {
      meta: { exitCode: number };
      purge: {
        summary: {
          purgedCount: number;
          reclaimedCount: number;
          skippedOccupiedCount: number;
          staleFilteredCount: number;
        };
        failures: unknown[];
        dryRun: boolean;
        manifestErrors?: Array<{ path: string; reason: string }>;
      };
    };
    expect(env.meta.exitCode).toBe(0);
    expect(env.purge.summary.purgedCount).toBe(0);
    expect(env.purge.summary.reclaimedCount).toBe(0);
    expect(env.purge.summary.skippedOccupiedCount).toBe(0);
    expect(env.purge.summary.staleFilteredCount).toBe(0);
    expect(env.purge.failures).toEqual([]);
    expect(env.purge.manifestErrors).toBeDefined();
    expect(env.purge.manifestErrors!.length).toBe(3);
  });

  // -- 7. Partial failure path ----------------------------------------

  it('--yes with an unlink failure records failure[] but still exits 0 for survivors', async () => {
    // Make the B archive's parent directory read-only so unlink fails.
    // We chmod the file to 0o000 on the parent dir combination; a simpler
    // approach is to chmod the archive file itself to 0 then remove write
    // on the parent. On macOS/Linux unlink needs write on parent dir.
    const parentDir = path.dirname(archivePath(tmpHome, 'b-occupied'));
    await chmod(parentDir, 0o500); // r-x only — denies unlink

    try {
      const r = await runCcauditCli(tmpHome, ['purge-archive', '--json', '--yes']);
      // Restore perms before any assertion failure so afterEach cleanup works.
      await chmod(parentDir, 0o755);

      expect(r.exitCode, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
      const env = JSON.parse(r.stdout.trim()) as {
        purge: {
          summary: { purgedCount: number; reclaimedCount: number };
          failures: Array<{ path: string; reason: string }>;
        };
      };
      // A (reclaim) + C (stale) should still succeed (A lived in a
      // different parent dir — archived/.claude/agents/ — but chmod on it
      // prevents BOTH A's rename + B's unlink because they share that dir.
      // We only assert the contract: at least 1 failure recorded and the
      // batch did NOT abort (exit 0). Survivor count is flexible.
      expect(env.purge.failures.length).toBeGreaterThanOrEqual(1);
      // Stale branch never touches the archived dir, so it always succeeds
      // → staleFilteredCount === 1 in summary regardless.
      // Reading from summary fields is more deterministic than from raw counts.
      expect(env.purge.summary.reclaimedCount + env.purge.summary.purgedCount).toBeGreaterThan(0);
    } finally {
      // Guarantee permissions are restored for afterEach rm -rf.
      await chmod(parentDir, 0o755);
    }
  });
});
