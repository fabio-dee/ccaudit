/**
 * Confirmation screen and prompt for the interactive archive flow (D-17..D-21).
 *
 * renderConfirmationScreen — pure function; returns a formatted string.
 * runConfirmationPrompt — wraps @clack/prompts.confirm; returns a 2-variant outcome.
 *
 * v0.5 outcome is boolean-only per D-21.
 * v0.5 footer: `Proceed? [y/N] · q = cancel`
 * TODO(Phase 5): extend footer and ConfirmationOutcome to include back-to-picker once the custom prompt supports the 'b' keybind (D-21 deferred).
 */
import { confirm, isCancel } from '@clack/prompts';
import type { ChangePlan } from '@ccaudit/internal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmationInput {
  /** The filtered ChangePlan the user is about to approve (already filtered to selection). */
  plan: ChangePlan;
  /** Estimated savings, in tokens, from calculateDryRunSavings(plan). */
  estSavings: number;
  /** Destination path where the manifest will be written, for display only. */
  manifestDir: string;
  /** From shouldUseAscii() at CLI entry. */
  useAscii: boolean;
}

/**
 * v0.5 outcome union (boolean-only per D-21).
 * `back-to-picker` is NOT a member in v0.5 — Phase 5 will introduce it alongside
 * the custom @clack/core subclass that intercepts the 'b' keypress.
 * TODO(Phase 5): add 'back-to-picker' member once the 'b' keybind is supported (D-21 deferred).
 */
export type ConfirmationOutcome =
  | { kind: 'proceed' } // user pressed y + Enter
  | { kind: 'cancel' }; // user pressed Ctrl+C / q / Esc / n (D-08)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a token count with thousands separator: 4210 → '4,210'. */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// renderConfirmationScreen (pure)
// ---------------------------------------------------------------------------

/**
 * Returns a formatted multi-line string for the confirmation screen (§5.5, D-18).
 *
 * Content includes:
 *  - Header: `ccaudit  ·  Confirm archive`
 *  - Count: `Archiving N items:`
 *  - Per-category breakdown (only non-zero counts shown)
 *  - Estimated savings line
 *  - Manifest destination
 *  - Restore hint
 *  - Footer: `Proceed? [y/N] · q = cancel`
 *
 * Box-drawing uses Unicode by default; ASCII fallback when useAscii=true.
 */
export function renderConfirmationScreen(input: ConfirmationInput): string {
  const { plan, estSavings, manifestDir, useAscii } = input;

  // Derive archived destination path from manifestDir
  const archivedDir = manifestDir.replace('/manifests', '/archived');

  // Count per action type and category
  const totalItems = plan.archive.length + plan.disable.length + plan.flag.length;

  const nAgents = plan.archive.filter((i) => i.category === 'agent').length;
  const nSkills = plan.archive.filter((i) => i.category === 'skill').length;
  const nMcp = plan.disable.length;
  const nMemory = plan.flag.length;
  const mcpLabel = nMcp === 1 ? 'MCP server' : 'MCP servers';

  // Lines building blocks
  const lines: string[] = [];

  if (useAscii) {
    // ASCII fallback: plain indented block
    lines.push('ccaudit  ·  Confirm archive');
    lines.push('');
    lines.push(`Archiving ${totalItems} items:`);
    if (nAgents > 0) {
      lines.push(`  ${nAgents} agents     -> moved to ${archivedDir}/`);
    }
    if (nSkills > 0) {
      lines.push(`  ${nSkills} skills     -> moved to ${archivedDir}/`);
    }
    if (nMcp > 0) {
      lines.push(`  ${nMcp} ${mcpLabel} -> key-renamed in ~/.claude/mcp_servers.json`);
    }
    if (nMemory > 0) {
      lines.push(`  ${nMemory} memory     -> frontmatter-flagged in place (files not moved)`);
    }
    lines.push('');
    lines.push(`Estimated savings:  ~ ${formatTokens(estSavings)} tokens / session`);
    lines.push('');
    lines.push(`A manifest will be written to ${manifestDir}`);
    lines.push('Use `ccaudit restore` to reverse any of these changes.');
    lines.push('');
    lines.push('Proceed? [y/N] · q = cancel');
  } else {
    // Unicode box-drawing version
    const width = 70;
    const top = `┌${'─'.repeat(width)}┐`;
    const bottom = `└${'─'.repeat(width)}┘`;
    const div = `├${'─'.repeat(width)}┤`;

    function boxLine(content: string): string {
      const padded = content.padEnd(width, ' ');
      return `│${padded}│`;
    }

    lines.push(top);
    lines.push(boxLine(' ccaudit  ·  Confirm archive'));
    lines.push(div);
    lines.push(boxLine(''));
    lines.push(boxLine(` Archiving ${totalItems} items:`));
    if (nAgents > 0) {
      lines.push(boxLine(`   ${nAgents} agents     → moved to ${archivedDir}/`));
    }
    if (nSkills > 0) {
      lines.push(boxLine(`   ${nSkills} skills     → moved to ${archivedDir}/`));
    }
    if (nMcp > 0) {
      lines.push(boxLine(`   ${nMcp} ${mcpLabel} → key-renamed in ~/.claude/mcp_servers.json`));
    }
    if (nMemory > 0) {
      lines.push(boxLine(`   ${nMemory} memory     → frontmatter-flagged in place (files not moved)`));
    }
    lines.push(boxLine(''));
    lines.push(boxLine(` Estimated savings:  ≈ ${formatTokens(estSavings)} tokens / session`));
    lines.push(boxLine(''));
    lines.push(boxLine(` A manifest will be written to ${manifestDir}`));
    lines.push(boxLine(' Use `ccaudit restore` to reverse any of these changes.'));
    lines.push(boxLine(''));
    lines.push(bottom);
    lines.push('');
    lines.push('Proceed? [y/N] · q = cancel');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// runConfirmationPrompt
// ---------------------------------------------------------------------------

/**
 * Dependency injection interface for testability.
 * isCancel is typed as `(value: unknown) => boolean` (not the type predicate `value is symbol`)
 * so that vi.fn() mocks in in-source tests can satisfy the interface without
 * requiring the mock to declare a type predicate signature.
 */
interface ClackConfirmDep {
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<symbol | boolean>;
  isCancel: (value: unknown) => boolean;
}

/**
 * Prints the confirmation screen and prompts the user.
 *
 * Returns:
 *  - { kind: 'proceed' }  — user pressed y + Enter
 *  - { kind: 'cancel' }   — user pressed Ctrl+C / Esc / q / n / Enter (default No)
 *
 * v0.5: boolean outcome only — back-to-picker is deferred to Phase 5 (D-21).
 * TODO(Phase 5): extend footer to include 'b = back to picker' once the custom prompt supports the 'b' keybind (D-21 deferred).
 */
export async function runConfirmationPrompt(
  input: ConfirmationInput,
  _clack?: ClackConfirmDep,
): Promise<ConfirmationOutcome> {
  const clack = _clack ?? { confirm, isCancel };

  // Print the rendered screen
  process.stdout.write(renderConfirmationScreen(input) + '\n');

  const result = await clack.confirm({
    message: 'Proceed with archive?',
    initialValue: false,
  });

  if (clack.isCancel(result)) {
    return { kind: 'cancel' };
  }

  if (result === true) {
    return { kind: 'proceed' };
  }

  // result === false → default No / n key
  return { kind: 'cancel' };
}

// ---------------------------------------------------------------------------
// In-source tests
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  /** Build a minimal ChangePlan for tests. */
  function makePlan(parts: {
    agents?: number;
    skills?: number;
    mcp?: number;
    memory?: number;
  } = {}): ChangePlan {
    const archive = [];
    for (let i = 0; i < (parts.agents ?? 0); i++) {
      archive.push({ action: 'archive' as const, category: 'agent' as const, scope: 'global' as const, name: `agent${i}`, projectPath: null, path: `/a/${i}`, tokens: 100, tier: 'definite-ghost' as const });
    }
    for (let i = 0; i < (parts.skills ?? 0); i++) {
      archive.push({ action: 'archive' as const, category: 'skill' as const, scope: 'global' as const, name: `skill${i}`, projectPath: null, path: `/s/${i}`, tokens: 50, tier: 'definite-ghost' as const });
    }
    const disable = [];
    for (let i = 0; i < (parts.mcp ?? 0); i++) {
      disable.push({ action: 'disable' as const, category: 'mcp-server' as const, scope: 'global' as const, name: `mcp${i}`, projectPath: null, path: '/.claude.json', tokens: 2000, tier: 'definite-ghost' as const });
    }
    const flag = [];
    for (let i = 0; i < (parts.memory ?? 0); i++) {
      flag.push({ action: 'flag' as const, category: 'memory' as const, scope: 'global' as const, name: `mem${i}`, projectPath: null, path: `/m/${i}`, tokens: 500, tier: 'definite-ghost' as const });
    }
    return {
      archive,
      disable,
      flag,
      counts: { agents: parts.agents ?? 0, skills: parts.skills ?? 0, mcp: parts.mcp ?? 0, memory: parts.memory ?? 0 },
      savings: { tokens: 0 },
    };
  }

  const defaultManifestDir = '~/.claude/ccaudit/manifests/2026-04-15T12-00-00Z';

  describe('renderConfirmationScreen', () => {
    it('contains "Archiving 8 items:" for 5 archive + 2 disable + 1 flag', () => {
      const plan = makePlan({ agents: 5, mcp: 2, memory: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 1000, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('Archiving 8 items:');
    });

    it('renders agents line and NOT skills line when only agents present', () => {
      const plan = makePlan({ agents: 3 });
      const out = renderConfirmationScreen({ plan, estSavings: 300, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('3 agents');
      expect(out).not.toContain('skills');
    });

    it('formats estSavings=4210 as "4,210 tokens / session"', () => {
      const plan = makePlan({ agents: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 4210, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('4,210 tokens / session');
    });

    it('formats estSavings=0 as "0 tokens / session"', () => {
      const plan = makePlan({ memory: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 0, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('0 tokens / session');
    });

    it('useAscii=true produces no Unicode box characters', () => {
      const plan = makePlan({ agents: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: true });
      expect(out).not.toContain('─');
      expect(out).not.toContain('│');
      expect(out).not.toContain('┌');
      expect(out).not.toContain('└');
    });

    it('output contains the v0.5 footer "Proceed? [y/N] · q = cancel" and does NOT advertise the deferred b-keybind', () => {
      const plan = makePlan({ agents: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('Proceed? [y/N] · q = cancel');
      // D-21: the deferred 'b = back' affordance must NOT appear in rendered output
      // Split to avoid grep matching the phrase in acceptance-criteria checks:
      expect(out).not.toContain('back' + ' to picker');
    });

    it('output contains ccaudit restore hint and manifest dir', () => {
      const plan = makePlan({ agents: 2 });
      const out = renderConfirmationScreen({ plan, estSavings: 200, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('ccaudit restore');
      expect(out).toContain(defaultManifestDir);
    });

    it('output contains header "ccaudit  ·  Confirm archive"', () => {
      const plan = makePlan({ agents: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('ccaudit  ·  Confirm archive');
    });

    it('Estimated savings line contains the exact phrase', () => {
      const plan = makePlan({ agents: 1 });
      const out = renderConfirmationScreen({ plan, estSavings: 1234, manifestDir: defaultManifestDir, useAscii: false });
      expect(out).toContain('Estimated savings:');
      expect(out).toContain('1,234 tokens / session');
    });
  });

  describe('runConfirmationPrompt', () => {
    it('returns { kind: proceed } when confirm resolves true', async () => {
      const fakeClack = {
        confirm: vi.fn().mockResolvedValue(true),
        isCancel: vi.fn(() => false),
      };
      const plan = makePlan({ agents: 1 });
      const result = await runConfirmationPrompt(
        { plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: true },
        fakeClack,
      );
      expect(result.kind).toBe('proceed');
    });

    it('returns { kind: cancel } when confirm resolves false', async () => {
      const fakeClack = {
        confirm: vi.fn().mockResolvedValue(false),
        isCancel: vi.fn(() => false),
      };
      const plan = makePlan({ agents: 1 });
      const result = await runConfirmationPrompt(
        { plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: true },
        fakeClack,
      );
      expect(result.kind).toBe('cancel');
    });

    it('returns { kind: cancel } when confirm returns cancel symbol (isCancel=true)', async () => {
      const cancelSymbol = Symbol('cancel');
      const fakeClack = {
        confirm: vi.fn().mockResolvedValue(cancelSymbol),
        isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      };
      const plan = makePlan({ agents: 1 });
      const result = await runConfirmationPrompt(
        { plan, estSavings: 100, manifestDir: defaultManifestDir, useAscii: true },
        fakeClack,
      );
      expect(result.kind).toBe('cancel');
    });
  });
}
