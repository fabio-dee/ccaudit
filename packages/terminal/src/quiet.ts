/**
 * TSV (tab-separated values) formatter for quiet mode output.
 */

/**
 * Join fields with tab characters for machine-parseable quiet output.
 * No escaping needed for tab-separated output.
 */
export function tsvRow(fields: string[]): string {
  return fields.join('\t');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('tsvRow', () => {
    it('joins fields with tab character', () => {
      expect(tsvRow(['a', 'b', 'c'])).toBe('a\tb\tc');
    });
  });
}
