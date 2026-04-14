// Scanner types
export type { InventoryItem, ScanResult, ScannerOptions, InvocationSummary } from './types.ts';

// Classification
export { classifyGhost, LIKELY_GHOST_MS, DEFINITE_GHOST_MS } from './classify.ts';

// Invocation lookup
export { buildInvocationMaps } from './invocation-map.ts';

// Individual scanners
export { scanAgents } from './scan-agents.ts';
export { scanSkills, resolveSkillName } from './scan-skills.ts';
export { scanMcpServers, readClaudeConfig } from './scan-mcp.ts';
export type { ClaudeConfig } from './scan-mcp.ts';
export { scanMemoryFiles } from './scan-memory.ts';
export { scanCommands, resolveCommandName } from './scan-commands.ts';
export { scanHooks } from './scan-hooks.ts';

// Coordinator
export { scanAll, matchInventory, groupByProject } from './scan-all.ts';

// Annotation layer (Phase 2 — framework field decoration + GhostItem materializer)
export { annotateFrameworks, toGhostItems } from './annotate.ts';

// Phase 5: shared @-import resolver (used by scan-memory.ts + memory-estimator.ts)
export { resolveMarkdownImports } from './resolve-imports.ts';
export type { ResolvedImport } from './resolve-imports.ts';
