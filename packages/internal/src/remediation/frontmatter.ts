// @ccaudit/internal -- hand-rolled YAML frontmatter patcher (Phase 8 D-07 / D-08)
//
// Line-based patcher for memory files (CLAUDE.md + rules/*.md) that flags them
// as stale by writing `ccaudit-stale: true` + `ccaudit-flagged: <iso>` frontmatter
// keys. Three cases per D-08:
//
//   1. No frontmatter (the overwhelming real-world case per RESEARCH empirical
//      sampling)                           -> prepend a fresh block
//   2. Simple flat key:value frontmatter   -> update or inject the ccaudit keys
//                                             in place (preserving unrelated keys)
//   3. Exotic YAML (folded scalars `>` / `|`, nested keys, arrays, unterminated
//      blocks)                             -> refuse to patch, return skipped
//                                             with reason 'exotic-yaml'
//
// D-07: when a file already carries `ccaudit-stale: true`, the current bust
// refreshes `ccaudit-flagged` only (idempotent re-flag). The stale key stays
// untouched.
//
// Zero runtime deps -- uses only `node:fs/promises`. Line endings (LF vs CRLF)
// are detected from the input and preserved on write.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// -- Types --------------------------------------------------------

/**
 * Discriminated result of {@link patchFrontmatter}. Callers MUST pattern-match
 * on `status` before accessing type-specific fields.
 */
export type FrontmatterPatchResult =
  | {
      status: 'patched';
      hadFrontmatter: boolean;
      hadCcauditStale: boolean;
      previousFlaggedAt: string | null;
    }
  | { status: 'refreshed'; previousFlaggedAt: string }
  | { status: 'skipped'; reason: 'exotic-yaml' | 'read-error' | 'write-error' };

// -- Exotic YAML detection ---------------------------------------
//
// These patterns identify constructs that the line-based patcher refuses to
// touch. They are conservative: on any uncertain line the file is skipped.
//
//   - EXOTIC_INDENT       : a line that starts with whitespace followed by a
//                           non-whitespace character. Indicates a nested key,
//                           an array continuation, or a folded-scalar body.
//   - EXOTIC_FOLDED_SCALAR: a top-level key whose value is only the folded or
//                           literal scalar marker (`>` / `|`, optionally with
//                           a chomping indicator `+`/`-`). The body of such a
//                           scalar lives on subsequent indented lines.
//   - EXOTIC_ARRAY_ITEM   : a top-level array item (`- foo`).
const EXOTIC_INDENT = /^\s+\S/;
const EXOTIC_FOLDED_SCALAR = /^[^:]+:\s*[|>][+-]?\s*$/;
const EXOTIC_ARRAY_ITEM = /^\s*-\s/;

// Simple flat key:value line. Keys accept [A-Za-z0-9_.-]; values are
// captured as-is (possibly empty, possibly quoted -- callers strip quotes
// before comparing).
const FLAT_KV = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

// -- Public API ---------------------------------------------------

/**
 * Stub implementation -- see GREEN commit for the real patcher. Every caller
 * currently receives a sentinel skipped result so the in-source test block
 * exercises its assertion paths (all will fail, which is the RED state).
 */
export async function patchFrontmatter(
  _filePath: string,
  _nowIso: string,
): Promise<FrontmatterPatchResult> {
  return { status: 'skipped', reason: 'read-error' };
}

// -- In-source tests ---------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { mkdtemp, writeFile: wf, readFile: rf, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const NOW = '2026-04-05T18:30:00.000Z';

  describe('patchFrontmatter', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'frontmatter-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    async function writeFixture(name: string, content: string): Promise<string> {
      const p = path.join(tmp, name);
      await wf(p, content, 'utf8');
      return p;
    }

    it('fixture 01: no frontmatter -> prepends block', async () => {
      const file = await writeFixture('01.md', '# Heading\nBody text\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      if (result.status === 'patched') {
        expect(result.hadFrontmatter).toBe(false);
        expect(result.hadCcauditStale).toBe(false);
        expect(result.previousFlaggedAt).toBe(null);
      }
      const out = await rf(file, 'utf8');
      expect(out).toMatch(
        /^---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00\.000Z\n---\n\n# Heading/,
      );
    });

    it('fixture 02: empty frontmatter -> injects both keys', async () => {
      const file = await writeFixture('02.md', '---\n---\n\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      const out = await rf(file, 'utf8');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('ccaudit-flagged: 2026-04-05T18:30:00.000Z');
      expect(out).toContain('\nBody\n');
    });

    it('fixture 03: unrelated keys -> injects ccaudit keys, preserves others', async () => {
      const file = await writeFixture('03.md', '---\ntitle: X\nauthor: Y\n---\n\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      if (result.status === 'patched') {
        expect(result.hadFrontmatter).toBe(true);
      }
      const out = await rf(file, 'utf8');
      expect(out).toContain('title: X');
      expect(out).toContain('author: Y');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('ccaudit-flagged: 2026-04-05T18:30:00.000Z');
    });

    it('fixture 04: has ccaudit-stale -> refreshed (D-07)', async () => {
      const file = await writeFixture(
        '04.md',
        '---\ntitle: X\nccaudit-stale: true\nccaudit-flagged: 2026-01-01T00:00:00Z\n---\n\nBody\n',
      );
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('refreshed');
      if (result.status === 'refreshed') {
        expect(result.previousFlaggedAt).toBe('2026-01-01T00:00:00Z');
      }
      const out = await rf(file, 'utf8');
      // Old timestamp replaced, stale flag unchanged, unrelated key preserved.
      expect(out).toContain('ccaudit-flagged: 2026-04-05T18:30:00.000Z');
      expect(out).not.toContain('2026-01-01T00:00:00Z');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('title: X');
    });

    it('fixture 05: folded scalar -> skipped exotic-yaml', async () => {
      const file = await writeFixture(
        '05.md',
        '---\ndescription: >\n  multi-line\n  folded\n---\nBody\n',
      );
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 06: array item -> skipped exotic-yaml', async () => {
      const file = await writeFixture('06.md', '---\ntools:\n  - Read\n  - Write\n---\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 07: nested key -> skipped exotic-yaml', async () => {
      const file = await writeFixture('07.md', '---\nconfig:\n  nested: true\n---\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 08: CRLF line endings -> preserved on write', async () => {
      const file = await writeFixture('08.md', '# Heading\r\nBody\r\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      const out = await rf(file, 'utf8');
      // CRLF is present in the output.
      expect(out.includes('\r\n')).toBe(true);
      // And no lone LF bytes appear outside CRLF pairs.
      const loneLF = /(?<!\r)\n/.test(out);
      expect(loneLF).toBe(false);
    });

    it('fixture 09: unterminated frontmatter -> skipped exotic-yaml', async () => {
      const file = await writeFixture(
        '09.md',
        '---\nkey: value\n\n# Body (no closing fence)\n',
      );
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 10: empty file -> prepends fresh block', async () => {
      const file = await writeFixture('10.md', '');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      if (result.status === 'patched') {
        expect(result.hadFrontmatter).toBe(false);
      }
      const out = await rf(file, 'utf8');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('ccaudit-flagged: 2026-04-05T18:30:00.000Z');
    });

    it('round-trip idempotency: second patch refreshes first', async () => {
      const file = await writeFixture('idem.md', '# Heading\n');
      const r1 = await patchFrontmatter(file, '2026-01-01T00:00:00.000Z');
      expect(r1.status).toBe('patched');
      const r2 = await patchFrontmatter(file, NOW);
      expect(r2.status).toBe('refreshed');
      if (r2.status === 'refreshed') {
        expect(r2.previousFlaggedAt).toBe('2026-01-01T00:00:00.000Z');
      }
    });

    it('non-existent file -> skipped read-error', async () => {
      const result = await patchFrontmatter(path.join(tmp, 'nope.md'), NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'read-error' });
    });
  });
}
