import { colorize } from '../color.ts';
import type { HealthGrade, HealthScore } from '@ccaudit/internal';

/**
 * Return the letter grade for a given HealthGrade.
 *
 * Healthy → A+, Fair → B, Poor → D, Critical → F
 */
export function letterForGrade(grade: HealthGrade): string {
  switch (grade) {
    case 'Healthy':
      return 'A+';
    case 'Fair':
      return 'B';
    case 'Poor':
      return 'D';
    case 'Critical':
      return 'F';
  }
}

/**
 * Render the health score line with color by grade.
 *
 * Format: `Health: {letter} ({grade})`
 *
 * Colors (per UI-SPEC):
 *   - Healthy (>=80): green + bold
 *   - Fair (>=50): yellow + bold
 *   - Poor (>=20): red + bold
 *   - Critical (<20): red + bold
 */
export function renderHealthScore(health: HealthScore): string {
  const letter = letterForGrade(health.grade);
  const label = `Health grade: ${letter} (${health.grade})`;

  switch (health.grade) {
    case 'Healthy':
      return colorize.green(colorize.bold(label));
    case 'Fair':
      return colorize.yellow(colorize.bold(label));
    case 'Poor':
      return colorize.red(colorize.bold(label));
    case 'Critical':
      return colorize.red(colorize.bold(label));
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('letterForGrade', () => {
    it('returns A+ for Healthy', () => {
      expect(letterForGrade('Healthy')).toBe('A+');
    });

    it('returns B for Fair', () => {
      expect(letterForGrade('Fair')).toBe('B');
    });

    it('returns D for Poor', () => {
      expect(letterForGrade('Poor')).toBe('D');
    });

    it('returns F for Critical', () => {
      expect(letterForGrade('Critical')).toBe('F');
    });
  });

  describe('renderHealthScore', () => {
    it('renders score 85 with Healthy grade', () => {
      const result = renderHealthScore({
        score: 85,
        grade: 'Healthy',
        ghostPenalty: 15,
        tokenPenalty: 0,
      });
      expect(result).toContain('Health grade: A+ (Healthy)');
    });

    it('renders score 42 with Poor grade', () => {
      const result = renderHealthScore({
        score: 42,
        grade: 'Poor',
        ghostPenalty: 48,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health grade: D (Poor)');
    });

    it('renders score 60 with Fair grade', () => {
      const result = renderHealthScore({
        score: 60,
        grade: 'Fair',
        ghostPenalty: 30,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health grade: B (Fair)');
    });

    it('renders score 10 with Critical grade', () => {
      const result = renderHealthScore({
        score: 10,
        grade: 'Critical',
        ghostPenalty: 80,
        tokenPenalty: 10,
      });
      expect(result).toContain('Health grade: F (Critical)');
    });

    it('output does not contain /100', () => {
      const result = renderHealthScore({
        score: 100,
        grade: 'Healthy',
        ghostPenalty: 0,
        tokenPenalty: 0,
      });
      expect(result).not.toContain('/100');
    });
  });
}
