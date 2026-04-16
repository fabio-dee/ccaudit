/**
 * Shared preflight copy helpers for the "Claude Code is running" gate.
 *
 * renderRunningProcessMessage — pure function; returns a formatted stderr string.
 *                                Caller writes to process.stderr verbatim.
 * runPreflightRetryLoop       — retry-until-clear wrapper around detectFn; shared
 *                                by the entry preflight (ghost.ts, plan 03.2-04)
 *                                and the bust-time retry branch.
 *
 * Self-invocation (initialResult.selfInvocation===true) never retries — closing
 * the parent Claude Code session would kill ccaudit itself. External-pids case
 * retries until detect clears or the user cancels.
 *
 * Zero new runtime deps: @clack/prompts is already bundled via confirmation.ts;
 * colorize is already used by tabbed-picker.ts.
 */
import { confirm, isCancel } from '@clack/prompts';
import { colorize } from '../color.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunningProcessInput {
  selfInvocation: boolean;
  pids: readonly number[];
}

export type PreflightPhase = 'entry' | 'bust';

export type PreflightRetryOutcome =
  | { status: 'clear' }
  | { status: 'cancelled' }
  | { status: 'spawn-failed'; error: string };

/**
 * Dependency injection surface for testability. isCancel is typed as
 * `(value: unknown) => boolean` (not a type predicate) so that vi.fn()
 * mocks can satisfy the interface without declaring a type predicate.
 * Mirrors ClackConfirmDep in confirmation.ts.
 */
export interface ClackConfirmDep {
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<symbol | boolean>;
  isCancel: (value: unknown) => boolean;
}

export interface PreflightLoopInput {
  detectFn: () => Promise<
    | { status: 'ok'; processes: Array<{ pid: number; command: string }> }
    | { status: 'spawn-failed'; error: string }
  >;
  phase: PreflightPhase;
  initialResult?: RunningProcessInput;
  _clack?: ClackConfirmDep;
}

// ---------------------------------------------------------------------------
// renderRunningProcessMessage (pure)
// ---------------------------------------------------------------------------

/**
 * Byte-for-byte extraction of the copy block that used to live inline at
 * apps/ccaudit/src/cli/commands/ghost.ts:1229-1248 (case 'running-process').
 * The existing console.error calls appended '\n' per line; joining with '\n'
 * plus a single trailing '\n' produces byte-identical stderr.
 */
export function renderRunningProcessMessage(input: RunningProcessInput): string {
  const lines: string[] = [];
  if (input.selfInvocation) {
    lines.push("You're running ccaudit from inside a Claude Code session.");
    lines.push('');
    lines.push('Open a separate terminal window and run the command from there.');
    lines.push(
      "ccaudit cannot modify Claude Code's configuration while Claude Code is reading it.",
    );
  } else {
    lines.push(`Claude Code is still running (pids: ${input.pids.join(', ')}).`);
    lines.push('');
    lines.push(colorize.red("Don't cross the streams!"));
    lines.push('');
    lines.push('Close all Claude Code instances before running --dangerously-bust-ghosts.');
    lines.push('Modifying configuration while Claude Code is active can corrupt session state.');
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// runPreflightRetryLoop (shared by entry and bust-time call sites)
// ---------------------------------------------------------------------------

/**
 * Render the preflight copy, prompt the user to retry, re-detect on retry.
 *
 * Loop semantics:
 *   - self-invocation (initialResult.selfInvocation===true): render copy, return
 *     cancelled. DO NOT call detectFn, DO NOT prompt — retry would require
 *     closing the parent Claude session which would kill ccaudit itself.
 *   - no initialResult: call detectFn; if status==='spawn-failed' → return that;
 *     if processes===[] → return 'clear'; otherwise enter retry loop.
 *   - initialResult with selfInvocation===false: enter retry loop with the
 *     caller's existing detection (no extra detectFn call this iteration).
 *   - retry loop: render copy → prompt → on yes, call detectFn and repeat; on
 *     no/cancel, return 'cancelled'; on spawn-failed, return that.
 */
export async function runPreflightRetryLoop(
  input: PreflightLoopInput,
): Promise<PreflightRetryOutcome> {
  const { detectFn, phase, initialResult } = input;
  const clack: ClackConfirmDep = input._clack ?? { confirm, isCancel };

  // Self-invocation short-circuit: closing the parent session kills ccaudit.
  if (initialResult?.selfInvocation) {
    process.stderr.write(renderRunningProcessMessage(initialResult));
    return { status: 'cancelled' };
  }

  let current: RunningProcessInput | null = initialResult ?? null;
  const promptMsg =
    phase === 'entry'
      ? "Retry preflight? (I've closed all Claude Code windows)"
      : "Retry bust? (I've closed all Claude Code windows)";

  while (true) {
    if (current === null) {
      const detected = await detectFn();
      if (detected.status === 'spawn-failed') {
        return { status: 'spawn-failed', error: detected.error };
      }
      if (detected.processes.length === 0) {
        return { status: 'clear' };
      }
      current = {
        selfInvocation: false,
        pids: detected.processes.map((p) => p.pid),
      };
    }
    process.stderr.write(renderRunningProcessMessage(current));
    const result = await clack.confirm({ message: promptMsg, initialValue: false });
    if (clack.isCancel(result) || result === false) {
      return { status: 'cancelled' };
    }
    // result === true → user says Claude is closed. Reset and re-detect.
    current = null;
  }
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  describe('renderRunningProcessMessage', () => {
    it('self-invocation: emits the in-session copy with trailing newline', () => {
      const out = renderRunningProcessMessage({ selfInvocation: true, pids: [] });
      expect(out).toContain("You're running ccaudit from inside a Claude Code session.");
      expect(out).toContain('Open a separate terminal window and run the command from there.');
      expect(out).toContain(
        "ccaudit cannot modify Claude Code's configuration while Claude Code is reading it.",
      );
      expect(out.endsWith('\n')).toBe(true);
    });

    it('external pids: emits pid list + "Don\'t cross the streams!" + actionable sentences', () => {
      const out = renderRunningProcessMessage({ selfInvocation: false, pids: [42, 43] });
      expect(out).toContain('Claude Code is still running (pids: 42, 43).');
      expect(out).toContain("Don't cross the streams!");
      expect(out).toContain(
        'Close all Claude Code instances before running --dangerously-bust-ghosts.',
      );
      expect(out).toContain(
        'Modifying configuration while Claude Code is active can corrupt session state.',
      );
    });

    it('single-pid case renders "pids: 42." (not "pids: 42, .")', () => {
      const out = renderRunningProcessMessage({ selfInvocation: false, pids: [42] });
      expect(out).toContain('Claude Code is still running (pids: 42).');
    });

    it('matches a deterministic inline snapshot for selfInvocation=true (SC5 drift guard)', () => {
      // SC5: the byte-for-byte contract. Any future reformatter that changes
      // these bytes will break the interactive path's stderr match against
      // the non-interactive --dangerously-bust-ghosts path.
      const out = renderRunningProcessMessage({ selfInvocation: true, pids: [] });
      expect(out).toMatchInlineSnapshot(`
        "You're running ccaudit from inside a Claude Code session.

        Open a separate terminal window and run the command from there.
        ccaudit cannot modify Claude Code's configuration while Claude Code is reading it.
        "
      `);
    });
  });

  describe('runPreflightRetryLoop', () => {
    it('returns { status: clear } when detectFn returns zero processes', async () => {
      const detectFn = vi.fn().mockResolvedValue({ status: 'ok' as const, processes: [] });
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
      };
      const out = await runPreflightRetryLoop({ detectFn, phase: 'entry', _clack: fakeClack });
      expect(out).toEqual({ status: 'clear' });
      expect(fakeClack.confirm).not.toHaveBeenCalled();
    });

    it('returns { status: spawn-failed, error } when detectFn fails', async () => {
      const detectFn = vi
        .fn()
        .mockResolvedValue({ status: 'spawn-failed' as const, error: 'ENOENT' });
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
      };
      const out = await runPreflightRetryLoop({ detectFn, phase: 'entry', _clack: fakeClack });
      expect(out).toEqual({ status: 'spawn-failed', error: 'ENOENT' });
    });

    it('self-invocation initialResult short-circuits without calling detectFn', async () => {
      const detectFn = vi.fn();
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn(),
        isCancel: vi.fn(() => false),
      };
      const out = await runPreflightRetryLoop({
        detectFn,
        phase: 'bust',
        initialResult: { selfInvocation: true, pids: [99] },
        _clack: fakeClack,
      });
      expect(out).toEqual({ status: 'cancelled' });
      expect(detectFn).not.toHaveBeenCalled();
      expect(fakeClack.confirm).not.toHaveBeenCalled();
    });

    it('external-pids with user-cancel (confirm→false) returns { status: cancelled } after 1 prompt', async () => {
      const detectFn = vi.fn();
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn().mockResolvedValueOnce(false),
        isCancel: vi.fn(() => false),
      };
      const out = await runPreflightRetryLoop({
        detectFn,
        phase: 'entry',
        initialResult: { selfInvocation: false, pids: [42] },
        _clack: fakeClack,
      });
      expect(out).toEqual({ status: 'cancelled' });
      expect(fakeClack.confirm).toHaveBeenCalledTimes(1);
      expect(detectFn).not.toHaveBeenCalled();
    });

    it('external-pids with isCancel true (user Esc) returns { status: cancelled }', async () => {
      const sym = Symbol('cancel');
      const detectFn = vi.fn();
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn().mockResolvedValueOnce(sym),
        isCancel: vi.fn((v: unknown) => v === sym),
      };
      const out = await runPreflightRetryLoop({
        detectFn,
        phase: 'entry',
        initialResult: { selfInvocation: false, pids: [7] },
        _clack: fakeClack,
      });
      expect(out).toEqual({ status: 'cancelled' });
    });

    it('retry until clear: first detect dirty, user confirms, second detect clear → { status: clear }', async () => {
      const detectFn = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok' as const,
          processes: [{ pid: 42, command: 'claude' }],
        })
        .mockResolvedValueOnce({ status: 'ok' as const, processes: [] });
      const fakeClack: ClackConfirmDep = {
        confirm: vi.fn().mockResolvedValueOnce(true),
        isCancel: vi.fn(() => false),
      };
      const out = await runPreflightRetryLoop({ detectFn, phase: 'entry', _clack: fakeClack });
      expect(out).toEqual({ status: 'clear' });
      // First detect runs once at loop entry; after confirm→true, detect runs again.
      expect(detectFn).toHaveBeenCalledTimes(2);
      expect(fakeClack.confirm).toHaveBeenCalledTimes(1);
    });

    it('uses the "Retry preflight?" message for phase=entry', async () => {
      const detectFn = vi.fn();
      const confirmMock = vi.fn().mockResolvedValueOnce(false);
      const fakeClack: ClackConfirmDep = {
        confirm: confirmMock,
        isCancel: vi.fn(() => false),
      };
      await runPreflightRetryLoop({
        detectFn,
        phase: 'entry',
        initialResult: { selfInvocation: false, pids: [1] },
        _clack: fakeClack,
      });
      const callArgs = confirmMock.mock.calls[0]?.[0] as {
        message: string;
        initialValue?: boolean;
      };
      expect(callArgs.message).toBe("Retry preflight? (I've closed all Claude Code windows)");
      expect(callArgs.initialValue).toBe(false);
    });

    it('uses the "Retry bust?" message for phase=bust', async () => {
      const detectFn = vi.fn();
      const confirmMock = vi.fn().mockResolvedValueOnce(false);
      const fakeClack: ClackConfirmDep = {
        confirm: confirmMock,
        isCancel: vi.fn(() => false),
      };
      await runPreflightRetryLoop({
        detectFn,
        phase: 'bust',
        initialResult: { selfInvocation: false, pids: [2] },
        _clack: fakeClack,
      });
      const callArgs = confirmMock.mock.calls[0]?.[0] as { message: string };
      expect(callArgs.message).toBe("Retry bust? (I've closed all Claude Code windows)");
    });

    it('WR-01: on retry iteration 2, rendered pids come from detectFn output, not stale initialResult', async () => {
      // Caller supplies initialResult with pids=[999]. User confirms retry.
      // detectFn returns different pids ([888]). The re-rendered copy must
      // include 888, not 999 — the fresh detection supersedes the stale
      // initialResult on every retry iteration.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const detectFn = vi
          .fn()
          .mockResolvedValueOnce({
            status: 'ok' as const,
            processes: [{ pid: 888, command: 'claude' }],
          })
          .mockResolvedValueOnce({ status: 'ok' as const, processes: [] });
        const fakeClack: ClackConfirmDep = {
          confirm: vi.fn().mockResolvedValueOnce(true),
          isCancel: vi.fn(() => false),
        };
        const out = await runPreflightRetryLoop({
          detectFn,
          phase: 'entry',
          initialResult: { selfInvocation: false, pids: [999] },
          _clack: fakeClack,
        });
        expect(out).toEqual({ status: 'clear' });
        // Iteration 1 renders with initialResult pids=[999].
        // Iteration 2 renders with detectFn's fresh pids=[888].
        const writes = stderrSpy.mock.calls
          .map((call) => call[0])
          .filter((arg): arg is string => typeof arg === 'string');
        const iter1 = writes.find((w) => w.includes('pids: 999'));
        const iter2 = writes.find((w) => w.includes('pids: 888'));
        expect(iter1).toBeDefined();
        expect(iter2).toBeDefined();
        // Crucially: after retry, NO render should still reference the stale 999.
        const staleAfterRetry = writes.slice(writes.indexOf(iter1!) + 1).some(
          (w) => w.includes('pids: 999'),
        );
        expect(staleAfterRetry).toBe(false);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('W2: emits the running-process copy exactly once per loop iteration (single stderr write)', async () => {
      // Spy on process.stderr.write to count invocations during a single-prompt iteration.
      // Cancel on the first prompt → should see exactly ONE stderr write (one render per iteration).
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const detectFn = vi.fn();
        const fakeClack: ClackConfirmDep = {
          confirm: vi.fn().mockResolvedValueOnce(false),
          isCancel: vi.fn(() => false),
        };
        await runPreflightRetryLoop({
          detectFn,
          phase: 'entry',
          initialResult: { selfInvocation: false, pids: [99] },
          _clack: fakeClack,
        });
        // Count writes whose content contains the identifying "Don't cross the streams!" phrase.
        const relevant = stderrSpy.mock.calls.filter((call) => {
          const arg = call[0];
          return typeof arg === 'string' && arg.includes("Don't cross the streams!");
        });
        expect(relevant.length).toBe(1);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
}
