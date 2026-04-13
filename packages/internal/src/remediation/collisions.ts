import path from 'node:path';

/**
 * ISO-timestamp suffix helpers for archive filename + JSON key collision handling.
 *
 * D-05 (archive filename collisions): ~/.claude/ccaudit/archived/agents/code-reviewer.md
 *   collides -> ~/.claude/ccaudit/archived/agents/code-reviewer.2026-04-05T18-30-00Z.md
 *   (colons replaced with dashes for cross-filesystem safety -- NTFS forbids colons)
 *
 * D-06 (MCP disabled key collisions): ccaudit-disabled:playwright collides ->
 *   ccaudit-disabled:playwright:2026-04-05T18:30:00Z
 *   (colons PRESERVED -- JSON object keys allow any UTF-8 per RFC 8259)
 *
 * D-10 (manifest filename): same as D-05 -- bust-2026-04-05T18-30-00Z.jsonl
 *
 * RESEARCH Open Question 1: archive paths preserve nested subdirectory structure
 * via path.relative so `agents/design/foo.md` archives to
 * `ccaudit/archived/agents/design/foo.md`, never flattened.
 */

/**
 * Generate an ISO 8601 timestamp suffix safe for filenames (colons -> dashes, no ms).
 * Example: '2026-04-05T18-30-00Z'
 */
export function timestampSuffixForFilename(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/**
 * Generate an ISO 8601 timestamp suffix for JSON object keys (colons PRESERVED, no ms).
 * Example: '2026-04-05T18:30:00Z'
 */
export function timestampSuffixForJsonKey(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a collision-resistant archive path that PRESERVES nested subdirectory
 * structure relative to the category root.
 *
 * Per RESEARCH Open Question 1 recommendation:
 *   sourcePath  = /home/user/.claude/agents/design/foo.md
 *   categoryRoot = /home/user/.claude/agents
 *   archivedDir  = /home/user/.claude/ccaudit/archived/agents
 *   result      = /home/user/.claude/ccaudit/archived/agents/design/foo.md
 *
 * On collision (collisionExists returns true for the computed path):
 *   result = /home/user/.claude/ccaudit/archived/agents/design/foo.<iso-suffix>.md
 *
 * Throws if sourcePath is outside categoryRoot (guards against `..` escape).
 */
export function buildArchivePath(opts: {
  sourcePath: string;
  categoryRoot: string;
  archivedDir: string; // e.g. `${claudeRoot}/ccaudit/archived/agents`
  collisionExists: (p: string) => boolean;
  now?: Date;
}): string {
  const rel = path.relative(opts.categoryRoot, opts.sourcePath);
  // Never archive across the category root (guard against `..` in relative path)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `buildArchivePath: sourcePath ${opts.sourcePath} is outside categoryRoot ${opts.categoryRoot}`,
    );
  }
  const candidate = path.join(opts.archivedDir, rel);
  if (!opts.collisionExists(candidate)) return candidate;

  // Collision: insert ISO suffix before the extension
  const parsed = path.parse(candidate);
  const suffix = timestampSuffixForFilename(opts.now);
  return path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext}`);
}

/**
 * Build a collision-resistant MCP disabled key.
 * First time:  ccaudit-disabled:playwright
 * Collision:   ccaudit-disabled:playwright:2026-04-05T18:30:00Z
 *
 * Note: the colon between `ccaudit-disabled` and the server name is a literal
 * key character, not a nested path delimiter -- JSON object keys permit any
 * UTF-8 per RFC 8259.
 */
export function buildDisabledMcpKey(
  serverName: string,
  existingKeys: Set<string>,
  now: Date = new Date(),
): string {
  const base = `ccaudit-disabled:${serverName}`;
  if (!existingKeys.has(base)) return base;
  const suffix = timestampSuffixForJsonKey(now);
  return `${base}:${suffix}`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('timestampSuffixForFilename', () => {
    it('strips ms and replaces colons with dashes', () => {
      const d = new Date('2026-04-05T18:30:00.123Z');
      expect(timestampSuffixForFilename(d)).toBe('2026-04-05T18-30-00Z');
    });

    it('defaults to now() and returns a dash-only shape', () => {
      const s = timestampSuffixForFilename();
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    });

    it('handles zero milliseconds (ISO string without fractional seconds)', () => {
      // Date.toISOString() always emits .000Z even when ms === 0
      const d = new Date('2026-01-01T00:00:00.000Z');
      expect(timestampSuffixForFilename(d)).toBe('2026-01-01T00-00-00Z');
    });
  });

  describe('timestampSuffixForJsonKey', () => {
    it('strips ms but PRESERVES colons', () => {
      const d = new Date('2026-04-05T18:30:00.123Z');
      expect(timestampSuffixForJsonKey(d)).toBe('2026-04-05T18:30:00Z');
    });

    it('defaults to now() and returns a colon-containing shape', () => {
      const s = timestampSuffixForJsonKey();
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  // Windows: path.relative/join produce backslash paths; assertions use hardcoded forward slashes.
  describe.skipIf(process.platform === 'win32')('buildArchivePath', () => {
    const categoryRoot = '/home/u/.claude/agents';
    const archivedDir = '/home/u/.claude/ccaudit/archived/agents';

    it('flat file: no collision returns plain archive path', () => {
      const p = buildArchivePath({
        sourcePath: '/home/u/.claude/agents/foo.md',
        categoryRoot,
        archivedDir,
        collisionExists: () => false,
      });
      expect(p).toBe('/home/u/.claude/ccaudit/archived/agents/foo.md');
    });

    it('nested file: preserves subdirectory structure', () => {
      const p = buildArchivePath({
        sourcePath: '/home/u/.claude/agents/design/foo.md',
        categoryRoot,
        archivedDir,
        collisionExists: () => false,
      });
      expect(p).toBe('/home/u/.claude/ccaudit/archived/agents/design/foo.md');
    });

    it('deeply nested: preserves full relative structure', () => {
      const p = buildArchivePath({
        sourcePath: '/home/u/.claude/agents/design/ux/foo.md',
        categoryRoot,
        archivedDir,
        collisionExists: () => false,
      });
      expect(p).toBe('/home/u/.claude/ccaudit/archived/agents/design/ux/foo.md');
    });

    it('collision: inserts timestamp suffix before extension', () => {
      const p = buildArchivePath({
        sourcePath: '/home/u/.claude/agents/foo.md',
        categoryRoot,
        archivedDir,
        collisionExists: (c) => c === '/home/u/.claude/ccaudit/archived/agents/foo.md',
        now: new Date('2026-04-05T18:30:00.000Z'),
      });
      expect(p).toBe('/home/u/.claude/ccaudit/archived/agents/foo.2026-04-05T18-30-00Z.md');
    });

    it('nested collision: preserves dir + inserts suffix', () => {
      const p = buildArchivePath({
        sourcePath: '/home/u/.claude/agents/design/foo.md',
        categoryRoot,
        archivedDir,
        collisionExists: (c) => c === '/home/u/.claude/ccaudit/archived/agents/design/foo.md',
        now: new Date('2026-04-05T18:30:00.000Z'),
      });
      expect(p).toBe('/home/u/.claude/ccaudit/archived/agents/design/foo.2026-04-05T18-30-00Z.md');
    });

    it('throws when sourcePath escapes categoryRoot via ..', () => {
      expect(() =>
        buildArchivePath({
          sourcePath: '/home/u/.claude/other/foo.md',
          categoryRoot,
          archivedDir,
          collisionExists: () => false,
        }),
      ).toThrow(/outside categoryRoot/);
    });
  });

  describe('buildDisabledMcpKey', () => {
    it('first-time: returns ccaudit-disabled:<name>', () => {
      expect(buildDisabledMcpKey('playwright', new Set())).toBe('ccaudit-disabled:playwright');
    });

    it('collision: appends timestamp suffix with preserved colons', () => {
      const existing = new Set(['ccaudit-disabled:playwright']);
      const now = new Date('2026-04-05T18:30:00.000Z');
      expect(buildDisabledMcpKey('playwright', existing, now)).toBe(
        'ccaudit-disabled:playwright:2026-04-05T18:30:00Z',
      );
    });

    it('server name with hyphen works', () => {
      expect(buildDisabledMcpKey('chrome-devtools', new Set())).toBe(
        'ccaudit-disabled:chrome-devtools',
      );
    });

    it('double collision: still returns the timestamped key (caller responsibility)', () => {
      const existing = new Set([
        'ccaudit-disabled:playwright',
        'ccaudit-disabled:playwright:2026-04-05T18:30:00Z',
      ]);
      const now = new Date('2026-04-05T18:30:00.000Z');
      // Documents the edge case: the helper does not loop to disambiguate further.
      // The caller is responsible for detecting duplicate timestamped keys if it
      // matters (in practice two busts at the exact same wall-clock second are
      // vanishingly unlikely and the caller can bust twice in a row as a fix).
      expect(buildDisabledMcpKey('playwright', existing, now)).toBe(
        'ccaudit-disabled:playwright:2026-04-05T18:30:00Z',
      );
    });
  });
}
