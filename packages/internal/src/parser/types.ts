/**
 * Kind of invocation detected in JSONL tool_use blocks.
 * 'command' is emitted by extractCommandInvocations from user-line <command-name> markers.
 * 'hook' is emitted by extractHookInvocations from tool-result [hook EventName] markers.
 */
export type InvocationKind = 'agent' | 'skill' | 'mcp' | 'command' | 'hook';

/**
 * A single invocation record extracted from a JSONL assistant message.
 */
export interface InvocationRecord {
  /** Classification: agent, skill, or mcp */
  kind: InvocationKind;
  /** Agent subagent_type, skill name, or MCP server name */
  name: string;
  /** MCP tool name (only present for kind='mcp') */
  tool?: string;
  /** Session ID from the JSONL line */
  sessionId: string;
  /** ISO 8601 timestamp (e.g., '2026-03-27T21:26:27.174Z') */
  timestamp: string;
  /** Project path from the cwd field */
  projectPath: string;
  /** Whether this invocation occurred in a sidechain (subagent) session */
  isSidechain: boolean;
}

/**
 * Metadata about a parsed session file.
 */
export interface SessionMeta {
  /** Absolute path to the JSONL file */
  filePath: string;
  /** Project path extracted from cwd field, null if not found */
  projectPath: string | null;
  /** Whether the session is a sidechain (subagent) session */
  isSidechain: boolean;
}

/**
 * Result of parsing a complete session file.
 */
export interface ParsedSessionResult {
  /** Session file metadata */
  meta: SessionMeta;
  /** All invocation records extracted from the session */
  invocations: InvocationRecord[];
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('InvocationRecord', () => {
    it('should accept a valid agent invocation', () => {
      const record: InvocationRecord = {
        kind: 'agent',
        name: 'Explore',
        sessionId: 'sess-001',
        timestamp: '2026-03-27T21:26:27.174Z',
        projectPath: '/Users/test/project',
        isSidechain: false,
      };
      expect(record.kind).toBe('agent');
      expect(record.tool).toBeUndefined();
    });

    it('should accept a valid skill invocation', () => {
      const record: InvocationRecord = {
        kind: 'skill',
        name: 'gsd:plan-phase',
        sessionId: 'sess-002',
        timestamp: '2026-03-27T22:00:00.000Z',
        projectPath: '/Users/test/project',
        isSidechain: false,
      };
      expect(record.kind).toBe('skill');
      expect(record.name).toBe('gsd:plan-phase');
    });

    it('should accept a valid mcp invocation with tool field', () => {
      const record: InvocationRecord = {
        kind: 'mcp',
        name: 'sequential-thinking',
        tool: 'sequentialthinking',
        sessionId: 'sess-003',
        timestamp: '2026-03-27T23:00:00.000Z',
        projectPath: '/Users/test/project',
        isSidechain: true,
      };
      expect(record.kind).toBe('mcp');
      expect(record.tool).toBe('sequentialthinking');
      expect(record.isSidechain).toBe(true);
    });
  });

  describe('SessionMeta', () => {
    it('should accept metadata with null projectPath', () => {
      const meta: SessionMeta = {
        filePath: '/home/user/.claude/projects/abc/session.jsonl',
        projectPath: null,
        isSidechain: false,
      };
      expect(meta.projectPath).toBeNull();
    });
  });

  describe('ParsedSessionResult', () => {
    it('should hold meta and invocations together', () => {
      const result: ParsedSessionResult = {
        meta: {
          filePath: '/home/user/.claude/projects/abc/session.jsonl',
          projectPath: '/Users/test/project',
          isSidechain: false,
        },
        invocations: [],
      };
      expect(result.invocations).toHaveLength(0);
      expect(result.meta.projectPath).toBe('/Users/test/project');
    });
  });
}
