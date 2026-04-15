import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { InventoryItem } from '../scanner/types.ts';
import type { TokenCostResult } from '../token/types.ts';

// -- Checkpoint schema (D-17) ------------------------------------

export interface Checkpoint {
  checkpoint_version: 1;
  ccaudit_version: string;
  timestamp: string;
  since_window: string;
  ghost_hash: string;
  item_count: {
    agents: number;
    skills: number;
    mcp: number;
    memory: number;
  };
  savings: {
    tokens: number;
  };
  total_overhead: number; // total ghost token overhead before bust
  /**
   * MCP regime resolved at dry-run time.
   * Pinned so bust uses the same regime value, eliminating Before/After drift.
   * Optional for backward compat — old checkpoints without this field default to 'unknown'.
   */
  mcp_regime?: 'eager' | 'deferred' | 'unknown';
  /**
   * Claude Code version detected at dry-run time (null if undetectable).
   * Stored alongside mcp_regime so the provenance is fully reproducible.
   * Optional for backward compat — old checkpoints without this field default to null.
   */
  cc_version?: string | null;
}

// -- Internal canonical hash record types (not exported) ---------

interface AgentSkillHashRecord {
  category: 'agent' | 'skill';
  scope: 'global' | 'project';
  projectPath: string | null;
  path: string;
  mtimeMs: number;
}
interface McpHashRecord {
  category: 'mcp-server';
  scope: 'global' | 'project';
  projectPath: string | null;
  serverName: string;
  sourcePath: string;
  configMtimeMs: number;
}
interface MemoryHashRecord {
  category: 'memory';
  scope: 'global' | 'project';
  path: string;
  mtimeMs: number;
}
type HashRecord = AgentSkillHashRecord | McpHashRecord | MemoryHashRecord;

// -- Canonical item identifier (Plan 01 extraction) ---------------

/**
 * Canonical item identifier — the single source of truth for how an
 * InventoryItem is keyed inside computeGhostHash AND inside any
 * subset-selection Set<string>. This identifier is intentionally
 * INDEPENDENT of mtimeMs (mtime tracks "this version"; the id tracks
 * "this item"). Plan 02's selectedItems filter and Phase 2's TUI
 * picker both consume this function so their ids are identical to
 * the hash's internal keys.
 *
 * Format is an opaque internal contract; callers must NEVER parse it.
 * Stability guarantee: the byte sequence computeGhostHash produces
 * for any given inventory is frozen by __fixtures__/ghost-hash-golden.json.
 */
export function canonicalItemId(item: InventoryItem): string {
  switch (item.category) {
    case 'mcp-server':
      return `mcp-server|${item.scope}|${item.projectPath ?? ''}|${item.name}|${item.path}`;
    case 'memory':
      return `memory|${item.scope}|${item.path}`;
    default:
      // agent | skill | command | hook
      return `${item.category}|${item.scope}|${item.projectPath ?? ''}|${item.path}`;
  }
}

// -- Hash computation (D-10 through D-16) ------------------------

/**
 * Stat function signature used by computeGhostHash. Default is node:fs/promises
 * `stat`; tests may pass an injected implementation to verify the per-sourcePath
 * cache (D-14) since vi.spyOn cannot intercept built-in ESM module exports.
 */
export type StatFn = (p: string) => Promise<{ mtimeMs: number }>;

/**
 * Compute the deterministic SHA-256 hash of the archive-eligible inventory.
 *
 * Steps (D-12):
 *  1. Filter `enriched` to the exact set Phase 8 would mutate (D-10, D-11a)
 *  2. For each eligible item, stat() its file to fetch mtimeMs (D-13)
 *  3. For MCP items, stat() the sourcePath once per unique path, cache in Map (D-14)
 *  4. Build canonical records with stable key order (D-11)
 *  5. Sort records by (category, scope, projectPath??'', path||serverName)
 *     using String.localeCompare with 'en-US-POSIX' locale (D-12)
 *  6. JSON.stringify the sorted array (single line, default spacing)
 *  7. sha256 the UTF-8 bytes of the JSON string
 *  8. Return "sha256:" + hexDigest (D-12 literal prefix)
 *
 * Note on path separators (RESEARCH.md Cross-Platform Concerns):
 * The hash includes absolute paths, so the digest differs across OSes
 * (Linux uses '/', Windows uses '\'). This is INTENTIONAL -- a checkpoint
 * is machine-local, not portable, and ~/.claude/ccaudit/.last-dry-run is
 * itself machine-local.
 *
 * @param enriched  Enriched scan results from enrichScanResults()
 * @param statFn    Optional stat function injection (test-only; defaults to
 *                  node:fs/promises stat). Production callers pass one argument.
 */
export async function computeGhostHash(
  enriched: TokenCostResult[],
  statFn: StatFn = stat,
): Promise<string> {
  // Step 1: filter to archive-eligible set (D-10, D-11a)
  const eligible = enriched.filter((r) => {
    if (r.item.category === 'agent' || r.item.category === 'skill') {
      return r.tier === 'definite-ghost';
    }
    if (r.item.category === 'mcp-server') {
      return r.tier !== 'used'; // D-11a: widened to include likely-ghost
    }
    if (r.item.category === 'memory') {
      return r.tier !== 'used';
    }
    return false;
  });

  // Step 2-3: stat batch with per-sourcePath cache for MCP (D-14).
  // Cache stores Promises (not resolved values) so concurrent requests for
  // the same sourcePath share a single underlying stat() call. Caching raw
  // numbers would race-fail under Promise.all because all mcp records check
  // the empty map synchronously before any stat completes.
  const mcpConfigMtimeCache = new Map<string, Promise<number>>();
  const maybeRecords: (HashRecord | null)[] = await Promise.all(
    eligible.map(async (r): Promise<HashRecord | null> => {
      try {
        if (r.item.category === 'mcp-server') {
          let configMtimePromise = mcpConfigMtimeCache.get(r.item.path);
          if (configMtimePromise === undefined) {
            configMtimePromise = statFn(r.item.path).then((s) => s.mtimeMs);
            mcpConfigMtimeCache.set(r.item.path, configMtimePromise);
          }
          const configMtimeMs = await configMtimePromise;
          return {
            category: 'mcp-server',
            scope: r.item.scope,
            projectPath: r.item.projectPath,
            serverName: r.item.name,
            sourcePath: r.item.path,
            configMtimeMs,
          };
        }
        if (r.item.category === 'memory') {
          // Memory scanner populates mtimeMs (scan-memory.ts); fallback for safety.
          const mtimeMs = r.item.mtimeMs ?? (await statFn(r.item.path)).mtimeMs;
          return {
            category: 'memory',
            scope: r.item.scope,
            path: r.item.path,
            mtimeMs,
          };
        }
        // Agent / skill: scanners now populate mtimeMs (Phase 7 gap fix 07-04).
        // Fallback retained as a defensive safety net for any future regression.
        const mtimeMs = r.item.mtimeMs ?? (await statFn(r.item.path)).mtimeMs;
        return {
          category: r.item.category as 'agent' | 'skill',
          scope: r.item.scope,
          projectPath: r.item.projectPath,
          path: r.item.path,
          mtimeMs,
        };
      } catch {
        // Path cannot be stat'd (broken symlink, deleted file, EACCES, ELOOP, ENOTDIR).
        // Consistent with frozen D-17 contract "items enter/leave eligible set":
        // an un-stat-able item effectively leaves the set.
        return null;
      }
    }),
  );
  const records: HashRecord[] = maybeRecords.filter((r): r is HashRecord => r !== null);

  // Step 5: deterministic sort with stable POSIX locale (D-12)
  records.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category, 'en-US-POSIX');
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope, 'en-US-POSIX');
    const ap = ('projectPath' in a ? a.projectPath : null) ?? '';
    const bp = ('projectPath' in b ? b.projectPath : null) ?? '';
    if (ap !== bp) return ap.localeCompare(bp, 'en-US-POSIX');
    const akey = 'serverName' in a ? a.serverName : a.path;
    const bkey = 'serverName' in b ? b.serverName : b.path;
    return akey.localeCompare(bkey, 'en-US-POSIX');
  });

  // Step 4 (stable key order) + Step 6: canonicalize each record.
  // Construct literals in fixed key order so JSON.stringify emits keys
  // in insertion order (ES2015+ guaranteed for string keys).
  const canonicalArray = records.map((r) => {
    if (r.category === 'mcp-server') {
      return {
        category: r.category,
        scope: r.scope,
        projectPath: r.projectPath,
        serverName: r.serverName,
        sourcePath: r.sourcePath,
        configMtimeMs: r.configMtimeMs,
      };
    }
    if (r.category === 'memory') {
      return {
        category: r.category,
        scope: r.scope,
        path: r.path,
        mtimeMs: r.mtimeMs,
      };
    }
    return {
      category: r.category,
      scope: r.scope,
      projectPath: r.projectPath,
      path: r.path,
      mtimeMs: r.mtimeMs,
    };
  });
  const canonicalJson = JSON.stringify(canonicalArray);

  // Step 7-8: hash and prefix
  const hexDigest = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return `sha256:${hexDigest}`;
}

// -- Checkpoint path resolution (D-18) ---------------------------

/**
 * Resolve the canonical checkpoint file path (D-18).
 * Always ~/.claude/ccaudit/.last-dry-run -- no XDG fallback (explicitly rejected).
 */
export function resolveCheckpointPath(): string {
  return path.join(homedir(), '.claude', 'ccaudit', '.last-dry-run');
}

// -- Atomic checkpoint write (D-19, D-20) ------------------------

/**
 * Write the checkpoint atomically (D-19).
 *
 * @param checkpoint  - Fully-populated Checkpoint object (D-17 schema)
 * @param targetPath  - Final file path. Accepts an explicit path for test injection;
 *                      production callers pass resolveCheckpointPath().
 *
 * Semantics:
 * - Ensures parent dir exists with mode 0o700 (rwx for owner only)
 * - Writes to a .tmp-<pid> sibling file with mode 0o600 (rw for owner only)
 * - Renames onto the final path (atomic on POSIX; overwrite-semantics on Windows)
 * - On any failure, attempts to unlink the tmp file before rethrowing
 *
 * Errors are propagated unchanged -- the dry-run command handler converts
 * them into process.exitCode = 2 per D-20.
 */
export async function writeCheckpoint(checkpoint: Checkpoint, targetPath: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${process.pid}`;

  // D-18: mkdir with mode 0o700, recursive:true. On Windows, mode is a no-op.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(checkpoint, null, 2);

  try {
    // D-18: file mode 0o600 (owner rw only). Best-effort on Windows.
    await writeFile(tmpPath, body, { mode: 0o600, encoding: 'utf8' });
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file (ignore unlink errors)
    try {
      await unlink(tmpPath);
    } catch {
      /* swallow */
    }
    throw err;
  }
}

// -- Checkpoint read API (for Phase 8 consumption) ---------------

export type ReadCheckpointResult =
  | { status: 'ok'; checkpoint: Checkpoint }
  | { status: 'missing' }
  | { status: 'parse-error'; message: string }
  | { status: 'unknown-version'; version: number }
  | { status: 'schema-mismatch'; missingField: string };

/**
 * Read and validate the checkpoint file.
 *
 * @param targetPath  - File path to read. Accepts an explicit path for test injection;
 *                      production callers pass resolveCheckpointPath().
 *
 * Returns a discriminated result. Never throws for the expected paths
 * (missing / parse-error / unknown-version / schema-mismatch).
 *
 * Unexpected I/O errors (permission denied, etc.) are propagated.
 */
export async function readCheckpoint(targetPath: string): Promise<ReadCheckpointResult> {
  let raw: string;
  try {
    raw = await readFile(targetPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'parse-error', message: (err as Error).message };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('checkpoint_version' in parsed) ||
    (parsed as { checkpoint_version: unknown }).checkpoint_version !== 1
  ) {
    const version = (parsed as { checkpoint_version?: number } | null)?.checkpoint_version ?? -1;
    return { status: 'unknown-version', version };
  }

  const required = [
    'checkpoint_version',
    'ccaudit_version',
    'timestamp',
    'since_window',
    'ghost_hash',
    'item_count',
    'savings',
  ] as const;
  for (const field of required) {
    if (!(field in (parsed as object))) {
      return { status: 'schema-mismatch', missingField: field };
    }
  }

  // total_overhead is optional for backward compat (old checkpoints omit it); default to 0
  const cp = parsed as Checkpoint;
  if (!('total_overhead' in cp)) {
    (cp as Record<string, unknown>).total_overhead = 0;
  }
  return { status: 'ok', checkpoint: cp };
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const {
    mkdtemp,
    rm,
    writeFile: wf,
    mkdir: mk,
    utimes,
    chmod,
    stat: statFn,
  } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  // -- Factory helper -----------------------------------------------
  function makeResult(opts: {
    category: 'agent' | 'skill' | 'mcp-server' | 'memory';
    tier: 'used' | 'likely-ghost' | 'definite-ghost';
    name?: string;
    path?: string;
    mtimeMs?: number;
    projectPath?: string | null;
  }): TokenCostResult {
    const name = opts.name ?? `${opts.category}-x`;
    return {
      item: {
        name,
        path: opts.path ?? `/synthetic/${name}`,
        scope: opts.projectPath ? 'project' : 'global',
        category: opts.category,
        projectPath: opts.projectPath ?? null,
        mtimeMs: opts.mtimeMs,
      },
      tier: opts.tier,
      lastUsed: null,
      invocationCount: 0,
      tokenEstimate: { tokens: 100, confidence: 'estimated', source: 'test' },
    };
  }

  describe('computeGhostHash', () => {
    // Helper: build a synthetic memory item (memory uses item.mtimeMs, so no stat needed)
    const memoryItem = (name: string, mtime: number) =>
      makeResult({
        category: 'memory',
        tier: 'definite-ghost',
        name,
        path: `/synth/${name}`,
        mtimeMs: mtime,
      });

    it('returns sha256: prefix + 64 hex chars', async () => {
      const hash = await computeGhostHash([memoryItem('a', 1000)]);
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('determinism: same input -> same hash across 10 iterations', async () => {
      const input = [memoryItem('a', 1000), memoryItem('b', 2000), memoryItem('c', 3000)];
      const first = await computeGhostHash(input);
      for (let i = 0; i < 10; i++) {
        expect(await computeGhostHash(input)).toBe(first);
      }
    });

    it('stability: hash is stable under input reordering', async () => {
      const items = [
        memoryItem('a', 1000),
        memoryItem('b', 2000),
        memoryItem('c', 3000),
        memoryItem('d', 4000),
        memoryItem('e', 5000),
      ];
      const h1 = await computeGhostHash(items);
      const h2 = await computeGhostHash([...items].reverse());
      const h3 = await computeGhostHash([...items.slice(2), ...items.slice(0, 2)]);
      expect(h1).toBe(h2);
      expect(h1).toBe(h3);
    });

    it('only includes eligible items -- likely-ghost agents do NOT contribute', async () => {
      // Use memory items as the eligible set (item.mtimeMs is set, no fs.stat needed)
      const eligible = [memoryItem('a', 1000), memoryItem('b', 2000)];
      const h1 = await computeGhostHash(eligible);
      // Adding ineligible items (likely-ghost agent, used items) MUST NOT change the hash
      const h2 = await computeGhostHash([
        ...eligible,
        makeResult({ category: 'agent', tier: 'likely-ghost', name: 'monitor-only' }),
        makeResult({ category: 'agent', tier: 'used', name: 'healthy' }),
        makeResult({ category: 'mcp-server', tier: 'used', name: 'healthy-mcp' }),
        makeResult({ category: 'memory', tier: 'used', name: 'healthy-mem', mtimeMs: 9999 }),
      ]);
      expect(h1).toBe(h2);
    });

    it('likely-ghost agents EXCLUDED from hash (only contribute via agent/skill if definite)', async () => {
      const h1 = await computeGhostHash([]);
      const h2 = await computeGhostHash([
        makeResult({ category: 'agent', tier: 'likely-ghost', name: 'l1' }),
        makeResult({ category: 'skill', tier: 'likely-ghost', name: 'l2' }),
      ]);
      expect(h1).toBe(h2); // both reduce to empty canonical array
    });

    it('hash CHANGES when an agent file mtimeMs bumps (DRYR-03 invalidation)', async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), 'hash-mtime-'));
      try {
        const agentPath = path.join(tmp, 'a.md');
        await wf(agentPath, 'agent body', 'utf8');
        const input = [
          makeResult({ category: 'agent', tier: 'definite-ghost', name: 'a', path: agentPath }),
        ];
        const h1 = await computeGhostHash(input);
        // Bump the mtime by 60 seconds
        const newTime = new Date(Date.now() + 60000);
        await utimes(agentPath, newTime, newTime);
        const h2 = await computeGhostHash(input);
        expect(h1).not.toBe(h2);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it('hash CHANGES when an agent is added to the eligible set', async () => {
      const h1 = await computeGhostHash([memoryItem('a', 1000)]);
      const h2 = await computeGhostHash([memoryItem('a', 1000), memoryItem('b', 2000)]);
      expect(h1).not.toBe(h2);
    });

    it('hash CHANGES when a likely-ghost MCP transitions to used (drops from hash)', async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), 'hash-mcp-'));
      try {
        const cfg = path.join(tmp, '.claude.json');
        await wf(cfg, '{"mcpServers":{}}', 'utf8');
        const likely = makeResult({
          category: 'mcp-server',
          tier: 'likely-ghost',
          name: 'srv1',
          path: cfg,
        });
        const used = makeResult({ category: 'mcp-server', tier: 'used', name: 'srv1', path: cfg });
        const h1 = await computeGhostHash([likely]);
        const h2 = await computeGhostHash([used]);
        expect(h1).not.toBe(h2);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it('MCP configMtimeMs is cached per unique sourcePath (D-14)', async () => {
      // vi.spyOn cannot intercept built-in ESM module exports (node:fs/promises
      // is non-configurable). Use the computeGhostHash statFn injection instead:
      // pass a counting stub and assert call count.
      const calls: string[] = [];
      const countingStat: StatFn = async (p: string) => {
        calls.push(p);
        return { mtimeMs: 12345 };
      };

      const cfgA = '/synth/.claude.json';
      const cfgB = '/synth/project/.mcp.json';
      const input: TokenCostResult[] = [
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm1', path: cfgA }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm2', path: cfgA }),
        makeResult({ category: 'mcp-server', tier: 'likely-ghost', name: 'm3', path: cfgA }),
        makeResult({ category: 'mcp-server', tier: 'definite-ghost', name: 'm4', path: cfgB }),
        makeResult({ category: 'mcp-server', tier: 'likely-ghost', name: 'm5', path: cfgB }),
      ];
      await computeGhostHash(input, countingStat);

      // Exactly 2 stat calls -- one per unique sourcePath -- despite 5 MCP records.
      // This proves the Map<sourcePath, Promise<mtimeMs>> cache deduplicates
      // concurrent requests under Promise.all.
      expect(calls).toHaveLength(2);
      expect(calls.sort()).toEqual([cfgA, cfgB].sort());
    });

    it("should skip items whose path cannot be stat'd (broken symlink, deleted file)", async () => {
      // Real ENOENT path -- no StatFn injection, so the error hits the actual
      // node:fs/promises stat and must be swallowed by the defensive try/catch.
      const tmp = await mkdtemp(path.join(tmpdir(), 'hash-enoent-'));
      try {
        // Valid control agent: backs onto a real file
        const validPath = path.join(tmp, 'valid-agent.md');
        await wf(validPath, 'valid agent body', 'utf8');

        // Un-stat-able path: never existed
        const missingPath = path.join(tmp, 'does-not-exist.md');

        const withMissing = [
          makeResult({
            category: 'agent',
            tier: 'definite-ghost',
            name: 'missing',
            path: missingPath,
          }),
          makeResult({ category: 'agent', tier: 'definite-ghost', name: 'valid', path: validPath }),
        ];
        const hash = await computeGhostHash(withMissing);
        expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);

        // Hash must match the "only valid item" control -- missing item is
        // filtered out exactly as if it were never in the eligible set.
        const controlHash = await computeGhostHash([
          makeResult({ category: 'agent', tier: 'definite-ghost', name: 'valid', path: validPath }),
        ]);
        expect(hash).toBe(controlHash);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  // -- Golden fixture: freeze computeGhostHash output bytes -----------

  describe('computeGhostHash — golden fixture', () => {
    it('Test 1: produces exactly the frozen expectedHash (byte-identical)', async () => {
      const fixtureRaw = await readFile(
        new URL('./__fixtures__/ghost-hash-golden.json', import.meta.url),
        'utf8',
      );
      const fixture = JSON.parse(fixtureRaw) as {
        input: TokenCostResult[];
        expectedHash: string;
      };

      // Injected StatFn: returns fixed mtimeMs for the shared MCP sourcePath
      const MCP_MTIME = 1700000002000;
      const deterministicStat: StatFn = async () => ({ mtimeMs: MCP_MTIME });

      const actual = await computeGhostHash(fixture.input, deterministicStat);
      expect(actual).toBe(fixture.expectedHash);
    });

    it('Test 2 (sanity): mutating any mtime in fixture input changes the hash', async () => {
      const fixtureRaw = await readFile(
        new URL('./__fixtures__/ghost-hash-golden.json', import.meta.url),
        'utf8',
      );
      const fixture = JSON.parse(fixtureRaw) as { input: TokenCostResult[]; expectedHash: string };
      const MCP_MTIME = 1700000002000;
      const deterministicStat: StatFn = async () => ({ mtimeMs: MCP_MTIME });

      // Mutate the memory item's mtimeMs
      const mutated = fixture.input.map((r) => {
        if (r.item.category === 'memory') {
          return { ...r, item: { ...r.item, mtimeMs: 9999999999999 } };
        }
        return r;
      });
      const mutatedHash = await computeGhostHash(mutated, deterministicStat);
      expect(mutatedHash).not.toBe(fixture.expectedHash);
    });

    it('Test 3 (sanity): reordering fixture input items does NOT change the hash', async () => {
      const fixtureRaw = await readFile(
        new URL('./__fixtures__/ghost-hash-golden.json', import.meta.url),
        'utf8',
      );
      const fixture = JSON.parse(fixtureRaw) as { input: TokenCostResult[]; expectedHash: string };
      const MCP_MTIME = 1700000002000;
      const deterministicStat: StatFn = async () => ({ mtimeMs: MCP_MTIME });

      const reversed = [...fixture.input].reverse();
      const reversedHash = await computeGhostHash(reversed, deterministicStat);
      expect(reversedHash).toBe(fixture.expectedHash);
    });
  });

  // -- writeCheckpoint / readCheckpoint tests -----------------------

  describe('resolveCheckpointPath', () => {
    it('returns ~/.claude/ccaudit/.last-dry-run', () => {
      const p = resolveCheckpointPath();
      expect(p).toMatch(/[/\\]\.claude[/\\]ccaudit[/\\]\.last-dry-run$/);
    });
  });

  describe('writeCheckpoint / readCheckpoint', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'checkpoint-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    function sampleCheckpoint(): Checkpoint {
      return {
        checkpoint_version: 1,
        ccaudit_version: '0.0.1',
        timestamp: '2026-04-04T18:30:00.000Z',
        since_window: '7d',
        ghost_hash: 'sha256:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
        item_count: { agents: 128, skills: 82, mcp: 4, memory: 6 },
        savings: { tokens: 94000 },
        total_overhead: 94000,
      };
    }

    it('writeCheckpoint creates parent dir recursively', async () => {
      const target = path.join(tmp, 'nested', 'deep', 'subdir', '.last-dry-run');
      await writeCheckpoint(sampleCheckpoint(), target);
      const s = await statFn(target);
      expect(s.isFile()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'writeCheckpoint writes file with mode 0o600 on Unix',
      async () => {
        const target = path.join(tmp, '.last-dry-run');
        await writeCheckpoint(sampleCheckpoint(), target);
        const s = await statFn(target);
        expect(s.mode & 0o777).toBe(0o600);
      },
    );

    it('writeCheckpoint tmp-rename pattern: crashed write does not corrupt existing checkpoint', async () => {
      const target = path.join(tmp, '.last-dry-run');
      // Write a valid checkpoint first
      const original = sampleCheckpoint();
      await writeCheckpoint(original, target);

      // Now simulate a crash on a second write. We inject a bad checkpoint whose
      // JSON.stringify does not throw -- but we monkey-patch the filesystem by
      // passing a path inside a non-writable parent. Create a read-only dir:
      const roDir = path.join(tmp, 'readonly');
      await mk(roDir, { recursive: true, mode: 0o500 });
      try {
        await writeCheckpoint(sampleCheckpoint(), path.join(roDir, 'fail.json'));
        // On some CI environments running as root, the write may succeed -- in that
        // case, the assertion below is moot; the important property is that the
        // ORIGINAL file is untouched.
      } catch {
        // Expected on non-root environments
      }
      // Original file still intact
      const roundTrip = await readCheckpoint(target);
      expect(roundTrip.status).toBe('ok');
      if (roundTrip.status === 'ok') {
        expect(roundTrip.checkpoint).toEqual(original);
      }
      // Cleanup readonly dir so afterEach rm succeeds
      await chmod(roDir, 0o700);
    });

    it.skipIf(process.platform === 'win32')(
      'writeCheckpoint propagates errors on read-only parent directory',
      async () => {
        const roDir = path.join(tmp, 'ro-parent');
        await mk(roDir, { recursive: true, mode: 0o500 });
        try {
          await expect(
            writeCheckpoint(sampleCheckpoint(), path.join(roDir, 'nested', '.last-dry-run')),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
        } finally {
          await chmod(roDir, 0o700);
        }
      },
    );

    it('round-trip: writeCheckpoint then readCheckpoint returns identical checkpoint', async () => {
      const target = path.join(tmp, '.last-dry-run');
      const cp = sampleCheckpoint();
      await writeCheckpoint(cp, target);
      const result = await readCheckpoint(target);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.checkpoint).toEqual(cp);
      }
    });

    it('written JSON on disk matches D-17 schema exactly (8 top-level fields)', async () => {
      const target = path.join(tmp, '.last-dry-run');
      await writeCheckpoint(sampleCheckpoint(), target);
      const raw = await readFile(target, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        'ccaudit_version',
        'checkpoint_version',
        'ghost_hash',
        'item_count',
        'savings',
        'since_window',
        'timestamp',
        'total_overhead',
      ]);
    });

    it('readCheckpoint returns { status: "missing" } when file does not exist', async () => {
      const result = await readCheckpoint(path.join(tmp, 'does-not-exist'));
      expect(result.status).toBe('missing');
    });

    it('readCheckpoint returns { status: "parse-error", message } on malformed JSON', async () => {
      const target = path.join(tmp, '.last-dry-run');
      await wf(target, '{not json', 'utf8');
      const result = await readCheckpoint(target);
      expect(result.status).toBe('parse-error');
      if (result.status === 'parse-error') {
        expect(typeof result.message).toBe('string');
      }
    });

    it('readCheckpoint returns { status: "unknown-version", version: 2 } for checkpoint_version !== 1', async () => {
      const target = path.join(tmp, '.last-dry-run');
      await wf(
        target,
        JSON.stringify({
          checkpoint_version: 2,
          ccaudit_version: '0.0.1',
          timestamp: 'x',
          since_window: '7d',
          ghost_hash: 'sha256:x',
          item_count: {},
          savings: {},
        }),
        'utf8',
      );
      const result = await readCheckpoint(target);
      expect(result.status).toBe('unknown-version');
      if (result.status === 'unknown-version') {
        expect(result.version).toBe(2);
      }
    });

    it('readCheckpoint returns { status: "schema-mismatch", missingField } for missing required fields', async () => {
      const target = path.join(tmp, '.last-dry-run');
      await wf(target, JSON.stringify({ checkpoint_version: 1 }), 'utf8');
      const result = await readCheckpoint(target);
      expect(result.status).toBe('schema-mismatch');
      if (result.status === 'schema-mismatch') {
        expect([
          'ccaudit_version',
          'timestamp',
          'since_window',
          'ghost_hash',
          'item_count',
          'savings',
        ]).toContain(result.missingField);
      }
    });
  });

  describe('canonicalItemId', () => {
    function makeItem(
      overrides: Partial<InventoryItem> & { category: InventoryItem['category'] },
    ): InventoryItem {
      return {
        name: 'test-item',
        path: '/synthetic/path/item.md',
        scope: 'global',
        projectPath: null,
        ...overrides,
      };
    }

    it('Test 1: returns a deterministic string — same result across 10 calls on the same item', () => {
      const item = makeItem({ category: 'agent' });
      const first = canonicalItemId(item);
      for (let i = 0; i < 10; i++) {
        expect(canonicalItemId(item)).toBe(first);
      }
      expect(typeof first).toBe('string');
      expect(first.length).toBeGreaterThan(0);
    });

    it('Test 2: is independent of item.mtimeMs — two items differing only in mtimeMs produce the same id', () => {
      const base = makeItem({ category: 'agent', mtimeMs: 1000000 });
      const bumped = makeItem({ category: 'agent', mtimeMs: 9999999 });
      expect(canonicalItemId(base)).toBe(canonicalItemId(bumped));
    });

    it('Test 3: differs across category even when other fields are identical', () => {
      const sharedProps = {
        name: 'x',
        path: '/synth/x',
        scope: 'global' as const,
        projectPath: null,
      };
      const agent = canonicalItemId(makeItem({ category: 'agent', ...sharedProps }));
      const skill = canonicalItemId(makeItem({ category: 'skill', ...sharedProps }));
      const memory = canonicalItemId(makeItem({ category: 'memory', ...sharedProps }));
      expect(agent).not.toBe(skill);
      expect(agent).not.toBe(memory);
      expect(skill).not.toBe(memory);
    });

    it('Test 4: differs across scope even with same name/path', () => {
      const globalItem = makeItem({ category: 'agent', scope: 'global', projectPath: null });
      const projectItem = makeItem({
        category: 'agent',
        scope: 'project',
        projectPath: '/some/project',
      });
      expect(canonicalItemId(globalItem)).not.toBe(canonicalItemId(projectItem));
    });

    it('mcp-server id includes name (serverName) and path (sourcePath)', () => {
      const mcp1 = makeItem({
        category: 'mcp-server',
        name: 'server-a',
        path: '/synth/.claude.json',
        scope: 'global',
        projectPath: null,
      });
      const mcp2 = makeItem({
        category: 'mcp-server',
        name: 'server-b',
        path: '/synth/.claude.json',
        scope: 'global',
        projectPath: null,
      });
      // Same sourcePath, different names => different ids
      expect(canonicalItemId(mcp1)).not.toBe(canonicalItemId(mcp2));
    });
  });
}
