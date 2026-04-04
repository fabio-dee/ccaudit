/**
 * Minimal MCP JSON-RPC 2.0 client for --live measurement.
 *
 * Spawns MCP servers via stdio, performs the initialize + tools/list
 * handshake, and returns tool definitions for token counting.
 *
 * Only stdio transport is supported. HTTP/SSE servers return a clear error.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Configuration for connecting to an MCP server.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Transport type: only 'stdio' is supported for live measurement */
  type?: string;
}

/**
 * A single tool definition returned by MCP tools/list.
 */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Spawn an MCP server, perform JSON-RPC initialize + tools/list handshake,
 * and return the raw tool definitions.
 *
 * @param config - Server spawn configuration
 * @param timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns Array of tool definitions from the server
 * @throws If server times out, command not found, or non-stdio transport
 */
export async function listMcpTools(
  _config: McpServerConfig,
  _timeoutMs?: number,
): Promise<McpToolDefinition[]> {
  // TODO: implement
  throw new Error('Not implemented');
}

/**
 * Measure token cost of an MCP server's tool definitions.
 *
 * Spawns the server, retrieves tool definitions via tools/list,
 * and estimates tokens using chars/4 heuristic.
 *
 * @param config - Server spawn configuration
 * @param timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns Token measurement with confidence 'measured'
 */
export async function measureMcpTokens(
  _config: McpServerConfig,
  _timeoutMs?: number,
): Promise<{
  tokens: number;
  confidence: 'measured';
  source: string;
  toolCount: number;
}> {
  // TODO: implement
  throw new Error('Not implemented');
}

// Suppress unused import warnings for RED phase
void spawn;
void createInterface;

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Mock MCP server script that responds to initialize + tools/list
  const mockMcpServer = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-server', version: '0.0.1' },
          },
        }) + '\\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              { name: 'tool_alpha', description: 'First test tool', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
              { name: 'tool_beta', description: 'Second test tool', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
            ],
          },
        }) + '\\n');
      }
    });
  `;

  // Script that never responds (for timeout testing)
  const hangingServer = `setTimeout(() => {}, 60000);`;

  describe('listMcpTools', () => {
    it('should return parsed tool definitions from a mock MCP server', async () => {
      const tools = await listMcpTools(
        { command: 'node', args: ['-e', mockMcpServer] },
        10_000,
      );
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('tool_alpha');
      expect(tools[0].description).toBe('First test tool');
      expect(tools[1].name).toBe('tool_beta');
      expect(tools[1].inputSchema).toBeDefined();
    });

    it('should reject with timeout error when server does not respond', async () => {
      await expect(
        listMcpTools({ command: 'node', args: ['-e', hangingServer] }, 500),
      ).rejects.toThrow(/timeout/i);
    });

    it('should reject for non-stdio transport with clear message', async () => {
      await expect(
        listMcpTools({ command: 'node', type: 'http' }),
      ).rejects.toThrow(/http.*transport/i);
    });

    it('should reject when command is not found', async () => {
      await expect(
        listMcpTools({ command: 'nonexistent-binary-xyz-999' }, 5_000),
      ).rejects.toThrow();
    });
  });

  describe('measureMcpTokens', () => {
    it('should return token count with confidence measured', async () => {
      const result = await measureMcpTokens(
        { command: 'node', args: ['-e', mockMcpServer] },
        10_000,
      );
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.confidence).toBe('measured');
      expect(result.source).toContain('live measurement');
      expect(result.toolCount).toBe(2);
    });
  });

  describe('McpServerConfig', () => {
    it('should accept command + args + optional env', () => {
      const config: McpServerConfig = {
        command: 'node',
        args: ['--version'],
        env: { FOO: 'bar' },
      };
      expect(config.command).toBe('node');
      expect(config.args).toEqual(['--version']);
      expect(config.env).toEqual({ FOO: 'bar' });
    });

    it('should accept minimal config with only command', () => {
      const config: McpServerConfig = { command: 'echo' };
      expect(config.command).toBe('echo');
      expect(config.args).toBeUndefined();
      expect(config.env).toBeUndefined();
    });
  });
}
