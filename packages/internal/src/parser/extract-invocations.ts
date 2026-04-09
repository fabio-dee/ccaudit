import type { AssistantLine } from '../schemas/session-line.ts';
import type { InvocationRecord } from './types.ts';

/**
 * Parse an MCP tool name (e.g., 'mcp__Chrome__tab') into server and tool components.
 *
 * Format: `mcp__<server>__<tool>` where server may contain single underscores.
 * Splits on the FIRST `__` after stripping the `mcp__` prefix.
 *
 * @returns `{ server, tool }` or `null` if the name is not a valid MCP tool name.
 */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) {
    return null;
  }

  // Strip 'mcp__' prefix (5 characters)
  const remainder = name.slice(5);

  // Find first occurrence of '__' in the remainder
  const separatorIndex = remainder.indexOf('__');
  if (separatorIndex === -1) {
    return null;
  }

  const server = remainder.slice(0, separatorIndex);
  const tool = remainder.slice(separatorIndex + 2);

  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

/**
 * Extract invocation records from an assistant message line.
 *
 * Scans tool_use content blocks for Agent, Task, Skill, and MCP invocations.
 * Blocks with missing required fields (e.g., Agent without subagent_type) are silently skipped.
 *
 * @param line - A validated AssistantLine from the JSONL parser.
 * @returns Array of InvocationRecord, empty if no invocations found.
 */
export function extractInvocations(line: AssistantLine): InvocationRecord[] {
  const records: InvocationRecord[] = [];
  const { content } = line.message;

  // String content (no tool_use blocks)
  if (typeof content === 'string') {
    return records;
  }

  for (const block of content) {
    if (block.type !== 'tool_use') {
      continue;
    }

    // TypeScript needs narrowing -- only tool_use blocks have name/input
    const toolBlock = block as {
      type: 'tool_use';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    };
    const meta = {
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      projectPath: line.cwd ?? '',
      isSidechain: line.isSidechain ?? false,
    };

    if (toolBlock.name === 'Agent' || toolBlock.name === 'Task') {
      const subagentType = toolBlock.input?.subagent_type as string | undefined;
      if (subagentType) {
        records.push({
          kind: 'agent',
          name: subagentType,
          ...meta,
        });
      }
    } else if (toolBlock.name === 'Skill') {
      const skill = toolBlock.input?.skill as string | undefined;
      if (skill) {
        records.push({
          kind: 'skill',
          name: skill,
          ...meta,
        });
      }
    } else if (toolBlock.name.startsWith('mcp__')) {
      const mcpResult = parseMcpName(toolBlock.name);
      if (mcpResult) {
        records.push({
          kind: 'mcp',
          name: mcpResult.server,
          tool: mcpResult.tool,
          ...meta,
        });
      }
    }
  }

  return records;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('parseMcpName', () => {
    it('should parse server with underscore in name', () => {
      const result = parseMcpName('mcp__Claude_in_Chrome__tabs_context_mcp');
      expect(result).toEqual({ server: 'Claude_in_Chrome', tool: 'tabs_context_mcp' });
    });

    it('should parse server with hyphen in name', () => {
      const result = parseMcpName('mcp__sequential-thinking__sequentialthinking');
      expect(result).toEqual({ server: 'sequential-thinking', tool: 'sequentialthinking' });
    });

    it('should parse simple server and tool', () => {
      const result = parseMcpName('mcp__simple__tool');
      expect(result).toEqual({ server: 'simple', tool: 'tool' });
    });

    it('should return null for non-mcp prefix', () => {
      expect(parseMcpName('not_mcp')).toBeNull();
    });

    it('should return null when no __ separator after server', () => {
      expect(parseMcpName('mcp__nodelimiter')).toBeNull();
    });

    it('should return null for regular tool names', () => {
      expect(parseMcpName('Agent')).toBeNull();
    });

    it('should return null for empty server name', () => {
      expect(parseMcpName('mcp____tool')).toBeNull();
    });

    it('should return null for empty tool name', () => {
      expect(parseMcpName('mcp__server__')).toBeNull();
    });

    it('should handle multiple __ delimiters (split on first)', () => {
      const result = parseMcpName('mcp__server__tool__extra');
      expect(result).toEqual({ server: 'server', tool: 'tool__extra' });
    });
  });

  describe('extractInvocations', () => {
    const baseLine = {
      type: 'assistant' as const,
      sessionId: 'sess-001',
      timestamp: '2026-03-27T21:26:27.174Z',
      cwd: '/Users/test/project',
      message: {
        role: 'assistant' as const,
        content: [] as Array<Record<string, unknown>>,
      },
    };

    it('should extract Agent invocation', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_01',
              name: 'Agent',
              input: { subagent_type: 'Explore', prompt: 'test' },
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('agent');
      expect(results[0].name).toBe('Explore');
      expect(results[0].sessionId).toBe('sess-001');
      expect(results[0].projectPath).toBe('/Users/test/project');
      expect(results[0].isSidechain).toBe(false);
      expect(results[0].tool).toBeUndefined();
    });

    it('should extract Task invocation (backward compat)', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_02',
              name: 'Task',
              input: { subagent_type: 'Explore' },
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('agent');
      expect(results[0].name).toBe('Explore');
    });

    it('should extract Skill invocation', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_03',
              name: 'Skill',
              input: { skill: 'gsd:plan-phase' },
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('skill');
      expect(results[0].name).toBe('gsd:plan-phase');
    });

    it('should extract MCP invocation', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'toolu_04', name: 'mcp__Chrome__tab', input: {} },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('mcp');
      expect(results[0].name).toBe('Chrome');
      expect(results[0].tool).toBe('tab');
    });

    it('should return empty array for text-only content', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Hello world' }],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should return empty array for string content', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: 'Hello, how can I help?',
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should extract multiple invocations from multiple tool_use blocks', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'text' as const, text: 'Let me check.' },
            {
              type: 'tool_use' as const,
              id: 'toolu_01',
              name: 'Agent',
              input: { subagent_type: 'Research' },
            },
            {
              type: 'tool_use' as const,
              id: 'toolu_02',
              name: 'mcp__sequential-thinking__sequentialthinking',
              input: {},
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(2);
      expect(results[0].kind).toBe('agent');
      expect(results[0].name).toBe('Research');
      expect(results[1].kind).toBe('mcp');
      expect(results[1].name).toBe('sequential-thinking');
      expect(results[1].tool).toBe('sequentialthinking');
    });

    it('should skip Agent invocation without subagent_type', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'toolu_05', name: 'Agent', input: { prompt: 'test' } },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should skip Skill invocation without skill field', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'toolu_06', name: 'Skill', input: {} }],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should skip invalid MCP name (no tool delimiter)', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'toolu_07', name: 'mcp__nodelimiter', input: {} },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should propagate isSidechain from the line', () => {
      const line = {
        ...baseLine,
        isSidechain: true,
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_08',
              name: 'Agent',
              input: { subagent_type: 'Review' },
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].isSidechain).toBe(true);
    });

    it('should default projectPath to empty string when cwd is missing', () => {
      const line = {
        type: 'assistant' as const,
        sessionId: 'sess-002',
        timestamp: '2026-03-27T22:00:00.000Z',
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_09',
              name: 'Skill',
              input: { skill: 'test-skill' },
            },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].projectPath).toBe('');
    });

    it('should skip Agent invocation without input at all', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'toolu_10', name: 'Agent' }],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('should ignore non-agent/skill/mcp tool_use blocks', () => {
      const line = {
        ...baseLine,
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: 'toolu_11',
              name: 'Read',
              input: { file_path: '/test' },
            },
            { type: 'tool_use' as const, id: 'toolu_12', name: 'Write', input: { content: 'x' } },
          ],
        },
      };
      const results = extractInvocations(line);
      expect(results).toHaveLength(0);
    });
  });
}
