/**
 * TTY detection and output-mode suppression guards (D-06, D-07, D-23).
 *
 * Pure module — accepts all relevant inputs as a struct so that tests
 * can inject synthetic values instead of reading process.stdin.isTTY
 * or process.env directly.
 *
 * Plan 03 (ghost.ts) and Plan 04 (auto-open call site) collect these
 * facts at CLI entry and pass them in via GuardInputs.
 */

/**
 * Result variants from checkTuiGuards.
 *
 * ok                 — TUI may proceed
 * hard-error         — `--interactive` + `--json`: print message, exit 2
 * fallback-dry-run   — `--interactive` on non-TTY: stderr notice, run dry-run path
 * refuse-narrow      — terminal < 60 cols + `--interactive`: stderr message, exit 0
 * suppress-auto-open — auto-open prompt should be silently skipped
 */
export type TuiGuardMode =
  | { kind: 'ok' }
  | { kind: 'hard-error'; message: string; exitCode: 2 }
  | { kind: 'fallback-dry-run'; reason: string }
  | { kind: 'refuse-narrow'; cols: number; message: string }
  | { kind: 'suppress-auto-open' };

/**
 * D-23 full suppression matrix — all 6 flags must be wired by the caller.
 * Do NOT add `?` to mode fields; every call site must pass all 6 explicitly.
 */
export interface GuardInputs {
  mode: {
    json: boolean;
    csv: boolean;
    quiet: boolean;
    ci: boolean;
    dryRun: boolean; // D-23 new: user asked for dry-run; don't nudge them to archive
    dangerouslyBustGhosts: boolean; // D-23 new: non-interactive bust path is explicit; no nudge
  };
  isTty: boolean;
  ttyCols: number | undefined;
  isExplicitInteractive: boolean; // true for `--interactive`/`-i`, false for auto-open check
}

/**
 * Guard function implementing 9-rule precedence (first match wins).
 *
 * Rules (in order):
 *  1. json + explicit-interactive  → hard-error (D-06)
 *  2. auto-open + output-mode flag → suppress-auto-open (D-23 output flags)
 *  3. auto-open + dryRun           → suppress-auto-open (D-23 new)
 *  4. auto-open + dangerouslyBust  → suppress-auto-open (D-23 new)
 *  5. non-TTY + explicit           → fallback-dry-run (D-07)
 *  6. non-TTY + auto-open          → suppress-auto-open
 *  7. narrow + explicit            → refuse-narrow
 *  8. narrow + auto-open           → suppress-auto-open
 *  9. default                      → ok
 */
export function checkTuiGuards(input: GuardInputs): TuiGuardMode {
  const { mode, isTty, ttyCols, isExplicitInteractive } = input;

  // Rule 1: --interactive + --json is a hard error (D-06)
  if (mode.json && isExplicitInteractive) {
    return {
      kind: 'hard-error',
      message: 'Error: --interactive cannot be combined with --json.',
      exitCode: 2,
    };
  }

  // Rule 2: auto-open + output-mode flags silently suppressed (D-23)
  if (!isExplicitInteractive && (mode.json || mode.csv || mode.quiet || mode.ci)) {
    return { kind: 'suppress-auto-open' };
  }

  // Rule 3: auto-open + --dry-run silently suppressed (D-23 new)
  if (!isExplicitInteractive && mode.dryRun) {
    return { kind: 'suppress-auto-open' };
  }

  // Rule 4: auto-open + --dangerously-bust-ghosts silently suppressed (D-23 new)
  if (!isExplicitInteractive && mode.dangerouslyBustGhosts) {
    return { kind: 'suppress-auto-open' };
  }

  // Rule 5: non-TTY + explicit --interactive → fallback to dry-run (D-07)
  if (!isTty && isExplicitInteractive) {
    return {
      kind: 'fallback-dry-run',
      reason: 'No TTY detected — running in dry-run mode.',
    };
  }

  // Rule 6: non-TTY + auto-open → suppress
  if (!isTty && !isExplicitInteractive) {
    return { kind: 'suppress-auto-open' };
  }

  // Rule 7: narrow terminal + explicit --interactive → refuse
  if ((ttyCols ?? 80) < 60 && isExplicitInteractive) {
    const cols = ttyCols ?? 0;
    return {
      kind: 'refuse-narrow',
      cols,
      message: `Terminal too narrow (need ≥60 cols, got ${cols}). Resize your terminal or use --dangerously-bust-ghosts non-interactively.`,
    };
  }

  // Rule 8: narrow terminal + auto-open → suppress
  if ((ttyCols ?? 80) < 60 && !isExplicitInteractive) {
    return { kind: 'suppress-auto-open' };
  }

  // Rule 9: default — TUI may proceed
  return { kind: 'ok' };
}

/**
 * Convenience wrapper: returns true iff the auto-open check would pass (kind === 'ok').
 * Equivalent to `checkTuiGuards({ ...input, isExplicitInteractive: false }).kind === 'ok'`.
 */
export function isTuiAvailable(input: Pick<GuardInputs, 'mode' | 'isTty' | 'ttyCols'>): boolean {
  return checkTuiGuards({ ...input, isExplicitInteractive: false }).kind === 'ok';
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Factory for a full GuardInputs with sane defaults (TTY, wide, no flags). */
  function makeInput(overrides: Partial<GuardInputs> = {}): GuardInputs {
    return {
      mode: {
        json: false,
        csv: false,
        quiet: false,
        ci: false,
        dryRun: false,
        dangerouslyBustGhosts: false,
      },
      isTty: true,
      ttyCols: 120,
      isExplicitInteractive: false,
      ...overrides,
    };
  }

  describe('checkTuiGuards', () => {
    // Rule 1: --json + --interactive → hard-error
    it('rule 1: json + explicit-interactive → hard-error', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: true,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: true,
        }),
      );
      expect(result.kind).toBe('hard-error');
      expect((result as { kind: 'hard-error'; message: string; exitCode: 2 }).message).toBe(
        'Error: --interactive cannot be combined with --json.',
      );
      expect((result as { kind: 'hard-error'; message: string; exitCode: 2 }).exitCode).toBe(2);
    });

    // Rule 2: auto-open + json → suppress
    it('rule 2a: auto-open + json → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: true,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    it('rule 2b: auto-open + csv → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: true,
            quiet: false,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    it('rule 2c: auto-open + quiet → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: true,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    it('rule 2d: auto-open + ci → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: false,
            ci: true,
            dryRun: false,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    // Rule 3: auto-open + dryRun → suppress (D-23 new)
    it('rule 3: auto-open + dryRun=true → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: true,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    // dryRun with explicit-interactive does NOT by itself suppress (falls through to ok)
    it('rule 3 inverse: explicit-interactive + dryRun does NOT suppress by itself', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: true,
            dangerouslyBustGhosts: false,
          },
          isExplicitInteractive: true,
        }),
      );
      // No TTY rule applies (isTty=true), no narrow rule (cols=120) → ok
      expect(result.kind).toBe('ok');
    });

    // Rule 4: auto-open + dangerouslyBustGhosts → suppress (D-23 new)
    it('rule 4: auto-open + dangerouslyBustGhosts=true → suppress-auto-open', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: true,
          },
          isExplicitInteractive: false,
        }),
      );
      expect(result.kind).toBe('suppress-auto-open');
    });

    // dangerouslyBustGhosts with explicit-interactive does NOT by itself suppress
    it('rule 4 inverse: explicit-interactive + dangerouslyBustGhosts does NOT suppress by itself', () => {
      const result = checkTuiGuards(
        makeInput({
          mode: {
            json: false,
            csv: false,
            quiet: false,
            ci: false,
            dryRun: false,
            dangerouslyBustGhosts: true,
          },
          isExplicitInteractive: true,
        }),
      );
      expect(result.kind).toBe('ok');
    });

    // Rule 5: non-TTY + explicit-interactive → fallback-dry-run (D-07)
    it('rule 5: non-TTY + explicit-interactive → fallback-dry-run', () => {
      const result = checkTuiGuards(makeInput({ isTty: false, isExplicitInteractive: true }));
      expect(result.kind).toBe('fallback-dry-run');
      expect((result as { kind: 'fallback-dry-run'; reason: string }).reason).toBe(
        'No TTY detected — running in dry-run mode.',
      );
    });

    // Rule 6: non-TTY + auto-open → suppress
    it('rule 6: non-TTY + auto-open → suppress-auto-open', () => {
      const result = checkTuiGuards(makeInput({ isTty: false, isExplicitInteractive: false }));
      expect(result.kind).toBe('suppress-auto-open');
    });

    // Rule 7: narrow + explicit-interactive → refuse-narrow
    it('rule 7: narrow terminal + explicit-interactive → refuse-narrow', () => {
      const result = checkTuiGuards(makeInput({ ttyCols: 50, isExplicitInteractive: true }));
      expect(result.kind).toBe('refuse-narrow');
      const r = result as { kind: 'refuse-narrow'; cols: number; message: string };
      expect(r.cols).toBe(50);
      expect(r.message).toContain('Terminal too narrow (need ≥60 cols');
    });

    // Rule 8: narrow + auto-open → suppress
    it('rule 8: narrow terminal + auto-open → suppress-auto-open', () => {
      const result = checkTuiGuards(makeInput({ ttyCols: 50, isExplicitInteractive: false }));
      expect(result.kind).toBe('suppress-auto-open');
    });

    // Rule 9: default → ok
    it('rule 9: all-clear → ok', () => {
      const result = checkTuiGuards(makeInput({ isExplicitInteractive: true }));
      expect(result.kind).toBe('ok');
    });
  });

  describe('isTuiAvailable', () => {
    it('returns true when auto-open check passes (no flags, TTY, wide)', () => {
      const input = {
        mode: {
          json: false,
          csv: false,
          quiet: false,
          ci: false,
          dryRun: false,
          dangerouslyBustGhosts: false,
        },
        isTty: true,
        ttyCols: 120,
      };
      expect(isTuiAvailable(input)).toBe(true);
    });

    it('returns false when json flag set (auto-open would be suppressed)', () => {
      const input = {
        mode: {
          json: true,
          csv: false,
          quiet: false,
          ci: false,
          dryRun: false,
          dangerouslyBustGhosts: false,
        },
        isTty: true,
        ttyCols: 120,
      };
      expect(isTuiAvailable(input)).toBe(false);
    });

    it('returns false when not a TTY', () => {
      const input = {
        mode: {
          json: false,
          csv: false,
          quiet: false,
          ci: false,
          dryRun: false,
          dangerouslyBustGhosts: false,
        },
        isTty: false,
        ttyCols: 120,
      };
      expect(isTuiAvailable(input)).toBe(false);
    });
  });
}
