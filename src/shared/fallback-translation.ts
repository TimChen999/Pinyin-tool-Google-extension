/**
 * Shared "Phase 2" orchestration for the non-LLM on-device translator
 * fallback. Used by both:
 *  - src/content/content.ts (page selections via mouseup / context
 *    menu / keyboard shortcut, and OCR'd text)
 *  - src/reader/reader.ts   (in-extension reader selections)
 *
 * Owning the orchestration here keeps the gating + two-phase paint
 * logic in lockstep across surfaces so a future tweak to the cap, the
 * dedup, or the request-id staleness check doesn't have to be made
 * twice. Both call sites supply their own paint/error callbacks
 * because the surrounding surface (overlay state, ttsEnabled source,
 * requestId mechanism) lives in their own module.
 *
 * Pipeline:
 *   1. Dedupe Chinese segments from the locally segmented words
 *      (skip non-Chinese fragments, drop duplicates, cap at
 *      MAX_FALLBACK_SEGMENTS to bound parallel translate() fan-out).
 *   2. Kick off the full-text translate() and every segment
 *      translate() in parallel.
 *   3. Phase A -- await full translation, paint with empty defs.
 *   4. Phase B -- await segment translations, paint again with
 *      glosses. Words past the cap keep an empty definition.
 *
 * Either phase may be skipped if isStale() flips during its await.
 * onError fires when the full translation fails (no point painting
 * empty glosses with no headline translation); per-segment failures
 * are silently treated as missing glosses.
 */

import { containsChinese } from "./chinese-detect";
import { MAX_FALLBACK_SEGMENTS } from "./constants";
import { translateChineseToEnglish } from "./translate-example";
import type { WordData } from "./types";

export interface FallbackOverlayCallbacks {
  /**
   * Returns true when the current selection has been superseded by a
   * newer one and any pending paint should be aborted. Mirrors the
   * requestId pattern used by both the LLM path in content.ts and
   * reader.ts.
   */
  isStale: () => boolean;
  /**
   * Paint the overlay with the supplied words + full translation.
   * Called twice: once with empty definitions (Phase A) as soon as
   * the full sentence is ready, then again with per-segment glosses
   * filled in (Phase B). Both call into updateOverlayFallback in
   * production.
   */
  onPaint: (words: Required<WordData>[], translation: string) => void;
  /**
   * Paint the overlay with an error message. Called only when the
   * full-text translate() fails -- segment translation failures are
   * silently dropped so the user still gets the headline translation.
   */
  onError: (message: string) => void;
}

export async function runFallbackTranslation(
  text: string,
  words: WordData[],
  cbs: FallbackOverlayCallbacks,
): Promise<void> {
  const segments = collectUniqueChineseSegments(words);

  const fullPromise = translateChineseToEnglish(text);
  const segmentPromises = segments.map((s) => translateChineseToEnglish(s));

  const fullResult = await fullPromise;
  if (cbs.isStale()) return;

  if (!fullResult.ok) {
    cbs.onError(fullResult.error.message);
    return;
  }

  // Phase A: full translation only -- words still have empty
  // definitions so clicking a ruby is a no-op until Phase B lands,
  // but the user already sees the sentence translation.
  const phaseAWords: Required<WordData>[] = words.map((w) => ({
    chars: w.chars,
    pinyin: w.pinyin,
    definition: w.definition ?? "",
  }));
  cbs.onPaint(phaseAWords, fullResult.translation);

  const segmentResults = await Promise.all(segmentPromises);
  if (cbs.isStale()) return;

  const segMap = new Map<string, string>();
  segments.forEach((s, i) => {
    const r = segmentResults[i];
    if (r.ok) segMap.set(s, r.translation);
  });

  // Phase B: enrich each ruby with its per-segment gloss. Words
  // beyond MAX_FALLBACK_SEGMENTS keep an empty definition (click is
  // a no-op) but still display pinyin and contribute to the
  // already-rendered full translation.
  const enriched: Required<WordData>[] = words.map((w) => ({
    chars: w.chars,
    pinyin: w.pinyin,
    definition: segMap.get(w.chars) ?? w.definition ?? "",
  }));
  cbs.onPaint(enriched, fullResult.translation);
}

/**
 * Pulls the unique Chinese segments from a locally-segmented word
 * list, capped at MAX_FALLBACK_SEGMENTS. Exported for tests; in
 * production it's only called from runFallbackTranslation above.
 *
 * Skips non-Chinese fragments (English, punctuation, numbers) since
 * the on-device zh→en translator has nothing useful to say about
 * them, and skips duplicates so a sentence that repeats the same
 * word three times only fires one translate() for it.
 */
export function collectUniqueChineseSegments(words: WordData[]): string[] {
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (!w.chars || seen.has(w.chars)) continue;
    if (!containsChinese(w.chars)) continue;
    seen.add(w.chars);
    segments.push(w.chars);
    if (segments.length >= MAX_FALLBACK_SEGMENTS) break;
  }
  return segments;
}
