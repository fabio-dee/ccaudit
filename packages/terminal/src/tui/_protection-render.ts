/**
 * Phase 6 Plan 02: Pure render helpers for framework-protection UX in the
 * tabbed picker. Protected rows render dim with a lock glyph (`[🔒]` or ASCII
 * `[L]`); the below-cursor hint shows the canonical `protection.reason`
 * string emitted by the scanner (plan 06-01) verbatim — picker MUST NOT
 * reconstruct the wording.
 *
 * Invariants (D6-04 / D6-05 / D6-20):
 *   - Glyph ALWAYS accompanies dim. No color-only protection signal.
 *   - ASCII fallback via explicit `{ ascii }` option (caller decides once
 *     at TUI entry via `shouldUseAscii()`).
 *   - Dim SGR uses `22` reset (not `0`) so other attributes survive in
 *     composed rows.
 *   - `protectedHintLine` returns `item.protection.reason` verbatim —
 *     the scanner is the single source of truth for the string.
 */

/**
 * Returns the lock glyph: `[🔒]` in Unicode mode, `[L]` in ASCII mode.
 */
export function protectedGlyph(ascii: boolean): string {
  return ascii ? '[L]' : '[🔒]';
}

/**
 * Returns the dim-wrapped row prefix for a protected item, matching the
 * D6-04 row format `  [🔒] …` (two leading spaces then glyph then trailing
 * space). Returns empty string for unprotected items.
 *
 * The prefix is dim-wrapped so it composes with the caller's own content
 * (row label) via `dimLine`.
 */
export function renderProtectedPrefix(
  item: { protection?: unknown },
  opts: { ascii: boolean },
): string {
  if (item.protection === undefined) return '';
  const glyph = protectedGlyph(opts.ascii);
  return `  ${glyph} `;
}

/**
 * Wrap text in the standard SGR "dim" sequence (`\x1b[2m…\x1b[22m`). The
 * `22` reset is preferred over `0` so other attributes composed into the
 * same row (bold, color) are preserved when the dim span ends.
 *
 * When `colorless: true` (e.g. test fixtures, `NO_COLOR`-style contexts),
 * returns the text unchanged — the caller's lock-glyph prefix carries the
 * protection signal in that case (D6-20: never color-alone).
 *
 * The `ascii` option is accepted for API symmetry but does not change
 * the SGR sequence — plain terminals that can't render Unicode can still
 * interpret SGR, and the caller's glyph choice already handles the ASCII
 * fallback.
 */
export function dimLine(text: string, opts: { ascii: boolean; colorless?: boolean }): string {
  void opts.ascii;
  if (opts.colorless === true) return text;
  return `\x1b[2m${text}\x1b[22m`;
}

/**
 * Returns the below-cursor hint line for a focused protected item, prefixed
 * with two spaces to align with the row format. Returns `null` when the
 * item is unprotected so callers can fall through to Phase 5 help/filter
 * hint rendering (hint slot is shared — D6-05).
 *
 * The string is `item.protection.reason` verbatim — the scanner is the
 * single source of truth (plan 06-01). Do NOT template or reconstruct.
 */
export function protectedHintLine(
  item: { protection?: { reason: string } },
  opts: { ascii: boolean },
): string | null {
  void opts.ascii;
  if (item.protection === undefined) return null;
  return `  ${item.protection.reason}`;
}

// ─────────────────────────── In-source tests ───────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('protectedGlyph', () => {
    it('returns [🔒] in Unicode mode', () => {
      expect(protectedGlyph(false)).toBe('[🔒]');
    });
    it('returns [L] in ASCII mode', () => {
      expect(protectedGlyph(true)).toBe('[L]');
    });
  });

  describe('renderProtectedPrefix', () => {
    it('returns empty string for unprotected item', () => {
      expect(renderProtectedPrefix({}, { ascii: false })).toBe('');
      expect(renderProtectedPrefix({ protection: undefined }, { ascii: false })).toBe('');
    });

    it('returns "  [🔒] " prefix for a protected item in Unicode mode', () => {
      const item = {
        protection: { framework: 'gsd', total: 2, ghostCount: 1, reason: 'x' },
      };
      expect(renderProtectedPrefix(item, { ascii: false })).toBe('  [🔒] ');
    });

    it('returns "  [L] " prefix for a protected item in ASCII mode', () => {
      const item = {
        protection: { framework: 'gsd', total: 2, ghostCount: 1, reason: 'x' },
      };
      expect(renderProtectedPrefix(item, { ascii: true })).toBe('  [L] ');
    });
  });

  describe('dimLine', () => {
    it('wraps text in SGR dim sequence with 22 reset (not 0)', () => {
      const out = dimLine('hello', { ascii: false });
      expect(out).toBe('\x1b[2mhello\x1b[22m');
      expect(out).not.toContain('\x1b[0m');
    });

    it('returns raw text when colorless: true (glyph carries the signal)', () => {
      expect(dimLine('hello', { ascii: false, colorless: true })).toBe('hello');
      expect(dimLine('hello', { ascii: true, colorless: true })).toBe('hello');
    });

    it('dim sequence unchanged in ASCII mode (SGR works on plain terminals)', () => {
      expect(dimLine('x', { ascii: true })).toBe('\x1b[2mx\x1b[22m');
    });
  });

  describe('protectedHintLine', () => {
    it('returns null for unprotected item', () => {
      expect(protectedHintLine({}, { ascii: false })).toBeNull();
      expect(protectedHintLine({ protection: undefined }, { ascii: false })).toBeNull();
    });

    it('returns two-space prefixed reason verbatim for protected item', () => {
      const reason = 'Part of GSD (2 used, 1 ghost). --force-partial to override.';
      const line = protectedHintLine({ protection: { reason } }, { ascii: false });
      expect(line).toBe(`  ${reason}`);
    });

    it('passes reason verbatim without template re-construction (scanner owns wording)', () => {
      const reason =
        'Custom scanner-provided reason string with punctuation: "quotes", parens, ellipsis…';
      const line = protectedHintLine({ protection: { reason } }, { ascii: true });
      expect(line).toBe(`  ${reason}`);
    });

    it('ASCII option does not alter the returned reason string', () => {
      const reason = 'some reason';
      expect(protectedHintLine({ protection: { reason } }, { ascii: true })).toBe(
        protectedHintLine({ protection: { reason } }, { ascii: false }),
      );
    });
  });
}
