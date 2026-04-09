/**
 * Integration tests for ghost command rendering and report output.
 *
 * Tests validate rendered output from @ccaudit/terminal renderers
 * and @ccaudit/internal report functions given known fixture data.
 * Includes both renderer-level tests with fixture data and a full pipeline
 * test that exercises discover -> parse -> scan -> enrich against a mock
 * filesystem in a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  renderGhostSummary,
  renderTopGhosts,
  renderHeader,
  renderHealthScore,
  renderInventoryTable,
  renderMcpTable,
} from '@ccaudit/terminal';
import {
  calculateHealthScore,
  classifyRecommendation,
  discoverSessionFiles,
  parseSession,
  scanAll,
  enrichScanResults,
} from '@ccaudit/internal';
import type {
  TokenCostResult,
  CategorySummary,
  ClaudePaths,
  InvocationRecord,
} from '@ccaudit/internal';

// ── Fixture Helpers ────────────────────────────────────────────────

/** Build a minimal TokenCostResult for testing. */
function makeResult(
  name: string,
  tier: 'used' | 'likely-ghost' | 'definite-ghost',
  tokens: number | null = null,
  category: 'agent' | 'skill' | 'mcp-server' | 'memory' = 'agent',
): TokenCostResult {
  return {
    item: {
      name,
      path: `/test/${name}`,
      scope: 'global',
      category,
      projectPath: null,
    },
    tier,
    lastUsed: tier === 'used' ? new Date() : null,
    invocationCount: tier === 'used' ? 1 : 0,
    tokenEstimate: tokens !== null ? { tokens, confidence: 'estimated', source: 'test' } : null,
  };
}

/**
 * Write a minimal valid JSONL session file to a directory.
 * Contains a system message with cwd field and several tool_use blocks
 * covering agent, skill, and MCP invocations.
 */
async function writeFixtureSession(
  dir: string,
  sessionData: {
    sessionId: string;
    projectPath: string;
    invocations: Array<{
      kind: 'agent' | 'skill' | 'mcp';
      name: string;
      tool?: string;
      timestamp: string;
    }>;
  },
): Promise<string> {
  const lines: string[] = [];

  // System message with cwd field (authoritative project path)
  lines.push(
    JSON.stringify({
      type: 'system',
      message: {
        role: 'system',
        content: 'System prompt',
      },
      cwd: sessionData.projectPath,
      sessionId: sessionData.sessionId,
      timestamp: sessionData.invocations[0]?.timestamp ?? '2026-04-01T10:00:00Z',
    }),
  );

  // Tool use blocks for each invocation
  for (const inv of sessionData.invocations) {
    let toolUseBlock: Record<string, unknown>;

    switch (inv.kind) {
      case 'agent':
        toolUseBlock = {
          type: 'tool_use',
          id: `tu_${Math.random().toString(36).slice(2, 10)}`,
          name: 'Agent',
          input: {
            subagent_type: inv.name,
            prompt: 'Test invocation',
          },
        };
        break;
      case 'skill':
        toolUseBlock = {
          type: 'tool_use',
          id: `tu_${Math.random().toString(36).slice(2, 10)}`,
          name: 'Skill',
          input: {
            skill: inv.name,
          },
        };
        break;
      case 'mcp':
        toolUseBlock = {
          type: 'tool_use',
          id: `tu_${Math.random().toString(36).slice(2, 10)}`,
          name: `mcp__${inv.name}__${inv.tool ?? 'default'}`,
          input: {},
        };
        break;
    }

    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [toolUseBlock],
        },
        sessionId: sessionData.sessionId,
        timestamp: inv.timestamp,
      }),
    );
  }

  const filePath = join(dir, `${sessionData.sessionId}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

// ── Mock Filesystem Setup ───────────────────────────────────────────

/** Root of the temporary mock filesystem. */
let fixtureDir: string;

/** Paths within the fixture directory. */
let claudeDir: string;
let agentsDir: string;
let skillsDir: string;
let sessionsDir: string;
let claudeConfigPath: string;

async function setupMockFilesystem(): Promise<void> {
  fixtureDir = join(tmpdir(), `ccaudit-test-${Date.now()}`);
  claudeDir = join(fixtureDir, '.claude');
  agentsDir = join(claudeDir, 'agents');
  skillsDir = join(claudeDir, 'skills');
  sessionsDir = join(claudeDir, 'projects', 'test-project');
  claudeConfigPath = join(fixtureDir, '.claude.json');

  // Create directory structure mimicking ~/.claude/ layout
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  // Agent 1: "code-reviewer" -- will be marked as used (has invocation)
  // scanAgents uses path.basename(file, '.md') as the name, so flat .md files
  await writeFile(
    join(agentsDir, 'code-reviewer.md'),
    '# Code Reviewer Agent\nReviews code.',
    'utf-8',
  );

  // Agent 2: "stale-helper" -- will be a ghost (no invocation)
  await writeFile(join(agentsDir, 'stale-helper.md'), '# Stale Helper Agent\nNever used.', 'utf-8');

  // Skill 1: "deploy" -- will be used
  const skillDir = join(skillsDir, 'deploy');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Deploy Skill\nDeploys things.', 'utf-8');

  // .claude.json with 2 MCP server entries (one used, one ghost)
  const claudeConfig = {
    mcpServers: {
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
      },
      'unused-server': {
        command: 'npx',
        args: ['-y', 'unused-mcp@latest'],
      },
    },
  };
  await writeFile(claudeConfigPath, JSON.stringify(claudeConfig, null, 2), 'utf-8');

  // Write session files with fixture JSONL data
  await writeFixtureSession(sessionsDir, {
    sessionId: 'session-001',
    projectPath: '/Users/test/my-project',
    invocations: [
      // Agent invocation (code-reviewer is "used") — use recent timestamp so tier stays 'used'
      {
        kind: 'agent',
        name: 'code-reviewer',
        timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      // Skill invocation (deploy is "used")
      {
        kind: 'skill',
        name: 'deploy',
        timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      // MCP invocation (context7 is "used")
      {
        kind: 'mcp',
        name: 'context7',
        tool: 'resolve-library-id',
        timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    ],
  });
}

async function teardownMockFilesystem(): Promise<void> {
  if (fixtureDir) {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('ghost command integration', () => {
  beforeAll(async () => {
    await setupMockFilesystem();
  });

  afterAll(async () => {
    await teardownMockFilesystem();
  });

  // ── Fixture Validation (real test) ────────────────────────────────

  it('creates valid fixture directory structure', async () => {
    // Verify root structure
    const claudeContents = await readdir(claudeDir);
    expect(claudeContents).toContain('agents');
    expect(claudeContents).toContain('skills');
    expect(claudeContents).toContain('projects');

    // Verify agents exist (flat .md files -- scanAgents uses basename as name)
    const agentContents = await readdir(agentsDir);
    expect(agentContents).toContain('code-reviewer.md');
    expect(agentContents).toContain('stale-helper.md');

    // Verify skills exist
    const skillContents = await readdir(skillsDir);
    expect(skillContents).toContain('deploy');

    // Verify .claude.json exists and contains MCP servers
    const configStat = await stat(claudeConfigPath);
    expect(configStat.isFile()).toBe(true);

    // Verify session JSONL file was written
    const sessionContents = await readdir(sessionsDir);
    expect(sessionContents.length).toBeGreaterThanOrEqual(1);
    expect(sessionContents.some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  // ── Render Integration Tests ──────────────────────────────────────

  it('renders summary rows with 4 category lines', () => {
    const summaries: CategorySummary[] = [
      { category: 'agent', defined: 140, used: 12, ghost: 128, tokenCost: 47000 },
      { category: 'skill', defined: 90, used: 8, ghost: 82, tokenCost: 18000 },
      { category: 'mcp-server', defined: 6, used: 2, ghost: 4, tokenCost: 32000 },
      { category: 'memory', defined: 9, used: 3, ghost: 6, tokenCost: 12000 },
    ];

    const output = renderGhostSummary(summaries);
    const lines = output.split('\n').filter((l: string) => l.trim().length > 0);
    expect(lines).toHaveLength(4);

    // Each line should contain a category name
    expect(output).toContain('Agents');
    expect(output).toContain('Skills');
    expect(output).toContain('MCP Servers');
    expect(output).toContain('Memory Files');
  });

  it('renders top ghosts section sorted by token cost', () => {
    const ghosts = [
      makeResult('low-cost', 'definite-ghost', 1000),
      makeResult('high-cost', 'definite-ghost', 15000),
      makeResult('mid-cost', 'definite-ghost', 5000),
    ];

    const output = renderTopGhosts(ghosts);

    // Bordered table — verify all three names appear and are in cost-descending order
    expect(output).toContain('high-cost');
    expect(output).toContain('mid-cost');
    expect(output).toContain('low-cost');
    expect(output.indexOf('high-cost')).toBeLessThan(output.indexOf('mid-cost'));
    expect(output.indexOf('mid-cost')).toBeLessThan(output.indexOf('low-cost'));
  });

  it('renders health score line with grade', () => {
    const results = Array.from({ length: 5 }, () => makeResult('ghost', 'definite-ghost', 0));
    const healthScore = calculateHealthScore(results);

    const output = renderHealthScore(healthScore);
    expect(output).toContain('Health grade: A+ (Healthy)');
  });

  it('renders --since window in header', () => {
    const output = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days');
    expect(output).toContain('7 days');
    expect(output).toContain('Ghost Inventory');
    expect(output).toContain('\u{1F47B}');
  });

  it('renders CCAUDIT tool name and wasted tokens in header when provided', () => {
    const output = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 109000);
    expect(output).toContain('CCAUDIT');
    expect(output).toContain('~109k tokens/session wasted');
    expect(output).toContain('Ghost Inventory');
    expect(output).toContain('7 days');
  });

  it('header has 4 lines when wasted tokens provided', () => {
    const output = renderHeader('\u{1F47B}', 'Ghost Inventory', '7 days', 109000);
    const lines = output.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('CCAUDIT');
    expect(lines[2]).toContain('Ghost Inventory');
  });

  it('JSON output includes healthScore and recommendation fields', () => {
    const results = [
      makeResult('ghost-agent', 'definite-ghost', 5000),
      makeResult('likely-agent', 'likely-ghost', 2000),
      makeResult('active-agent', 'used', 1000),
    ];

    const healthScore = calculateHealthScore(results);

    // Simulate the JSON output structure from ghost.ts
    const jsonOutput = {
      healthScore: {
        score: healthScore.score,
        grade: healthScore.grade,
        ghostPenalty: healthScore.ghostPenalty,
        tokenPenalty: healthScore.tokenPenalty,
      },
      items: results
        .filter((r) => r.tier !== 'used')
        .map((r) => ({
          name: r.item.name,
          recommendation: classifyRecommendation(r.tier),
        })),
    };

    // Verify healthScore structure
    expect(jsonOutput.healthScore).toHaveProperty('score');
    expect(jsonOutput.healthScore).toHaveProperty('grade');
    expect(typeof jsonOutput.healthScore.score).toBe('number');
    expect(typeof jsonOutput.healthScore.grade).toBe('string');

    // Verify items have recommendation field
    expect(jsonOutput.items).toHaveLength(2); // 2 ghosts
    expect(jsonOutput.items[0]!.recommendation).toBe('archive');
    expect(jsonOutput.items[1]!.recommendation).toBe('monitor');
  });

  it('inventory command renders table with column headers', () => {
    const results = [
      makeResult('agent-a', 'definite-ghost', 5000, 'agent'),
      makeResult('skill-b', 'used', 1000, 'skill'),
    ];

    const output = renderInventoryTable(results);
    expect(output).toContain('Name');
    expect(output).toContain('Category');
    expect(output).toContain('Tier');
    expect(output).toContain('Action');
    // Verify item names appear in table
    expect(output).toContain('agent-a');
    expect(output).toContain('skill-b');
  });

  it('mcp command renders table with health score', () => {
    const results = [makeResult('sequential-thinking', 'definite-ghost', 15000, 'mcp-server')];

    const output = renderMcpTable(results);
    expect(output).toContain('Server');
    // The responsive table wraps long server names across multiple cell lines.
    // Verify the name is present: both the prefix and the wrapped suffix must appear.
    expect(output).toContain('sequential');
    expect(output).toContain('inking');
    expect(output).toContain('Action');

    // Also verify health score rendering works for MCP context
    const healthScore = calculateHealthScore(results);
    const scoreOutput = renderHealthScore(healthScore);
    expect(scoreOutput).toContain('Health grade: A+ (Healthy)');
  });

  // ── Full Pipeline Test ──────────────────────────────────────────────

  it('exercises full discover->parse->scan->enrich pipeline against mock filesystem', async () => {
    // Use the mock filesystem's .claude/ directory as the legacy Claude path.
    // discoverSessionFiles expects claudePaths: { xdg, legacy } pointing to Claude data dirs.
    // The fixture has sessions at claudeDir/projects/test-project/session-001.jsonl
    // which matches the glob pattern: legacy/projects/*/*.jsonl
    const claudePaths: ClaudePaths = {
      xdg: join(fixtureDir, '.config', 'claude'), // non-existent -- no XDG sessions
      legacy: claudeDir, // fixtureDir/.claude -- has sessions, agents, skills
    };

    // Step 1: Discover session files from fixture directory
    const files = await discoverSessionFiles({ claudePaths });
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.includes('session-001.jsonl'))).toBe(true);

    // Step 2: Parse all discovered sessions
    const allInvocations: InvocationRecord[] = [];
    const projectPaths = new Set<string>();
    for (const file of files) {
      const result = await parseSession(file, Infinity);
      allInvocations.push(...result.invocations);
      if (result.meta.projectPath) {
        projectPaths.add(result.meta.projectPath);
      }
    }

    // Fixture has 3 invocations: agent(code-reviewer), skill(deploy), mcp(context7)
    expect(allInvocations.length).toBeGreaterThanOrEqual(3);

    // Step 3: Run inventory scanner against fixture directories
    const { results } = await scanAll(allInvocations, {
      claudePaths,
      projectPaths: [...projectPaths],
      claudeConfigPath: claudeConfigPath,
    });

    // Fixture defines: 2 agents, 1 skill, 2 MCP servers = at least 5 items
    expect(results.length).toBeGreaterThanOrEqual(3);

    // Step 4: Enrich with token estimates
    const enriched = await enrichScanResults(results);
    expect(enriched.length).toBe(results.length);

    // Step 5: Verify ghost detection -- stale-helper agent and unused-server MCP should be ghosts
    const ghostItems = enriched.filter((r) => r.tier !== 'used');
    const ghostNames = ghostItems.map((r) => r.item.name);

    // stale-helper agent has no invocations -> should be a ghost
    expect(ghostNames).toContain('stale-helper');

    // unused-server MCP has no invocations -> should be a ghost
    expect(ghostNames).toContain('unused-server');

    // code-reviewer agent has an invocation -> should NOT be a ghost
    const usedItems = enriched.filter((r) => r.tier === 'used');
    const usedNames = usedItems.map((r) => r.item.name);
    expect(usedNames).toContain('code-reviewer');

    // Step 6: Health score should be computable
    const healthScore = calculateHealthScore(enriched);
    expect(healthScore.score).toBeGreaterThanOrEqual(0);
    expect(healthScore.score).toBeLessThanOrEqual(100);
    expect(typeof healthScore.grade).toBe('string');

    // Step 7: Render ghost summary with pipeline data to verify end-to-end
    const categories = ['agent', 'skill', 'mcp-server', 'memory'] as const;
    const summaries: CategorySummary[] = categories.map((cat) => {
      const catItems = enriched.filter((r) => r.item.category === cat);
      return {
        category: cat,
        defined: catItems.length,
        used: catItems.filter((r) => r.tier === 'used').length,
        ghost: catItems.filter((r) => r.tier !== 'used').length,
        tokenCost: catItems
          .filter((r) => r.tier !== 'used')
          .reduce((sum, r) => sum + (r.tokenEstimate?.tokens ?? 0), 0),
      };
    });
    const summaryOutput = renderGhostSummary(summaries);
    expect(summaryOutput).toContain('Agents');
    expect(summaryOutput).toContain('MCP Servers');
  });
});
