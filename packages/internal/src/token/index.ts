// Token types
export type { TokenEstimate, TokenCostResult, McpTokenEntry } from './types.ts';

// MCP token estimates data (bundled JSON + valibot-validated lookup)
export {
  lookupMcpEstimate,
  getMcpEstimatesMap,
  CONTEXT_WINDOW_SIZE,
  DEFAULT_UNKNOWN_MCP_TOKENS,
} from './mcp-estimates-data.ts';

// File-size-based token estimation
export { estimateFromFileSize, BYTES_PER_TOKEN } from './file-size-estimator.ts';

// Token display formatting
export { formatTokenEstimate, formatTotalOverhead, formatSavingsLine } from './format.ts';

// Enrichment pipeline
export {
  enrichScanResults,
  calculateTotalOverhead,
  calculateGhostTotalOverhead,
  sumHookTokens,
  calculateWorstCaseOverhead,
} from './estimate.ts';

// MCP live client
export { listMcpTools, measureMcpTokens } from './mcp-live-client.ts';
export type { McpServerConfig, McpToolDefinition } from './mcp-live-client.ts';

// Frontmatter parser (zero-dep, custom YAML subset)
export { parseFrontmatter } from './frontmatter.ts';
export type { ParsedFrontmatter } from './frontmatter.ts';

// Per-category token estimators
export { estimateSkillTokens } from './skill-estimator.ts';
export type { SkillEstimateResult } from './skill-estimator.ts';
export { estimateAgentTokens } from './agent-estimator.ts';
export type { AgentEstimateResult } from './agent-estimator.ts';
export { estimateMemoryTokens } from './memory-estimator.ts';
export type { MemoryEstimateResult } from './memory-estimator.ts';
export { estimateCommandTokens } from './command-estimator.ts';
export type { CommandEstimateResult } from './command-estimator.ts';

// Phase 4: hook token estimator
export { estimateHookTokens } from './hook-estimator.ts';

// MCP regime detection + deferred-tools math (Phase 2)
export type { McpRegime } from './mcp-regime.ts';
export {
  detectClaudeCodeVersion,
  resolveMcpRegime,
  perToolTokens,
  regimeFlatOverhead,
} from './mcp-regime.ts';

// Enrichment pipeline constant for unknown MCP tool count
export { DEFAULT_UNKNOWN_MCP_TOOL_COUNT } from './estimate.ts';
