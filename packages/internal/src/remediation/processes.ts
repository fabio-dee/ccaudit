import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Running-process detection for the `--dangerously-bust-ghosts` preflight gate.
 *
 * D-02: Spawn `ps -A -o pid=,comm=` on Unix, `tasklist /FO CSV /NH` on Windows.
 *       Any spawn failure (ENOENT, permission denied, timeout) returns a tagged
 *       `spawn-failed` result -- fail-closed policy, caller refuses the bust.
 *
 * D-03: Positive detection exits with code 3, no bypass flag.
 *
 * D-04: Self-invocation sub-case: if any detected Claude pid is in ccaudit's
 *       own parent-process chain (ccaudit was spawned from inside a Claude
 *       Code session), caller emits the "open a standalone terminal" message.
 *
 * Zero runtime deps -- uses `node:child_process.spawn` only. All real I/O is
 * behind injected `ProcessDetectorDeps` so unit tests never shell out.
 */

export interface ClaudeProcess {
  pid: number;
  command: string;
}

export type DetectResult =
  | { status: 'ok'; processes: ClaudeProcess[] }
  | { status: 'spawn-failed'; error: string };

/**
 * Conservative regex for Claude Code process name matching.
 * Matches EXACT basenames -- rejects ClaudeBar, claude-code-router, ClaudeHelper,
 * claudia, notclaude, etc.
 *
 * Empirical sources (08-RESEARCH.md section Pattern 2):
 * - macOS CLI:    "claude"          (Mach-O arm64 binary at ~/.local/bin/claude)
 * - macOS app:    "Claude"          (/Applications/Claude.app/Contents/MacOS/Claude)
 * - Windows CLI:  "claude.exe"
 * - Windows app:  "Claude.exe"
 * - Future:       "Claude Code"     (potential product name)
 *
 * Anchored with ^...$ to prevent partial matches.
 */
export const CLAUDE_NAME_REGEX = /^(claude(?:\.exe)?|Claude(?:\.exe)?|Claude Code)$/;

// Injected primitives for testability (avoid real spawn in unit tests)
export interface ProcessDetectorDeps {
  runCommand: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  getParentPid: (pid: number) => Promise<number | null>;
  platform: NodeJS.Platform;
}

/**
 * Detect Claude Code processes via ps (Unix) or tasklist (Windows).
 * Returns 'spawn-failed' on ANY spawn error -- fail-closed per D-02.
 * Excludes the self pid (caller can exclude parent chain separately via walkParentChain).
 */
export async function detectClaudeProcesses(
  selfPid: number = process.pid,
  deps: ProcessDetectorDeps = defaultDeps,
): Promise<DetectResult> {
  try {
    let raw: string;
    let processes: ClaudeProcess[];
    if (deps.platform === 'win32') {
      raw = await deps.runCommand('tasklist', ['/FO', 'CSV', '/NH'], 2000);
      processes = parseTasklistCsv(raw);
    } else {
      raw = await deps.runCommand('ps', ['-A', '-o', 'pid=,comm='], 2000);
      processes = parsePsComm(raw);
    }
    return {
      status: 'ok',
      processes: processes.filter((p) => p.pid !== selfPid),
    };
  } catch (err) {
    return { status: 'spawn-failed', error: (err as Error).message };
  }
}

/**
 * Parse Unix `ps -A -o pid=,comm=` output (no header).
 * Format: "  12345 claude" or "  12345 /path/to/claude"
 * Uses basename for matching (handles full-path comm= output on macOS).
 */
export function parsePsComm(raw: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid)) continue;
    // Take basename (handles "/path/to/claude" comm= output)
    const name = (m[2] ?? '').trim().split('/').pop() ?? '';
    if (CLAUDE_NAME_REGEX.test(name)) {
      out.push({ pid, command: name });
    }
  }
  return out;
}

/**
 * Parse Windows `tasklist /FO CSV /NH` output.
 * Format: "image","pid","session","sessionNum","memUsage"\r\n
 */
export function parseTasklistCsv(raw: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const image = fields[0]!.slice(1, -1);
    const pidStr = fields[1]!.slice(1, -1);
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) continue;
    if (CLAUDE_NAME_REGEX.test(image)) {
      out.push({ pid, command: image });
    }
  }
  return out;
}

/**
 * Walk the parent process chain starting from `startPid` up to `maxDepth` levels.
 * Stops on pid <= 1 (init), null return from getParentPid, or self-reference.
 * Returns the chain of parent pids (excluding startPid itself).
 *
 * Used by D-04 self-invocation detection: if any detected Claude pid appears
 * in the chain, the bust command emits the "open a standalone terminal" error.
 */
export async function walkParentChain(
  startPid: number,
  deps: Pick<ProcessDetectorDeps, 'getParentPid'> = defaultDeps,
  maxDepth = 16,
): Promise<number[]> {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const parent = await deps.getParentPid(pid);
    if (parent === null || parent === pid || parent <= 0) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}

// -- Default (production) deps implementation --------------------

async function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
    const child = spawn(cmd, args, opts);
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // stdio[1] is explicitly set to 'pipe' above, so child.stdout is non-null
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0 && code !== null) {
        reject(new Error(`${cmd} exited ${code}`));
        return;
      }
      resolve(out);
    });
  });
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      // wmic is deprecated on Win 11 but still available in 22H2.
      // A PowerShell fallback is tracked as a Phase 8 open spike
      // (08-RESEARCH.md -- Environment Availability).
      const raw = await runCommand(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'],
        1500,
      );
      const m = /ParentProcessId=(\d+)/.exec(raw);
      return m ? Number(m[1]) : null;
    }
    const raw = await runCommand('ps', ['-o', 'ppid=', '-p', String(pid)], 1500);
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export const defaultDeps: ProcessDetectorDeps = {
  runCommand,
  getParentPid,
  platform: process.platform,
};

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('CLAUDE_NAME_REGEX', () => {
    it('matches exact Claude binary names', () => {
      expect(CLAUDE_NAME_REGEX.test('claude')).toBe(true);
      expect(CLAUDE_NAME_REGEX.test('Claude')).toBe(true);
      expect(CLAUDE_NAME_REGEX.test('claude.exe')).toBe(true);
      expect(CLAUDE_NAME_REGEX.test('Claude.exe')).toBe(true);
      expect(CLAUDE_NAME_REGEX.test('Claude Code')).toBe(true);
    });

    it('rejects similar but distinct names', () => {
      expect(CLAUDE_NAME_REGEX.test('ClaudeBar')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('ClaudeHelper')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('claude-code-router')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('claudia')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('notclaude')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('')).toBe(false);
    });

    it('rejects partial matches even when prefix matches', () => {
      // Guard against accidental non-anchored regex regression
      expect(CLAUDE_NAME_REGEX.test('claude-desktop')).toBe(false);
      expect(CLAUDE_NAME_REGEX.test('Claude.exe.bak')).toBe(false);
    });
  });

  describe('parsePsComm', () => {
    it('parses basic pid+name lines', () => {
      const raw = '  39193 claude\n  12345 node\n  67890 Claude\n';
      expect(parsePsComm(raw)).toEqual([
        { pid: 39193, command: 'claude' },
        { pid: 67890, command: 'Claude' },
      ]);
    });

    it('handles full-path comm= via basename', () => {
      const raw = '12345 /Applications/Claude.app/Contents/MacOS/Claude\n';
      expect(parsePsComm(raw)).toEqual([{ pid: 12345, command: 'Claude' }]);
    });

    it('skips blank lines and malformed rows', () => {
      const raw = '\n\n  abc claude\n  456 claude\n';
      expect(parsePsComm(raw)).toEqual([{ pid: 456, command: 'claude' }]);
    });

    it('rejects ClaudeBar even at short pid', () => {
      expect(parsePsComm('  100 ClaudeBar\n')).toEqual([]);
    });
  });

  describe('parseTasklistCsv', () => {
    it('parses CSV rows matching Claude', () => {
      const raw =
        '"claude.exe","1234","Console","1","45,000 K"\r\n' +
        '"notepad.exe","5678","Console","1","12,000 K"\r\n' +
        '"Claude.exe","9012","Console","1","123,000 K"\r\n';
      expect(parseTasklistCsv(raw)).toEqual([
        { pid: 1234, command: 'claude.exe' },
        { pid: 9012, command: 'Claude.exe' },
      ]);
    });

    it('skips malformed rows', () => {
      const raw = '"claude.exe","notanumber","Console","1","45 K"\r\n';
      expect(parseTasklistCsv(raw)).toEqual([]);
    });

    it('handles single line without trailing CRLF', () => {
      const raw = '"claude.exe","1234","Console","1","45,000 K"';
      expect(parseTasklistCsv(raw)).toEqual([{ pid: 1234, command: 'claude.exe' }]);
    });
  });

  describe('detectClaudeProcesses', () => {
    const noParent = async () => null;

    it('returns ok with filtered Claude pids on Unix', async () => {
      const deps: ProcessDetectorDeps = {
        runCommand: async () => '  39193 claude\n  12345 node\n',
        getParentPid: noParent,
        platform: 'darwin',
      };
      const result = await detectClaudeProcesses(0, deps);
      expect(result).toEqual({ status: 'ok', processes: [{ pid: 39193, command: 'claude' }] });
    });

    it('excludes self pid from results', async () => {
      const deps: ProcessDetectorDeps = {
        runCommand: async () => '  100 claude\n  200 claude\n',
        getParentPid: noParent,
        platform: 'darwin',
      };
      const result = await detectClaudeProcesses(100, deps);
      expect(result).toEqual({ status: 'ok', processes: [{ pid: 200, command: 'claude' }] });
    });

    it('returns spawn-failed on runCommand rejection', async () => {
      const deps: ProcessDetectorDeps = {
        runCommand: async () => { throw new Error('ENOENT: ps not found'); },
        getParentPid: noParent,
        platform: 'linux',
      };
      const result = await detectClaudeProcesses(0, deps);
      expect(result.status).toBe('spawn-failed');
      if (result.status === 'spawn-failed') {
        expect(result.error).toMatch(/ENOENT/);
      }
    });

    it('returns spawn-failed on timeout', async () => {
      const deps: ProcessDetectorDeps = {
        runCommand: async () => { throw new Error('ps timed out after 2000ms'); },
        getParentPid: noParent,
        platform: 'darwin',
      };
      const result = await detectClaudeProcesses(0, deps);
      expect(result.status).toBe('spawn-failed');
      if (result.status === 'spawn-failed') {
        expect(result.error).toMatch(/timed out/);
      }
    });

    it('uses tasklist on win32', async () => {
      const calls: string[] = [];
      const deps: ProcessDetectorDeps = {
        runCommand: async (cmd) => {
          calls.push(cmd);
          return '"claude.exe","1234","Console","1","45,000 K"\r\n';
        },
        getParentPid: noParent,
        platform: 'win32',
      };
      const result = await detectClaudeProcesses(0, deps);
      expect(calls).toEqual(['tasklist']);
      expect(result).toEqual({ status: 'ok', processes: [{ pid: 1234, command: 'claude.exe' }] });
    });

    it('returns empty ok when no Claude processes present', async () => {
      const deps: ProcessDetectorDeps = {
        runCommand: async () => '  12345 node\n  67890 bash\n',
        getParentPid: noParent,
        platform: 'linux',
      };
      const result = await detectClaudeProcesses(0, deps);
      expect(result).toEqual({ status: 'ok', processes: [] });
    });
  });

  describe('walkParentChain', () => {
    it('walks chain until pid <= 1', async () => {
      const tree: Record<number, number> = { 100: 50, 50: 25, 25: 1 };
      const deps = {
        runCommand: async () => '',
        getParentPid: async (pid: number) => tree[pid] ?? null,
        platform: 'linux' as NodeJS.Platform,
      };
      const chain = await walkParentChain(100, deps);
      expect(chain).toEqual([50, 25, 1]);
    });

    it('stops at maxDepth', async () => {
      const deps = {
        runCommand: async () => '',
        getParentPid: async (pid: number) => pid - 1,
        platform: 'linux' as NodeJS.Platform,
      };
      const chain = await walkParentChain(100, deps, 5);
      expect(chain).toHaveLength(5);
    });

    it('stops on null parent', async () => {
      const deps = {
        runCommand: async () => '',
        getParentPid: async () => null,
        platform: 'linux' as NodeJS.Platform,
      };
      expect(await walkParentChain(100, deps)).toEqual([]);
    });

    it('breaks on self-reference', async () => {
      const deps = {
        runCommand: async () => '',
        getParentPid: async () => 100,
        platform: 'linux' as NodeJS.Platform,
      };
      expect(await walkParentChain(100, deps)).toEqual([]);
    });

    it('d-04: detects Claude pid in parent chain', async () => {
      // Simulate: we are pid 999, bash is 500, claude is 300, launchd is 1
      const tree: Record<number, number> = { 999: 500, 500: 300, 300: 1 };
      const deps = {
        runCommand: async () => '',
        getParentPid: async (pid: number) => tree[pid] ?? null,
        platform: 'darwin' as NodeJS.Platform,
      };
      const chain = await walkParentChain(999, deps);
      expect(chain).toEqual([500, 300, 1]);
      // Caller: check if any detectedClaudePids overlap with this chain
      const claudePids = new Set([300]);
      const fromClaude = chain.some((p) => claudePids.has(p));
      expect(fromClaude).toBe(true);
    });
  });
}
