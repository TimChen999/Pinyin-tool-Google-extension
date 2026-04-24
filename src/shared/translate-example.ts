/**
 * Chinese-to-English example sentence translator backed by Chrome's
 * built-in Translator API (Chrome 138+). Replaces the previous
 * LLM-backed sentence translator: zero LLM tokens, no third-party
 * service dependency, on-device translation.
 *
 * Imported by the two surfaces that own the originating user gesture:
 *  - src/content/content.ts -- runs on "+ Vocab" click in the overlay,
 *    so transient user activation is fresh.
 *  - src/hub/hub.ts          -- runs on "Translate" button click in
 *    the vocab card / flashcard flip view, again with fresh activation.
 *
 * The Translator API is intentionally NOT callable from the MV3 service
 * worker (Chrome's docs explicitly exclude Web Workers, and offscreen
 * documents have no user activation so Translator.create() throws
 * NotAllowedError). Calling it from these two pages is the documented,
 * supported path -- top-level windows and content-script main worlds.
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
 * Translates one Chinese sentence into English via Chrome's built-in
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
export async function translateExampleSentence(
  sentence: string,
): Promise<TranslateResult> {
  if (typeof Translator === "undefined") {
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
    translator = await cachedTranslator;
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
    const translation = await translator.translate(sentence);
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
