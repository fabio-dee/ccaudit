/**
 * tmux-backed E2E driver for manual-QA-style interactive tests.
 *
 * This helper is intentionally optional: tests should skip when `tmux` is not
 * installed or on platforms where tmux is unavailable. It gives us a pragmatic
 * middle ground between pure stdin pipes and true human QA: real terminal size,
 * real key events, pane capture, and SIGWINCH via `tmux resize-window`.
 *
 * It does NOT replace macOS Terminal.app GUI checks (drag resize, font zoom,
 * green-dot maximize), but it can cover most picker flows from
 * ccaudit-manual-tests.txt: tab navigation, Space/Enter/Esc, help overlay,
 * pagination, filter/sort, and archive/restore confirmation.
 */
import { execFile as execFileCb } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface TmuxRunResult {
  stdout: string;
  stderr: string;
}

export interface StartTmuxE2EOpts {
  /** Unique tmux session name. Existing session is killed by default. */
  name: string;
  /** Command argv to run inside the pane. */
  command: readonly string[];
  /** Working directory for the command. */
  cwd: string;
  /** Directory where the generated runner script is written. */
  tmpDir: string;
  /** Env vars exported before the command runs. Defaults to process.env passthrough for unspecified keys. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Initial pane width. */
  width?: number;
  /** Initial pane height. */
  height?: number;
  /** Keep pane alive after command exit so tests can capture final output. Defaults to 2s. */
  afterExitSleepMs?: number;
  /** Kill an existing session with the same name before starting. Defaults to true. */
  killExisting?: boolean;
}

export interface WaitForTextOpts {
  /** Poll timeout. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Poll interval. Defaults to 100ms. */
  intervalMs?: number;
  /** Capture scrollback start. Defaults to -200. */
  startLine?: number;
  /** Strip ANSI before matching. Defaults to true. */
  stripAnsi?: boolean;
}

export interface SendKeysOpts {
  /** Delay after each key. Defaults to 75ms. */
  delayMs?: number;
}

export interface CaptureOpts {
  /** Start line for capture-pane. Defaults to -200. */
  startLine?: number;
  /** Preserve ANSI escape codes. Defaults to false. */
  ansi?: boolean;
}

export const TMUX_KEYS = {
  enter: 'Enter',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backTab: 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
  home: 'Home',
  end: 'End',
  ctrlC: 'C-c',
} as const;

export class TmuxE2ESession {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async sendKeys(keys: readonly string[], opts: SendKeysOpts = {}): Promise<void> {
    const delayMs = opts.delayMs ?? 75;
    for (const key of keys) {
      await tmux(['send-keys', '-t', this.name, key]);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  async sendLiteral(text: string, opts: SendKeysOpts = {}): Promise<void> {
    await tmux(['send-keys', '-t', this.name, '-l', text]);
    const delayMs = opts.delayMs ?? 75;
    if (delayMs > 0) await sleep(delayMs);
  }

  async resize(width: number, height: number): Promise<void> {
    await tmux(['resize-window', '-t', this.name, '-x', String(width), '-y', String(height)]);
  }

  async capture(opts: CaptureOpts = {}): Promise<string> {
    const args = ['capture-pane', '-t', this.name, '-p', '-S', String(opts.startLine ?? -200)];
    if (opts.ansi === true) args.splice(3, 0, '-e');
    const { stdout } = await tmux(args);
    return opts.ansi === true ? stdout : stripAnsi(stdout);
  }

  async isAlive(): Promise<boolean> {
    try {
      await tmux(['has-session', '-t', this.name]);
      return true;
    } catch {
      return false;
    }
  }

  async kill(): Promise<void> {
    try {
      await tmux(['kill-session', '-t', this.name]);
    } catch {
      // Already gone.
    }
  }

  async waitForText(needle: string | RegExp, opts: WaitForTextOpts = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const intervalMs = opts.intervalMs ?? 100;
    const start = Date.now();
    let lastCapture = '';
    while (Date.now() - start <= timeoutMs) {
      const raw = await this.capture({
        startLine: opts.startLine ?? -200,
        ansi: opts.stripAnsi === false,
      });
      lastCapture = opts.stripAnsi === false ? raw : stripAnsi(raw);
      const matched =
        typeof needle === 'string' ? lastCapture.includes(needle) : needle.test(lastCapture);
      if (matched) return lastCapture;
      await sleep(intervalMs);
    }
    throw new Error(
      `Timed out waiting for ${String(needle)} in tmux session ${this.name}\n` +
        `Last capture:\n${lastCapture.slice(-2000)}`,
    );
  }
}

export async function hasTmux(): Promise<boolean> {
  try {
    await tmux(['-V']);
    return true;
  } catch {
    return false;
  }
}

export async function startTmuxE2E(opts: StartTmuxE2EOpts): Promise<TmuxE2ESession> {
  if (opts.command.length === 0) {
    throw new Error('startTmuxE2E: command must not be empty');
  }

  const session = new TmuxE2ESession(opts.name);
  if (opts.killExisting ?? true) await session.kill();

  const runnerPath = path.join(opts.tmpDir, `${opts.name}.tmux-runner.sh`);
  await writeFile(runnerPath, buildRunnerScript(opts), 'utf8');
  await chmod(runnerPath, 0o755);

  await tmux([
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-x',
    String(opts.width ?? 120),
    '-y',
    String(opts.height ?? 30),
    runnerPath,
  ]);
  return session;
}

export function stripAnsi(s: string): string {
  /* eslint-disable no-control-regex -- ANSI/OSC stripping intentionally matches ESC/BEL bytes. */
  return s
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n');
  /* eslint-enable no-control-regex */
}

function buildRunnerScript(opts: StartTmuxE2EOpts): string {
  const envLines = Object.entries(opts.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  const command = opts.command.map(shellQuote).join(' ');
  const sleepSeconds = Math.max(0, (opts.afterExitSleepMs ?? 2_000) / 1_000);

  return `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(opts.cwd)}
${envLines}
${command}
status=$?
printf '\n__CCAUDIT_TMUX_EXIT:%s__\n' "$status"
sleep ${sleepSeconds}
exit "$status"
`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function tmux(args: readonly string[]): Promise<TmuxRunResult> {
  const { stdout, stderr } = await execFile('tmux', [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
