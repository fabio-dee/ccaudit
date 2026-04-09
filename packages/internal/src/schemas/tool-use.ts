import * as v from 'valibot';

/**
 * Schema for a tool_use content block in an assistant message.
 * Validates the specific structure of tool invocation records.
 */
export const toolUseBlockSchema = v.object({
  type: v.literal('tool_use'),
  id: v.string(),
  name: v.string(),
  input: v.optional(v.record(v.string(), v.unknown())),
  caller: v.optional(v.object({ type: v.string() })),
});

export type ToolUseBlock = v.InferOutput<typeof toolUseBlockSchema>;

/**
 * Union schema for any content block in an assistant message.
 * Handles tool_use, text, and catch-all for thinking/tool_result/etc.
 */
export const contentBlockSchema = v.union([
  toolUseBlockSchema,
  v.object({ type: v.literal('text'), text: v.string() }),
  v.object({ type: v.string() }), // Catch-all for thinking, tool_result, etc.
]);

export type ContentBlock = v.InferOutput<typeof contentBlockSchema>;

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('toolUseBlockSchema', () => {
    it('should accept a valid tool_use block with input', () => {
      const result = v.safeParse(toolUseBlockSchema, {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Agent',
        input: { subagent_type: 'Explore' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.name).toBe('Agent');
        expect(result.output.input).toEqual({ subagent_type: 'Explore' });
      }
    });

    it('should accept a tool_use block without optional fields', () => {
      const result = v.safeParse(toolUseBlockSchema, {
        type: 'tool_use',
        id: 'toolu_02',
        name: 'Skill',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.input).toBeUndefined();
        expect(result.output.caller).toBeUndefined();
      }
    });

    it('should reject a block with wrong type literal', () => {
      const result = v.safeParse(toolUseBlockSchema, {
        type: 'text',
        text: 'hello',
      });
      expect(result.success).toBe(false);
    });

    it('should accept a tool_use block with caller', () => {
      const result = v.safeParse(toolUseBlockSchema, {
        type: 'tool_use',
        id: 'toolu_03',
        name: 'mcp__Chrome__tab',
        input: {},
        caller: { type: 'agent' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('contentBlockSchema', () => {
    it('should accept a tool_use block', () => {
      const result = v.safeParse(contentBlockSchema, {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Skill',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a text block', () => {
      const result = v.safeParse(contentBlockSchema, {
        type: 'text',
        text: 'hello world',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a thinking block via catch-all', () => {
      const result = v.safeParse(contentBlockSchema, {
        type: 'thinking',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a tool_result block via catch-all', () => {
      const result = v.safeParse(contentBlockSchema, {
        type: 'tool_result',
      });
      expect(result.success).toBe(true);
    });

    it('should reject a non-object value', () => {
      const result = v.safeParse(contentBlockSchema, 'not an object');
      expect(result.success).toBe(false);
    });
  });
}
