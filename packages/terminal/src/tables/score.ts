import pc from 'picocolors';
import type { HealthScore } from '@ccaudit/internal';

/**
 * Render the health score line with color by grade.
 *
 * Format: `Health: {score}/100 ({grade})`
 *
 * Colors (per UI-SPEC):
 *   - Healthy (>=80): green + bold
 *   - Fair (>=50): yellow + bold
 *   - Poor (>=20): red + bold
 *   - Critical (<20): red + bold
 */
export function renderHealthScore(health: HealthScore): string {
  const label = `Health: ${health.score}/100 (${health.grade})`;

  switch (health.grade) {
    case 'Healthy':
      return pc.green(pc.bold(label));
    case 'Fair':
      return pc.yellow(pc.bold(label));
    case 'Poor':
      return pc.red(pc.bold(label));
    case 'Critical':
      return pc.red(pc.bold(label));
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('renderHealthScore', () => {
    it('renders score 85 with Healthy grade', () => {
      const result = renderHealthScore({
        score: 85,
        grade: 'Healthy',
        ghostPenalty: 15,
        tokenPenalty: 0,
      });
      expect(result).toContain('Health: 85/100');
      expect(result).toContain('Healthy');
    });

    it('renders score 42 with Poor grade', () => {
      const result = renderHealthScore({
        score: 42,
        grade: 'Poor',
        ghostPenalty: 48,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health: 42/100');
      expect(result).toContain('Poor');
    });

    it('renders score 60 with Fair grade', () => {
      const result = renderHealthScore({
        score: 60,
        grade: 'Fair',
        ghostPenalty: 30,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health: 60/100');
      expect(result).toContain('Fair');
    });

    it('renders score 10 with Critical grade', () => {
      const result = renderHealthScore({
        score: 10,
        grade: 'Critical',
        ghostPenalty: 80,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health: 10/100');
      expect(result).toContain('Critical');
    });

    it('output contains /100 format', () => {
      const result = renderHealthScore({
        score: 100,
        grade: 'Healthy',
        ghostPenalty: 0,
        tokenPenalty: 0,
      });
      expect(result).toContain('/100');
    });
  });
}
