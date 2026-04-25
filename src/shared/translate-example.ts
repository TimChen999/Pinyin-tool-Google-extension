/**
 * Chinese-to-English on-device translator backed by Chrome's built-in
 * Translator API (Chrome 138+). Zero LLM tokens, no third-party
 * service dependency, no API key.
 *
 * Two public entry points share one cached zh→en Translator instance:
 *  - translateExampleSentence / translateChineseToEnglish: the actual
 *    translation call. Used by the "+ Vocab" capture pipeline, the
 *    hub Translate button, and the non-LLM fallback in content /
 *    reader selection flows.
 *  - prewarmTranslator: best-effort warmup so a slow async chain
 *    (e.g. Tesseract OCR running between the user's drag-mouseup and
 *    the eventual translation call) doesn't leave us calling
 *    Translator.create() with stale transient activation.
 *
 * The Translator API is intentionally NOT callable from the MV3 service
 * worker (Chrome's docs explicitly exclude Web Workers, and offscreen
 * documents have no user activation so Translator.create() throws
 * NotAllowedError). Calling it from content scripts and extension
 * pages is the documented, supported path.
 */

// ─── Translator API shape ──────────────────────────────────────────
//
// Minimal local typing for Chrome's globalThis.Translator. Avoids
// pulling in @types/dom-chromium-ai as a new devDependency. Mirrors
// https://developer.chrome.com/docs/ai/translator-api at the call
// surface we use.

type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

interface TranslatorCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (m: EventTarget) => void;
}

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}

interface TranslatorStatic {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
  create(opts: TranslatorCreateOptions): Promise<TranslatorInstance>;
}

declare const Translator: TranslatorStatic | undefined;

// ─── Public Result Type ────────────────────────────────────────────

export interface TranslateError {
  /**
   * UNAVAILABLE        -- Translator API missing on this browser, or
   *                       availability() reported "unavailable" for zh→en.
   * DOWNLOAD_FAILED    -- Translator.create() rejected (model download
   *                       failed, user blocked, no activation, etc.).
   * TRANSLATION_FAILED -- translator.translate() rejected.
   */
  code: "UNAVAILABLE" | "DOWNLOAD_FAILED" | "TRANSLATION_FAILED";
  message: string;
}

export type TranslateResult =
  | { ok: true; translation: string }
  | { ok: false; error: TranslateError };

// ─── Module-scoped instance cache ──────────────────────────────────
//
// One zh→en Translator per importing context (content script main
// world, hub page). Concurrent translateExampleSentence() calls
// coalesce on the same create() Promise so the model download only
// fires once per context lifetime. The instance is reused across
// every translate() call after that.

let cachedTranslator: Promise<TranslatorInstance> | null = null;

/** Reset cache. Test-only; not exported from the public surface. */
export function _resetForTests(): void {
  cachedTranslator = null;
}

/**
 * Synchronous feature check for the Translator API. Lets callers
 * decide up front whether to render a "Loading translation..." row
 * (true) or omit the translation slot entirely (false), without
 * paying the cost of an async availability() probe.
 */
export function isTranslatorAvailable(): boolean {
  return typeof Translator !== "undefined";
}

/**
 * Returns (and lazily creates) the cached zh→en Translator promise.
 * Returns null when the API is missing on this browser. Centralised
 * so translateChineseToEnglish() and prewarmTranslator() share the
 * exact same create() path -- a single in-flight create() Promise
 * coalesces concurrent first-use callers and the prewarm.
 */
function ensureTranslatorPromise(): Promise<TranslatorInstance> | null {
  if (typeof Translator === "undefined") return null;
  if (!cachedTranslator) {
    cachedTranslator = (async () => {
      const status = await Translator.availability({
        sourceLanguage: "zh",
        targetLanguage: "en",
      });
      if (status === "unavailable") {
        throw new Error("Translator reports zh→en is unavailable.");
      }
      // create() resolves only when the model is ready; if the
      // status is "downloadable"/"downloading" this will await the
      // download internally. Browsers without a downloaded model
      // typically take a few seconds to tens of seconds on first call.
      return Translator.create({
        sourceLanguage: "zh",
        targetLanguage: "en",
      });
    })();
  }
  return cachedTranslator;
}

/**
 * Translates one Chinese string into English via Chrome's built-in
 * Translator API. Lazily creates a single zh→en translator instance
 * per importing context and reuses it for all subsequent calls.
 *
 * Failure surface:
 *  - Translator missing -> UNAVAILABLE (e.g. older Chrome, mobile, Edge,
 *    Firefox, Safari -- the API is desktop-Chrome 138+ only).
 *  - availability() reports "unavailable" -> UNAVAILABLE (e.g. zh-en
 *    pair not supported on this device, or model storage exhausted).
 *  - create() throws -> DOWNLOAD_FAILED (covers download failures and
 *    NotAllowedError when no transient activation is present).
 *  - translate() throws -> TRANSLATION_FAILED.
 *
 * The cached translator promise is cleared on create()/translate()
 * failure so the next call retries from scratch instead of replaying
 * the same rejection.
 */
export async function translateChineseToEnglish(
  text: string,
): Promise<TranslateResult> {
  const pending = ensureTranslatorPromise();
  if (!pending) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Translation isn't available on this browser.",
      },
    };
  }

  let translator: TranslatorInstance;
  try {
    translator = await pending;
  } catch (err) {
    cachedTranslator = null;
    const msg = err instanceof Error ? err.message : String(err);
    // availability() === "unavailable" surfaces as the synthetic Error
    // above; collapse it into the cleaner UNAVAILABLE code so callers
    // can distinguish "browser can't ever do this" from "model download
    // failed and you might want to retry".
    if (msg.includes("zh→en is unavailable")) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Translation isn't available on this browser.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "DOWNLOAD_FAILED",
        message: "Translation model couldn't be loaded. Try again.",
      },
    };
  }

  try {
    const translation = await translator.translate(text);
    return { ok: true, translation };
  } catch {
    // Don't drop the cached translator on a per-call translate()
    // failure -- the instance is probably still healthy for the next
    // sentence. We only invalidate on create() failure above.
    return {
      ok: false,
      error: {
        code: "TRANSLATION_FAILED",
        message: "Translation failed. Try again.",
      },
    };
  }
}

/**
 * Backwards-compatible alias for the original example-sentence call
 * site. Vocab capture (`src/shared/vocab-capture.ts`) and the hub
 * Translate buttons (`src/hub/hub.ts`) still import this name; the
 * implementation is identical to translateChineseToEnglish().
 */
export const translateExampleSentence = translateChineseToEnglish;

/**
 * Best-effort warmup: kicks off Translator.create() so the cached
 * zh→en instance is ready by the time a later translate() call runs.
 *
 * The motivating case is OCR. The user's drag-mouseup is a fresh
 * transient user activation, but Tesseract recognition can take many
 * seconds; by the time the OCR'd text is ready, the activation
 * window has expired and Translator.create() fails with
 * NotAllowedError. Calling prewarmTranslator() directly inside the
 * mouseup-resolved code path captures the still-valid activation
 * and stores the resulting instance in the module cache.
 *
 * Safe to call repeatedly; the cached create() promise short-circuits
 * subsequent calls. No-op when the Translator API is missing on
 * this browser. Failures are swallowed so callers can fire-and-forget;
 * the next translateChineseToEnglish() will surface the real error
 * via its typed result type after the cache is cleared.
 */
export async function prewarmTranslator(): Promise<void> {
  const pending = ensureTranslatorPromise();
  if (!pending) return;
  try {
    await pending;
  } catch {
    // Mirror translateChineseToEnglish(): clear the cache on failure
    // so the next attempt starts fresh.
    cachedTranslator = null;
  }
}
