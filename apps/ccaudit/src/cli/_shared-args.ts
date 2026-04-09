/**
 * Shared CLI flag definitions for all subcommands.
 *
 * These flags are spread into every command's `args` object.
 *
 * --no-color is declared here for --help visibility (gunshi help metadata).
 * The authoritative runtime source is initColor() in @ccaudit/terminal/color.ts,
 * which reads process.argv directly for root-level positioning robustness (per D-07).
 * Both sources agree because gunshi parsing does not modify process.argv.
 */
export const outputArgs = {
  quiet: {
    type: 'boolean' as const,
    short: 'q',
    description: 'Machine-readable output only (suppress decorative text)',
    default: false,
  },
  csv: {
    type: 'boolean' as const,
    description: 'Output as CSV (RFC 4180)',
    default: false,
  },
  ci: {
    type: 'boolean' as const,
    description: 'CI mode: --json --quiet with exit codes (implies --json --quiet)',
    default: false,
  },
  'no-color': {
    type: 'boolean' as const,
    description: 'Disable ANSI colors in output (also respects NO_COLOR env var)',
    default: false,
  },
} as const;

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('outputArgs', () => {
    it('has quiet key with type boolean and default false', () => {
      expect(outputArgs).toHaveProperty('quiet');
      expect((outputArgs as Record<string, unknown>).quiet).toMatchObject({
        type: 'boolean',
        default: false,
      });
    });

    it('quiet has short alias q', () => {
      expect((outputArgs as Record<string, { short?: string }>).quiet.short).toBe('q');
    });

    it('has csv key with type boolean and default false', () => {
      expect(outputArgs).toHaveProperty('csv');
      expect((outputArgs as Record<string, unknown>).csv).toMatchObject({
        type: 'boolean',
        default: false,
      });
    });

    it('has ci key with type boolean and default false', () => {
      expect(outputArgs).toHaveProperty('ci');
      expect((outputArgs as Record<string, unknown>).ci).toMatchObject({
        type: 'boolean',
        default: false,
      });
    });

    it('ci description mentions CI mode', () => {
      expect((outputArgs as Record<string, { description?: string }>).ci.description).toContain(
        'CI mode',
      );
    });

    it('has no-color key with type boolean and default false', () => {
      expect(outputArgs).toHaveProperty('no-color');
      expect((outputArgs as Record<string, unknown>)['no-color']).toMatchObject({
        type: 'boolean',
        default: false,
      });
    });

    it('no-color description mentions NO_COLOR env var', () => {
      const desc = (outputArgs as Record<string, { description?: string }>)['no-color'].description;
      expect(typeof desc).toBe('string');
      expect(desc).toContain('NO_COLOR');
    });
  });
}
