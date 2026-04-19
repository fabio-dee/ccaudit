/**
 * Phase 6 Plan 03 (D6-08, D6-14): pure banner renderer for the top-of-TUI
 * `--force-partial` warning.
 *
 * Contract:
 *   - When `active === false`, returns `""` (empty string). The picker omits
 *     the banner line entirely and viewport math stays at its Phase 3.1 size.
 *   - When `active === true`, returns a single-line banner:
 *       Unicode: `⚠ --force-partial active: framework protection DISABLED. …`
 *       ASCII:   `! --force-partial active: framework protection DISABLED. …`
 *   - When `active === true` AND `protectedCount === 0`, the banner gains a
 *     suffix `" (no protected items in this scan)"` — prevents the user from
 *     thinking the flag was silently dropped (D6-14).
 *
 * No color here — the picker wraps the return value in an SGR sequence when
 * the terminal is a TTY. Helper stays colorless so tests are deterministic.
 */

const BASE_TEXT =
  '--force-partial active: framework protection DISABLED. ' +
  'Partial framework splits may corrupt dependent setups.';

const ZERO_PROTECTED_SUFFIX = ' (no protected items in this scan)';

export interface RenderForcePartialBannerOptions {
  active: boolean;
  protectedCount: number;
  ascii: boolean;
}

/**
 * Render the banner line (no trailing newline). Returns empty string when
 * inactive so the picker can do a simple `if (banner) lines.push(banner)`
 * without conditionals on the flag.
 */
export function renderForcePartialBanner(opts: RenderForcePartialBannerOptions): string {
  if (!opts.active) return '';
  const glyph = opts.ascii ? '!' : '⚠';
  const suffix = opts.protectedCount === 0 ? ZERO_PROTECTED_SUFFIX : '';
  return `${glyph} ${BASE_TEXT}${suffix}`;
}

/**
 * Row budget the banner consumes. Used by the viewport formula to deduct
 * one row when the banner is visible.
 */
export function bannerHeight(opts: { active: boolean }): number {
  return opts.active ? 1 : 0;
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderForcePartialBanner', () => {
    it('returns empty string when active=false (regardless of protectedCount/ascii)', () => {
      expect(renderForcePartialBanner({ active: false, protectedCount: 0, ascii: false })).toBe('');
      expect(renderForcePartialBanner({ active: false, protectedCount: 5, ascii: true })).toBe('');
    });

    it('active + Unicode + protectedCount>0 → ⚠ prefix, base text, no suffix', () => {
      const out = renderForcePartialBanner({ active: true, protectedCount: 3, ascii: false });
      expect(out.startsWith('⚠ ')).toBe(true);
      expect(out).toContain('--force-partial active: framework protection DISABLED.');
      expect(out).toContain('Partial framework splits may corrupt dependent setups.');
      expect(out).not.toContain('no protected items in this scan');
    });

    it('active + Unicode + protectedCount===0 → adds "(no protected items in this scan)" suffix (D6-14)', () => {
      const out = renderForcePartialBanner({ active: true, protectedCount: 0, ascii: false });
      expect(out.startsWith('⚠ ')).toBe(true);
      expect(out.endsWith('(no protected items in this scan)')).toBe(true);
    });

    it('active + ASCII → swaps ⚠ for ! (D6-08)', () => {
      const out = renderForcePartialBanner({ active: true, protectedCount: 2, ascii: true });
      expect(out.startsWith('! ')).toBe(true);
      expect(out).not.toContain('⚠');
    });

    it('active + ASCII + zero-protected → ! prefix AND suffix', () => {
      const out = renderForcePartialBanner({ active: true, protectedCount: 0, ascii: true });
      expect(out.startsWith('! ')).toBe(true);
      expect(out.endsWith('(no protected items in this scan)')).toBe(true);
    });

    it('contains no ANSI escape sequences (picker adds color at render time)', () => {
      const out = renderForcePartialBanner({ active: true, protectedCount: 1, ascii: false });
      // eslint-disable-next-line no-control-regex
      expect(/\x1b\[/.test(out)).toBe(false);
    });
  });

  describe('bannerHeight', () => {
    it('returns 0 when active=false', () => {
      expect(bannerHeight({ active: false })).toBe(0);
    });

    it('returns 1 when active=true', () => {
      expect(bannerHeight({ active: true })).toBe(1);
    });
  });
}
