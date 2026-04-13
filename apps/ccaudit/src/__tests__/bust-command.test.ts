/**
 * Subprocess integration tests for `ccaudit --dangerously-bust-ghosts`.
 *
 * Spawns the built binary (apps/ccaudit/dist/index.js) with HOME overridden
 * to a tmpdir fixture, asserts exit codes, stdout/stderr, manifest contents,
 * and on-disk side effects. Mirrors the pattern from dry-run-command.test.ts.
 *
 * Coverage:
 *   RMED-01: flag registered and routed through ghost command
 *   RMED-10 (D-15, D-16, D-17): confirmation ceremony, --yes-proceed-busting, non-TTY
 *   Exit code 0: successful bust with --yes-proceed-busting and a matching checkpoint
 *   Exit code 1: checkpoint-missing + hash-mismatch + --csv rejection
 *   Exit code 3: running-process detection (forced via PATH stripping -> spawn-failed)
 *   Exit code 4: non-TTY without --yes-proceed-busting (piped stdin)
 *   Output matrix: --json honored, --csv rejected, --quiet suppresses progress, --ci implies --yes-proceed-busting
 *   Full pipeline: archive agent + disable MCP + flag memory with real on-disk side effects
 *   .mcp.json flat-schema disable (Issue 1 revision): dual-schema MCP mutation end-to-end
 *
 * Local-vs-CI note
 * ─────────────────
 * The bust command's preflight runs `ps -A -o pid=,comm=` to detect any running
 * Claude Code process (D-02/D-03) and walks the parent chain for self-invocation
 * detection (D-04). On a CI runner with no Claude Code, the detector finds zero
 * matching processes and the pipeline proceeds. But when this test suite runs
 * from INSIDE a Claude Code session (local dev), the real `ps` finds the
 * enclosing Claude process and every bust test would fail with exit 3 /
 * running-process.
 *
 * Solution: each test writes a FAKE `ps` script into `<tmpHome>/bin/ps` that
 * emits only pid 1 (init) for `-A` calls and `1` for `-o ppid=` parent-chain
 * walks. The subprocess is spawned with `PATH=<tmpHome>/bin` so `runCommand`
 * finds the fake. This works identically in CI and local because we stop
 * trusting the ambient process table entirely.
 *
 * The exit-3 test case deliberately sets `PATH=/nonexistent-dir-only` to force
 * `spawn-failed` -> `process-detection-failed` -> exit 3, which exercises the
 * D-02 fail-closed path.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Resolve dist path ──────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ lives at apps/ccaudit/src/__tests__ -> dist is at apps/ccaudit/dist
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Fake ps script body ────────────────────────────────────────

/**
 * POSIX shell script that impersonates `ps` for the bust preflight. Emits only
 * pid 1 (init) for `-A` listings so CLAUDE_NAME_REGEX finds no matches, and
 * pid `1` for parent-chain walks so walkParentChain terminates immediately
 * (init is pid 1, and the bust orchestrator stops on `pid <= 1`).
 *
 * Installed into `<tmpHome>/bin/ps` by `buildFakePs`, then the subprocess is
 * spawned with `PATH=<tmpHome>/bin` so the fake is the only `ps` on PATH.
 */
const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit bust integration tests.
# Handles both \`ps -A -o pid=,comm=\` (system listing) and
# \`ps -o ppid= -p <pid>\` (parent chain walk).
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

async function buildFakePs(tmpHome: string): Promise<string> {
  const binDir = path.join(tmpHome, 'bin');
  await mkdir(binDir, { recursive: true });
  const psPath = path.join(binDir, 'ps');
  await writeFile(psPath, FAKE_PS_SCRIPT, 'utf8');
  await chmod(psPath, 0o755);
  return binDir;
}

// ── Subprocess runner ──────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOpts {
  /** Optional PATH override. Defaults to `<tmpHome>/bin` (the fake-ps dir). */
  pathOverride?: string;
  /** Maximum duration before the subprocess is SIGKILL'd. */
  timeout?: number;
}

async function runBustCommand(
  tmpHome: string,
  flags: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // process.execPath is an absolute Node path that works even when PATH is
    // stripped to a nonexistent dir (needed for the exit-3 test).
    const child = spawn(process.execPath, [distPath, ...flags], {
      env: {
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        PATH: opts.pathOverride ?? path.join(tmpHome, 'bin'),
      },
      // Pipe stdin so the subprocess sees isTTY === false (non-interactive).
      // The bust branch uses Boolean(process.stdin.isTTY) so piped stdin
      // without --yes-proceed-busting triggers the D-17 exit 4 path.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = opts.timeout ?? 30_000;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`runBustCommand timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ code, stdout, stderr });
    });

    // Close stdin immediately with no data -> isTTY is false, no input piped.
    child.stdin.end();
  });
}

// ── Fixture builders ───────────────────────────────────────────

/**
 * Build the minimum fixture for a bust test: the `.claude/` directory tree
 * the scanners walk, an empty `~/.claude.json`, a minimal session JSONL so
 * `discoverSessionFiles` returns at least one file (the ghost command bails
 * early on zero session files), and the fake-ps shim on PATH.
 *
 * Returns nothing — callers that want to mutate the fixture further (add an
 * agent, seed an .mcp.json, etc.) do so after this call.
 */
async function buildBaseFixture(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  // Minimal session so discoverSessionFiles finds at least one file.
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
  // Empty ~/.claude.json.
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  await buildFakePs(tmpHome);
}

/** Run `ccaudit --dry-run --json` against the fixture to create a checkpoint. */
async function runDryRunFirst(tmpHome: string): Promise<RunResult> {
  return runBustCommand(tmpHome, ['--dry-run', '--json']);
}

// ── Guard: dist must exist before any test runs ────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Test cases ──────────────────────────────────────────────────

// Windows: subprocess tests rely on fake `ps` shell scripts that require /bin/sh.
describe.skipIf(process.platform === 'win32')(
  'ccaudit --dangerously-bust-ghosts (integration)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await mkdtemp(path.join(tmpdir(), 'bust-cmd-'));
    });

    afterEach(async () => {
      await rm(tmpHome, { recursive: true, force: true });
    });

    // ── Exit code 4: non-TTY requires --yes-proceed-busting ──────
    describe('exit code 4: non-TTY requires --yes-proceed-busting (D-17)', () => {
      it('piped stdin without --yes-proceed-busting -> exit 4', async () => {
        await buildBaseFixture(tmpHome);
        // Run dry-run first so the checkpoint exists (gate 1 passes).
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, ['--dangerously-bust-ghosts']);
        expect(result.code).toBe(4);
        expect(result.stderr).toMatch(/requires an interactive terminal/);
        expect(result.stderr).toMatch(/--yes-proceed-busting/);
      });

      it('piped stdin WITH --yes-proceed-busting -> bypasses prompt (no exit 4)', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
        ]);
        // Empty fixture -> no ops to run -> exit 0 (success).
        expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      });

      it('--ci --dangerously-bust-ghosts implies --yes-proceed-busting', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, ['--dangerously-bust-ghosts', '--ci']);
        expect(result.code, `stderr: ${result.stderr}`).toBe(0);
        // --ci implies --json, so stdout should be parseable JSON with bust envelope.
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(parsed).toHaveProperty('meta');
        expect(parsed).toHaveProperty('bust');
        const bust = parsed.bust as Record<string, unknown>;
        expect(bust.status).toBe('success');
      });
    });

    // ── Exit code 1: checkpoint gate failures and --csv rejection ──
    describe('exit code 1: checkpoint and hash gate failures (D-01)', () => {
      it('no checkpoint -> exit 1 with checkpoint-missing message', async () => {
        await buildBaseFixture(tmpHome);
        // Do NOT run --dry-run first, so no checkpoint file exists.
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/No checkpoint found/);
        expect(result.stderr).toMatch(/ccaudit --dry-run/);
      });

      it('hash mismatch (inventory changed) -> exit 1', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        // Add a new ghost agent AFTER the dry-run to change the inventory.
        // New agent has no session invocations -> classified as definite-ghost
        // by matchInventory (lastUsedMs=null) -> hash includes it -> hash differs.
        await writeFile(
          path.join(tmpHome, '.claude', 'agents', 'new-ghost.md'),
          '# new agent',
          'utf8',
        );
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
        ]);
        expect(result.code).toBe(1);
        const output = result.stderr + result.stdout;
        expect(output).toMatch(/Inventory has changed|hash/i);
      });

      it('--csv on bust -> exit 1 with rejection message', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
          '--csv',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/--csv is not supported/);
      });
    });

    // ── Exit code 0: success paths ───────────────────────────────
    describe('exit code 0: successful bust paths', () => {
      it('empty fixture + --yes-proceed-busting -> exit 0 with manifest', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
          '--json',
        ]);
        expect(result.code, `stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(parsed.meta).toBeTruthy();
        expect(parsed.bust).toBeTruthy();
        const bust = parsed.bust as { status: string; manifestPath: string };
        expect(bust.status).toBe('success');
        // Manifest file must exist on disk.
        expect(existsSync(bust.manifestPath)).toBe(true);
        // Manifest contains header + footer at minimum (empty plan).
        const manifestContent = await readFile(bust.manifestPath, 'utf8');
        const lines = manifestContent.split('\n').filter(Boolean);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        const firstLine = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(firstLine.record_type).toBe('header');
        const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
        expect(lastLine.record_type).toBe('footer');
        expect(lastLine.status).toBe('completed');
      });

      it('--quiet suppresses progress output, still exits 0', async () => {
        await buildBaseFixture(tmpHome);
        await runDryRunFirst(tmpHome);
        const result = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
          '--quiet',
        ]);
        expect(result.code, `stderr: ${result.stderr}`).toBe(0);
        // Under --quiet the bust branch suppresses the "Done. ..." progress line.
        expect(result.stdout).not.toMatch(/Done\./);
      });
    });

    // ── Exit code 3: running-process preflight ──────────────────
    describe('exit code 3: running-process preflight (D-02, D-03)', () => {
      // We cannot reliably spawn a "claude" process on CI runners. Instead we
      // exercise the fail-closed `spawn-failed` path (D-02): strip PATH so `ps`
      // is not reachable, which forces `process-detection-failed` and exit 3.
      //
      // Skipped on Windows because the plan reserves exit 3 for `tasklist` on
      // win32, and PATH manipulation to hide tasklist.exe is unreliable in
      // GitHub Actions Windows runners.
      it.skipIf(process.platform === 'win32')(
        'empty PATH so ps is unreachable -> exit 3 (process-detection-failed)',
        async () => {
          await buildBaseFixture(tmpHome);
          await runDryRunFirst(tmpHome);
          const result = await runBustCommand(
            tmpHome,
            ['--dangerously-bust-ghosts', '--yes-proceed-busting'],
            { pathOverride: '/nonexistent-dir-only' },
          );
          expect(result.code).toBe(3);
          expect(result.stderr).toMatch(
            /Could not verify Claude Code is stopped|process-detection-failed/,
          );
        },
      );
    });

    // ── Full pipeline: archive + disable + flag end-to-end ──────
    describe('full pipeline: archive + disable + flag', () => {
      it('real fixture: 1 agent + 1 MCP + 1 memory -> manifest with 3 ops, all side effects on disk', async () => {
        await buildBaseFixture(tmpHome);

        // Ghost agent at ~/.claude/agents/ghost-agent.md.
        await writeFile(
          path.join(tmpHome, '.claude', 'agents', 'ghost-agent.md'),
          '# ghost agent body',
          'utf8',
        );

        // Ghost MCP in ~/.claude.json (global scope, nested schema).
        await writeFile(
          path.join(tmpHome, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              'ghost-mcp': { command: 'npx', args: ['ghost'] },
            },
          }),
          'utf8',
        );

        // Old memory file: ~/.claude/CLAUDE.md with mtime 40 days ago so
        // classifyGhost returns definite-ghost (elapsed > 30d).
        const memoryPath = path.join(tmpHome, '.claude', 'CLAUDE.md');
        await writeFile(memoryPath, '# old memory\n', 'utf8');
        const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        await utimes(memoryPath, oldTime, oldTime);

        // Dry-run to produce the checkpoint for gate 1.
        const dry = await runDryRunFirst(tmpHome);
        expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

        // Bust with --json so we can inspect the envelope shape.
        const bust = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
          '--json',
        ]);
        expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

        const parsed = JSON.parse(bust.stdout) as Record<string, unknown>;
        const bustResult = parsed.bust as {
          status: string;
          manifestPath: string;
          counts: {
            archive: { completed: number; failed: number };
            disable: { completed: number; failed: number };
            flag: { completed: number; failed: number; refreshed: number; skipped: number };
          };
        };
        expect(bustResult.status).toBe('success');
        expect(bustResult.counts.archive.completed).toBe(1);
        expect(bustResult.counts.disable.completed).toBe(1);
        expect(bustResult.counts.flag.completed).toBe(1);

        // ── Disk side effects ────────────────────────────────

        // Ghost agent moved to ccaudit/archived/agents/.
        const archivedPath = path.join(
          tmpHome,
          '.claude',
          'ccaudit',
          'archived',
          'agents',
          'ghost-agent.md',
        );
        expect(existsSync(archivedPath)).toBe(true);
        expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'ghost-agent.md'))).toBe(false);

        // ~/.claude.json has mcpServers cleared and ccaudit-disabled:ghost-mcp at root.
        const updatedConfig = JSON.parse(
          await readFile(path.join(tmpHome, '.claude.json'), 'utf8'),
        ) as Record<string, unknown>;
        const updatedMcpServers = (updatedConfig.mcpServers ?? {}) as Record<string, unknown>;
        expect(updatedMcpServers['ghost-mcp']).toBeUndefined();
        expect(updatedConfig['ccaudit-disabled:ghost-mcp']).toEqual({
          command: 'npx',
          args: ['ghost'],
        });

        // CLAUDE.md has frontmatter injected with the two ccaudit keys.
        const updatedMemory = await readFile(memoryPath, 'utf8');
        expect(updatedMemory).toMatch(/ccaudit-stale: true/);
        expect(updatedMemory).toMatch(/ccaudit-flagged:/);

        // ── Manifest shape ────────────────────────────────────

        expect(existsSync(bustResult.manifestPath)).toBe(true);
        const manifestContent = await readFile(bustResult.manifestPath, 'utf8');
        const lines = manifestContent.split('\n').filter(Boolean);
        const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(records[0]!.record_type).toBe('header');
        expect(records[records.length - 1]!.record_type).toBe('footer');
        const ops = records.filter((r) => r.record_type !== 'header' && r.record_type !== 'footer');
        expect(ops).toHaveLength(3);
        // D-13 execution order: archive (agents) -> disable (mcp) -> flag (memory).
        expect(ops[0]!.op_type).toBe('archive');
        expect(ops[1]!.op_type).toBe('disable');
        expect(ops[2]!.op_type).toBe('flag');
      });
    });

    // ── Issue 1 revision: .mcp.json flat-schema disable ─────────
    describe('.mcp.json flat-schema disable (Issue 1 revision)', () => {
      it('project .mcp.json ghost MCP -> key moves to top level of THAT file, no projects wrapper', async () => {
        // Build the base fixture, but overwrite the session file below so the
        // project path seeded into `projectPaths` matches the real tmpdir
        // project directory (that's how scanMcpServers route #3 discovers
        // `<projDir>/.mcp.json`).
        await buildBaseFixture(tmpHome);

        const projDir = path.join(tmpHome, 'my-project');
        await mkdir(projDir, { recursive: true });
        const mcpJsonPath = path.join(projDir, '.mcp.json');
        const originalValue = { command: 'npx', args: ['ghost-mcp-server'] };
        await writeFile(
          mcpJsonPath,
          JSON.stringify({
            mcpServers: {
              'mcp-json-ghost': originalValue,
            },
          }),
          'utf8',
        );

        // Overwrite the session file so its cwd points to the real projDir.
        // scanAll -> scanMcpServers receives `projectPaths = [projDir]` from
        // this cwd, then route #3 walks `<projDir>/.mcp.json` and discovers
        // the ghost server with scope: 'project', path: <mcpJsonPath>.
        const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
        const sessionLine = JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: projDir,
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'fixture-session',
        });
        await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLine + '\n', 'utf8');

        // Dry-run to produce checkpoint.
        const dry = await runDryRunFirst(tmpHome);
        expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

        // Sanity: the dry-run's plan.disable should contain our mcp-json-ghost.
        const dryParsed = JSON.parse(dry.stdout) as {
          changePlan: { disable: Array<Record<string, unknown>> };
        };
        const disableItems = dryParsed.changePlan.disable;
        const found = disableItems.find((i) => i.name === 'mcp-json-ghost');
        expect(found, 'scanner must discover .mcp.json ghost').toBeTruthy();
        expect(found!.path).toBe(mcpJsonPath);
        expect(found!.projectPath).toBe(projDir);

        // Bust.
        const bust = await runBustCommand(tmpHome, [
          '--dangerously-bust-ghosts',
          '--yes-proceed-busting',
          '--json',
        ]);
        expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);
        const parsed = JSON.parse(bust.stdout) as Record<string, unknown>;
        const bustResult = parsed.bust as { status: string; manifestPath: string };
        expect(['success', 'partial-success']).toContain(bustResult.status);

        // ── Assert .mcp.json mutation: FLAT schema at document root ──
        const mcpAfter = JSON.parse(await readFile(mcpJsonPath, 'utf8')) as Record<string, unknown>;
        const afterMcpServers = (mcpAfter.mcpServers ?? {}) as Record<string, unknown>;
        // The ghost server is removed from mcpServers.
        expect(afterMcpServers['mcp-json-ghost']).toBeUndefined();
        // The disabled key lives at TOP LEVEL of the .mcp.json document
        // (first-time rename -- no collision suffix expected).
        expect(mcpAfter['ccaudit-disabled:mcp-json-ghost']).toEqual(originalValue);
        // CRITICAL: no `projects` wrapper was synthesized -- .mcp.json stays flat.
        expect(mcpAfter.projects).toBeUndefined();

        // ── Assert the manifest records the disable op against the .mcp.json path ──
        expect(existsSync(bustResult.manifestPath)).toBe(true);
        const manifestContent = await readFile(bustResult.manifestPath, 'utf8');
        const lines = manifestContent.split('\n').filter(Boolean);
        const ops = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r.record_type !== 'header' && r.record_type !== 'footer');
        const disableOps = ops.filter((o) => o.op_type === 'disable');
        expect(disableOps.length).toBeGreaterThanOrEqual(1);
        const ourOp = disableOps.find((o) => (o.config_path as string) === mcpJsonPath);
        expect(ourOp).toBeTruthy();
        expect(ourOp!.original_key).toBe('mcpServers.mcp-json-ghost');
        expect(ourOp!.new_key).toBe('ccaudit-disabled:mcp-json-ghost');
        expect(ourOp!.original_value).toEqual(originalValue);
        expect(ourOp!.scope).toBe('project');
        expect(ourOp!.project_path).toBe(projDir);
      });
    });
  },
);
