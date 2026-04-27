/**
 * Phase 10 Plan 01 (SC1) — regime-detection golden test.
 *
 * Pins MCP regime resolution against two layouts of the Claude Code config
 * tree: pre-2.1.116 (mcpServers in `~/.claude.json` only) and post-2.1.117
 * (mcpServers also written into `~/.claude/settings.json` per the cc
 * 2.1.116/117 mcpServers + hooks loading refactor). Both fixtures encode
 * the same semantic inventory (12 stdio servers); the resolver must produce
 * a byte-identical regime + reason at fixed inputs (cc 2.1.117, 200K context,
 * no override).
 *
 * If the two snapshots ever diverge, that's drift introduced by a future
 * scanner refactor — investigate before re-locking the snapshots.
 *
 * Self-contained: no real HOME mutation. Uses `makeTmpHome` to copy each
 * fixture tree into a fresh tmpdir before invoking `scanMcpServers`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMcpServers, resolveMcpRegime, perToolTokens } from '@ccaudit/internal';
import { makeTmpHome, cleanupTmpHome } from './_test-helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '__fixtures__');

interface RegimeOutcome {
  regime: 'eager' | 'deferred' | 'unknown';
  reason: string;
  serverCount: number;
  totalMcpToolTokens: number;
}

async function computeRegimeForFixture(
  fixtureDir: string,
  tmpHome: string,
): Promise<RegimeOutcome> {
  // Copy the fixture tree into the tmpHome so scanMcpServers reads from
  // an isolated filesystem under our control. The fixture is the SOURCE;
  // tmpHome is the SANDBOX.
  await cp(fixtureDir, tmpHome, { recursive: true });

  const claudeConfigPath = path.join(tmpHome, '.claude.json');
  const items = await scanMcpServers(claudeConfigPath, []);
  const serverCount = items.length;

  // Scanner does not introspect tool schemas. Each emitted server is
  // billed at the eager per-tool rate to feed the resolver. This mirrors
  // how the live token pipeline computes totalMcpToolTokens before the
  // resolver decides eager vs deferred.
  const totalMcpToolTokens = serverCount * perToolTokens('eager');

  const { regime, reason } = resolveMcpRegime({
    totalMcpToolTokens,
    contextWindow: 200_000,
    ccVersion: '2.1.117',
    override: null,
  });

  return { regime, reason, serverCount, totalMcpToolTokens };
}

describe.skipIf(process.platform === 'win32')(
  'Phase 10 SC1 regime detection — cc 2.1.116/117 mcpServers + hooks loading refactor compat',
  () => {
    let tmpHome: string;
    let origHome: string | undefined;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      origHome = process.env['HOME'];
      process.env['HOME'] = tmpHome;
    });

    afterEach(async () => {
      if (origHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = origHome;
      await cleanupTmpHome(tmpHome);
    });

    it('pre-2.1.116 layout resolves to the locked snapshot', async () => {
      const result = await computeRegimeForFixture(
        path.join(FIXTURES, 'regime-pre-2-1-116'),
        tmpHome,
      );
      expect(result).toMatchInlineSnapshot(`
        {
          "reason": "cc >=2.1.7 but MCP <=10% ctx — ToolSearch not triggered",
          "regime": "eager",
          "serverCount": 12,
          "totalMcpToolTokens": 6000,
        }
      `);
    });

    it('post-2.1.117 layout resolves to the SAME snapshot (byte-identical regime + reason)', async () => {
      const result = await computeRegimeForFixture(
        path.join(FIXTURES, 'regime-post-2-1-117'),
        tmpHome,
      );
      expect(result).toMatchInlineSnapshot(`
        {
          "reason": "cc >=2.1.7 but MCP <=10% ctx — ToolSearch not triggered",
          "regime": "eager",
          "serverCount": 12,
          "totalMcpToolTokens": 6000,
        }
      `);
    });
  },
);
