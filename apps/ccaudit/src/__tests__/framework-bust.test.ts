/**
 * Integration tests for v1.3.0 Phase 4 framework-as-unit bust protection.
 *
 * Spawns the built binary against a tmpdir fixture containing a partially-used
 * GSD-like framework, a domain-folder agent, and ungrouped ghosts. Verifies
 * BUST-01..06 end-to-end and enforces the BUST-07 bust.ts NO-TOUCH invariant
 * via a line-count assertion.
 *
 * Phase 5 owns the full TEST-04/05 fixture matrix; Phase 4 ships just enough
 * coverage to verify the requirement set:
 *   BUST-01: groupByFramework called before archival
 *   BUST-02: ghost members of partially-used frameworks skipped without --force-partial
 *   BUST-03: skipped list surfaced (warnings + protected[] in JSON envelope)
 *   BUST-04: yellow warning block present in default-mode stdout
 *   BUST-05: PROTECTED section present in default-mode stdout
 *   BUST-06: --force-partial bypasses protection; ghosts archived
 *   BUST-07: bust.ts NO-TOUCH line-count guard (1483 lines, identical to v1.2.1).
 *            The restore.ts line-count guard was removed in commit 4515c1c
 *            when v1.3.0 landed an internal process-gate fix in that file;
 *            manifest compatibility is covered by the restore-command tests
 *            and documented in CHANGELOG.md.
 *   RESTORE-01..03: manifest compatibility (v1.2.1 manifests restore cleanly)
 *            is validated by restore-command.test.ts, not by a line-count guard.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, utimes, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Resolve paths ──────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ lives at apps/ccaudit/src/__tests__ → dist is at apps/ccaudit/dist
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');
// Repo root is four levels up from __tests__ (src/__tests__ → src → ccaudit → apps → repo)
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const bustTsPath = path.resolve(repoRoot, 'packages', 'internal', 'src', 'remediation', 'bust.ts');

// ── Fake ps script body (copy from bust-command.test.ts) ───────

const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit framework-bust integration tests.
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

async function runCommand(tmpHome: string, flags: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath, ...flags], {
      env: {
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        PATH: path.join(tmpHome, 'bin'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('runCommand timed out after 30s'));
    }, 30_000);
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

// ── Fixture builder for framework-protection scenarios ─────────

/**
 * Build a fixture with:
 *  - 1 USED gsd-planner.md (recent mtime + session invocation reference)
 *  - 2 GHOST gsd-*.md agents (mtime 60 days ago, no session reference)
 *  - 1 GHOST engineering/code-reviewer.md (domain-folder, NOT a framework)
 *  - 1 GHOST solo-ungrouped.md (no framework, no cluster)
 *  - empty .claude.json
 *  - minimal session JSONL with a tool_use referencing gsd-planner so the
 *    parser records an invocation and the classifier marks it as 'used'.
 *  - fake-ps shim
 */
async function buildFrameworkFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const engineeringDir = path.join(agentsDir, 'engineering');
  const skillsDir = path.join(tmpHome, '.claude', 'skills');
  const xdgDir = path.join(tmpHome, '.config', 'claude');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(engineeringDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(xdgDir, { recursive: true });

  // 1 USED gsd-planner — recent mtime (mtime stays as "now" after writeFile)
  const plannerPath = path.join(agentsDir, 'gsd-planner.md');
  await writeFile(plannerPath, '# gsd-planner agent\n', 'utf8');

  // 2 GHOST gsd-* — old mtime (60 days ago → definite-ghost)
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  const ghostAgents = ['gsd-researcher.md', 'gsd-verifier.md'];
  for (const name of ghostAgents) {
    const p = path.join(agentsDir, name);
    await writeFile(p, `# ${name}\n`, 'utf8');
    await utimes(p, sixtyDaysAgo, sixtyDaysAgo);
  }

  // 1 GHOST engineering/code-reviewer — domain-folder, NOT a framework
  const codeReviewerPath = path.join(engineeringDir, 'code-reviewer.md');
  await writeFile(codeReviewerPath, '# code-reviewer\n', 'utf8');
  await utimes(codeReviewerPath, sixtyDaysAgo, sixtyDaysAgo);

  // 1 GHOST solo-ungrouped — no cluster, no framework
  const soloPath = path.join(agentsDir, 'solo-ungrouped.md');
  await writeFile(soloPath, '# solo-ungrouped\n', 'utf8');
  await utimes(soloPath, sixtyDaysAgo, sixtyDaysAgo);

  // Empty .claude.json (no MCP servers — keeps the test focused on agents)
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

  // Session JSONL with a tool_use block referencing gsd-planner so the
  // parser records an invocation and the classifier marks it as 'used'.
  // The parser's extractInvocations reads `toolBlock.name === 'Task'` with
  // `input.subagent_type` to produce an InvocationRecord of kind 'agent'.
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
  await mkdir(sessionDir, { recursive: true });
  const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const sessionLines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/project',
      timestamp: recentTs,
      sessionId: 'phase4-test',
    }),
    // Tool-use line referencing gsd-planner via Task tool with subagent_type.
    // extractInvocations matches `toolBlock.name === 'Task'` → `input.subagent_type`.
    JSON.stringify({
      type: 'assistant',
      timestamp: recentTs,
      sessionId: 'phase4-test',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Task',
            input: { subagent_type: 'gsd-planner', prompt: 'plan something' },
          },
        ],
      },
    }),
  ];
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLines.join('\n') + '\n', 'utf8');

  // Fake ps shim
  await buildFakePs(tmpHome);
}

// ── Guard: dist must exist before any test runs ────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ── Test cases ─────────────────────────────────────────────────

describe('Phase 4: framework-as-unit bust protection (integration)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'phase4-fwbust-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── BUST-07 NO-TOUCH invariant (bust.ts only) ────────────────
  // restore.ts is no longer asserted identical to v1.2.1: v1.3.0 lands a
  // documented internal process-gate fix (parent-chain self-invocation).
  // See CHANGELOG.md for the manifest-compatibility statement. bust.ts
  // remains truly untouched.
  describe('BUST-07: NO-TOUCH exported API invariant', () => {
    it('packages/internal/src/remediation/bust.ts exports the expected public symbols', () => {
      // Asserts the public API surface rather than a raw line count.
      // Stable against formatting, comment changes, and additions of in-source
      // vitest blocks (which are stripped by the bundler and must not trip this guard).
      // To update: add new exported names here when the module gains new exports;
      // remove names only when the export is intentionally deleted.
      const bustSrc = readFileSync(bustTsPath, 'utf8');
      const EXPECTED_EXPORTS = ['runBust', 'runConfirmationCeremony'];
      for (const sym of EXPECTED_EXPORTS) {
        expect(bustSrc, `bust.ts must export '${sym}'`).toMatch(
          new RegExp(`\\bexport\\b[^\\n]*\\b${sym}\\b`),
        );
      }
    });
  });

  // ── BUST-02, BUST-03 (default behavior — protection active) ──
  describe('BUST-02 + BUST-03: dry-run without --force-partial protects ghost members', () => {
    it('GSD ghost members are NOT in changePlan.archive[]', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--json']);
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const archive = (changePlan.archive as Array<{ name: string }>) ?? [];
      const gsdGhostsInArchive = archive.filter((i) => /^gsd-/.test(i.name));
      expect(gsdGhostsInArchive).toEqual([]);
    });

    it('changePlan.protectionWarnings emitted with frameworkId=gsd', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const warnings = changePlan.protectionWarnings as Array<{
        frameworkId: string;
        activeMembers: number;
        protectedGhostMembers: number;
      }>;
      expect(warnings).toBeDefined();
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.frameworkId).toBe('gsd');
      expect(warnings[0]?.activeMembers).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.protectedGhostMembers).toBeGreaterThanOrEqual(2);
    });

    it('changePlan.protected[] contains the skipped GSD ghost members', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const protectedItems = (changePlan.protected as Array<{ name: string }>) ?? [];
      const protectedNames = protectedItems.map((i) => i.name).sort();
      expect(protectedNames.length).toBeGreaterThanOrEqual(2);
      expect(protectedNames.every((n) => /^gsd-/.test(n))).toBe(true);
    });
  });

  // ── BUST-04 + BUST-05: stdout rendering ──────────────────────
  describe('BUST-04 + BUST-05: dry-run stdout shows yellow warning + PROTECTED section', () => {
    it('default-mode stdout contains "Will SKIP (framework protection)" header', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run']);
      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Will SKIP (framework protection)');
    });

    it('default-mode stdout contains the framework displayName + --force-partial mention', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run']);
      expect(result.code).toBe(0);
      // The displayName comes from KNOWN_FRAMEWORKS registry. Use a case-insensitive
      // contains check on 'gsd' to be tolerant of the canonical capitalization.
      expect(result.stdout.toLowerCase()).toContain('gsd');
      expect(result.stdout).toContain('--force-partial');
    });
  });

  // ── BUST-06: --force-partial bypass ──────────────────────────
  describe('BUST-06: --force-partial archives ghost members of partially-used frameworks', () => {
    it('GSD ghost members ARE in changePlan.archive[] when --force-partial is set', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--force-partial', '--json']);
      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const archive = (changePlan.archive as Array<{ name: string }>) ?? [];
      const gsdGhostsInArchive = archive.filter((i) => /^gsd-/.test(i.name));
      expect(gsdGhostsInArchive.length).toBeGreaterThanOrEqual(2);
    });

    it('protectionWarnings still emitted under --force-partial (audit trail)', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--force-partial', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const warnings = changePlan.protectionWarnings as Array<{ frameworkId: string }>;
      expect(warnings).toBeDefined();
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.frameworkId).toBe('gsd');
    });

    it('changePlan.protected[] is omitted/empty under --force-partial', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--force-partial', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      // Per Plan 03 omission rule, the field is absent (key not present) when
      // protectedItems.length === 0. forcePartial moves all items into archive.
      const protectedItems = (changePlan.protected as Array<unknown>) ?? [];
      expect(protectedItems).toEqual([]);
    });
  });

  // ── --no-group-frameworks bypass ──────────────────────────────
  describe('CLI-05: --no-group-frameworks disables protection entirely', () => {
    it('changePlan.protected and changePlan.protectionWarnings are absent', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, [
        'ghost',
        '--dry-run',
        '--no-group-frameworks',
        '--json',
      ]);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      expect(changePlan.protected).toBeUndefined();
      expect(changePlan.protectionWarnings).toBeUndefined();
    });

    it('GSD ghost agents flow into changePlan.archive[] when grouping disabled', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, [
        'ghost',
        '--dry-run',
        '--no-group-frameworks',
        '--json',
      ]);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const archive = (changePlan.archive as Array<{ name: string }>) ?? [];
      const gsdGhosts = archive.filter((i) => /^gsd-(researcher|verifier)/.test(i.name));
      expect(gsdGhosts.length).toBeGreaterThanOrEqual(2);
    });

    it('--force-partial + --no-group-frameworks emits informational stderr warning', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, [
        'ghost',
        '--dry-run',
        '--no-group-frameworks',
        '--force-partial',
      ]);
      expect(result.stderr).toMatch(/--force-partial has no effect with --no-group-frameworks/);
    });
  });

  // ── DETECT-05/07: domain folders are not frameworks ──────────
  describe('DETECT-05 + DETECT-07: domain-folder agents are NOT framework-protected', () => {
    it('engineering/code-reviewer.md appears in changePlan.archive[] regardless of --force-partial', async () => {
      await buildFrameworkFixture(tmpHome);
      const result = await runCommand(tmpHome, ['ghost', '--dry-run', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const changePlan = parsed.changePlan as Record<string, unknown>;
      const archive = (changePlan.archive as Array<{ name: string }>) ?? [];
      const codeReviewer = archive.find((i) => i.name === 'code-reviewer');
      expect(codeReviewer).toBeDefined();
    });
  });
});
