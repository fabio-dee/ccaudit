import pc from 'picocolors';

const noColorFns = pc.createColors(false);

// Module-level color state
let colorEnabled: boolean | undefined;

/**
 * Initialize color detection from process.argv and environment.
 *
 * Detects color state from two sources:
 * 1. process.argv.includes('--no-color') -- root-level flag (per D-07)
 * 2. process.env.NO_COLOR -- present and non-empty disables color (per NO_COLOR spec)
 *
 * Called once per command invocation before any rendering.
 * picocolors ALSO auto-detects --no-color at import time, but we need
 * initColor() for cli-table3's getTableStyle() which does NOT auto-detect.
 */
export function initColor(): void {
  const argvHasNoColor = process.argv.includes('--no-color');
  const envHasNoColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== '';
  colorEnabled = !(argvHasNoColor || envHasNoColor);
}

/**
 * Returns whether color output is enabled.
 * Falls back to picocolors' own detection if initColor() hasn't been called.
 */
export function isColorEnabled(): boolean {
  if (colorEnabled !== undefined) return colorEnabled;
  return pc.isColorSupported;
}

/**
 * Returns cli-table3 style object respecting color state.
 * When color enabled: { head: ['cyan'] }
 * When disabled: {} (prevents @colors/colors from applying ANSI)
 */
export function getTableStyle(): Record<string, unknown> {
  return isColorEnabled() ? { head: ['cyan'] } : {};
}

/**
 * Color-aware wrappers around picocolors functions.
 * Returns plain text when color is disabled, ANSI-colored text when enabled.
 * Uses createColors(false) from picocolors which returns identity functions.
 */
export const colorize = {
  bold: (s: string): string => isColorEnabled() ? pc.bold(s) : noColorFns.bold(s),
  cyan: (s: string): string => isColorEnabled() ? pc.cyan(s) : noColorFns.cyan(s),
  red: (s: string): string => isColorEnabled() ? pc.red(s) : noColorFns.red(s),
  yellow: (s: string): string => isColorEnabled() ? pc.yellow(s) : noColorFns.yellow(s),
  green: (s: string): string => isColorEnabled() ? pc.green(s) : noColorFns.green(s),
  dim: (s: string): string => isColorEnabled() ? pc.dim(s) : noColorFns.dim(s),
};

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;

  describe('initColor / isColorEnabled', () => {
    let originalArgv: string[];
    let originalNoColor: string | undefined;

    beforeEach(() => {
      originalArgv = [...process.argv];
      originalNoColor = process.env.NO_COLOR;
      // Reset module state
      colorEnabled = undefined;
    });

    afterEach(() => {
      process.argv = originalArgv;
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
      colorEnabled = undefined;
    });

    it('returns false when process.argv includes --no-color', () => {
      process.argv = ['node', 'ccaudit', '--no-color'];
      delete process.env.NO_COLOR;
      initColor();
      expect(isColorEnabled()).toBe(false);
    });

    it('returns false when NO_COLOR env is non-empty string', () => {
      process.argv = ['node', 'ccaudit'];
      process.env.NO_COLOR = '1';
      initColor();
      expect(isColorEnabled()).toBe(false);
    });

    it('returns true when neither argv flag nor env disables color', () => {
      process.argv = ['node', 'ccaudit'];
      delete process.env.NO_COLOR;
      initColor();
      expect(isColorEnabled()).toBe(true);
    });
  });

  describe('getTableStyle', () => {
    let originalArgv: string[];
    let originalNoColor: string | undefined;

    beforeEach(() => {
      originalArgv = [...process.argv];
      originalNoColor = process.env.NO_COLOR;
      colorEnabled = undefined;
    });

    afterEach(() => {
      process.argv = originalArgv;
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
      colorEnabled = undefined;
    });

    it('returns { head: ["cyan"] } when color enabled', () => {
      process.argv = ['node', 'ccaudit'];
      delete process.env.NO_COLOR;
      initColor();
      expect(getTableStyle()).toEqual({ head: ['cyan'] });
    });

    it('returns {} when color disabled', () => {
      process.argv = ['node', 'ccaudit', '--no-color'];
      initColor();
      expect(getTableStyle()).toEqual({});
    });
  });

  describe('colorize', () => {
    let originalArgv: string[];
    let originalNoColor: string | undefined;

    beforeEach(() => {
      originalArgv = [...process.argv];
      originalNoColor = process.env.NO_COLOR;
      colorEnabled = undefined;
    });

    afterEach(() => {
      process.argv = originalArgv;
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
      colorEnabled = undefined;
    });

    it('colorize.bold returns pc.bold when color enabled', () => {
      process.argv = ['node', 'ccaudit'];
      delete process.env.NO_COLOR;
      initColor();
      expect(colorize.bold('x')).toBe(pc.bold('x'));
    });

    it('colorize.bold returns plain text when color disabled', () => {
      process.argv = ['node', 'ccaudit', '--no-color'];
      initColor();
      expect(colorize.bold('x')).toBe('x');
    });
  });
}
