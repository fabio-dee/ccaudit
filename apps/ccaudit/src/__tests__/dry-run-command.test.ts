/**
 * Integration tests for `ccaudit --dry-run`.
 *
 * These tests spawn the built binary (apps/ccaudit/dist/index.js) as a
 * subprocess with HOME pointed at a tmpdir fixture, and assert on the
 * rendered output, JSON envelope, CSV schema, TSV schema, and the
 * resulting checkpoint file at ${tmpHome}/.claude/ccaudit/.last-dry-run.
 *
 * Covers every DRYR-01 integration row + DRYR-02/DRYR-03 end-to-end rows
 * from .planning/phases/07-dry-run-checkpoint/07-RESEARCH.md
 * §Validation Architecture.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, symlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCheckpoint } from '@ccaudit/internal';

// ── Resolve dist path ──────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ lives at apps/ccaudit/src/__tests__ → dist is at apps/ccaudit/dist
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Subprocess runner ──────────────────────────────────────────

interface DryRunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runDryRun(tmpHome: string, flags: string[]): Promise<DryRunOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [distPath, ...flags], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome, // Windows-compat for os.homedir()
        NO_COLOR: '1',        // deterministic ANSI-free output for string assertions
        // Point XDG_CONFIG_HOME into the tmpdir so the dual-path scanner does
        // not observe any real developer inventory under ~/.config/claude.
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ── Fixture builder ────────────────────────────────────────────

interface FixtureSpec {
  /** Agent file basenames to create under ~/.claude/agents/ (e.g., ['stale-one.md']) */
  agents?: string[];
  /** Project path to use in the session JSONL's cwd field */
  sessionProject?: string;
  /** Whether to create the agents directory at all (default: true if agents.length > 0) */
  createAgentsDir?: boolean;
  /**
   * Skill names to create as broken symlinks under ~/.claude/skills/.
   * Each name becomes a symlink pointing at a path that does NOT exist,
   * reproducing the real-world escape where `scanSkills` returns items whose
   * paths cannot be stat'd. Regression fixture for Phase 7 gap 07-04.
   */
  brokenSymlinkSkills?: string[];
}

async function buildFixture(
  tmpHome: string,
  spec: FixtureSpec = {},
): Promise<{ agentPaths: string[] }> {
  const claudeDir = path.join(tmpHome, '.claude');
  await mkdir(claudeDir, { recursive: true });

  const projectPath = spec.sessionProject ?? '/fake/project';
  // discoverSessionFiles glob: `${legacy}/projects/*/*.jsonl`
  // So session-1.jsonl must live directly under projects/<slug>/, not in a sessions/ subdir.
  const sessionDir = path.join(claudeDir, 'projects', 'fake-project');
  await mkdir(sessionDir, { recursive: true });

  // Minimal valid JSONL — one system message carrying cwd, nothing else.
  // Zero tool_use blocks → zero invocations → every defined agent is a ghost.
  const sessionLines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: projectPath,
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionId: 'fixture-session',
    }),
  ];
  await writeFile(
    path.join(sessionDir, 'session-1.jsonl'),
    sessionLines.join('\n') + '\n',
    'utf8',
  );

  const agentPaths: string[] = [];
  const createAgents = spec.createAgentsDir ?? ((spec.agents?.length ?? 0) > 0);
  if (createAgents) {
    const agentsDir = path.join(claudeDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    for (const basename of spec.agents ?? []) {
      const agentPath = path.join(agentsDir, basename);
      await writeFile(
        agentPath,
        `---\nname: ${basename.replace('.md', '')}\n---\n\nStale test agent.\n`,
        'utf8',
      );
      agentPaths.push(agentPath);
      // Backdate the mtime to make the definite-ghost classification
      // robust regardless of whether classifyGhost consults mtimeMs for agents.
      // Agents with zero invocations are already classified as definite-ghost
      // by scan-all.ts, but backdating is belt-and-suspenders.
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      await utimes(agentPath, oldTime, oldTime);
    }
  }

  if (spec.brokenSymlinkSkills && spec.brokenSymlinkSkills.length > 0) {
    const skillsDir = path.join(claudeDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    for (const name of spec.brokenSymlinkSkills) {
      const linkPath = path.join(skillsDir, name);
      const deadTarget = path.join(tmpHome, '_never_exists_', name);
      // Create a symlink pointing at a path that does NOT exist.
      // This reproduces the real-world `~/.claude/skills/full-output-enforcement`
      // crash that escaped Phase 7 verification.
      await symlink(deadTarget, linkPath);
    }
  }

  return { agentPaths };
}

// ── Ensure build is fresh before running subprocess tests ──────

beforeAll(async () => {
  // The pretest hook (Plan 02) regenerates _version.ts automatically.
  // We still need dist/index.js to exist — trigger a build if it is missing.
  if (!existsSync(distPath)) {
    const result = spawnSync('pnpm', ['--filter', 'ccaudit', 'build'], {
      stdio: 'inherit',
      cwd: path.resolve(here, '..', '..', '..', '..'), // repo root
    });
    if (result.status !== 0) {
      throw new Error(`Failed to build ccaudit before integration tests: exit ${result.status}`);
    }
  }
  if (!existsSync(distPath)) {
    throw new Error(`dist/index.js still missing after build attempt at ${distPath}`);
  }
}, 120_000);

// ── Test cases ──────────────────────────────────────────────────

describe('ccaudit --dry-run (integration, DRYR-01/02/03)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-dry-run-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('produces change-plan output end-to-end against fixture tmpdir (DRYR-01 default)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md', 'stale-two.md'] });
    const { code, stdout, stderr } = await runDryRun(tmpHome, ['--dry-run']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('Dry-Run'); // header title
    expect(stdout).toContain('Will ARCHIVE'); // D-06 group header
    expect(stdout).toContain('Estimated savings:'); // savings line always present
    expect(stdout).toContain('Checkpoint:'); // footer line
    expect(stdout).toContain('Next: ccaudit --dangerously-bust-ghosts'); // CTA line
  }, 30_000);

  it('--dry-run --json envelope contains dryRun: true + changePlan + checkpoint (DRYR-01)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md'] });
    const { code, stdout, stderr } = await runDryRun(tmpHome, ['--dry-run', '--json']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    const meta = envelope.meta as Record<string, unknown>;
    expect(meta.command).toBe('ghost');
    expect(meta.exitCode).toBe(0);
    expect(envelope.dryRun).toBe(true);

    const changePlan = envelope.changePlan as Record<string, unknown>;
    expect(changePlan).toHaveProperty('archive');
    expect(changePlan).toHaveProperty('disable');
    expect(changePlan).toHaveProperty('flag');
    expect(changePlan).toHaveProperty('counts');
    expect(changePlan).toHaveProperty('savings');
    expect(Array.isArray(changePlan.archive)).toBe(true);
    expect(Array.isArray(changePlan.disable)).toBe(true);
    expect(Array.isArray(changePlan.flag)).toBe(true);

    const checkpoint = envelope.checkpoint as Record<string, unknown>;
    expect(checkpoint).toHaveProperty('path');
    expect(checkpoint).toHaveProperty('ghost_hash');
    expect(checkpoint).toHaveProperty('timestamp');
    expect(checkpoint).toHaveProperty('ccaudit_version');
    expect(checkpoint.checkpoint_version).toBe(1);
    expect(checkpoint.ghost_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 30_000);

  it('--dry-run --csv emits one row per item with 8-column schema (DRYR-01)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md', 'stale-two.md'] });
    const { code, stdout, stderr } = await runDryRun(tmpHome, ['--dry-run', '--csv']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('action,category,name,scope,projectPath,path,tokens,tier');
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 data rows
    // Each data row has 8 comma-separated fields. Tmpdir paths on macOS/Linux
    // do not contain commas, so naive split is safe for this fixture.
    for (const row of lines.slice(1)) {
      expect(row.split(',').length).toBe(8);
    }
  }, 30_000);

  it('--dry-run --quiet emits TSV rows with 8 columns and no header (DRYR-01)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md', 'stale-two.md'] });
    const { code, stdout, stderr } = await runDryRun(tmpHome, ['--dry-run', '--quiet']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2); // 2 data rows, no header
    for (const row of lines) {
      expect(row.split('\t').length).toBe(8);
    }
    // Verify no literal header row leaked into TSV output
    expect(stdout).not.toContain('action\tcategory');
  }, 30_000);

  it('exits 0 with zero ghosts and still writes checkpoint (D-03, D-04 — DRYR-01)', async () => {
    // No agents, but session file must exist so discoverSessionFiles returns >=1 file
    await buildFixture(tmpHome, { agents: [], createAgentsDir: false });
    const { code, stderr } = await runDryRun(tmpHome, ['--dry-run']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    const checkpointPath = path.join(tmpHome, '.claude', 'ccaudit', '.last-dry-run');
    const s = await stat(checkpointPath);
    expect(s.isFile()).toBe(true);
  }, 30_000);

  it('writes checkpoint at ~/.claude/ccaudit/.last-dry-run with full D-17 schema (DRYR-02)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md'] });
    const { code, stderr } = await runDryRun(tmpHome, ['--dry-run']);
    expect(code, `stderr: ${stderr}`).toBe(0);
    const checkpointPath = path.join(tmpHome, '.claude', 'ccaudit', '.last-dry-run');
    const result = await readCheckpoint(checkpointPath);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const cp = result.checkpoint;
      expect(cp.checkpoint_version).toBe(1);
      expect(typeof cp.ccaudit_version).toBe('string');
      expect(cp.ccaudit_version.length).toBeGreaterThan(0);
      expect(cp.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(cp.since_window).toBe('7d'); // default window
      expect(cp.ghost_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(cp.item_count).toMatchObject({
        agents: expect.any(Number),
        skills: expect.any(Number),
        mcp: expect.any(Number),
        memory: expect.any(Number),
      });
      expect(typeof cp.savings.tokens).toBe('number');
    }
  }, 30_000);

  it('re-running --dry-run against unchanged fixture produces identical ghost_hash (DRYR-03 stability)', async () => {
    await buildFixture(tmpHome, { agents: ['stale-one.md', 'stale-two.md'] });
    const checkpointPath = path.join(tmpHome, '.claude', 'ccaudit', '.last-dry-run');

    const first = await runDryRun(tmpHome, ['--dry-run']);
    expect(first.code, `first run stderr: ${first.stderr}`).toBe(0);
    const firstRead = await readCheckpoint(checkpointPath);
    expect(firstRead.status).toBe('ok');
    const hash1 = firstRead.status === 'ok' ? firstRead.checkpoint.ghost_hash : '';

    const second = await runDryRun(tmpHome, ['--dry-run']);
    expect(second.code, `second run stderr: ${second.stderr}`).toBe(0);
    const secondRead = await readCheckpoint(checkpointPath);
    expect(secondRead.status).toBe('ok');
    const hash2 = secondRead.status === 'ok' ? secondRead.checkpoint.ghost_hash : '';

    expect(hash1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
  }, 60_000);

  it('mutating an agent mtime between runs produces a different ghost_hash (DRYR-03 invalidation)', async () => {
    const { agentPaths } = await buildFixture(tmpHome, { agents: ['stale-one.md'] });
    const checkpointPath = path.join(tmpHome, '.claude', 'ccaudit', '.last-dry-run');

    const first = await runDryRun(tmpHome, ['--dry-run']);
    expect(first.code, `first run stderr: ${first.stderr}`).toBe(0);
    const firstRead = await readCheckpoint(checkpointPath);
    expect(firstRead.status).toBe('ok');
    const hash1 = firstRead.status === 'ok' ? firstRead.checkpoint.ghost_hash : '';

    // Bump agent mtime by advancing 5 minutes. Still definite-ghost
    // (60d backdate - 5min is still well past the 30d boundary).
    const newTime = new Date(Date.now() + 5 * 60 * 1000);
    await utimes(agentPaths[0]!, newTime, newTime);

    const second = await runDryRun(tmpHome, ['--dry-run']);
    expect(second.code, `second run stderr: ${second.stderr}`).toBe(0);
    const secondRead = await readCheckpoint(checkpointPath);
    expect(secondRead.status).toBe('ok');
    const hash2 = secondRead.status === 'ok' ? secondRead.checkpoint.ghost_hash : '';

    expect(hash1).not.toBe(hash2);
  }, 60_000);

  it('should succeed when ~/.claude/skills/ contains a broken symlink (gap 07-04 regression)', async () => {
    await buildFixture(tmpHome, {
      agents: ['stale-agent.md'],
      brokenSymlinkSkills: ['full-output-enforcement', 'orphaned-skill'],
    });

    const { code, stdout, stderr } = await runDryRun(tmpHome, ['--dry-run']);

    // Must not crash. Exit code is 0 (per Phase 7 D-03: dry-run always exits 0
    // on successful scan+checkpoint-write, even with ghosts present).
    expect(code).toBe(0);

    // Stderr must contain no ENOENT stack trace and no uncaught error text.
    expect(stderr).not.toContain('ENOENT');
    expect(stderr).not.toContain('Error:');
    expect(stderr).not.toMatch(/at async Promise\.all/);

    // Stdout should include the dry-run header (Phase 7 D-06).
    expect(stdout).toMatch(/Dry.?Run/i);

    // Checkpoint file must exist and carry a valid sha256 hash.
    const checkpointPath = path.join(tmpHome, '.claude', 'ccaudit', '.last-dry-run');
    const body = await readFile(checkpointPath, 'utf8');
    const checkpoint = JSON.parse(body) as { ghost_hash: string };
    expect(checkpoint.ghost_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
