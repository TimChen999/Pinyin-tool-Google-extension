/**
 * Pure-logic unit tests for the flashcard session building algorithm.
 *
 * Tests buildSession() in isolation without any DOM or storage dependencies.
 *
 * See: VOCAB_HUB_SPEC.md Section 6 "Flashcard Session Algorithm".
 */

import { describe, it, expect } from "vitest";
import { buildSession } from "../../src/hub/hub";
import { FLASHCARD_WRONG_POOL_RATIO } from "../../src/shared/constants";
import type { VocabEntry } from "../../src/shared/types";

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
    ...overrides,
  };
}

describe("buildSession", () => {
  it("returns empty array for empty vocab", () => {
    expect(buildSession([], 10)).toEqual([]);
  });

  it("returns all words when vocab size is less than requested", () => {
    const vocab = [makeEntry("A"), makeEntry("B"), makeEntry("C")];
    const result = buildSession(vocab, 10);
    expect(result).toHaveLength(3);
  });

  it("returns exactly N words when vocab has enough", () => {
    const vocab = Array.from({ length: 30 }, (_, i) => makeEntry(`word${i}`));
    const result = buildSession(vocab, 20);
    expect(result).toHaveLength(20);
  });

  it("all returned words exist in the input vocab", () => {
    const vocab = Array.from({ length: 20 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 10);

    const vocabChars = new Set(vocab.map((v) => v.chars));
    for (const card of result) {
      expect(vocabChars.has(card.chars)).toBe(true);
    }
  });

  it("has no duplicate words in the session", () => {
    const vocab = Array.from({ length: 20 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 15);
    const charSet = new Set(result.map((c) => c.chars));
    expect(charSet.size).toBe(result.length);
  });

  it("prioritizes wrong-streak words up to 40% of session", () => {
    const wrongWords = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`wrong${i}`, { wrongStreak: i + 1 }),
    );
    const normalWords = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`normal${i}`),
    );
    const vocab = [...wrongWords, ...normalWords];
    const result = buildSession(vocab, 20);

    expect(result).toHaveLength(20);

    const wrongInResult = result.filter((c) => c.chars.startsWith("wrong"));
    const maxWrongSlots = Math.ceil(20 * FLASHCARD_WRONG_POOL_RATIO);
    expect(wrongInResult.length).toBeLessThanOrEqual(maxWrongSlots);
    expect(wrongInResult.length).toBeGreaterThan(0);
  });

  it("fills entire session from normal pool when no wrong words", () => {
    const vocab = Array.from({ length: 20 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 10);
    expect(result).toHaveLength(10);
    for (const card of result) {
      expect(card.wrongStreak).toBe(0);
    }
  });

  it("takes all wrong-pool entries when fewer than 40% of N", () => {
    const wrongWords = [makeEntry("w1", { wrongStreak: 2 })];
    const normalWords = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`n${i}`),
    );
    const vocab = [...wrongWords, ...normalWords];
    const result = buildSession(vocab, 10);

    expect(result).toHaveLength(10);
    const wrongInResult = result.filter((c) => c.chars === "w1");
    expect(wrongInResult).toHaveLength(1);
  });

  it("handles all words having wrong streaks", () => {
    const vocab = Array.from({ length: 5 }, (_, i) =>
      makeEntry(`w${i}`, { wrongStreak: i + 1 }),
    );
    const result = buildSession(vocab, 5);
    expect(result).toHaveLength(5);
  });

  it("prioritizes higher wrongStreak words first", () => {
    const vocab = [
      makeEntry("low", { wrongStreak: 1 }),
      makeEntry("mid", { wrongStreak: 3 }),
      makeEntry("high", { wrongStreak: 5 }),
      ...Array.from({ length: 20 }, (_, i) => makeEntry(`n${i}`)),
    ];

    const results: string[][] = [];
    for (let i = 0; i < 50; i++) {
      const session = buildSession(vocab, 5);
      const wrongInSession = session
        .filter((c) => c.wrongStreak > 0)
        .map((c) => c.chars);
      results.push(wrongInSession);
    }

    const highAppearances = results.filter((r) => r.includes("high")).length;
    expect(highAppearances).toBeGreaterThan(0);
  });

  it("returns correct count when session size equals vocab size", () => {
    const vocab = Array.from({ length: 10 }, (_, i) => makeEntry(`w${i}`));
    const result = buildSession(vocab, 10);
    expect(result).toHaveLength(10);
  });

  it("handles session size of 1", () => {
    const vocab = [makeEntry("only")];
    const result = buildSession(vocab, 1);
    expect(result).toHaveLength(1);
    expect(result[0].chars).toBe("only");
  });
});
