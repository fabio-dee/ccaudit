/**
 * Phase 5 (v1.3.0) Framework Integration Test Suite
 *
 * Covers TEST-04 through TEST-09 (REQUIREMENTS.md) against the canonical 14-item
 * fixture at `__fixtures__/framework-integration/`. The fixture is checked in
 * (not procedurally generated) to allow deterministic inline snapshots.
 *
 * Test sections:
 *   TEST-04 + TEST-05: Full pipeline via subprocess — framework grouping + dry-run protection
 *   TEST-06:           9 inline snapshots (3 widths × 3 modes) via in-process renderers
 *   TEST-07:           JSON backward compatibility (Prong A byte-compare, Prong B jq-path)
 *   TEST-08:           Coverage threshold regression guard (existsSync-gated)
 *   TEST-09:           Performance smoke test — gated on CI=true or RUN_PERF env var
 *   DOCS-04:           --help flag visibility (in help-output.test.ts, not here)
 *
 * D-01: frozen test files (scanner-integration.test.ts, framework-bust.test.ts, etc.)
 *       are READ-ONLY; helpers are copied by value — not imported.
 * D-12: subprocess tests always pass `--since 3650d` for date-agnostic fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toGhostItems, groupByFramework } from '@ccaudit/internal';
import type { GhostItem, FrameworkGroup } from '@ccaudit/internal';
import type { TokenCostResult } from '@ccaudit/internal';
import { renderFrameworksSection, renderInventoryTable } from '@ccaudit/terminal';

// ── Path constants ──────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ is at apps/ccaudit/src/__tests__ → dist is ../../dist
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');
const fixtureSourceDir = path.resolve(here, '__fixtures__', 'framework-integration');
const v121FixturePath = path.resolve(fixtureSourceDir, 'v1-2-1-envelope.json');
// coverage-summary.json is at <repo>/coverage/coverage-summary.json
const coverageSummaryPath = path.resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'coverage',
  'coverage-summary.json',
);
const binaryExists = existsSync(distPath);

// D-12: fixed NOW constant — same as project convention in in-source tests
const NOW = 1_712_000_000_000;

// ── v1.2.1 fixture preflight ────────────────────────────────────────────────
// The envelope is captured once by apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs
// and committed as a static file. The test MUST NOT regenerate it at runtime.

if (!existsSync(v121FixturePath)) {
  throw new Error(
    `[framework-integration.test.ts] v1.2.1 envelope fixture missing at ${v121FixturePath}. ` +
      `Run: pnpm -F ccaudit-cli build && node apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs`,
  );
}
if (statSync(v121FixturePath).size === 0) {
  throw new Error(
    `[framework-integration.test.ts] v1.2.1 envelope fixture at ${v121FixturePath} is zero-byte. ` +
      `Re-run the capture script: node apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs`,
  );
}

// ── Fake ps script (COPIED from framework-bust.test.ts:47-62 — D-01 no-import) ──

const FAKE_PS_SCRIPT = `#!/bin/sh
# Fake ps used by ccaudit framework-integration tests.
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

// ── Subprocess helpers (COPIED from framework-bust.test.ts:64-117 — D-01) ──

async function buildFakePs(tmpHome: string): Promise<string> {
  const binDir = path.join(tmpHome, 'bin');
  await mkdir(binDir, { recursive: true });
  const psPath = path.join(binDir, 'ps');
  await writeFile(psPath, FAKE_PS_SCRIPT, 'utf8');
  await chmod(psPath, 0o755);
  return binDir;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCommand(tmpHome: string, flags: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath, ...flags], {
      env: {
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        NO_COLOR: '1',
        PATH: path.join(tmpHome, 'bin'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('runCommand timed out after 30s'));
    }, 30_000);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

// ── In-process helpers ──────────────────────────────────────────────────────

/**
 * Copy fixture tree into tmpHome and build the fake ps binary.
 * IMPORTANT: The JSONL session file in the fixture uses static 2024-04-01 timestamps.
 * classifyGhost() classifies invocations older than DEFINITE_GHOST_MS as 'definite-ghost'
 * even if they appear in the session file. We must rewrite the tool_use lines to use
 * recent timestamps (~1h ago) so gsd-planner and gsd-executor are classified as 'used'.
 * The system-init line stays with its original timestamp (it doesn't affect classification).
 */
async function copyFixture(tmpHome: string): Promise<void> {
  await cp(fixtureSourceDir, tmpHome, { recursive: true });

  // Rewrite session-1.jsonl with recent timestamps for the two tool_use assistant lines.
  // This mirrors the pattern used in framework-bust.test.ts (recentTs = Date.now()-3600000).
  const recentTs = new Date(Date.now() - 3_600_000).toISOString();
  const sessionPath = path.join(
    tmpHome,
    '.claude',
    'projects',
    'framework-fixture',
    'session-1.jsonl',
  );
  const freshSession =
    [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/fake/project',
        timestamp: '2024-04-01T12:00:00.000Z',
        sessionId: 'phase5-fixture',
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: recentTs,
        sessionId: 'phase5-fixture',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't-gsd-planner',
              name: 'Task',
              input: { subagent_type: 'gsd-planner', prompt: 'plan phase 5' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: recentTs,
        sessionId: 'phase5-fixture',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't-gsd-executor',
              name: 'Task',
              input: { subagent_type: 'gsd-executor', prompt: 'execute plan' },
            },
          ],
        },
      }),
    ].join('\n') + '\n';
  await writeFile(sessionPath, freshSession, 'utf-8');

  await buildFakePs(tmpHome);
}

/**
 * Build a minimal TokenCostResult for snapshot construction.
 * COPIED from ghost-command.test.ts:41-60 and EXTENDED with framework field.
 */
function makeResult(
  name: string,
  tier: 'used' | 'likely-ghost' | 'definite-ghost',
  tokens: number | null = null,
  category: 'agent' | 'skill' | 'mcp-server' | 'memory' = 'agent',
  framework: string | null = null,
): TokenCostResult {
  return {
    item: {
      name,
      path: `/test/${name}`,
      scope: 'global',
      category,
      projectPath: null,
      framework,
    },
    tier,
    lastUsed: tier === 'used' ? new Date(NOW) : null,
    invocationCount: tier === 'used' ? 1 : 0,
    tokenEstimate: tokens !== null ? { tokens, confidence: 'estimated', source: 'test' } : null,
  };
}

/** Build 150-item performance fixture home directory. */
async function buildPerfFixture(tmpHome: string, itemCount: number): Promise<void> {
  const agentsDir = path.join(tmpHome, '.claude', 'agents');
  const skillsDir = path.join(tmpHome, '.claude', 'skills');
  const projDir = path.join(tmpHome, '.claude', 'projects', 'perf-project');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(projDir, { recursive: true });

  const body = (i: number) => `# perf agent ${i}\n`.repeat(20);
  const perBucket = Math.floor(itemCount / 3);

  // Curated GSD agents
  for (let i = 0; i < perBucket; i++) {
    await writeFile(path.join(agentsDir, `gsd-perf-${i}.md`), body(i), 'utf-8');
  }
  // Heuristic bulk-* agents
  for (let i = 0; i < perBucket; i++) {
    await writeFile(path.join(agentsDir, `bulk-perf-${i}.md`), body(i), 'utf-8');
  }
  // Solo ungrouped agents (remainder)
  const remaining = itemCount - perBucket * 2;
  for (let i = 0; i < remaining; i++) {
    await writeFile(path.join(agentsDir, `solo-${i}.md`), body(i), 'utf-8');
  }

  // Session file (system-init only — no invocations so all items are ghost)
  const sessionLine = JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: '/fake/perf',
    timestamp: '2024-04-01T12:00:00.000Z',
    sessionId: 'perf-session',
  });
  await writeFile(path.join(projDir, 'session.jsonl'), sessionLine + '\n', 'utf-8');

  await writeFile(path.join(tmpHome, '.claude.json'), '{}', 'utf-8');
  await buildFakePs(tmpHome);
}

// ── Binary guard ────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!binaryExists) {
    throw new Error(
      `[framework-integration.test.ts] Binary not found at ${distPath}. Run: pnpm -F ccaudit-cli build`,
    );
  }
});

// ── TEST-04 + TEST-05: Full pipeline against canonical fixture ──────────────

describe.skipIf(!binaryExists)('TEST-04 + TEST-05: full pipeline against canonical fixture', () => {
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-phase5-integ-'));
    await copyFixture(tmpHome);
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('TEST-04: GSD renders as a partially-used framework row', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      frameworks: Array<{
        id: string;
        source_type: string;
        status: string;
        totals: { defined: number; used: number; definiteGhost: number };
      }>;
    };
    expect(Array.isArray(envelope.frameworks)).toBe(true);
    const gsd = envelope.frameworks.find((f) => f.id === 'gsd');
    expect(gsd).toBeDefined();
    expect(gsd!.status).toBe('partially-used');
    expect(gsd!.totals.defined).toBe(5);
    expect(gsd!.totals.used).toBe(2);
    expect(gsd!.totals.definiteGhost).toBe(3);
  });

  it('TEST-04: foo heuristic cluster renders as a ghost-all framework', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      frameworks: Array<{
        id: string;
        source_type: string;
        status: string;
        totals: { definiteGhost: number };
      }>;
    };
    const foo = envelope.frameworks.find((f) => f.id === 'foo');
    expect(foo).toBeDefined();
    expect(foo!.source_type).toBe('heuristic');
    expect(foo!.status).toBe('ghost-all');
    expect(foo!.totals.definiteGhost).toBe(3);
  });

  it('TEST-04: engineering/ agents render with framework: null (TEST-02 regression)', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      items: Array<{ name: string; path: string; framework: string | null }>;
    };
    const engItems = envelope.items.filter((i) => i.path.includes('/engineering/'));
    expect(engItems.length).toBe(4);
    for (const item of engItems) {
      expect(item.framework).toBeNull();
    }
  });

  it('TEST-04: solo-agent and lone-skill are ungrouped (framework: null)', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      items: Array<{ name: string; framework: string | null }>;
    };
    const soloAgent = envelope.items.find((i) => i.name === 'solo-agent');
    expect(soloAgent).toBeDefined();
    expect(soloAgent!.framework).toBeNull();
    const loneSkill = envelope.items.find((i) => i.name === 'lone-skill');
    expect(loneSkill).toBeDefined();
    expect(loneSkill!.framework).toBeNull();
  });

  // Regression guard for Fix 2 (release/v1.3.0): annotateFrameworks only sets
  // item.framework for Tier-1 curated matches. Tier-2 heuristic groups (the
  // foo-* cluster in this fixture) retain item.framework === null on their
  // members. Before the fix, downstream renderers read r.item.framework
  // directly, so heuristic members:
  //   (a) serialized as framework: null in the JSON items[] array, and
  //   (b) slipped through the Top Ghosts filter (r.item.framework == null)
  //       and got rendered BOTH inside their Frameworks section AND inside
  //       the Top Ghosts table — visible duplication.
  // The fix resolves membership via grouped.frameworks[].members (mirrors
  // packages/internal/src/remediation/framework-bust.ts).
  it('TEST-04: heuristic foo-* members carry framework="foo" in JSON items[] (Fix 2 regression)', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      items: Array<{ name: string; framework: string | null }>;
    };
    const fooMembers = envelope.items.filter((i) => i.name.startsWith('foo-'));
    // Fixture has exactly 3 heuristic foo-* agents (foo-alpha, foo-beta, foo-gamma).
    expect(fooMembers).toHaveLength(3);
    for (const m of fooMembers) {
      expect(m.framework).toBe('foo');
    }
  });

  it('TEST-04: heuristic foo-* members are NOT duplicated in the Top Ghosts table (Fix 2 regression)', async () => {
    // Default (non-JSON) rendering. The Top Ghosts section's title is stable
    // across terminal widths; any foo-* name appearing AFTER that title would
    // mean the heuristic cluster double-appears (Frameworks section + Top
    // Ghosts). Global Baseline follows Top Ghosts — scope the search to the
    // segment between them.
    const result = await runCommand(tmpHome, ['ghost', '--since', '3650d']);
    expect([0, 1]).toContain(result.code);
    const stdout = result.stdout;
    const topStart = stdout.indexOf('Top global ghosts by token cost');
    // If the Top Ghosts section is present, none of the foo-* members should
    // appear inside it. (If the section is omitted because every ghost is
    // framework-attributed, topStart === -1 and there is nothing to check —
    // which is itself the passing outcome.)
    if (topStart !== -1) {
      // Next section marker: Global Baseline (renderGlobalBaseline output).
      // Fall back to end-of-output if the marker is absent.
      const nextSectionIdx = stdout.indexOf('Global', topStart + 1);
      const topEnd = nextSectionIdx === -1 ? stdout.length : nextSectionIdx;
      const topSegment = stdout.slice(topStart, topEnd);
      expect(topSegment).not.toContain('foo-alpha');
      expect(topSegment).not.toContain('foo-beta');
      expect(topSegment).not.toContain('foo-gamma');
    }
  });

  it('TEST-05: --dry-run WITHOUT --force-partial protects all GSD ghost members', async () => {
    const result = await runCommand(tmpHome, [
      'ghost',
      '--dry-run',
      '--json',
      '--since',
      '3650d',
      '--yes-proceed-busting',
    ]);
    expect([0, 1]).toContain(result.code);
    const envelope = JSON.parse(result.stdout) as {
      changePlan: {
        archive: Array<{ name: string }>;
        protected?: Array<{ name: string }>;
        protectionWarnings?: string[];
      };
    };
    // Archive names (locked field path from ghost.ts:285-318)
    const archiveNames = (envelope.changePlan.archive as Array<{ name: string }>).map(
      (i) => i.name,
    );
    // No GSD ghost item should be in archive when protection is active
    const gsdInArchive = archiveNames.filter((n) => n.startsWith('gsd-'));
    expect(gsdInArchive).toHaveLength(0);
    // Protected names
    const protectedNames = (
      (envelope.changePlan.protected as Array<{ name: string }> | undefined) ?? []
    ).map((i) => i.name);
    expect(protectedNames).toContain('gsd-roadmapper');
    expect(protectedNames).toContain('gsd-verifier');
    expect(protectedNames).toContain('gsd-code-reviewer');
    expect(protectedNames).toHaveLength(3);
    // Protection warnings must be non-empty
    const protectionWarnings =
      (envelope.changePlan.protectionWarnings as string[] | undefined) ?? [];
    expect(protectionWarnings.length).toBeGreaterThan(0);
  });

  it('TEST-05: --dry-run WITH --force-partial archives 3 ghost GSD members but never the 2 used ones', async () => {
    const result = await runCommand(tmpHome, [
      'ghost',
      '--dry-run',
      '--force-partial',
      '--json',
      '--since',
      '3650d',
      '--yes-proceed-busting',
    ]);
    expect([0, 1]).toContain(result.code);
    const envelope = JSON.parse(result.stdout) as {
      changePlan: {
        archive: Array<{ name: string }>;
        protected?: Array<{ name: string }>;
      };
    };
    const archiveNames = (envelope.changePlan.archive as Array<{ name: string }>).map(
      (i) => i.name,
    );
    // Ghost GSD members MUST be in archive with --force-partial
    expect(archiveNames).toContain('gsd-roadmapper');
    expect(archiveNames).toContain('gsd-verifier');
    expect(archiveNames).toContain('gsd-code-reviewer');
    // Used GSD members must NOT be in archive
    expect(archiveNames).not.toContain('gsd-planner');
    expect(archiveNames).not.toContain('gsd-executor');
    // Protected list should be absent or empty (--force-partial bypassed protection)
    const protectedNames = (
      (envelope.changePlan.protected as Array<{ name: string }> | undefined) ?? []
    ).map((i) => i.name);
    expect(protectedNames).toHaveLength(0);
  });
});

// ── TEST-06: Snapshot matrix (3 widths × 3 modes) ──────────────────────────

describe('TEST-06: snapshot matrix (3 widths × 3 modes)', () => {
  let groups: FrameworkGroup[];
  let enrichedItems: TokenCostResult[];
  let frameworkColumnValues: Map<string, string | null>;
  let originalColumns: number | undefined;

  // Freeze the system clock so the "Last Used" column renders as a stable
  // "740d ago" relative to NOW (= 2024-04-01) regardless of when CI runs.
  // Without this, snapshots drift by one day every 24h.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW + 740 * 86_400_000);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeAll(async () => {
    // Build TokenCostResult[] via makeResult factory — deterministic + fast.
    // We construct the 14-item fixture manually to avoid in-process file I/O
    // and ensure snapshot stability regardless of file sizes.
    enrichedItems = [
      // GSD agents: 2 used, 3 definite-ghost
      makeResult('gsd-planner', 'used', 200, 'agent', 'gsd'),
      makeResult('gsd-executor', 'used', 200, 'agent', 'gsd'),
      makeResult('gsd-roadmapper', 'definite-ghost', 200, 'agent', 'gsd'),
      makeResult('gsd-verifier', 'definite-ghost', 200, 'agent', 'gsd'),
      makeResult('gsd-code-reviewer', 'definite-ghost', 200, 'agent', 'gsd'),
      // foo heuristic cluster: all ghost
      makeResult('foo-alpha', 'definite-ghost', 150, 'agent', 'foo'),
      makeResult('foo-beta', 'definite-ghost', 150, 'agent', 'foo'),
      makeResult('foo-gamma', 'definite-ghost', 150, 'agent', 'foo'),
      // engineering/ domain-folder agents: all ungrouped
      makeResult('backend-dev', 'definite-ghost', 100, 'agent', null),
      makeResult('frontend-dev', 'definite-ghost', 100, 'agent', null),
      makeResult('ml-engineer', 'definite-ghost', 100, 'agent', null),
      makeResult('devops', 'definite-ghost', 100, 'agent', null),
      // Ungrouped singletons
      makeResult('solo-agent', 'definite-ghost', 80, 'agent', null),
      makeResult('lone-skill', 'definite-ghost', 80, 'skill', null),
    ];

    const ghostItems: GhostItem[] = toGhostItems(enrichedItems);
    const grouped = groupByFramework(ghostItems);
    groups = grouped.frameworks;

    // Framework column values map for renderInventoryTable
    frameworkColumnValues = new Map(
      ghostItems.filter((i) => i.framework).map((i) => [i.name, i.framework!]),
    );
  });

  beforeEach(() => {
    originalColumns = process.stdout.columns;
  });

  afterEach(() => {
    if (originalColumns === undefined) {
      (process.stdout as { columns?: number }).columns = undefined;
    } else {
      process.stdout.columns = originalColumns;
    }
  });

  function withColumns<T>(width: number, fn: () => T): T {
    process.stdout.columns = width;
    return fn();
  }

  // Default mode (no verbose, frameworks section shown)
  it('80 cols, default mode', () => {
    const rendered = withColumns(
      80,
      () =>
        renderFrameworksSection(groups, { verbose: false }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: false, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                               │
      ├────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                               │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                               │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌───────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────[0m┐
      │ Name          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Act[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-planner   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-executor  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-roadmappe │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ r             │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-verifier  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-code-revi │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ ewer          │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-alpha     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-beta      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-gamma     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ backend-dev   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ frontend-dev  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ ml-engineer   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ devops        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ solo-agent    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ lone-skill    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      └───────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────[0m┘"
    `);
  });

  it('100 cols, default mode', () => {
    const rendered = withColumns(
      100,
      () =>
        renderFrameworksSection(groups, { verbose: false }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: false, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                                                   │
      ├────────────────────────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                                                   │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                                                   │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                                    │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌───────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer             │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });

  it('120 cols, default mode', () => {
    const rendered = withColumns(
      120,
      () =>
        renderFrameworksSection(groups, { verbose: false }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: false, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                                                                       │
      ├────────────────────────────────────────────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                                                                       │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────────────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                                                                       │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                                                        │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────────────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌───────────────────────────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                                              │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                                       │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                                      │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                                    │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                                      │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer                                 │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                                          │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                                      │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                                            │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                                        │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                                        │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });

  // Verbose mode
  it('80 cols, verbose mode', () => {
    const rendered = withColumns(
      80,
      () =>
        renderFrameworksSection(groups, { verbose: true }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: true, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                               │
      ├────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                               │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                               │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌──────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Framework members (verbose):                                              │
      ├────────────────────┬───────────────────────────────┬──────────┬──────────────┤
      │ Framework          │ Member                        │ Tier     │ ~Tokens      │
      ├────────────────────┼───────────────────────────────┼──────────┼──────────────┤
      │ Foo~               │ foo-alpha                     │ [GHOST]  │  ~150 tokens │
      │                    │ foo-beta                      │ [GHOST]  │  ~150 tokens │
      │                    │ foo-gamma                     │ [GHOST]  │  ~150 tokens │
      │ GSD (Get Shit      │ gsd-executor                  │ [ACTIVE] │  ~200 tokens │
      │ Done)              │                               │          │              │
      │                    │ gsd-planner                   │ [ACTIVE] │  ~200 tokens │
      │                    │ gsd-code-reviewer             │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-roadmapper                │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-verifier                  │ [GHOST]  │  ~200 tokens │
      └────────────────────┴───────────────────────────────┴──────────┴──────────────┘
      ┌───────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────[0m┐
      │ Name          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Act[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-planner   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-executor  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-roadmappe │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ r             │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-verifier  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-code-revi │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ ewer          │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-alpha     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-beta      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-gamma     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ backend-dev   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ frontend-dev  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ ml-engineer   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ devops        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ solo-agent    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ lone-skill    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      └───────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────[0m┘"
    `);
  });

  it('100 cols, verbose mode', () => {
    const rendered = withColumns(
      100,
      () =>
        renderFrameworksSection(groups, { verbose: true }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: true, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                                                   │
      ├────────────────────────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                                                   │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                                                   │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                                    │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Framework members (verbose):                                                                  │
      ├────────────────────┬───────────────────────────────────────────────────┬──────────┬──────────────┤
      │ Framework          │ Member                                            │ Tier     │ ~Tokens      │
      ├────────────────────┼───────────────────────────────────────────────────┼──────────┼──────────────┤
      │ Foo~               │ foo-alpha                                         │ [GHOST]  │  ~150 tokens │
      │                    │ foo-beta                                          │ [GHOST]  │  ~150 tokens │
      │                    │ foo-gamma                                         │ [GHOST]  │  ~150 tokens │
      │ GSD (Get Shit      │ gsd-executor                                      │ [ACTIVE] │  ~200 tokens │
      │ Done)              │                                                   │          │              │
      │                    │ gsd-planner                                       │ [ACTIVE] │  ~200 tokens │
      │                    │ gsd-code-reviewer                                 │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-roadmapper                                    │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-verifier                                      │ [GHOST]  │  ~200 tokens │
      └────────────────────┴───────────────────────────────────────────────────┴──────────┴──────────────┘
      ┌───────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer             │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });

  it('120 cols, verbose mode', () => {
    const rendered = withColumns(
      120,
      () =>
        renderFrameworksSection(groups, { verbose: true }) +
        '\n' +
        renderInventoryTable(enrichedItems, { verbose: true, frameworkColumnValues }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Frameworks:                                                                                                       │
      ├────────────────────────────────────────────────────────────────────────────┬───────┬────────┬─────────┬──────────────┤
      │ Name                                                                       │ Def   │ Used   │ Ghost   │ ~Tokens      │
      ├────────────────────────────────────────────────────────────────────────────┼───────┼────────┼─────────┼──────────────┤
      │ Foo~                                                                       │     3 │      0 │       3 │  ~450 tokens │
      │ GSD (Get Shit Done)                                                        │     5 │      2 │       3 │  ~600 tokens │
      └────────────────────────────────────────────────────────────────────────────┴───────┴────────┴─────────┴──────────────┘
      ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
      │ 🧩 Framework members (verbose):                                                                                      │
      ├────────────────────┬───────────────────────────────────────────────────────────────────────┬──────────┬──────────────┤
      │ Framework          │ Member                                                                │ Tier     │ ~Tokens      │
      ├────────────────────┼───────────────────────────────────────────────────────────────────────┼──────────┼──────────────┤
      │ Foo~               │ foo-alpha                                                             │ [GHOST]  │  ~150 tokens │
      │                    │ foo-beta                                                              │ [GHOST]  │  ~150 tokens │
      │                    │ foo-gamma                                                             │ [GHOST]  │  ~150 tokens │
      │ GSD (Get Shit      │ gsd-executor                                                          │ [ACTIVE] │  ~200 tokens │
      │ Done)              │                                                                       │          │              │
      │                    │ gsd-planner                                                           │ [ACTIVE] │  ~200 tokens │
      │                    │ gsd-code-reviewer                                                     │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-roadmapper                                                        │ [GHOST]  │  ~200 tokens │
      │                    │ gsd-verifier                                                          │ [GHOST]  │  ~200 tokens │
      └────────────────────┴───────────────────────────────────────────────────────────────────────┴──────────┴──────────────┘
      ┌───────────────────────────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                                              │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                                       │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                                      │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                                    │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                                      │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer                                 │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                                          │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                                      │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                                            │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                                        │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                                        │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });

  // no-group-frameworks mode (only renderInventoryTable, no framework section, no frameworkColumnValues)
  it('80 cols, no-group-frameworks mode', () => {
    const rendered = withColumns(80, () => renderInventoryTable(enrichedItems, { verbose: false }));
    expect(rendered).toMatchInlineSnapshot(`
      "┌───────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────[0m┐
      │ Name          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Act[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-planner   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-executor  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Kee[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-roadmappe │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ r             │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-verifier  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ gsd-code-revi │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Arc[0m│
      │ ewer          │           │        │          │          │              │    [0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-alpha     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-beta      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ foo-gamma     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ backend-dev   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ frontend-dev  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ ml-engineer   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ devops        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ solo-agent    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      ├───────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────[0m┤
      │ lone-skill    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Arc[0m│
      └───────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────[0m┘"
    `);
  });

  it('100 cols, no-group-frameworks mode', () => {
    const rendered = withColumns(100, () =>
      renderInventoryTable(enrichedItems, { verbose: false }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌───────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                          │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                   │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                  │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                  │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer             │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                      │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                     │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                  │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                   │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                        │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                    │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                    │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });

  it('120 cols, no-group-frameworks mode', () => {
    const rendered = withColumns(120, () =>
      renderInventoryTable(enrichedItems, { verbose: false }),
    );
    expect(rendered).toMatchInlineSnapshot(`
      "┌───────────────────────────────────────────────────┬───────────┬────────┬──────────┬──────────┬──────────────┬────────┐
      │ Name                                              │ Category  │ Scope  │ Tier     │ Last     │ ~Token Cost  │ Action │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-planner                                       │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-executor                                      │ agent     │ global │ [ACTIVE] │ 740d ago │ ~200 tokens  │ Keep   │
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-roadmapper                                    │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-verifier                                      │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ gsd-code-reviewer                                 │ agent     │ global │ [GHOST]  │ never    │ ~200 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-alpha                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-beta                                          │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ foo-gamma                                         │ agent     │ global │ [GHOST]  │ never    │ ~150 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ backend-dev                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ frontend-dev                                      │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ ml-engineer                                       │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ devops                                            │ agent     │ global │ [GHOST]  │ never    │ ~100 tokens  │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ solo-agent                                        │ agent     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      ├───────────────────────────────────────────────────┼───────────┼────────┼──────────┼──────────┼──────────────┼────────┤
      │ lone-skill                                        │ skill     │ global │ [GHOST]  │ never    │ ~80 tokens   │ Archive│
      └───────────────────────────────────────────────────┴───────────┴────────┴──────────┴──────────┴──────────────┴────────┘"
    `);
  });
});

// ── TEST-07: JSON backward compatibility ────────────────────────────────────

describe.skipIf(!binaryExists)('TEST-07: JSON backward compatibility', () => {
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-phase5-back-'));
    await copyFixture(tmpHome);
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('Prong A: --no-group-frameworks output byte-equals checked-in v1.2.1 envelope', async () => {
    // Fixture preflight already asserted existence + non-zero size at module load.
    const result = await runCommand(tmpHome, [
      'ghost',
      '--json',
      '--no-group-frameworks',
      '--since',
      '3650d',
    ]);
    expect(result.code).toBe(1);

    const actual = JSON.parse(result.stdout) as {
      meta: { timestamp: string; version: string };
      items?: Array<{ path?: string }>;
    };
    const fixture = JSON.parse(readFileSync(v121FixturePath, 'utf-8')) as {
      meta: { timestamp: string; version: string };
      items?: Array<{ path?: string }>;
    };

    // Normalize non-deterministic fields (Pitfall 3)
    // tokenEstimate for skills uses stat().size on the skill directory — macOS returns
    // ~96 bytes, Linux returns 4096. Normalize tokenEstimate + totalOverhead to avoid
    // platform-dependent assertion failures.
    function normalize(env: {
      meta: { timestamp: string; version: string; mcpRegime?: string; toolSearchOverhead?: number };
      healthScore?: {
        score: number;
        grade: string;
        ghostPenalty: number;
        tokenPenalty: number;
        dormantPenalty?: number;
      };
      totalOverhead?: { tokens: number };
      items?: Array<{
        path?: string;
        lastUsed?: string | null;
        daysSinceLastUse?: number | null;
        urgencyScore?: number | null;
        tokenEstimate?: { tokens: number; confidence: string; source: string } | null;
      }>;
    }): string {
      const copy = JSON.parse(JSON.stringify(env)) as {
        meta: {
          timestamp: string;
          version: string;
          mcpRegime?: string;
          toolSearchOverhead?: number;
        };
        healthScore?: {
          score: number;
          grade: string;
          ghostPenalty: number;
          tokenPenalty: number;
          dormantPenalty?: number;
        };
        totalOverhead?: { tokens: number };
        items?: Array<{
          path?: string;
          lastUsed?: string | null;
          daysSinceLastUse?: number | null;
          urgencyScore?: number | null;
          tokenEstimate?: { tokens: number; confidence: string; source: string } | null;
        }>;
      };
      copy.meta.timestamp = 'NORMALIZED';
      copy.meta.version = 'NORMALIZED';
      // totalOverhead depends on platform-specific skill stat().size — normalize
      if (copy.totalOverhead) copy.totalOverhead.tokens = 0;
      // Phase 2 additive meta fields — strip so v1.2.1 fixture byte-identity is preserved
      delete copy.meta.mcpRegime;
      delete copy.meta.toolSearchOverhead;
      // Phase 4 additive healthScore field — strip so v1.2.1 fixture byte-identity is preserved
      if (copy.healthScore) delete copy.healthScore.dormantPenalty;
      // Phase 4.1 additive fields — strip so v1.2.1 fixture byte-identity is preserved
      if (copy.meta) delete (copy.meta as Record<string, unknown>).hooksAggregated;
      if (copy.totalOverhead)
        delete (copy.totalOverhead as Record<string, unknown>).hooksUpperBound;
      // Paths differ between runs (tmpdir base) — normalize to basename
      // lastUsed, daysSinceLastUse, and urgencyScore are date-dependent — normalize per item
      // tokenEstimate for skills varies across platforms (dir stat().size) — normalize
      if (copy.items) {
        for (const item of copy.items) {
          if (item.path) {
            item.path = item.path.replace(/.*[/\\]\.claude[/\\]/, '/.claude/');
            item.path = item.path.replaceAll('\\', '/');
          }
          if (item.lastUsed != null) item.lastUsed = 'NORMALIZED';
          if (item.daysSinceLastUse != null) item.daysSinceLastUse = 0;
          if (item.urgencyScore != null) item.urgencyScore = 0;
          if (item.tokenEstimate) {
            item.tokenEstimate.tokens = 0;
            item.tokenEstimate.source = 'NORMALIZED';
          }
        }
      }
      return JSON.stringify(copy, null, 2);
    }

    expect(normalize(actual)).toBe(normalize(fixture));

    // Byte-level guarantee: no "framework" substring in v1.2.1-mode output
    expect(result.stdout).not.toContain('"framework"');
    expect(result.stdout).not.toContain('"frameworks"');
  });

  it('Prong B: default --json output satisfies v1.2.1 jq paths + v1.3.0 additive fields', async () => {
    const result = await runCommand(tmpHome, ['ghost', '--json', '--since', '3650d']);
    expect(result.code).toBe(1);
    const env = JSON.parse(result.stdout) as {
      meta: { command: string; timestamp: string };
      items: Array<{
        name: string;
        tier: string;
        framework: string | null;
      }>;
      frameworks: Array<{
        id: string;
        status: string;
        totals: { defined: number };
      }>;
    };

    // v1.2.1 jq paths — MUST continue to resolve
    expect(typeof env.meta.command).toBe('string');
    expect(env.meta.command).toBe('ghost');
    expect(typeof env.meta.timestamp).toBe('string');
    expect(env.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Array.isArray(env.items)).toBe(true);
    expect(env.items.length).toBeGreaterThan(0);
    for (const item of env.items) {
      expect(typeof item.name).toBe('string');
      expect(['used', 'likely-ghost', 'definite-ghost']).toContain(item.tier);
    }

    // v1.3.0 additive — MUST be present when groupFrameworks is active (default)
    expect(env.frameworks).toBeDefined();
    expect(Array.isArray(env.frameworks)).toBe(true);
    expect(env.frameworks.length).toBeGreaterThanOrEqual(2);
    const gsd = env.frameworks.find((f) => f.id === 'gsd');
    expect(gsd).toBeDefined();
    expect(gsd!.status).toBe('partially-used');
    expect(gsd!.totals.defined).toBe(5);

    // Per-item framework field — MUST be present on GSD items
    const gsdItems = env.items.filter((i) => i.name.startsWith('gsd-'));
    expect(gsdItems.length).toBeGreaterThanOrEqual(3);
    for (const item of gsdItems) {
      expect(item.framework).toBe('gsd');
    }
  });
});

// ── TEST-08: Coverage threshold regression guard ────────────────────────────

describe('TEST-08: coverage threshold regression guard', () => {
  it('coverage-summary.json meets 80/80/80/70 when coverage has run', () => {
    if (!existsSync(coverageSummaryPath)) {
      console.info(
        `[TEST-08] coverage-summary.json not found at ${coverageSummaryPath}; ` +
          `run \`pnpm exec vitest --run --coverage\` to exercise this check.`,
      );
      return;
    }
    const raw = JSON.parse(readFileSync(coverageSummaryPath, 'utf-8')) as {
      total: {
        lines: { pct: number };
        statements: { pct: number };
        functions: { pct: number };
        branches: { pct: number };
      };
    };
    expect(raw.total.lines.pct).toBeGreaterThanOrEqual(80);
    expect(raw.total.statements.pct).toBeGreaterThanOrEqual(80);
    expect(raw.total.functions.pct).toBeGreaterThanOrEqual(80);
    expect(raw.total.branches.pct).toBeGreaterThanOrEqual(70);
  });
});

// ── TEST-09: Performance smoke (150 items) ──────────────────────────────────

const perfEnabled = process.env.CI === 'true' || process.env.RUN_PERF !== undefined;
// Skip on Windows: the 500ms budget is calibrated for POSIX I/O, and the
// 150-file fixture build routinely exceeds vitest's 10s beforeAll timeout on
// Windows CI (antivirus + NTFS latency). afterAll `rm` also flakes with
// ENOTEMPTY when Windows file handles haven't released. Ubuntu + macOS
// coverage is sufficient for the perf regression guard.
const perfSkip = !binaryExists || !perfEnabled || process.platform === 'win32';

describe.skipIf(perfSkip)('TEST-09: performance smoke (150 items)', () => {
  let perfHome: string;

  beforeAll(async () => {
    perfHome = await mkdtemp(path.join(tmpdir(), 'ccaudit-phase5-perf-'));
    await buildPerfFixture(perfHome, 150);
  }, 60_000);

  afterAll(async () => {
    await rm(perfHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('ghost --json completes within 500ms budget (median of 3)', async () => {
    async function measureOnce(): Promise<number> {
      const start = performance.now();
      const result = await runCommand(perfHome, ['ghost', '--json', '--since', '3650d']);
      const end = performance.now();
      expect([0, 1]).toContain(result.code); // 0 no ghosts, 1 ghosts found
      return end - start;
    }

    await measureOnce(); // warmup, discard
    const t1 = await measureOnce();
    const t2 = await measureOnce();
    const t3 = await measureOnce();
    const times = [t1, t2, t3];
    const median = [...times].sort((a, b) => a - b)[1]!;

    // Always print for investigator-friendly output even when test passes
    console.warn(
      `[TEST-09] runs: ${times.map((t) => t.toFixed(0)).join('ms, ')}ms, median: ${median.toFixed(0)}ms`,
    );
    expect(median).toBeLessThanOrEqual(500);
  });
});
