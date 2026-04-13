import type { InvocationRecord } from '../parser/types.ts';

/**
 * A single time bucket in the trend view.
 * Groups invocations by day or week with per-category counts.
 */
export interface TrendBucket {
  /** ISO date string for daily ('2026-04-01'), 'Week of YYYY-MM-DD' for weekly */
  period: string;
  /** Agent invocation count in this period */
  agents: number;
  /** Skill invocation count in this period */
  skills: number;
  /** MCP invocation count in this period */
  mcp: number;
  /** Total invocations in this period */
  total: number;
}

/**
 * Aggregate invocation records into time-bucketed trend data.
 *
 * Granularity auto-selection:
 *   - Daily for sinceMs <= 7 days
 *   - Weekly for sinceMs > 7 days
 *
 * Empty periods are zero-filled so the trend line is continuous.
 */
export function buildTrendData(invocations: InvocationRecord[], sinceMs: number): TrendBucket[] {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const isWeekly = sinceMs > SEVEN_DAYS;

  const now = new Date();
  const start = new Date(now.getTime() - sinceMs);

  // Build empty bucket map with zero-fill
  const bucketMap = new Map<string, TrendBucket>();

  if (isWeekly) {
    // Generate weekly buckets starting from Monday of start week
    const cursor = new Date(start);
    cursor.setUTCHours(0, 0, 0, 0);
    // Align to Monday (1 = Monday in getUTCDay where 0 = Sunday)
    const dayOfWeek = cursor.getUTCDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    cursor.setUTCDate(cursor.getUTCDate() - daysToMonday);

    while (cursor <= now) {
      const key = `Week of ${cursor.toISOString().slice(0, 10)}`;
      bucketMap.set(key, { period: key, agents: 0, skills: 0, mcp: 0, total: 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else {
    // Generate daily buckets
    const cursor = new Date(start);
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor <= now) {
      const key = cursor.toISOString().slice(0, 10);
      bucketMap.set(key, { period: key, agents: 0, skills: 0, mcp: 0, total: 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // Fill buckets from invocations
  for (const inv of invocations) {
    const date = new Date(inv.timestamp);
    let bucketKey: string;

    if (isWeekly) {
      const d = new Date(date);
      d.setUTCHours(0, 0, 0, 0);
      const dayOfWeek = d.getUTCDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      d.setUTCDate(d.getUTCDate() - daysToMonday);
      bucketKey = `Week of ${d.toISOString().slice(0, 10)}`;
    } else {
      bucketKey = date.toISOString().slice(0, 10);
    }

    const bucket = bucketMap.get(bucketKey);
    if (!bucket) continue;

    switch (inv.kind) {
      case 'agent':
        bucket.agents++;
        break;
      case 'skill':
        bucket.skills++;
        break;
      case 'mcp':
        bucket.mcp++;
        break;
    }
    bucket.total++;
  }

  return [...bucketMap.values()];
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  /** Helper: build a minimal InvocationRecord for testing. */
  function makeInvocation(kind: 'agent' | 'skill' | 'mcp', timestamp: string): InvocationRecord {
    return {
      kind,
      name: `test-${kind}`,
      sessionId: 'sess-001',
      timestamp,
      projectPath: '/test/project',
      isSidechain: false,
    };
  }

  describe('buildTrendData', () => {
    it('returns ~7-8 zero-filled daily buckets for empty invocations with 7-day window', () => {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const buckets = buildTrendData([], SEVEN_DAYS);
      // 7-day window = daily granularity, should produce 7 or 8 buckets
      expect(buckets.length).toBeGreaterThanOrEqual(7);
      expect(buckets.length).toBeLessThanOrEqual(8);
      for (const b of buckets) {
        expect(b.agents).toBe(0);
        expect(b.skills).toBe(0);
        expect(b.mcp).toBe(0);
        expect(b.total).toBe(0);
        // Daily buckets use ISO date format
        expect(b.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('fills one bucket correctly for 3 agent invocations on same day', () => {
      const today = new Date().toISOString().slice(0, 10) + 'T12:00:00Z';
      const invocations = [
        makeInvocation('agent', today),
        makeInvocation('agent', today),
        makeInvocation('agent', today),
      ];
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const buckets = buildTrendData(invocations, SEVEN_DAYS);
      const todayKey = new Date().toISOString().slice(0, 10);
      const todayBucket = buckets.find((b) => b.period === todayKey);
      expect(todayBucket).toBeDefined();
      expect(todayBucket!.agents).toBe(3);
      expect(todayBucket!.total).toBe(3);
      expect(todayBucket!.skills).toBe(0);
      expect(todayBucket!.mcp).toBe(0);
    });

    it('produces weekly buckets with "Week of" prefix for sinceMs > 7 days', () => {
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
      const buckets = buildTrendData([], FOURTEEN_DAYS);
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      for (const b of buckets) {
        expect(b.period).toMatch(/^Week of \d{4}-\d{2}-\d{2}$/);
      }
    });

    it('zero-fills days with no invocations', () => {
      // Create one invocation on a specific day
      const today = new Date().toISOString().slice(0, 10) + 'T10:00:00Z';
      const invocations = [makeInvocation('mcp', today)];
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const buckets = buildTrendData(invocations, SEVEN_DAYS);

      // Should have multiple buckets, most with zero counts
      const zeroBuckets = buckets.filter((b) => b.total === 0);
      expect(zeroBuckets.length).toBeGreaterThanOrEqual(6);
      for (const b of zeroBuckets) {
        expect(b.agents).toBe(0);
        expect(b.skills).toBe(0);
        expect(b.mcp).toBe(0);
      }
    });

    it('counts invocations into correct weekly buckets across multiple weeks', () => {
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // Create invocations on different weeks
      const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

      const invocations = [
        makeInvocation('agent', eightDaysAgo.toISOString()),
        makeInvocation('agent', threeDaysAgo.toISOString()),
        makeInvocation('skill', threeDaysAgo.toISOString()),
      ];

      const buckets = buildTrendData(invocations, FOURTEEN_DAYS);

      // Should have weekly buckets with "Week of" prefix
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      for (const b of buckets) {
        expect(b.period).toMatch(/^Week of /);
      }

      // Total across all buckets should be 3
      const totalSum = buckets.reduce((sum, b) => sum + b.total, 0);
      expect(totalSum).toBe(3);

      // At least two different buckets should have nonzero counts
      const nonZeroBuckets = buckets.filter((b) => b.total > 0);
      expect(nonZeroBuckets.length).toBeGreaterThanOrEqual(2);
    });

    it('aligns Sunday invocation to Monday of the same ISO week', () => {
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

      // Find the most recent Sunday (or today if it's Sunday)
      const now = new Date();
      now.setUTCHours(12, 0, 0, 0);
      const dayOfWeek = now.getUTCDay();
      const daysToLastSunday = dayOfWeek === 0 ? 0 : dayOfWeek;
      // Use last Sunday if today isn't Sunday, otherwise use today
      const sunday = new Date(now.getTime() - daysToLastSunday * 24 * 60 * 60 * 1000);

      const invocations = [makeInvocation('agent', sunday.toISOString())];
      const buckets = buildTrendData(invocations, FOURTEEN_DAYS);

      // The Sunday invocation should land in a "Week of <Monday>" bucket
      // where Monday is 6 days before the Sunday
      const expectedMonday = new Date(sunday.getTime() - 6 * 24 * 60 * 60 * 1000);
      const expectedBucketLabel = `Week of ${expectedMonday.toISOString().slice(0, 10)}`;

      const matchingBucket = buckets.find((b) => b.total > 0);
      expect(matchingBucket).toBeDefined();
      expect(matchingBucket!.period).toBe(expectedBucketLabel);
      expect(matchingBucket!.agents).toBe(1);
    });

    it('counts MCP invocations in weekly buckets', () => {
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      const invocations = [
        makeInvocation('mcp', twoDaysAgo.toISOString()),
        makeInvocation('mcp', twoDaysAgo.toISOString()),
      ];

      const buckets = buildTrendData(invocations, FOURTEEN_DAYS);

      const nonZeroBucket = buckets.find((b) => b.total > 0);
      expect(nonZeroBucket).toBeDefined();
      expect(nonZeroBucket!.mcp).toBe(2);
      expect(nonZeroBucket!.agents).toBe(0);
      expect(nonZeroBucket!.skills).toBe(0);
      expect(nonZeroBucket!.total).toBe(2);
    });

    it('silently drops invocations older than the time window', () => {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

      // Invocation from 30 days ago — well outside the 7-day window
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const invocations = [makeInvocation('agent', oldDate.toISOString())];

      const buckets = buildTrendData(invocations, SEVEN_DAYS);

      // No bucket should have any counts since the invocation is outside the window
      const totalSum = buckets.reduce((sum, b) => sum + b.total, 0);
      expect(totalSum).toBe(0);
    });
  });
}
