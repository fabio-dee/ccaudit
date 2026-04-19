import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { InventoryItem } from './types.ts';
import { computeConfigRefs, compareConfigRef } from './_config-refs.ts';
import { presentPath } from './_present-path.ts';

/**
 * Shape of ~/.claude.json config relevant to MCP server scanning.
 * Exported so Plan 03 coordinator can access skillUsage and disabledMcpServers.
 */
export interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, unknown>;
      disabledMcpServers?: string[];
    }
  >;
  skillUsage?: Record<
    string,
    {
      usageCount: number;
      lastUsedAt: number;
    }
  >;
}

/**
 * Read and parse ~/.claude.json (or a custom path) safely.
 * Returns an empty object on any error (missing file, corrupt JSON).
 */
export async function readClaudeConfig(configPath?: string): Promise<ClaudeConfig> {
  const resolved = configPath ?? path.join(homedir(), '.claude.json');
  try {
    const raw = await readFile(resolved, 'utf-8');
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return {}; // Missing or corrupt -- return empty
  }
}

/**
 * Discover MCP servers from three sources:
 * 1. Global mcpServers in ~/.claude.json
 * 2. Per-project mcpServers in ~/.claude.json projects.<path>.mcpServers
 * 3. .mcp.json files at each project root
 *
 * Deduplicates by (name, projectPath) key.
 * Silently handles missing/corrupt files (never throws).
 */
export async function scanMcpServers(
  claudeConfigPath: string | undefined,
  projectPaths: string[],
): Promise<InventoryItem[]> {
  const config = await readClaudeConfig(claudeConfigPath);
  const home = homedir();
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  const resolvedConfigPath = claudeConfigPath ?? path.join(home, '.claude.json');

  // Collect every (server key, rendered config path) occurrence across all
  // discovered configs so computeConfigRefs can group by key regardless of
  // project. Rendering happens here via presentPath so the grouping sees
  // already-canonicalized paths (D6-17 / D6-18).
  const occurrences: { key: string; configPath: string }[] = [];

  // 1. Global mcpServers (root level in ~/.claude.json)
  const renderedGlobalConfig = presentPath(resolvedConfigPath, home);
  for (const serverName of Object.keys(config.mcpServers ?? {})) {
    const key = `global::${serverName}`;
    seen.add(key);
    occurrences.push({ key: serverName, configPath: renderedGlobalConfig });
    items.push({
      name: serverName,
      path: resolvedConfigPath,
      scope: 'global',
      category: 'mcp-server',
      projectPath: null,
    });
  }

  // 2. Per-project mcpServers from ~/.claude.json (scope still rendered
  //    against $HOME since that's where the file lives — but the logical
  //    "project" that owns the entry is the key in config.projects).
  for (const [projPath, projConfig] of Object.entries(config.projects ?? {})) {
    for (const serverName of Object.keys(projConfig.mcpServers ?? {})) {
      const key = `${projPath}::${serverName}`;
      occurrences.push({ key: serverName, configPath: renderedGlobalConfig });
      if (!seen.has(key)) {
        seen.add(key);
        items.push({
          name: serverName,
          path: resolvedConfigPath,
          scope: 'project',
          category: 'mcp-server',
          projectPath: projPath,
        });
      }
    }
  }

  // 3. .mcp.json files at project roots — rendered project-relative when
  //    the file lives under the project root (D6-18 project precedence).
  for (const projPath of projectPaths) {
    const mcpJsonPath = path.join(projPath, '.mcp.json');
    try {
      const raw = await readFile(mcpJsonPath, 'utf-8');
      const mcpConfig = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const renderedMcpJsonPath = presentPath(mcpJsonPath, home, projPath);
      for (const serverName of Object.keys(mcpConfig.mcpServers ?? {})) {
        const key = `${projPath}::${serverName}`;
        occurrences.push({ key: serverName, configPath: renderedMcpJsonPath });
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            name: serverName,
            path: mcpJsonPath,
            scope: 'project',
            category: 'mcp-server',
            projectPath: projPath,
          });
        }
      }
    } catch {
      continue; // No .mcp.json or corrupt -- skip silently
    }
  }

  // D6-02: group occurrences by server key, deduplicate, sort via
  // compareConfigRef. Every emitted MCP item gets configRefs >= 1.
  const refs = computeConfigRefs(occurrences);
  return items.map((it) => {
    const list = refs.get(it.name);
    // Defensive: if an item was emitted we also pushed an occurrence for it,
    // so list must exist. Guard against accidental future drift by falling
    // back to a single-element list rendered from the item's own config path.
    const configRefs =
      list ?? [presentPath(it.path, home, it.projectPath ?? undefined)].sort(compareConfigRef);
    return { ...it, configRefs };
  });
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  describe('readClaudeConfig', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'claude-config-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty object when config file does not exist', async () => {
      const result = await readClaudeConfig(path.join(tmpDir, 'nonexistent.json'));
      expect(result).toEqual({});
    });

    it('should return empty object when config is corrupt JSON', async () => {
      const configPath = path.join(tmpDir, 'corrupt.json');
      await writeFile(configPath, 'not valid json {{{');
      const result = await readClaudeConfig(configPath);
      expect(result).toEqual({});
    });

    it('should parse valid claude.json config', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { context7: { type: 'http' } },
          projects: {
            '/test/proj': {
              mcpServers: { supabase: { type: 'http' } },
              disabledMcpServers: ['context7'],
            },
          },
        }),
      );
      const result = await readClaudeConfig(configPath);
      expect(result.mcpServers).toBeDefined();
      expect(Object.keys(result.mcpServers!)).toContain('context7');
      expect(result.projects?.['/test/proj']?.disabledMcpServers).toEqual(['context7']);
    });
  });

  describe('scanMcpServers', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-mcp-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when config file does not exist', async () => {
      const result = await scanMcpServers(path.join(tmpDir, 'nonexistent.json'), []);
      expect(result).toEqual([]);
    });

    it('should discover global MCP servers from root mcpServers', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            context7: { type: 'http' },
            sequential: { type: 'stdio' },
          },
        }),
      );

      const result = await scanMcpServers(configPath, []);
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['context7', 'sequential']);
      for (const item of result) {
        expect(item.scope).toBe('global');
        expect(item.category).toBe('mcp-server');
        expect(item.projectPath).toBeNull();
        expect(item.path).toBe(configPath);
      }
    });

    it('should discover per-project MCP servers from projects config', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(
        configPath,
        JSON.stringify({
          projects: {
            '/test/project-a': {
              mcpServers: { supabase: { type: 'http' } },
            },
          },
        }),
      );

      const result = await scanMcpServers(configPath, []);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('supabase');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe('/test/project-a');
    });

    it('should discover MCP servers from .mcp.json at project roots', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(configPath, '{}');

      const projPath = path.join(tmpDir, 'my-project');
      await mkdir(projPath, { recursive: true });
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'chrome-devtools': { command: 'npx', args: [] },
          },
        }),
      );

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('chrome-devtools');
      expect(result[0].scope).toBe('project');
      expect(result[0].projectPath).toBe(projPath);
      expect(result[0].path).toBe(path.join(projPath, '.mcp.json'));
    });

    it('should deduplicate servers with same (name, projectPath) across sources', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const projPath = path.join(tmpDir, 'dup-project');
      await mkdir(projPath, { recursive: true });

      // Server defined in both claude.json per-project AND .mcp.json
      await writeFile(
        configPath,
        JSON.stringify({
          projects: {
            [projPath]: {
              mcpServers: { 'shared-server': { type: 'http' } },
            },
          },
        }),
      );
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({
          mcpServers: { 'shared-server': { command: 'npx', args: [] } },
        }),
      );

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared-server');
    });

    it('should discover servers from all three sources combined', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const projPath = path.join(tmpDir, 'multi-project');
      await mkdir(projPath, { recursive: true });

      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { 'global-server': { type: 'http' } },
          projects: {
            [projPath]: {
              mcpServers: { 'proj-server': { type: 'http' } },
            },
          },
        }),
      );
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({
          mcpServers: { 'mcp-json-server': { command: 'npx' } },
        }),
      );

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(3);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['global-server', 'mcp-json-server', 'proj-server']);
    });

    it('should handle corrupt .mcp.json silently', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { 'working-server': { type: 'http' } },
        }),
      );

      const projPath = path.join(tmpDir, 'corrupt-project');
      await mkdir(projPath, { recursive: true });
      await writeFile(path.join(projPath, '.mcp.json'), 'not valid json!');

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('working-server');
    });
  });

  describe('scanMcpServers — configRefs (Phase 6, D6-02)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'scan-mcp-refs-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('emits configRefs with length >= 1 for every MCP item (single-config case)', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(configPath, JSON.stringify({ mcpServers: { context7: { type: 'http' } } }));
      const result = await scanMcpServers(configPath, []);
      expect(result).toHaveLength(1);
      expect(result[0].configRefs).toBeDefined();
      expect(result[0].configRefs!.length).toBeGreaterThanOrEqual(1);
    });

    it('collects cross-config references for the same server key', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const projPath = path.join(tmpDir, 'proj');
      await mkdir(projPath, { recursive: true });
      // Same key 'shared' appears in global (root mcpServers) and in
      // project .mcp.json — configRefs on BOTH emitted items must list both.
      await writeFile(configPath, JSON.stringify({ mcpServers: { shared: { type: 'http' } } }));
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({ mcpServers: { shared: { command: 'npx' } } }),
      );
      const result = await scanMcpServers(configPath, [projPath]);
      // Two items: one global-scope, one project-scope (different seen keys).
      expect(result).toHaveLength(2);
      for (const it of result) {
        expect(it.name).toBe('shared');
        expect(it.configRefs).toBeDefined();
        expect(it.configRefs!.length).toBe(2);
        // Project-local ('.mcp.json') must come before a `/`-absolute path
        // per compareConfigRef bucket rule.
        const refs = it.configRefs!;
        expect(refs[0]).toBe('.mcp.json');
        // The second ref is the rendered global config path — may be
        // absolute or ~-compressed depending on whether tmpDir is under
        // $HOME. Either way it must NOT be bucket 0 (project-local).
        expect(refs[1]!.startsWith('.mcp.json')).toBe(false);
      }
    });

    it('renders a project-local .mcp.json as project-relative', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const projPath = path.join(tmpDir, 'p');
      await mkdir(projPath, { recursive: true });
      await writeFile(configPath, '{}');
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({ mcpServers: { only: { command: 'npx' } } }),
      );
      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(1);
      expect(result[0].configRefs).toEqual(['.mcp.json']);
    });
  });
}
