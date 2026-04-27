/**
 * Manual QA follow-up fixture builders for v1.5 Phase 9/10 ship-gate gaps.
 *
 * These helpers intentionally create disposable HOME trees on disk. They are
 * meant for regression tests that drive the real CLI/TUI after manual QA found
 * mismatches in:
 *   - purge-archive idempotency (G6)
 *   - purge-archive ignoring flag + MCP disable ops (G4)
 *   - glyph rendering / help legend coverage (E1/E4)
 *   - 500+ item pagination + filter Esc behavior (D1/D2)
 *   - interactive bust -> restore smoke (H2)
 *
 * Callers supply `tmpHome` (usually from makeTmpHome()). All paths are written
 * under that HOME only; no real ~/.claude state is touched.
 */
import { chmod, mkdir, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OLD_DATE = new Date('2020-01-01T00:00:00.000Z');

export const MANUAL_QA_PROJECT_ROOT = 'fixture-project';

export interface ManualQaFixturePaths {
  home: string;
  projectRoot: string;
}

export interface ArchiveOpSpec {
  /** Agent name used for source/archive `<name>.md`. */
  name: string;
  /** Whether the archive file exists on disk. */
  archiveOnDisk: boolean;
  /** Whether the original source file exists on disk. */
  sourceOnDisk: boolean;
}

export const PURGE_MIXED_SPECS: readonly ArchiveOpSpec[] = [
  // A: archive exists, source free -> reclaim candidate.
  { name: 'a-reclaim', archiveOnDisk: true, sourceOnDisk: false },
  // B: archive exists, source occupied -> drop/source_occupied candidate.
  { name: 'b-occupied', archiveOnDisk: true, sourceOnDisk: true },
  // C: archive missing, source exists -> stale_archive_missing candidate.
  { name: 'c-stale', archiveOnDisk: false, sourceOnDisk: true },
  // D: archive missing, source missing -> both_missing broken-state skip.
  { name: 'd-broken', archiveOnDisk: false, sourceOnDisk: false },
] as const;

export async function stageFakePs(tmpHome: string): Promise<string> {
  const binDir = path.join(tmpHome, 'bin');
  await mkdir(binDir, { recursive: true });
  const psPath = path.join(binDir, 'ps');
  await writeFile(
    psPath,
    `#!/bin/sh
case "$*" in
  *-A*) echo "    1 init" ;;
  *-o\\ ppid=*) echo "1" ;;
  *) echo "    1 init" ;;
esac
`,
    'utf8',
  );
  await chmod(psPath, 0o755);
  return binDir;
}

async function writeRecentSession(tmpHome: string, cwd: string): Promise<void> {
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'manual-qa');
  await mkdir(sessionDir, { recursive: true });
  const line = JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd,
    timestamp: new Date().toISOString(),
    sessionId: 'manual-qa-fixture',
  });
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), `${line}\n`, 'utf8');
}

async function writeTaskSession(tmpHome: string, cwd: string, subagentType: string): Promise<void> {
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'manual-qa');
  await mkdir(sessionDir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    sessionId: 'manual-qa-framework',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_manual_qa_1',
          name: 'Task',
          input: { subagent_type: subagentType, prompt: 'fixture invocation' },
        },
      ],
    },
  });
  // Include an init line too so project-root discovery has a cwd anchor.
  const init = JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd,
    timestamp: new Date().toISOString(),
    sessionId: 'manual-qa-framework',
  });
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), `${init}\n${line}\n`, 'utf8');
}

function manifestsDir(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
}

function archivedAgentsDir(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'archived', '.claude', 'agents');
}

function agentsDir(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'agents');
}

function sourcePath(tmpHome: string, name: string): string {
  return path.join(agentsDir(tmpHome), `${name}.md`);
}

function archivePath(tmpHome: string, name: string): string {
  return path.join(archivedAgentsDir(tmpHome), `${name}.md`);
}

/**
 * Stage the mixed purge classifier fixture used by Phase 9 G1/G3/G5/G6.
 *
 * By default it writes archive ops only. Set `includeFlagAndDisableOps` for
 * Phase 9 G4 coverage: purge must reclaim/drop archive ops while leaving memory
 * frontmatter flags and disabled MCP keys untouched.
 */
export async function stagePurgeMixedFixture(
  tmpHome: string,
  opts: { includeFlagAndDisableOps?: boolean } = {},
): Promise<void> {
  await mkdir(manifestsDir(tmpHome), { recursive: true });
  await mkdir(archivedAgentsDir(tmpHome), { recursive: true });
  await mkdir(agentsDir(tmpHome), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude'), { recursive: true });

  const archiveOps = PURGE_MIXED_SPECS.map((spec) => ({
    op_id: `op-${spec.name}`,
    op_type: 'archive',
    timestamp: '2026-04-22T09:00:00.000Z',
    status: 'completed',
    category: 'agent',
    scope: 'global',
    source_path: sourcePath(tmpHome, spec.name),
    archive_path: archivePath(tmpHome, spec.name),
    content_sha256: '0'.repeat(64),
  }));

  const extraOps: unknown[] = [];
  if (opts.includeFlagAndDisableOps === true) {
    const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
    await writeFile(
      memoryPath,
      [
        '---',
        'ccaudit-stale: "2026-04-22T09:00:00.000Z"',
        'ccaudit-flagged: "2026-04-22T09:00:00.000Z"',
        '---',
        '# flagged memory fixture',
        '',
      ].join('\n'),
      'utf8',
    );

    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    await writeFile(
      claudeJsonPath,
      JSON.stringify(
        {
          mcpServers: {
            'ccaudit-disabled:serverA': { command: 'npx', args: ['server-a'] },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    extraOps.push(
      {
        op_id: 'op-memory-flag',
        op_type: 'flag',
        timestamp: '2026-04-22T09:00:00.001Z',
        status: 'completed',
        file_path: memoryPath,
        scope: 'global',
        had_frontmatter: false,
        had_ccaudit_stale: false,
        patched_keys: ['ccaudit-stale', 'ccaudit-flagged'],
        original_content_sha256: '1'.repeat(64),
      },
      {
        op_id: 'op-mcp-disable',
        op_type: 'disable',
        timestamp: '2026-04-22T09:00:00.002Z',
        status: 'completed',
        config_path: claudeJsonPath,
        scope: 'global',
        project_path: null,
        original_key: 'serverA',
        new_key: 'ccaudit-disabled:serverA',
        original_value: { command: 'npx', args: ['server-a'] },
      },
    );
  } else {
    await writeFile(path.join(tmpHome, '.claude.json'), '{}\n', 'utf8');
  }

  const header = {
    record_type: 'header',
    manifest_version: 1,
    ccaudit_version: '1.5.0-test',
    checkpoint_ghost_hash: 'manual-qa-purge-fixture',
    checkpoint_timestamp: '2026-04-22T09:00:00.000Z',
    since_window: '30d',
    os: 'darwin',
    node_version: 'v20.0.0',
    planned_ops: {
      archive: archiveOps.length,
      disable: opts.includeFlagAndDisableOps === true ? 1 : 0,
      flag: opts.includeFlagAndDisableOps === true ? 1 : 0,
    },
    selection_filter: { mode: 'full' },
  };
  const footer = {
    record_type: 'footer',
    status: 'completed',
    actual_ops: {
      archive: { completed: archiveOps.length, failed: 0 },
      disable: { completed: opts.includeFlagAndDisableOps === true ? 1 : 0, failed: 0 },
      flag: {
        completed: opts.includeFlagAndDisableOps === true ? 1 : 0,
        failed: 0,
        refreshed: 0,
        skipped: 0,
      },
    },
    duration_ms: 1,
    exit_code: 0,
  };

  const records = [header, ...archiveOps, ...extraOps, footer];
  await writeFile(
    path.join(manifestsDir(tmpHome), 'bust-2026-04-22T09-00-00-000Z-manual-qa.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  for (const spec of PURGE_MIXED_SPECS) {
    if (spec.archiveOnDisk) {
      await writeFile(archivePath(tmpHome, spec.name), `# ${spec.name} archived\n`, 'utf8');
    }
    if (spec.sourceOnDisk) {
      await writeFile(sourcePath(tmpHome, spec.name), `# ${spec.name} source\n`, 'utf8');
    }
  }
}

/**
 * Stage the post-first-purge state directly: original archive ops remain in the
 * bust manifest, a purge manifest contains archive_purge follow-ups, and disk
 * state matches a completed purge. `purge-archive --yes` should no-op here.
 */
export async function stageAlreadyPurgedFixture(tmpHome: string): Promise<void> {
  await stagePurgeMixedFixture(tmpHome);

  // Remove the archive files for a-reclaim and b-occupied so the disk state
  // actually matches a completed purge (M1: archives must be absent).
  for (const name of ['a-reclaim', 'b-occupied'] as const) {
    try {
      await unlink(archivePath(tmpHome, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Disk state after a successful purge: A/B archives gone, A source restored,
  // B/C sources present, D remains both-missing.
  await writeFile(sourcePath(tmpHome, 'a-reclaim'), '# a-reclaim reclaimed\n', 'utf8');

  const purgeHeader = {
    record_type: 'header',
    manifest_version: 1,
    ccaudit_version: '1.5.0-test',
    checkpoint_ghost_hash: 'manual-qa-purge-followup',
    checkpoint_timestamp: '2026-04-22T09:01:00.000Z',
    since_window: '30d',
    os: 'darwin',
    node_version: 'v20.0.0',
    planned_ops: { archive: 0, disable: 0, flag: 0 },
    selection_filter: { mode: 'full' },
  };
  const purgeOps = [
    { original_op_id: 'op-a-reclaim', reason: 'reclaimed' },
    { original_op_id: 'op-b-occupied', reason: 'source_occupied' },
    { original_op_id: 'op-c-stale', reason: 'stale_archive_missing' },
  ].map((op, i) => ({
    op_id: `purge-${i + 1}`,
    op_type: 'archive_purge',
    timestamp: '2026-04-22T09:01:00.000Z',
    status: 'completed',
    original_op_id: op.original_op_id,
    purged: true,
    reason: op.reason,
  }));
  const purgeFooter = {
    record_type: 'footer',
    status: 'completed',
    actual_ops: {
      archive: { completed: 0, failed: 0 },
      disable: { completed: 0, failed: 0 },
      flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
    },
    duration_ms: 1,
    exit_code: 0,
  };

  await writeFile(
    path.join(manifestsDir(tmpHome), 'purge-2026-04-22T09-01-00-000Z-manual-qa.jsonl'),
    [purgeHeader, ...purgeOps, purgeFooter].map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

/**
 * Fixture for glyph/manual TUI coverage. It contains:
 *   - selected/unselected-capable agent rows
 *   - a partially-used GSD framework member (protected without --force-partial)
 *   - multi-config MCP server (`shared`) in ~/.claude.json and project .mcp.json
 *   - stale memory file
 *
 * Run the CLI with cwd set to `projectRoot` so project-local MCP discovery is
 * in scope. Use `--force-partial` when you want selectable framework rows; omit
 * it when asserting the lock/protected glyph.
 */
export async function stageGlyphFixture(tmpHome: string): Promise<ManualQaFixturePaths> {
  const projectRoot = path.join(tmpHome, MANUAL_QA_PROJECT_ROOT);
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const usedAgent = path.join(tmpHome, '.claude', 'agents', 'gsd-planner.md');
  const protectedGhost = path.join(tmpHome, '.claude', 'agents', 'gsd-researcher.md');
  const soloGhost = path.join(tmpHome, '.claude', 'agents', 'solo.md');
  await writeFile(usedAgent, '# gsd-planner used\n', 'utf8');
  await writeFile(protectedGhost, '# gsd-researcher ghost\n', 'utf8');
  await writeFile(soloGhost, '# solo ghost\n', 'utf8');
  await utimes(protectedGhost, OLD_DATE, OLD_DATE);
  await utimes(soloGhost, OLD_DATE, OLD_DATE);

  const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
  await writeFile(memoryPath, '# stale memory\n', 'utf8');
  await utimes(memoryPath, OLD_DATE, OLD_DATE);

  await writeTaskSession(tmpHome, projectRoot, 'gsd-planner');

  const sharedServer = { command: 'npx', args: ['shared'] };
  await writeFile(
    path.join(tmpHome, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          shared: sharedServer,
          single: { command: 'npx', args: ['single'] },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    path.join(projectRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { shared: sharedServer } }, null, 2) + '\n',
    'utf8',
  );

  return { home: tmpHome, projectRoot };
}

/** Build a real filesystem 500+ ghost inventory for TTY pagination tests. */
export async function stagePaginationFixture(tmpHome: string, count = 550): Promise<void> {
  if (count < 1 || count > 999) {
    throw new Error(`stagePaginationFixture: count must be 1..999 (got ${count})`);
  }
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  const chunkSize = 50;
  for (let start = 1; start <= count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize - 1);
    await Promise.all(
      Array.from({ length: end - start + 1 }, async (_, idx) => {
        const i = start + idx;
        const name = `agent-${String(i).padStart(3, '0')}`;
        const filePath = path.join(tmpHome, '.claude', 'agents', `${name}.md`);
        await writeFile(filePath, `# ${name} ghost\n`, 'utf8');
        await utimes(filePath, OLD_DATE, OLD_DATE);
      }),
    );
  }
  await writeFile(path.join(tmpHome, '.claude.json'), '{}\n', 'utf8');
  await writeRecentSession(tmpHome, '/fixture/pagination');
}

/** Build the minimal HOME for a real `ghost -i` archive then restore smoke. */
export async function stageInteractiveBustFixture(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  const agentPath = path.join(tmpHome, '.claude', 'agents', 'h2-solo.md');
  await writeFile(agentPath, '# h2-solo ghost\n', 'utf8');
  await utimes(agentPath, OLD_DATE, OLD_DATE);
  await writeFile(path.join(tmpHome, '.claude.json'), '{}\n', 'utf8');
  await writeRecentSession(tmpHome, '/fixture/h2');
  await stageFakePs(tmpHome);
}
