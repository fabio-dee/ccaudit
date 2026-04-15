/**
 * ASCII fallback predicate for TUI rendering (D-15, D-16).
 *
 * Single source of truth: call ONCE at TUI entry and pass the result
 * (`useAscii: boolean`) into all downstream render functions.
 * Do NOT re-evaluate per-row.
 */

/**
 * Returns `true` when Unicode glyphs are unreliable and ASCII fallbacks
 * should be used throughout the TUI session.
 *
 * Triggers (D-15) — first match wins:
 *   1. `CCAUDIT_ASCII_ONLY=1` env var (explicit user opt-in)
 *   2. `stdout.hasColors?.() === false` (no color support → likely no Unicode)
 *   3. Terminal width < 60 columns (narrow terminal forces plain rendering)
 *   4. Both LANG and LC_ALL are undefined AND TERM is 'dumb' or undefined
 *      (non-Unicode locale with dumb terminal)
 *
 * @param env  - Node.js process environment (injected for testability)
 * @param stdout - Node.js write stream (injected for testability)
 * @param ttyCols - Explicit column override (skips stdout.columns lookup if provided)
 */
export function shouldUseAscii(
  env: NodeJS.ProcessEnv,
  stdout: Pick<NodeJS.WriteStream, 'hasColors' | 'columns'>,
  ttyCols?: number | undefined,
): boolean {
  // Trigger 1: explicit opt-in via env var
  if (env['CCAUDIT_ASCII_ONLY'] === '1') {
    return true;
  }

  // Trigger 2: no color support implies unreliable Unicode rendering
  if (stdout.hasColors?.() === false) {
    return true;
  }

  // Trigger 3: narrow terminal
  const cols = ttyCols ?? stdout.columns ?? 80;
  if (cols < 60) {
    return true;
  }

  // Trigger 4: no Unicode locale indicators AND dumb/missing TERM
  const hasLocale = env['LANG'] !== undefined || env['LC_ALL'] !== undefined;
  const term = env['TERM'];
  if (!hasLocale && (term === 'dumb' || term === undefined)) {
    return true;
  }

  return false;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Minimal fake stdout for tests */
  function makeStdout(opts: {
    hasColors?: () => boolean;
    columns?: number;
  }): Pick<NodeJS.WriteStream, 'hasColors' | 'columns'> {
    return {
      hasColors: opts.hasColors,
      columns: opts.columns ?? 80,
    };
  }

  describe('shouldUseAscii', () => {
    it('returns true when CCAUDIT_ASCII_ONLY=1', () => {
      const env = { CCAUDIT_ASCII_ONLY: '1', LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(true);
    });

    it('returns true when hasColors() === false', () => {
      const env = { LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => false, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(true);
    });

    it('returns true when ttyCols < 60 (via explicit param)', () => {
      const env = { LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout, 55)).toBe(true);
    });

    it('returns true when stdout.columns < 60 (via stdout)', () => {
      const env = { LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => true, columns: 40 });
      expect(shouldUseAscii(env, stdout)).toBe(true);
    });

    it('returns true when TERM=dumb and no LANG/LC_ALL', () => {
      const env = { TERM: 'dumb' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(true);
    });

    it('returns true when TERM is undefined and no LANG/LC_ALL', () => {
      const env: NodeJS.ProcessEnv = {};
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(true);
    });

    it('returns false for a standard color-capable TTY ≥60 cols with LANG set (default-false case)', () => {
      const env = { LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(false);
    });

    it('returns false when LC_ALL set even if TERM=dumb (locale present overrides dumb-term trigger)', () => {
      const env = { LC_ALL: 'en_US.UTF-8', TERM: 'dumb' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(false);
    });

    it('CCAUDIT_ASCII_ONLY=0 is not treated as opt-in (only "1" triggers)', () => {
      const env = { CCAUDIT_ASCII_ONLY: '0', LANG: 'en_US.UTF-8' };
      const stdout = makeStdout({ hasColors: () => true, columns: 120 });
      expect(shouldUseAscii(env, stdout)).toBe(false);
    });
  });
}
