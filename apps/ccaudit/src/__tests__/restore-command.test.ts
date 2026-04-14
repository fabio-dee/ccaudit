/**
 * Subprocess integration tests for `ccaudit restore`.
 *
 * Spawns the built binary (apps/ccaudit/dist/index.js) with HOME overridden
 * to a tmpdir fixture, asserts exit codes, stdout/stderr, and on-disk side
 * effects. Mirrors the pattern from bust-command.test.ts.
 *
 * Coverage:
 *   RMED-11: full restore and partial-bust scenarios
 *   RMED-12: single-item restore by name
 *   RMED-13: --list read-only listing
 *
 *   Exit code 0: success, no-manifests, name-not-found, list, partial-bust
 *   Exit code 1: manifest-corrupt (header missing)
 *   Exit code 3: running-process (Claude detected), process-detection-failed
 *
 * Local-vs-CI note
 * ─────────────────
 * The restore command's preflight runs `ps -A -o pid=,comm=` to detect any
 * running Claude Code process (D-14). On a CI runner with no Claude Code, the
 * detector finds zero matching processes and the pipeline proceeds. When this
 * test suite runs from INSIDE a Claude Code session, the real `ps` would find
 * the enclosing Claude process and every restore test would fail with exit 3.
 *
 * Solution: each test writes a FAKE `ps` script into `<tmpHome>/bin/ps` that
 * emits only pid 1 (init) for `-A` calls and `1` for `-o ppid=` parent-chain
 * walks. The subprocess is spawned with `PATH=<tmpHome>/bin:...` so the fake
 * is found before the real `ps`. This works identically in CI and local.
 *
 * The process-detection-failed test (Case 13) deliberately makes the fake ps
 * non-executable (chmod 000) so spawn fails → exit 3.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ── Resolve dist path ──────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ lives at apps/ccaudit/src/__tests__ -> dist is at apps/ccaudit/dist
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Types ──────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface RunOpts {
  timeout?: number;
  /** Optional PATH override — defaults to `<tmpHome>/bin:<original PATH>`. */
  pathOverride?: string;
}

// ── Guard: dist must exist before any test runs ─────────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `ccaudit dist not built. Run 'pnpm -F ccaudit build' before the restore integration tests.`,
    );
  }
});

// ── Fake ps script body ────────────────────────────────────────────

/**
 * POSIX shell script that impersonates `ps` for the restore preflight.
 * Emits only pid 1 (init) for `-A` listings so CLAUDE_NAME_REGEX finds no
 * matches, and pid `1` for parent-chain walks so walkParentChain terminates
 * immediately.
 *
 * Installed into `<tmpHome>/bin/ps` by `installFakePs`, then the subprocess
 * is spawned with `PATH=<tmpHome>/bin:...` so the fake is found first.
 */
const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit restore integration tests.
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

// ── Subprocess runner ──────────────────────────────────────────────

/**
 * Spawn `ccaudit restore [flags]` with HOME overridden to `tmpHome`.
 *
 * PATH is prefixed with `<tmpHome>/bin` so the fake `ps` is always found
 * before the real system `ps`. stdin is closed immediately (isTTY=false).
 * NO_COLOR=1 strips all ANSI for deterministic assertions.
 */
async function runRestore(
  tmpHome: string,
  flags: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const originalPath = process.env.PATH ?? '';
    const defaultPath = `${path.join(tmpHome, 'bin')}:${originalPath}`;
    const child = spawn(process.execPath, [distPath, 'restore', ...flags], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        PATH: opts.pathOverride ?? defaultPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — ensures isTTY === false inside the subprocess.
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = opts.timeout ?? 30_000;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`restore command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Spawn `ccaudit [flags]` without a hardcoded subcommand.
 * Used by the round-trip test to invoke --dry-run and --dangerously-bust-ghosts.
 */
async function runCli(tmpHome: string, flags: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const originalPath = process.env.PATH ?? '';
    const defaultPath = `${path.join(tmpHome, 'bin')}:${originalPath}`;
    const child = spawn(process.execPath, [distPath, ...flags], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        PATH: opts.pathOverride ?? defaultPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = opts.timeout ?? 30_000;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`runCli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (!killed) resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// ── Fake ps installer ──────────────────────────────────────────────

/**
 * Write a fake `ps` bash script into `<tmpHome>/bin/ps` and mark it
 * executable. When `processes` array is empty, the fake emits only
 * pid 1 (init) — process gate passes. When non-empty, emits those
 * processes so the gate fails with running-process.
 */
async function installFakePs(
  tmpHome: string,
  processes: Array<{ pid: number; cmd: string }> = [],
): Promise<void> {
  const binDir = path.join(tmpHome, 'bin');
  await mkdir(binDir, { recursive: true });

  let script: string;
  if (processes.length === 0) {
    // Empty process list — gate passes.
    script = FAKE_PS_SCRIPT;
  } else {
    // Emit the requested processes so the gate finds them.
    const lines = processes.map((p) => `    ${p.pid} ${p.cmd}`).join('\n');
    script = `#!/bin/sh\necho "    1 init"\n${lines
      .split('\n')
      .map((l) => `echo "${l}"`)
      .join('\n')}\n`;
  }

  await writeFile(path.join(binDir, 'ps'), script, { mode: 0o755 });
  // Also provide a tasklist stub for Windows-like test environments (no-op on macOS/Linux).
  await writeFile(path.join(binDir, 'tasklist'), '#!/bin/sh\necho ""\n', { mode: 0o755 });
}

// ── Fixture builders ───────────────────────────────────────────────

/**
 * Create a fresh isolated tmpHome with the minimum directory structure.
 * Installs the empty fake ps (gate passes).
 */
async function setupEmptyHome(): Promise<string> {
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-restore-'));
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'ccaudit', 'manifests'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  await installFakePs(tmpHome); // empty → gate passes
  return tmpHome;
}

interface FixtureResult {
  tmpHome: string;
  manifestPath: string;
  archivedAgentPath: string;
  agentSourcePath: string;
  contentSha256: string;
}

interface BuildFixtureOptions {
  /** If false, skip writing the archived file to disk. Default: true */
  includeArchive?: boolean;
  /** If false, skip writing the footer record. Default: true */
  includeFooter?: boolean;
  /** If false, skip writing the header record. Default: true */
  includeHeader?: boolean;
  /** If true, write extra content into the archive to cause SHA256 mismatch. Default: false */
  tamperArchive?: boolean;
}

/**
 * Build a basic fixture with one archived agent.
 *
 * Writes a JSONL manifest in the manifests directory that simulates a
 * completed Phase 8 bust. The manifest contains:
 *   - header record (unless includeHeader: false)
 *   - one archive op for 'code-reviewer.md'
 *   - footer record (unless includeFooter: false)
 *
 * The archived file is placed at `.claude/ccaudit/archived/agents/code-reviewer.md`
 * (unless includeArchive: false). The source path where it should be restored
 * is `.claude/agents/code-reviewer.md`.
 */
async function buildBasicFixture(options: BuildFixtureOptions = {}): Promise<FixtureResult> {
  const {
    includeArchive = true,
    includeFooter = true,
    includeHeader = true,
    tamperArchive = false,
  } = options;

  const tmpHome = await setupEmptyHome();
  const archivedDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
  await mkdir(archivedDir, { recursive: true });

  const archivedAgentPath = path.join(archivedDir, 'code-reviewer.md');
  const agentSourcePath = path.join(tmpHome, '.claude', 'agents', 'code-reviewer.md');
  const content = '# Code Reviewer\n\nA sample agent for integration tests.\n';

  // Write the actual archived file (unless skipped)
  if (includeArchive) {
    const writeContent = tamperArchive ? content + '\nEXTRA CONTENT — TAMPERED\n' : content;
    await writeFile(archivedAgentPath, writeContent);
  }

  // SHA256 of the ORIGINAL content (what the manifest records)
  const contentSha256 = createHash('sha256').update(content).digest('hex');

  // Build the manifest JSONL lines
  const manifestPath = path.join(
    tmpHome,
    '.claude',
    'ccaudit',
    'manifests',
    'bust-2026-04-05T18-30-00Z.jsonl',
  );

  const lines: string[] = [];

  if (includeHeader) {
    lines.push(
      JSON.stringify({
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.2.0',
        checkpoint_ghost_hash: 'fake-hash-for-test',
        checkpoint_timestamp: '2026-04-05T18:30:00.000Z',
        since_window: '30d',
        os: process.platform,
        node_version: process.version,
        planned_ops: { archive: 1, disable: 0, flag: 0 },
      }),
    );
  }

  // Archive op: records where agent was and where it went
  lines.push(
    JSON.stringify({
      op_id: 'test-op-001',
      op_type: 'archive',
      timestamp: '2026-04-05T18:30:01.000Z',
      status: 'completed',
      category: 'agent',
      scope: 'global',
      source_path: agentSourcePath,
      archive_path: archivedAgentPath,
      content_sha256: contentSha256,
    }),
  );

  if (includeFooter) {
    lines.push(
      JSON.stringify({
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 1, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 150,
        exit_code: 0,
      }),
    );
  }

  await writeFile(manifestPath, lines.join('\n') + '\n');

  return { tmpHome, manifestPath, archivedAgentPath, agentSourcePath, contentSha256 };
}

// ── Test suite ─────────────────────────────────────────────────────

// Windows: subprocess tests rely on fake `ps` shell scripts that require /bin/sh.
describe.skipIf(process.platform === 'win32')('ccaudit restore (subprocess integration)', () => {
  let tmpHome: string;

  beforeEach(() => {
    // Reset tmpHome before each test so afterEach can unconditionally clean up.
    tmpHome = '';
  });

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  // ── Case 1: no manifests → exit 0 with message (RMED-11) ──────────

  it('Case 1: exits 0 with message when no bust history exists', async () => {
    tmpHome = await setupEmptyHome();
    const result = await runRestore(tmpHome, []);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('No bust history found');
  });

  // ── Case 2: full restore happy path (RMED-11) ─────────────────────

  it('Case 2: performs full restore from newest manifest', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, []);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    // stdout should mention "restore" in some form
    expect(result.stdout.toLowerCase()).toMatch(/restore/);

    // Archive file should be moved back to source path
    expect(existsSync(fixture.agentSourcePath)).toBe(true);
    // Archive location should be empty
    expect(existsSync(fixture.archivedAgentPath)).toBe(false);
  });

  // ── Case 3: single-item restore by name (RMED-12) ─────────────────

  it('Case 3: restores single archived item by name', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['code-reviewer']);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    // Source path should be restored
    expect(existsSync(fixture.agentSourcePath)).toBe(true);
  });

  // ── Case 4: --list output (RMED-13) ───────────────────────────────

  it('Case 4: lists archived items with bust grouping and item names', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['--list']);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    // Should show the "Archived items" header
    expect(result.stdout).toContain('Archived items');
    // Should show the date portion of the manifest timestamp
    expect(result.stdout).toContain('2026-04-05');
    // Should show the agent name
    expect(result.stdout).toContain('code-reviewer');
    // Should show the "clean bust" label (footer present)
    expect(result.stdout).toContain('clean bust');
  });

  // ── Case 5: partial bust warning (D-06) ───────────────────────────

  it('Case 5: warns and proceeds on partial bust (no footer)', async () => {
    const fixture = await buildBasicFixture({ includeFooter: false });
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['--verbose']);
    // Partial bust: header present, footer absent → warn and proceed
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    // Warning should appear somewhere in the output
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/partial bust|partial|no completion record/i);

    // Restore should still have proceeded
    expect(existsSync(fixture.agentSourcePath)).toBe(true);
  });

  // ── Case 6: corrupt manifest (no header) → exit 1 (D-07) ─────────

  it('Case 6: refuses with exit 1 on corrupt manifest (header missing)', async () => {
    const fixture = await buildBasicFixture({ includeHeader: false });
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, []);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);

    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/corrupt|header/i);
  });

  // ── Case 7: process gate → exit 3 (D-14) ─────────────────────────

  it('Case 7: exits 3 when Claude Code is running (process gate)', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    // Overwrite fake ps to report a claude process as running
    await installFakePs(tmpHome, [{ pid: 9999, cmd: 'claude' }]);

    const result = await runRestore(tmpHome, []);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(3);

    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/running|9999|Claude Code/i);
  });

  // ── Case 8: --json envelope parseable (D-16) ─────────────────────

  it('Case 8: emits parseable JSON envelope with --json', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['--json']);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    // stdout should be valid JSON
    let parsed: Record<string, unknown>;
    expect(() => {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    }).not.toThrow();
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    // Envelope structure: { meta: { command, version, ... }, status, counts, ... }
    // buildJsonEnvelope spreads restoreResultToJson's payload directly (no 'data' wrapper).
    const meta = parsed.meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.command).toBe('restore');
    // restoreResultToJson spreads status + counts at top level of the envelope
    expect(parsed.status).toBe('success');
    expect(parsed.counts).toBeDefined();
  });

  // ── Case 9: name-not-found → exit 0 with message (D-05) ──────────

  it('Case 9: exits 0 with message when named item not found', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['nonexistent-item-xyz']);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|No archived item/i);
  });

  // ── Case 10: tamper detection warn-and-proceed (D-13) ─────────────

  it('Case 10: warns on SHA256 mismatch but restores anyway', async () => {
    const fixture = await buildBasicFixture({ tamperArchive: true });
    tmpHome = fixture.tmpHome;

    const result = await runRestore(tmpHome, ['--verbose']);
    // Should still succeed (warn and proceed, not abort)
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    // Warning about modification/tampering should appear
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/modified|tamper|sha|checksum/i);

    // Restore should still have proceeded
    expect(existsSync(fixture.agentSourcePath)).toBe(true);
  });

  // ── Case 11: --list skips process gate (D-14 read-only exception) ──

  it('Case 11: --list succeeds even when Claude Code is running', async () => {
    const fixture = await buildBasicFixture();
    tmpHome = fixture.tmpHome;

    // Set the fake ps to report a running claude process
    await installFakePs(tmpHome, [{ pid: 9999, cmd: 'claude' }]);

    // --list is read-only and should bypass the process gate
    const result = await runRestore(tmpHome, ['--list']);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    // Listing should still show items
    expect(result.stdout).toContain('Archived items');
  });

  // ── Case 12: round-trip bust → restore (RMED-11 holistic) ─────────

  it('Case 12: round-trip bust → restore reverses all operations', async () => {
    // ── Fixture setup ─────────────────────────────────────────────
    tmpHome = await setupEmptyHome();

    // 1. Session JSONL (required for discoverSessionFiles)
    const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
    await mkdir(sessionDir, { recursive: true });
    const sessionLine = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/project',
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionId: 'fixture-session',
    });
    await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLine + '\n', 'utf8');

    // 2. Ghost agent
    const agentContent = '# Ghost Agent\n\nA test agent for round-trip.\n';
    const agentPath = path.join(tmpHome, '.claude', 'agents', 'round-trip-agent.md');
    await writeFile(agentPath, agentContent, 'utf8');

    // 3. Ghost MCP in ~/.claude.json
    const originalMcpValue = { command: 'npx', args: ['rt'] };
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    await writeFile(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { 'round-trip-mcp': originalMcpValue } }),
      'utf8',
    );

    // 4. Ghost memory file with old mtime (40 days ago → definite-ghost)
    const memoryContent = '# Round-trip memory\n';
    const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
    await writeFile(memoryPath, memoryContent, 'utf8');
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(memoryPath, oldTime, oldTime);

    // ── Subprocess 1: Dry-run (creates checkpoint) ────────────────
    const dryRun = await runCli(tmpHome, ['--dry-run', '--json']);
    expect(dryRun.exitCode, `dry-run stderr: ${dryRun.stderr}`).toBe(0);

    // ── Subprocess 2: Bust ────────────────────────────────────────
    const bust = await runCli(tmpHome, [
      '--dangerously-bust-ghosts',
      '--yes-proceed-busting',
      '--json',
    ]);
    expect(bust.exitCode, `bust stderr: ${bust.stderr}`).toBe(0);

    const bustParsed = JSON.parse(bust.stdout) as Record<string, unknown>;
    const bustResult = bustParsed.bust as {
      status: string;
      manifestPath: string;
      counts: {
        archive: { agents: number; skills: number; failed: number };
        disable: { completed: number; failed: number };
        flag: { completed: number; failed: number; refreshed: number; skipped: number };
      };
    };
    expect(bustResult.status).toBe('success');
    // The fixture archives 1 agent — agents counter carries the count (Bug #1 fix).
    expect(bustResult.counts.archive.agents).toBe(1);
    expect(bustResult.counts.archive.skills).toBe(0);
    expect(bustResult.counts.disable.completed).toBe(1);
    expect(bustResult.counts.flag.completed).toBe(1);

    // ── Verify bust side effects on disk ──────────────────────────
    const archivedAgentPath = path.join(
      tmpHome,
      '.claude',
      'ccaudit',
      'archived',
      'agents',
      'round-trip-agent.md',
    );
    expect(existsSync(archivedAgentPath)).toBe(true);
    expect(existsSync(agentPath)).toBe(false);

    const postBustConfig = JSON.parse(await readFile(claudeJsonPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const postBustMcpServers = (postBustConfig.mcpServers ?? {}) as Record<string, unknown>;
    expect(postBustMcpServers['round-trip-mcp']).toBeUndefined();
    expect(postBustConfig['ccaudit-disabled:round-trip-mcp']).toBeDefined();

    const postBustMemory = await readFile(memoryPath, 'utf8');
    expect(postBustMemory).toMatch(/ccaudit-stale: true/);
    expect(postBustMemory).toMatch(/ccaudit-flagged:/);

    // ── Subprocess 3: Restore ─────────────────────────────────────
    const restore = await runRestore(tmpHome, ['--json']);
    expect(restore.exitCode, `restore stderr: ${restore.stderr}`).toBe(0);

    const restoreParsed = JSON.parse(restore.stdout) as Record<string, unknown>;
    expect(restoreParsed.status).toBe('success');

    // ── Verify full restoration to pre-bust state ─────────────────
    // Agent restored to original location with original content
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(archivedAgentPath)).toBe(false);
    const restoredAgent = await readFile(agentPath, 'utf8');
    expect(restoredAgent).toBe(agentContent);

    // MCP re-enabled in ~/.claude.json
    const restoredConfig = JSON.parse(await readFile(claudeJsonPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const restoredMcpServers = (restoredConfig.mcpServers ?? {}) as Record<string, unknown>;
    expect(restoredMcpServers['round-trip-mcp']).toEqual(originalMcpValue);
    expect(restoredConfig['ccaudit-disabled:round-trip-mcp']).toBeUndefined();

    // Memory frontmatter stripped
    const restoredMemory = await readFile(memoryPath, 'utf8');
    expect(restoredMemory).not.toMatch(/ccaudit-stale/);
    expect(restoredMemory).not.toMatch(/ccaudit-flagged/);
    expect(restoredMemory).toContain('# Round-trip memory');
  }, 90_000);

  // ── Case 13: process-detection-failed → exit 3 ────────────────────
  //
  // Note: The restore CLI maps 'process-detection-failed' → exit 3 (same as
  // 'running-process'). The PLAN spec listed exit 4, but restore.ts
  // restoreResultToExitCode returns 3 for both variants. Tests match the code.

  it.skipIf(process.platform === 'win32')(
    'Case 13: exits 3 when process detection fails (non-executable ps)',
    async () => {
      const fixture = await buildBasicFixture();
      tmpHome = fixture.tmpHome;

      // Write a non-executable ps into tmpHome/bin/ps (chmod 000).
      // Then pass pathOverride = ONLY tmpHome/bin so the real system ps is
      // never reachable. When spawn('ps', ...) fails, the restore orchestrator
      // returns 'process-detection-failed' → exit 3 (fail-closed per D-14).
      const fakePsPath = path.join(tmpHome, 'bin', 'ps');
      await writeFile(fakePsPath, '#!/bin/sh\necho ""\n');
      await chmod(fakePsPath, 0o000); // no permissions at all

      // PATH = ONLY tmpHome/bin so the system ps is unreachable.
      // process.execPath is used to spawn node directly (not via PATH).
      const result = await runRestore(tmpHome, [], {
        pathOverride: path.join(tmpHome, 'bin'),
      });
      expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(3);

      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(
        /process.detection|detection.failed|process detection|Could not verify/i,
      );
    },
  );

  // ── Phase 3: Case 14 — multi-manifest restore (all 5 agents across 2 manifests) ──
  //
  // Regression for: full-mode restore reads only the newest manifest (entries[0]).
  // After two busts, the old manifest's items were unreachable orphans.
  // With findManifestsForRestore (plural), all manifests are walked newest-first
  // and all 5 agents are restored.
  //
  // Implementation: seed two JSONL manifests with distinct timestamps (1-second
  // apart) directly, without running real busts. This avoids the timestamp-
  // collision problem (resolveManifestPath strips milliseconds, so two busts
  // within the same second produce one file). The manifests faithfully mimic
  // what a real bust produces.

  it('Case 14: full restore walks ALL manifests — items from older manifest are restored', async () => {
    tmpHome = await setupEmptyHome();

    const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
    const archivedDir = path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents');
    await mkdir(archivedDir, { recursive: true });

    // ── Helper: build one manifest + archive files for N agents ───
    // sourceSubdir: subdirectory under tmpHome for source paths (default: '.claude/agents')
    async function seedManifest(
      timestamp: string,
      agentNames: string[],
      sourceSubdir = '.claude/agents',
    ): Promise<{ sources: string[]; archives: string[] }> {
      const sources: string[] = [];
      const archives: string[] = [];

      // Convert filename-safe slug (colons replaced by dashes) to a proper ISO string
      const isoTimestamp = timestamp.replace(/(\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3') + 'Z';

      const lines: string[] = [];
      lines.push(
        JSON.stringify({
          record_type: 'header',
          manifest_version: 1,
          ccaudit_version: '1.2.0',
          checkpoint_ghost_hash: `hash-${timestamp}`,
          checkpoint_timestamp: new Date(isoTimestamp).toISOString(),
          since_window: '30d',
          os: process.platform,
          node_version: process.version,
          planned_ops: { archive: agentNames.length, disable: 0, flag: 0 },
        }),
      );

      for (const name of agentNames) {
        const sourcePath = path.join(tmpHome, sourceSubdir, `${name}.md`);
        const archivePath = path.join(archivedDir, `${name}.md`);
        const content = `# ${name}\nA ghost agent from ${timestamp}.\n`;
        const sha256 = createHash('sha256').update(content).digest('hex');

        // Write archive file (simulating completed bust)
        await writeFile(archivePath, content, 'utf8');
        sources.push(sourcePath);
        archives.push(archivePath);

        lines.push(
          JSON.stringify({
            op_id: `op-${name}`,
            op_type: 'archive',
            timestamp: new Date(new Date(isoTimestamp).getTime() + 1).toISOString(),
            status: 'completed',
            category: 'agent',
            scope: 'global',
            source_path: sourcePath,
            archive_path: archivePath,
            content_sha256: sha256,
          }),
        );
      }

      lines.push(
        JSON.stringify({
          record_type: 'footer',
          status: 'completed',
          actual_ops: {
            archive: { completed: agentNames.length, failed: 0 },
            disable: { completed: 0, failed: 0 },
            flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
          },
          duration_ms: 100,
          exit_code: 0,
        }),
      );

      // Format: bust-<ISO-with-colons-as-dashes>Z.jsonl
      // timestampSuffixForFilename replaces ':' with '-' and keeps T and Z.
      // Input timestamps are already in that form (colons are '-', T is kept).
      const stamp = `${timestamp}Z`;
      const manifestPath = path.join(manifestsDir, `bust-${stamp}.jsonl`);
      await writeFile(manifestPath, lines.join('\n') + '\n', 'utf8');

      // Set mtime to the parsed timestamp so discoverManifests sorts correctly
      // regardless of how fast the test writes both files.
      const parsedDate = new Date(isoTimestamp);
      await utimes(manifestPath, parsedDate, parsedDate);

      return { sources, archives };
    }

    // Manifest A (older, mtime = 2026-04-01): 3 agents in default source dir
    const { sources: sources1, archives: archives1 } = await seedManifest('2026-04-01T10-00-00', [
      'ghost-alpha',
      'ghost-beta',
      'ghost-gamma',
    ]);

    // Manifest B (newer, mtime = 2026-04-05): 3 agents.
    // ghost-alpha is intentionally included again with a different source dir so its
    // archive_path matches Manifest A's ghost-alpha entry. This exercises the
    // dedupe-by-archive_path / newer-wins branch: only Manifest B's record should be
    // used for ghost-alpha, and Manifest A's stale source path must NOT be restored.
    const { sources: sources2, archives: archives2 } = await seedManifest(
      '2026-04-05T18-30-00',
      ['ghost-delta', 'ghost-epsilon', 'ghost-alpha'],
      // ghost-alpha's source lives in a different subdir so we can assert which record won
      '.claude/agents/project',
    );
    // sources2[2] is the newer ghost-alpha source; sources1[0] is the stale one.
    const newerAlphaSource = sources2[2]!;
    const stalerAlphaSource = sources1[0]!;

    // Confirm 2 manifests exist before restore
    const manifestsBefore = await readdir(manifestsDir);
    const manifestCount = manifestsBefore.filter(
      (f) => f.startsWith('bust-') && f.endsWith('.jsonl'),
    ).length;
    expect(manifestCount, 'should have 2 manifests seeded').toBe(2);

    // Confirm all 5 unique archive files exist (ghost-alpha archive was overwritten by B)
    const uniqueArchives = [...new Set([...archives1, ...archives2])];
    for (const archivePath of uniqueArchives) {
      expect(existsSync(archivePath), `archive ${path.basename(archivePath)} should exist`).toBe(
        true,
      );
    }

    // ── Restore: should recover all 5 agents ─────────────────────
    const restore = await runRestore(tmpHome, ['--json']);
    expect(restore.exitCode, `restore stderr: ${restore.stderr}`).toBe(0);

    const restoreParsed = JSON.parse(restore.stdout) as Record<string, unknown>;
    expect(restoreParsed.status, `restore status unexpected, stdout: ${restore.stdout}`).toBe(
      'success',
    );

    // Newer ghost-alpha source (from Manifest B) must be restored
    expect(
      existsSync(newerAlphaSource),
      'ghost-alpha newer source (Manifest B) must be restored',
    ).toBe(true);

    // Stale ghost-alpha source (from Manifest A) must NOT be restored -- dedupe dropped it
    expect(
      existsSync(stalerAlphaSource),
      'ghost-alpha stale source (Manifest A) must not be restored',
    ).toBe(false);

    // ghost-beta, ghost-gamma (A) and ghost-delta, ghost-epsilon (B) must all be restored
    for (const sourcePath of [...sources1.slice(1), ...sources2.slice(0, 2)]) {
      expect(
        existsSync(sourcePath),
        `${path.basename(sourcePath)} must be restored to source`,
      ).toBe(true);
    }

    // All unique archive files should be gone
    for (const archivePath of uniqueArchives) {
      expect(
        existsSync(archivePath),
        `${path.basename(archivePath)} archive should be removed`,
      ).toBe(false);
    }

    // Counts: 5 moved (dedupe collapsed 6 records to 5 unique archive_paths),
    // 0 already-at-source, 0 failed
    const counts = restoreParsed.counts as {
      unarchived: { moved: number; alreadyAtSource: number; failed: number };
    };
    expect(counts.unarchived.moved, 'moved count should be 5').toBe(5);
    expect(counts.unarchived.alreadyAtSource, 'already-at-source count should be 0').toBe(0);
    expect(counts.unarchived.failed, 'failed count should be 0').toBe(0);
  }, 30_000);

  // ── Phase 3: Case 15 — false-positive "already at source" not counted as restored ──
  //
  // Regression for: the old 'already at original location' branch returned
  // 'completed' and inflated the restored count. After the fix it returns
  // 'already-at-source' and is reported separately.

  it('Case 15: already-at-source items are not counted as restored', async () => {
    // Build a fixture with 2 archived agents via the manifest builder (bypasses real bust)
    const tmpH = await setupEmptyHome();
    tmpHome = tmpH;

    const archivedDir = path.join(tmpH, '.claude', 'ccaudit', 'archived', 'agents');
    await mkdir(archivedDir, { recursive: true });

    const agentNames = ['alpha-agent', 'beta-agent'];
    const agentSources: string[] = [];
    const agentArchives: string[] = [];

    const manifestLines: string[] = [];
    manifestLines.push(
      JSON.stringify({
        record_type: 'header',
        manifest_version: 1,
        ccaudit_version: '1.2.0',
        checkpoint_ghost_hash: 'fake-hash-case15',
        checkpoint_timestamp: '2026-04-10T10:00:00.000Z',
        since_window: '30d',
        os: process.platform,
        node_version: process.version,
        planned_ops: { archive: 2, disable: 0, flag: 0 },
      }),
    );

    for (const name of agentNames) {
      const sourcePath = path.join(tmpH, '.claude', 'agents', `${name}.md`);
      const archivePath = path.join(archivedDir, `${name}.md`);
      const content = `# ${name}\nAgent content.\n`;
      const sha256 = createHash('sha256').update(content).digest('hex');

      // Write the archive file (as if bust happened)
      await writeFile(archivePath, content, 'utf8');

      agentSources.push(sourcePath);
      agentArchives.push(archivePath);

      manifestLines.push(
        JSON.stringify({
          op_id: `test-op-${name}`,
          op_type: 'archive',
          timestamp: '2026-04-10T10:00:01.000Z',
          status: 'completed',
          category: 'agent',
          scope: 'global',
          source_path: sourcePath,
          archive_path: archivePath,
          content_sha256: sha256,
        }),
      );
    }

    manifestLines.push(
      JSON.stringify({
        record_type: 'footer',
        status: 'completed',
        actual_ops: {
          archive: { completed: 2, failed: 0 },
          disable: { completed: 0, failed: 0 },
          flag: { completed: 0, failed: 0, refreshed: 0, skipped: 0 },
        },
        duration_ms: 200,
        exit_code: 0,
      }),
    );

    const manifestPath = path.join(
      tmpH,
      '.claude',
      'ccaudit',
      'manifests',
      'bust-2026-04-10T10-00-00Z.jsonl',
    );
    await writeFile(manifestPath, manifestLines.join('\n') + '\n', 'utf8');

    // Simulate "manual restore": copy the archives back to source paths
    // (the archive files remain too — this is the "both exist" collision case)
    // Actually for the "already-at-source" case we want: source exists, archive MISSING
    // (i.e., files were restored externally without manifest knowledge)
    // So: write source file AND delete (never write) archive — that's "already-at-source"
    for (let i = 0; i < agentNames.length; i++) {
      // Write the source file (manual restore simulation)
      await writeFile(agentSources[i]!, `# ${agentNames[i]}\nAgent content.\n`, 'utf8');
      // Remove the archive (simulating a prior restore consumed it)
      await rm(agentArchives[i]!, { force: true });
    }

    // ── Run restore ───────────────────────────────────────────────
    const result = await runRestore(tmpH, ['--json']);
    expect(result.exitCode, `restore stderr: ${result.stderr}`).toBe(0);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe('success');

    // The key assertion: moved = 0, alreadyAtSource = 2
    const counts = parsed.counts as {
      unarchived: { moved: number; alreadyAtSource: number; failed: number };
    };
    expect(counts.unarchived.moved, 'moved should be 0 (nothing actually moved)').toBe(0);
    expect(counts.unarchived.alreadyAtSource, 'already-at-source should be 2').toBe(2);
    expect(counts.unarchived.failed, 'failed should be 0').toBe(0);

    // The rendered output must mention "already at source" separately
    const rendered = await runRestore(tmpH, []);
    const combined = rendered.stdout + rendered.stderr;
    expect(combined).toMatch(/already.at.source|already at source/i);
  }, 60_000);
});
