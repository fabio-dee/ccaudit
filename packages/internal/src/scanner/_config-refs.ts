/**
 * Pure helpers for grouping MCP server occurrences across config files
 * (Phase 6, D6-02 / D6-17 / D6-19) and for querying framework-as-unit
 * protection on a canonical inventory item (D6-01).
 *
 * Deliberately free of `fs`, `os`, and any non-stdlib import: callers
 * render `configPath` via `presentPath` BEFORE handing servers here so
 * the bucketing rule is purely textual.
 */

/**
 * Minimal shape the grouping helper needs from a scanned MCP server.
 * Additional fields on the actual scanner record are ignored (structural
 * typing).
 */
export interface ScannedMcpServer {
  /** The MCP server key (post canonical-ID normalization). */
  key: string;
  /** Rendered config path (output of `presentPath`). */
  configPath: string;
}

/**
 * Group scanned MCP servers by key, producing the ordered list of config
 * files that reference each key.
 *
 * Contract (D6-02):
 *   - Every key that appears in the input gets an entry in the returned Map.
 *   - `string[]` length is always >= 1 (no empty arrays, never undefined).
 *   - Duplicate (key, configPath) pairs dedupe via Set semantics.
 *   - Sort order per `compareConfigRef`: project-local → ~user → system.
 *
 * @param servers Scanned MCP servers (one per (key, config) occurrence).
 * @returns Map from key to ordered, deduplicated configPath list.
 */
export function computeConfigRefs(servers: ReadonlyArray<ScannedMcpServer>): Map<string, string[]> {
  // Collect dedup sets per key, preserving first-seen order within each bucket.
  const sets = new Map<string, Set<string>>();
  for (const s of servers) {
    const existing = sets.get(s.key);
    if (existing) {
      existing.add(s.configPath);
    } else {
      sets.set(s.key, new Set<string>([s.configPath]));
    }
  }

  const out = new Map<string, string[]>();
  for (const [key, set] of sets) {
    // Array.prototype.sort is stable on Node 20+ → first-seen order is
    // preserved within each bucket.
    out.set(key, [...set].sort(compareConfigRef));
  }
  return out;
}

/**
 * Stable sort comparator for rendered config paths (D6-19).
 *
 * Bucket 0 — project-local: does not start with `~/` and does not start with `/`.
 * Bucket 1 — user-scope:    starts with `~/`.
 * Bucket 2 — system:        starts with `/` (absolute non-home; home was
 *                           already compressed to `~/` upstream via presentPath).
 *
 * Within a bucket, the comparator returns 0 so the caller's Array.prototype.sort
 * (stable on Node 20+) preserves input order.
 */
export function compareConfigRef(a: string, b: string): number {
  return bucketOf(a) - bucketOf(b);
}

function bucketOf(p: string): number {
  if (p.startsWith('~/')) return 1;
  // POSIX absolute (`/etc/...`) or Windows drive-letter absolute (`C:/Users/...`)
  // — the latter shape comes through after presentPath normalizes backslashes.
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) return 2;
  return 0;
}

/**
 * Advisory predicate: true iff the item carries a Phase 6 `protection`
 * object (D6-01). Server-side INV-S6 enforcement in `runBust` remains the
 * actual gate — this helper is for the picker row render / toggle guard.
 */
export function isProtected(item: { protection?: unknown }): boolean {
  return item.protection !== undefined;
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('computeConfigRefs', () => {
    it('yields [path] for a single-key single-ref input (no tri-state)', () => {
      const result = computeConfigRefs([{ key: 'foo', configPath: '.mcp.json' }]);
      expect(result.get('foo')).toEqual(['.mcp.json']);
      expect(result.size).toBe(1);
    });

    it('orders project-local before user-scope for the same key', () => {
      const result = computeConfigRefs([
        { key: 'foo', configPath: '~/.claude/settings.json' },
        { key: 'foo', configPath: '.mcp.json' },
      ]);
      expect(result.get('foo')).toEqual(['.mcp.json', '~/.claude/settings.json']);
    });

    it('isolates keys from each other', () => {
      const result = computeConfigRefs([
        { key: 'foo', configPath: '.mcp.json' },
        { key: 'foo', configPath: '~/.claude/settings.json' },
        { key: 'bar', configPath: '.mcp.json' },
      ]);
      expect(result.get('foo')).toEqual(['.mcp.json', '~/.claude/settings.json']);
      expect(result.get('bar')).toEqual(['.mcp.json']);
    });

    it('deduplicates repeated (key, configPath) pairs', () => {
      const result = computeConfigRefs([
        { key: 'foo', configPath: '.mcp.json' },
        { key: 'foo', configPath: '.mcp.json' },
        { key: 'foo', configPath: '~/.claude/settings.json' },
      ]);
      expect(result.get('foo')).toEqual(['.mcp.json', '~/.claude/settings.json']);
    });

    it('orders all three buckets: project-local → ~user → system', () => {
      const result = computeConfigRefs([
        { key: 'foo', configPath: '/etc/global-mcp.json' },
        { key: 'foo', configPath: '~/.claude/settings.json' },
        { key: 'foo', configPath: '.mcp.json' },
      ]);
      expect(result.get('foo')).toEqual([
        '.mcp.json',
        '~/.claude/settings.json',
        '/etc/global-mcp.json',
      ]);
    });

    it('preserves first-seen order within a bucket (stable sort)', () => {
      const result = computeConfigRefs([
        { key: 'foo', configPath: 'apps/a/.mcp.json' },
        { key: 'foo', configPath: '.mcp.json' },
        { key: 'foo', configPath: 'apps/b/.mcp.json' },
      ]);
      expect(result.get('foo')).toEqual(['apps/a/.mcp.json', '.mcp.json', 'apps/b/.mcp.json']);
    });

    it('returns an empty Map for empty input', () => {
      expect(computeConfigRefs([])).toEqual(new Map());
    });
  });

  describe('compareConfigRef', () => {
    it('ranks project-local < user-scope < system', () => {
      expect(compareConfigRef('.mcp.json', '~/x.json')).toBeLessThan(0);
      expect(compareConfigRef('~/x.json', '/etc/x.json')).toBeLessThan(0);
      expect(compareConfigRef('.mcp.json', '/etc/x.json')).toBeLessThan(0);
    });

    it('treats Windows drive-letter paths as system (bucket 2)', () => {
      // After presentPath normalizes backslashes, Windows absolute paths
      // look like `C:/Users/...`. They must sort AFTER project-local refs.
      expect(compareConfigRef('.mcp.json', 'C:/Users/foo/claude.json')).toBeLessThan(0);
      expect(compareConfigRef('~/x.json', 'C:/Users/foo/claude.json')).toBeLessThan(0);
      expect(compareConfigRef('D:/projects/.mcp.json', '.mcp.json')).toBeGreaterThan(0);
    });

    it('returns 0 within a bucket (stable sort via Array.sort)', () => {
      expect(compareConfigRef('a.json', 'b.json')).toBe(0);
      expect(compareConfigRef('~/a.json', '~/b.json')).toBe(0);
      expect(compareConfigRef('/etc/a.json', '/etc/b.json')).toBe(0);
    });
  });

  describe('isProtected', () => {
    it('returns true when protection is present', () => {
      expect(
        isProtected({
          protection: { framework: 'gsd', total: 5, ghostCount: 2, reason: 'x' },
        }),
      ).toBe(true);
    });

    it('returns false when protection is undefined', () => {
      expect(isProtected({})).toBe(false);
      expect(isProtected({ protection: undefined })).toBe(false);
    });
  });
}
