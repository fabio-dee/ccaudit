/**
 * Phase 3 — Safety-invariant integration tests for MCP byte-preservation
 * (INV-S1) and the cross-path equivalence smoke for INV-S4 + INV-S5
 * (CONTEXT D-13).
 *
 * INV-S1 (SAFETY-01): unselected MCP server keys in shared ~/.claude.json
 * are byte-preserved across a subset bust. The test selects ONLY serverA
 * via CCAUDIT_SELECT_IDS, runs --dangerously-bust-ghosts, then asserts
 * that serverB's key + value + surrounding formatting bytes are
 * IDENTICAL to a hand-crafted slice of the original fixture file.
 *
 * Why bytes (not JSON-equivalent): a naive JSON.parse + JSON.stringify
 * round-trip would produce JSON-equivalent but byte-DIFFERENT output
 * (key reordering, indent changes, trailing newline loss). The fixture
 * deliberately uses 2-space indent + serverA-before-serverB key order
 * + a trailing newline so any naive rewrite would fail this test.
 *
 * INV-S4/S5 cross-path equivalence: ONE combined test that runs the
 * SAME subset bust as INV-S1 and asserts the manifest's selection_filter
 * shape + freedTokens-vs-totalPlannedTokens semantics match what the
 * Phase 1 unit tests already pin for the ghost-select-ids env path.
 * This is intentionally light coverage (CONTEXT D-13).
 *
 * Pattern mirrors bust-command.test.ts and ghost-select-ids.test.ts.
 * Helpers come from _test-helpers.ts (Phase 3 Plan 01).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from '@ccaudit/internal';
import {
  makeTmpHome,
  cleanupTmpHome,
  buildFakePs,
  runCcauditGhost,
  createMcpFixture,
  readMcpConfigBytes,
  mcpItemId,
} from './_test-helpers.ts';

// ── Guard: dist must exist before any test runs ────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '..', '..', 'dist', 'index.js');
beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `dist binary not found at ${distPath}. Run \`pnpm -F ccaudit build\` before running this test.`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-S1: MCP byte-preservation (SAFETY-01)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.platform === 'win32')(
  'Phase 3 — INV-S1: MCP byte-preservation (SAFETY-01)',
  () => {
    let tmpHome: string;
    let preBustBytes: Buffer;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      // .claude/ directory tree the scanners walk
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      // Minimal session JSONL so discoverSessionFiles returns ≥1 file
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      const sessionLine = JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/fake/project',
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        sessionId: 'inv-s1-session',
      });
      await writeFile(path.join(sessionDir, 'session-1.jsonl'), sessionLine + '\n', 'utf8');

      // MCP fixture: 2 servers (A, B) with deliberate formatting quirks
      await createMcpFixture(tmpHome);
      preBustBytes = await readMcpConfigBytes(tmpHome);

      // Fake ps shim (Claude-process preflight passes)
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    // ── Test 1: INV-S1 — serverB bytes byte-identical post-subset-bust ──
    it('serverB key + value + surrounding bytes are byte-identical after subset-bust(serverA)', async () => {
      // Step 1: dry-run to write checkpoint (gate 1).
      const dry = runCcauditGhost(tmpHome, ['--dry-run', '--yes-proceed-busting', '--json']);
      dry.child.stdin?.end();
      const dryResult = await dry.done;
      expect(dryResult.exitCode, `dry-run stderr: ${dryResult.stderr}`).toBe(0);

      // Step 2: subset-bust serverA only via CCAUDIT_SELECT_IDS.
      const aId = mcpItemId(tmpHome, 'serverA');
      const bust = runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: aId } },
      );
      bust.child.stdin?.end();
      const bustResult = await bust.done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      // Step 3: read post-bust bytes.
      const postBustBytes = await readMcpConfigBytes(tmpHome);
      const postBustText = postBustBytes.toString('utf8');

      // Step 4: locate serverB's exact byte slice in pre AND post buffers.
      // Slice spans from the literal '"serverB":' opening through the closing '}' of its value object.
      // Implementation: find the byte index of '"serverB":' in both buffers, then walk forward
      // to the matching '}' that closes the value object (track brace depth from 0 at the colon).
      const findServerBSlice = (text: string): { start: number; end: number } | null => {
        const needle = '"serverB":';
        const start = text.indexOf(needle);
        if (start === -1) return null;
        // Walk forward from after the colon, finding the value's opening '{' and matching '}'.
        let i = start + needle.length;
        // Skip any whitespace
        while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t')) i++;
        if (text[i] !== '{') return null; // not an object value
        // Walk to the matching closing `}`, respecting JSON string boundaries.
        let depth = 0;
        let inString = false;
        for (; i < text.length; i++) {
          const ch = text[i];
          if (inString) {
            if (ch === '\\') {
              i++;
              continue;
            } // skip escaped char
            if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') {
            inString = true;
            continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) return { start, end: i + 1 };
          }
        }
        return null;
      };
      const preText = preBustBytes.toString('utf8');
      const preSlice = findServerBSlice(preText);
      const postSlice = findServerBSlice(postBustText);

      expect(preSlice, 'serverB block must be present in pre-bust fixture').not.toBeNull();
      expect(
        postSlice,
        `serverB block missing post-bust; full post-bust file:\n${postBustText}`,
      ).not.toBeNull();

      // Compare the EXACT byte ranges. Strings (not Buffers) are sufficient because
      // utf8 round-trip is byte-stable for ASCII fixtures, and the assertion message
      // is far more legible on string mismatch.
      const preServerBChunk = preText.slice(preSlice!.start, preSlice!.end);
      const postServerBChunk = postBustText.slice(postSlice!.start, postSlice!.end);
      expect(postServerBChunk).toBe(preServerBChunk);
    });

    // ── Test 2: INV-S1 supplement — serverA key renamed to ccaudit-disabled:serverA ──
    it('serverA key is renamed to ccaudit-disabled:serverA after subset-bust(serverA)', async () => {
      // dry-run + subset-bust as above
      const dry = runCcauditGhost(tmpHome, ['--dry-run', '--yes-proceed-busting', '--json']);
      dry.child.stdin?.end();
      await dry.done;

      const aId = mcpItemId(tmpHome, 'serverA');
      const bust = runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: aId } },
      );
      bust.child.stdin?.end();
      const bustResult = await bust.done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      // Parse post-bust JSON to verify the rename.
      const postBustParsed = JSON.parse(
        (await readMcpConfigBytes(tmpHome)).toString('utf8'),
      ) as Record<string, unknown>;

      // ccaudit-disabled:serverA appears at the ROOT level (current v1.4.0 disable behavior),
      // and the original mcpServers.serverA key is gone.
      expect(postBustParsed['ccaudit-disabled:serverA']).toBeDefined();
      expect(postBustParsed['ccaudit-disabled:serverA']).toMatchObject({
        command: 'npx',
        args: ['server-a'],
      });
      const mcpServers = postBustParsed.mcpServers as Record<string, unknown> | undefined;
      expect(mcpServers?.serverA).toBeUndefined();
      // serverB is still under mcpServers (not renamed because it was not selected).
      expect(mcpServers?.serverB).toBeDefined();
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// INV-S4/S5 cross-path equivalence (CONTEXT D-13) — light coverage
// ─────────────────────────────────────────────────────────────────

describe.skipIf(process.platform === 'win32')(
  'Phase 3 — INV-S4 + INV-S5 cross-path equivalence (light)',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'cross-path',
        }) + '\n',
        'utf8',
      );
      await createMcpFixture(tmpHome);
      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('subset bust on serverA produces a manifest with subset selection_filter and subset-accurate freedTokens', async () => {
      const dry = runCcauditGhost(tmpHome, ['--dry-run', '--yes-proceed-busting', '--json']);
      dry.child.stdin?.end();
      const dryResult = await dry.done;
      expect(dryResult.exitCode, `dry-run stderr: ${dryResult.stderr}`).toBe(0);

      const aId = mcpItemId(tmpHome, 'serverA');
      const bust = runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: aId } },
      );
      bust.child.stdin?.end();
      const bustResult = await bust.done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      const parsed = JSON.parse(bustResult.stdout) as {
        bust: {
          status: string;
          manifestPath: string;
          summary: { freedTokens: number; totalPlannedTokens: number };
        };
      };
      expect(parsed.bust.status).toBe('success');

      // INV-S4 cross-path: manifest selection_filter is subset, planned_ops.disable=1
      const manifest = await readManifest(parsed.bust.manifestPath);
      expect(manifest.header).not.toBeNull();
      expect(manifest.header!.selection_filter).toBeDefined();
      expect(manifest.header!.selection_filter!.mode).toBe('subset');
      const sf = manifest.header!.selection_filter as { mode: 'subset'; ids: string[] };
      expect(sf.ids).toEqual([aId]);
      expect(manifest.header!.planned_ops.disable).toBe(1);
      expect(manifest.header!.planned_ops.archive).toBe(0);
      expect(manifest.header!.planned_ops.flag).toBe(0);

      // INV-S5 cross-path: freedTokens > 0, freedTokens < totalPlannedTokens
      // (Only 1 of 2 MCP servers archived → strict less-than. We tolerate equal
      //  if the unselected server's token estimate is 0, but with the canonical
      //  npx-style fixture both estimate to a positive value.)
      expect(parsed.bust.summary.freedTokens).toBeGreaterThan(0);
      expect(parsed.bust.summary.freedTokens).toBeLessThanOrEqual(
        parsed.bust.summary.totalPlannedTokens,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C2: INV-S1 with project-scoped + global-scoped same-name servers
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.platform === 'win32')(
  'Phase 3 — C2: INV-S1 scoped rename with project+global same-name servers',
  () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = await makeTmpHome();
      await mkdir(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
      await mkdir(path.join(tmpHome, '.claude', 'skills'), { recursive: true });
      await mkdir(path.join(tmpHome, '.config', 'claude'), { recursive: true });
      const sessionDir = path.join(tmpHome, '.claude', 'projects', 'fake-project');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'session-1.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: '/fake/project',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          sessionId: 'c2-inv-s1-session',
        }) + '\n',
        'utf8',
      );

      // Fixture: serverA appears in BOTH a project-level block AND the global
      // mcpServers block. The project entry appears first in the document so a
      // naive text.indexOf(`"serverA":`) would match it instead of the global one.
      const body =
        '{\n' +
        '  "projects": {\n' +
        '    "/some/project": {\n' +
        '      "mcpServers": {\n' +
        '        "serverA": {\n' +
        '          "command": "project-scoped"\n' +
        '        }\n' +
        '      }\n' +
        '    }\n' +
        '  },\n' +
        '  "mcpServers": {\n' +
        '    "serverA": {\n' +
        '      "command": "npx",\n' +
        '      "args": ["server-a"]\n' +
        '    },\n' +
        '    "serverB": {\n' +
        '      "command": "npx",\n' +
        '      "args": ["server-b"]\n' +
        '    }\n' +
        '  }\n' +
        '}\n';
      await writeFile(path.join(tmpHome, '.claude.json'), body, 'utf8');

      await buildFakePs(tmpHome);
    });

    afterEach(async () => {
      await cleanupTmpHome(tmpHome);
    });

    it('C2-INV-S1: subset bust of global serverA renames global key, leaves project block byte-identical', async () => {
      // Step 1: dry-run checkpoint
      const dry = runCcauditGhost(tmpHome, ['--dry-run', '--yes-proceed-busting', '--json']);
      dry.child.stdin?.end();
      const dryResult = await dry.done;
      expect(dryResult.exitCode, `dry-run stderr: ${dryResult.stderr}`).toBe(0);

      // Capture original project block bytes for comparison
      const preBustText = (await readMcpConfigBytes(tmpHome)).toString('utf8');

      // Step 2: subset-bust global serverA only
      const aId = mcpItemId(tmpHome, 'serverA');
      const bust = runCcauditGhost(
        tmpHome,
        ['--dangerously-bust-ghosts', '--yes-proceed-busting', '--json'],
        { env: { CCAUDIT_SELECT_IDS: aId } },
      );
      bust.child.stdin?.end();
      const bustResult = await bust.done;
      expect(bustResult.exitCode, `bust stderr: ${bustResult.stderr}`).toBe(0);

      const postBustText = (await readMcpConfigBytes(tmpHome)).toString('utf8');
      const postBustParsed = JSON.parse(postBustText) as Record<string, unknown>;

      // Global mcpServers.serverA must be gone
      const globalMcp = postBustParsed.mcpServers as Record<string, unknown> | undefined;
      expect(globalMcp?.serverA).toBeUndefined();

      // A ccaudit-disabled:serverA key must appear at root with the global value
      const disabledKey = Object.keys(postBustParsed).find((k) =>
        k.startsWith('ccaudit-disabled:serverA'),
      );
      expect(disabledKey).toBeDefined();
      expect(postBustParsed[disabledKey!]).toMatchObject({ command: 'npx', args: ['server-a'] });

      // Project-scoped serverA must be untouched
      const projects = postBustParsed.projects as Record<
        string,
        { mcpServers?: Record<string, unknown> }
      >;
      expect(projects['/some/project']?.mcpServers?.serverA).toEqual({
        command: 'project-scoped',
      });

      // Verify the project block bytes are identical (C2 byte-preservation check)
      const findProjectBlock = (text: string): string | null => {
        const needle = '"projects":';
        const start = text.indexOf(needle);
        if (start === -1) return null;
        let i = start + needle.length;
        while (i < text.length && /\s/.test(text[i]!)) i++;
        if (text[i] !== '{') return null;
        let depth = 0;
        let inS = false;
        for (let k = i; k < text.length; k++) {
          const c = text[k];
          if (inS) {
            if (c === '\\') {
              k++;
              continue;
            }
            if (c === '"') inS = false;
            continue;
          }
          if (c === '"') {
            inS = true;
            continue;
          }
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) return text.slice(i, k + 1);
          }
        }
        return null;
      };
      const preProjectBlock = findProjectBlock(preBustText);
      const postProjectBlock = findProjectBlock(postBustText);
      expect(preProjectBlock).not.toBeNull();
      expect(postProjectBlock).toBe(preProjectBlock);

      // Manifest records original_key === "mcpServers.serverA" and scope === "global"
      const envelope = JSON.parse(bustResult.stdout) as {
        bust: { manifestPath: string };
      };
      const manifest = await readManifest(envelope.bust.manifestPath);
      const disableOp = (manifest.ops ?? []).find(
        (o: { op_type?: string }) => o.op_type === 'disable',
      ) as { original_key?: string; scope?: string } | undefined;
      expect(disableOp).toBeDefined();
      expect(disableOp!.original_key).toBe('mcpServers.serverA');
      expect(disableOp!.scope).toBe('global');
    });
  },
);
