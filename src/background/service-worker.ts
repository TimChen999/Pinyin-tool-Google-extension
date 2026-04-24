/**
 * Background service worker -- the orchestration hub of the extension.
 *
 * Receives PINYIN_REQUEST messages from the content script and returns
 * a Phase 1 (local pinyin-pro) response immediately via sendResponse.
 * Phase 2 calls the LLM client asynchronously, sending contextual
 * definitions and translations back via chrome.tabs.sendMessage.
 *
 * Also registers the "Show Pinyin & Translation" context menu item
 * and handles the Alt+Shift+P keyboard shortcut, forwarding both
 * triggers to the content script for overlay rendering.
 *
 * See: SPEC.md Section 3 "Architecture" for the service worker's role,
 *      SPEC.md Section 5 "Data Flow" for the two-phase message flow,
 *      IMPLEMENTATION_GUIDE.md Steps 3-5 for implementation details.
 */

import { convertToPinyin } from "./pinyin-service";
import { queryLLM, translateSentence, type LLMResult } from "./llm-client";
import {
  hashText,
  getFromCache,
  getCachedError,
  saveToCache,
  saveErrorToCache,
  evictExpiredEntries,
} from "./cache";
import {
  recordWords,
  removeWord,
  removeExample,
  setExampleTranslation,
  getAllVocab,
} from "./vocab-store";
import { isUsableExample, trimSentenceForExample } from "../shared/example-quality";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
  KEEPALIVE_PORT_NAME,
} from "../shared/constants";
import type {
  ExtensionSettings,
  LLMConfig,
  PinyinRequest,
  PinyinResponseLocal,
  VocabExample,
} from "../shared/types";

// ─── In-flight Request Coalescing ──────────────────────────────────

/**
 * Map<cacheKey, in-flight queryLLM Promise>. Lets duplicate concurrent
 * requests for the same text+context (e.g. rapid mouse-ups, keyboard
 * shortcut firing while a context-menu request is mid-flight) share a
 * single network call instead of racing each other and competing for
 * the same timeout budget.
 */
const inflightLLM = new Map<string, Promise<LLMResult>>();

// ─── Settings Helper ───────────────────────────────────────────────

/**
 * Reads user settings from chrome.storage.sync and merges with
 * DEFAULT_SETTINGS so any missing keys fall back to sensible defaults.
 * Called on every PINYIN_REQUEST to pick up live setting changes
 * without requiring a service worker restart.
 */
export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Message Handling ──────────────────────────────────────────────

/**
 * Phase 1 fast-path: on PINYIN_REQUEST, immediately run pinyin-pro
 * and return the result via sendResponse. The content script shows
 * the overlay with basic pinyin while the LLM path runs in the
 * background. (SPEC.md Section 5 "Two-Phase Rendering")
 *
 * Returns true to keep the message channel open for the async
 * getSettings() call inside the handler.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: PinyinResponseLocal) => void,
  ) => {
    if (message.type !== "PINYIN_REQUEST") return;

    const request = message as PinyinRequest;

    handlePinyinRequest(request, sender.tab?.id, sendResponse);

    return true;
  },
);

async function handlePinyinRequest(
  request: PinyinRequest,
  tabId: number | undefined,
  sendResponse: (response: PinyinResponseLocal) => void,
): Promise<void> {
  const settings = await getSettings();
  const words = convertToPinyin(request.text, settings.pinyinStyle);

  sendResponse({ type: "PINYIN_RESPONSE_LOCAL", words });

  // Phase 2: async LLM call for contextual definitions + translation
  handleLLMPath(request, tabId, settings);
}

/**
 * Async LLM path (Phase 2). Layered cache + dedup before the network
 * call, plus partial-response support and a brief negative cache for
 * rate-limit replies.
 *
 * Order of operations:
 *  1. Bail out if LLM is disabled or the API key is missing.
 *  2. Hash text+context into a cache key.
 *  3. Positive-cache hit -> reply with cached response.
 *  4. Negative-cache hit (today: only RATE_LIMITED) -> reply with the
 *     cached error so we don't hammer the provider mid-throttle.
 *  5. In-flight coalescing -> share a single Promise for any duplicate
 *     concurrent request with the same cache key.
 *  6. Otherwise call queryLLM (which already does retries + salvage).
 *  7. On success: send the words/translation. Cache only when the
 *     response is *not* `partial`, so a salvaged-from-truncation reply
 *     never freezes a degraded answer in place for a week.
 *  8. On error: forward the message and (best effort) write a negative
 *     cache entry; saveErrorToCache silently no-ops for codes outside
 *     the NEGATIVE_CACHE_TTL_MS allow-list.
 *
 * (SPEC.md Section 6 "Fallback Strategy", "Caching")
 */
async function handleLLMPath(
  request: PinyinRequest,
  tabId: number | undefined,
  settings: ExtensionSettings,
): Promise<void> {
  if (!settings.llmEnabled || !tabId) {
    console.log("[LLM] Skipped: llmEnabled=%s, tabId=%s", settings.llmEnabled, tabId);
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) {
    console.warn("[LLM] No API key set for provider '%s'", settings.provider);
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_ERROR",
      error: "Set up an API key in extension settings for translations.",
      phase: "llm",
    });
    return;
  }

  console.log("[LLM] Starting request: provider=%s, model=%s, text='%s'",
    settings.provider, settings.model, request.text.slice(0, 50));

  // Cache lookup keyed on text+context so identical selections in
  // different paragraphs get separate, contextually correct entries.
  const cacheKey = await hashText(request.text + request.context);

  const cached = await getFromCache(cacheKey);
  if (cached) {
    console.log("[LLM] Positive cache hit for key=%s", cacheKey.slice(0, 12));
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_RESPONSE_LLM",
      words: cached.words,
      translation: cached.translation,
    });
    return;
  }

  const cachedErr = await getCachedError(cacheKey);
  if (cachedErr) {
    console.log("[LLM] Negative cache hit [%s] for key=%s", cachedErr.code, cacheKey.slice(0, 12));
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_ERROR",
      error: cachedErr.message,
      phase: "llm",
    });
    return;
  }

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await dedupedQueryLLM(
    cacheKey,
    request.text,
    request.context,
    config,
    settings.pinyinStyle,
  );

  if (result.ok) {
    console.log("[LLM] Success%s: %d words, translation='%s'",
      result.data.partial ? " (partial)" : "",
      result.data.words.length, result.data.translation.slice(0, 80));
    if (!result.data.partial) {
      await saveToCache(cacheKey, result.data);
    }
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_RESPONSE_LLM",
      words: result.data.words,
      translation: result.data.translation,
    });
  } else {
    console.error("[LLM] queryLLM failed: [%s] %s", result.error.code, result.error.message);
    await saveErrorToCache(cacheKey, result.error);
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_ERROR",
      error: result.error.message,
      phase: "llm",
    });
  }
}

/**
 * Wraps queryLLM with an in-flight Map keyed by cache key. If a request
 * for the same key is already running, returns its Promise instead of
 * starting a second one. The map entry is cleared on settlement (via
 * .finally) so the next *new* request for that key still hits the wire.
 */
function dedupedQueryLLM(
  cacheKey: string,
  text: string,
  context: string,
  config: LLMConfig,
  pinyinStyle: ExtensionSettings["pinyinStyle"],
): Promise<LLMResult> {
  const existing = inflightLLM.get(cacheKey);
  if (existing) {
    console.log("[LLM] Coalescing onto in-flight request for key=%s", cacheKey.slice(0, 12));
    return existing;
  }

  const p = queryLLM(text, context, config, pinyinStyle).finally(() => {
    inflightLLM.delete(cacheKey);
  });
  inflightLLM.set(cacheKey, p);
  return p;
}

// ─── Vocab Recording + Example Sentences ──────────────────────────

/**
 * RECORD_WORD handler. Persists the word, runs the captured page
 * context through the quality gate, attaches it as an example slot
 * when it passes, and -- if AI Translations is configured -- fires
 * an off-thread sentence translation that backfills the example's
 * translation field via setExampleTranslation.
 *
 * The auto-translate path is best-effort: if the LLM call fails the
 * sentence is still kept (translation can be filled later via the
 * "Translate" button in the vocab card / flashcard flip view). It
 * also short-circuits when the example already carries a translation
 * (e.g. a duplicate sentence from a prior save), so a user-attached
 * translation is never silently overwritten.
 */
async function handleRecordWord(
  word: { chars: string; pinyin: string; definition: string },
  context: string,
): Promise<void> {
  const cleaned = context.trim();

  let example: VocabExample | undefined;
  if (cleaned && isUsableExample(word.chars, cleaned)) {
    // Quality gate scores the original captured context; we only trim
    // the sentence we actually persist so the stored example reads
    // like one thought instead of a paragraph.
    const trimmed = trimSentenceForExample(cleaned, word.chars);
    example = { sentence: trimmed, capturedAt: Date.now() };
  }

  await recordWords([{ ...word }], example);

  if (!example) return;

  const settings = await getSettings();
  if (!settings.llmEnabled) return;

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) return;

  const all = await getAllVocab();
  const entry = all.find((e) => e.chars === word.chars);
  const idx = entry?.examples?.findIndex((e) => e.sentence === example!.sentence) ?? -1;
  if (idx < 0) return;
  if (entry!.examples![idx].translation) return;

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await translateSentence(example.sentence, config);
  if (!result.ok) return;

  await setExampleTranslation(word.chars, idx, result.translation);
}

/**
 * ADD_EXAMPLE_TRANSLATION handler. Looks up the targeted example by
 * (chars, index), translates its sentence with the user's configured
 * LLM, and stores the result. Replies via sendResponse so the hub UI
 * (vocab card / flashcard flip view) can refresh inline without a
 * separate poll.
 *
 * Reply shape: { ok: true, translation } on success,
 *              { ok: false, error: string } otherwise.
 */
async function handleAddExampleTranslation(
  chars: string,
  index: number,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const settings = await getSettings();
  if (!settings.llmEnabled) {
    sendResponse({ ok: false, error: "AI Translations is disabled in settings." });
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) {
    sendResponse({ ok: false, error: "API key required." });
    return;
  }

  const all = await getAllVocab();
  const entry = all.find((e) => e.chars === chars);
  const example = entry?.examples?.[index];
  if (!example) {
    sendResponse({ ok: false, error: "Example not found." });
    return;
  }

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await translateSentence(example.sentence, config);
  if (!result.ok) {
    sendResponse({ ok: false, error: result.error.message });
    return;
  }

  await setExampleTranslation(chars, index, result.translation);
  sendResponse({ ok: true, translation: result.translation });
}

// ─── OCR Message Handling ──────────────────────────────────────────

/**
 * Handles OCR_START (from popup) and OCR_CAPTURE_REQUEST (from content
 * script). These are separate from the PINYIN_REQUEST listener because
 * they follow a different async pattern and don't use sendResponse.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === "RECORD_WORD") {
      const word = message.word as { chars: string; pinyin: string; definition: string };
      const context = typeof message.context === "string" ? message.context : "";
      handleRecordWord(word, context);
      return;
    }

    if (message.type === "REMOVE_WORD") {
      removeWord(message.chars as string);
      return;
    }

    if (message.type === "REMOVE_EXAMPLE") {
      const chars = message.chars as string;
      const index = message.index as number;
      removeExample(chars, index);
      return;
    }

    if (message.type === "ADD_EXAMPLE_TRANSLATION") {
      const chars = message.chars as string;
      const index = message.index as number;
      handleAddExampleTranslation(chars, index, sendResponse);
      // Keep the message channel open for the async response.
      return true;
    }

    if (message.type === "OCR_START") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "OCR_START_SELECTION" });
        }
      });
      return;
    }

    if (message.type === "OCR_CAPTURE_REQUEST") {
      const tabId = sender.tab?.id;
      if (!tabId) return;

      chrome.tabs.captureVisibleTab(
        null as unknown as number,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            chrome.tabs.sendMessage(tabId, {
              type: "PINYIN_ERROR",
              error: chrome.runtime.lastError?.message
                ?? "Failed to capture screenshot",
              phase: "local",
            });
            return;
          }
          chrome.tabs.sendMessage(tabId, {
            type: "OCR_CAPTURE_RESULT",
            dataUrl,
          });
        },
      );
      return;
    }
  },
);

// ─── MV3 Keep-Alive Port ──────────────────────────────────────────

/**
 * Accepts (and silently holds) chrome.runtime.Port connections opened
 * by content scripts for the duration of long-running LLM requests.
 * Chrome keeps the MV3 service worker alive as long as at least one
 * port remains connected, so a 30+ second LLM generation no longer
 * risks suspension mid-fetch (which used to manifest as silent
 * dropped responses). chrome.runtime tracks the port lifetime
 * internally; we just need a listener to be registered, otherwise
 * incoming connections close immediately.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  // No-op: holding the listener registration is sufficient. The port
  // disconnects when the content script calls port.disconnect() or
  // when the originating tab navigates / closes.
});

// ─── Context Menu ──────────────────────────────────────────────────

/**
 * Creates the right-click "Show Pinyin & Translation" menu item
 * on first install and on extension updates. Only appears when
 * the user has text selected. (SPEC.md Section 2.6)
 *
 * Also runs cache eviction to clean up expired / over-limit entries
 * that may have accumulated since the last install or update.
 * (SPEC.md Section 6 "Caching", IMPLEMENTATION_GUIDE.md Step 5b)
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "show-pinyin",
    title: "Show Pinyin & Translation",
    contexts: ["selection"],
  });

  evictExpiredEntries();
});

/**
 * Forwards the right-clicked selection text to the content script
 * so it can run the same pinyin/overlay flow as a mouseup selection.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "show-pinyin" && info.selectionText && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "CONTEXT_MENU_TRIGGER",
      text: info.selectionText,
    });
  }
});

// ─── Keyboard Command ──────────────────────────────────────────────

/**
 * Handles the Alt+Shift+P shortcut defined in manifest.json.
 * Sends COMMAND_TRIGGER to the active tab so the content script
 * can process the current selection. (SPEC.md Section 2.6)
 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "show-pinyin" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "COMMAND_TRIGGER" });
  }
});
