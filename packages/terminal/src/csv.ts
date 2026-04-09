/**
 * RFC 4180 CSV formatting utilities.
 */

/**
 * Escape a single CSV field per RFC 4180.
 * If the value contains a comma, double-quote, or newline,
 * wrap in double quotes and double any internal quotes.
 */
export function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format an array of fields as a single CSV row.
 */
export function csvRow(fields: string[]): string {
  return fields.map(csvEscape).join(',');
}

/**
 * Format a complete CSV table with optional header row.
 */
export function csvTable(headers: string[], rows: string[][], includeHeader = true): string {
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(csvRow(headers));
  }
  for (const row of rows) {
    lines.push(csvRow(row));
  }
  return lines.join('\n');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('csvEscape', () => {
    it('returns plain value unchanged', () => {
      expect(csvEscape('hello')).toBe('hello');
    });

    it('quotes value containing comma', () => {
      expect(csvEscape('hello,world')).toBe('"hello,world"');
    });

    it('doubles quotes and wraps in quotes', () => {
      expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    });

    it('quotes value containing newline', () => {
      expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });
  });

  describe('csvRow', () => {
    it('joins fields with comma, escaping as needed', () => {
      expect(csvRow(['a', 'b,c', 'd'])).toBe('a,"b,c",d');
    });
  });

  describe('csvTable', () => {
    it('includes header when includeHeader is true', () => {
      const result = csvTable(
        ['h1', 'h2'],
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
        true,
      );
      expect(result).toBe('h1,h2\na,b\nc,d');
    });

    it('excludes header when includeHeader is false', () => {
      const result = csvTable(['h1', 'h2'], [['a', 'b']], false);
      expect(result).toBe('a,b');
    });
  });
}
