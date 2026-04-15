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
  type SelectGhostsOutcome,
  type SelectGhostsInput,
} from './select-ghosts.ts';
export {
  renderConfirmationScreen,
  runConfirmationPrompt,
  type ConfirmationOutcome,
  type ConfirmationInput,
} from './confirmation.ts';
