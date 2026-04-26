/**
 * Pure path presentation helper (Phase 6, D6-18).
 *
 * Converts an absolute path into a user-friendly form for display in the
 * TUI and in the manifest JSON envelope:
 *
 *   1. If `projectRoot` is provided AND `absPath` lives under it, return the
 *      project-relative remainder (project-root precedence over home).
 *   2. Else if `absPath` lives under `homeDir`, return `~/<remainder>`.
 *   3. Else return the input unchanged (non-home absolute, already relative,
 *      or the `/` root edge).
 *
 * The function is pure: no `fs`, no `os`. Callers must pass `homeDir` and
 * (optionally) `projectRoot` explicitly — this keeps `presentPath` snapshot-
 * testable without mocking `os.homedir()`.
 *
 * Forward slashes only (tinyglobby / CLAUDE.md convention). On Windows,
 * callers are expected to normalize to forward slashes upstream before
 * handing paths to the scanner.
 */

/**
 * Render an absolute path for display. Pure function — see module doc.
 *
 * @param absPath   Path to render. May be absolute, `~`-prefixed, or relative.
 * @param homeDir   Absolute path to the user's home directory (no trailing slash).
 * @param projectRoot Optional absolute path to the current project root (no trailing slash).
 * @returns         `"~/..."`, `"<project-relative>"`, or `absPath` unchanged.
 */
export function presentPath(absPath: string, homeDir: string, projectRoot?: string): string {
  // Normalize Windows backslashes to forward slashes before prefix-matching.
  const abs = absPath.replace(/\\/g, '/');
  const home = homeDir.replace(/\\/g, '/');
  const proj = projectRoot ? projectRoot.replace(/\\/g, '/') : projectRoot;

  // Step 1 — project-root wins over home (D6-18).
  if (proj && proj.length > 0 && abs.startsWith(proj + '/')) {
    return abs.slice(proj.length + 1);
  }
  // Step 2 — home compression.
  if (home && home.length > 0 && abs.startsWith(home + '/')) {
    return '~/' + abs.slice(home.length + 1);
  }
  // Step 3 — passthrough (non-home absolute, already relative, `/` root).
  return abs;
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('presentPath', () => {
    it('compresses $HOME to ~/ (D6-18)', () => {
      expect(presentPath('/Users/foo/.claude/settings.json', '/Users/foo')).toBe(
        '~/.claude/settings.json',
      );
    });

    it('project-root precedence over home', () => {
      expect(presentPath('/Users/foo/proj/.mcp.json', '/Users/foo', '/Users/foo/proj')).toBe(
        '.mcp.json',
      );
    });

    it('leaves non-home absolute paths unchanged', () => {
      expect(presentPath('/etc/system.json', '/Users/foo')).toBe('/etc/system.json');
    });

    it('is idempotent on already-relative paths', () => {
      expect(presentPath('relative/already.json', '/Users/foo')).toBe('relative/already.json');
    });

    it('handles the root edge "/" without mangling', () => {
      expect(presentPath('/', '/Users/foo')).toBe('/');
    });

    it('compresses home on Windows-style forward-slashed paths', () => {
      expect(presentPath('C:/Users/foo/.claude/x.json', 'C:/Users/foo')).toBe('~/.claude/x.json');
    });

    it('does NOT compress a path that only shares a prefix substring with home', () => {
      // '/Users/foobar/...' must NOT be rewritten when home is '/Users/foo'.
      expect(presentPath('/Users/foobar/x.json', '/Users/foo')).toBe('/Users/foobar/x.json');
    });

    it('does NOT compress a path that only shares a prefix substring with projectRoot', () => {
      expect(presentPath('/Users/foo/project-b/x.json', '/Users/foo', '/Users/foo/project-a')).toBe(
        '~/project-b/x.json',
      );
    });

    it('compresses project-root on Windows backslash inputs', () => {
      expect(
        presentPath('C:\\Users\\foo\\proj\\.mcp.json', 'C:\\Users\\foo', 'C:\\Users\\foo\\proj'),
      ).toBe('.mcp.json');
    });

    it('compresses home on Windows backslash inputs', () => {
      expect(presentPath('C:\\Users\\foo\\.claude\\x.json', 'C:\\Users\\foo')).toBe(
        '~/.claude/x.json',
      );
    });
  });
}
