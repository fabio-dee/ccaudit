import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
} from '@ccaudit/internal';
import type { InvocationRecord } from '@ccaudit/internal';

export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d, 2w)',
      default: '7d',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'Output as JSON',
      default: false,
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      description: 'Show scan details',
      default: false,
    },
  },
  async run(ctx) {
    const sinceStr = ctx.values.since ?? '7d';
    let sinceMs: number;
    try {
      sinceMs = parseDuration(sinceStr);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    if (ctx.values.verbose) {
      console.log(`Scanning sessions (window: ${sinceStr})...`);
    }

    // Step 1: Discover session files
    const files = await discoverSessionFiles({ sinceMs });

    if (ctx.values.verbose) {
      console.log(`Found ${files.length} session file(s)`);
    }

    // Step 2: Parse all session files
    const allInvocations: InvocationRecord[] = [];
    const projectPaths = new Set<string>();
    let parsedCount = 0;

    for (const file of files) {
      const result = await parseSession(file, sinceMs);
      allInvocations.push(...result.invocations);
      if (result.meta.projectPath) {
        projectPaths.add(result.meta.projectPath);
      }
      parsedCount++;
    }

    // Step 3: Summarize by kind
    const agents = allInvocations.filter(r => r.kind === 'agent');
    const skills = allInvocations.filter(r => r.kind === 'skill');
    const mcps = allInvocations.filter(r => r.kind === 'mcp');

    if (ctx.values.json) {
      console.log(JSON.stringify({
        window: sinceStr,
        files: files.length,
        projects: projectPaths.size,
        invocations: {
          total: allInvocations.length,
          agents: agents.length,
          skills: skills.length,
          mcp: mcps.length,
        },
      }, null, 2));
    } else {
      console.log(`\nccaudit ghost (window: ${sinceStr})`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`Files scanned: ${files.length}`);
      console.log(`Projects: ${projectPaths.size}`);
      console.log(`\nInvocations found:`);
      console.log(`  Agents: ${agents.length}`);
      console.log(`  Skills: ${skills.length}`);
      console.log(`  MCP:    ${mcps.length}`);
      console.log(`  Total:  ${allInvocations.length}`);
      console.log(`\n(Ghost detection requires inventory scan -- Phase 3)`);
    }
  },
});
