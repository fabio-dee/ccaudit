// @ccaudit/terminal -- table rendering utilities
// Stub for Phase 1. Implementation in Phase 5 (Report & CLI Commands).

export const TERMINAL_VERSION = '0.0.1';

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;

  it('exports TERMINAL_VERSION', () => {
    expect(TERMINAL_VERSION).toBe('0.0.1');
  });
}
