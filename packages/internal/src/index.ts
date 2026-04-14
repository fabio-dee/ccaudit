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

// Framework module (v1.3.0 — framework-aware ghost grouping, Phase 1 data model + Phase 2 type narrowing)
export type {
  Framework,
  FrameworkGroup,
  FrameworkStatus,
  DetectResult,
  DetectableItem,
  GroupedInventory,
} from './framework/index.ts';
export {
  detectFramework,
  groupByFramework,
  computeFrameworkStatus,
  KNOWN_FRAMEWORKS,
  KNOWN_ITEMS_THRESHOLD,
  STOP_PREFIXES,
  DOMAIN_STOP_FOLDERS,
  frameworkSchema,
  registrySchema,
} from './framework/index.ts';

// Parser module (Phase 2)
export {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  parseMcpName,
  extractInvocations,
  extractCommandInvocations,
  extractHookInvocations,
} from './parser/index.ts';
export type {
  DiscoverOptions,
  InvocationKind,
  InvocationRecord,
  SessionMeta,
  ParsedSessionResult,
} from './parser/index.ts';

// Schemas (Phase 2 + Phase 3)
export { anyLineSchema, assistantLineSchema, userLineSchema } from './schemas/session-line.ts';
export type { AnyLine, AssistantLine, UserLine } from './schemas/session-line.ts';
export { toolUseBlockSchema, contentBlockSchema } from './schemas/tool-use.ts';
export type { ToolUseBlock, ContentBlock } from './schemas/tool-use.ts';

// Scanner module (Phase 3 + Phase 2 v1.3.0 framework annotation; Phase 4 hooks)
export {
  scanAll,
  scanAgents,
  scanSkills,
  scanMcpServers,
  scanMemoryFiles,
  scanCommands,
  resolveCommandName,
  scanHooks,
  classifyGhost,
  buildInvocationMaps,
  readClaudeConfig,
  resolveSkillName,
  matchInventory,
  groupByProject,
  annotateFrameworks,
  toGhostItems,
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
  calculateGhostTotalOverhead,
  sumHookTokens,
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
  DEFAULT_UNKNOWN_MCP_TOKENS,
  // Phase 2: MCP regime detection + deferred-tools math
  detectClaudeCodeVersion,
  resolveMcpRegime,
  perToolTokens,
  regimeFlatOverhead,
  DEFAULT_UNKNOWN_MCP_TOOL_COUNT,
  // Phase 3: command estimator
  estimateCommandTokens,
  // Phase 4: hook estimator
  estimateHookTokens,
} from './token/index.ts';
export type {
  TokenEstimate,
  TokenCostResult,
  McpTokenEntry,
  McpServerConfig,
  McpToolDefinition,
  // Phase 2
  McpRegime,
  // Phase 3
  CommandEstimateResult,
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

// Remediation module (v1.3.0 Phase 4 — framework-as-unit bust protection)
// Surfaced here so the CLI layer (apps/ccaudit/src/cli/commands/ghost.ts)
// can import alongside runBust without reaching into subpath modules.
export { applyFrameworkProtection } from './remediation/index.ts';
export type {
  FrameworkBustOptions,
  FrameworkBustResult,
  ProtectedFrameworkWarning,
} from './remediation/index.ts';

// Remediation module (Phase 9 — restore orchestrator + manifest discovery)
// Surfaced here so restore.ts CLI command can import from `@ccaudit/internal`.
export {
  executeRestore,
  findManifestsForRestore,
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

// Phase 4: orphan reclaim command
export { reclaim } from './remediation/index.ts';
export type {
  ReclaimOptions,
  ReclaimResult,
  ReclaimDeps,
  DirEntry,
  OrphanEntry,
} from './remediation/index.ts';

// Phase 6: append-only history log
export { HistoryWriter, recordHistory } from './history/index.ts';
export type {
  HistoryHeader,
  HistoryEntry,
  HistoryRecord,
  CommandResult,
  GhostResult,
  DryRunResult,
  HistoryBustResult,
  HistoryRestoreResult,
  HistoryReclaimResult,
  GenericResult,
  RecordHistoryOpts,
} from './history/index.ts';
