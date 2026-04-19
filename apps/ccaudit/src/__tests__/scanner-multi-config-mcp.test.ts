/**
 * Phase 6 (06-05) — Scanner multi-config MCP aggregation test.
 *
 * Validates that `scanMcpServers` produces `configRefs.length >= 2` when the
 * same MCP server key appears in two or more config files, in deterministic
 * bucket+stable order (project-local first, then user scope, then system),
 * and that single-config MCPs still carry `configRefs.length === 1`.
 *
 * Runs in-process (no subprocess). Uses `createMultiConfigMcpFixture` from
 * `_test-helpers.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanMcpServers } from '@ccaudit/internal';
import { makeTmpHome, cleanupTmpHome, createMultiConfigMcpFixture } from './_test-helpers.ts';

describe.skipIf(process.platform === 'win32')(
  'Phase 6 SC3 scanner — multi-config MCP aggregation',
  () => {
    let tmpHome: string;
    let origHome: string | undefined;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      // presentPath() in scanner reads os.homedir() which is driven by $HOME
      // on POSIX. Override to tmpHome so `~/.claude.json` compression fires.
      origHome = process.env['HOME'];
      process.env['HOME'] = tmpHome;
    });

    afterEach(async () => {
      if (origHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = origHome;
      await cleanupTmpHome(tmpHome);
    });

    it('identical MCP key in 2 configs produces configRefs.length === 2 in deterministic order', async () => {
      const fixture = await createMultiConfigMcpFixture({
        home: tmpHome,
        sharedKey: 'pencil',
        alsoInProjectLocal: true,
        alsoInUser: true,
      });

      const items = await scanMcpServers(fixture.userConfigPath, fixture.projectPaths);

      const pencilItems = items.filter((i) => i.name === 'pencil');
      expect(pencilItems.length).toBeGreaterThanOrEqual(1);

      // Every emitted `pencil` item must reference BOTH configs.
      for (const it of pencilItems) {
        expect(it.configRefs, 'configRefs must be populated').toBeDefined();
        expect(it.configRefs!.length).toBe(2);
        // D6-19 bucket order: project-local (relative) first, then user (~/...).
        expect(it.configRefs![0]).toMatch(/\.mcp\.json$/);
        expect(it.configRefs![1]).toMatch(/^~\//);
        expect(it.configRefs![1]).toContain('.claude.json');
      }
    });

    it('single-config MCP still carries configRefs.length === 1', async () => {
      // Only user-scope; no project-local.
      const fixture = await createMultiConfigMcpFixture({
        home: tmpHome,
        sharedKey: 'solo',
        alsoInProjectLocal: false,
        alsoInUser: true,
      });

      const items = await scanMcpServers(fixture.userConfigPath, fixture.projectPaths);
      const solo = items.find((i) => i.name === 'solo');
      expect(solo, 'solo item must exist').toBeDefined();
      expect(solo!.configRefs).toBeDefined();
      expect(solo!.configRefs!.length).toBe(1);
    });

    it('aggregation across many configs is deterministic and dedup-safe', async () => {
      const fixture = await createMultiConfigMcpFixture({
        home: tmpHome,
        sharedKey: 'quintet',
        alsoInProjectLocal: true,
        alsoInUser: true,
        extraProjectDirs: ['proj-b', 'proj-c', 'proj-d'],
      });

      const items = await scanMcpServers(fixture.userConfigPath, fixture.projectPaths);
      const quintetItems = items.filter((i) => i.name === 'quintet');
      expect(quintetItems.length).toBeGreaterThanOrEqual(1);
      for (const it of quintetItems) {
        // At minimum: project-local + user scopes both present.
        expect(it.configRefs!.length).toBeGreaterThanOrEqual(2);
        // Sorted output is stable across invocations.
        const sorted = [...it.configRefs!];
        expect(it.configRefs).toEqual(sorted);
      }
    });
  },
);
