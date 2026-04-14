/**
 * Shared test helpers for ccaudit integration tests (Phase 0).
 * tmpHome scaffolding + subprocess runner + JSONL reader.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ccauditBin = path.resolve(here, '..', '..', 'dist', 'index.js');

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface RunOpts {
  /** Extra env vars merged on top of HOME/USERPROFILE/XDG_CONFIG_HOME/NO_COLOR. */
  env?: Record<string, string>;
  cwd?: string;
  /** Kill timeout in ms (default 30 000). */
  timeout?: number;
}

/** Create a fresh tmp directory for use as HOME in a single test. */
export function makeTmpHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ccaudit-test-'));
}

/** Remove a tmpHome created by makeTmpHome. Safe if already gone. */
export function cleanupTmpHome(p: string): Promise<void> {
  return rm(p, { recursive: true, force: true });
}

/**
 * Spawn the ccaudit CLI as a subprocess with HOME overridden to tmpHome.
 * Wired exactly like dry-run-command.test.ts:36: HOME, USERPROFILE,
 * XDG_CONFIG_HOME, and NO_COLOR=1 are always set.
 */
export function runCcauditCli(
  tmpHome: string,
  argv: string[],
  opts: RunOpts = {},
): Promise<CliResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ccauditBin, ...argv], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        ...opts.env,
      },
      cwd: opts.cwd ?? tmpHome,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const ms = opts.timeout ?? 30_000;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runCcauditCli timed out after ${ms}ms\n` +
            `stdout:\n${stdout.slice(-1000)}\n` +
            `stderr:\n${stderr.slice(-1000)}`,
        ),
      );
    }, ms);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (!killed) resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - start });
    });

    child.stdin.end();
  });
}

/**
 * Read a JSONL file and return an array of parsed objects, skipping blank lines.
 */
export async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
