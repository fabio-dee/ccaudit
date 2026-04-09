/**
 * Millisecond multipliers for each supported duration unit.
 */
const UNITS: Record<string, number> = {
  h: 3_600_000, // 1 hour
  d: 86_400_000, // 1 day
  w: 604_800_000, // 1 week (7 days)
  m: 2_592_000_000, // 1 month (30 days)
};

/**
 * Parse a duration string (e.g., '7d', '2w', '1m', '24h') into milliseconds.
 *
 * Supported units: h (hours), d (days), w (weeks), m (months = 30 days).
 * Case-insensitive.
 *
 * @throws {Error} If the input does not match the expected format.
 */
export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+)\s*([hdwm])$/i);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Expected format: <number><unit> where unit is h (hours), d (days), w (weeks), or m (months). Examples: 7d, 2w, 1m`,
    );
  }
  return parseInt(match[1], 10) * UNITS[match[2].toLowerCase()];
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('parseDuration', () => {
    it('should parse days', () => {
      expect(parseDuration('7d')).toBe(604_800_000);
    });

    it('should parse weeks', () => {
      expect(parseDuration('2w')).toBe(1_209_600_000);
    });

    it('should parse months (30 days)', () => {
      expect(parseDuration('1m')).toBe(2_592_000_000);
    });

    it('should parse hours', () => {
      expect(parseDuration('24h')).toBe(86_400_000);
    });

    it('should return 0 for zero duration', () => {
      expect(parseDuration('0d')).toBe(0);
    });

    it('should be case-insensitive', () => {
      expect(parseDuration('7D')).toBe(604_800_000);
      expect(parseDuration('2W')).toBe(1_209_600_000);
      expect(parseDuration('1M')).toBe(2_592_000_000);
      expect(parseDuration('24H')).toBe(86_400_000);
    });

    it('should throw on invalid input "abc"', () => {
      expect(() => parseDuration('abc')).toThrow('Invalid duration');
    });

    it('should throw on empty string', () => {
      expect(() => parseDuration('')).toThrow('Invalid duration');
    });

    it('should throw on unit-only input', () => {
      expect(() => parseDuration('d')).toThrow('Invalid duration');
    });

    it('should throw on number-only input', () => {
      expect(() => parseDuration('7')).toThrow('Invalid duration');
    });

    it('should handle whitespace around input', () => {
      expect(parseDuration(' 7d ')).toBe(604_800_000);
    });

    it('should throw on negative numbers', () => {
      expect(() => parseDuration('-7d')).toThrow('Invalid duration');
    });

    it('should throw on unsupported unit', () => {
      expect(() => parseDuration('7y')).toThrow('Invalid duration');
    });
  });
}
