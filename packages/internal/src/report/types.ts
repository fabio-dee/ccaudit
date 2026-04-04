import type { ItemCategory } from '../types.ts';

/**
 * Health grade label for the ghost inventory health score.
 * Healthy >= 80, Fair >= 50, Poor >= 20, Critical < 20.
 */
export type HealthGrade = 'Healthy' | 'Fair' | 'Poor' | 'Critical';

/**
 * Health score result for the ghost inventory audit.
 * Score is 0-100 integer. Breakdown shows ghost and token penalties.
 */
export interface HealthScore {
  /** Overall health score, 0-100 integer */
  score: number;
  /** Human-readable grade label */
  grade: HealthGrade;
  /** Penalty points from ghost count */
  ghostPenalty: number;
  /** Penalty points from ghost token overhead */
  tokenPenalty: number;
}

/**
 * Per-category summary for the ghost inventory table.
 * One row per category (agent, skill, mcp-server, memory).
 */
export interface CategorySummary {
  /** Category: agent, skill, mcp-server, memory */
  category: ItemCategory;
  /** Total defined items in this category */
  defined: number;
  /** Items classified as 'used' */
  used: number;
  /** Items classified as ghost (likely + definite) */
  ghost: number;
  /** Total estimated token cost for ghost items in this category */
  tokenCost: number;
}
