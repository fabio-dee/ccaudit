// @ccaudit/terminal -- CLI table rendering layer
export {
  renderHeader,
  renderDivider,
  humanizeSinceWindow,
  renderHealthScore,
  letterForGrade,
  renderGhostSummary,
  renderTopGhosts,
  renderGhostFooter,
  renderGlobalBaseline,
  renderProjectsTable,
  renderProjectsVerbose,
  renderInventoryTable,
  renderMcpTable,
  renderTrendTable,
  renderChangePlan,
  renderChangePlanVerbose,
  renderProgressBar,
  renderShareableBlock,
  renderBoxed,
  renderGhostOutputBox,
  renderFrameworksSection,
} from './tables/index.ts';
export type { ShareableBlockParams } from './tables/index.ts';
export type { ChangePlanRenderOptions, ProtectedItem } from './tables/index.ts';

export { initColor, isColorEnabled, getTableStyle, colorize } from './color.ts';
export { csvEscape, csvRow, csvTable } from './csv.ts';
export { tsvRow } from './quiet.ts';
