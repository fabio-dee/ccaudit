/**
 * MCP regime detection and deferred-tools math.
 *
 * Claude Code >=2.1.7 auto-enables ToolSearch (deferred tools) when the MCP
 * tool schemas exceed 10% of the context window. In deferred mode, each tool
 * costs ~15 tokens instead of ~500 — a 77 K -> 8.7 K collapse for heavy MCP
 * users. This module detects the installed cc version and resolves the correct
 * regime so the enrichment pipeline can apply accurate per-tool costs.
 *
 * 'unknown' is behaviorally equivalent to 'eager' (pessimistic fallback).
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export type McpRegime = 'eager' | 'deferred' | 'unknown';

/**
 * Tiny semver comparator. Returns negative / 0 / positive like Array.sort.
 * Strips pre-release suffixes (e.g. '2.1.7-beta.1' -> '2.1.7').
 */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

/**
 * Returns true if version is a parseable X.Y.Z string.
 */
function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version);
}

/**
 * Attempt to detect the installed Claude Code version.
 *
 * Priority order:
 * 1. `claude --version` (500 ms timeout, AbortController kill).
 * 2. Fallback: `npm root -g` -> read `@anthropic-ai/claude-code/package.json`.
 * 3. Returns null on any failure — never throws.
 *
 * Note: uses execFile (not exec) to prevent shell injection. Input is fully
 * static (no user-supplied arguments), so there is no injection risk, but
 * execFile is the correct primitive for subprocess invocation regardless.
 */
export async function detectClaudeCodeVersion(): Promise<string | null> {
  // Attempt 1: claude --version
  try {
    const ac = new AbortController();
    const killTimer = setTimeout(() => ac.abort(), 600); // slight buffer over 500ms
    try {
      const { stdout } = await execFile('claude', ['--version'], {
        timeout: 500,
        signal: ac.signal,
      });
      const match = /(\d+\.\d+\.\d+)/.exec(stdout);
      if (match) return match[1]!;
    } finally {
      clearTimeout(killTimer);
    }
  } catch {
    // ENOENT, timeout, abort -- fall through to attempt 2
  }

  // Attempt 2: npm root -g -> read package.json
  try {
    const { stdout: npmRoot } = await execFile('npm', ['root', '-g'], { timeout: 5000 });
    const globalRoot = npmRoot.trim();
    if (!globalRoot) return null;

    const pkgPath = `${globalRoot}/@anthropic-ai/claude-code/package.json`;
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    const version = parsed.version;
    if (typeof version === 'string' && isValidSemver(version)) {
      return version.split('-')[0]!; // strip any pre-release suffix
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the MCP regime to use for token estimation.
 *
 * Priority order:
 * 1. Explicit override (--regime flag) always wins.
 * 2. ccVersion >= 2.1.7 AND totalMcpToolTokens > 10% of contextWindow -> deferred.
 * 3. ccVersion >= 2.1.7 AND tokens <= 10% -> eager (ToolSearch not triggered).
 * 4. ccVersion < 2.1.7 -> eager (deferred tools not available).
 * 5. ccVersion null -> unknown (treated as eager, pessimistic).
 */
export function resolveMcpRegime(inputs: {
  totalMcpToolTokens: number;
  contextWindow: number;
  ccVersion: string | null;
  override: McpRegime | null;
}): { regime: McpRegime; reason: string } {
  const { totalMcpToolTokens, contextWindow, ccVersion, override } = inputs;

  // Rule 1: explicit override wins
  if (override !== null) {
    return { regime: override, reason: 'explicit --regime flag' };
  }

  // Rule 2-5: version-based resolution
  if (ccVersion !== null && isValidSemver(ccVersion)) {
    const threshold = 0.1 * contextWindow;
    if (compareSemver(ccVersion, '2.1.7') >= 0) {
      if (totalMcpToolTokens > threshold) {
        return {
          regime: 'deferred',
          reason: 'cc >=2.1.7 and MCP >10% ctx — ToolSearch auto-enabled',
        };
      }
      return {
        regime: 'eager',
        reason: 'cc >=2.1.7 but MCP <=10% ctx — ToolSearch not triggered',
      };
    }
    return { regime: 'eager', reason: 'cc <2.1.7 — deferred tools not available' };
  }

  // ccVersion null or not parseable -> unknown
  return {
    regime: 'unknown',
    reason: 'cc version unavailable — treated as eager (pessimistic)',
  };
}

/**
 * Per-tool token cost for the given regime.
 * - eager: 500 tokens (full schema injected into context)
 * - deferred: 15 tokens (only name+short-description via ToolSearch registry)
 * - unknown: 500 tokens (pessimistic, treated as eager)
 */
export function perToolTokens(regime: McpRegime): number {
  return regime === 'deferred' ? 15 : 500;
}

/**
 * Flat overhead added by the ToolSearch mechanism itself.
 * - deferred: 1700 tokens (200 ToolSearch metadata + ~1500 instruction tokens)
 * - eager / unknown: 0 (no ToolSearch mechanism active)
 */
export function regimeFlatOverhead(regime: McpRegime): number {
  return regime === 'deferred' ? 1700 : 0;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('compareSemver (internal via resolveMcpRegime)', () => {
    it('2.1.7 equals 2.1.7 — boundary at-version resolves correctly', () => {
      // At exactly 2.1.7 with tokens > 10% => deferred
      const { regime } = resolveMcpRegime({
        totalMcpToolTokens: 21_000,
        contextWindow: 200_000,
        ccVersion: '2.1.7',
        override: null,
      });
      expect(regime).toBe('deferred');
    });

    it('2.1.7-beta.1 treated as 2.1.7 for comparison (pre-release stripped)', () => {
      // beta.1 of 2.1.7 should still be >= 2.1.7 for our purposes
      const { regime } = resolveMcpRegime({
        totalMcpToolTokens: 21_000,
        contextWindow: 200_000,
        ccVersion: '2.1.7-beta.1',
        override: null,
      });
      expect(regime).toBe('deferred');
    });
  });

  describe('resolveMcpRegime', () => {
    const ctx = { contextWindow: 200_000 };

    it('override=eager wins over version implying deferred', () => {
      const { regime, reason } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 25_000, // >10% of 200k
        ccVersion: '2.2.0',
        override: 'eager',
      });
      expect(regime).toBe('eager');
      expect(reason).toBe('explicit --regime flag');
    });

    it('override=deferred wins even when version is old', () => {
      const { regime } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 100,
        ccVersion: '1.0.0',
        override: 'deferred',
      });
      expect(regime).toBe('deferred');
    });

    it('ccVersion null -> unknown with correct reason', () => {
      const { regime, reason } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 0,
        ccVersion: null,
        override: null,
      });
      expect(regime).toBe('unknown');
      expect(reason).toContain('unavailable');
    });

    it('ccVersion 2.2.0 + tokens=25000 (>10% of 200k) -> deferred', () => {
      const { regime } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 25_000,
        ccVersion: '2.2.0',
        override: null,
      });
      expect(regime).toBe('deferred');
    });

    it('ccVersion 2.2.0 + tokens=5000 (<=10% of 200k) -> eager', () => {
      const { regime } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 5_000,
        ccVersion: '2.2.0',
        override: null,
      });
      expect(regime).toBe('eager');
    });

    it('ccVersion 2.0.5 + tokens=50000 -> eager (pre-2.1.7)', () => {
      const { regime, reason } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 50_000,
        ccVersion: '2.0.5',
        override: null,
      });
      expect(regime).toBe('eager');
      expect(reason).toContain('<2.1.7');
    });

    it('gibberish version string -> unknown', () => {
      const { regime } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 30_000,
        ccVersion: 'not-a-version',
        override: null,
      });
      expect(regime).toBe('unknown');
    });

    it('tokens exactly at threshold (=10%) -> eager (threshold is strict >)', () => {
      const { regime } = resolveMcpRegime({
        ...ctx,
        totalMcpToolTokens: 20_000, // exactly 10% of 200k, not > threshold
        ccVersion: '2.2.0',
        override: null,
      });
      expect(regime).toBe('eager');
    });
  });

  describe('perToolTokens', () => {
    it('eager -> 500', () => expect(perToolTokens('eager')).toBe(500));
    it('deferred -> 15', () => expect(perToolTokens('deferred')).toBe(15));
    it('unknown -> 500', () => expect(perToolTokens('unknown')).toBe(500));
  });

  describe('regimeFlatOverhead', () => {
    it('deferred -> 1700', () => expect(regimeFlatOverhead('deferred')).toBe(1700));
    it('eager -> 0', () => expect(regimeFlatOverhead('eager')).toBe(0));
    it('unknown -> 0', () => expect(regimeFlatOverhead('unknown')).toBe(0));
  });
}
