/**
 * Phase 6 Plan 04: Pure render helpers for the MCP multi-config warning UX
 * in the tabbed picker.
 *
 * When an MCP server key is referenced by more than one config file (e.g.
 * `~/.claude.json` + a project-local `.mcp.json`), the scanner (plan 06-01)
 * attaches `configRefs: string[]` (length >= 1) to the item. This helper
 * surfaces that in the picker:
 *
 *   - `renderMcpWarningPrefix` prepends `⚠ ` (or `! ` in ASCII) to the row
 *     when `configRefs.length > 1` (D6-06). Otherwise empty string.
 *   - `alsoInHintLine` returns an `Also in: <paths>` hint for the shared
 *     below-cursor slot (D6-07 / D6-21). Truncates to `<first 2>, … (N more)`
 *     when `configRefs.length > 3`.
 *
 * Invariants:
 *   - Glyph ALWAYS accompanied by the text "Also in:" — never icon-alone
 *     (D6-21 accessibility rule).
 *   - Pure: no `@clack/core`, no `fs`, no `os`. configRefs paths are already
 *     compressed via `presentPath` upstream (plan 01) — this layer just
 *     formats, never rewrites.
 *   - Advisory only: caller must NOT use the predicate to gate selection.
 */

/**
 * Returns the warning glyph: `⚠` in Unicode mode, `!` in ASCII mode (D6-06).
 */
export function warningGlyph(ascii: boolean): string {
  return ascii ? '!' : '⚠';
}

/**
 * True when the item is an MCP server referenced by more than one config
 * file. Tolerant of partial shapes so callers can pass `GhostItem` or the
 * underlying `InventoryItem` interchangeably — both use `category` as the
 * discriminator field (Phase 6 Plan 04 bugfix: earlier revision keyed off
 * `kind` which neither canonical type exposes at runtime).
 */
export function isMultiConfig(item: {
  kind?: string;
  category?: string;
  configRefs?: string[];
}): boolean {
  const tag = item.category ?? item.kind;
  return tag === 'mcp-server' && Array.isArray(item.configRefs) && item.configRefs.length > 1;
}

/**
 * Row prefix `⚠ ` (or `! `) when multi-config, else empty string (D6-06).
 * Callers insert this between the selection checkbox and the item label
 * per CONTEXT discretion note: `[🔒]` / `[x]` / `⚠` / name.
 */
export function renderMcpWarningPrefix(item: unknown, opts: { ascii: boolean }): string {
  if (item === null || typeof item !== 'object') return '';
  if (!isMultiConfig(item as { kind?: string; configRefs?: string[] })) return '';
  return `${warningGlyph(opts.ascii)} `;
}

/**
 * Format the Also-in list per D6-07:
 *   - length 0 or 1 → null (caller skips hint; single-config items get no hint)
 *   - length 2 or 3 → "a, b" / "a, b, c"
 *   - length > 3    → "a, b, … (N more)" where N = length - 2
 *
 * Paths are emitted verbatim from the input — they were compressed via
 * `presentPath` upstream in plan 01 (no raw `$HOME` leak).
 */
export function formatAlsoIn(configRefs: string[]): string | null {
  if (configRefs.length <= 1) return null;
  if (configRefs.length <= 3) return configRefs.join(', ');
  const remaining = configRefs.length - 2;
  return `${configRefs[0]}, ${configRefs[1]}, … (${remaining} more)`;
}

/**
 * Full below-cursor hint line for a multi-config MCP row. Two leading
 * spaces match the indent used by `protectedHintLine` so the two hint
 * variants align visually in the shared slot. Returns `null` for non-MCP
 * or single-config items (caller falls through to the next hint branch).
 */
export function alsoInHintLine(item: unknown, opts: { ascii: boolean }): string | null {
  void opts.ascii;
  if (item === null || typeof item !== 'object') return null;
  const typed = item as { kind?: string; configRefs?: string[] };
  if (!isMultiConfig(typed)) return null;
  const refs = typed.configRefs as string[];
  const formatted = formatAlsoIn(refs);
  if (formatted === null) return null;
  return `  Also in: ${formatted}`;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('warningGlyph', () => {
    it('returns Unicode glyph when ascii=false', () => {
      expect(warningGlyph(false)).toBe('⚠');
    });

    it('returns ASCII fallback when ascii=true', () => {
      expect(warningGlyph(true)).toBe('!');
    });
  });

  describe('isMultiConfig', () => {
    it('returns false for non-MCP item', () => {
      expect(isMultiConfig({ kind: 'agent', configRefs: ['a', 'b'] })).toBe(false);
    });

    it('returns false for MCP with single config', () => {
      expect(isMultiConfig({ kind: 'mcp-server', configRefs: ['~/.claude.json'] })).toBe(false);
    });

    it('returns false for MCP with no configRefs', () => {
      expect(isMultiConfig({ kind: 'mcp-server' })).toBe(false);
    });

    it('returns true for MCP with 2 configRefs', () => {
      expect(isMultiConfig({ kind: 'mcp-server', configRefs: ['a', 'b'] })).toBe(true);
    });

    it('returns true for MCP with 5 configRefs', () => {
      expect(isMultiConfig({ kind: 'mcp-server', configRefs: ['a', 'b', 'c', 'd', 'e'] })).toBe(
        true,
      );
    });

    it('accepts InventoryItem-shaped input via `category` (bugfix 06-05)', () => {
      // InventoryItem uses `category`, not `kind`. The picker passes
      // `row.item.item` (an InventoryItem) to renderMcpWarningPrefix, so
      // this branch MUST work end-to-end.
      expect(isMultiConfig({ category: 'mcp-server', configRefs: ['a', 'b'] })).toBe(true);
      expect(isMultiConfig({ category: 'agent', configRefs: ['a', 'b'] })).toBe(false);
    });
  });

  describe('renderMcpWarningPrefix', () => {
    it('returns empty string for single-config MCP', () => {
      expect(
        renderMcpWarningPrefix(
          { kind: 'mcp-server', configRefs: ['~/.claude.json'] },
          { ascii: false },
        ),
      ).toBe('');
    });

    it('returns "⚠ " for multi-config MCP in Unicode mode', () => {
      expect(
        renderMcpWarningPrefix({ kind: 'mcp-server', configRefs: ['a', 'b'] }, { ascii: false }),
      ).toBe('⚠ ');
    });

    it('returns "! " for multi-config MCP in ASCII mode', () => {
      expect(
        renderMcpWarningPrefix({ kind: 'mcp-server', configRefs: ['a', 'b'] }, { ascii: true }),
      ).toBe('! ');
    });

    it('returns empty string for non-object input', () => {
      expect(renderMcpWarningPrefix(null, { ascii: false })).toBe('');
      expect(renderMcpWarningPrefix(undefined, { ascii: false })).toBe('');
    });

    it('returns empty string for non-MCP item even with configRefs', () => {
      expect(
        renderMcpWarningPrefix({ kind: 'agent', configRefs: ['a', 'b'] }, { ascii: false }),
      ).toBe('');
    });
  });

  describe('formatAlsoIn', () => {
    it('returns null for empty list', () => {
      expect(formatAlsoIn([])).toBe(null);
    });

    it('returns null for single-config list', () => {
      expect(formatAlsoIn(['~/.claude.json'])).toBe(null);
    });

    it('joins 2 refs with comma+space', () => {
      expect(formatAlsoIn(['~/.claude.json', '.mcp.json'])).toBe('~/.claude.json, .mcp.json');
    });

    it('joins 3 refs with comma+space (no truncation at boundary)', () => {
      expect(formatAlsoIn(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('truncates at length 4 → "(2 more)"', () => {
      expect(formatAlsoIn(['a', 'b', 'c', 'd'])).toBe('a, b, … (2 more)');
    });

    it('truncates at length 5 → "(3 more)"', () => {
      expect(formatAlsoIn(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, … (3 more)');
    });

    it('truncates at length 10 → "(8 more)"', () => {
      expect(formatAlsoIn(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])).toBe(
        'a, b, … (8 more)',
      );
    });
  });

  describe('alsoInHintLine', () => {
    it('returns null for non-MCP item', () => {
      expect(alsoInHintLine({ kind: 'agent', configRefs: ['a', 'b'] }, { ascii: false })).toBe(
        null,
      );
    });

    it('returns null for single-config MCP', () => {
      expect(
        alsoInHintLine({ kind: 'mcp-server', configRefs: ['~/.claude.json'] }, { ascii: false }),
      ).toBe(null);
    });

    it('returns null for MCP without configRefs', () => {
      expect(alsoInHintLine({ kind: 'mcp-server' }, { ascii: false })).toBe(null);
    });

    it('returns null for non-object input', () => {
      expect(alsoInHintLine(null, { ascii: false })).toBe(null);
      expect(alsoInHintLine(42, { ascii: false })).toBe(null);
    });

    it('formats 2-config MCP with 2-space indent matching protection hint', () => {
      expect(
        alsoInHintLine(
          { kind: 'mcp-server', configRefs: ['~/.claude.json', '.mcp.json'] },
          { ascii: false },
        ),
      ).toBe('  Also in: ~/.claude.json, .mcp.json');
    });

    it('formats 3-config MCP without truncation', () => {
      expect(
        alsoInHintLine({ kind: 'mcp-server', configRefs: ['a', 'b', 'c'] }, { ascii: false }),
      ).toBe('  Also in: a, b, c');
    });

    it('truncates 5-config MCP hint to "(3 more)"', () => {
      expect(
        alsoInHintLine(
          { kind: 'mcp-server', configRefs: ['a', 'b', 'c', 'd', 'e'] },
          { ascii: false },
        ),
      ).toBe('  Also in: a, b, … (3 more)');
    });

    it('"Also in:" text present regardless of ascii mode (D6-21)', () => {
      const item = { kind: 'mcp-server', configRefs: ['a', 'b'] };
      expect(alsoInHintLine(item, { ascii: true })).toContain('Also in:');
      expect(alsoInHintLine(item, { ascii: false })).toContain('Also in:');
    });
  });
}
