import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as v from 'valibot';
import { anyLineSchema, assistantLineSchema, userLineSchema } from '../schemas/session-line.ts';
import {
  extractInvocations,
  extractCommandInvocations,
  extractHookInvocations,
} from './extract-invocations.ts';
import type { InvocationRecord, ParsedSessionResult, SessionMeta } from './types.ts';

const MAX_LINE_SIZE = 10 * 1024 * 1024; // 10MB safety limit

/**
 * Parse a JSONL session file using streaming (constant memory).
 *
 * Uses node:readline for line-by-line processing and valibot safeParse
 * for schema validation. Malformed lines are silently skipped.
 *
 * @param filePath - Absolute path to the JSONL session file.
 * @param sinceMs - Time window in milliseconds. Use Infinity to include all.
 * @returns Parsed session result with metadata and invocation records.
 */
export async function parseSession(
  filePath: string,
  sinceMs: number,
): Promise<ParsedSessionResult> {
  const invocations: InvocationRecord[] = [];
  let projectPath: string | null = null;
  const now = Date.now();
  const cutoff = sinceMs === Infinity ? 0 : now - sinceMs;

  // Detect subagent from file path (subagents/agent-*.jsonl) OR from JSONL data
  let isSidechain = filePath.includes('/subagents/agent-');

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    // Skip empty lines and oversized lines (OOM protection)
    if (line.length === 0 || line.length > MAX_LINE_SIZE) continue;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue; // Malformed JSON -- silent skip (DIST-04)
    }

    // Extract cwd and isSidechain from the first line that has them (PARS-06)
    const anyResult = v.safeParse(anyLineSchema, json);
    if (anyResult.success) {
      if (projectPath === null && anyResult.output.cwd) {
        projectPath = anyResult.output.cwd;
      }
      if (!isSidechain && anyResult.output.isSidechain === true) {
        isSidechain = true;
      }
    }

    // Deeply parse assistant messages for tool_use extraction
    const assistantResult = v.safeParse(assistantLineSchema, json);
    if (assistantResult.success) {
      const assistantLine = assistantResult.output;

      // Time window filter (PARS-07)
      if (assistantLine.timestamp) {
        const ts = new Date(assistantLine.timestamp).getTime();
        if (ts < cutoff) continue; // Outside --since window
      }

      // Extract invocations from content blocks (PARS-03, PARS-04, PARS-05)
      const records = extractInvocations(assistantLine);
      invocations.push(...records);
      continue;
    }

    // Also parse user messages for <command-name> tag extraction (Phase 3)
    const userResult = v.safeParse(userLineSchema, json);
    if (userResult.success) {
      const userLine = userResult.output;

      // Time window filter for user lines (use timestamp if present)
      if (userLine.timestamp) {
        const ts = new Date(userLine.timestamp).getTime();
        if (ts < cutoff) continue;
      }

      const commandRecords = extractCommandInvocations(userLine);
      invocations.push(...commandRecords);

      // Phase 4: also extract hook firing signals from tool_result [hook EventName] markers
      const hookRecords = extractHookInvocations(userLine);
      invocations.push(...hookRecords);
    }
  }

  const meta: SessionMeta = {
    filePath,
    projectPath,
    isSidechain,
  };

  return { meta, invocations };
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
      const result = await parseSession(nodePath.join(fixtureDir, 'valid-session.jsonl'), Infinity);
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
      const result = await parseSession(nodePath.join(fixtureDir, 'valid-session.jsonl'), Infinity);
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
