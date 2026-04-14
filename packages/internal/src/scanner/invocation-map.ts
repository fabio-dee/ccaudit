import type { InvocationRecord } from '../parser/types.ts';
import type { InvocationSummary } from './types.ts';

/**
 * Build lookup maps from the invocation ledger for fast O(1) matching.
 * Returns separate maps for agents, skills, MCP servers, commands, and hooks,
 * each keyed by item name with aggregated invocation summaries.
 *
 * Hook firing signals use event-level keys (e.g. 'SessionStart:*') because
 * the matcher is not recoverable from the [hook EventName] text marker.
 *
 * @param invocations - All invocation records from parsed JSONL sessions
 * @returns Five maps: agents, skills, mcpServers, commands, hooks
 */
export function buildInvocationMaps(invocations: InvocationRecord[]): {
  agents: Map<string, InvocationSummary>;
  skills: Map<string, InvocationSummary>;
  mcpServers: Map<string, InvocationSummary>;
  commands: Map<string, InvocationSummary>;
  hooks: Map<string, InvocationSummary>;
} {
  const agents = new Map<string, InvocationSummary>();
  const skills = new Map<string, InvocationSummary>();
  const mcpServers = new Map<string, InvocationSummary>();
  const commands = new Map<string, InvocationSummary>();
  const hooks = new Map<string, InvocationSummary>();

  for (const inv of invocations) {
    const targetMap =
      inv.kind === 'agent'
        ? agents
        : inv.kind === 'skill'
          ? skills
          : inv.kind === 'command'
            ? commands
            : inv.kind === 'hook'
              ? hooks
              : mcpServers;

    const existing = targetMap.get(inv.name);
    if (existing) {
      if (inv.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = inv.timestamp;
      }
      existing.count++;
      if (inv.projectPath) existing.projects.add(inv.projectPath);
    } else {
      const projects = new Set<string>();
      if (inv.projectPath) projects.add(inv.projectPath);
      targetMap.set(inv.name, {
        lastTimestamp: inv.timestamp,
        count: 1,
        projects,
      });
    }
  }

  return { agents, skills, mcpServers, commands, hooks };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Reusable factory for InvocationRecord fixtures
  function makeRecord(
    overrides: Partial<InvocationRecord> & Pick<InvocationRecord, 'kind' | 'name'>,
  ): InvocationRecord {
    return {
      sessionId: 'sess-001',
      timestamp: '2026-04-01T12:00:00.000Z',
      projectPath: '/Users/test/project',
      isSidechain: false,
      ...overrides,
    };
  }

  describe('buildInvocationMaps', () => {
    it('returns five empty Maps for empty input', () => {
      const result = buildInvocationMaps([]);
      expect(result.agents.size).toBe(0);
      expect(result.skills.size).toBe(0);
      expect(result.mcpServers.size).toBe(0);
      expect(result.commands.size).toBe(0);
      expect(result.hooks.size).toBe(0);
    });

    it('routes a single hook invocation to hooks map', () => {
      const result = buildInvocationMaps([makeRecord({ kind: 'hook', name: 'SessionStart:*' })]);
      expect(result.hooks.size).toBe(1);
      expect(result.agents.size).toBe(0);
      expect(result.skills.size).toBe(0);
      expect(result.commands.size).toBe(0);

      const entry = result.hooks.get('SessionStart:*')!;
      expect(entry.count).toBe(1);
      expect(entry.lastTimestamp).toBe('2026-04-01T12:00:00.000Z');
    });

    it('routes a single agent invocation to agents map', () => {
      const result = buildInvocationMaps([makeRecord({ kind: 'agent', name: 'Explore' })]);
      expect(result.agents.size).toBe(1);
      expect(result.skills.size).toBe(0);
      expect(result.mcpServers.size).toBe(0);
      expect(result.commands.size).toBe(0);

      const entry = result.agents.get('Explore')!;
      expect(entry.count).toBe(1);
      expect(entry.lastTimestamp).toBe('2026-04-01T12:00:00.000Z');
      expect(entry.projects.has('/Users/test/project')).toBe(true);
    });

    it('routes a single command invocation to commands map', () => {
      const result = buildInvocationMaps([makeRecord({ kind: 'command', name: 'gsd:update' })]);
      expect(result.commands.size).toBe(1);
      expect(result.agents.size).toBe(0);
      expect(result.skills.size).toBe(0);
      expect(result.mcpServers.size).toBe(0);

      const entry = result.commands.get('gsd:update')!;
      expect(entry.count).toBe(1);
      expect(entry.lastTimestamp).toBe('2026-04-01T12:00:00.000Z');
    });

    it('routes a single skill invocation to skills map', () => {
      const result = buildInvocationMaps([makeRecord({ kind: 'skill', name: 'gsd:plan-phase' })]);
      expect(result.skills.size).toBe(1);
      expect(result.agents.size).toBe(0);
      expect(result.mcpServers.size).toBe(0);

      const entry = result.skills.get('gsd:plan-phase')!;
      expect(entry.count).toBe(1);
    });

    it('routes a single MCP invocation to mcpServers map', () => {
      const result = buildInvocationMaps([
        makeRecord({ kind: 'mcp', name: 'sequential-thinking', tool: 'sequentialthinking' }),
      ]);
      expect(result.mcpServers.size).toBe(1);
      expect(result.agents.size).toBe(0);
      expect(result.skills.size).toBe(0);

      const entry = result.mcpServers.get('sequential-thinking')!;
      expect(entry.count).toBe(1);
    });

    it('accumulates count and updates lastTimestamp for same agent', () => {
      const result = buildInvocationMaps([
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          timestamp: '2026-04-01T10:00:00.000Z',
          sessionId: 'sess-001',
        }),
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          timestamp: '2026-04-01T14:00:00.000Z',
          sessionId: 'sess-002',
        }),
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          timestamp: '2026-04-01T12:00:00.000Z',
          sessionId: 'sess-003',
        }),
      ]);

      const entry = result.agents.get('Explore')!;
      expect(entry.count).toBe(3);
      // Should track the chronologically latest timestamp
      expect(entry.lastTimestamp).toBe('2026-04-01T14:00:00.000Z');
    });

    it('accumulates projects from different project paths', () => {
      const result = buildInvocationMaps([
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          projectPath: '/Users/test/project-a',
        }),
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          projectPath: '/Users/test/project-b',
        }),
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          projectPath: '/Users/test/project-a', // duplicate
        }),
      ]);

      const entry = result.agents.get('Explore')!;
      expect(entry.count).toBe(3);
      expect(entry.projects.size).toBe(2);
      expect(entry.projects.has('/Users/test/project-a')).toBe(true);
      expect(entry.projects.has('/Users/test/project-b')).toBe(true);
    });

    it('distributes mixed invocations to correct maps', () => {
      const result = buildInvocationMaps([
        makeRecord({ kind: 'agent', name: 'Explore' }),
        makeRecord({ kind: 'skill', name: 'gsd:plan-phase' }),
        makeRecord({ kind: 'mcp', name: 'context7', tool: 'resolve-library-id' }),
        makeRecord({ kind: 'agent', name: 'Bash' }),
        makeRecord({ kind: 'mcp', name: 'context7', tool: 'get-library-docs' }),
      ]);

      expect(result.agents.size).toBe(2);
      expect(result.skills.size).toBe(1);
      expect(result.mcpServers.size).toBe(1);

      expect(result.agents.has('Explore')).toBe(true);
      expect(result.agents.has('Bash')).toBe(true);
      expect(result.skills.has('gsd:plan-phase')).toBe(true);
      expect(result.mcpServers.has('context7')).toBe(true);

      // context7 should have count=2 from two invocations
      expect(result.mcpServers.get('context7')!.count).toBe(2);
    });

    it('tracks chronologically latest timestamp via ISO string comparison', () => {
      const result = buildInvocationMaps([
        makeRecord({
          kind: 'skill',
          name: 'deploy',
          timestamp: '2026-04-02T23:59:59.999Z',
        }),
        makeRecord({
          kind: 'skill',
          name: 'deploy',
          timestamp: '2026-04-01T00:00:00.000Z',
        }),
      ]);

      const entry = result.skills.get('deploy')!;
      expect(entry.lastTimestamp).toBe('2026-04-02T23:59:59.999Z');
    });

    it('handles empty projectPath by not adding to projects set', () => {
      const result = buildInvocationMaps([
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          projectPath: '',
        }),
      ]);

      const entry = result.agents.get('Explore')!;
      expect(entry.projects.size).toBe(0);
    });
  });
}
