import { homedir } from 'node:os';
import path from 'node:path';
import type { ClaudePaths } from '../types.ts';
import type { InvocationRecord } from '../parser/types.ts';
import type { InventoryItem, ScanResult } from './types.ts';
import { classifyGhost } from './classify.ts';
import { buildInvocationMaps } from './invocation-map.ts';
import { scanAgents } from './scan-agents.ts';
import { scanSkills, resolveSkillName } from './scan-skills.ts';
import { scanMcpServers, readClaudeConfig } from './scan-mcp.ts';
import { scanMemoryFiles } from './scan-memory.ts';
import { annotateFrameworks } from './annotate.ts';

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
  const { agents, skills, mcpServers } = buildInvocationMaps(invocations);
  const config = await readClaudeConfig(claudeConfigPath);
  const skillUsage = config.skillUsage ?? {};

  const results: ScanResult[] = [];

  for (const item of items) {
    let lastUsedMs: number | null = null;
    let count = 0;
    let lastUsedDate: Date | null = null;

    if (item.category === 'agent') {
      const summary = agents.get(item.name);
      if (summary) {
        lastUsedMs = new Date(summary.lastTimestamp).getTime();
        count = summary.count;
        lastUsedDate = new Date(summary.lastTimestamp);
      }
    } else if (item.category === 'skill') {
      // First try invocation map by directory name
      let summary = skills.get(item.name);

      // Also try the resolved (registered) skill name
      if (!summary) {
        const registeredName = await resolveSkillName(item.path);
        summary = skills.get(registeredName);

        // If still no invocation match, check skillUsage from ~/.claude.json
        if (!summary) {
          // Try registered name first, then directory name, then partial match
          const usageEntry =
            skillUsage[registeredName] ??
            skillUsage[item.name] ??
            Object.entries(skillUsage).find(([key]) => key.includes(item.name))?.[1];

          if (usageEntry) {
            lastUsedMs = usageEntry.lastUsedAt;
            count = usageEntry.usageCount;
            lastUsedDate = new Date(usageEntry.lastUsedAt);
          }
        }
      }

      if (summary) {
        lastUsedMs = new Date(summary.lastTimestamp).getTime();
        count = summary.count;
        lastUsedDate = new Date(summary.lastTimestamp);
      }
    } else if (item.category === 'mcp-server') {
      const summary = mcpServers.get(item.name);
      if (summary) {
        lastUsedMs = new Date(summary.lastTimestamp).getTime();
        count = summary.count;
        lastUsedDate = new Date(summary.lastTimestamp);
      }
    } else if (item.category === 'memory') {
      // Memory files use mtimeMs directly (no invocation matching)
      lastUsedMs = item.mtimeMs ?? null;
      count = 0;
      lastUsedDate = lastUsedMs !== null ? new Date(lastUsedMs) : null;
    }

    const tier = classifyGhost(lastUsedMs);

    // For non-memory items, compute lastUsedDate from lastUsedMs if not already set
    if (lastUsedDate === null && lastUsedMs !== null) {
      lastUsedDate = new Date(lastUsedMs);
    }

    results.push({
      item,
      tier,
      lastUsed: lastUsedDate,
      invocationCount: count,
    });
  }

  return results;
}

/**
 * Group scan results by project path.
 * Global items (projectPath === null) are grouped under the 'global' key.
 */
export function groupByProject(results: ScanResult[]): Map<string, ScanResult[]> {
  const map = new Map<string, ScanResult[]>();
  for (const r of results) {
    const key = r.item.projectPath ?? 'global';
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  return map;
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
  // Resolve claudePaths from options or defaults
  const claudePaths: ClaudePaths = options?.claudePaths ?? {
    xdg: path.join(homedir(), '.config', 'claude'),
    legacy: path.join(homedir(), '.claude'),
  };

  // Resolve projectPaths from options or extract unique values from invocations
  const rawProjectPaths: string[] = options?.projectPaths ?? [
    ...new Set(invocations.map((inv) => inv.projectPath).filter(Boolean)),
  ];

  // Filter out homedir — its .claude/ IS the global scope; scanning it as a
  // project-local path would duplicate every global agent/skill/memory file.
  const home = homedir();
  const projectPaths = rawProjectPaths.filter((p) => p !== home);

  // Run all four scanners in parallel
  const [agentItems, skillItems, mcpItems, memoryItems] = await Promise.all([
    scanAgents(claudePaths, projectPaths),
    scanSkills(claudePaths, projectPaths),
    scanMcpServers(options?.claudeConfigPath, projectPaths),
    scanMemoryFiles(claudePaths, projectPaths),
  ]);

  // Phase 2 (v1.3.0): Annotate agent and skill items with their `framework`
  // field BEFORE concat with mcp/memory items. Subset-annotate is the locked
  // D-10 decision: it makes the DETECT-09 scope visible at the call site
  // (mcp + memory bypass annotation entirely) and gives the knownItems
  // threshold the correct semantic (only counts agents/skills toward gstack
  // detection). Memory and mcp items pass through with no `framework` key,
  // preserving byte-identical v1.2.1 JSON output for those categories.
  const annotated = annotateFrameworks([...agentItems, ...skillItems]);

  // Flatten all items
  const allItems: InventoryItem[] = [...annotated, ...mcpItems, ...memoryItems];

  // Classify all items against invocation ledger
  const results = await matchInventory(allItems, invocations, options?.claudeConfigPath);

  // Group by project
  const byProject = groupByProject(results);

  return { results, byProject };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir, homedir: osHomedir } = await import('node:os');

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
        makeRecord({
          kind: 'agent',
          name: 'Explore',
          timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        }),
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
      const items: InventoryItem[] = [
        makeItem({ name: 'deploy', category: 'skill', path: '/mock/skill/deploy' }),
      ];
      const invocations: InvocationRecord[] = [
        makeRecord({
          kind: 'skill',
          name: 'deploy',
          timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        }),
      ];

      const results = await matchInventory(items, invocations);
      expect(results).toHaveLength(1);
      expect(results[0].tier).toBe('used');
      expect(results[0].invocationCount).toBe(1);
    });

    it('returns correct tier for MCP server matched via invocation map', async () => {
      const items: InventoryItem[] = [makeItem({ name: 'context7', category: 'mcp-server' })];
      const invocations: InvocationRecord[] = [
        makeRecord({
          kind: 'mcp',
          name: 'context7',
          tool: 'resolve-library-id',
          timestamp: new Date(Date.now() - 1 * 86_400_000).toISOString(),
        }),
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

  describe('scanAll homedir filter', () => {
    it('does not emit project-scope items for projectPath === homedir()', async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-all-home-'));
      try {
        // Empty global dirs so the global scan yields nothing
        const emptyLegacy = path.join(tmpDir, 'legacy');
        const emptyXdg = path.join(tmpDir, 'xdg');
        await mkdir(emptyLegacy, { recursive: true });
        await mkdir(emptyXdg, { recursive: true });

        const claudePaths = { legacy: emptyLegacy, xdg: emptyXdg };

        // Pass homedir() as a project path — without the fix this would scan
        // ~/.claude/agents/ as project scope and emit duplicates
        const home = osHomedir();
        const { results } = await scanAll([], {
          claudePaths,
          projectPaths: [home],
        });

        const homedirItems = results.filter((r) => r.item.projectPath === home);
        expect(homedirItems).toHaveLength(0);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('still scans non-homedir project paths when homedir() is also in the list', async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-all-mixed-'));
      try {
        const emptyLegacy = path.join(tmpDir, 'legacy');
        const emptyXdg = path.join(tmpDir, 'xdg');
        await mkdir(emptyLegacy, { recursive: true });
        await mkdir(emptyXdg, { recursive: true });

        // A real project with one agent
        const projPath = path.join(tmpDir, 'my-project');
        const agentsDir = path.join(projPath, '.claude', 'agents');
        await mkdir(agentsDir, { recursive: true });
        await writeFile(path.join(agentsDir, 'proj-agent.md'), '# Agent');

        const claudePaths = { legacy: emptyLegacy, xdg: emptyXdg };
        const home = osHomedir();

        const { results } = await scanAll([], {
          claudePaths,
          projectPaths: [home, projPath],
        });

        // The real project agent must appear
        const projItems = results.filter((r) => r.item.projectPath === projPath);
        expect(projItems).toHaveLength(1);
        expect(projItems[0]!.item.name).toBe('proj-agent');

        // homedir must NOT appear as a project path in any result
        const homedirItems = results.filter((r) => r.item.projectPath === home);
        expect(homedirItems).toHaveLength(0);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
}
