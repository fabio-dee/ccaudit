import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { InventoryItem } from './types.ts';

/**
 * Shape of ~/.claude.json config relevant to MCP server scanning.
 * Exported so Plan 03 coordinator can access skillUsage and disabledMcpServers.
 */
export interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, {
    mcpServers?: Record<string, unknown>;
    disabledMcpServers?: string[];
  }>;
  skillUsage?: Record<string, {
    usageCount: number;
    lastUsedAt: number;
  }>;
}

/**
 * Read and parse ~/.claude.json (or a custom path) safely.
 * Returns an empty object on any error (missing file, corrupt JSON).
 */
export async function readClaudeConfig(configPath?: string): Promise<ClaudeConfig> {
  // TODO: implement
  throw new Error('Not implemented');
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
  // TODO: implement
  throw new Error('Not implemented');
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
      await writeFile(configPath, JSON.stringify({
        mcpServers: { context7: { type: 'http' } },
        projects: {
          '/test/proj': {
            mcpServers: { supabase: { type: 'http' } },
            disabledMcpServers: ['context7'],
          },
        },
      }));
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
      await writeFile(configPath, JSON.stringify({
        mcpServers: {
          context7: { type: 'http' },
          sequential: { type: 'stdio' },
        },
      }));

      const result = await scanMcpServers(configPath, []);
      expect(result).toHaveLength(2);
      const names = result.map(r => r.name).sort();
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
      await writeFile(configPath, JSON.stringify({
        projects: {
          '/test/project-a': {
            mcpServers: { supabase: { type: 'http' } },
          },
        },
      }));

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
      await writeFile(configPath, JSON.stringify({
        projects: {
          [projPath]: {
            mcpServers: { 'shared-server': { type: 'http' } },
          },
        },
      }));
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

      await writeFile(configPath, JSON.stringify({
        mcpServers: { 'global-server': { type: 'http' } },
        projects: {
          [projPath]: {
            mcpServers: { 'proj-server': { type: 'http' } },
          },
        },
      }));
      await writeFile(
        path.join(projPath, '.mcp.json'),
        JSON.stringify({
          mcpServers: { 'mcp-json-server': { command: 'npx' } },
        }),
      );

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(3);
      const names = result.map(r => r.name).sort();
      expect(names).toEqual(['global-server', 'mcp-json-server', 'proj-server']);
    });

    it('should handle corrupt .mcp.json silently', async () => {
      const configPath = path.join(tmpDir, 'claude.json');
      await writeFile(configPath, JSON.stringify({
        mcpServers: { 'working-server': { type: 'http' } },
      }));

      const projPath = path.join(tmpDir, 'corrupt-project');
      await mkdir(projPath, { recursive: true });
      await writeFile(path.join(projPath, '.mcp.json'), 'not valid json!');

      const result = await scanMcpServers(configPath, [projPath]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('working-server');
    });
  });
}
