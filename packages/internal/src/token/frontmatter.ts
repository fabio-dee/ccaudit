/**
 * Zero-dependency YAML frontmatter parser for Claude Code config files.
 *
 * Intentional non-goals (documented here to explain what is NOT supported):
 * - YAML anchors/aliases, merge keys (`<<:`), tags (`!!str`)
 * - YAML 1.1 boolean zoo (`yes`/`no`/`on`/`off` — zero occurrences in 435 real files)
 * - Nested maps as values
 * - Multi-document streams
 * - Full numeric-type coercion (only strings/bools/lists of strings for our 6 keys)
 *
 * Note on `allowed-tools` vs `tools`:
 *   Real Claude Code configs use EITHER `tools` (agents) OR `allowed-tools` (skills/commands).
 *   For Phase 1 scope (agents + skills), both are mapped to the same `tools` field.
 */

import { readFile } from 'node:fs/promises';

export interface ParsedFrontmatter {
  name: string | null;
  description: string | null;
  /** Defaults to false when absent. YAML key: `disable-model-invocation`. */
  disableModelInvocation: boolean;
  /** Defaults to true when absent. YAML key: `user-invocable`. */
  userInvocable: boolean;
  tools: string[] | null;
  model: string | null;
}

/** Strip surrounding single or double quotes from a value if they wrap the entire string. */
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Parse a tools/allowed-tools value into a string[].
 *  Priority: flow-sequence → bare comma → single token.
 */
function parseToolsValue(
  value: string,
  remainingLines: string[],
  startIndex: number,
): {
  tools: string[];
  consumedCount: number;
} {
  // Block sequence: empty value + following indented "- item" lines
  if (value === '') {
    const tools: string[] = [];
    let consumed = 0;
    for (let i = startIndex; i < remainingLines.length; i++) {
      const line = remainingLines[i];
      const match = line.match(/^\s{2,}- (.+)$/);
      if (match) {
        tools.push(match[1].trim());
        consumed++;
      } else if (line.trim() === '' || line.match(/^\s*#/)) {
        // skip blank/comment continuation
        consumed++;
      } else {
        break;
      }
    }
    return { tools, consumedCount: consumed };
  }

  // Flow sequence: [A, B, C] or ["A", "B"]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return { tools: [], consumedCount: 0 };
    const items = inner.split(/\s*,\s*/).map((t) => stripWrappingQuotes(t.trim()));
    return { tools: items, consumedCount: 0 };
  }

  // Bare comma-separated list
  if (value.includes(',')) {
    const items = value
      .split(/\s*,\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
    return { tools: items, consumedCount: 0 };
  }

  // Single token
  return { tools: [value.trim()], consumedCount: 0 };
}

/** Collect folded scalar lines (lines with indent > 0) and join with spaces. */
function collectFoldedScalar(
  lines: string[],
  startIndex: number,
): {
  value: string;
  consumedCount: number;
} {
  const parts: string[] = [];
  let consumed = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    // A folded continuation line has at least one leading space/tab
    if (line.match(/^[ \t]+\S/)) {
      parts.push(line.trim());
      consumed++;
    } else if (line.trim() === '') {
      consumed++;
    } else {
      break;
    }
  }
  return { value: parts.join(' '), consumedCount: consumed };
}

/**
 * Parse the YAML frontmatter block of a Claude Code config file.
 *
 * Returns null if:
 * - The file cannot be read
 * - The file does not start with `---\n` or `---\r\n` (no frontmatter)
 * - The opening fence has no matching closing fence
 */
export async function parseFrontmatter(filePath: string): Promise<ParsedFrontmatter | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  // Strip UTF-8 BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  // Must start with --- fence
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return null;
  }

  // Find closing fence (must be on its own line)
  const closeLFIndex = content.indexOf('\n---', 3);
  if (closeLFIndex === -1) {
    return null;
  }

  // Extract the block between the two fences (after opening `---\n`)
  const blockStart = content.startsWith('---\r\n') ? 5 : 4;
  const blockEnd = closeLFIndex; // up to the \n before closing ---
  const block = content.slice(blockStart, blockEnd);

  // Split into lines, normalise CRLF → LF
  const rawLines = block.split(/\r?\n/);

  // Working state
  let name: string | null = null;
  let description: string | null = null;
  let disableModelInvocationRaw: boolean | null = null;
  let userInvocableRaw: boolean | null = null;
  let tools: string[] | null = null;
  let model: string | null = null;

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];

    // Skip blank lines and full-line comments
    if (line.trim() === '' || line.match(/^\s*#/)) {
      i++;
      continue;
    }

    // Split on first `: ` (colon-space) — handles tool args like Bash(cmd:*) correctly
    const colonSpaceIdx = line.indexOf(': ');
    if (colonSpaceIdx === -1) {
      // No `: ` — could be a key with empty value (`tools:` with no trailing space)
      // Check for key with no value (line ends with `:`)
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(':')) {
        const key = trimmed.slice(0, -1).trim().toLowerCase();
        if (key === 'tools' || key === 'allowed-tools') {
          i++;
          const { tools: parsed, consumedCount } = parseToolsValue('', rawLines, i);
          tools = parsed.length > 0 ? parsed : null;
          i += consumedCount;
        } else {
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    const key = line.slice(0, colonSpaceIdx).trim().toLowerCase();
    const rawValue = line.slice(colonSpaceIdx + 2); // everything after `: `

    i++;

    switch (key) {
      case 'name':
        name = stripWrappingQuotes(rawValue.trim()) || null;
        break;

      case 'description': {
        const trimmedVal = rawValue.trim();
        if (trimmedVal === '>') {
          const { value, consumedCount } = collectFoldedScalar(rawLines, i);
          description = value || null;
          i += consumedCount;
        } else if (trimmedVal === '|') {
          // Literal block scalar — return null (caller falls back to filesize)
          description = null;
          // Skip the continuation lines
          while (i < rawLines.length && rawLines[i].match(/^[ \t]+/)) {
            i++;
          }
        } else {
          description = stripWrappingQuotes(trimmedVal) || null;
        }
        break;
      }

      case 'model':
        model = stripWrappingQuotes(rawValue.trim()) || null;
        break;

      case 'tools':
      case 'allowed-tools': {
        const trimmedVal = rawValue.trim();
        const { tools: parsed, consumedCount } = parseToolsValue(trimmedVal, rawLines, i);
        tools = parsed.length > 0 ? parsed : null;
        i += consumedCount;
        break;
      }

      case 'disable-model-invocation': {
        // Strip trailing inline comment before bool coerce
        const boolVal = rawValue
          .trim()
          .replace(/\s+#.*$/, '')
          .trim();
        if (/^(true|True|TRUE)$/.test(boolVal)) {
          disableModelInvocationRaw = true;
        } else if (/^(false|False|FALSE)$/.test(boolVal)) {
          disableModelInvocationRaw = false;
        }
        // else omit — leave caller to apply default
        break;
      }

      case 'user-invocable': {
        const boolVal = rawValue
          .trim()
          .replace(/\s+#.*$/, '')
          .trim();
        if (/^(true|True|TRUE)$/.test(boolVal)) {
          userInvocableRaw = true;
        } else if (/^(false|False|FALSE)$/.test(boolVal)) {
          userInvocableRaw = false;
        }
        break;
      }

      default:
        // Unknown keys silently dropped
        break;
    }
  }

  return {
    name,
    description,
    disableModelInvocation: disableModelInvocationRaw ?? false,
    userInvocable: userInvocableRaw ?? true,
    tools,
    model,
  };
}

// ---------------------------------------------------------------------------
// In-source vitest fixtures
// ---------------------------------------------------------------------------
if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let tmpDir: string;

  async function writeFixture(name: string, content: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  describe('parseFrontmatter', () => {
    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'fm-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('quoted description with em-dash + commas + parens preserved', async () => {
      const fp = await writeFixture(
        'a.md',
        '---\ndescription: "5 font sizes declared (14, 16, 18, 20, 28) — max 4 allowed"\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.description).toBe(
        '5 font sizes declared (14, 16, 18, 20, 28) — max 4 allowed',
      );
    });

    it('bare comma tools → 8-item array', async () => {
      const fp = await writeFixture(
        'b.md',
        '---\ntools: Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.tools).toHaveLength(8);
      expect(result!.tools).toContain('mcp__context7__*');
    });

    it('flow-sequence tools → 3-item array, bare tokens', async () => {
      const fp = await writeFixture('c.md', '---\ntools: [Read, Grep, Glob]\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.tools).toEqual(['Read', 'Grep', 'Glob']);
    });

    it('JSON-quoted flow sequence allowed-tools → quotes stripped', async () => {
      const fp = await writeFixture('d.md', '---\nallowed-tools: ["Read", "Write", "Grep"]\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.tools).toEqual(['Read', 'Write', 'Grep']);
    });

    it('tool-arg colons (Bash(gh pr view:*)) → 2 items, colon preserved', async () => {
      const fp = await writeFixture(
        'e.md',
        '---\nallowed-tools: Bash(gh pr view:*), Bash(gh issue list:*)\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.tools).toHaveLength(2);
      expect(result!.tools![0]).toBe('Bash(gh pr view:*)');
      expect(result!.tools![1]).toBe('Bash(gh issue list:*)');
    });

    it('block sequence tools → 3-item array', async () => {
      const fp = await writeFixture('f.md', '---\ntools:\n  - Read\n  - Write\n  - Edit\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.tools).toEqual(['Read', 'Write', 'Edit']);
    });

    it('bool with trailing comment → disableModelInvocation: true', async () => {
      const fp = await writeFixture(
        'g.md',
        '---\ndisable-model-invocation: true  # Only user can invoke\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.disableModelInvocation).toBe(true);
    });

    it('folded > description → concatenated single-spaced string', async () => {
      const fp = await writeFixture(
        'h.md',
        '---\ndescription: >\n  Line one\n  line two\n  line three\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.description).toBe('Line one line two line three');
    });

    it('literal | description → null (caller falls back to filesize)', async () => {
      const fp = await writeFixture(
        'i.md',
        '---\ndescription: |\n  some multiline\n  content\n---\n',
      );
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.description).toBeNull();
    });

    it('Title Case name preserved', async () => {
      const fp = await writeFixture('j.md', '---\nname: Content Creator\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Content Creator');
    });

    it('unknown keys silently dropped, known keys intact', async () => {
      const fp = await writeFixture('k.md', '---\ncolor: "#10B981"\nemoji: 🚀\nname: foo\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('foo');
      // No color or emoji on the result object
      expect(Object.keys(result!)).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'disableModelInvocation',
          'userInvocable',
          'tools',
          'model',
        ]),
      );
      expect(Object.keys(result!)).toHaveLength(6);
    });

    it('no frontmatter → null', async () => {
      const fp = await writeFixture('l.md', '# Just a heading\nNo frontmatter here.\n');
      const result = await parseFrontmatter(fp);
      expect(result).toBeNull();
    });

    it('opening --- without closing fence → null', async () => {
      const fp = await writeFixture('m.md', '---\nname: foo\n# no closing fence\n');
      const result = await parseFrontmatter(fp);
      expect(result).toBeNull();
    });

    it('CRLF defensive: \\r\\n separators parse identically to LF', async () => {
      const content = '---\r\nname: crlf-test\r\ntools: Read, Write\r\n---\r\n';
      const fp = await writeFixture('n.md', content);
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('crlf-test');
      expect(result!.tools).toEqual(['Read', 'Write']);
    });

    it('BOM defensive: \\ufeff prefix parsed correctly', async () => {
      const content = '\ufeff---\nname: bom-test\n---\n';
      const fp = await writeFixture('o.md', content);
      // Must write raw bytes — writeFile will encode the BOM correctly in utf8
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('bom-test');
    });

    it('missing user-invocable → default true', async () => {
      const fp = await writeFixture('p.md', '---\nname: no-invocable\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.userInvocable).toBe(true);
    });

    it('missing disable-model-invocation → default false', async () => {
      const fp = await writeFixture('q.md', '---\nname: no-disable\n---\n');
      const result = await parseFrontmatter(fp);
      expect(result).not.toBeNull();
      expect(result!.disableModelInvocation).toBe(false);
    });

    it('unreadable file path → null', async () => {
      const result = await parseFrontmatter('/definitely/does/not/exist/file.md');
      expect(result).toBeNull();
    });
  });
}
