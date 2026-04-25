/**
 * Unit tests for the shared on-device fallback orchestration. The
 * same module is consumed by both src/content/content.ts and
 * src/reader/reader.ts, so verifying gating + the two-phase paint
 * here covers both surfaces' fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectUniqueChineseSegments,
  runFallbackTranslation,
  type FallbackOverlayCallbacks,
} from "../../src/shared/fallback-translation";
import { _resetForTests } from "../../src/shared/translate-example";
import type { WordData } from "../../src/shared/types";
import { MAX_FALLBACK_SEGMENTS } from "../../src/shared/constants";

function setTranslator(impl: unknown): void {
  (globalThis as { Translator?: unknown }).Translator = impl as never;
}

function clearTranslator(): void {
  delete (globalThis as { Translator?: unknown }).Translator;
}

/**
 * Pulls a vi.Mock spy off a callbacks bundle for assertions. Used so
 * tests can write `cbs.spy("onPaint")` instead of casting at every
 * call site -- vi.fn() spies satisfy the FallbackOverlayCallbacks
 * function signatures at runtime but TypeScript's structural compare
 * doesn't recognise the cross-shape compatibility.
 */
function spyOf(cbs: FallbackOverlayCallbacks, key: keyof FallbackOverlayCallbacks): ReturnType<typeof vi.fn> {
  return cbs[key] as unknown as ReturnType<typeof vi.fn>;
}

/**
 * Builds a callbacks bundle whose three slots are vi.fn() spies, with
 * isStale defaulting to false. Tests can override individual slots
 * (or call the spy after the fact) to drive each branch.
 */
function makeCallbacks(
  overrides: Partial<FallbackOverlayCallbacks> = {},
): FallbackOverlayCallbacks {
  return {
    isStale: vi.fn(() => false),
    onPaint: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("collectUniqueChineseSegments", () => {
  it("returns segments in their first-occurrence order", () => {
    const words: WordData[] = [
      { chars: "我", pinyin: "wǒ" },
      { chars: "学习", pinyin: "xué xí" },
      { chars: "中文", pinyin: "zhōng wén" },
    ];
    expect(collectUniqueChineseSegments(words)).toEqual([
      "我",
      "学习",
      "中文",
    ]);
  });

  it("deduplicates repeated segments so each unique chunk fires one translate()", () => {
    const words: WordData[] = [
      { chars: "我", pinyin: "wǒ" },
      { chars: "我", pinyin: "wǒ" },
      { chars: "学习", pinyin: "xué xí" },
      { chars: "我", pinyin: "wǒ" },
    ];
    expect(collectUniqueChineseSegments(words)).toEqual(["我", "学习"]);
  });

  it("skips non-Chinese fragments (English, punctuation, numbers)", () => {
    const words: WordData[] = [
      { chars: "我", pinyin: "wǒ" },
      { chars: "hello", pinyin: "hello" },
      { chars: "，", pinyin: "，" },
      { chars: "123", pinyin: "123" },
      { chars: "中文", pinyin: "zhōng wén" },
    ];
    expect(collectUniqueChineseSegments(words)).toEqual(["我", "中文"]);
  });

  it("caps the result at MAX_FALLBACK_SEGMENTS to bound translate() fan-out", () => {
    // Build (cap+5) unique single-char segments via the surrogate-free
    // CJK range so each is independently Chinese-detectable.
    const words: WordData[] = Array.from(
      { length: MAX_FALLBACK_SEGMENTS + 5 },
      (_, i) => ({
        chars: String.fromCodePoint(0x4e00 + i),
        pinyin: `p${i}`,
      }),
    );
    const out = collectUniqueChineseSegments(words);
    expect(out).toHaveLength(MAX_FALLBACK_SEGMENTS);
  });

  it("skips empty chars entries defensively", () => {
    const words: WordData[] = [
      { chars: "", pinyin: "" },
      { chars: "我", pinyin: "wǒ" },
    ];
    expect(collectUniqueChineseSegments(words)).toEqual(["我"]);
  });
});

describe("runFallbackTranslation", () => {
  beforeEach(() => {
    clearTranslator();
    _resetForTests();
  });

  afterEach(() => {
    clearTranslator();
    _resetForTests();
    vi.restoreAllMocks();
  });

  const sampleWords: WordData[] = [
    { chars: "我", pinyin: "wǒ" },
    { chars: "学习", pinyin: "xué xí" },
    { chars: "中文", pinyin: "zhōng wén" },
  ];

  it("paints twice -- Phase A (full only, empty defs), Phase B (with glosses) -- when everything succeeds", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    setTranslator({
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });

    const cbs = makeCallbacks();
    await runFallbackTranslation("我学习中文", sampleWords, cbs);

    const onPaint = spyOf(cbs, "onPaint");
    const onError = spyOf(cbs, "onError");
    expect(onPaint).toHaveBeenCalledTimes(2);

    const phaseA = onPaint.mock.calls[0];
    expect(phaseA[1]).toBe("EN(我学习中文)");
    // Phase A words carry empty definitions because segment glosses
    // haven't resolved yet -- they reuse whatever the words came in
    // with (or "" when the field was missing).
    expect((phaseA[0] as Required<WordData>[]).map((w) => w.definition)).toEqual([
      "",
      "",
      "",
    ]);

    const phaseB = onPaint.mock.calls[1];
    expect(phaseB[1]).toBe("EN(我学习中文)");
    expect((phaseB[0] as Required<WordData>[]).map((w) => [w.chars, w.definition])).toEqual([
      ["我", "EN(我)"],
      ["学习", "EN(学习)"],
      ["中文", "EN(中文)"],
    ]);

    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError and skips both paints when the full translation fails", async () => {
    setTranslator({
      availability: vi.fn(async () => "downloadable"),
      create: vi.fn(async () => {
        throw new Error("download blocked");
      }),
    });

    const cbs = makeCallbacks();
    await runFallbackTranslation("我学习中文", sampleWords, cbs);

    const onPaint = spyOf(cbs, "onPaint");
    const onError = spyOf(cbs, "onError");
    expect(onPaint).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const msg = onError.mock.calls[0][0];
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("aborts after the full translation if isStale flips before Phase A", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    setTranslator({
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });

    // isStale returns true on its first call (just after the full
    // translate resolves), so neither paint should run.
    const isStale = vi.fn(() => true);
    const cbs = makeCallbacks({ isStale });

    await runFallbackTranslation("我学习中文", sampleWords, cbs);

    expect(spyOf(cbs, "onPaint")).not.toHaveBeenCalled();
    expect(spyOf(cbs, "onError")).not.toHaveBeenCalled();
    expect(isStale).toHaveBeenCalled();
  });

  it("renders Phase A but aborts Phase B if isStale flips between the two awaits", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    setTranslator({
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });

    let calls = 0;
    const isStale = vi.fn(() => {
      // First call (after full translate): not stale -> Phase A paints.
      // Second call (after Promise.all of segments): stale -> abort.
      calls += 1;
      return calls > 1;
    });
    const cbs = makeCallbacks({ isStale });

    await runFallbackTranslation("我学习中文", sampleWords, cbs);

    const onPaint = spyOf(cbs, "onPaint");
    expect(onPaint).toHaveBeenCalledTimes(1);
    const phaseA = onPaint.mock.calls[0];
    expect(phaseA[1]).toBe("EN(我学习中文)");
  });

  it("treats per-segment translate() failures as missing glosses (Phase B still paints)", async () => {
    let segCalls = 0;
    const translate = vi.fn(async (s: string) => {
      // Full text and the first segment succeed; subsequent segment
      // calls reject. Verifies we don't propagate per-segment failures
      // into the headline error path.
      if (s === "我学习中文" || s === "我") return `EN(${s})`;
      segCalls += 1;
      throw new Error("segment failed " + segCalls);
    });
    setTranslator({
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });

    const cbs = makeCallbacks();
    await runFallbackTranslation("我学习中文", sampleWords, cbs);

    const onPaint = spyOf(cbs, "onPaint");
    expect(spyOf(cbs, "onError")).not.toHaveBeenCalled();
    expect(onPaint).toHaveBeenCalledTimes(2);

    const phaseB = onPaint.mock.calls[1];
    expect((phaseB[0] as Required<WordData>[]).map((w) => [w.chars, w.definition])).toEqual([
      ["我", "EN(我)"],
      ["学习", ""], // segment translate() rejected -> empty gloss
      ["中文", ""], // segment translate() rejected -> empty gloss
    ]);
  });

  it("calls onError with the Translator-API-missing message when there's no Translator at all", async () => {
    clearTranslator();

    const cbs = makeCallbacks();
    await runFallbackTranslation("我学习", sampleWords, cbs);

    const onError = spyOf(cbs, "onError");
    expect(onError).toHaveBeenCalledTimes(1);
    const msg = onError.mock.calls[0][0] as string;
    expect(msg.toLowerCase()).toContain("isn't available");
    expect(spyOf(cbs, "onPaint")).not.toHaveBeenCalled();
  });

  it("dedupes repeated chars so identical translate() calls are coalesced into a single segment promise", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    setTranslator({
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });

    // Three rubies, but only two unique segments -- "我" repeats.
    const wordsWithDup: WordData[] = [
      { chars: "我", pinyin: "wǒ" },
      { chars: "学习", pinyin: "xué xí" },
      { chars: "我", pinyin: "wǒ" },
    ];

    const cbs = makeCallbacks();
    await runFallbackTranslation("我学习我", wordsWithDup, cbs);

    // 1 full + 2 unique segments = 3 translate() calls (not 4).
    expect(translate).toHaveBeenCalledTimes(3);
    expect(translate).toHaveBeenCalledWith("我学习我");
    expect(translate).toHaveBeenCalledWith("我");
    expect(translate).toHaveBeenCalledWith("学习");

    // Both occurrences of "我" pick up the same gloss in Phase B.
    const phaseB = spyOf(cbs, "onPaint").mock.calls[1];
    expect((phaseB[0] as Required<WordData>[]).map((w) => w.definition)).toEqual([
      "EN(我)",
      "EN(学习)",
      "EN(我)",
    ]);
  });
});
