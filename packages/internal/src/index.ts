// Domain types (Phase 1)
export type {
  ItemScope,
  GhostTier,
  ItemCategory,
  ConfidenceTier,
  Recommendation,
  GhostItem,
  ClaudePaths,
} from './types.ts';

// Parser module (Phase 2)
export {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  parseMcpName,
  extractInvocations,
} from './parser/index.ts';
export type {
  DiscoverOptions,
  InvocationKind,
  InvocationRecord,
  SessionMeta,
  ParsedSessionResult,
} from './parser/index.ts';

// Schemas (Phase 2)
export {
  anyLineSchema,
  assistantLineSchema,
} from './schemas/session-line.ts';
export type { AnyLine, AssistantLine } from './schemas/session-line.ts';
export {
  toolUseBlockSchema,
  contentBlockSchema,
} from './schemas/tool-use.ts';
export type { ToolUseBlock, ContentBlock } from './schemas/tool-use.ts';

// Scanner module (Phase 3)
export {
  scanAll,
  scanAgents,
  scanSkills,
  scanMcpServers,
  scanMemoryFiles,
  classifyGhost,
  buildInvocationMaps,
  readClaudeConfig,
  resolveSkillName,
  matchInventory,
  groupByProject,
  LIKELY_GHOST_MS,
  DEFINITE_GHOST_MS,
} from './scanner/index.ts';
export type {
  InventoryItem,
  ScanResult,
  ScannerOptions,
  InvocationSummary,
} from './scanner/index.ts';
export type { ClaudeConfig } from './scanner/index.ts';

// Token module (Phase 4)
export {
  enrichScanResults,
  calculateTotalOverhead,
  lookupMcpEstimate,
  getMcpEstimatesMap,
  estimateFromFileSize,
  formatTokenEstimate,
  formatTotalOverhead,
  listMcpTools,
  measureMcpTokens,
  BYTES_PER_TOKEN,
  CONTEXT_WINDOW_SIZE,
} from './token/index.ts';
export type {
  TokenEstimate,
  TokenCostResult,
  McpTokenEntry,
  McpServerConfig,
  McpToolDefinition,
} from './token/index.ts';

// Report module (Phase 5)
export {
  calculateHealthScore,
  classifyRecommendation,
  buildTrendData,
} from './report/index.ts';
export type {
  HealthScore,
  HealthGrade,
  CategorySummary,
  TrendBucket,
} from './report/index.ts';
