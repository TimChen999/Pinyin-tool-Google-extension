/**
 * Click-flow controller — the new interaction model.
 *
 * Hover preview + click commit, backed by:
 *  - CC-CEDICT longest-match (offline) for instant word boundaries.
 *  - Chrome on-device translator for instant Bootstrap sentence translation.
 *  - LLM round-trip via the service worker for the contextual upgrade
 *    (Hot state) — better word boundaries, contextual pinyin/gloss,
 *    polished sentence translation.
 *
 * Per-sentence state machine: Cold → Bootstrap → Hot. Once Hot, hover
 * boundaries within that sentence come from the LLM's `words` array
 * instead of CC-CEDICT longest-match.
 *
 * See: .claude/ARCHITECTURE_REDESIGN.md sections 3-15.
 */

import {
  ensureDictionaryLoaded,
  findLongest,
  formatPinyin,
  isDictionaryReady,
  lookupExact,
} from "../shared/cedict-lookup";
import {
  caretFromPoint,
  buildTextRange,
  type CaretPosition,
} from "./caret-from-point";
import { detectSentence, type SentenceResult } from "./sentence-detect";
import {
  clearAllHighlights,
  clearWordHighlights,
  ensureHighlightStylesInjected,
  highlightApiAvailable,
  setHoverHighlight,
  setSentenceHighlight,
  setWordHighlight,
} from "./page-highlight";
import {
  bootstrapWordFromHit,
  dismiss as dismissPopup,
  getPopupHostElement,
  isShowingSentence,
  setClickPopupDismissHandler,
  setSentenceError,
  setSentenceText,
  showBootstrap,
  upgradeWord,
} from "./click-popup";
import {
  isTranslatorAvailable,
  prewarmTranslator,
  translateChineseToEnglish,
} from "../shared/translate-example";
import { containsChinese } from "../shared/chinese-detect";
import type {
  ExtensionMessage,
  LLMSentenceWord,
  PinyinStyle,
  SentenceTranslateResponseLLM,
  Theme,
} from "../shared/types";

// ─── Settings cache (mirrored from content.ts) ─────────────────────

interface ClickFlowSettings {
  theme: Theme;
  fontSize: number;
  pinyinStyle: PinyinStyle;
  llmEnabled: boolean;
  /** Master switch for the click flow. When false, only the legacy
   *  selection / context-menu / shortcut paths fire. */
  clickFlowEnabled: boolean;
}

let settings: ClickFlowSettings = {
  theme: "auto",
  fontSize: 16,
  pinyinStyle: "toneMarks",
  llmEnabled: true,
  clickFlowEnabled: true,
};

export function setClickFlowSettings(next: Partial<ClickFlowSettings>): void {
  settings = { ...settings, ...next };
}

// ─── Per-sentence state ────────────────────────────────────────────

type SentenceState =
  | { kind: "bootstrap" }
  | {
      kind: "hot";
      words: LLMSentenceWord[];
      translation: string;
    };

/** All sentences engaged in this tab. Persists for the page session. */
const sentenceStates = new Map<string, SentenceState>();

/** The sentence currently shown in the popup. Used to drop late LLM responses. */
let currentSentence = "";
let currentRequestId = 0;

// ─── Init ──────────────────────────────────────────────────────────

let initialized = false;

export function initClickFlow(): void {
  if (initialized) return;
  initialized = true;

  ensureHighlightStylesInjected();
  // Warm both dictionary + translator off the critical path.
  void ensureDictionaryLoaded().catch((err) => {
    console.error("[click-flow] Failed to load CC-CEDICT:", err);
  });
  if (isTranslatorAvailable()) {
    void prewarmTranslator();
  }

  setClickPopupDismissHandler(() => {
    clearAllHighlights();
  });

  document.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("keydown", onKeyDown, { capture: true });

  chrome.runtime.onMessage.addListener(onMessage);
}

// ─── Mouse move (hover preview) ────────────────────────────────────

let pendingHoverFrame = 0;
let lastHoverEvent: MouseEvent | null = null;

function onMouseMove(ev: MouseEvent): void {
  if (!settings.clickFlowEnabled) return;
  if (!highlightApiAvailable()) return;

  // Ignore moves over our own popup so the hover doesn't churn while the
  // user reads it.
  const host = getPopupHostElement();
  if (host && host.contains(ev.target as Node)) {
    setHoverHighlight(null);
    return;
  }

  lastHoverEvent = ev;
  if (pendingHoverFrame) return;
  pendingHoverFrame = requestAnimationFrame(() => {
    pendingHoverFrame = 0;
    const e = lastHoverEvent;
    lastHoverEvent = null;
    if (!e) return;
    handleHover(e);
  });
}

function handleHover(ev: MouseEvent): void {
  const caret = caretFromPoint(ev.clientX, ev.clientY);
  if (!caret || caret.kind !== "text") {
    setHoverHighlight(null);
    return;
  }

  const range = previewRangeForCaret(caret);
  setHoverHighlight(range);
}

/**
 * Builds the range that should be hover-highlighted for a caret position.
 * Uses LLM word boundaries when the surrounding sentence is Hot;
 * otherwise CC-CEDICT longest-match; otherwise a single-character span.
 */
function previewRangeForCaret(caret: CaretPosition): Range | null {
  const text = caret.text;
  const offset = caret.offset;
  if (offset >= text.length) return null;
  if (!containsChinese(text[offset])) return null;

  // Hot path: if we have an LLM segmentation for the sentence the caret
  // lives in, use those boundaries.
  const sentence = detectSentence(caret.node as Text, offset);
  if (sentence) {
    const state = sentenceStates.get(sentence.text);
    if (state && state.kind === "hot") {
      const slot = findLlmWordAtOffset(state.words, sentence.text, offset, text);
      if (slot) {
        return buildTextRange(
          caret.node as Text,
          slot.startInTextNode,
          slot.endInTextNode,
        );
      }
    }
  }

  // Bootstrap: CC-CEDICT longest-match.
  if (isDictionaryReady()) {
    const slice = text.slice(offset);
    const hit = findLongest(slice);
    if (hit) {
      return buildTextRange(
        caret.node as Text,
        offset,
        offset + hit.length,
      );
    }
  }

  // Fallback: single-character preview.
  return buildTextRange(caret.node as Text, offset, offset + 1);
}

interface LlmSlot {
  word: LLMSentenceWord;
  startInTextNode: number;
  endInTextNode: number;
}

/**
 * Maps the caret's text-node offset to the LLM word it falls inside.
 *
 * The LLM segmentation is over the *sentence string*, but the caret
 * offset is into the *text node*. They line up only when the whole
 * sentence is in one text node — which is the common case but not
 * guaranteed. For a simple, robust mapping we find the offset of the
 * sentence in the text node first, then walk LLM words.
 */
function findLlmWordAtOffset(
  words: LLMSentenceWord[],
  sentence: string,
  caretOffsetInTextNode: number,
  textNodeData: string,
): LlmSlot | null {
  const sentStart = textNodeData.indexOf(sentence);
  if (sentStart < 0) return null;
  const within = caretOffsetInTextNode - sentStart;
  if (within < 0 || within >= sentence.length) return null;

  let cursor = 0;
  for (const w of words) {
    const next = cursor + w.text.length;
    if (within >= cursor && within < next) {
      return {
        word: w,
        startInTextNode: sentStart + cursor,
        endInTextNode: sentStart + next,
      };
    }
    cursor = next;
  }
  return null;
}

// ─── Click (commit) ────────────────────────────────────────────────

function onClick(ev: MouseEvent): void {
  if (!settings.clickFlowEnabled) return;
  // Let clicks inside our own popup keep their default behaviour.
  const host = getPopupHostElement();
  if (host && host.contains(ev.target as Node)) return;

  // We only handle primary-button clicks.
  if (ev.button !== 0) return;

  const caret = caretFromPoint(ev.clientX, ev.clientY);
  if (!caret || caret.kind !== "text") return;
  if (caret.offset >= caret.text.length) return;
  if (!containsChinese(caret.text[caret.offset])) return;

  // We are committing — prevent the page's own click handlers (links,
  // page-level menus) from running.
  ev.preventDefault();
  ev.stopPropagation();

  void commitClick(caret).catch((err) => {
    console.error("[click-flow] commit failed:", err);
  });
}

async function commitClick(caret: CaretPosition): Promise<void> {
  const sentence = detectSentence(caret.node as Text, caret.offset);
  if (!sentence) return;

  // Pick the word range using current state for this sentence.
  const wordRange = pickWordRangeOnClick(caret, sentence);
  if (!wordRange) return;

  const word = wordRange.toString();
  if (!word) return;

  // Prepare Bootstrap word data (CC-CEDICT) + sentence highlight.
  const bootstrapWord = buildBootstrapWord(word);

  setWordHighlight(wordRange);
  setSentenceHighlight(sentence.range);
  // Hover follows the cursor afterwards; clear the stale hover paint.
  setHoverHighlight(null);

  const expectLlm = settings.llmEnabled;
  const expectBootstrapTranslation = isTranslatorAvailable();

  const wordRect = wordRange.getBoundingClientRect();
  showBootstrap({
    word: bootstrapWord,
    sentence: sentence.text,
    anchorRect: wordRect,
    theme: settings.theme,
    fontSize: settings.fontSize,
    expectLlm,
    expectBootstrapTranslation,
  });

  currentSentence = sentence.text;
  const requestId = ++currentRequestId;

  const existingState = sentenceStates.get(sentence.text);
  if (!existingState) {
    sentenceStates.set(sentence.text, { kind: "bootstrap" });
  }

  // If the sentence is already Hot (cached from earlier in this tab),
  // skip both the Bootstrap translator and the network round-trip.
  if (existingState && existingState.kind === "hot") {
    applyHotData(existingState.words, existingState.translation, sentence.text, word);
    return;
  }

  // Bootstrap sentence translation via on-device translator (when
  // available). Doesn't affect state — we don't promote to Hot here.
  if (expectBootstrapTranslation) {
    void translateChineseToEnglish(sentence.text).then((res) => {
      if (!isShowingSentence(sentence.text)) return;
      // Don't overwrite an LLM result if it landed first.
      const state = sentenceStates.get(sentence.text);
      if (state && state.kind === "hot") return;
      if (res.ok) setSentenceText(res.translation, "bootstrap");
    });
  }

  // Ask the SW for the Hot upgrade.
  if (expectLlm) {
    chrome.runtime.sendMessage({
      type: "SENTENCE_TRANSLATE_REQUEST",
      sentence: sentence.text,
      pinyinStyle: settings.pinyinStyle,
      requestId,
    });
  }
}

function pickWordRangeOnClick(
  caret: CaretPosition,
  sentence: SentenceResult,
): Range | null {
  const node = caret.node as Text;
  const text = caret.text;
  const offset = caret.offset;

  const state = sentenceStates.get(sentence.text);
  if (state && state.kind === "hot") {
    const slot = findLlmWordAtOffset(state.words, sentence.text, offset, text);
    if (slot) {
      return buildTextRange(node, slot.startInTextNode, slot.endInTextNode);
    }
  }

  if (isDictionaryReady()) {
    const slice = text.slice(offset);
    const hit = findLongest(slice);
    if (hit) {
      return buildTextRange(node, offset, offset + hit.length);
    }
  }

  return buildTextRange(node, offset, offset + 1);
}

function buildBootstrapWord(word: string): {
  chars: string;
  pinyin: string;
  gloss: string;
} {
  const entries = lookupExact(word);
  if (entries && entries.length > 0) {
    const hit = { word, length: word.length, entries };
    return bootstrapWordFromHit(hit, settings.pinyinStyle);
  }
  // Single character that wasn't in the dictionary; pick a degraded
  // representation so the popup still has something useful.
  return {
    chars: word,
    pinyin: "",
    gloss: isDictionaryReady()
      ? "(no dictionary entry)"
      : "(loading dictionary…)",
  };
}

// ─── Incoming messages ─────────────────────────────────────────────

function onMessage(message: ExtensionMessage): void {
  if (message.type === "SENTENCE_TRANSLATE_RESPONSE_LLM") {
    handleSentenceLLM(message);
    return;
  }
  if (message.type === "SENTENCE_TRANSLATE_ERROR") {
    if (message.requestId === currentRequestId && currentSentence === message.sentence) {
      setSentenceError(message.error);
    }
    return;
  }
}

function handleSentenceLLM(msg: SentenceTranslateResponseLLM): void {
  // Cache regardless of whether it's still showing — we want it for
  // future clicks in this tab.
  sentenceStates.set(msg.sentence, {
    kind: "hot",
    words: msg.words,
    translation: msg.translation,
  });

  if (!isShowingSentence(msg.sentence)) return;
  if (msg.requestId !== currentRequestId) return;

  // Find the clicked word in the LLM's segmentation. We don't know the
  // caret offset anymore at this point; we use the word currently shown
  // in the popup as the lookup key.
  const popupWord = currentClickedWord();
  if (popupWord) {
    const match = msg.words.find((w) => w.text === popupWord);
    if (match) {
      const formattedPinyin = match.pinyin
        ? // The LLM returned a pre-formatted pinyin string already in the
          // requested style; pass through. Falling back to CC-CEDICT
          // formatting here would assume CC-CEDICT input which we don't
          // have.
          match.pinyin
        : "";
      upgradeWord({
        chars: match.text,
        pinyin: formattedPinyin,
        gloss: match.gloss,
      });
    }
  }

  setSentenceText(msg.translation, "llm");
}

function currentClickedWord(): string | null {
  // Read the chars from the popup's word header. The popup renders it
  // via `.pt-chars` so we extract from there. This avoids threading
  // another piece of state through commitClick.
  const host = getPopupHostElement();
  if (!host || !host.shadowRoot) return null;
  const charsEl = host.shadowRoot.querySelector(".pt-popup .pt-chars");
  return charsEl ? charsEl.textContent : null;
}

function applyHotData(
  words: LLMSentenceWord[],
  translation: string,
  sentence: string,
  clickedWord: string,
): void {
  const match = words.find((w) => w.text === clickedWord);
  if (match) {
    upgradeWord({
      chars: match.text,
      pinyin: match.pinyin || formatPinyin("", settings.pinyinStyle),
      gloss: match.gloss,
    });
  }
  setSentenceText(translation, "llm");
  // Make sure state is up to date.
  sentenceStates.set(sentence, { kind: "hot", words, translation });
}

// ─── Keyboard ──────────────────────────────────────────────────────

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    // Only dismiss if our popup is actually showing.
    const host = getPopupHostElement();
    if (host && host.shadowRoot && host.shadowRoot.querySelector(".pt-popup")) {
      dismissPopup();
    }
  }
}

// ─── Manual dismiss (used by the content script when a click outside
//     the popup happens through a non-text path) ────────────────────

export function dismissClickFlow(): void {
  dismissPopup();
}

// Suppress unused-import warning for formatPinyin if the LLM always
// returns formatted pinyin. We keep the import because the fallback
// branch above may reference it and tree-shake on the production build.
void formatPinyin;
