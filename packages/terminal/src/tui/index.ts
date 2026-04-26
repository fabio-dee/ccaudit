/**
 * TUI primitives barrel — re-exports all public symbols from the tui/ subdir.
 *
 * Consumers (apps/ccaudit/src/cli/commands/ghost.ts) import from '@ccaudit/terminal'
 * which re-exports everything from this barrel via packages/terminal/src/index.ts.
 */
export { shouldUseAscii } from './_glyph-capability.ts';
export {
  isTuiAvailable,
  checkTuiGuards,
  type TuiGuardMode,
  type GuardInputs,
} from './_tui-mode.ts';
export {
  selectGhosts,
  formatRowLabel,
  CATEGORY_ORDER,
  CATEGORY_LABEL,
  type SelectGhostsOutcome,
  type SelectGhostsInput,
  type PickerDep,
} from './select-ghosts.ts';
export {
  openTabbedPicker,
  type TabbedPickerInput,
  type TabbedPickerOutcome,
} from './tabbed-picker.ts';
export {
  renderConfirmationScreen,
  runConfirmationPrompt,
  type ConfirmationOutcome,
  type ConfirmationInput,
} from './confirmation.ts';
export {
  openRestorePicker,
  RESTORE_FOOTER_TEMPLATE,
  type SelectRestoreOutcome,
  type RestoreItem,
  type RestoreItemCategory,
  type RestorePickerDep,
} from './select-restore.ts';
export { promptAutoOpen, type AutoOpenOutcome } from './auto-open-prompt.ts';
export {
  renderRunningProcessMessage,
  runPreflightRetryLoop,
  type RunningProcessInput,
  type PreflightRetryOutcome,
  type PreflightPhase,
} from './_preflight-copy.ts';
