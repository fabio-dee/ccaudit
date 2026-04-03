import * as v from 'valibot';
import { contentBlockSchema } from './tool-use.ts';

/**
 * Lightweight schema: extracts type + cwd + timestamp + sessionId from ANY line.
 * Used for quick filtering before deep parsing.
 */
export const anyLineSchema = v.object({
  type: v.string(),
  sessionId: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  cwd: v.optional(v.string()),
  isSidechain: v.optional(v.boolean()),
});

export type AnyLine = v.InferOutput<typeof anyLineSchema>;

/**
 * Full assistant message schema -- the only type we deeply parse for tool_use extraction.
 * Validates structure of assistant messages containing content blocks.
 */
export const assistantLineSchema = v.object({
  type: v.literal('assistant'),
  sessionId: v.string(),
  timestamp: v.string(),
  cwd: v.optional(v.string()),
  isSidechain: v.optional(v.boolean()),
  parentUuid: v.optional(v.nullable(v.string())),
  message: v.object({
    role: v.literal('assistant'),
    content: v.union([
      v.array(contentBlockSchema),
      v.string(),
    ]),
  }),
});

export type AssistantLine = v.InferOutput<typeof assistantLineSchema>;

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('anyLineSchema', () => {
    it('should accept a full line with all fields', () => {
      const result = v.safeParse(anyLineSchema, {
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/tmp',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.type).toBe('assistant');
        expect(result.output.cwd).toBe('/tmp');
      }
    });

    it('should accept a minimal line with only type', () => {
      const result = v.safeParse(anyLineSchema, {
        type: 'progress',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.sessionId).toBeUndefined();
        expect(result.output.cwd).toBeUndefined();
      }
    });

    it('should accept a line with isSidechain', () => {
      const result = v.safeParse(anyLineSchema, {
        type: 'assistant',
        sessionId: 'xyz',
        isSidechain: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.isSidechain).toBe(true);
      }
    });

    it('should reject a non-object value', () => {
      const result = v.safeParse(anyLineSchema, 'not an object');
      expect(result.success).toBe(false);
    });

    it('should reject null', () => {
      const result = v.safeParse(anyLineSchema, null);
      expect(result.success).toBe(false);
    });
  });

  describe('assistantLineSchema', () => {
    it('should accept a valid assistant message with tool_use content', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
        sessionId: 'sess-001',
        timestamp: '2026-03-27T21:26:27.174Z',
        cwd: '/Users/test/project',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Agent',
              input: { subagent_type: 'Explore', prompt: 'test' },
            },
          ],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.sessionId).toBe('sess-001');
        expect(Array.isArray(result.output.message.content)).toBe(true);
      }
    });

    it('should accept assistant message with string content', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
        sessionId: 'sess-002',
        timestamp: '2026-03-27T22:00:00.000Z',
        message: {
          role: 'assistant',
          content: 'Hello, how can I help?',
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.output.message.content).toBe('string');
      }
    });

    it('should accept assistant message with isSidechain and parentUuid', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
        sessionId: 'sess-003',
        timestamp: '2026-03-27T23:00:00.000Z',
        isSidechain: true,
        parentUuid: 'parent-uuid-123',
        message: {
          role: 'assistant',
          content: [],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.isSidechain).toBe(true);
        expect(result.output.parentUuid).toBe('parent-uuid-123');
      }
    });

    it('should accept assistant message with null parentUuid', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
        sessionId: 'sess-004',
        timestamp: '2026-03-27T23:00:00.000Z',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.parentUuid).toBeNull();
      }
    });

    it('should reject a user message (wrong type literal)', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'user',
        sessionId: 'sess-005',
        timestamp: '2026-03-27T23:00:00.000Z',
        message: {
          role: 'user',
          content: 'hello',
        },
      });
      expect(result.success).toBe(false);
    });

    it('should reject a line missing required fields', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
      });
      expect(result.success).toBe(false);
    });

    it('should accept assistant message with mixed content blocks', () => {
      const result = v.safeParse(assistantLineSchema, {
        type: 'assistant',
        sessionId: 'sess-006',
        timestamp: '2026-03-28T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check that.' },
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'mcp__Chrome__tab',
              input: { url: 'https://example.com' },
            },
            { type: 'thinking' },
          ],
        },
      });
      expect(result.success).toBe(true);
    });
  });
}
