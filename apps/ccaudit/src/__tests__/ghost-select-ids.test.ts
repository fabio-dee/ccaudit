/**
 * Subprocess integration tests for CCAUDIT_SELECT_IDS env var (Phase 1 Plan 03).
 *
 * Spawns the built binary (apps/ccaudit/dist/index.js) with HOME overridden
 * to a tmpdir fixture and CCAUDIT_SELECT_IDS set to exercise subset bust paths.
 * Mirrors the pattern from bust-command.test.ts: fake-ps shim, tmpHome layout,
 * dry-run-then-bust sequencing, manifest assertion via readManifest.
 *
 * Coverage:
 *   INV-S4: manifest header.planned_ops reflects the selection subset
 *   INV-S5: bust.summary.freedTokens is subset-accurate;
 *            bust.summary.totalPlannedTokens preserves the full-plan figure
 *   Edge cases: unset env (v1.4.0 compat), empty string (no-op subset), unknown ids
 *
 * Local-vs-CI note
 * ─────────────────
 * Same fake-ps shim as bust-command.test.ts: each test writes a FAKE `ps` script
 * into `<tmpHome>/bin/ps` so the bust preflight finds no running Claude Code
 * process and proceeds. Without it, tests run from inside a Claude Code session
 * would fail with exit 3 every time.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, utimes, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, canonicalItemId } from '@ccaudit/internal';
import type { InventoryItem } from '@ccaudit/internal';

// ── Resolve dist path ──────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Fake ps script body ────────────────────────────────────────

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
  /** Extra env vars merged on top of HOME/USERPROFILE/XDG_CONFIG_HOME/NO_COLOR/PATH. */
  env?: Record<string, string>;
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
    const child = spawn(process.execPath, [distPath, ...flags], {
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

    child.stdin.end();
  });
}

// ── Fixture builders ───────────────────────────────────────────

/**
 * Build the minimum fixture for a bust test: .claude/ directory tree,
 * empty ~/.claude.json, minimal session JSONL, and fake-ps shim on PATH.
 */
async function buildBaseFixture(tmpHome: string): Promise<void> {
  await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
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
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');
  await buildFakePs(tmpHome);
}

/**
 * Run dry-run to produce a checkpoint (required for bust gate 1).
 */
function runDryRunFirst(tmpHome: string): Promise<RunResult> {
  return runBustCommand(tmpHome, ['--dry-run', '--yes-proceed-busting', '--json']);
}

/**
 * Build the canonical id for a global agent file in tmpHome.
 * Uses `canonicalItemId` to guarantee format stays in sync with the scanner.
 */
function agentItemId(tmpHome: string, fileName: string): string {
  const item: InventoryItem = {
    name: path.basename(fileName, '.md'),
    path: path.join(tmpHome, '.claude', 'agents', fileName),
    scope: 'global',
    category: 'agent',
    projectPath: null,
  };
  return canonicalItemId(item);
}

/**
 * Resolve the path to the manifest written by a successful bust.
 * Parses the --json envelope to find the manifestPath field.
 */
function manifestPathFromEnvelope(stdout: string): string {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const bust = parsed.bust as { manifestPath: string };
  return bust.manifestPath;
}

// ── Guard: dist must exist before any test runs ────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Subset bust tests ────────────────────────────────────────────

// Windows: fake `ps` shell scripts require /bin/sh; skip on win32.
describe.skipIf(process.platform === 'win32')(
  'CCAUDIT_SELECT_IDS — subset bust (INV-S4 + INV-S5)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await mkdtemp(path.join(tmpdir(), 'ghost-select-'));

      await buildBaseFixture(tmpHome);

      // Seed 3 ghost agents: alpha, beta, gamma.
      // Each file has distinct content sizes for deterministic token estimates.
      // alpha:  short description (~50-token range)
      // beta:   medium description (~100-token range)
      // gamma:  longer description (~150-token range)
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'alpha.md'),
        '# alpha\nA short alpha agent.',
        'utf8',
      );
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'beta.md'),
        '# beta\n' + 'B'.repeat(200) + '\nA medium beta agent with more content.',
        'utf8',
      );
      await writeFile(
        path.join(tmpHome, '.claude', 'agents', 'gamma.md'),
        '# gamma\n' + 'G'.repeat(500) + '\nA longer gamma agent with even more content.',
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(tmpHome, { recursive: true, force: true });
    });

    // ── Test A: INV-S4 — planned_ops reflects subset ──────────────
    it('Test A — INV-S4: manifest planned_ops reflects selection subset', async () => {
      // Step 1: dry-run to create checkpoint.
      const dry = await runDryRunFirst(tmpHome);
      expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

      // Step 2: compute the canonical id for agent alpha only.
      const alphaId = agentItemId(tmpHome, 'alpha.md');

      // Step 3: subset bust with only alpha selected.
      const bust = await runBustCommand(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: alphaId } },
      );
      expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

      // Step 4: parse the bust envelope and read the manifest.
      const manifestPath = manifestPathFromEnvelope(bust.stdout);
      const manifest = await readManifest(manifestPath);

      // Step 5: planned_ops counts reflect subset (1 archive, 0 others).
      expect(manifest.header).not.toBeNull();
      expect(manifest.header!.planned_ops.archive).toBe(1);
      expect(manifest.header!.planned_ops.disable).toBe(0);
      expect(manifest.header!.planned_ops.flag).toBe(0);

      // Step 6: only 1 op record in manifest body.
      expect(manifest.ops).toHaveLength(1);
      expect(manifest.ops[0]!.op_type).toBe('archive');

      // Step 7: selection_filter is subset with exactly alphaId.
      expect(manifest.header!.selection_filter).toBeDefined();
      expect(manifest.header!.selection_filter!.mode).toBe('subset');
      const sf = manifest.header!.selection_filter as { mode: 'subset'; ids: string[] };
      expect(sf.ids).toEqual([alphaId]);

      // Step 8: alpha is archived; beta and gamma remain in place.
      expect(
        existsSync(path.join(tmpHome, '.claude', 'ccaudit', 'archived', 'agents', 'alpha.md')),
      ).toBe(true);
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md')),
      ).toBe(false);
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md')),
      ).toBe(true);
      expect(
        existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md')),
      ).toBe(true);
    });

    // ── Test B: INV-S5 — freedTokens subset-accurate; totalPlannedTokens full ──
    it('Test B — INV-S5: freedTokens subset-accurate; totalPlannedTokens preserves full figure', async () => {
      // Step 1: dry-run to get full-plan token figures.
      const dry = await runDryRunFirst(tmpHome);
      expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

      // Extract full-plan savings.tokens from the dry-run envelope.
      // The dry-run JSON envelope shape is:
      //   { dryRun: true, changePlan: { savings: { tokens: number }, ... } }
      // (not `totalOverhead` which belongs to the ghost inventory view path)
      const dryParsed = JSON.parse(dry.stdout) as {
        changePlan: { savings: { tokens: number } };
      };
      const fullPlanTokens = dryParsed.changePlan.savings.tokens;
      expect(fullPlanTokens).toBeGreaterThan(0);

      // Step 2: subset bust with only alpha selected.
      const alphaId = agentItemId(tmpHome, 'alpha.md');
      const bust = await runBustCommand(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: alphaId } },
      );
      expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

      // Step 3: parse the bust envelope summary.
      const bustParsed = JSON.parse(bust.stdout) as {
        bust: {
          status: string;
          summary: {
            freedTokens: number;
            totalPlannedTokens: number;
          };
        };
      };
      expect(bustParsed.bust.status).toBe('success');

      const { freedTokens, totalPlannedTokens } = bustParsed.bust.summary;

      // Step 4: totalPlannedTokens equals the full dry-run figure.
      expect(totalPlannedTokens).toBe(fullPlanTokens);

      // Step 5: freedTokens is less than totalPlannedTokens (1-of-3 subset).
      expect(freedTokens).toBeLessThan(totalPlannedTokens);

      // Step 6: freedTokens is positive (we archived something).
      expect(freedTokens).toBeGreaterThan(0);
    });
  },
);

// ── Edge case tests ──────────────────────────────────────────────

describe.skipIf(process.platform === 'win32')('CCAUDIT_SELECT_IDS — edge cases', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'ghost-select-edge-'));

    await buildBaseFixture(tmpHome);

    // Seed 3 ghost agents for the edge case tests.
    await writeFile(
      path.join(tmpHome, '.claude', 'agents', 'alpha.md'),
      '# alpha\nA short alpha agent.',
      'utf8',
    );
    await writeFile(
      path.join(tmpHome, '.claude', 'agents', 'beta.md'),
      '# beta\nA beta agent.',
      'utf8',
    );
    await writeFile(
      path.join(tmpHome, '.claude', 'agents', 'gamma.md'),
      '# gamma\nA gamma agent.',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── Test C: unset env preserves v1.4.0 full-inventory behavior ──
  it('Test C — unset env: v1.4.0 full-inventory behavior preserved', async () => {
    const dry = await runDryRunFirst(tmpHome);
    expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

    // Bust WITHOUT the env var — no CCAUDIT_SELECT_IDS key at all.
    const bust = await runBustCommand(tmpHome, [
      '--dangerously-bust-ghosts',
      '--yes-proceed-busting',
      '--json',
    ]);
    expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

    const manifestPath = manifestPathFromEnvelope(bust.stdout);
    const manifest = await readManifest(manifestPath);

    // Full bust: all 3 agents archived.
    expect(manifest.header).not.toBeNull();
    const totalOps =
      manifest.header!.planned_ops.archive +
      manifest.header!.planned_ops.disable +
      manifest.header!.planned_ops.flag;
    expect(totalOps).toBeGreaterThanOrEqual(3);

    // selection_filter is 'full'.
    expect(manifest.header!.selection_filter).toBeDefined();
    expect(manifest.header!.selection_filter!.mode).toBe('full');

    // freedTokens equals totalPlannedTokens for a full bust.
    const bustParsed = JSON.parse(bust.stdout) as {
      bust: { summary: { freedTokens: number; totalPlannedTokens: number } };
    };
    expect(bustParsed.bust.summary.freedTokens).toBe(
      bustParsed.bust.summary.totalPlannedTokens,
    );
  });

  // ── Test D: empty string env is a no-op subset with a warning ──
  it('Test D — empty string env: no-op subset with a warning', async () => {
    const dry = await runDryRunFirst(tmpHome);
    expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

    const bust = await runBustCommand(
      tmpHome,
      ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
      { env: { CCAUDIT_SELECT_IDS: '' } },
    );
    expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

    const manifestPath = manifestPathFromEnvelope(bust.stdout);
    const manifest = await readManifest(manifestPath);

    // No ops planned.
    expect(manifest.header).not.toBeNull();
    expect(manifest.header!.planned_ops.archive).toBe(0);
    expect(manifest.header!.planned_ops.disable).toBe(0);
    expect(manifest.header!.planned_ops.flag).toBe(0);

    // selection_filter is subset with empty ids.
    expect(manifest.header!.selection_filter!.mode).toBe('subset');
    const sf = manifest.header!.selection_filter as { mode: 'subset'; ids: string[] };
    expect(sf.ids).toEqual([]);

    // Warning printed to stderr.
    expect(bust.stderr).toMatch(/no items will be archived|empty set/i);

    // All source files untouched.
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(true);
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(true);
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md'))).toBe(true);
  });

  // ── Test E: unknown ids are silently ignored ──────────────────
  it('Test E — unknown ids: silently ignored, no files moved', async () => {
    const dry = await runDryRunFirst(tmpHome);
    expect(dry.code, `dry-run stderr: ${dry.stderr}`).toBe(0);

    const bust = await runBustCommand(
      tmpHome,
      ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
      { env: { CCAUDIT_SELECT_IDS: 'agent|global||/this/path/does/not/match/anything.md' } },
    );
    expect(bust.code, `bust stderr: ${bust.stderr}`).toBe(0);

    const manifestPath = manifestPathFromEnvelope(bust.stdout);
    const manifest = await readManifest(manifestPath);

    // No ops (unknown id filtered out — results in zero-item subset plan).
    expect(manifest.header).not.toBeNull();
    const totalOps =
      manifest.header!.planned_ops.archive +
      manifest.header!.planned_ops.disable +
      manifest.header!.planned_ops.flag;
    expect(totalOps).toBe(0);

    // All source files untouched.
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(true);
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(true);
    expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'gamma.md'))).toBe(true);
  });
});
