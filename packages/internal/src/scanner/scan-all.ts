import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudePaths } from '../types.ts';
import type { InvocationRecord } from '../parser/types.ts';
import type { InventoryItem, ScanResult, InvocationSummary } from './types.ts';
import { classifyGhost } from './classify.ts';
import { buildInvocationMaps } from './invocation-map.ts';
import { scanAgents } from './scan-agents.ts';
import { scanSkills, resolveSkillName } from './scan-skills.ts';
import { scanMcpServers, readClaudeConfig } from './scan-mcp.ts';
import { scanMemoryFiles } from './scan-memory.ts';

/**
 * Match inventory items against the invocation ledger and classify ghost tier.
 *
 * - Agents and MCP servers: matched by name in invocation maps
 * - Skills: matched first by invocation map (both dir name and resolved name),
 *   then by skillUsage from ~/.claude.json as fallback
 * - Memory files: classified by mtimeMs (no invocation matching)
 */
export async function matchInventory(
  items: InventoryItem[],
  invocations: InvocationRecord[],
  claudeConfigPath?: string,
): Promise<ScanResult[]> {
  // TODO: implement
  return [];
}

/**
 * Group scan results by project path.
 * Global items (projectPath === null) are grouped under the 'global' key.
 */
export function groupByProject(results: ScanResult[]): Map<string, ScanResult[]> {
  // TODO: implement
  return new Map();
}

/**
 * Run all four inventory scanners in parallel, classify all items
 * against the invocation ledger, and return results with per-project breakdown.
 */
export async function scanAll(
  invocations: InvocationRecord[],
  options?: {
    claudePaths?: ClaudePaths;
    projectPaths?: string[];
    claudeConfigPath?: string;
  },
): Promise<{
  results: ScanResult[];
  byProject: Map<string, ScanResult[]>;
}> {
  // TODO: implement
  return { results: [], byProject: new Map() };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Reusable factory for mock InventoryItem
  function makeItem(
    overrides: Partial<InventoryItem> & Pick<InventoryItem, 'name' | 'category'>,
  ): InventoryItem {
    return {
      path: `/mock/${overrides.category}/${overrides.name}`,
      scope: 'global',
      projectPath: null,
      ...overrides,
    };
  }

  // Reusable factory for mock InvocationRecord
  function makeRecord(
    overrides: Partial<InvocationRecord> & Pick<InvocationRecord, 'kind' | 'name'>,
  ): InvocationRecord {
    return {
      sessionId: 'sess-001',
      timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(), // 2 days ago
      projectPath: '/Users/test/project',
      isSidechain: false,
      ...overrides,
    };
  }

  describe('matchInventory', () => {
    it('returns tier=used for agent with matching invocation', async () => {
      const items: InventoryItem[] = [makeItem({ name: 'Explore', category: 'agent' })];
      const invocations: InvocationRecord[] = [
        makeRecord({ kind: 'agent', name: 'Explore', timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
      ];

      const results = await matchInventory(items, invocations);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('used');
      expect(results[0].lastUsed).toBeInstanceOf(Date);
      expect(results[0].invocationCount).toBe(1);
    });

    it('returns tier=definite-ghost for agent with no matching invocation', async () => {
      const items: InventoryItem[] = [makeItem({ name: 'StaleAgent', category: 'agent' })];
      const invocations: InvocationRecord[] = []; // no invocations at all

      const results = await matchInventory(items, invocations);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('definite-ghost');
      expect(results[0].lastUsed).toBeNull();
      expect(results[0].invocationCount).toBe(0);
    });

    it('returns correct tier for skill matched via invocation map', async () => {
      const items: InventoryItem[] = [makeItem({ name: 'deploy', category: 'skill', path: '/mock/skill/deploy' })];
      const invocations: InvocationRecord[] = [
        makeRecord({ kind: 'skill', name: 'deploy', timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      ];

      const results = await matchInventory(items, invocations);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('used');
      expect(results[0].invocationCount).toBe(1);
    });

    it('returns correct tier for MCP server matched via invocation map', async () => {
      const items: InventoryItem[] = [makeItem({ name: 'context7', category: 'mcp-server' })];
      const invocations: InvocationRecord[] = [
        makeRecord({ kind: 'mcp', name: 'context7', tool: 'resolve-library-id', timestamp: new Date(Date.now() - 1 * 86_400_000).toISOString() }),
      ];

      const results = await matchInventory(items, invocations);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('used');
      expect(results[0].invocationCount).toBe(1);
    });

    it('classifies memory file by mtimeMs -- 5 days ago = used', async () => {
      const fiveDaysAgo = Date.now() - 5 * 86_400_000;
      const items: InventoryItem[] = [
        makeItem({ name: 'CLAUDE.md', category: 'memory', mtimeMs: fiveDaysAgo }),
      ];

      const results = await matchInventory(items, []);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('used');
      expect(results[0].lastUsed).toBeInstanceOf(Date);
      expect(results[0].invocationCount).toBe(0);
    });

    it('classifies memory file by mtimeMs -- 15 days ago = likely-ghost', async () => {
      const fifteenDaysAgo = Date.now() - 15 * 86_400_000;
      const items: InventoryItem[] = [
        makeItem({ name: 'CLAUDE.md', category: 'memory', mtimeMs: fifteenDaysAgo }),
      ];

      const results = await matchInventory(items, []);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('likely-ghost');
    });

    it('classifies memory file by mtimeMs -- 60 days ago = definite-ghost', async () => {
      const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
      const items: InventoryItem[] = [
        makeItem({ name: 'CLAUDE.md', category: 'memory', mtimeMs: sixtyDaysAgo }),
      ];

      const results = await matchInventory(items, []);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('definite-ghost');
    });

    it('classifies memory file with no mtimeMs as definite-ghost', async () => {
      const items: InventoryItem[] = [
        makeItem({ name: 'CLAUDE.md', category: 'memory' }), // no mtimeMs
      ];

      const results = await matchInventory(items, []);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('definite-ghost');
      expect(results[0].lastUsed).toBeNull();
    });
  });

  describe('groupByProject', () => {
    it('groups results by item.projectPath', () => {
      const results: ScanResult[] = [
        {
          item: makeItem({ name: 'agent-a', category: 'agent', projectPath: '/proj/a' }),
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 5,
        },
        {
          item: makeItem({ name: 'agent-b', category: 'agent', projectPath: '/proj/b' }),
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
        {
          item: makeItem({ name: 'agent-c', category: 'agent', projectPath: '/proj/a' }),
          tier: 'likely-ghost',
          lastUsed: new Date(),
          invocationCount: 1,
        },
      ];

      const grouped = groupByProject(results);
      expect(grouped.size).toBe(2);
      expect(grouped.get('/proj/a')).toHaveLength(2);
      expect(grouped.get('/proj/b')).toHaveLength(1);
    });

    it('groups global items under "global" key', () => {
      const results: ScanResult[] = [
        {
          item: makeItem({ name: 'global-agent', category: 'agent', projectPath: null }),
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 3,
        },
      ];

      const grouped = groupByProject(results);
      expect(grouped.size).toBe(1);
      expect(grouped.has('global')).toBe(true);
      expect(grouped.get('global')).toHaveLength(1);
    });

    it('separates global and project items', () => {
      const results: ScanResult[] = [
        {
          item: makeItem({ name: 'global-agent', category: 'agent', projectPath: null }),
          tier: 'used',
          lastUsed: new Date(),
          invocationCount: 3,
        },
        {
          item: makeItem({ name: 'proj-agent', category: 'agent', projectPath: '/proj/x' }),
          tier: 'definite-ghost',
          lastUsed: null,
          invocationCount: 0,
        },
      ];

      const grouped = groupByProject(results);
      expect(grouped.size).toBe(2);
      expect(grouped.has('global')).toBe(true);
      expect(grouped.has('/proj/x')).toBe(true);
    });
  });
}
