/**
 * Shared test helpers for ccaudit integration tests (Phase 0 + Phase 3 + Phase 3.1).
 * tmpHome scaffolding + subprocess runner + JSONL reader + Phase 3 fixtures +
 * Phase 3.1 tabbed-picker key-injection helpers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, utimes, readdir } from 'node:fs/promises';
import { canonicalItemId } from '@ccaudit/internal';
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

// ── Phase 3 helpers ────────────────────────────────────────────────────────

const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit Phase 3 safety-invariant tests.
# Handles both \`ps -A -o pid=,comm=\` (system listing) and
# \`ps -o ppid= -p <pid>\` (parent chain walk).
case "$*" in
  *-A*)
    echo "    1 init"
    ;;
  *-o\\ ppid=*)
    echo "1"
    ;;
  *)
    echo "    1 init"
    ;;
esac
`;

/** Install a fake \`ps\` shim into <tmpHome>/bin/ps. Returns the binDir path. */
export async function buildFakePs(tmpHome: string): Promise<string> {
  const binDir = path.join(tmpHome, 'bin');
  await mkdir(binDir, { recursive: true });
  const psPath = path.join(binDir, 'ps');
  await writeFile(psPath, FAKE_PS_SCRIPT, 'utf8');
  await chmod(psPath, 0o755);
  return binDir;
}

/** Result type returned by the live ChildProcess from runCcauditGhost. */
export interface SpawnedGhost {
  child: ChildProcess;
  /** Resolves when the child exits or is killed. */
  done: Promise<CliResult>;
}

/**
 * Spawn `ccaudit ghost <flags>` as a subprocess. Unlike runCcauditCli (which
 * resolves only after exit), this returns the live ChildProcess so callers
 * can send signals (SIGINT for INV-S2). The `done` promise resolves with the
 * usual {stdout, stderr, exitCode, durationMs} once the child exits.
 *
 * Default env: HOME, USERPROFILE, XDG_CONFIG_HOME, NO_COLOR=1, TZ=UTC,
 * PATH=<tmpHome>/bin (the fake-ps dir). Caller can overlay extra vars via opts.env.
 */
export function runCcauditGhost(
  tmpHome: string,
  flags: string[],
  opts: RunOpts = {},
): SpawnedGhost {
  const start = Date.now();
  const child = spawn(process.execPath, [ccauditBin, 'ghost', ...flags], {
    env: {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      NO_COLOR: '1',
      TZ: 'UTC',
      PATH: path.join(tmpHome, 'bin'),
      ...opts.env,
    },
    cwd: opts.cwd ?? tmpHome,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let killed = false;
  const ms = opts.timeout ?? 30_000;

  const done = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runCcauditGhost timed out after ${ms}ms\nstdout:\n${stdout.slice(-500)}\nstderr:\n${stderr.slice(-500)}`,
        ),
      );
    }, ms);
    child.stdout!.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      // Resolve in both killed and non-killed cases so callers always get output.
      void killed;
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - start });
    });
  });
  // Do NOT end stdin automatically — INV-S2 test may want to send signals first.
  return { child, done };
}

/**
 * Write a `~/.claude.json` containing exactly two MCP servers (serverA, serverB)
 * under the global `mcpServers` nested schema. The serialized JSON deliberately
 * uses 2-space indentation, a specific key order (serverA before serverB), and
 * a trailing newline — so the byte-preservation invariant (INV-S1) is testable:
 * a naive JSON.parse → JSON.stringify round-trip would NOT produce byte-identical
 * output (key order / trailing newline differ).
 *
 * Returns the absolute path to the .claude.json file written.
 */
export async function createMcpFixture(tmpHome: string): Promise<string> {
  // Hand-crafted JSON with deliberate formatting:
  //  - 2-space indent
  //  - serverA defined BEFORE serverB (key order matters for byte-identity)
  //  - file ends with a newline (JSON.stringify omits this by default)
  const body =
    '{\n' +
    '  "mcpServers": {\n' +
    '    "serverA": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["server-a"]\n' +
    '    },\n' +
    '    "serverB": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["server-b", "--port", "9999"]\n' +
    '    }\n' +
    '  }\n' +
    '}\n';
  const target = path.join(tmpHome, '.claude.json');
  await writeFile(target, body, 'utf8');
  return target;
}

/**
 * Build a fixture where the GSD framework is "partially-used":
 *  - 1 USED gsd-planner.md (recent mtime + session JSONL Task tool invocation)
 *  - 2 GHOST gsd-*.md (mtime 60 days ago → definite-ghost)
 *  - empty .claude.json
 *  - minimal session JSONL with a Task subagent_type='gsd-planner' invocation
 *
 * This setup makes the GSD framework's status='partially-used' so
 * applyFrameworkProtection() locks the 2 ghosts unless --force-partial.
 *
 * Caller must invoke `await buildFakePs(tmpHome)` separately if subprocess
 * tests need the running-Claude preflight to pass.
 */
export async function createFrameworkFixture(tmpHome: string): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const xdgDir = path.join(tmpHome, '.config', 'claude');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(xdgDir, { recursive: true });

  // 1 USED gsd-planner — recent mtime
  await writeFile(path.join(agentsDir, 'gsd-planner.md'), '# gsd-planner agent\n', 'utf8');

  // 2 GHOST gsd-* — 60-day-old mtime
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  for (const name of ['gsd-researcher.md', 'gsd-verifier.md']) {
    const p = path.join(agentsDir, name);
    await writeFile(p, `# ${name}\n`, 'utf8');
    await utimes(p, sixtyDaysAgo, sixtyDaysAgo);
  }

  // Empty .claude.json
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

  // Session JSONL with a Task subagent_type='gsd-planner' invocation
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
  await mkdir(sessionDir, { recursive: true });
  const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sessionLines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/project',
      timestamp: recentTs,
      sessionId: 'phase3-fwk',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: recentTs,
      sessionId: 'phase3-fwk',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Task',
            input: { subagent_type: 'gsd-planner', prompt: 'plan something' },
          },
        ],
      },
    }),
  ];
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLines.join('\n') + '\n', 'utf8');
}

/**
 * Return the sorted basenames inside <tmpHome>/.claude/ccaudit/manifests/.
 * Returns [] if the directory does not exist (INV-S2 baseline + post-abort check).
 */
export async function listManifestsDir(tmpHome: string): Promise<string[]> {
  const dir = path.join(tmpHome, '.claude', 'ccaudit', 'manifests');
  try {
    const entries = await readdir(dir);
    return entries.sort();
  } catch {
    return [];
  }
}

/**
 * Read <tmpHome>/.claude.json as raw bytes (NOT JSON.parse). INV-S1 asserts
 * that the unselected MCP server's key + surrounding formatting are
 * byte-identical post-bust, so the test must compare bytes, not parsed JSON.
 */
export function readMcpConfigBytes(tmpHome: string): Promise<Buffer> {
  return readFile(path.join(tmpHome, '.claude.json'));
}

/** Compute the canonical id for a global agent at <tmpHome>/.claude/agents/<fileName>. */
export function agentItemId(tmpHome: string, fileName: string): string {
  return canonicalItemId({
    name: path.basename(fileName, '.md'),
    path: path.join(tmpHome, '.claude', 'agents', fileName),
    scope: 'global',
    category: 'agent',
    projectPath: null,
  });
}

/**
 * Compute the canonical id for a global command .md file at
 * `<tmpHome>/.claude/commands/<relPath>`, matching the scanner's
 * resolveCommandName behavior (namespace-separator `:`).
 *
 * Example:
 *   commandItemId(tmpHome, 'sc/build.md', 'sc:build')
 *   → canonical id for {category:'command', scope:'global', name:'sc:build', path:<abs>}
 */
export function commandItemId(tmpHome: string, relPath: string, name: string): string {
  return canonicalItemId({
    name,
    path: path.join(tmpHome, '.claude', 'commands', relPath),
    scope: 'global',
    category: 'command',
    projectPath: null,
  });
}

// ── Phase 3.1 helpers (tabbed-picker integration tests) ───────────────────

/**
 * Write key bytes to a spawned ccaudit picker's stdin with a small inter-key delay.
 *
 * The picker blocks on stdin inside @clack/core's readline loop; writes are processed
 * asynchronously by the base class. A small delay between each keystroke lets the TUI
 * re-render so the next key is applied to the post-render state.
 *
 * Key-byte reference:
 *
 *     Tab         → '\t'
 *     Shift-Tab   → '\x1b[Z'
 *     ArrowUp     → '\x1b[A'
 *     ArrowDown   → '\x1b[B'
 *     ArrowRight  → '\x1b[C'
 *     ArrowLeft   → '\x1b[D'
 *     Enter       → '\r'
 *     Space       → ' '
 *     Esc         → '\x1b'
 *     Ctrl-C      → '\x03'
 *     PageUp      → '\x1b[5~'
 *     PageDown    → '\x1b[6~'
 *     Home        → '\x1b[H'
 *     End         → '\x1b[F'
 *
 * @param child   Live ChildProcess returned by {@link runCcauditGhost}.
 * @param keys    Ordered key byte sequences to transmit.
 * @param delayMs Per-keystroke delay in milliseconds (default 75).
 */
export async function sendKeys(
  child: ChildProcess,
  keys: readonly string[],
  delayMs = 75,
): Promise<void> {
  for (const k of keys) {
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error('sendKeys: child stdin is not available or already destroyed');
    }
    child.stdin.write(k);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Scaffold N ghost agents under `<tmpHome>/.claude/agents/` named
 * `agent-01.md` through `agent-NN.md` (zero-padded to 2 digits). Also seeds:
 *   - empty `.claude.json`
 *   - one minimal session jsonl (so discoverSessionFiles returns ≥1 file)
 *
 * Caller is responsible for {@link buildFakePs} if the subprocess needs the
 * running-Claude preflight to pass.
 *
 * Note: callers needing >99 ghosts should pass count ≤ 99 OR swap the `padStart(2,'0')`
 * for a wider width. The 60-ghost overflow regression test (Phase 3.1 Plan 04
 * Task 2) uses 60, comfortably inside the two-digit range.
 */
export async function buildManyGhostsFixture(tmpHome: string, count: number): Promise<void> {
  if (count < 1 || count > 99) {
    throw new Error(`buildManyGhostsFixture: count must be 1..99 (got ${count})`);
  }
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });

  // N agents named agent-01..agent-NN with minimal content.
  for (let i = 1; i <= count; i++) {
    const name = `agent-${String(i).padStart(2, '0')}`;
    await writeFile(path.join(agentsDir, `${name}.md`), `# ${name}\nunused\n`, 'utf8');
  }

  // Empty .claude.json so the scanner doesn't fail loading MCP servers.
  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

  // Minimal session jsonl — discoverSessionFiles requires ≥1 file.
  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'many-ghosts-project');
  await mkdir(sessionDir, { recursive: true });
  const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(
    path.join(sessionDir, 'session-1.jsonl'),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/many-ghosts',
      timestamp: recentTs,
      sessionId: 'many-ghosts-session',
    }) + '\n',
    'utf8',
  );
}

/**
 * Compute the canonical id for a GLOBAL MCP server defined in <tmpHome>/.claude.json
 * under `mcpServers.<serverName>`. Mirrors the scanner's MCP InventoryItem shape:
 *   path = <tmpHome>/.claude.json (the source config file)
 *   scope = 'global', projectPath = null, name = serverName.
 */
export function mcpItemId(tmpHome: string, serverName: string): string {
  return canonicalItemId({
    name: serverName,
    path: path.join(tmpHome, '.claude.json'),
    scope: 'global',
    category: 'mcp-server',
    projectPath: null,
  });
}

// ── Phase 6 helpers (multi-framework + multi-config MCP fixtures) ─────────

export interface MultiFrameworkSpec {
  /**
   * Curated framework prefix used to generate agent filenames
   * (`<prefix>-<suffix>.md`). Must match a `KNOWN_FRAMEWORKS` id (e.g. `gsd`
   * or `sc`) so the scanner attaches `framework: <id>`.
   */
  prefix: string;
  /** Agent file suffixes that should be classified as USED. */
  usedMembers: readonly string[];
  /** Agent file suffixes that should be classified as GHOST (60d mtime). */
  ghostMembers: readonly string[];
  /**
   * When the `prefix` is a session-tool name different from the agent
   * subagent_type, override it here. Default is `<prefix>-<usedMembers[0]>`.
   */
  sessionSubagent?: string;
}

/**
 * Build a tmp home containing N curated-framework groups, each with mixed
 * used/ghost membership so `applyFrameworkProtection` classifies them as
 * `partially-used`. Designed for Phase 6 SC1/SC4 integration tests.
 *
 * Caller is responsible for {@link buildFakePs} if the subprocess needs the
 * preflight to pass.
 */
export async function createMultiFrameworkFixture(
  tmpHome: string,
  frameworks: readonly MultiFrameworkSpec[],
): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const xdgDir = path.join(tmpHome, '.config', 'claude');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(xdgDir, { recursive: true });

  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Per-framework used + ghost files, plus a per-framework session JSONL
  // invoking the used subagent so the scanner classifies it as used.
  const sessionLines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/fake/multi-fwk',
      timestamp: recentTs,
      sessionId: 'multi-fwk',
    }),
  ];

  let toolCounter = 1;
  for (const fw of frameworks) {
    for (const suffix of fw.usedMembers) {
      const name = `${fw.prefix}-${suffix}`;
      await writeFile(path.join(agentsDir, `${name}.md`), `# ${name} used\n`, 'utf8');
      sessionLines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: recentTs,
          sessionId: 'multi-fwk',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `t${toolCounter++}`,
                name: 'Task',
                input: { subagent_type: name, prompt: 'do work' },
              },
            ],
          },
        }),
      );
    }
    for (const suffix of fw.ghostMembers) {
      const name = `${fw.prefix}-${suffix}`;
      const p = path.join(agentsDir, `${name}.md`);
      await writeFile(p, `# ${name} ghost\n`, 'utf8');
      await utimes(p, sixtyDaysAgo, sixtyDaysAgo);
    }
  }

  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf8');

  const sessionDir = path.join(tmpHome, '.claude', 'projects', 'multi-fwk');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLines.join('\n') + '\n', 'utf8');
}

export interface MultiConfigMcpFixtureOpts {
  /** Absolute path to the tmp HOME. */
  home: string;
  /**
   * Absolute project root (defaults to `<home>/project`). A `.mcp.json` is
   * written here when `alsoInProjectLocal` is true.
   */
  projectRoot?: string;
  /** MCP server key that will appear in multiple config files. */
  sharedKey: string;
  /** When true, write `sharedKey` into `<projectRoot>/.mcp.json`. */
  alsoInProjectLocal?: boolean;
  /**
   * When true, write `sharedKey` into `~/.claude/settings.json` under
   * `mcpServers`. (Note: the ccaudit scanner reads `~/.claude.json`; we
   * write to BOTH locations so the fixture matches the ticket text — the
   * scanner walks `~/.claude.json`, which is the canonical user file here.)
   */
  alsoInUser?: boolean;
  /**
   * Additional `.mcp.json` files at synthetic project roots. Each entry
   * becomes another project dir with a `.mcp.json` containing `sharedKey`.
   */
  extraProjectDirs?: readonly string[];
}

export interface MultiConfigMcpFixture {
  /** Project roots to pass into `scanMcpServers(configPath, projectPaths)`. */
  projectPaths: string[];
  /** Absolute path to the root user claude config (`~/.claude.json`). */
  userConfigPath: string;
}

/**
 * Write one MCP `sharedKey` into 2+ config files so `scanMcpServers` sets
 * `configRefs.length >= 2` on the emitted item. Used by Phase 6 SC3 (MCP
 * multi-config warning hint) and the scanner-aggregation test.
 *
 * Writes the same server definition into every target config so the scanner
 * treats them as genuinely shared. Each config is a well-formed JSON file.
 */
export async function createMultiConfigMcpFixture(
  opts: MultiConfigMcpFixtureOpts,
): Promise<MultiConfigMcpFixture> {
  const { home, sharedKey } = opts;
  const projectRoot = opts.projectRoot ?? path.join(home, 'project');
  const alsoInProjectLocal = opts.alsoInProjectLocal ?? true;
  const alsoInUser = opts.alsoInUser ?? true;
  const extra = opts.extraProjectDirs ?? [];

  const serverDef = { command: 'npx', args: [sharedKey] };
  const projectPaths: string[] = [];

  // Root user config (~/.claude.json). Always written — this is the scanner's
  // primary config source.
  const userConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (alsoInUser) {
    userConfig.mcpServers[sharedKey] = serverDef;
  }
  const userConfigPath = path.join(home, '.claude.json');
  await writeFile(userConfigPath, JSON.stringify(userConfig, null, 2) + '\n', 'utf8');

  // Primary project root .mcp.json.
  if (alsoInProjectLocal) {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { [sharedKey]: serverDef } }, null, 2) + '\n',
      'utf8',
    );
    projectPaths.push(projectRoot);
  }

  // Additional project dirs with their own .mcp.json.
  for (const rel of extra) {
    const dir = path.isAbsolute(rel) ? rel : path.join(home, rel);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { [sharedKey]: serverDef } }, null, 2) + '\n',
      'utf8',
    );
    projectPaths.push(dir);
  }

  return { projectPaths, userConfigPath };
}
