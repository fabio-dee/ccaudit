/**
 * Shared CLI flag definitions for all subcommands.
 *
 * These flags are spread into every command's `args` object.
 *
 * --no-color is declared here for --help visibility (gunshi help metadata).
 * The authoritative runtime source is initColor() in @ccaudit/terminal/color.ts,
 * which reads process.argv directly for root-level positioning robustness (per D-07).
 * Both sources agree because gunshi parsing does not modify process.argv.
 *
 * IMPORTANT: use camelCase internal keys plus `toKebab: true` for the public
 * `--no-*` flags instead of either:
 *   1) gunshi's `negatable: true` (renders `Negatable of --...`), or
 *   2) literal `no-*` arg keys (renderer strips the prefix and prints
 *      placeholder text like `color` / `group-frameworks`).
 *
 * `noColor` + `toKebab: true` still exposes the documented `--no-color` flag,
 * but avoids both gunshi help-rendering defects.
 */
export const outputArgs = {
  quiet: {
    type: 'boolean' as const,
    short: 'q',
    description: 'Machine-readable only',
    default: false,
  },
  csv: {
    type: 'boolean' as const,
    description: 'Output as CSV (RFC 4180)',
    default: false,
  },
  ci: {
    type: 'boolean' as const,
    description: 'CI: --json --quiet',
    default: false,
  },
  noColor: {
    type: 'boolean' as const,
    toKebab: true,
    description: 'Disable ANSI colors (NO_COLOR too)',
    default: false,
  },
  noGroupFrameworks: {
    type: 'boolean' as const,
    toKebab: true,
    description: 'Disable framework grouping',
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

    it('ci description mentions CI', () => {
      expect((outputArgs as Record<string, { description?: string }>).ci.description).toContain(
        'CI',
      );
    });

    it('has noColor key with type boolean, toKebab, and default false', () => {
      expect(outputArgs).toHaveProperty('noColor');
      expect((outputArgs as Record<string, unknown>).noColor).toMatchObject({
        type: 'boolean',
        toKebab: true,
        default: false,
      });
    });

    it('noColor description mentions NO_COLOR env var', () => {
      const desc = (outputArgs as Record<string, { description?: string }>).noColor.description;
      expect(typeof desc).toBe('string');
      expect(desc).toContain('NO_COLOR');
    });

    it('has noGroupFrameworks key with type boolean, toKebab, and default false', () => {
      expect(outputArgs).toHaveProperty('noGroupFrameworks');
      expect((outputArgs as Record<string, unknown>).noGroupFrameworks).toMatchObject({
        type: 'boolean',
        toKebab: true,
        default: false,
      });
    });

    it('noGroupFrameworks description mentions framework grouping', () => {
      const desc = (outputArgs as Record<string, { description?: string }>).noGroupFrameworks
        .description;
      expect(typeof desc).toBe('string');
      expect(desc).toContain('framework grouping');
    });
  });
}
