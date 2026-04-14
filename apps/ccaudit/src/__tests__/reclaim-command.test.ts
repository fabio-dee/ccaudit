/**
 * Subprocess integration tests for `ccaudit reclaim`.
 *
 * Spawns the built binary (apps/ccaudit/dist/index.js) with HOME overridden
 * to a tmpdir fixture, asserts exit codes, stdout/stderr, and on-disk side
 * effects. Mirrors the pattern from restore-command.test.ts.
 *
 * Coverage:
 *   RECLAIM-01: happy path — 3 orphan files, no manifest referencing them.
 *               --dry-run lists all 3, marks source-missing, does NOT mutate FS.
 *               reclaim (no flag) restores all 3 to inferred source paths.
 *   RECLAIM-02: source-exists — 1 orphan whose inferred source already exists.
 *               reclaim skips it with a warning; archived file remains intact.
 *   RECLAIM-03: mixed — 2 source-missing + 1 source-exists.
 *               2 reclaimed, 1 skipped.
 *   RECLAIM-04: no orphans — archived/ has a file referenced by a manifest.
 *               reclaim finds 0 orphans, exits 0, no-op.
 *   RECLAIM-05: archived root does not exist — exits 0 with "0 orphans".
 *   RECLAIM-06: manifests dir does not exist — every file in archived/ is an orphan.
 *
 * Architecture note
 * ─────────────────
 * `reclaim` does NOT use the running-process gate (it has no manifest context
 * and just reads/moves files). Therefore there is no fake `ps` requirement
 * for this test suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Resolve dist path ──────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Types ──────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// ── Guard: dist must exist before any test runs ─────────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `ccaudit dist not built. Run 'pnpm -F ccaudit build' before the reclaim integration tests.`,
    );
  }
});

// ── Subprocess runner ──────────────────────────────────────────────

async function runReclaim(tmpHome: string, flags: string[], timeout = 30_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath, 'reclaim', ...flags], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`reclaim command timed out after ${timeout}ms`));
    }, timeout);

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

// ── Fixture helpers ────────────────────────────────────────────────

/** Resolve the archived root path for the given tmpHome. */
function archivedRoot(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'archived');
}

/** Resolve the manifests dir for the given tmpHome. */
function manifestsDir(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
}

/**
 * Write a minimal (no-manifest-reference) orphan file into archived/.
 * The path mirrors the source layout:
 *   archived/.claude/<relPath> → source: .claude/<relPath>
 *
 * The archived dir layout: ~/.claude/ccaudit/archived/<relative-to-home>
 * e.g. orphan at .claude/agents/foo.md → archived path: archived/.claude/agents/foo.md
 */
async function writeOrphanFile(
  tmpHome: string,
  relToHome: string,
  content = 'hello',
): Promise<void> {
  // relToHome e.g. '.claude/agents/foo.md'
  const archivePath = path.join(archivedRoot(tmpHome), relToHome);
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, content, 'utf8');
}

/**
 * Write a minimal JSONL manifest that references an archive_path.
 * This simulates a file that IS referenced by a manifest (non-orphan).
 */
async function writeManifestWithReference(tmpHome: string, archivePath: string): Promise<void> {
  const mDir = manifestsDir(tmpHome);
  await mkdir(mDir, { recursive: true });
  const manifestPath = path.join(mDir, 'bust-2026-04-14T00-00-00Z.jsonl');
  const header = JSON.stringify({
    record_type: 'header',
    manifest_version: 1,
    ccaudit_version: '1.4.0',
    checkpoint_ghost_hash: 'abc123',
    checkpoint_timestamp: '2026-04-14T00:00:00Z',
    since_window: '30d',
    os: 'darwin',
    node_version: 'v22.0.0',
    planned_ops: { archive: 1, disable: 0, flag: 0 },
  });
  const op = JSON.stringify({
    op_id: '00000000-0000-0000-0000-000000000001',
    op_type: 'archive',
    timestamp: '2026-04-14T00:00:01Z',
    status: 'completed',
    category: 'agent',
    scope: 'global',
    source_path: archivePath.replace('/ccaudit/archived/', '/'),
    archive_path: archivePath,
    content_sha256: 'deadbeef',
  });
  const footer = JSON.stringify({
    record_type: 'footer',
    completed_at: '2026-04-14T00:00:02Z',
    total_ops: 1,
    failed_ops: 0,
  });
  await writeFile(manifestPath, `${header}\n${op}\n${footer}\n`, 'utf8');
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ccaudit reclaim', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-reclaim-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  // ── RECLAIM-01: happy path ────────────────────────────────────────

  describe('RECLAIM-01: 3 orphan files, no manifest', () => {
    beforeEach(async () => {
      // Seed 3 orphan files with source paths that do NOT exist yet
      await writeOrphanFile(tmpHome, '.claude/agents/alpha.md', 'agent alpha');
      await writeOrphanFile(tmpHome, '.claude/agents/beta.md', 'agent beta');
      await writeOrphanFile(tmpHome, '.claude/skills/gamma.md', 'skill gamma');
    });

    it('--dry-run lists all 3 orphans as source-missing and does NOT mutate FS', async () => {
      const archRoot = archivedRoot(tmpHome);
      const result = await runReclaim(tmpHome, ['--dry-run']);

      expect(result.exitCode).toBe(0);

      // Should mention all 3 orphan files
      expect(result.stdout).toContain('alpha.md');
      expect(result.stdout).toContain('beta.md');
      expect(result.stdout).toContain('gamma.md');

      // All 3 should be listed as source-missing
      expect(result.stdout.match(/source-missing/g)?.length).toBeGreaterThanOrEqual(3);

      // Summary must say 3 orphans detected (dry-run mode)
      expect(result.stdout).toMatch(/3 orphan/i);

      // FS must be UNCHANGED: archived files still present
      expect(existsSync(path.join(archRoot, '.claude', 'agents', 'alpha.md'))).toBe(true);
      expect(existsSync(path.join(archRoot, '.claude', 'agents', 'beta.md'))).toBe(true);
      expect(existsSync(path.join(archRoot, '.claude', 'skills', 'gamma.md'))).toBe(true);

      // Source paths must still be absent
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(false);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(false);
      expect(existsSync(path.join(tmpHome, '.claude', 'skills', 'gamma.md'))).toBe(false);
    });

    it('reclaim (no --dry-run) restores all 3 files to source paths', async () => {
      const archRoot = archivedRoot(tmpHome);
      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);

      // Summary: 3 reclaimed
      expect(result.stdout).toMatch(/3 reclaimed/i);

      // Source paths must now exist
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'alpha.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'beta.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'skills', 'gamma.md'))).toBe(true);

      // Archive paths must be gone
      expect(existsSync(path.join(archRoot, '.claude', 'agents', 'alpha.md'))).toBe(false);
      expect(existsSync(path.join(archRoot, '.claude', 'agents', 'beta.md'))).toBe(false);
      expect(existsSync(path.join(archRoot, '.claude', 'skills', 'gamma.md'))).toBe(false);
    });
  });

  // ── RECLAIM-02: source-exists — must skip ─────────────────────────

  describe('RECLAIM-02: orphan whose source already exists', () => {
    beforeEach(async () => {
      // Write both the orphan in archived/ AND the existing source file
      await writeOrphanFile(tmpHome, '.claude/agents/existing.md', 'archived version');
      // Create the source path that already exists
      const sourcePath = path.join(tmpHome, '.claude', 'agents', 'existing.md');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, 'original source version', 'utf8');
    });

    it('skips the orphan and leaves both files untouched', async () => {
      const archRoot = archivedRoot(tmpHome);
      const archivePath = path.join(archRoot, '.claude', 'agents', 'existing.md');
      const sourcePath = path.join(tmpHome, '.claude', 'agents', 'existing.md');

      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);

      // Summary: 0 reclaimed, 1 skipped
      expect(result.stdout).toMatch(/0 reclaimed/i);
      expect(result.stdout).toMatch(/1 skipped/i);

      // SAFETY INVARIANT: archived file must still be present (NOT deleted)
      expect(existsSync(archivePath)).toBe(true);

      // SAFETY INVARIANT: source file must be UNCHANGED (NOT overwritten)
      const { readFile } = await import('node:fs/promises');
      const sourceContent = await readFile(sourcePath, 'utf8');
      expect(sourceContent).toBe('original source version');
    });
  });

  // ── RECLAIM-03: mixed — 2 source-missing + 1 source-exists ────────

  describe('RECLAIM-03: mixed orphans', () => {
    beforeEach(async () => {
      // 2 orphans with no source
      await writeOrphanFile(tmpHome, '.claude/agents/orphan-a.md', 'orphan a');
      await writeOrphanFile(tmpHome, '.claude/agents/orphan-b.md', 'orphan b');
      // 1 orphan whose source already exists
      await writeOrphanFile(tmpHome, '.claude/agents/exists-c.md', 'archived c');
      const existsSource = path.join(tmpHome, '.claude', 'agents', 'exists-c.md');
      await mkdir(path.dirname(existsSource), { recursive: true });
      await writeFile(existsSource, 'live c', 'utf8');
    });

    it('reclaims 2, skips 1', async () => {
      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/2 reclaimed/i);
      expect(result.stdout).toMatch(/1 skipped/i);

      // The 2 orphans should now be at their source paths
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'orphan-a.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'orphan-b.md'))).toBe(true);

      // The source-exists one must remain untouched at live c
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(
        path.join(tmpHome, '.claude', 'agents', 'exists-c.md'),
        'utf8',
      );
      expect(content).toBe('live c');
    });
  });

  // ── RECLAIM-04: no orphans (file IS referenced by a manifest) ─────

  describe('RECLAIM-04: file referenced by manifest is NOT an orphan', () => {
    beforeEach(async () => {
      const archRoot = archivedRoot(tmpHome);
      const archivePath = path.join(archRoot, '.claude', 'agents', 'referenced.md');
      // Write the file into archived/
      await mkdir(path.dirname(archivePath), { recursive: true });
      await writeFile(archivePath, 'referenced content', 'utf8');
      // Write a manifest that references it
      await writeManifestWithReference(tmpHome, archivePath);
    });

    it('detects 0 orphans and exits 0 with no-op', async () => {
      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/0 orphan/i);

      // The referenced file should remain in archived/ (not moved)
      const archRoot = archivedRoot(tmpHome);
      expect(existsSync(path.join(archRoot, '.claude', 'agents', 'referenced.md'))).toBe(true);
    });
  });

  // ── RECLAIM-05: archived root does not exist ───────────────────────

  describe('RECLAIM-05: archived root does not exist', () => {
    it('exits 0 with 0 orphans detected', async () => {
      // Do NOT create the archived directory
      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/0 orphan/i);
    });

    it('--dry-run also exits 0 with 0 orphans', async () => {
      const result = await runReclaim(tmpHome, ['--dry-run']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/0 orphan/i);
    });
  });

  // ── RECLAIM-06: manifests dir does not exist → all files are orphans

  describe('RECLAIM-06: manifests dir does not exist', () => {
    beforeEach(async () => {
      // Write 2 orphan files, but do NOT create the manifests directory
      await writeOrphanFile(tmpHome, '.claude/agents/no-manifest-a.md', 'orphan a');
      await writeOrphanFile(tmpHome, '.claude/agents/no-manifest-b.md', 'orphan b');
    });

    it('treats all archived files as orphans and reclaims them', async () => {
      const result = await runReclaim(tmpHome, []);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/2 reclaimed/i);

      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'no-manifest-a.md'))).toBe(true);
      expect(existsSync(path.join(tmpHome, '.claude', 'agents', 'no-manifest-b.md'))).toBe(true);
    });
  });
});
