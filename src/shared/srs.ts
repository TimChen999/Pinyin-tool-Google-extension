/**
 * Spaced-repetition scheduling and bucket classification for vocab.
 *
 * Pure logic only -- no storage, no DOM. The vocab-store consumes
 * applyReviewResult() to update an entry after each flashcard answer,
 * the hub UI consumes getVocabBucket() to label rows, and the session
 * builder consumes isDue() to pick which cards to surface next.
 *
 * The scheduler is a Leitner-style doubling interval: a correct answer
 * doubles the interval (starting at 1 day), a wrong answer resets it
 * to zero (immediately due) and bumps the wrong-streak counter. Three
 * user-facing buckets fall out of the resulting state:
 *
 *   - "not-reviewed":      no review has happened yet
 *   - "needs-improvement": reviewed, but interval is short or the
 *                          last answer was wrong
 *   - "confident":         interval has reached the confident
 *                          threshold without any active wrong-streak
 */

import type { VocabEntry } from "./types";

export const MS_PER_DAY = 86_400_000;

/** Interval applied after the first correct answer on a fresh card. */
export const SRS_INITIAL_INTERVAL_DAYS = 1;

/** Hard cap so a long success streak doesn't push reviews years out. */
export const SRS_MAX_INTERVAL_DAYS = 365;

/**
 * Threshold (in days) at which a clean entry graduates to the
 * "confident" bucket. Roughly one week of successful spacing -- short
 * enough to feel earned, long enough that flaky guessing doesn't get
 * there by accident.
 */
export const SRS_CONFIDENT_INTERVAL_DAYS = 7;

export type VocabBucket = "not-reviewed" | "needs-improvement" | "confident";

/**
 * Returns the SRS-state fields produced by applying a single review
 * result on top of the entry's current scheduling state. Caller is
 * responsible for merging these into storage.
 *
 * On correct: interval doubles (1 day floor, MAX cap), wrongStreak
 * clears, totalReviews/totalCorrect increment, nextDueAt is pushed
 * one interval into the future.
 *
 * On wrong: interval drops to 0 so the card is immediately due again,
 * wrongStreak grows, totalCorrect is unchanged, nextDueAt is pinned to
 * `now` so the next session picks it up.
 */
export function applyReviewResult(
  entry: Pick<VocabEntry, "intervalDays" | "wrongStreak" | "totalReviews" | "totalCorrect">,
  correct: boolean,
  now: number,
): Pick<VocabEntry, "intervalDays" | "nextDueAt" | "wrongStreak" | "totalReviews" | "totalCorrect"> {
  const prevInterval = entry.intervalDays ?? 0;
  const totalReviews = (entry.totalReviews ?? 0) + 1;

  if (correct) {
    const next = prevInterval > 0
      ? Math.min(prevInterval * 2, SRS_MAX_INTERVAL_DAYS)
      : SRS_INITIAL_INTERVAL_DAYS;
    return {
      intervalDays: next,
      nextDueAt: now + next * MS_PER_DAY,
      wrongStreak: 0,
      totalReviews,
      totalCorrect: (entry.totalCorrect ?? 0) + 1,
    };
  }

  return {
    intervalDays: 0,
    nextDueAt: now,
    wrongStreak: (entry.wrongStreak ?? 0) + 1,
    totalReviews,
    totalCorrect: entry.totalCorrect ?? 0,
  };
}

/**
 * Classifies an entry into one of the three user-facing buckets.
 * Mirrors Du Chinese's "strong / weak / not studied" surfacing but
 * derived purely from SRS state -- there is no separate stored field.
 */
export function getVocabBucket(entry: VocabEntry): VocabBucket {
  if ((entry.totalReviews ?? 0) === 0) return "not-reviewed";
  if (
    (entry.wrongStreak ?? 0) === 0 &&
    (entry.intervalDays ?? 0) >= SRS_CONFIDENT_INTERVAL_DAYS
  ) {
    return "confident";
  }
  return "needs-improvement";
}

/** Human-readable label for a bucket, used in pills and counts. */
export function bucketLabel(bucket: VocabBucket): string {
  switch (bucket) {
    case "confident":
      return "Confident";
    case "needs-improvement":
      return "Needs improvement";
    case "not-reviewed":
      return "Not reviewed";
  }
}

/**
 * True when the entry is due for review at `now`. Entries that have
 * never been scheduled (nextDueAt missing or 0) are always due, which
 * means a freshly-recorded word shows up in the very next session.
 */
export function isDue(entry: VocabEntry, now: number): boolean {
  return (entry.nextDueAt ?? 0) <= now;
}
