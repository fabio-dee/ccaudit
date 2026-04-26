/**
 * Phase 9 D2 — env escape hatch helper.
 *
 * `CCAUDIT_NO_INTERACTIVE=1` (or `=true`, case-insensitive) gates all
 * interactivity globally. The helper is a pure read of `process.env` with
 * a strict whitelist per D2 / T-09-01: only "1" or "true" (trimmed,
 * case-insensitive) count as truthy. Everything else — including "yes",
 * "on", "0", "false", "", undefined, or whitespace-only — is false.
 *
 * Both `ghost` and `restore` route their `--interactive` and auto-open
 * decisions through this helper so the refusal behavior is uniform.
 */
export function isNoInteractiveEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CCAUDIT_NO_INTERACTIVE'];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('isNoInteractiveEnv', () => {
    it('true for "1"', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: '1' })).toBe(true);
    });
    it('true for "true"', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: 'true' })).toBe(true);
    });
    it('true for "TRUE" (case-insensitive)', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: 'TRUE' })).toBe(true);
    });
    it('true for " true " (trimmed)', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: ' true ' })).toBe(true);
    });
    it('false for "0"', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: '0' })).toBe(false);
    });
    it('false for "false"', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: 'false' })).toBe(false);
    });
    it('false for unset', () => {
      expect(isNoInteractiveEnv({})).toBe(false);
    });
    it('false for empty string', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: '' })).toBe(false);
    });
    it('false for whitespace only', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: '   ' })).toBe(false);
    });
    it('false for "yes" (strict whitelist — T-09-01)', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: 'yes' })).toBe(false);
    });
    it('false for "on" (strict whitelist — T-09-01)', () => {
      expect(isNoInteractiveEnv({ CCAUDIT_NO_INTERACTIVE: 'on' })).toBe(false);
    });
  });
}
