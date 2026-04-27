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

export interface BannerHeightOptions {
  active: boolean;
  protectedCount: number;
  ascii: boolean;
  terminalCols: number;
}

/**
 * Row budget the banner consumes. Width-aware: computes the exact rendered
 * text length via `renderForcePartialBanner` (colorless by contract) and
 * divides by `terminalCols` to account for line-wrapping at narrower
 * terminals (e.g. at 80 cols the 111-char active+protected banner wraps to
 * 2 rows; at 60 cols the 146-char active+zero-protected banner wraps to 3).
 *
 * `⚠` is width-1 in all modern terminals (xterm-256, iTerm, Terminal.app,
 * Windows Terminal) — no string-width dep needed.
 */
export function bannerHeight(opts: BannerHeightOptions): number {
  if (!opts.active) return 0;
  const text = renderForcePartialBanner(opts);
  const cols = Math.max(1, opts.terminalCols);
  return Math.max(1, Math.ceil(text.length / cols));
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

  describe('bannerHeight (width-aware)', () => {
    it('returns 0 when active=false (regardless of cols/protectedCount/ascii)', () => {
      expect(
        bannerHeight({ active: false, protectedCount: 0, ascii: false, terminalCols: 80 }),
      ).toBe(0);
      expect(
        bannerHeight({ active: false, protectedCount: 5, ascii: true, terminalCols: 40 }),
      ).toBe(0);
    });

    it('terminalCols=200, active=true, protectedCount>0 → 1 row', () => {
      expect(
        bannerHeight({ active: true, protectedCount: 3, ascii: false, terminalCols: 200 }),
      ).toBe(1);
    });

    it('terminalCols=120, protectedCount>0 → 1 row', () => {
      expect(
        bannerHeight({ active: true, protectedCount: 3, ascii: false, terminalCols: 120 }),
      ).toBe(1);
    });

    it('terminalCols=120, protectedCount=0 → 2 rows (suffix pushes past 120 cols)', () => {
      // active+zero-protected text is ~147 chars → ceil(147/120) = 2
      const h = bannerHeight({ active: true, protectedCount: 0, ascii: false, terminalCols: 120 });
      expect(h).toBe(2);
    });

    it('terminalCols=80, protectedCount>0 → 2 rows (111-char text wraps)', () => {
      expect(
        bannerHeight({ active: true, protectedCount: 1, ascii: false, terminalCols: 80 }),
      ).toBe(2);
    });

    it('terminalCols=80, protectedCount=0 → 2 rows', () => {
      expect(
        bannerHeight({ active: true, protectedCount: 0, ascii: false, terminalCols: 80 }),
      ).toBe(2);
    });

    it('terminalCols=60, protectedCount=0 → 3 rows (146-char text wraps to ceil(146/60)=3)', () => {
      expect(
        bannerHeight({ active: true, protectedCount: 0, ascii: false, terminalCols: 60 }),
      ).toBe(3);
    });

    it('round-trip: bannerHeight === ceil(renderForcePartialBanner.length / cols) for all 4 (ascii × protected) combinations', () => {
      for (const ascii of [false, true]) {
        for (const protectedCount of [0, 3]) {
          for (const terminalCols of [60, 80]) {
            const text = renderForcePartialBanner({ active: true, protectedCount, ascii });
            const expected = Math.max(1, Math.ceil(text.length / terminalCols));
            const actual = bannerHeight({ active: true, protectedCount, ascii, terminalCols });
            expect(
              actual,
              `ascii=${ascii} protectedCount=${protectedCount} cols=${terminalCols}`,
            ).toBe(expected);
          }
        }
      }
    });
  });
}
