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
export { anyLineSchema, assistantLineSchema } from './schemas/session-line.ts';
export type { AnyLine, AssistantLine } from './schemas/session-line.ts';
export { toolUseBlockSchema, contentBlockSchema } from './schemas/tool-use.ts';
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
  calculateWorstCaseOverhead,
  lookupMcpEstimate,
  getMcpEstimatesMap,
  estimateFromFileSize,
  formatTokenEstimate,
  formatTotalOverhead,
  formatSavingsLine,
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
  calculateUrgencyScore,
  classifyRecommendation,
  buildTrendData,
  groupGhostsByProject,
  redactPaths,
  buildRedactionMap,
} from './report/index.ts';
export type {
  HealthScore,
  HealthGrade,
  CategorySummary,
  ProjectGhostSummary,
  TrendBucket,
} from './report/index.ts';

// Remediation module (Phase 7)
export {
  buildChangePlan,
  calculateDryRunSavings,
  computeGhostHash,
  resolveCheckpointPath,
  writeCheckpoint,
  readCheckpoint,
} from './remediation/index.ts';
export type {
  ChangePlan,
  ChangePlanItem,
  ChangePlanAction,
  Checkpoint,
  ReadCheckpointResult,
} from './remediation/index.ts';

// Remediation module (Phase 8 — bust orchestrator + wiring primitives)
// Surfaced here so the CLI layer (apps/ccaudit) can import from
// `@ccaudit/internal` without reaching into subpath modules.
export {
  runBust,
  runConfirmationCeremony,
  ManifestWriter,
  resolveManifestPath,
  patchFrontmatter,
  atomicWriteJson,
  defaultProcessDeps,
} from './remediation/index.ts';
export type { BustResult, BustDeps, BustCounts, CeremonyResult } from './remediation/index.ts';

// Remediation module (Phase 9 — restore orchestrator + manifest discovery)
// Surfaced here so restore.ts CLI command can import from `@ccaudit/internal`.
export {
  executeRestore,
  findManifestForRestore,
  findManifestForName,
  extractServerName,
  discoverManifests,
  readManifest,
  removeFrontmatterKeys,
  setFrontmatterValue,
} from './remediation/index.ts';
export type {
  RestoreDeps,
  RestoreResult,
  RestoreCounts,
  RestoreMode,
  ManifestListEntry,
  ManifestEntry,
  ManifestOp,
  ArchiveOp,
  DisableOp,
  FlagOp,
  RefreshOp,
} from './remediation/index.ts';
