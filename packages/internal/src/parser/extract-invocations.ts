import type { AssistantLine, UserLine } from '../schemas/session-line.ts';
import type { InvocationRecord } from './types.ts';

/**
 * Regex matching [hook EventName] text markers in tool-result content.
 *
 * Real session format check (grepped ~/.claude/projects/ across 1473 JSONL files):
 * Markers appear in assistant tool_use input text as plan content, and in user
 * tool_result blocks as plan content. No actual hook-firing signal was found in
 * the sampled corpus — all occurrences were documentation/plan text, not runtime
 * output. The extractor is therefore effectively inert on real session data.
 *
 * Consequence: ALL inject-capable hooks will be classified as 'dormant' (zero
 * observed fires). This is the correct conservative behaviour — the plan spec
 * explicitly anticipates this outcome.
 *
 * If Claude Code starts embedding hook-firing markers in tool_result blocks in a
 * future release, this extractor will begin attributing firings correctly without
 * any code change.
 */
const HOOK_FIRE_PATTERN = /\[hook\s+(\w+)\]/g;

/**
 * Extract hook invocation records from a user message line.
 *
 * Scans all tool_result content blocks for [hook EventName] text markers.
 * The name is set to `${event}:*` — the `:*` placeholder is intentional:
 * we cannot recover the specific matcher from the firing signal, so we
 * attribute to event-level. The matching pass in scan-all.ts will then
 * credit all configured hooks for that event.
 *
 * @param line - A validated UserLine from the JSONL parser.
 * @returns Array of InvocationRecord with kind='hook', empty if none found.
 */
export function extractHookInvocations(line: UserLine): InvocationRecord[] {
  const records: InvocationRecord[] = [];
  const meta = {
    sessionId: line.sessionId ?? '',
    timestamp: line.timestamp ?? new Date(0).toISOString(),
    projectPath: line.cwd ?? '',
    isSidechain: line.isSidechain ?? false,
  };

  const { content } = line.message;

  // Collect all text strings from tool_result content blocks
  const texts: string[] = [];
  if (typeof content === 'string') {
    texts.push(content);
  } else {
    for (const block of content) {
      // Only scan tool_result blocks for hook firing markers
      if (block.text) texts.push(block.text);
    }
  }

  for (const text of texts) {
    HOOK_FIRE_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HOOK_FIRE_PATTERN.exec(text)) !== null) {
      const event = m[1];
      if (event) {
        // Use event:* as name — matcher is not recoverable from the firing signal
        records.push({ kind: 'hook', name: `${event}:*`, ...meta });
      }
    }
  }

  return records;
}

/**
 * Extract command invocations from a user message line.
 *
 * Scans all text content for <command-name>...</command-name> tags.
 * Emits one InvocationRecord per match with kind='command'.
 *
 * Real session format (from ~/.claude/projects/ spot-check):
 *   <command-name>/gsd:update</command-name>
 *   <command-name>/clear</command-name>
 *
 * Namespacing: the leading slash is stripped; ':' separators are preserved
 * so 'gsd:update' matches scan-commands.ts namespace convention.
 *
 * @param line - A validated UserLine from the JSONL parser.
 * @returns Array of InvocationRecord with kind='command', empty if none found.
 */
export function extractCommandInvocations(line: UserLine): InvocationRecord[] {
  const records: InvocationRecord[] = [];
  const meta = {
    sessionId: line.sessionId ?? '',
    timestamp: line.timestamp ?? new Date(0).toISOString(),
    projectPath: line.cwd ?? '',
    isSidechain: line.isSidechain ?? false,
  };

  const { content } = line.message;

  // Collect all text strings to search
  const texts: string[] = [];
  if (typeof content === 'string') {
    texts.push(content);
  } else {
    for (const block of content) {
      if (block.text) texts.push(block.text);
    }
  }

  // Regex: match <command-name>/optional-slash + name </command-name>
  // Leading slash is optional; name may contain letters, digits, hyphens, colons
  const tagPattern = /<command-name>\s*\/?([^\s<]+)\s*<\/command-name>/g;

  for (const text of texts) {
    let m: RegExpExecArray | null;
    tagPattern.lastIndex = 0;
    while ((m = tagPattern.exec(text)) !== null) {
      const name = m[1];
      if (name) {
        records.push({ kind: 'command', name, ...meta });
      }
    }
  }

  return records;
}

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

  describe('extractCommandInvocations', () => {
    const baseUserLine: UserLine = {
      type: 'user',
      sessionId: 'sess-001',
      timestamp: '2026-04-01T12:00:00.000Z',
      cwd: '/Users/test/project',
      isSidechain: false,
      message: { role: 'user', content: '' },
    };

    it('<command-name>/gsd-new-project</command-name> → name gsd-new-project', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content: '<command-name>/gsd-new-project</command-name>\nsome text',
        },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('command');
      expect(results[0].name).toBe('gsd-new-project');
      expect(results[0].sessionId).toBe('sess-001');
      expect(results[0].projectPath).toBe('/Users/test/project');
    });

    it('<command-name>/git:commit</command-name> → name git:commit (colon namespace preserved)', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: '<command-name>/git:commit</command-name>' },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('git:commit');
    });

    it('<command-name>gsd-new-project</command-name> without leading slash → same name', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: '<command-name>gsd-new-project</command-name>' },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('gsd-new-project');
    });

    it('multiple command tags in same user line → all extracted', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content:
            '<command-name>/gsd:update</command-name>\nsome text\n<command-name>/clear</command-name>',
        },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name)).toEqual(['gsd:update', 'clear']);
    });

    it('no <command-name> tag in content → empty array', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: 'just a regular user message with no tags' },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('array content blocks → extracts from text blocks', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<command-name>/gsd:update</command-name>' }],
        },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('gsd:update');
    });

    it('array content with non-text block → skipped gracefully', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result' },
            { type: 'text', text: '<command-name>/clear</command-name>' },
          ],
        },
      };
      const results = extractCommandInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('clear');
    });
  });

  describe('extractHookInvocations', () => {
    const baseUserLine: UserLine = {
      type: 'user',
      sessionId: 'sess-001',
      timestamp: '2026-04-01T12:00:00.000Z',
      cwd: '/Users/test/project',
      isSidechain: false,
      message: { role: 'user', content: '' },
    };

    it('[hook SessionStart] in text content → one hook invocation with name SessionStart:*', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: '[hook SessionStart] output: session initialized' },
      };
      const results = extractHookInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('hook');
      expect(results[0].name).toBe('SessionStart:*');
      expect(results[0].sessionId).toBe('sess-001');
      expect(results[0].projectPath).toBe('/Users/test/project');
    });

    it('multiple [hook X] markers in same content → all extracted', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content: '[hook PreToolUse] pre-check\n[hook PostToolUse] post-check',
        },
      };
      const results = extractHookInvocations(line);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('PreToolUse:*');
      expect(results[1].name).toBe('PostToolUse:*');
    });

    it('no [hook ...] markers → empty array', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: 'just a regular message, no hook markers' },
      };
      const results = extractHookInvocations(line);
      expect(results).toHaveLength(0);
    });

    it('array content blocks → extracts from text blocks', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[hook SessionStart] running startup hooks' }],
        },
      };
      const results = extractHookInvocations(line);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('SessionStart:*');
    });

    it('hook name uses event:* placeholder (matcher not recoverable from firing signal)', () => {
      const line: UserLine = {
        ...baseUserLine,
        message: { role: 'user', content: '[hook PreToolUse] check before bash' },
      };
      const results = extractHookInvocations(line);
      expect(results[0].name).toBe('PreToolUse:*');
    });
  });
}
