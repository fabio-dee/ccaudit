/**
 * Phase 4 (v1.4.0) Integration Test — Commands + Hooks categories
 *
 * Validates the full pipeline for hook scanning, dormant tier classification,
 * per-category health-score weights, and the JSON envelope additions.
 *
 * Fixture: 2 commands + 1 inject-capable SessionStart hook in project settings.json.
 * Session log: ONE command invocation (/foo:command), NO hook firing signals.
 *
 * Expected:
 *   - Commands: 1 used (foo-used), 1 definite-ghost (foo-ghost)
 *   - Hook: 1 dormant (inject-capable SessionStart, zero fires)
 *   - healthScore.ghostPenalty reflects per-category weights (not flat 3/1)
 *   - healthScore.dormantPenalty > 0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanAll,
  enrichScanResults,
  calculateHealthScore,
  calculateGhostTotalOverhead,
  sumHookTokens,
  groupByFramework,
  toGhostItems,
  classifyRecommendation,
} from '@ccaudit/internal';
import type { ClaudePaths, InvocationRecord } from '@ccaudit/internal';

// ── Fixture state ──────────────────────────────────────────────────

let fixtureDir: string;
let claudeDir: string;
let commandsDir: string;

async function setupFixture(): Promise<void> {
  fixtureDir = await mkdtemp(join(tmpdir(), 'ccaudit-hooks-int-'));
  claudeDir = join(fixtureDir, '.claude');
  commandsDir = join(claudeDir, 'commands');
  await mkdir(commandsDir, { recursive: true });

  // 2 command files
  await writeFile(
    join(commandsDir, 'foo-used.md'),
    '---\nname: foo-used\ndescription: Used command\n---\n# Foo Used',
    'utf-8',
  );
  await writeFile(
    join(commandsDir, 'foo-ghost.md'),
    '---\nname: foo-ghost\ndescription: Ghost command\n---\n# Foo Ghost',
    'utf-8',
  );

  // 1 inject-capable SessionStart hook in project settings.json
  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo "session start hook for integration test"',
              },
            ],
          },
        ],
      },
    }),
    'utf-8',
  );
}

async function teardownFixture(): Promise<void> {
  await rm(fixtureDir, { recursive: true, force: true });
}

// ── Invocation fixtures ────────────────────────────────────────────

/**
 * Simulate a session log with ONE command invocation (foo-used),
 * and NO hook firing signals.
 */
function makeInvocations(): InvocationRecord[] {
  return [
    {
      kind: 'command',
      name: 'foo-used',
      sessionId: 'sess-hooks-int-001',
      timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(), // 2 days ago
      projectPath: fixtureDir,
      isSidechain: false,
    },
  ];
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Phase 4 commands+hooks integration', () => {
  beforeAll(setupFixture);
  afterAll(teardownFixture);

  it('scans fixture and produces correct item counts per category', async () => {
    const invocations = makeInvocations();

    // Use empty global paths so only project-scoped items appear
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const commandItems = results.filter((r) => r.item.category === 'command');
    const hookItems = results.filter((r) => r.item.category === 'hook');

    // 2 commands total
    expect(commandItems).toHaveLength(2);
    const usedCommand = commandItems.find((r) => r.item.name === 'foo-used');
    const ghostCommand = commandItems.find((r) => r.item.name === 'foo-ghost');
    expect(usedCommand).toBeDefined();
    expect(usedCommand!.tier).toBe('used');
    expect(ghostCommand).toBeDefined();
    expect(ghostCommand!.tier).toBe('definite-ghost');

    // 1 hook total — the SessionStart hook from project settings.json
    expect(hookItems).toHaveLength(1);
    const hookItem = hookItems[0];
    expect(hookItem.item.hookEvent).toBe('SessionStart');
    expect(hookItem.item.injectCapable).toBe(true);
  });

  it('dormant tier: inject-capable hook with zero fires → tier=dormant', async () => {
    const invocations = makeInvocations(); // no hook fires

    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const hookItems = results.filter((r) => r.item.category === 'hook');
    expect(hookItems).toHaveLength(1);
    expect(hookItems[0].tier).toBe('dormant');
    expect(hookItems[0].invocationCount).toBe(0);
  });

  it('healthScore uses per-category weights and has dormantPenalty > 0', async () => {
    const invocations = makeInvocations();

    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const enriched = await enrichScanResults(results);
    const healthScore = calculateHealthScore(enriched);

    // Ghost breakdown:
    //   1 definite-ghost command: weight 1 → contributes 1 pt
    //   1 dormant hook: weight 1 → contributes 1 pt
    // Total raw = 2, no cap needed → ghostPenalty = 2
    expect(healthScore.ghostPenalty).toBe(2);

    // dormantPenalty should be 1 (one dormant hook × weight 1)
    expect(healthScore.dormantPenalty).toBeGreaterThan(0);
    expect(healthScore.dormantPenalty).toBe(1);

    // Score = 100 - 2 - tokenPenalty
    // tokenPenalty from ghost command (small file) + dormant hook (2500 tok upper-bound)
    // tokenPenalty = min(round((tokens / 200000) * 100), 20)
    // Either way score must be < 100
    expect(healthScore.score).toBeLessThan(100);
    expect(healthScore.score).toBeGreaterThan(70); // reasonable range
  });

  it('hook token estimate: dormant inject-capable → 2500 tokens upper-bound', async () => {
    const invocations = makeInvocations();

    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const enriched = await enrichScanResults(results);
    const hookResult = enriched.find((r) => r.item.category === 'hook');

    expect(hookResult).toBeDefined();
    expect(hookResult!.tokenEstimate).not.toBeNull();
    expect(hookResult!.tokenEstimate!.tokens).toBe(2500);
    expect(hookResult!.tokenEstimate!.confidence).toBe('upper-bound');
    expect(hookResult!.tokenEstimate!.source).toContain('upper-bound');
  });

  it('groupByFramework includes hook items in ungrouped section', async () => {
    const invocations = makeInvocations();

    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const enriched = await enrichScanResults(results);
    const ghostItems = toGhostItems(enriched);
    const grouped = groupByFramework(ghostItems);

    // Hook items have no framework → they appear in ungrouped or solo
    const hookItems = ghostItems.filter((g) => g.category === 'hook');
    expect(hookItems).toHaveLength(1);
    // Should be represented somewhere in the grouped inventory
    const allGroupedItems = [...grouped.ungrouped, ...grouped.frameworks.flatMap((f) => f.members)];
    const hookInGrouped = allGroupedItems.filter((g) => g.category === 'hook');
    expect(hookInGrouped).toHaveLength(1);
  });

  it('calculateGhostTotalOverhead: default (includeHooks=false) excludes hook tokens', async () => {
    const invocations = makeInvocations();
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };
    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [],
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'),
    });
    const enriched = await enrichScanResults(results);
    const ghosts = enriched.filter((r) => r.tier !== 'used');

    const hooksUpperBound = sumHookTokens(ghosts);
    expect(hooksUpperBound).toBeGreaterThan(0); // 2500 tok dormant hook

    const totalWithout = calculateGhostTotalOverhead(ghosts, false);
    const totalWith = calculateGhostTotalOverhead(ghosts, true);

    // Without hooks: should be lower than with hooks
    expect(totalWithout).toBeLessThan(totalWith);
    // Delta should equal the hook upper-bound
    expect(totalWith - totalWithout).toBe(hooksUpperBound);
  });

  it('calculateGhostTotalOverhead: includeHooks=true includes hook tokens in total', async () => {
    const invocations = makeInvocations();
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };
    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [],
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'),
    });
    const enriched = await enrichScanResults(results);
    const ghosts = enriched.filter((r) => r.tier !== 'used');

    const hooksUpperBound = sumHookTokens(ghosts);
    const totalWith = calculateGhostTotalOverhead(ghosts, true);
    // hooksUpperBound must be > 0 and included in totalWith
    expect(hooksUpperBound).toBe(2500); // dormant inject-capable hook = 2500 upper-bound
    expect(totalWith).toBeGreaterThanOrEqual(hooksUpperBound);
  });

  it('health score: tokenPenalty differs between includeHooks modes; ghostPenalty and dormantPenalty identical', async () => {
    const invocations = makeInvocations();
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };
    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [],
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'),
    });
    const enriched = await enrichScanResults(results);

    const scoreDefault = calculateHealthScore(enriched, { includeHooks: false });
    const scoreWithHooks = calculateHealthScore(enriched, { includeHooks: true });

    // tokenPenalty must be lower (or equal) in default mode (hook tokens excluded)
    expect(scoreDefault.tokenPenalty).toBeLessThanOrEqual(scoreWithHooks.tokenPenalty);
    // ghostPenalty unchanged across modes
    expect(scoreDefault.ghostPenalty).toBe(scoreWithHooks.ghostPenalty);
    // dormantPenalty unchanged across modes
    expect(scoreDefault.dormantPenalty).toBe(scoreWithHooks.dormantPenalty);
    expect(scoreDefault.dormantPenalty).toBeGreaterThan(0);
  });

  it('sumHookTokens: returns 2500 for one dormant inject-capable hook', async () => {
    const invocations = makeInvocations();
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };
    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [],
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'),
    });
    const enriched = await enrichScanResults(results);
    const ghosts = enriched.filter((r) => r.tier !== 'used');
    expect(sumHookTokens(ghosts)).toBe(2500);
  });

  it('ghost --csv default mode: hook rows absent; --include-hooks mode: hook rows present', async () => {
    // Simulates the CSV branch in ghost.ts:
    //   default (!includeHooks): enriched filtered to exclude category==='hook'
    //   --include-hooks:         enriched used as-is
    const invocations = makeInvocations();
    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };
    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [],
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'),
    });
    const enriched = await enrichScanResults(results);

    // Simulate what ghost.ts CSV branch does
    const toRow = (r: (typeof enriched)[number]) =>
      [
        r.item.name,
        r.item.category,
        r.tier,
        r.lastUsed?.toISOString() ?? 'never',
        String(r.tokenEstimate?.tokens ?? 0),
        classifyRecommendation(r.tier),
        r.tokenEstimate?.confidence ?? 'none',
      ].join(',');

    const defaultCsvRows = enriched.filter((r) => r.item.category !== 'hook').map(toRow);
    const includeHooksCsvRows = enriched.map(toRow);

    // Default: no hook rows
    expect(defaultCsvRows.filter((row) => row.includes(',hook,'))).toHaveLength(0);
    // --include-hooks: hook rows present
    expect(includeHooksCsvRows.filter((row) => row.includes(',hook,'))).toHaveLength(1);
  });

  it('privacy: raw command string from hook never appears in enriched output', async () => {
    const invocations = makeInvocations();

    const claudePaths: ClaudePaths = {
      legacy: join(fixtureDir, 'empty-legacy'),
      xdg: join(fixtureDir, 'empty-xdg'),
    };

    const { results } = await scanAll(invocations, {
      claudePaths,
      projectPaths: [fixtureDir],
      globalHookSettingsPaths: [], // prevent reading real ~/.claude/settings.json
      claudeConfigPath: join(fixtureDir, 'no-mcp.json'), // prevent reading real ~/.claude.json
    });

    const enriched = await enrichScanResults(results);
    const serialized = JSON.stringify(enriched);

    // The raw command string must never appear in any serialized output
    const rawCommand = 'echo "session start hook for integration test"';
    expect(serialized).not.toContain(rawCommand);
    expect(serialized).not.toContain('session start hook for integration test');
  });
});
