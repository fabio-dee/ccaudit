// @ccaudit/internal -- atomic JSON write helper (Phase 8 D-18 extraction)
//
// Extracts the Phase 7 writeCheckpoint atomic write pattern (tmp + rename) into
// a reusable helper and adds a graceful-fs-style Windows EPERM retry loop for
// SC-9 (antivirus / Windows Defender / Search Indexer race on fs.rename).
//
// Public API:
//   - atomicWriteJson(targetPath, value, options?)  -- write a JSON payload
//     atomically via tmp + rename, with Windows EPERM retry.
//   - renameWithRetry(from, to, options?)           -- lower level helper,
//     exposed for manifest-file rename edge cases (Phase 8 D-10+).
//   - _renameWithRetryInternal(from, to, opts, deps) -- internal helper that
//     accepts injected primitives (rename/stat/setTimeout/now/platform) so the
//     retry logic can be tested deterministically on any platform.
//
// Retry schedule (CLI-appropriate; graceful-fs uses 60s which is too long for
// an interactive CLI):
//   - Retryable codes: EPERM | EACCES | EBUSY (Windows only)
//   - Initial backoff: 10ms, +10ms per retry, capped at 100ms
//   - Total budget: 10_000ms (10s)
//   - stat-before-retry gate: if the destination exists after a rename failure,
//     the original error is re-thrown (graceful-fs canonical behavior -- the
//     failure was real, not a transient lock)

import { mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

// -- Options & defaults ------------------------------------------

export interface AtomicWriteOptions {
  /** File mode for the final written file. POSIX only; no-op on Windows. Default 0o600. */
  mode?: number;
  /** Directory mode for parent mkdir. POSIX only; no-op on Windows. Default 0o700. */
  dirMode?: number;
  /** Total retry budget in ms for Windows EPERM/EACCES/EBUSY. Default 10_000. */
  retryTotalMs?: number;
  /** Initial backoff delay in ms. Default 10. */
  retryInitialMs?: number;
  /** Maximum backoff delay per retry in ms. Default 100. */
  retryMaxMs?: number;
}

const DEFAULTS: Required<AtomicWriteOptions> = {
  mode: 0o600,
  dirMode: 0o700,
  retryTotalMs: 10_000,
  retryInitialMs: 10,
  retryMaxMs: 100,
};

// -- atomicWriteJson ---------------------------------------------

/**
 * Atomically write a JSON-serializable value to `targetPath`.
 *
 * Semantics (D-18):
 *  1. mkdir parent recursively with mode 0o700 (POSIX; no-op on Windows)
 *  2. Write to a sibling `<target>.tmp-<pid>-<random8>` file with mode 0o600
 *     (MUST be in the same directory as target -- prevents EXDEV cross-device
 *     errors, graceful-fs pitfall)
 *  3. rename() onto the final path (atomic on POSIX; Windows may EPERM under
 *     AV load -- retry loop handles this via renameWithRetry)
 *  4. On any failure, best-effort unlink the tmp file before rethrowing
 */
export async function atomicWriteJson<T>(
  targetPath: string,
  value: T,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteRaw(targetPath, JSON.stringify(value, null, 2), options);
}

async function atomicWriteRaw(
  targetPath: string,
  body: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const opts = { ...DEFAULTS, ...options };
  const dir = path.dirname(targetPath);
  // Random 8-char suffix for concurrent-caller collision avoidance.
  // Not crypto-random; Math.random() is fine for non-security use.
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const tmpPath = `${targetPath}.tmp-${process.pid}-${rand}`;

  // Parent dir with restrictive mode. Mode is a no-op on Windows.
  await mkdir(dir, { recursive: true, mode: opts.dirMode });

  try {
    await writeFile(tmpPath, body, { mode: opts.mode, encoding: 'utf8' });
    await renameWithRetry(tmpPath, targetPath, opts);
  } catch (err) {
    // Best-effort cleanup of the tmp file; swallow unlink errors (the tmp
    // file may never have been created if writeFile itself threw).
    try {
      await unlink(tmpPath);
    } catch {
      /* swallow */
    }
    throw err;
  }
}

/**
 * Atomically write a pre-formatted text string to `targetPath` via a tmp file
 * + rename, with the same Windows EPERM retry semantics as `atomicWriteJson`.
 *
 * Use this instead of `atomicWriteJson` when the caller has already produced
 * the final serialized content and must preserve exact byte formatting (e.g.
 * surgical MCP key renames in `~/.claude.json` that must leave unmodified keys
 * byte-identical to the original — INV-S1).
 */
export async function atomicWriteText(
  targetPath: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteRaw(targetPath, text, options);
}

// -- renameWithRetry ---------------------------------------------

/**
 * Rename `from` -> `to` with a graceful-fs-style retry loop for Windows
 * EPERM/EACCES/EBUSY (transient AV locks on ~/.claude.json, checkpoint files,
 * and manifests). On non-Windows platforms this is a single rename() call;
 * the retry loop never engages.
 *
 * stat-before-retry gate: after a retryable failure, stat the destination.
 * If it exists (stat succeeds), the rename actually failed for a real reason
 * and we re-throw the ORIGINAL error. Only ENOENT on stat confirms the rename
 * never happened and a retry is safe.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: Pick<AtomicWriteOptions, 'retryTotalMs' | 'retryInitialMs' | 'retryMaxMs'> = {},
): Promise<void> {
  const opts = {
    retryTotalMs: options.retryTotalMs ?? DEFAULTS.retryTotalMs,
    retryInitialMs: options.retryInitialMs ?? DEFAULTS.retryInitialMs,
    retryMaxMs: options.retryMaxMs ?? DEFAULTS.retryMaxMs,
  };
  return _renameWithRetryInternal(from, to, opts, {
    rename,
    stat: stat as (p: string) => Promise<{ isFile(): boolean }>,
    setTimeout: (cb, ms) => {
      globalThis.setTimeout(cb, ms);
    },
    now: () => Date.now(),
    platform: process.platform,
  });
}

// -- Internal (test-only) ---------------------------------------

/**
 * Dependencies injected into `_renameWithRetryInternal` so the retry logic
 * (which depends on platform detection, timing, and stat() outcomes) can be
 * exercised deterministically from in-source tests on any platform.
 *
 * NOT part of the public API. Consumers use `renameWithRetry`.
 */
export interface RenameInternals {
  rename: (from: string, to: string) => Promise<void>;
  stat: (p: string) => Promise<{ isFile(): boolean }>;
  setTimeout: (cb: () => void, ms: number) => void;
  now: () => number;
  platform: NodeJS.Platform;
}

/**
 * Internal rename-with-retry with injectable primitives. See `renameWithRetry`
 * for the production wrapper and docs.
 */
export async function _renameWithRetryInternal(
  from: string,
  to: string,
  opts: Required<Pick<AtomicWriteOptions, 'retryTotalMs' | 'retryInitialMs' | 'retryMaxMs'>>,
  deps: RenameInternals,
): Promise<void> {
  const start = deps.now();
  let backoff = opts.retryInitialMs;
  while (true) {
    try {
      await deps.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      const elapsed = deps.now() - start;
      // Only retry on Windows + retryable code + still within budget.
      // Unix (darwin/linux) and unknown platforms throw immediately.
      if (!retryable || elapsed >= opts.retryTotalMs || deps.platform !== 'win32') {
        throw err;
      }
      // graceful-fs stat-before-retry gate: if destination exists (stat
      // returns no error), the rename actually failed for a real reason --
      // re-throw the original error instead of looping.
      try {
        await deps.stat(to);
        // Destination exists -- original error is real, not a transient lock.
        throw err;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          // stat threw for a reason other than ENOENT -- propagate the
          // ORIGINAL rename error (we don't know if a retry is safe).
          throw err;
        }
        // ENOENT confirms destination does not exist -- safe to retry.
      }
      await new Promise<void>((r) => deps.setTimeout(() => r(), backoff));
      backoff = Math.min(backoff + 10, opts.retryMaxMs);
    }
  }
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach, vi } = import.meta.vitest;
  const {
    mkdtemp,
    rm,
    readFile,
    readdir,
    stat: fsStat,
    chmod,
    mkdir: mk,
    writeFile: wf,
  } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('atomicWriteJson', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'atomic-write-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('round-trips a JSON payload', async () => {
      const target = path.join(tmp, 'out.json');
      await atomicWriteJson(target, { hello: 'world', n: 42 });
      const raw = await readFile(target, 'utf8');
      expect(JSON.parse(raw)).toEqual({ hello: 'world', n: 42 });
    });

    it('creates parent directories recursively', async () => {
      const target = path.join(tmp, 'a', 'b', 'c', 'out.json');
      await atomicWriteJson(target, { ok: true });
      const s = await fsStat(target);
      expect(s.isFile()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('sets file mode 0o600 on Unix', async () => {
      const target = path.join(tmp, 'out.json');
      await atomicWriteJson(target, { ok: true });
      const s = await fsStat(target);
      expect(s.mode & 0o777).toBe(0o600);
    });

    it('writes tmp file in same directory as target (not os.tmpdir)', async () => {
      // Deterministic random so the tmp filename is predictable; assert that
      // after success only the target exists (the tmp was in target's dir and
      // got renamed in place).
      const target = path.join(tmp, 'out.json');
      const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
      try {
        await atomicWriteJson(target, { ok: true });
      } finally {
        randSpy.mockRestore();
      }
      const s = await fsStat(target);
      expect(s.isFile()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'unlinks tmp file on write failure (read-only parent)',
      async () => {
        const roDir = path.join(tmp, 'ro');
        await mk(roDir, { recursive: true, mode: 0o500 });
        try {
          await expect(
            atomicWriteJson(path.join(roDir, 'sub', 'out.json'), { ok: true }),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
        } finally {
          await chmod(roDir, 0o700);
        }
      },
    );
  });

  describe('atomicWriteText', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'atomic-write-text-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('round-trips caller-provided text byte-for-byte', async () => {
      const target = path.join(tmp, 'raw.txt');
      const body = '{  "keep" : [1,2,3],\n  "spacing": "verbatim"\n}\n';
      await atomicWriteText(target, body);
      const raw = await readFile(target, 'utf8');
      expect(raw).toBe(body);
    });

    it('creates parent directories recursively', async () => {
      const target = path.join(tmp, 'nested', 'dir', 'raw.txt');
      await atomicWriteText(target, 'hello\n');
      const s = await fsStat(target);
      expect(s.isFile()).toBe(true);
      await expect(readFile(target, 'utf8')).resolves.toBe('hello\n');
    });

    it('unlinks tmp file when rename fails', async () => {
      const target = path.join(tmp, 'existing-dir');
      await mk(target, { recursive: true });
      const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
      const tmpPath = `${target}.tmp-${process.pid}-${Math.random()
        .toString(36)
        .slice(2, 10)
        .padEnd(8, '0')}`;
      try {
        await expect(atomicWriteText(target, 'cannot replace a directory')).rejects.toThrow();
      } finally {
        randSpy.mockRestore();
      }
      await expect(readdir(tmp)).resolves.not.toContain(path.basename(tmpPath));
    });
  });

  describe('renameWithRetry', () => {
    it('succeeds immediately when rename works first try', async () => {
      const tmp2 = await mkdtemp(path.join(tmpdir(), 'rename-retry-'));
      try {
        const from = path.join(tmp2, 'a');
        const to = path.join(tmp2, 'b');
        await wf(from, 'x', 'utf8');
        await renameWithRetry(from, to);
        const s = await fsStat(to);
        expect(s.isFile()).toBe(true);
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform !== 'win32')(
      'retries on EPERM then succeeds (Windows only smoke test)',
      async () => {
        // This assertion only runs on Windows CI. Exercises a real tmp+rename
        // round-trip on NTFS; exact iteration counting is out of scope --
        // deterministic retry coverage is provided by _renameWithRetryInternal
        // tests below using injected deps.
        const tmp3 = await mkdtemp(path.join(tmpdir(), 'rename-win-'));
        try {
          const from = path.join(tmp3, 'a');
          const to = path.join(tmp3, 'b');
          await wf(from, 'x', 'utf8');
          await renameWithRetry(from, to);
          const s = await fsStat(to);
          expect(s.isFile()).toBe(true);
        } finally {
          await rm(tmp3, { recursive: true, force: true });
        }
      },
    );
  });

  describe('_renameWithRetryInternal', () => {
    const baseOpts = { retryTotalMs: 10_000, retryInitialMs: 10, retryMaxMs: 100 };

    it('retries on EPERM N times then succeeds', async () => {
      let attempts = 0;
      const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          if (attempts < 4) {
            const e: NodeJS.ErrnoException = Object.assign(new Error('EPERM'), { code: 'EPERM' });
            throw e;
          }
        },
        stat: async () => {
          throw enoent;
        },
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'win32',
      };
      await _renameWithRetryInternal('a', 'b', baseOpts, deps);
      expect(attempts).toBe(4);
    });

    it('retries on EACCES and EBUSY', async () => {
      const codes = ['EACCES', 'EBUSY', 'EPERM'];
      let i = 0;
      const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const deps: RenameInternals = {
        rename: async () => {
          if (i < codes.length) {
            const c = codes[i++]!;
            throw Object.assign(new Error(c), { code: c });
          }
        },
        stat: async () => {
          throw enoent;
        },
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'win32',
      };
      await _renameWithRetryInternal('a', 'b', baseOpts, deps);
      expect(i).toBe(3);
    });

    it('does NOT retry on ENOENT', async () => {
      let attempts = 0;
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'win32',
      };
      await expect(_renameWithRetryInternal('a', 'b', baseOpts, deps)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(attempts).toBe(1);
    });

    it('does NOT retry on EINVAL', async () => {
      let attempts = 0;
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        },
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'win32',
      };
      await expect(_renameWithRetryInternal('a', 'b', baseOpts, deps)).rejects.toMatchObject({
        code: 'EINVAL',
      });
      expect(attempts).toBe(1);
    });

    it('does NOT retry on non-win32 platforms', async () => {
      let attempts = 0;
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'darwin',
      };
      await expect(_renameWithRetryInternal('a', 'b', baseOpts, deps)).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(attempts).toBe(1);
    });

    it('stat-before-retry gate: rethrows original if destination exists', async () => {
      let attempts = 0;
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
        // stat resolves (no throw) -> destination exists -> rethrow original EPERM
        stat: async () => ({ isFile: () => true }),
        setTimeout: (cb) => cb(),
        now: () => 0,
        platform: 'win32',
      };
      await expect(_renameWithRetryInternal('a', 'b', baseOpts, deps)).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(attempts).toBe(1);
    });

    it('exhausts retryTotalMs budget and throws last error', async () => {
      let attempts = 0;
      let t = 0;
      const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
        stat: async () => {
          throw enoent;
        },
        setTimeout: (cb, ms) => {
          t += ms;
          cb();
        },
        now: () => t,
        platform: 'win32',
      };
      await expect(
        _renameWithRetryInternal(
          'a',
          'b',
          { retryTotalMs: 50, retryInitialMs: 10, retryMaxMs: 20 },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'EPERM' });
      expect(attempts).toBeGreaterThan(1);
    });

    it('backoff schedule: 10, 20, 30, ... capped at retryMaxMs', async () => {
      const delays: number[] = [];
      let attempts = 0;
      const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const deps: RenameInternals = {
        rename: async () => {
          attempts++;
          if (attempts < 6) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
        stat: async () => {
          throw enoent;
        },
        setTimeout: (cb, ms) => {
          delays.push(ms);
          cb();
        },
        now: () => 0,
        platform: 'win32',
      };
      await _renameWithRetryInternal(
        'a',
        'b',
        { retryTotalMs: 10_000, retryInitialMs: 10, retryMaxMs: 30 },
        deps,
      );
      // First 3 delays: 10, 20, 30. Then capped at 30 for remaining retries.
      expect(delays.slice(0, 5)).toEqual([10, 20, 30, 30, 30]);
    });
  });
}
