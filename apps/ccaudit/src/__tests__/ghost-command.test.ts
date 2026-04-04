/**
 * Integration test scaffold for the ghost command.
 *
 * Wave 0 setup for Plan 03: creates fixture JSONL data, mock filesystem
 * structure, and assertion stubs for all command output behaviors.
 * Plan 03 tasks will fill in the .todo() stubs after commands are wired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Fixture Data ────────────────────────────────────────────────────

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
  lines.push(JSON.stringify({
    type: 'system',
    message: {
      role: 'system',
      content: 'System prompt',
    },
    cwd: sessionData.projectPath,
    sessionId: sessionData.sessionId,
    timestamp: sessionData.invocations[0]?.timestamp ?? '2026-04-01T10:00:00Z',
  }));

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

    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [toolUseBlock],
      },
      sessionId: sessionData.sessionId,
      timestamp: inv.timestamp,
    }));
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
  const usedAgentDir = join(agentsDir, 'code-reviewer');
  await mkdir(usedAgentDir, { recursive: true });
  await writeFile(join(usedAgentDir, 'agent.md'), '# Code Reviewer Agent\nReviews code.', 'utf-8');

  // Agent 2: "stale-helper" -- will be a ghost (no invocation)
  const ghostAgentDir = join(agentsDir, 'stale-helper');
  await mkdir(ghostAgentDir, { recursive: true });
  await writeFile(join(ghostAgentDir, 'agent.md'), '# Stale Helper Agent\nNever used.', 'utf-8');

  // Skill 1: "deploy" -- will be used
  const skillDir = join(skillsDir, 'deploy');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Deploy Skill\nDeploys things.', 'utf-8');

  // .claude.json with 2 MCP server entries (one used, one ghost)
  const claudeConfig = {
    mcpServers: {
      'context7': {
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
      // Agent invocation (code-reviewer is "used")
      { kind: 'agent', name: 'code-reviewer', timestamp: '2026-04-01T10:00:00Z' },
      // Skill invocation (deploy is "used")
      { kind: 'skill', name: 'deploy', timestamp: '2026-04-01T10:05:00Z' },
      // MCP invocation (context7 is "used")
      { kind: 'mcp', name: 'context7', tool: 'resolve-library-id', timestamp: '2026-04-01T10:10:00Z' },
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

    // Verify agents exist
    const agentContents = await readdir(agentsDir);
    expect(agentContents).toContain('code-reviewer');
    expect(agentContents).toContain('stale-helper');

    // Verify skills exist
    const skillContents = await readdir(skillsDir);
    expect(skillContents).toContain('deploy');

    // Verify .claude.json exists and contains MCP servers
    const configStat = await stat(claudeConfigPath);
    expect(configStat.isFile()).toBe(true);

    // Verify session JSONL file was written
    const sessionContents = await readdir(sessionsDir);
    expect(sessionContents.length).toBeGreaterThanOrEqual(1);
    expect(sessionContents.some(f => f.endsWith('.jsonl'))).toBe(true);
  });

  // ── Assertion Stubs (Plan 03 will fill these in) ──────────────────

  it.todo('renders summary rows with 4 category lines');

  it.todo('renders top ghosts section sorted by token cost');

  it.todo('renders health score line with grade');

  it.todo('renders --since window in header');

  it.todo('JSON output includes healthScore and recommendation fields');

  it.todo('inventory command renders cli-table3 bordered table');

  it.todo('mcp command renders cli-table3 bordered table with health score');
});
