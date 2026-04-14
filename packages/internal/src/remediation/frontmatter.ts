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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFilePreservingMtime } from './fs-utils.ts';

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

// -- Additional result type for remove/update ops -----------------

/**
 * Discriminated result of {@link removeFrontmatterKeys} and {@link setFrontmatterValue}.
 */
export type FrontmatterRemoveResult =
  | { status: 'removed'; keysRemoved: string[]; blockDeleted: boolean }
  | { status: 'updated'; key: string; previousValue: string | null }
  | { status: 'no-frontmatter' }
  | { status: 'keys-not-found' }
  | { status: 'skipped'; reason: 'exotic-yaml' | 'read-error' | 'write-error' | 'file-not-found' };

// -- Shared internal parse helper ---------------------------------

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  openLineIdx: number; // index of opening --- in split lines (always 0 when hasFrontmatter)
  closeLineIdx: number; // index of closing ---
  bodyLines: string[]; // lines between the fences
  trailingLines: string[]; // everything after closing ---
  lineEnding: '\n' | '\r\n';
  hasBom: boolean;
  exotic: boolean;
}

/**
 * Parse a raw file string into its frontmatter components.
 * Detects line endings, BOM, exotic-yaml constructs, and splits the
 * body/trailing content. Returns `hasFrontmatter: false` when the file
 * does not start with `---` after BOM stripping.
 */
function parseFlatFrontmatter(raw: string): ParsedFrontmatter {
  const lineEnding: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  let hasBom = false;
  if (lines[0]?.charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0]!.slice(1);
    hasBom = true;
  }

  const notFound: ParsedFrontmatter = {
    hasFrontmatter: false,
    openLineIdx: -1,
    closeLineIdx: -1,
    bodyLines: [],
    trailingLines: lines,
    lineEnding,
    hasBom,
    exotic: false,
  };

  if (lines[0] !== '---') return notFound;

  // Find closing fence
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Unterminated block — treat as exotic
    return {
      hasFrontmatter: true,
      openLineIdx: 0,
      closeLineIdx: -1,
      bodyLines: lines.slice(1),
      trailingLines: [],
      lineEnding,
      hasBom,
      exotic: true,
    };
  }

  const bodyLines = lines.slice(1, closeIdx);
  const trailingLines = lines.slice(closeIdx + 1);

  // Check for exotic constructs in body lines
  let exotic = false;
  for (const line of bodyLines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (
      EXOTIC_INDENT.test(line) ||
      EXOTIC_FOLDED_SCALAR.test(line) ||
      EXOTIC_ARRAY_ITEM.test(line)
    ) {
      exotic = true;
      break;
    }
    if (!FLAT_KV.test(line)) {
      exotic = true;
      break;
    }
  }

  return {
    hasFrontmatter: true,
    openLineIdx: 0,
    closeLineIdx: closeIdx,
    bodyLines,
    trailingLines,
    lineEnding,
    hasBom,
    exotic,
  };
}

// -- Public API ---------------------------------------------------

/**
 * Patch a memory file's frontmatter to flag it as stale (D-07, D-08).
 *
 * Case handling:
 *   1. No frontmatter                   -> prepend a fresh `---\n ... \n---\n\n`
 *                                           block followed by the original body
 *                                           (`{status:'patched', hadFrontmatter:false}`)
 *   2. Flat key:value frontmatter       -> inject missing ccaudit keys before
 *                                           the closing fence; unrelated keys
 *                                           are preserved
 *                                           (`{status:'patched', hadFrontmatter:true}`)
 *   3. Already has `ccaudit-stale:true` -> D-07 idempotent refresh: update the
 *                                           `ccaudit-flagged` timestamp only and
 *                                           leave the stale key alone
 *                                           (`{status:'refreshed', previousFlaggedAt}`)
 *   4. Exotic / malformed frontmatter   -> return `{status:'skipped', reason:'exotic-yaml'}`
 *                                           and leave the file untouched. This
 *                                           covers folded scalars (`>` / `|`),
 *                                           nested keys, arrays, and
 *                                           unterminated blocks.
 *
 * Line endings are detected from the input (LF vs CRLF) and preserved on write.
 * A leading UTF-8 BOM is transparently stripped on read.
 *
 * Read failures (missing file, permission denied, non-UTF-8 bytes) return
 * `{status:'skipped', reason:'read-error'}`. Write failures after a successful
 * read return `{status:'skipped', reason:'write-error'}`.
 */
export async function patchFrontmatter(
  filePath: string,
  nowIso: string,
): Promise<FrontmatterPatchResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { status: 'skipped', reason: 'read-error' };
  }

  // Detect line ending style; preserved on every writeback below.
  const crlf = /\r\n/.test(raw);
  const eol = crlf ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  // Strip a leading BOM if present -- some markdown editors emit one and it
  // would prevent the literal `---` match on line 0.
  if (lines[0]?.charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0]!.slice(1);
  }

  // CASE 1: No frontmatter. The empty-file edge case is also handled here --
  //         lines is `['']`, the `---` test fails, and we prepend a fresh block.
  const hasFrontmatter = lines[0] === '---';
  if (!hasFrontmatter) {
    const block = ['---', 'ccaudit-stale: true', `ccaudit-flagged: ${nowIso}`, '---', ''].join(eol);
    // Re-join the original lines with the detected eol so we do not flip
    // line endings while appending the prepended block.
    const body = lines.join(eol);
    const out = body === '' ? block + eol : block + eol + body;
    try {
      await writeFilePreservingMtime(filePath, out);
    } catch {
      return { status: 'skipped', reason: 'write-error' };
    }
    return {
      status: 'patched',
      hadFrontmatter: false,
      hadCcauditStale: false,
      previousFlaggedAt: null,
    };
  }

  // Frontmatter block detected on line 0. Find the closing fence.
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    // Unterminated frontmatter block -- refuse to touch.
    return { status: 'skipped', reason: 'exotic-yaml' };
  }

  // Walk the frontmatter body (lines 1 .. closingIdx-1) and validate that
  // every non-blank non-comment line is a simple flat key:value. Any exotic
  // construct triggers a skip with reason 'exotic-yaml'.
  const bodyLines = lines.slice(1, closingIdx);
  let ccauditStaleIdx = -1; // index RELATIVE to bodyLines
  let ccauditFlaggedIdx = -1; // index RELATIVE to bodyLines
  let previousFlaggedAt: string | null = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Detect exotic constructs before attempting to parse as flat key:value.
    // Order matters: folded-scalar check runs before the indent check because
    // a `description: >` line itself is NOT indented, but its continuation
    // lines are. EXOTIC_INDENT catches the continuation lines that appear
    // after it.
    if (
      EXOTIC_INDENT.test(line) ||
      EXOTIC_FOLDED_SCALAR.test(line) ||
      EXOTIC_ARRAY_ITEM.test(line)
    ) {
      return { status: 'skipped', reason: 'exotic-yaml' };
    }

    const m = FLAT_KV.exec(line);
    if (!m) {
      return { status: 'skipped', reason: 'exotic-yaml' };
    }

    if (m[1] === 'ccaudit-stale') ccauditStaleIdx = i;
    if (m[1] === 'ccaudit-flagged') {
      ccauditFlaggedIdx = i;
      // Strip surrounding quotes (single or double) and whitespace so the
      // previous value round-trips through the manifest unchanged.
      previousFlaggedAt = (m[2] ?? '').replace(/^["']|["']$/g, '').trim();
    }
  }

  // D-07 idempotent refresh: both ccaudit keys already present -> replace the
  // ccaudit-flagged value in place; leave ccaudit-stale and everything else
  // alone.
  if (ccauditStaleIdx >= 0 && ccauditFlaggedIdx >= 0) {
    const newLines = [...lines];
    // bodyLines index -> lines index: add 1 to skip the opening `---` fence.
    newLines[ccauditFlaggedIdx + 1] = `ccaudit-flagged: ${nowIso}`;
    try {
      await writeFilePreservingMtime(filePath, newLines.join(eol));
    } catch {
      return { status: 'skipped', reason: 'write-error' };
    }
    return {
      status: 'refreshed',
      previousFlaggedAt: previousFlaggedAt ?? 'unknown',
    };
  }

  // Flat frontmatter with one or both ccaudit keys missing -- inject whichever
  // keys are absent immediately before the closing `---` fence.
  const inject: string[] = [];
  if (ccauditStaleIdx < 0) inject.push('ccaudit-stale: true');
  if (ccauditFlaggedIdx < 0) inject.push(`ccaudit-flagged: ${nowIso}`);

  const newLines = [...lines];
  newLines.splice(closingIdx, 0, ...inject);
  try {
    await writeFilePreservingMtime(filePath, newLines.join(eol));
  } catch {
    return { status: 'skipped', reason: 'write-error' };
  }
  return {
    status: 'patched',
    hadFrontmatter: true,
    hadCcauditStale: ccauditStaleIdx >= 0,
    previousFlaggedAt,
  };
}

// -- Restore helpers (Phase 9 Plan 02) ----------------------------

/**
 * Remove named keys from a flat frontmatter block and write the file back.
 *
 * - If all remaining body lines are blank/comment-only after removal, the
 *   entire `---` block is deleted (Q4 empty-block handling).
 * - Returns `keys-not-found` when none of the requested keys were present.
 * - Returns `no-frontmatter` when the file has no frontmatter block at all.
 * - Skips with `exotic-yaml` for any frontmatter that parseFlatFrontmatter
 *   classifies as exotic.
 * - Preserves CRLF line endings and leading UTF-8 BOM.
 */
export async function removeFrontmatterKeys(
  filePath: string,
  keys: string[],
): Promise<FrontmatterRemoveResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'skipped', reason: 'file-not-found' };
    }
    return { status: 'skipped', reason: 'read-error' };
  }

  const parsed = parseFlatFrontmatter(raw);
  if (!parsed.hasFrontmatter) return { status: 'no-frontmatter' };
  if (parsed.exotic) return { status: 'skipped', reason: 'exotic-yaml' };

  const keysSet = new Set(keys);
  const keysRemoved: string[] = [];
  const filteredBodyLines: string[] = [];

  for (const line of parsed.bodyLines) {
    const match = FLAT_KV.exec(line);
    if (match !== null && keysSet.has(match[1]!)) {
      keysRemoved.push(match[1]!);
      continue; // drop this line
    }
    filteredBodyLines.push(line);
  }

  if (keysRemoved.length === 0) return { status: 'keys-not-found' };

  // Q4: remove entire block if all remaining lines are blank or comment-only
  const allRemainingBlank = filteredBodyLines.every(
    (line) => line.trim() === '' || line.trim().startsWith('#'),
  );

  const LE = parsed.lineEnding;
  const bom = parsed.hasBom ? '\uFEFF' : '';
  let rebuilt: string;
  if (allRemainingBlank) {
    // Drop the entire --- block; preserve trailing body (strip leading blank line if present)
    const trailing = parsed.trailingLines.join(LE);
    const trimmedLeading = trailing.replace(/^(\r?\n)+/, '');
    rebuilt = bom + trimmedLeading;
  } else {
    rebuilt =
      bom +
      '---' +
      LE +
      filteredBodyLines.join(LE) +
      LE +
      '---' +
      LE +
      parsed.trailingLines.join(LE);
  }

  try {
    await writeFilePreservingMtime(filePath, rebuilt);
  } catch {
    return { status: 'skipped', reason: 'write-error' };
  }

  return {
    status: 'removed',
    keysRemoved,
    blockDeleted: allRemainingBlank,
  };
}

/**
 * Replace the value of an existing key in a flat frontmatter block in-place.
 *
 * - Returns `keys-not-found` when the key is absent from the frontmatter.
 * - Returns `no-frontmatter` when the file has no frontmatter block at all.
 * - Skips with `exotic-yaml` for exotic frontmatter.
 * - Preserves CRLF line endings and leading UTF-8 BOM.
 * - Returns the previous value in `result.previousValue` for rollback callers.
 */
export async function setFrontmatterValue(
  filePath: string,
  key: string,
  value: string,
): Promise<FrontmatterRemoveResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'skipped', reason: 'file-not-found' };
    }
    return { status: 'skipped', reason: 'read-error' };
  }

  const parsed = parseFlatFrontmatter(raw);
  if (!parsed.hasFrontmatter) return { status: 'no-frontmatter' };
  if (parsed.exotic) return { status: 'skipped', reason: 'exotic-yaml' };

  let previousValue: string | null = null;
  const newBodyLines = parsed.bodyLines.map((line) => {
    const match = FLAT_KV.exec(line);
    if (match !== null && match[1] === key) {
      previousValue = match[2] ?? null;
      return `${key}: ${value}`;
    }
    return line;
  });

  if (previousValue === null) return { status: 'keys-not-found' };

  const LE = parsed.lineEnding;
  const bom = parsed.hasBom ? '\uFEFF' : '';
  const rebuilt =
    bom + '---' + LE + newBodyLines.join(LE) + LE + '---' + LE + parsed.trailingLines.join(LE);

  try {
    await writeFilePreservingMtime(filePath, rebuilt);
  } catch {
    return { status: 'skipped', reason: 'write-error' };
  }

  return { status: 'updated', key, previousValue };
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

    it('fixture 01: no frontmatter → prepends block', async () => {
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

    it('fixture 02: empty frontmatter → injects both keys', async () => {
      const file = await writeFixture('02.md', '---\n---\n\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result.status).toBe('patched');
      const out = await rf(file, 'utf8');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('ccaudit-flagged: 2026-04-05T18:30:00.000Z');
      expect(out).toContain('\nBody\n');
    });

    it('fixture 03: unrelated keys → injects ccaudit keys, preserves others', async () => {
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

    it('fixture 04: has ccaudit-stale → refreshed (D-07)', async () => {
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

    it('fixture 05: folded scalar → skipped exotic-yaml', async () => {
      const file = await writeFixture(
        '05.md',
        '---\ndescription: >\n  multi-line\n  folded\n---\nBody\n',
      );
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 06: array item → skipped exotic-yaml', async () => {
      const file = await writeFixture('06.md', '---\ntools:\n  - Read\n  - Write\n---\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 07: nested key → skipped exotic-yaml', async () => {
      const file = await writeFixture('07.md', '---\nconfig:\n  nested: true\n---\nBody\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 08: CRLF line endings → preserved on write', async () => {
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

    it('fixture 09: unterminated frontmatter → skipped exotic-yaml', async () => {
      const file = await writeFixture('09.md', '---\nkey: value\n\n# Body (no closing fence)\n');
      const result = await patchFrontmatter(file, NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'exotic-yaml' });
    });

    it('fixture 10: empty file → prepends fresh block', async () => {
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

    it('non-existent file → skipped read-error', async () => {
      const result = await patchFrontmatter(path.join(tmp, 'nope.md'), NOW);
      expect(result).toEqual({ status: 'skipped', reason: 'read-error' });
    });
  });

  describe('removeFrontmatterKeys', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'rmkeys-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    async function writeFixture(name: string, content: string): Promise<string> {
      const p = path.join(tmp, name);
      await wf(p, content, 'utf8');
      return p;
    }

    it('Test 1: all ccaudit keys present → entire block removed, file becomes body only', async () => {
      const file = await writeFixture(
        't1.md',
        '---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
      );
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale', 'ccaudit-flagged']);
      expect(result.status).toBe('removed');
      if (result.status === 'removed') {
        expect(result.keysRemoved).toContain('ccaudit-stale');
        expect(result.keysRemoved).toContain('ccaudit-flagged');
        expect(result.blockDeleted).toBe(true);
      }
      const out = await rf(file, 'utf8');
      expect(out).not.toContain('---');
      expect(out).toContain('# body');
    });

    it('Test 2: mixed keys → block kept with only unrelated key, body preserved', async () => {
      const file = await writeFixture(
        't2.md',
        '---\ntitle: Hello\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
      );
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale', 'ccaudit-flagged']);
      expect(result.status).toBe('removed');
      if (result.status === 'removed') {
        expect(result.blockDeleted).toBe(false);
      }
      const out = await rf(file, 'utf8');
      expect(out).toContain('title: Hello');
      expect(out).not.toContain('ccaudit-stale');
      expect(out).not.toContain('ccaudit-flagged');
      expect(out).toContain('# body');
    });

    it('Test 3: no frontmatter → status=no-frontmatter, file unchanged', async () => {
      const file = await writeFixture('t3.md', '# body\n');
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale']);
      expect(result.status).toBe('no-frontmatter');
      const out = await rf(file, 'utf8');
      expect(out).toBe('# body\n');
    });

    it('Test 4: frontmatter missing requested keys → status=keys-not-found, file unchanged', async () => {
      const file = await writeFixture('t4.md', '---\ntitle: Hello\n---\n# body\n');
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale']);
      expect(result.status).toBe('keys-not-found');
      const out = await rf(file, 'utf8');
      expect(out).toBe('---\ntitle: Hello\n---\n# body\n');
    });

    it('Test 5: exotic YAML (folded scalar) → status=skipped, reason=exotic-yaml', async () => {
      const file = await writeFixture('t5.md', '---\ndescription: >\n  multi-line\n---\n# body\n');
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale']);
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('exotic-yaml');
      }
    });

    it('Test 6: CRLF line endings preserved on write', async () => {
      const file = await writeFixture(
        't6.md',
        '---\r\ntitle: X\r\nccaudit-stale: true\r\n---\r\n# body\r\n',
      );
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale']);
      expect(result.status).toBe('removed');
      const out = await rf(file, 'utf8');
      expect(out.includes('\r\n')).toBe(true);
      expect(out).toContain('title: X');
    });

    it('Test 7: UTF-8 BOM stripped transparently', async () => {
      // BOM before the --- fence
      const file = await writeFixture(
        't7.md',
        '\uFEFF---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
      );
      const result = await removeFrontmatterKeys(file, ['ccaudit-stale', 'ccaudit-flagged']);
      expect(result.status).toBe('removed');
      const out = await rf(file, 'utf8');
      expect(out).not.toContain('---');
    });

    it('Test 8: read error (ENOENT) → status=skipped, reason=file-not-found', async () => {
      const result = await removeFrontmatterKeys(path.join(tmp, 'nope.md'), ['ccaudit-stale']);
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('file-not-found');
      }
    });
  });

  describe('setFrontmatterValue', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'setval-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    async function writeFixture(name: string, content: string): Promise<string> {
      const p = path.join(tmp, name);
      await wf(p, content, 'utf8');
      return p;
    }

    it('Test 9: replaces existing key value in-place, other keys preserved, body preserved', async () => {
      const file = await writeFixture(
        't9.md',
        '---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
      );
      const result = await setFrontmatterValue(file, 'ccaudit-flagged', '2026-04-01T10:00:00Z');
      expect(result.status).toBe('updated');
      if (result.status === 'updated') {
        expect(result.key).toBe('ccaudit-flagged');
        expect(result.previousValue).toBe('2026-04-05T18:30:00Z');
      }
      const out = await rf(file, 'utf8');
      expect(out).toContain('ccaudit-flagged: 2026-04-01T10:00:00Z');
      expect(out).toContain('ccaudit-stale: true');
      expect(out).toContain('# body');
      expect(out).not.toContain('2026-04-05T18:30:00Z');
    });

    it('Test 10: key does NOT exist in frontmatter → status=keys-not-found', async () => {
      const file = await writeFixture('t10.md', '---\ntitle: Hello\n---\n# body\n');
      const result = await setFrontmatterValue(file, 'ccaudit-flagged', '2026-04-01T10:00:00Z');
      expect(result.status).toBe('keys-not-found');
      const out = await rf(file, 'utf8');
      expect(out).toBe('---\ntitle: Hello\n---\n# body\n');
    });

    it('Test 11: no frontmatter → status=no-frontmatter', async () => {
      const file = await writeFixture('t11.md', '# body\n');
      const result = await setFrontmatterValue(file, 'ccaudit-flagged', '2026-04-01T10:00:00Z');
      expect(result.status).toBe('no-frontmatter');
    });

    it('Test 12: exotic YAML → status=skipped, reason=exotic-yaml', async () => {
      const file = await writeFixture('t12.md', '---\ndescription: >\n  multi-line\n---\n# body\n');
      const result = await setFrontmatterValue(file, 'ccaudit-flagged', '2026-04-01T10:00:00Z');
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('exotic-yaml');
      }
    });
  });

  // -- mtime preservation tests (Bug #3) ---------------------------
  // Each test ages a temp file to 60 days ago, invokes the function,
  // and asserts mtime is unchanged (±100ms tolerance).

  describe('mtime preservation: patchFrontmatter', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'mtime-patch-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('patchFrontmatter preserves mtime after patching a file', async () => {
      const { utimes, stat } = await import('node:fs/promises');
      const filePath = path.join(tmp, 'mtime-test.md');
      await wf(filePath, '# Heading\n', 'utf8');
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await utimes(filePath, oldTime, oldTime);
      const { mtimeMs: beforeMs } = await stat(filePath);
      await patchFrontmatter(filePath, NOW);
      const { mtimeMs: afterMs } = await stat(filePath);
      expect(Math.abs(afterMs - beforeMs)).toBeLessThan(100);
    });
  });

  describe('mtime preservation: removeFrontmatterKeys', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'mtime-rm-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('removeFrontmatterKeys preserves mtime after removing keys', async () => {
      const { utimes, stat } = await import('node:fs/promises');
      const filePath = path.join(tmp, 'mtime-rm.md');
      await wf(
        filePath,
        '---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
        'utf8',
      );
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await utimes(filePath, oldTime, oldTime);
      const { mtimeMs: beforeMs } = await stat(filePath);
      await removeFrontmatterKeys(filePath, ['ccaudit-stale', 'ccaudit-flagged']);
      const { mtimeMs: afterMs } = await stat(filePath);
      expect(Math.abs(afterMs - beforeMs)).toBeLessThan(100);
    });
  });

  describe('mtime preservation: setFrontmatterValue', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(tmpdir(), 'mtime-set-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('setFrontmatterValue preserves mtime after updating a key', async () => {
      const { utimes, stat } = await import('node:fs/promises');
      const filePath = path.join(tmp, 'mtime-set.md');
      await wf(
        filePath,
        '---\nccaudit-stale: true\nccaudit-flagged: 2026-04-05T18:30:00Z\n---\n# body\n',
        'utf8',
      );
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await utimes(filePath, oldTime, oldTime);
      const { mtimeMs: beforeMs } = await stat(filePath);
      await setFrontmatterValue(filePath, 'ccaudit-flagged', '2026-04-14T00:00:00Z');
      const { mtimeMs: afterMs } = await stat(filePath);
      expect(Math.abs(afterMs - beforeMs)).toBeLessThan(100);
    });
  });
}
