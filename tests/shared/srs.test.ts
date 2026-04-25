/**
 * Pure-logic tests for the SRS scheduler and bucket classifier.
 * No storage, no DOM -- exercises shared/srs.ts directly.
 */

import { describe, it, expect } from "vitest";
import {
  applyReviewResult,
  bucketLabel,
  getVocabBucket,
  isDue,
  MS_PER_DAY,
  SRS_CONFIDENT_INTERVAL_DAYS,
  SRS_INITIAL_INTERVAL_DAYS,
  SRS_MAX_INTERVAL_DAYS,
} from "../../src/shared/srs";
import type { VocabEntry } from "../../src/shared/types";

const NOW = 1_700_000_000_000;

function baseEntry(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    chars: "测试",
    pinyin: "cè shì",
    definition: "test",
    count: 1,
    firstSeen: 1000,
    lastSeen: 2000,
    wrongStreak: 0,
    totalReviews: 0,
    totalCorrect: 0,
    intervalDays: 0,
    nextDueAt: 0,
    ...overrides,
  };
}

describe("applyReviewResult", () => {
  it("first correct answer sets the initial interval", () => {
    const next = applyReviewResult(baseEntry(), true, NOW);
    expect(next.intervalDays).toBe(SRS_INITIAL_INTERVAL_DAYS);
    expect(next.nextDueAt).toBe(NOW + SRS_INITIAL_INTERVAL_DAYS * MS_PER_DAY);
    expect(next.totalReviews).toBe(1);
    expect(next.totalCorrect).toBe(1);
    expect(next.wrongStreak).toBe(0);
  });

  it("doubles the interval on each subsequent correct answer", () => {
    const next = applyReviewResult(
      baseEntry({ intervalDays: 4, totalReviews: 3, totalCorrect: 3 }),
      true,
      NOW,
    );
    expect(next.intervalDays).toBe(8);
    expect(next.nextDueAt).toBe(NOW + 8 * MS_PER_DAY);
    expect(next.totalReviews).toBe(4);
    expect(next.totalCorrect).toBe(4);
  });

  it("caps the interval at SRS_MAX_INTERVAL_DAYS", () => {
    const next = applyReviewResult(
      baseEntry({ intervalDays: SRS_MAX_INTERVAL_DAYS, totalReviews: 10, totalCorrect: 10 }),
      true,
      NOW,
    );
    expect(next.intervalDays).toBe(SRS_MAX_INTERVAL_DAYS);
  });

  it("wrong answer resets interval to 0 and pins due to now", () => {
    const next = applyReviewResult(
      baseEntry({ intervalDays: 30, totalReviews: 5, totalCorrect: 5 }),
      false,
      NOW,
    );
    expect(next.intervalDays).toBe(0);
    expect(next.nextDueAt).toBe(NOW);
    expect(next.wrongStreak).toBe(1);
    expect(next.totalReviews).toBe(6);
    expect(next.totalCorrect).toBe(5);
  });

  it("wrong answer increments wrongStreak across consecutive failures", () => {
    let entry = baseEntry({ wrongStreak: 2, totalReviews: 4, totalCorrect: 2 });
    const next = applyReviewResult(entry, false, NOW);
    expect(next.wrongStreak).toBe(3);
    expect(next.totalCorrect).toBe(2);
  });

  it("correct after wrong restarts the interval at the initial value", () => {
    const next = applyReviewResult(
      baseEntry({
        intervalDays: 0,
        wrongStreak: 2,
        totalReviews: 5,
        totalCorrect: 3,
      }),
      true,
      NOW,
    );
    expect(next.intervalDays).toBe(SRS_INITIAL_INTERVAL_DAYS);
    expect(next.wrongStreak).toBe(0);
  });
});

describe("getVocabBucket", () => {
  it("returns not-reviewed when totalReviews is 0", () => {
    expect(getVocabBucket(baseEntry())).toBe("not-reviewed");
  });

  it("returns needs-improvement after a single correct answer (interval below threshold)", () => {
    expect(
      getVocabBucket(
        baseEntry({ totalReviews: 1, totalCorrect: 1, intervalDays: 1 }),
      ),
    ).toBe("needs-improvement");
  });

  it("returns needs-improvement when wrongStreak > 0 even with high interval", () => {
    expect(
      getVocabBucket(
        baseEntry({
          totalReviews: 5,
          totalCorrect: 3,
          intervalDays: 30,
          wrongStreak: 1,
        }),
      ),
    ).toBe("needs-improvement");
  });

  it("returns confident when interval crosses SRS_CONFIDENT_INTERVAL_DAYS with no wrong streak", () => {
    expect(
      getVocabBucket(
        baseEntry({
          totalReviews: 4,
          totalCorrect: 4,
          intervalDays: SRS_CONFIDENT_INTERVAL_DAYS,
          wrongStreak: 0,
        }),
      ),
    ).toBe("confident");
  });
});

describe("bucketLabel", () => {
  it("returns the user-facing label for each bucket", () => {
    expect(bucketLabel("confident")).toBe("Confident");
    expect(bucketLabel("needs-improvement")).toBe("Needs improvement");
    expect(bucketLabel("not-reviewed")).toBe("Not reviewed");
  });
});

describe("isDue", () => {
  it("returns true for entries with nextDueAt in the past", () => {
    expect(isDue(baseEntry({ nextDueAt: NOW - 1 }), NOW)).toBe(true);
  });

  it("returns true for never-scheduled entries (nextDueAt = 0)", () => {
    expect(isDue(baseEntry(), NOW)).toBe(true);
  });

  it("returns true exactly at nextDueAt (boundary)", () => {
    expect(isDue(baseEntry({ nextDueAt: NOW }), NOW)).toBe(true);
  });

  it("returns false for entries due in the future", () => {
    expect(isDue(baseEntry({ nextDueAt: NOW + 1 }), NOW)).toBe(false);
  });
});
