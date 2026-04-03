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
