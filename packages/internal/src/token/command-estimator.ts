/**
 * Evidence-based token estimator for Claude Code slash commands.
 *
 * Commands use the same lazy-loading model as skills — Claude Code reads
 * only the command description when deciding whether to invoke it.
 * The full file content is NOT injected unless the command is triggered.
 *
 * Formula:
 *   - description present  → 15 + ceil(min(desc.length, 250) / 4)  (lazy: description truncated)
 *   - fileSize known       → min(ceil(fileSize / 4), 500)           (fallback: cap at ~2KB)
 *   - else                 → null
 */

import type { ParsedFrontmatter } from './frontmatter.ts';

export interface CommandEstimateResult {
  tokens: number;
  formula: 'lazy' | 'fallback-filesize';
  descriptionChars: number;
}

/** Maximum description characters to include in command token estimate. */
const MAX_DESCRIPTION_CHARS = 250;

/** Per-command base overhead (invocation metadata, name, etc.). */
const COMMAND_BASE_TOKENS = 15;

/** Fallback cap when falling back to file-size heuristic. */
const COMMAND_FILESIZE_CAP = 500;

/** Bytes per token heuristic (shared with file-size-estimator). */
const BYTES_PER_TOKEN = 4;

export function estimateCommandTokens(
  fm: ParsedFrontmatter | null,
  fileSize: number | null,
): CommandEstimateResult | null {
  // lazy: description present — truncate to 250 chars for the index entry
  if (fm?.description) {
    const descChars = Math.min(fm.description.length, MAX_DESCRIPTION_CHARS);
    const tokens = COMMAND_BASE_TOKENS + Math.ceil(descChars / BYTES_PER_TOKEN);
    return { tokens, formula: 'lazy', descriptionChars: descChars };
  }

  // fallback: use file size, capped at 500 tokens
  if (fileSize != null) {
    const tokens = Math.min(Math.ceil(fileSize / BYTES_PER_TOKEN), COMMAND_FILESIZE_CAP);
    return { tokens, formula: 'fallback-filesize', descriptionChars: 0 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// In-source vitest
// ---------------------------------------------------------------------------
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const BASE_FM: ParsedFrontmatter = {
    name: 'test',
    description: null,
    disableModelInvocation: false,
    userInvocable: true,
    tools: null,
    model: null,
  };

  describe('estimateCommandTokens', () => {
    it('lazy branch → 15 + ceil(desc.length / 4)', () => {
      const desc = 'A'.repeat(100); // 100 chars → 25 tokens → 15 + 25 = 40
      const result = estimateCommandTokens({ ...BASE_FM, description: desc }, null);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(40);
      expect(result!.formula).toBe('lazy');
      expect(result!.descriptionChars).toBe(100);
    });

    it('lazy branch: description truncated at 250 chars', () => {
      const desc = 'X'.repeat(500); // 500 chars → truncated to 250 → ceil(250/4)=63 → 15+63=78
      const result = estimateCommandTokens({ ...BASE_FM, description: desc }, null);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(78);
      expect(result!.descriptionChars).toBe(250);
      expect(result!.formula).toBe('lazy');
    });

    it('fallback-filesize branch → min(ceil(fileSize/4), 500)', () => {
      const result = estimateCommandTokens(null, 800); // 800/4=200 → well under cap
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(200);
      expect(result!.formula).toBe('fallback-filesize');
      expect(result!.descriptionChars).toBe(0);
    });

    it('fallback-filesize branch: cap at 500 tokens', () => {
      const result = estimateCommandTokens(null, 4000); // 4000/4=1000 → capped at 500
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(500);
      expect(result!.formula).toBe('fallback-filesize');
    });

    it('null when fm=null and fileSize=null', () => {
      const result = estimateCommandTokens(null, null);
      expect(result).toBeNull();
    });

    it('null fm (no description) with 0-byte file → 0 tokens (not null)', () => {
      const result = estimateCommandTokens(null, 0); // ceil(0/4)=0, min(0,500)=0
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(0);
      expect(result!.formula).toBe('fallback-filesize');
    });

    it('exact 250-char description → no truncation', () => {
      const desc = 'B'.repeat(250);
      const result = estimateCommandTokens({ ...BASE_FM, description: desc }, null);
      expect(result!.descriptionChars).toBe(250);
      expect(result!.tokens).toBe(15 + Math.ceil(250 / 4)); // 15 + 63 = 78
    });
  });
}
