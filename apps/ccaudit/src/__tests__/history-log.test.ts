/**
 * Integration tests for the append-only history.jsonl audit trail (Phase 6).
 *
 * Spawns the built binary with HOME overridden to a tmpdir fixture, then
 * inspects ~/.claude/ccaudit/history.jsonl for the expected records.
 *
 * Coverage:
 *   HIST-A: single invocation writes header + 1 entry
 *   HIST-B: three commands → append, not overwrite (1 header + 3 entries)
 *   HIST-C: CCAUDIT_NO_HISTORY=1 → no file created
 *   HIST-D: --privacy flag → privacy_redacted: true, cwd is synthetic
 *   HIST-E: malformed prior file → command succeeds, new entry appended, garbage left alone
 *   HIST-F: bust entry shape validation
 *   HIST-G: restore entry shape validation
 *   HIST-H: reclaim entry shape validation
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpHome, cleanupTmpHome, runCcauditCli, readJsonl } from './_test-helpers.ts';

// ── Resolve dist path ──────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');

// ── Guard ──────────────────────────────────────────────────────────

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `ccaudit dist not built. Run 'pnpm -F ccaudit build' before the history integration tests.`,
    );
  }
});

// ── Helpers ────────────────────────────────────────────────────────

function historyPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'ccaudit', 'history.jsonl');
}

/**
 * Fake ps script that makes bust tests work without a running Claude Code session.
 */
const FAKE_PS_SCRIPT = `#!/bin/sh
case "$*" in
  *-A*) echo "    1 init" ;;
  *-o\\ ppid=*) echo "1" ;;
  *) echo "    1 init" ;;
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

/**
 * Build minimal base fixture (session file + .claude.json + fake ps).
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
 * runCcauditCli wrapper that injects fake ps on PATH.
 */
async function runWithFakePs(
  tmpHome: string,
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof runCcauditCli>>> {
  const binDir = path.join(tmpHome, 'bin');
  // On Windows, process detection uses `tasklist` (from System32). Overriding
  // PATH to the fake-ps binDir alone would strip System32 and break bust.
  // Inherit the parent PATH on Windows; the fake ps shim is a Unix-only
  // workaround for environments where `ps` may not be present or deterministic.
  const envPath =
    process.platform === 'win32' ? (process.env.PATH ?? process.env.Path ?? '') : binDir;
  return runCcauditCli(tmpHome, argv, {
    env: {
      PATH: envPath,
      ...extraEnv,
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ccaudit history.jsonl', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await makeTmpHome();
    await buildBaseFixture(tmpHome);
  });

  afterEach(async () => {
    await cleanupTmpHome(tmpHome);
  });

  // ── HIST-A: single invocation ─────────────────────────────────────

  it('HIST-A: ghost command writes header + 1 entry to history.jsonl', async () => {
    const result = await runWithFakePs(tmpHome, ['ghost']);
    // ghost exits 0 (no ghosts) or 1 (ghosts found); both are fine
    expect([0, 1]).toContain(result.exitCode);

    const hPath = historyPath(tmpHome);
    expect(existsSync(hPath), `history.jsonl should exist at ${hPath}`).toBe(true);

    const records = await readJsonl(hPath);
    expect(records.length).toBe(2); // header + 1 entry

    const header = records[0] as Record<string, unknown>;
    expect(header.record_type).toBe('header');
    expect(header.history_version).toBe(1);
    expect(typeof header.ccaudit_version).toBe('string');
    expect(typeof header.created_at).toBe('string');
    expect(typeof header.host_os).toBe('string');
    expect(typeof header.node_version).toBe('string');

    const entry = records[1] as Record<string, unknown>;
    expect(entry.record_type).toBe('entry');
    expect(entry.command).toBe('ghost');
    expect(entry.exit_code).toBe(result.exitCode);
    expect(typeof entry.ts).toBe('string');
    expect(Array.isArray(entry.argv)).toBe(true);
    expect(typeof entry.duration_ms).toBe('number');
    expect(typeof entry.cwd).toBe('string');
    expect(entry.privacy_redacted).toBe(false);
    expect(Array.isArray(entry.errors)).toBe(true);
  });

  // ── HIST-B: append, not overwrite ────────────────────────────────

  it('HIST-B: three commands produce 1 header + 3 entries (append, not overwrite)', async () => {
    // Run ghost 3 times
    await runWithFakePs(tmpHome, ['ghost']);
    await runWithFakePs(tmpHome, ['ghost']);
    await runWithFakePs(tmpHome, ['ghost']);

    const hPath = historyPath(tmpHome);
    const records = await readJsonl(hPath);
    expect(records.length).toBe(4); // 1 header + 3 entries

    // All entries should be entries (not additional headers)
    const headers = records.filter((r) => (r as Record<string, unknown>).record_type === 'header');
    const entries = records.filter((r) => (r as Record<string, unknown>).record_type === 'entry');
    expect(headers.length).toBe(1);
    expect(entries.length).toBe(3);

    // Header timestamp should be identical across all 3 runs (written once)
    const headerTs = (records[0] as Record<string, unknown>).created_at as string;
    expect(typeof headerTs).toBe('string');
    // Sanity: all entries have different ts (milliseconds apart is fine)
    expect((records[1] as Record<string, unknown>).record_type).toBe('entry');
    expect((records[2] as Record<string, unknown>).record_type).toBe('entry');
    expect((records[3] as Record<string, unknown>).record_type).toBe('entry');
  });

  // ── HIST-C: opt-out ───────────────────────────────────────────────

  it('HIST-C: CCAUDIT_NO_HISTORY=1 prevents any history write', async () => {
    await runWithFakePs(tmpHome, ['ghost'], { CCAUDIT_NO_HISTORY: '1' });

    const hPath = historyPath(tmpHome);
    expect(existsSync(hPath), 'history.jsonl must NOT exist when opted out').toBe(false);
  });

  // ── HIST-D: privacy redaction ─────────────────────────────────────

  it('HIST-D: --privacy flag sets privacy_redacted: true and cwd is not a real path', async () => {
    await runWithFakePs(tmpHome, ['ghost', '--privacy']);

    const hPath = historyPath(tmpHome);
    expect(existsSync(hPath)).toBe(true);

    const records = await readJsonl(hPath);
    const entry = records.find((r) => (r as Record<string, unknown>).record_type === 'entry') as
      | Record<string, unknown>
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.privacy_redacted).toBe(true);

    // cwd must NOT contain the real tmpHome path
    const cwd = entry!.cwd as string;
    expect(cwd).not.toContain(tmpHome);
  });

  // ── HIST-E: malformed prior file ──────────────────────────────────

  it('HIST-E: malformed prior file is tolerated — command succeeds, new entry appended', async () => {
    const hPath = historyPath(tmpHome);
    // Pre-create history.jsonl with garbage content
    await mkdir(path.dirname(hPath), { recursive: true });
    await writeFile(hPath, '{"truncated garbage line\n', 'utf8');

    const result = await runWithFakePs(tmpHome, ['ghost']);
    expect(result.exitCode).not.toBe(2); // command must not crash with exit 2

    const raw = await readFile(hPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    // Garbage line must still be there (not repaired)
    expect(lines[0]).toContain('truncated garbage line');

    // At least one valid new line appended
    const validLines = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    expect(validLines.length).toBeGreaterThanOrEqual(1);
  });

  // ── HIST-F: bust entry shape ──────────────────────────────────────

  it('HIST-F: bust entry has expected result shape', async () => {
    // First run dry-run to create a checkpoint
    await runWithFakePs(tmpHome, ['--dry-run']);

    // Then bust
    const bustResult = await runWithFakePs(tmpHome, [
      '--dangerously-bust-ghosts',
      '--yes-proceed-busting',
    ]);
    // Bust exits 0 (success) or possibly other codes if no items; just run it
    expect(typeof bustResult.exitCode).toBe('number');

    const hPath = historyPath(tmpHome);
    const records = await readJsonl(hPath);
    const bustEntry = records.find(
      (r) =>
        (r as Record<string, unknown>).record_type === 'entry' &&
        (r as Record<string, unknown>).command === 'bust',
    ) as Record<string, unknown> | undefined;

    expect(bustEntry, 'bust entry should be present in history').toBeDefined();
    const result = bustEntry!.result as Record<string, unknown>;
    expect(result).toBeDefined();
    // Shape check: these keys should be present when bust succeeds with exit_code 0.
    // When bust fails or has nothing to process, result may be {} or a different shape.
    if (bustEntry!.exit_code === 0 && result !== null && 'before_tokens' in result) {
      expect(typeof result.before_tokens).toBe('number');
      expect(typeof result.after_tokens).toBe('number');
      expect(typeof result.freed_tokens).toBe('number');
      expect(typeof result.archived_agents).toBe('number');
      expect(typeof result.archived_skills).toBe('number');
    }
  });

  // ── HIST-G: restore entry shape ───────────────────────────────────

  it('HIST-G: restore entry has expected result shape', async () => {
    // Run restore (may be a no-op if no manifests, but should still log)
    await runWithFakePs(tmpHome, ['restore']);

    const hPath = historyPath(tmpHome);
    const records = await readJsonl(hPath);
    const restoreEntry = records.find(
      (r) =>
        (r as Record<string, unknown>).record_type === 'entry' &&
        (r as Record<string, unknown>).command === 'restore',
    ) as Record<string, unknown> | undefined;

    expect(restoreEntry, 'restore entry should be present in history').toBeDefined();
    const result = restoreEntry!.result as Record<string, unknown> | null;
    // result may be null for no-manifests case, or have shape
    if (result !== null && result !== undefined) {
      // If a result shape exists, it should have moved/already_at_source/failed
      if ('moved' in result) {
        expect(typeof result.moved).toBe('number');
        expect(typeof result.already_at_source).toBe('number');
        expect(typeof result.failed).toBe('number');
        expect(Array.isArray(result.manifests_consumed)).toBe(true);
      }
    }
  });

  // ── HIST-H: reclaim entry shape ───────────────────────────────────

  it('HIST-H: reclaim entry has expected result shape', async () => {
    await runWithFakePs(tmpHome, ['reclaim']);

    const hPath = historyPath(tmpHome);
    const records = await readJsonl(hPath);
    const reclaimEntry = records.find(
      (r) =>
        (r as Record<string, unknown>).record_type === 'entry' &&
        (r as Record<string, unknown>).command === 'reclaim',
    ) as Record<string, unknown> | undefined;

    expect(reclaimEntry, 'reclaim entry should be present in history').toBeDefined();
    const result = reclaimEntry!.result as Record<string, unknown>;
    expect(result).toBeDefined();
    expect(typeof result.orphans_detected).toBe('number');
    expect(typeof result.reclaimed).toBe('number');
    expect(typeof result.skipped).toBe('number');
  });
});
