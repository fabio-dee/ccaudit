import * as v from 'valibot';
import { registrySchema } from './types.ts';
import type { Framework } from './types.ts';

/**
 * Curated framework registry — the Tier 1 source of truth for framework detection.
 *
 * Declaration order is AUTHORITATIVE (D-04 first-match-wins). Do not reorder
 * without updating the test that asserts this order. Items with overlapping
 * signals are resolved by putting the more specific / higher-priority entry
 * earlier in the array.
 *
 * Validated at module-init via `v.safeParse(registrySchema, ...)`. A malformed
 * entry throws a clear error naming the offending entry's `id` (REG-04).
 */
const RAW_KNOWN_FRAMEWORKS: Framework[] = [
  {
    id: 'gsd',
    displayName: 'GSD (Get Shit Done)',
    description: 'Spec-driven development with atomic phases and fresh sub-agent contexts.',
    prefixes: ['gsd-', 'gsd:'],
    folders: ['gsd'],
    categories: ['agent', 'skill', 'command'],
    source: 'https://github.com/gsd-build/get-shit-done',
    source_type: 'curated',
  },
  {
    id: 'superclaude',
    displayName: 'SuperClaude',
    description: 'Configuration framework with slash commands and specialist personas.',
    prefixes: ['sc:', 'sc-'],
    folders: ['sc', 'superclaude'],
    categories: ['agent', 'skill', 'command'],
    source: 'https://github.com/SuperClaude-Org/SuperClaude_Framework',
    source_type: 'curated',
  },
  {
    id: 'nwave',
    displayName: 'nWave',
    description: 'Seven-wave framework with specialized agents and quality gates.',
    prefixes: ['nwave-', 'nwave:'],
    folders: ['nwave'],
    categories: ['agent', 'skill'],
    source: 'https://github.com/nWave-ai/nWave',
    source_type: 'curated',
  },
  {
    id: 'superpowers',
    displayName: 'Anthropic Superpowers',
    description: 'Official Anthropic skills bundle for structured development workflows.',
    prefixes: ['superpowers:', 'superpowers-'],
    folders: ['superpowers'],
    categories: ['skill'],
    source: 'https://github.com/anthropics/skills',
    source_type: 'curated',
  },
  {
    id: 'ralph-loop',
    displayName: 'Ralph Loop',
    description: 'Autonomous iteration loop for plan execution.',
    prefixes: ['ralph:', 'ralph-'],
    folders: ['ralph'],
    categories: ['agent', 'skill', 'command'],
    source: 'https://github.com/anthropics/claude-code',
    source_type: 'curated',
  },
  {
    id: 'agent-council',
    displayName: 'Agent Council',
    description: 'Multi-model deliberation and consensus framework.',
    prefixes: ['council:', 'council-'],
    folders: ['council'],
    categories: ['agent', 'skill', 'command'],
    source: 'https://github.com/yogirk/agent-council',
    source_type: 'curated',
  },
  {
    id: 'greg-strategy',
    displayName: 'Greg Strategy',
    description: 'Greg Isenberg-style strategic advisory commands.',
    prefixes: ['greg:', 'greg-'],
    folders: ['greg'],
    categories: ['agent', 'skill', 'command'],
    source: 'unverified',
    source_type: 'curated',
  },
  {
    id: 'ideabrowser',
    displayName: 'IdeaBrowser',
    description: 'Idea discovery and scraping commands.',
    prefixes: ['ideabrowser:', 'ideabrowser-'],
    folders: ['ideabrowser'],
    categories: ['skill', 'command'],
    source: 'unverified',
    source_type: 'curated',
  },
  {
    id: 'gstack',
    displayName: 'gstack',
    description: "Garry Tan's curated skill pack: specialists and power tools.",
    prefixes: [],
    folders: ['gstack'],
    knownItems: [
      'office-hours',
      'plan-ceo-review',
      'plan-eng-review',
      'review',
      'design-html',
      'qa',
      'ship',
      'land-and-deploy',
      'cso',
      'browse',
      'retro',
      'careful',
      'freeze',
      'guard',
    ],
    categories: ['skill'],
    source: 'https://github.com/garrytan/gstack',
    source_type: 'curated',
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    description: 'NousResearch integration layer for Claude Code.',
    prefixes: ['hermes:', 'hermes-'],
    folders: ['hermes'],
    categories: ['skill'],
    source: 'https://github.com/NousResearch/hermes-agent',
    source_type: 'curated',
  },
];

/** Validated at module load — throws with offending entry id on failure (REG-04). */
export const KNOWN_FRAMEWORKS: Framework[] = (() => {
  const result = v.safeParse(registrySchema, RAW_KNOWN_FRAMEWORKS);
  if (!result.success) {
    const firstIssue = result.issues[0];
    const arrayEntry = firstIssue?.path?.find((p) => p.type === 'array');
    const idx = arrayEntry?.key as number | undefined;
    const offendingId =
      idx !== undefined && idx >= 0 && idx < RAW_KNOWN_FRAMEWORKS.length
        ? RAW_KNOWN_FRAMEWORKS[idx]?.id
        : undefined;
    throw new Error(
      `Known frameworks registry is malformed (entry id: "${offendingId ?? 'UNKNOWN'}"): ${firstIssue?.message ?? 'unknown validation error'}`,
    );
  }
  return result.output;
})();

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('KNOWN_FRAMEWORKS', () => {
    it('contains exactly 10 curated entries (REG-02)', () => {
      expect(KNOWN_FRAMEWORKS).toHaveLength(10);
    });

    it('is ordered per D-04 first-match-wins: gsd, superclaude, nwave, superpowers, ralph-loop, agent-council, greg-strategy, ideabrowser, gstack, hermes', () => {
      expect(KNOWN_FRAMEWORKS.map((f) => f.id)).toEqual([
        'gsd',
        'superclaude',
        'nwave',
        'superpowers',
        'ralph-loop',
        'agent-council',
        'greg-strategy',
        'ideabrowser',
        'gstack',
        'hermes',
      ]);
    });

    it('every entry has source_type === curated (heuristic is set only in DetectResult)', () => {
      for (const fw of KNOWN_FRAMEWORKS) {
        expect(fw.source_type).toBe('curated');
      }
    });

    it('gsd entry has prefixes gsd- and gsd: and folder gsd', () => {
      const gsd = KNOWN_FRAMEWORKS.find((f) => f.id === 'gsd');
      expect(gsd).toBeDefined();
      expect(gsd!.prefixes).toEqual(['gsd-', 'gsd:']);
      expect(gsd!.folders).toEqual(['gsd']);
    });

    it('superclaude entry has prefixes sc: and sc- and folders sc + superclaude', () => {
      const sc = KNOWN_FRAMEWORKS.find((f) => f.id === 'superclaude');
      expect(sc).toBeDefined();
      expect(sc!.prefixes).toContain('sc:');
      expect(sc!.prefixes).toContain('sc-');
      expect(sc!.folders).toContain('sc');
      expect(sc!.folders).toContain('superclaude');
    });

    it('gstack entry has empty prefixes and >= 14 knownItems (REG-03 prefix-less detection)', () => {
      const gstack = KNOWN_FRAMEWORKS.find((f) => f.id === 'gstack');
      expect(gstack).toBeDefined();
      expect(gstack!.prefixes).toEqual([]);
      expect(gstack!.knownItems).toBeDefined();
      expect(gstack!.knownItems!.length).toBeGreaterThanOrEqual(14);
      expect(gstack!.knownItems).toContain('office-hours');
      expect(gstack!.knownItems).toContain('plan-ceo-review');
    });

    it('hermes entry exists and is the 10th (tail) entry', () => {
      expect(KNOWN_FRAMEWORKS[9]?.id).toBe('hermes');
    });
  });

  describe('Module-init validation (REG-04)', () => {
    it('a malformed entry produces an error naming the offending id', () => {
      // Directly exercise the validation branch with a bad array.
      const BAD = [
        {
          id: 'bad-entry',
          displayName: 'Bad',
          description: 'missing required fields',
          // prefixes intentionally missing to trigger validation error
        },
      ];
      const result = v.safeParse(registrySchema, BAD);
      expect(result.success).toBe(false);
      if (!result.success) {
        const firstIssue = result.issues[0];
        const arrayEntry = firstIssue?.path?.find((p) => p.type === 'array');
        const idx = arrayEntry?.key as number | undefined;
        const offendingId = idx !== undefined ? (BAD[idx] as { id: string })?.id : undefined;
        expect(offendingId).toBe('bad-entry');
      }
    });
  });
}
