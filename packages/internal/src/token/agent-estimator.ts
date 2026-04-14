/**
 * Evidence-based token estimator for Claude Code agents.
 *
 * Agents are "eager" — when Claude Code builds its agent registry at session start,
 * it includes the agent's full description in the Task schema injection. This is in
 * contrast to skills, which are lazy (only description summary used).
 *
 * Formula:
 *   - description present  → 30 + ceil(desc.length / 4)   (NO cap — full desc enters Task schema)
 *   - name present only    → 100 tokens                    (Agent-Registry baseline: name + slot overhead)
 *   - fileSize known       → min(ceil(fileSize / 4), 500)  (defensive fallback cap)
 *   - else                 → null
 */

import type { ParsedFrontmatter } from './frontmatter.ts';

export interface AgentEstimateResult {
  tokens: number;
  formula: 'eager-with-desc' | 'eager-no-desc' | 'fallback-filesize';
  descriptionChars: number;
}

/** Per-agent base overhead for the Task schema entry (name + schema overhead). */
const AGENT_BASE_TOKENS = 30;

/** Baseline token cost when an agent has a name but no description in frontmatter. */
const AGENT_REGISTRY_BASELINE = 100;

/** Defensive cap when falling back to file-size heuristic. */
const AGENT_FILESIZE_CAP = 500;

/** Bytes per token heuristic (shared with file-size-estimator). */
const BYTES_PER_TOKEN = 4;

export function estimateAgentTokens(
  fm: ParsedFrontmatter | null,
  fileSize: number | null,
): AgentEstimateResult | null {
  // eager-with-desc: full description enters Task schema — no truncation
  if (fm?.description) {
    const tokens = AGENT_BASE_TOKENS + Math.ceil(fm.description.length / BYTES_PER_TOKEN);
    return { tokens, formula: 'eager-with-desc', descriptionChars: fm.description.length };
  }

  // eager-no-desc: name present but no description — use registry baseline
  if (fm?.name) {
    return { tokens: AGENT_REGISTRY_BASELINE, formula: 'eager-no-desc', descriptionChars: 0 };
  }

  // fallback: use file size with defensive cap
  if (fileSize != null) {
    const tokens = Math.min(Math.ceil(fileSize / BYTES_PER_TOKEN), AGENT_FILESIZE_CAP);
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
    name: null,
    description: null,
    disableModelInvocation: false,
    userInvocable: true,
    tools: null,
    model: null,
  };

  describe('estimateAgentTokens', () => {
    it('eager-with-desc → 30 + ceil(desc.length / 4)', () => {
      const desc = 'A'.repeat(200); // 200 chars → 50 tokens → 30+50=80
      const result = estimateAgentTokens({ ...BASE_FM, name: 'test', description: desc }, null);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(80);
      expect(result!.formula).toBe('eager-with-desc');
      expect(result!.descriptionChars).toBe(200);
    });

    it('eager-with-desc: long description not truncated', () => {
      const desc = 'B'.repeat(2000); // 2000 chars → 500 tokens → 30+500=530 (no cap)
      const result = estimateAgentTokens({ ...BASE_FM, name: 'big', description: desc }, null);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(530);
      expect(result!.descriptionChars).toBe(2000);
    });

    it('eager-no-desc → 100 tokens baseline', () => {
      const result = estimateAgentTokens({ ...BASE_FM, name: 'my-agent' }, null);
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(100);
      expect(result!.formula).toBe('eager-no-desc');
      expect(result!.descriptionChars).toBe(0);
    });

    it('fallback-filesize → min(ceil(fileSize/4), 500)', () => {
      const result = estimateAgentTokens(null, 800); // 800/4=200
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(200);
      expect(result!.formula).toBe('fallback-filesize');
    });

    it('fallback-filesize: cap at 500 tokens', () => {
      const result = estimateAgentTokens(null, 4000); // 4000/4=1000 → capped
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(500);
    });

    it('null when fm=null and fileSize=null', () => {
      const result = estimateAgentTokens(null, null);
      expect(result).toBeNull();
    });
  });
}
