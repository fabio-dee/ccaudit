import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as v from 'valibot';
import { anyLineSchema, assistantLineSchema } from '../schemas/session-line.ts';
import { extractInvocations } from './extract-invocations.ts';
import type { InvocationRecord, ParsedSessionResult, SessionMeta } from './types.ts';

const MAX_LINE_SIZE = 10 * 1024 * 1024; // 10MB safety limit

// STUB: intentionally broken for TDD RED phase
export async function parseSession(
  _filePath: string,
  _sinceMs: number,
): Promise<ParsedSessionResult> {
  throw new Error('Not implemented');
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const nodePath = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const fixtureDir = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    '__fixtures__',
  );

  describe('parseSession', () => {
    it('should parse valid-session.jsonl and return 3 invocations', async () => {
      const result = await parseSession(
        nodePath.join(fixtureDir, 'valid-session.jsonl'),
        Infinity,
      );
      expect(result.invocations).toHaveLength(3);
      expect(result.invocations[0].kind).toBe('agent');
      expect(result.invocations[0].name).toBe('Explore');
      expect(result.invocations[1].kind).toBe('skill');
      expect(result.invocations[1].name).toBe('gsd:plan-phase');
      expect(result.invocations[2].kind).toBe('mcp');
      expect(result.invocations[2].name).toBe('Chrome');
      expect(result.invocations[2].tool).toBe('get_tabs');
    });

    it('should extract projectPath from first cwd field', async () => {
      const result = await parseSession(
        nodePath.join(fixtureDir, 'valid-session.jsonl'),
        Infinity,
      );
      expect(result.meta.projectPath).toBe('/test/project');
    });

    it('should NOT throw on malformed-session.jsonl', async () => {
      const result = await parseSession(
        nodePath.join(fixtureDir, 'malformed-session.jsonl'),
        Infinity,
      );
      // Should silently skip bad lines and return 1 invocation (the valid Agent line)
      expect(result.invocations).toHaveLength(1);
      expect(result.invocations[0].kind).toBe('agent');
      expect(result.invocations[0].name).toBe('Coder');
      expect(result.meta.projectPath).toBe('/test/malformed');
    });

    it('should parse subagent-session.jsonl with isSidechain=true', async () => {
      const result = await parseSession(
        nodePath.join(fixtureDir, 'subagent-session.jsonl'),
        Infinity,
      );
      expect(result.meta.isSidechain).toBe(true);
      expect(result.invocations).toHaveLength(1);
      expect(result.invocations[0].kind).toBe('skill');
      expect(result.invocations[0].name).toBe('gsd:execute-phase');
      expect(result.invocations[0].isSidechain).toBe(true);
    });

    it('should filter out invocations older than sinceMs', async () => {
      // All fixture timestamps are from 2026-03-27 -- using 1ms window means all are outside
      const result = await parseSession(
        nodePath.join(fixtureDir, 'valid-session.jsonl'),
        1, // 1ms window -- everything is in the past
      );
      expect(result.invocations).toHaveLength(0);
    });
  });
}
