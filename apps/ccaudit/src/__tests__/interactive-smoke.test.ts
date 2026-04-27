/**
 * Subprocess smoke integration tests for the interactive TUI guard paths (D-31, Phase 2).
 *
 * Coverage (3 guards that CAN be tested without a terminal emulator):
 *   Test A: `--interactive + --json` exits 2 with exact stderr (D-06)
 *   Test B: non-TTY `--interactive` prints D-07 fallback notice and exits 0 (no bust)
 *   Test C: auto-open prompt is suppressed under --json/--csv/--quiet/--ci and non-TTY (D-23)
 *
 * NOT tested here (Phase 3 responsibility — full picker flow requires terminal emulator fixtures):
 *   - Space/Enter/Ctrl+C inside the picker
 *   - Full interactive bust happy-path
 *   - Signal-based cancellation → zero writes
 *   - MCP byte-preservation across archive+restore cycles
 *
 * Pattern mirrors bust-command.test.ts: fake-ps shim, tmpHome layout, TZ=UTC env.
 * NO hard-coded /Users/... or /home/... paths — all derived from tmpHome.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Resolve dist path ──────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Fake ps script body ────────────────────────────────────────

/**
 * POSIX shell script that impersonates `ps` for the bust preflight.
 * Emits only pid 1 (init) so the detector finds no running Claude Code
 * process and proceeds. Same approach as bust-command.test.ts.
 */
const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit interactive smoke integration tests.
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
  /** Extra env vars merged on top of HOME/USERPROFILE/XDG_CONFIG_HOME/NO_COLOR/TZ/PATH. */
  env?: Record<string, string>;
  /** Optional PATH override. Defaults to `<tmpHome>/bin` (the fake-ps dir). */
  pathOverride?: string;
  /** Maximum duration before the subprocess is SIGKILL'd (default 30s). */
  timeout?: number;
}

async function runGhostCommand(
  tmpHome: string,
  flags: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath, 'ghost', ...flags], {
      env: {
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        TZ: 'UTC',
        PATH: opts.pathOverride ?? path.join(tmpHome, 'bin'),
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = opts.timeout ?? 30_000;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runGhostCommand timed out after ${timeoutMs}ms\nstdout: ${stdout.slice(-500)}\nstderr: ${stderr.slice(-500)}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (!killed) resolve({ code, stdout, stderr });
    });

    child.stdin.end();
  });
}

// ── Fixture builders ───────────────────────────────────────────

/**
 * Build the minimum fixture for a smoke test:
 *   - ~/.claude/agents/, ~/.claude/skills/, ~/.config/claude/ directories
 *   - Minimal session JSONL so discoverSessionFiles returns at least one file
 *   - Blank ~/.claude.json (no MCP entries)
 *   - Fake-ps shim on PATH
 */
async function buildBaseFixture(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'smoke-project');
  await mkdir(sessionDir, { recursive: true });
  const sessionLine = JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: '/fake/smoke',
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    sessionId: 'smoke-session',
  });
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLine + '\n', 'utf8');
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  await buildFakePs(tmpHome);
}

/**
 * Seed a minimal ghost inventory in tmpHome.
 * Writes one agent file that was never invoked in the session window,
 * guaranteeing ≥1 ghost in the scan so suppression-related assertions are
 * meaningful (D-23: "zero ghosts found" also suppresses the prompt, so we
 * need at least one ghost to make the --json/--csv/--quiet/--ci tests
 * definitively test flag-based suppression rather than zero-ghost suppression).
 */
async function seedMinimalInventory(tmpHome: string): Promise<void> {
  await writeFile(
    path.join(tmpHome, '.claude', 'agents', 'smoke-test-agent.md'),
    '# smoke-test-agent\n\nA minimal agent for smoke tests. Never invoked.\n',
    'utf8',
  );
}

// ── Guard: dist must exist before any test runs ────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Smoke tests — windows: fake ps requires /bin/sh; skip on win32 ──

describe.skipIf(process.platform === 'win32')(
  'interactive smoke tests — D-31 (3 non-interactive guards)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-smoke-'));
      await buildBaseFixture(tmpHome);
    });

    afterEach(async () => {
      await rm(tmpHome, { recursive: true, force: true });
    });

    // ── Test A: --interactive + --json hard-errors with exit 2 (D-06) ──────
    it('exits 2 with exact stderr when --interactive is combined with --json', async () => {
      const result = await runGhostCommand(tmpHome, ['--interactive', '--json']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Error: --interactive cannot be combined with --json.');
    });

    // ── Test B: non-TTY --interactive falls back to dry-run (D-07) ─────────
    it('falls back to dry-run under non-TTY when --interactive is explicit', async () => {
      await seedMinimalInventory(tmpHome);

      const result = await runGhostCommand(tmpHome, ['--interactive']);

      // D-07: non-TTY with explicit --interactive → stderr notice
      expect(result.stderr).toContain('No TTY detected — running in dry-run mode.');

      // Dry-run is non-destructive → exit 0
      expect(result.code).toBe(0);

      // Manifests directory must remain absent (no bust happened)
      const manifestsDir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
      const manifests = await readdir(manifestsDir).catch(() => [] as string[]);
      expect(manifests).toEqual([]);
    });

    // ── Test C: auto-open prompt is suppressed under output flags and non-TTY ──
    it('suppresses auto-open prompt under --json, --csv, --quiet, --ci, and non-TTY (D-23)', async () => {
      await seedMinimalInventory(tmpHome);

      // 4 suppression flags: --json, --csv, --quiet, --ci
      for (const flag of ['--json', '--csv', '--quiet', '--ci']) {
        const result = await runGhostCommand(tmpHome, [flag]);
        // The auto-open prompt must NEVER appear in either stdout or stderr
        // regardless of how many ghosts are found.
        expect(result.stderr).not.toContain('Open interactive picker?');
        expect(result.stdout).not.toContain('Open interactive picker?');
      }

      // Bare `ghost` under non-TTY (our subprocess case) also suppresses.
      // The subprocess has piped stdio → isTTY === false → checkTuiGuards returns
      // suppress-auto-open (Rule 6) → prompt is never shown.
      const bare = await runGhostCommand(tmpHome, []);
      expect(bare.stderr).not.toContain('Open interactive picker?');
      expect(bare.stdout).not.toContain('Open interactive picker?');
    });
  },
);
