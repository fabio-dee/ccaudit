import { cli } from 'gunshi';
import { ghostCommand } from './commands/ghost.ts';
import { mcpCommand } from './commands/mcp.ts';

export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  // Handle npx double-name edge case: `npx ccaudit ccaudit ghost` -> strip first `ccaudit`
  if (args[0] === 'ccaudit') args = args.slice(1);

  await cli(args, ghostCommand, {
    name: 'ccaudit',
    version: '0.0.1',
    description: 'Audit Claude Code ghost inventory — agents, skills, MCP servers, and memory files',
    subCommands: {
      ghost: ghostCommand,
      mcp: mcpCommand,
      // Future: inventory, trend, restore, contribute
    },
  });
}
