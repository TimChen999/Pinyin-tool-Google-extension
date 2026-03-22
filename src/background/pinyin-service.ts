/**
 * Local pinyin conversion wrapper around `pinyin-pro`.
 *
 * This is the Phase 1 "fast path" of the two-phase rendering architecture:
 * the service worker calls convertToPinyin() to return word-segmented pinyin
 * instantly (<50ms), before the slower LLM response arrives with contextual
 * definitions and translations.
 *
 * Uses pinyin-pro's `segment()` with AllSegment format for word-level grouping
 * (e.g., "银行" as one unit) rather than character-by-character `pinyin()`.
 * This is critical for polyphonic character disambiguation -- segment() picks
 * the contextually correct reading for characters like 行 (háng vs xíng).
 *
 * See: SPEC.md Section 5 "Two-Phase Rendering" for the fast-path role,
 *      SPEC.md Section 6 "Why LLM Disambiguation Matters" for segmentation,
 *      IMPLEMENTATION_GUIDE.md Step 2 for implementation details.
 */

import { segment, OutputFormat } from "pinyin-pro";
import type { WordData, PinyinStyle } from "../shared/types";

/**
 * Maps our PinyinStyle enum to pinyin-pro's toneType option.
 * "toneMarks" -> "symbol" (diacritics: hàn yǔ)
 * "toneNumbers" -> "num" (han4 yu3)
 * "none" -> "none" (han yu)
 */
const TONE_TYPE_MAP: Record<PinyinStyle, "symbol" | "num" | "none"> = {
  toneMarks: "symbol",
  toneNumbers: "num",
  none: "none",
};

/**
 * Converts Chinese text to an array of word-segmented WordData entries.
 *
 * Non-Chinese segments (English, numbers, punctuation) are passed through
 * with their original text as both `chars` and `pinyin` -- no annotation.
 *
 * @param text  - The input text to convert (may be mixed Chinese/English)
 * @param style - The desired pinyin display format
 * @returns An array where each element represents one segmented word
 */
export function convertToPinyin(text: string, style: PinyinStyle): WordData[] {
  if (!text) return [];

  const toneType = TONE_TYPE_MAP[style];

  const segments = segment(text, {
    format: OutputFormat.AllSegment,
    toneType,
  });

  return segments.map((seg) => ({
    chars: seg.origin,
    pinyin: seg.result,
  }));
}
