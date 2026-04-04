import * as v from 'valibot';
import rawEstimates from '../data/mcp-token-estimates.json' with { type: 'json' };
import type { McpTokenEntry } from './types.ts';

/**
 * Valibot schema for a single MCP token estimate entry.
 */
const McpEstimateSchema = v.object({
  name: v.string(),
  toolCount: v.number(),
  estimatedTokens: v.number(),
  confidence: v.picklist(['estimated', 'measured', 'community-reported']),
  lastUpdated: v.optional(v.string()),
  notes: v.optional(v.string()),
});

/**
 * Valibot schema for the top-level mcp-token-estimates.json file.
 */
const EstimatesFileSchema = v.object({
  version: v.number(),
  generatedAt: v.string(),
  contextWindowSize: v.number(),
  methodology: v.string(),
  entries: v.array(McpEstimateSchema),
});

// Validate at module load -- fail fast if data is malformed
const parsed = v.safeParse(EstimatesFileSchema, rawEstimates);
if (!parsed.success) {
  throw new Error(
    `Invalid mcp-token-estimates.json: ${parsed.issues.map((i) => i.message).join(', ')}`,
  );
}

const validatedData = parsed.output;

/** Claude context window size from bundled data (200,000 tokens). */
export const CONTEXT_WINDOW_SIZE: number = validatedData.contextWindowSize;

// Build lookup map from validated entries
const estimatesMap = new Map<string, McpTokenEntry>();
for (const entry of validatedData.entries) {
  estimatesMap.set(entry.name, entry as McpTokenEntry);
}

/**
 * Look up token estimate for a known MCP server by name.
 * Returns the entry if found, null for unknown servers.
 */
export function lookupMcpEstimate(serverName: string): McpTokenEntry | null {
  return estimatesMap.get(serverName) ?? null;
}

/**
 * Get the full map of MCP token estimates.
 * Returns a read-only view of the validated data.
 */
export function getMcpEstimatesMap(): ReadonlyMap<string, McpTokenEntry> {
  return estimatesMap;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('lookupMcpEstimate', () => {
    it('should return entry for context7 with correct values', () => {
      const entry = lookupMcpEstimate('context7');
      expect(entry).not.toBeNull();
      expect(entry!.estimatedTokens).toBe(1500);
      expect(entry!.confidence).toBe('estimated');
      expect(entry!.toolCount).toBe(2);
      expect(entry!.name).toBe('context7');
    });

    it('should return null for nonexistent server', () => {
      const entry = lookupMcpEstimate('nonexistent-server');
      expect(entry).toBeNull();
    });

    it('should return entry for playwright with community-reported confidence', () => {
      const entry = lookupMcpEstimate('playwright');
      expect(entry).not.toBeNull();
      expect(entry!.estimatedTokens).toBe(14000);
      expect(entry!.confidence).toBe('community-reported');
    });
  });

  describe('getMcpEstimatesMap', () => {
    it('should return a map with at least 5 entries', () => {
      const map = getMcpEstimatesMap();
      expect(map.size).toBeGreaterThanOrEqual(5);
    });

    it('should contain all 10 expected entries', () => {
      const map = getMcpEstimatesMap();
      expect(map.size).toBe(10);
      expect(map.has('context7')).toBe(true);
      expect(map.has('sequential-thinking')).toBe(true);
      expect(map.has('playwright')).toBe(true);
      expect(map.has('filesystem')).toBe(true);
      expect(map.has('github')).toBe(true);
      expect(map.has('fetch')).toBe(true);
      expect(map.has('memory')).toBe(true);
      expect(map.has('brave-search')).toBe(true);
      expect(map.has('puppeteer')).toBe(true);
      expect(map.has('slack')).toBe(true);
    });
  });

  describe('CONTEXT_WINDOW_SIZE', () => {
    it('should equal 200000', () => {
      expect(CONTEXT_WINDOW_SIZE).toBe(200000);
    });
  });
}
