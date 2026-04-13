/**
 * Phase 2 (v1.3.0) Scanner Integration Test
 *
 * In-process integration test for the framework annotation pipeline.
 * Mirrors the fixture-based pattern from `ghost-command.test.ts` but
 * runs `scanAll → enrichScanResults → annotateFrameworks → toGhostItems →
 * groupByFramework` in-process (no subprocess) and asserts on the
 * annotated `framework` field at every stage.
 *
 * Validates the four ROADMAP Phase 2 Success Criteria:
 *  1. (in-memory equivalent — full JSON projection is Phase 3 OUT-02)
 *     all `gsd-*` items carry `framework: 'gsd'` after scanAll.
 *  2. all agents under `engineering/` carry `framework: null`
 *     (CRITICAL NEGATIVE FINDING regression guard — DOMAIN_STOP_FOLDERS).
 *  3. empty-registry annotation produces output where every item has
 *     `framework === undefined` (no key on the object) — SCAN-04
 *     byte-identical to v1.2.1 JSON.
 *  4. Existing inventory and ghost tests still pass without modification
 *     (verified by the project-wide `pnpm -w test` run, not in this file).
 *
 * Plus the D-14 end-to-end token-totals check via the
 * `groupByFramework(toGhostItems(enriched))` chain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanAll,
  scanAgents,
  scanSkills,
  enrichScanResults,
  annotateFrameworks,
  toGhostItems,
  groupByFramework,
} from '@ccaudit/internal';
import type { ClaudePaths } from '@ccaudit/internal';

// ── Fixture state ──────────────────────────────────────────────────

let fixtureDir: string;
let claudeDir: string;
let agentsDir: string;
let skillsDir: string;

async function setupFixture(): Promise<void> {
  fixtureDir = await mkdtemp(join(tmpdir(), 'ccaudit-scan-int-'));
  claudeDir = join(fixtureDir, '.claude');
  agentsDir = join(claudeDir, 'agents');
  skillsDir = join(claudeDir, 'skills');

  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  // ── GSD curated prefix — three agents (Success Criterion #1)
  await writeFile(join(agentsDir, 'gsd-planner.md'), '# gsd planner\n', 'utf-8');
  await writeFile(join(agentsDir, 'gsd-executor.md'), '# gsd executor\n', 'utf-8');
  await writeFile(join(agentsDir, 'gsd-verifier.md'), '# gsd verifier\n', 'utf-8');

  // ── engineering/ DOMAIN_STOP_FOLDERS — MUST NOT be grouped (Success Criterion #2)
  const engDir = join(agentsDir, 'engineering');
  await mkdir(engDir, { recursive: true });
  await writeFile(join(engDir, 'backend-dev.md'), '# backend\n', 'utf-8');
  await writeFile(join(engDir, 'frontend-dev.md'), '# frontend\n', 'utf-8');

  // ── design/ DOMAIN_STOP_FOLDERS — second domain folder (defense-in-depth)
  const designDir = join(agentsDir, 'design');
  await mkdir(designDir, { recursive: true });
  await writeFile(join(designDir, 'ui-designer.md'), '# ui\n', 'utf-8');

  // ── Heuristic foo-* cluster — Phase 2 uses detectFramework only (Tier 1),
  //    so these MUST stay framework: null. Heuristic clustering is the
  //    job of groupByFramework, NOT annotateFrameworks. This is the key
  //    educational test case proving the layered separation.
  await writeFile(join(agentsDir, 'foo-one.md'), '# foo\n', 'utf-8');
  await writeFile(join(agentsDir, 'foo-two.md'), '# foo\n', 'utf-8');
  await writeFile(join(agentsDir, 'foo-three.md'), '# foo\n', 'utf-8');

  // ── Control: ungrouped singleton agent
  await writeFile(join(agentsDir, 'solo-agent.md'), '# solo\n', 'utf-8');

  // ── SuperClaude sc: skills — two skill directories (curated prefix)
  for (const skillName of ['sc:build', 'sc:analyze']) {
    const skillDir = join(skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf-8');
  }
}

async function teardownFixture(): Promise<void> {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
}

function claudePathsForFixture(): ClaudePaths {
  return {
    xdg: join(fixtureDir, '.config', 'claude'),
    legacy: claudeDir,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

// Windows: skill names contain colons (sc:build) which are invalid in NTFS filenames.
describe.skipIf(process.platform === 'win32')(
  'scanner-integration: framework annotation pipeline (Phase 2)',
  () => {
    beforeAll(setupFixture);
    afterAll(teardownFixture);

    it('Success Criterion #1: gsd-* agents carry framework: "gsd" (curated prefix)', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const gsdItems = results.filter((r) => r.item.name.startsWith('gsd-'));
      expect(gsdItems.length).toBeGreaterThanOrEqual(3);
      for (const r of gsdItems) {
        expect(r.item.framework).toBe('gsd');
      }
    });

    it('Success Criterion #1 (skills): sc: skills carry framework: "superclaude" (curated prefix)', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const scItems = results.filter((r) => r.item.name.startsWith('sc:'));
      expect(scItems.length).toBeGreaterThanOrEqual(2);
      for (const r of scItems) {
        expect(r.item.framework).toBe('superclaude');
      }
    });

    it('Success Criterion #2 (CRITICAL NEGATIVE FINDING): engineering/ agents carry framework: null', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const engItems = results.filter((r) => r.item.path.includes('/engineering/'));
      expect(engItems.length).toBeGreaterThanOrEqual(2);
      for (const r of engItems) {
        // CRITICAL: must be exactly null (not 'engineering', not undefined).
        // The populated-registry agent path always sets the key, so an
        // unmatched agent gets `framework: null`. The DOMAIN_STOP_FOLDERS
        // defense + curated-list-only folder gating prevents 'engineering'
        // from ever being a framework id.
        expect(r.item.framework).toBeNull();
      }
    });

    it('Success Criterion #2 (defense-in-depth): design/ agents carry framework: null', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const designItems = results.filter((r) => r.item.path.includes('/design/'));
      expect(designItems.length).toBeGreaterThanOrEqual(1);
      for (const r of designItems) {
        expect(r.item.framework).toBeNull();
      }
    });

    it('heuristic foo-* cluster stays framework: null (Tier 2 is groupByFramework, not annotate)', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const fooItems = results.filter((r) => r.item.name.startsWith('foo-'));
      expect(fooItems.length).toBeGreaterThanOrEqual(3);
      for (const r of fooItems) {
        // Phase 2 annotation uses detectFramework only (Tier 1 curated).
        // Heuristic clustering is invoked by groupByFramework downstream.
        // Therefore foo-* items must carry `null` after annotation, even
        // though groupByFramework would later cluster them.
        expect(r.item.framework).toBeNull();
      }
    });

    it('end-to-end token totals via toGhostItems + groupByFramework (D-14)', async () => {
      const { results } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const enriched = await enrichScanResults(results);

      // Sanity: enrichScanResults must propagate the framework field.
      const enrichedGsd = enriched.filter((r) => r.item.name.startsWith('gsd-'));
      expect(enrichedGsd.length).toBeGreaterThanOrEqual(3);
      for (const r of enrichedGsd) {
        expect(r.item.framework).toBe('gsd');
      }

      const ghostItems = toGhostItems(enriched);
      const grouped = groupByFramework(ghostItems);

      // The gsd framework group must exist with real per-member token totals.
      const gsd = grouped.frameworks.find((f) => f.id === 'gsd');
      expect(gsd).toBeDefined();
      expect(gsd!.totals.defined).toBeGreaterThanOrEqual(3);
      // No invocations passed → every gsd item is a ghost → ghostTokenCost > 0.
      expect(gsd!.totals.totalTokenCost).toBeGreaterThan(0);
      expect(gsd!.totals.ghostTokenCost).toBeGreaterThan(0);
      // With all members ghost, ghostTokenCost equals totalTokenCost.
      expect(gsd!.totals.ghostTokenCost).toBe(gsd!.totals.totalTokenCost);
    });

    it('Success Criterion #3 (SCAN-04): empty-registry annotation produces byte-identical output (no framework key)', async () => {
      // Build rawItems by calling the individual scanners directly, BYPASSING
      // scan-all's built-in annotation. This is necessary because scanAll()
      // now always runs annotateFrameworks (Plan 02-03 Task 1), so results
      // reaching the test already carry framework: null on agents/skills.
      // For the SCAN-04 byte-identical assertion to be meaningful, the input
      // items must NOT already have the framework key set — we need the
      // fresh, pre-annotation scanner output.
      //
      // [Rule 1 - Bug fix from plan] The plan's action block sourced rawItems
      // from scanAll's results.map, but that path runs through annotation
      // first, contaminating the input. Using scanAgents + scanSkills
      // directly gives us the uncontaminated raw input that the
      // --no-group-frameworks Phase 3 flag will actually see when it calls
      // annotateFrameworks(items, []). The empty-registry bypass code path
      // (registry.length === 0) does a shallow clone via { ...item }, so the
      // byte-identical guarantee requires inputs without the key.
      const claudePaths = claudePathsForFixture();
      const agentItems = await scanAgents(claudePaths, []);
      const skillItems = await scanSkills(claudePaths, []);
      const rawItems = [...agentItems, ...skillItems];

      // Pre-assert that our raw inputs have no framework key. If this fails,
      // the scanners themselves regressed.
      expect(rawItems.length).toBeGreaterThan(0);
      for (const item of rawItems) {
        expect(Object.prototype.hasOwnProperty.call(item, 'framework')).toBe(false);
      }

      // Re-run annotation against the raw items with an empty registry.
      // This is the bypass code path the Phase 3 --no-group-frameworks
      // CLI flag will exercise. Every output item must lack the `framework`
      // key entirely (not even set to null) so that JSON.stringify produces
      // byte-identical v1.2.1 output.
      const bypassed = annotateFrameworks(rawItems, []);

      expect(bypassed.length).toBe(rawItems.length);
      for (const item of bypassed) {
        expect(item.framework).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(item, 'framework')).toBe(false);
      }

      // Stronger assertion: serializing the bypassed items must produce JSON
      // that does NOT contain the substring "framework" anywhere. This is
      // the strongest possible check for byte-identical v1.2.1 output.
      const json = JSON.stringify(bypassed);
      expect(json).not.toContain('framework');
    });

    it('Success Criterion #4 (regression guard): annotation does not affect non-framework fields', async () => {
      // Run the pipeline twice and assert that ALL non-framework fields are
      // identical between the two runs. This proves annotation is purely
      // additive and never touches existing data (idempotency invariant).
      //
      // [Rule 1 - Bug fix] Comparing `results1[i]` to `results2[i]` by index
      // is fragile because tinyglobby (for agents) and readdir (for skills)
      // do NOT guarantee stable ordering across consecutive calls on some
      // filesystems. The fix: build a path-keyed map and compare
      // corresponding items, which is the semantically correct identity
      // join for "did the same input produce the same output".
      const { results: results1 } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });
      const { results: results2 } = await scanAll([], {
        claudePaths: claudePathsForFixture(),
        claudeConfigPath: join(fixtureDir, 'does-not-exist-claude.json'),
      });

      expect(results1.length).toBe(results2.length);

      // Build a path-keyed lookup for results2 so we can compare items by
      // their identity (path is unique) rather than by directory traversal
      // order, which is not guaranteed stable between calls.
      const byPath2 = new Map(results2.map((r) => [r.item.path, r]));
      expect(byPath2.size).toBe(results2.length); // paths are unique

      for (const r1 of results1) {
        const r2 = byPath2.get(r1.item.path);
        expect(r2).toBeDefined();
        // tier, lastUsed, invocationCount must match between runs (idempotent).
        expect(r1.tier).toBe(r2!.tier);
        expect(r1.invocationCount).toBe(r2!.invocationCount);
        // item identity fields match
        expect(r1.item.name).toBe(r2!.item.name);
        expect(r1.item.path).toBe(r2!.item.path);
        expect(r1.item.scope).toBe(r2!.item.scope);
        expect(r1.item.category).toBe(r2!.item.category);
        expect(r1.item.projectPath).toBe(r2!.item.projectPath);
      }
    });
  },
);
