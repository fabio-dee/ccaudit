// Public surface of the framework sub-module (Phase 1).
// Named re-exports only — no wildcards — matching the existing
// packages/internal/src/{parser,scanner,token,report,remediation}/index.ts
// pattern. See .planning/phases/01-framework-module-data-model/01-CONTEXT.md §D-05.

export type {
  Framework,
  FrameworkGroup,
  FrameworkStatus,
  DetectResult,
  DetectableItem,
  GroupedInventory,
} from './types.ts';

export { frameworkSchema, registrySchema } from './types.ts';
export { detectFramework, KNOWN_ITEMS_THRESHOLD } from './detect.ts';
export { groupByFramework } from './group.ts';
export { computeFrameworkStatus } from './status.ts';
export { KNOWN_FRAMEWORKS } from './known-frameworks.ts';
export { STOP_PREFIXES, DOMAIN_STOP_FOLDERS } from './stop-lists.ts';
