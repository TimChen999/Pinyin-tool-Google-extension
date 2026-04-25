/**
 * Pure-logic unit tests for the SRS-aware flashcard session builder.
 *
 * Tests buildSession() in isolation without any DOM or storage
 * dependencies. The session builder pulls due cards first (sorted by
 * wrongStreak desc, then nextDueAt asc), then fills any remaining
 * slots with the soonest-upcoming not-due cards so the user always
 * gets a session of the requested size when enough vocab exists.
 *
 * See: src/shared/srs.ts for the underlying isDue() helper.
 */

import { describe, it, expect } from "vitest";
import { buildSession } from "../../src/hub/hub";
import type { VocabEntry } from "../../src/shared/types";
import { MS_PER_DAY } from "../../src/shared/srs";

const NOW = 1_700_000_000_000;

function makeEntry(
  chars: string,
  overrides: Partial<VocabEntry> = {},
): VocabEntry {
  return {
    chars,
    pinyin: `pinyin_${chars}`,
    definition: `def_${chars}`,
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

describe("buildSession", () => {
  it("returns empty array for empty vocab", () => {
    expect(buildSession([], 10, NOW)).toEqual([]);
  });

  it("returns all words when vocab size is less than requested", () => {
    const vocab = [makeEntry("A"), makeEntry("B"), makeEntry("C")];
    const result = buildSession(vocab, 10, NOW);
    expect(result).toHaveLength(3);
  });

  it("returns exactly N words when vocab has enough", () => {
    const vocab = Array.from({ length: 30 }, (_, i) => makeEntry(`word${i}`));
    const result = buildSession(vocab, 20, NOW);
    expect(result).toHaveLength(20);
  });

  it("all returned words exist in the input vocab", () => {
    const vocab = Array.from({ length: 20 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 10, NOW);

    const vocabChars = new Set(vocab.map((v) => v.chars));
    for (const card of result) {
      expect(vocabChars.has(card.chars)).toBe(true);
    }
  });

  it("has no duplicate words in the session", () => {
    const vocab = Array.from({ length: 20 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 15, NOW);
    const charSet = new Set(result.map((c) => c.chars));
    expect(charSet.size).toBe(result.length);
  });

  it("treats nextDueAt=0 (never reviewed) as due now", () => {
    const vocab = Array.from({ length: 5 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 5, NOW);
    expect(result).toHaveLength(5);
  });

  it("draws due cards before not-due cards", () => {
    const dueCards = Array.from({ length: 3 }, (_, i) =>
      makeEntry(`due${i}`, {
        totalReviews: 1,
        intervalDays: 1,
        nextDueAt: NOW - MS_PER_DAY,
      }),
    );
    const notDueCards = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`fresh${i}`, {
        totalReviews: 1,
        intervalDays: 30,
        nextDueAt: NOW + 30 * MS_PER_DAY,
      }),
    );
    const vocab = [...notDueCards, ...dueCards];
    const result = buildSession(vocab, 3, NOW);

    expect(result).toHaveLength(3);
    for (const card of result) {
      expect(card.chars.startsWith("due")).toBe(true);
    }
  });

  it("fills remaining slots from not-due pool when due pool is too small", () => {
    const dueCards = Array.from({ length: 2 }, (_, i) =>
      makeEntry(`due${i}`, {
        totalReviews: 1,
        intervalDays: 1,
        nextDueAt: NOW - MS_PER_DAY,
      }),
    );
    const notDueCards = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`fresh${i}`, {
        totalReviews: 1,
        intervalDays: 30,
        nextDueAt: NOW + (i + 1) * MS_PER_DAY,
      }),
    );
    const vocab = [...notDueCards, ...dueCards];
    const result = buildSession(vocab, 5, NOW);

    expect(result).toHaveLength(5);
    const dueCount = result.filter((c) => c.chars.startsWith("due")).length;
    const freshCount = result.filter((c) => c.chars.startsWith("fresh")).length;
    expect(dueCount).toBe(2);
    expect(freshCount).toBe(3);
  });

  it("orders due cards with higher wrongStreak first", () => {
    const vocab = [
      makeEntry("low", { wrongStreak: 1, totalReviews: 2, nextDueAt: NOW - 1000 }),
      makeEntry("high", { wrongStreak: 5, totalReviews: 3, nextDueAt: NOW - 1000 }),
      makeEntry("mid", { wrongStreak: 3, totalReviews: 4, nextDueAt: NOW - 1000 }),
    ];
    // Take top 1 from due pool — wrongStreak=5 must win every time.
    // (shuffleArray runs after picking, but with N=1 there's only one
    // arrangement so we can assert exactly which card was picked.)
    for (let i = 0; i < 20; i++) {
      const result = buildSession(vocab, 1, NOW);
      expect(result[0].chars).toBe("high");
    }
  });

  it("orders due cards by nextDueAt ascending when wrongStreak is tied", () => {
    const vocab = [
      makeEntry("recent", {
        wrongStreak: 0,
        totalReviews: 1,
        intervalDays: 1,
        nextDueAt: NOW - MS_PER_DAY,
      }),
      makeEntry("old", {
        wrongStreak: 0,
        totalReviews: 1,
        intervalDays: 1,
        nextDueAt: NOW - 5 * MS_PER_DAY,
      }),
    ];
    // With N=1 the older-due card wins.
    const result = buildSession(vocab, 1, NOW);
    expect(result[0].chars).toBe("old");
  });

  it("returns nothing-but-not-due cards when nothing is due and N > 0", () => {
    const vocab = Array.from({ length: 5 }, (_, i) =>
      makeEntry(`w${i}`, {
        totalReviews: 1,
        intervalDays: 30,
        nextDueAt: NOW + (i + 1) * MS_PER_DAY,
      }),
    );
    const result = buildSession(vocab, 3, NOW);
    expect(result).toHaveLength(3);
  });

  it("handles session size of 1", () => {
    const vocab = [makeEntry("only")];
    const result = buildSession(vocab, 1, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].chars).toBe("only");
  });

  it("returns correct count when session size equals vocab size", () => {
    const vocab = Array.from({ length: 10 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 10, NOW);
    expect(result).toHaveLength(10);
  });
});
