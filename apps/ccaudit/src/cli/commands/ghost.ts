import { define } from 'gunshi';
import {
  discoverSessionFiles,
  parseSession,
  parseDuration,
  scanAll,
} from '@ccaudit/internal';
import type { InvocationRecord, ScanResult } from '@ccaudit/internal';

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

    for (const file of files) {
      const result = await parseSession(file, sinceMs);
      allInvocations.push(...result.invocations);
      if (result.meta.projectPath) {
        projectPaths.add(result.meta.projectPath);
      }
    }

    // Step 3: Run inventory scanner
    if (ctx.values.verbose) {
      console.log('Scanning inventory...');
    }

    const { results, byProject } = await scanAll(allInvocations, {
      projectPaths: [...projectPaths],
    });

    // Step 4: Filter to ghosts only
    const ghosts = results.filter(r => r.tier !== 'used');
    const likelyGhosts = ghosts.filter(r => r.tier === 'likely-ghost');
    const definiteGhosts = ghosts.filter(r => r.tier === 'definite-ghost');

    if (ctx.values.json) {
      console.log(JSON.stringify({
        window: sinceStr,
        files: files.length,
        projects: projectPaths.size,
        inventory: results.length,
        ghosts: {
          total: ghosts.length,
          likely: likelyGhosts.length,
          definite: definiteGhosts.length,
        },
        items: ghosts.map(r => ({
          name: r.item.name,
          category: r.item.category,
          scope: r.item.scope,
          tier: r.tier,
          lastUsed: r.lastUsed?.toISOString() ?? null,
          invocations: r.invocationCount,
          path: r.item.path,
          projectPath: r.item.projectPath,
        })),
      }, null, 2));
    } else {
      console.log(`\nccaudit ghost (window: ${sinceStr})`);
      console.log('\u2500'.repeat(50));
      console.log(`Scanned: ${files.length} files, ${projectPaths.size} projects`);
      console.log(`Inventory: ${results.length} items`);
      console.log(`Ghosts: ${ghosts.length} (${likelyGhosts.length} likely, ${definiteGhosts.length} definite)\n`);

      if (ghosts.length === 0) {
        console.log('No ghosts found. Your inventory is clean!');
        return;
      }

      // Group ghosts by category for display
      const categories = ['agent', 'skill', 'mcp-server', 'memory'] as const;
      for (const cat of categories) {
        const catGhosts = ghosts.filter(r => r.item.category === cat);
        if (catGhosts.length === 0) continue;

        console.log(`${cat.toUpperCase()}S (${catGhosts.length} ghost${catGhosts.length === 1 ? '' : 's'}):`);
        for (const r of catGhosts) {
          const lastUsedStr = r.lastUsed
            ? `last used ${Math.floor((Date.now() - r.lastUsed.getTime()) / 86_400_000)}d ago`
            : 'never used';
          const tierLabel = r.tier === 'definite-ghost' ? 'GHOST' : 'LIKELY';
          console.log(`  [${tierLabel}] ${r.item.name} \u2014 ${lastUsedStr} (${r.item.scope})`);
        }
        console.log('');
      }
    }
  },
});
