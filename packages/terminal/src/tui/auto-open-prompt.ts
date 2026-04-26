/**
 * Auto-open prompt for the interactive picker (D-22, D-24, D-25).
 *
 * Shown after a regular `ccaudit ghost` scan completes on a TTY with ≥1 ghost.
 * Wraps @clack/prompts.confirm with the D-22 voice copy:
 *   message: 'Open interactive picker?'
 *   initialValue: false  (default No — user must press y explicitly)
 *
 * D-24 outcome mapping:
 *   confirm returns true   → 'open'   (user pressed y + Enter)
 *   confirm returns false  → 'decline' (user pressed Enter alone = default No)
 *   isCancel(result)=true  → 'decline' (Ctrl+C / Esc / q — safety invariant: ambiguous input → do NOT proceed)
 *
 * D-25: uses already-bundled @clack/prompts.confirm — no readline dependency.
 *
 * Suppression logic is NOT here. The caller (ghost.ts) uses checkTuiGuards with
 * isExplicitInteractive=false to apply D-23's full 6-flag matrix before calling here.
 */
import { confirm, isCancel } from '@clack/prompts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of the auto-open prompt.
 * 'open'    — user confirmed with y/Y; caller should enter interactive flow.
 * 'decline' — user pressed Enter (default No), n, q, Ctrl+C, or Esc;
 *             caller should exit 0 normally (report already printed).
 */
export type AutoOpenOutcome = 'open' | 'decline';

// ---------------------------------------------------------------------------
// Dependency injection interface (for testability — mirrors confirmation.ts)
// ---------------------------------------------------------------------------

/**
 * Seam for injecting fake clack primitives in in-source tests.
 * isCancel typed as (value: unknown) => boolean (not the type predicate form)
 * so vi.fn() mocks satisfy the interface without a type-predicate signature.
 */
interface ClackDep {
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<symbol | boolean>;
  isCancel: (value: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// promptAutoOpen
// ---------------------------------------------------------------------------

/**
 * Shows the D-22 auto-open prompt and returns the outcome.
 *
 * MUST be called only after checkTuiGuards returns { kind: 'ok' } with
 * isExplicitInteractive=false (the caller's responsibility).
 *
 * The confirm message is exactly: 'Open interactive picker?'
 * The '[y/N]' label is rendered by @clack/prompts.confirm via initialValue=false.
 * Do NOT double-print the brackets.
 *
 * @param _clack — optional injection for tests; defaults to real @clack/prompts
 */
export async function promptAutoOpen(_clack?: ClackDep): Promise<AutoOpenOutcome> {
  const clack = _clack ?? { confirm, isCancel };

  const result = await clack.confirm({
    message: 'Open interactive picker?',
    initialValue: false,
  });

  // isCancel covers Ctrl+C / Esc / q — any ambiguous cancel → do NOT proceed
  if (clack.isCancel(result)) {
    return 'decline';
  }

  if (result === true) {
    return 'open';
  }

  // result === false → default No (Enter alone) or explicit n
  return 'decline';
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  describe('promptAutoOpen', () => {
    it('returns "open" when confirm resolves true (user pressed y)', async () => {
      const fakeClack: ClackDep = {
        confirm: vi.fn().mockResolvedValue(true),
        isCancel: vi.fn(() => false),
      };
      const result = await promptAutoOpen(fakeClack);
      expect(result).toBe('open');
    });

    it('returns "decline" when confirm resolves false (user pressed Enter = default No)', async () => {
      const fakeClack: ClackDep = {
        confirm: vi.fn().mockResolvedValue(false),
        isCancel: vi.fn(() => false),
      };
      const result = await promptAutoOpen(fakeClack);
      expect(result).toBe('decline');
    });

    it('returns "decline" when confirm returns cancel symbol (Ctrl+C / Esc / q)', async () => {
      const cancelSymbol = Symbol('cancel');
      const fakeClack: ClackDep = {
        confirm: vi.fn().mockResolvedValue(cancelSymbol),
        isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      };
      const result = await promptAutoOpen(fakeClack);
      expect(result).toBe('decline');
    });
  });
}
