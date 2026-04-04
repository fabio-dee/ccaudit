/**
 * Shared CLI flag definitions for all subcommands.
 *
 * These flags are spread into every command's `args` object.
 * IMPORTANT: --no-color is NOT here (per D-07). It is detected at root level
 * by initColor() reading process.argv directly. This means both
 * `ccaudit --no-color ghost` and `ccaudit ghost --no-color` work.
 */
export const outputArgs = {} as const;

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
      expect((outputArgs as Record<string, { description?: string }>).ci.description).toContain('CI mode');
    });

    it('does NOT have no-color key', () => {
      expect(outputArgs).not.toHaveProperty('no-color');
      expect(outputArgs).not.toHaveProperty('noColor');
    });
  });
}
