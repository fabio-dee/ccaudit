/**
 * HistoryWriter — append-only writer for history.jsonl.
 *
 * Modeled on ManifestWriter (packages/internal/src/remediation/manifest.ts:369).
 * Key differences from ManifestWriter:
 *   - Opens in 'a' (append) mode rather than creating a fresh file.
 *   - Caller must check whether the file is empty and write the header first.
 *   - Mode 0o600 is applied (same as manifest files).
 *
 * Concurrency caveat (v1):
 *   Two ccaudit processes appending simultaneously share the OS 'a' mode
 *   guarantee: each write(2) call atomically positions + writes on POSIX.
 *   JSONL lines are small (<4 KB), so interleaving is unlikely in practice.
 *   No file locking is implemented; callers should treat overlapping writes
 *   as best-effort.
 */

import { open, stat, mkdir, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryRecord } from './types.ts';

export class HistoryWriter {
  private fd: FileHandle | null = null;

  constructor(public readonly filePath: string) {}

  /**
   * Open the file in append mode. Creates the file and its parent directories
   * if they don't exist. Applies mode 0o600 (user-only read/write).
   *
   * Returns the current file size (bytes) so the caller can decide whether to
   * write a header before the first entry.
   */
  async open(): Promise<number> {
    // Guard against double-open: return the current file size without
    // opening a second handle (which would leak the original descriptor).
    if (this.fd) {
      try {
        const s = await this.fd.stat();
        return s.size;
      } catch {
        return 0;
      }
    }

    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.fd = await open(this.filePath, 'a', 0o600);
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // Windows doesn't honor POSIX modes; ignore EPERM/ENOTSUP.
    }
    // Stat AFTER open so we see the current size (handles both new and existing).
    try {
      const s = await stat(this.filePath);
      return s.size;
    } catch {
      return 0;
    }
  }

  /**
   * Append a single JSON record followed by a newline.
   * Fsync is called after every write to ensure durability.
   *
   * Pitfall (same as ManifestWriter): concatenate JSON + '\n' in ONE write
   * call to avoid a partial-line race between two syscalls.
   */
  async append(record: HistoryRecord): Promise<void> {
    if (!this.fd) {
      throw new Error('HistoryWriter.append: not opened (call open() first)');
    }
    await this.fd.write(JSON.stringify(record) + '\n');
    await this.fd.sync();
  }

  /** Close the file handle. Safe to call multiple times. */
  async close(): Promise<void> {
    if (!this.fd) return;
    await this.fd.close();
    this.fd = null;
  }
}

// ── In-source tests ───────────────────────────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect, afterEach } = import.meta.vitest;
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  let tmpDir: string;

  async function makeTmp(): Promise<string> {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'history-writer-test-'));
    return tmpDir;
  }

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('HistoryWriter', () => {
    it('creates file + writes header + entry on fresh path', async () => {
      const dir = await makeTmp();
      const filePath = path.join(dir, 'test.jsonl');
      const writer = new HistoryWriter(filePath);

      const size = await writer.open();
      expect(size).toBe(0); // fresh file

      const header = {
        record_type: 'header' as const,
        history_version: 1 as const,
        ccaudit_version: '1.4.0',
        created_at: '2026-04-14T00:00:00.000Z',
        host_os: 'darwin',
        node_version: 'v22.0.0',
      };
      const entry = {
        record_type: 'entry' as const,
        ts: '2026-04-14T00:00:00.000Z',
        argv: ['ghost'],
        command: 'ghost',
        exit_code: 0,
        duration_ms: 100,
        cwd: '/home/user',
        privacy_redacted: false,
        result: null,
        errors: [],
      };

      await writer.append(header);
      // Verify the file is readable BEFORE close (fsync guarantees)
      const afterFirstWrite = await readFile(filePath, 'utf8');
      expect(afterFirstWrite.trim()).toBe(JSON.stringify(header));

      await writer.append(entry);
      await writer.close();

      const raw = await readFile(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0])).toMatchObject({ record_type: 'header' });
      expect(JSON.parse(lines[1])).toMatchObject({ record_type: 'entry', command: 'ghost' });
    });

    it('appends entry to existing file (no duplicate header)', async () => {
      const dir = await makeTmp();
      const filePath = path.join(dir, 'test.jsonl');

      // Write first record
      const w1 = new HistoryWriter(filePath);
      const s1 = await w1.open();
      expect(s1).toBe(0);
      await w1.append({
        record_type: 'header',
        history_version: 1,
        ccaudit_version: '1.4.0',
        created_at: '2026-04-14T00:00:00Z',
        host_os: 'darwin',
        node_version: 'v22.0.0',
      });
      await w1.append({
        record_type: 'entry',
        ts: new Date().toISOString(),
        argv: ['ghost'],
        command: 'ghost',
        exit_code: 0,
        duration_ms: 100,
        cwd: '/home',
        privacy_redacted: false,
        result: null,
        errors: [],
      });
      await w1.close();

      // Re-open and append a second entry
      const w2 = new HistoryWriter(filePath);
      const s2 = await w2.open();
      expect(s2).toBeGreaterThan(0); // existing file is not empty
      await w2.append({
        record_type: 'entry',
        ts: new Date().toISOString(),
        argv: ['restore'],
        command: 'restore',
        exit_code: 0,
        duration_ms: 50,
        cwd: '/home',
        privacy_redacted: false,
        result: null,
        errors: [],
      });
      await w2.close();

      const raw = await readFile(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(3); // header + 2 entries
      const records = lines.map((l) => JSON.parse(l));
      expect(records[0].record_type).toBe('header');
      expect(records[1].command).toBe('ghost');
      expect(records[2].command).toBe('restore');
    });

    it('open() is idempotent (second call returns size, no fd leak)', async () => {
      const dir = await makeTmp();
      const filePath = path.join(dir, 'test.jsonl');
      const writer = new HistoryWriter(filePath);
      const s1 = await writer.open();
      expect(s1).toBe(0); // fresh file
      // Second open must return the same size without leaking a second handle.
      const s2 = await writer.open();
      expect(s2).toBe(0);
      // Write after double-open must still work (only one handle in use).
      await writer.append({
        record_type: 'header',
        history_version: 1,
        ccaudit_version: '1.0.0',
        created_at: new Date().toISOString(),
        host_os: 'darwin',
        node_version: 'v22.0.0',
      });
      await writer.close();
      const raw = await readFile(filePath, 'utf8');
      expect(raw.trim().length).toBeGreaterThan(0);
    });

    it('close() is idempotent (safe to call multiple times)', async () => {
      const dir = await makeTmp();
      const filePath = path.join(dir, 'test.jsonl');
      const writer = new HistoryWriter(filePath);
      await writer.open();
      await writer.close();
      await expect(writer.close()).resolves.toBeUndefined();
    });

    it('fsync per write: data readable before close()', async () => {
      const dir = await makeTmp();
      const filePath = path.join(dir, 'test.jsonl');
      const writer = new HistoryWriter(filePath);
      await writer.open();
      await writer.append({
        record_type: 'header',
        history_version: 1,
        ccaudit_version: '1.0.0',
        created_at: new Date().toISOString(),
        host_os: 'darwin',
        node_version: 'v22.0.0',
      });
      // Read BEFORE close — fsync guarantees data on disk
      const raw = await readFile(filePath, 'utf8');
      expect(raw.trim().length).toBeGreaterThan(0);
      await writer.close();
    });
  });
}
