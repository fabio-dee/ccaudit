/**
 * Phase 9 Plan 02 (D4, SC4) — colorblind-friendly glyph set.
 *
 * Every selectable state in the picker gets a distinct column-1 glyph
 * independent of color. Rendering callers pass `useAscii: boolean` from
 * `resolveGlyphSet()` once per frame; every row prints its state glyph
 * in column 1 — color is always layered on top, never the sole signal.
 *
 * Triggers for the ASCII fallback (first match wins):
 *   1. `CCAUDIT_ASCII_ONLY=1` env var
 *   2. `NO_COLOR` env var set (any value; convention is truthy-presence)
 *   3. `TERM=dumb`
 *   4. `opts.noColor === true` (mirrors the --no-color CLI flag at call sites)
 *
 * This is distinct from `_glyph-capability.ts`'s `shouldUseAscii()` which
 * also degrades on narrow terminals (cols < 60) — that predicate is about
 * rendering reliability; this one is about *colorblind accessibility*
 * (D4: "every state has a distinct glyph, never color-only").
 *
 * Do NOT re-evaluate per-row — call once at render-entry.
 */

export interface GlyphSet {
  /** Row-selected checkbox glyph. */
  selected: string;
  /** Row-unselected checkbox glyph. */
  unselected: string;
  /** Framework-as-unit protected row prefix. */
  protected: string;
  /** Multi-config MCP server advisory prefix. */
  multiConfigMcp: string;
  /** Stale (≥90d) memory file advisory prefix. */
  staleMemory: string;
}

export const GLYPHS_UNICODE: GlyphSet = {
  selected: '◉',
  unselected: '◯',
  protected: '🔒',
  multiConfigMcp: '⚠',
  staleMemory: '⌛',
};

export const GLYPHS_ASCII: GlyphSet = {
  selected: '[x]',
  unselected: '[ ]',
  protected: '#',
  multiConfigMcp: '!',
  staleMemory: '~',
};

export interface ResolveGlyphSetOpts {
  /** Mirrors the `--no-color` CLI flag; forces ASCII regardless of env. */
  noColor?: boolean;
}

/**
 * Pick a glyph set based on environment + explicit opts. ASCII wins on any
 * of the four D4 triggers; otherwise Unicode.
 */
export function resolveGlyphSet(env: NodeJS.ProcessEnv, opts?: ResolveGlyphSetOpts): GlyphSet {
  return shouldUseAsciiGlyphs(env, opts) ? GLYPHS_ASCII : GLYPHS_UNICODE;
}

/**
 * Predicate form of `resolveGlyphSet` — exposed for callers that already
 * track a `useAscii: boolean` state (e.g., tabbed-picker.ts). Pure.
 */
export function shouldUseAsciiGlyphs(env: NodeJS.ProcessEnv, opts?: ResolveGlyphSetOpts): boolean {
  if (opts?.noColor === true) return true;
  if (env['CCAUDIT_ASCII_ONLY'] === '1') return true;
  // NO_COLOR convention: any non-empty value => suppress color (and thus
  // glyphs that rely on color for distinction are still safe — we switch
  // to ASCII so they're distinguishable structurally).
  // https://no-color.org/
  const noColor = env['NO_COLOR'];
  if (typeof noColor === 'string' && noColor !== '') return true;
  if (env['TERM'] === 'dumb') return true;
  return false;
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('resolveGlyphSet', () => {
    it('returns Unicode glyphs for default color-capable env', () => {
      const g = resolveGlyphSet({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color' });
      expect(g).toBe(GLYPHS_UNICODE);
      expect(g.selected).toBe('◉');
      expect(g.unselected).toBe('◯');
    });

    it('returns ASCII glyphs when CCAUDIT_ASCII_ONLY=1', () => {
      const g = resolveGlyphSet({ CCAUDIT_ASCII_ONLY: '1' });
      expect(g).toBe(GLYPHS_ASCII);
      expect(g.selected).toBe('[x]');
      expect(g.unselected).toBe('[ ]');
    });

    it('returns ASCII glyphs when NO_COLOR is set (any non-empty value)', () => {
      expect(resolveGlyphSet({ NO_COLOR: '1' })).toBe(GLYPHS_ASCII);
      expect(resolveGlyphSet({ NO_COLOR: 'true' })).toBe(GLYPHS_ASCII);
    });

    it('does NOT trigger ASCII when NO_COLOR is empty string', () => {
      // Per no-color.org convention: empty string is not "set". We treat
      // unset/empty identically so callers that do `env.NO_COLOR ?? ''`
      // don't accidentally force ASCII.
      expect(resolveGlyphSet({ NO_COLOR: '', LANG: 'en_US.UTF-8' })).toBe(GLYPHS_UNICODE);
    });

    it('returns ASCII glyphs when TERM=dumb', () => {
      expect(resolveGlyphSet({ TERM: 'dumb' })).toBe(GLYPHS_ASCII);
    });

    it('returns ASCII glyphs when opts.noColor === true (mirrors --no-color flag)', () => {
      const g = resolveGlyphSet({ LANG: 'en_US.UTF-8' }, { noColor: true });
      expect(g).toBe(GLYPHS_ASCII);
    });

    it('CCAUDIT_ASCII_ONLY=0 is NOT treated as opt-in (only "1" triggers)', () => {
      const g = resolveGlyphSet({ CCAUDIT_ASCII_ONLY: '0', LANG: 'en_US.UTF-8' });
      expect(g).toBe(GLYPHS_UNICODE);
    });

    it('every state has a distinct glyph in both sets (SC4 invariant)', () => {
      for (const set of [GLYPHS_UNICODE, GLYPHS_ASCII]) {
        const glyphs = [
          set.selected,
          set.unselected,
          set.protected,
          set.multiConfigMcp,
          set.staleMemory,
        ];
        expect(new Set(glyphs).size).toBe(glyphs.length);
      }
    });
  });

  describe('shouldUseAsciiGlyphs', () => {
    it('matches resolveGlyphSet === GLYPHS_ASCII for all documented triggers', () => {
      const triggers: NodeJS.ProcessEnv[] = [
        { CCAUDIT_ASCII_ONLY: '1' },
        { NO_COLOR: '1' },
        { TERM: 'dumb' },
      ];
      for (const env of triggers) {
        expect(shouldUseAsciiGlyphs(env)).toBe(true);
        expect(resolveGlyphSet(env)).toBe(GLYPHS_ASCII);
      }
    });
  });
}
