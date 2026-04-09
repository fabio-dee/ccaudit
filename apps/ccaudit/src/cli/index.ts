import { cli } from 'gunshi';
import { CCAUDIT_VERSION } from '../_version.ts';
import { ghostCommand } from './commands/ghost.ts';
import { inventoryCommand } from './commands/inventory.ts';
import { mcpCommand } from './commands/mcp.ts';
import { restoreCommand } from './commands/restore.ts';
import { trendCommand } from './commands/trend.ts';
import { installSkillCommand } from './commands/install-skill.ts';

export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  // Handle npx double-name edge case: `npx ccaudit ccaudit ghost` -> strip first `ccaudit`
  if (args[0] === 'ccaudit') args = args.slice(1);

  await cli(args, ghostCommand, {
    name: 'ccaudit',
    version: CCAUDIT_VERSION,
    description:
      'Audit Claude Code ghost inventory \u2014 agents, skills, MCP servers, and memory files',
    // Suppress gunshi's default pre-run banner ("Audit Claude Code ghost
    // inventory — ... (ccaudit v0.0.1)") so machine-readable output modes
    // (--json, --csv, --quiet, --ci) emit ONLY the payload on stdout. Without
    // this, gunshi prints the decorative header before our command's `run()`
    // executes, which corrupts JSON.parse() and CSV row parsers downstream.
    // The banner is still visible in --help output (which uses renderUsage).
    renderHeader: null,
    subCommands: {
      ghost: ghostCommand,
      inventory: inventoryCommand,
      mcp: mcpCommand,
      restore: restoreCommand, // Phase 9
      trend: trendCommand,
      'install-skill': installSkillCommand,
    },
  });
}
