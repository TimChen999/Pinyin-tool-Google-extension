/**
 * Two-tier popup for the click-flow.
 *
 * Layout:
 *  - Word tier:     pinyin + (optional) gloss + +Vocab + close button
 *  - Sentence tier: English translation only (the original sentence is
 *                   visible on the page, highlighted by page-highlight.ts)
 *
 * Lives in the same Shadow DOM as the legacy overlay (`#hg-extension-root`)
 * so style isolation is shared, but uses its own root container element
 * `.pt-popup` so the legacy overlay (`.hg-overlay`) can still be opened
 * independently by the OCR / context-menu paths without interaction.
 *
 * State transitions:
 *  - showBootstrap()  -- word tier from CC-CEDICT, sentence tier "Translating..."
 *  - upgradeWord()    -- word tier with LLM contextual data
 *  - setSentenceText()-- sentence tier with the latest translation
 *  - setSentenceError -- inline error in the sentence tier
 *  - dismiss()        -- removes the popup and clears highlights via callback
 */

import overlayStyles from "./overlay.css?inline";
import type { Theme } from "../shared/types";
import {
  formatPinyin,
  lookupExact,
} from "../shared/cedict-lookup";
import type { CedictHit } from "../shared/cedict-types";

// ─── Module state ──────────────────────────────────────────────────

let shadowRoot: ShadowRoot | null = null;
let hostElement: HTMLElement | null = null;
let popupEl: HTMLElement | null = null;
let onDismiss: (() => void) | null = null;
let vocabCallback:
  | ((
      word: { chars: string; pinyin: string; definition: string },
      context: string,
    ) => void)
  | null = null;
let currentSentenceText = "";

// ─── Public API ────────────────────────────────────────────────────

export function setClickPopupVocabCallback(
  cb: (
    word: { chars: string; pinyin: string; definition: string },
    context: string,
  ) => void,
): void {
  vocabCallback = cb;
}

/**
 * Registers a callback fired when the popup dismisses itself (via
 * the close button or Escape). Lets the content script clear page
 * highlights that the popup itself doesn't own.
 */
export function setClickPopupDismissHandler(cb: () => void): void {
  onDismiss = cb;
}

export interface ShowBootstrapArgs {
  word: {
    chars: string;
    pinyin: string;
    gloss: string;
  };
  sentence: string;
  /** Position of the clicked word on screen (used to anchor the popup). */
  anchorRect: DOMRect;
  theme: Theme;
  fontSize: number;
  /** True when LLM enrichment is on its way (sentence tier shows spinner). */
  expectLlm: boolean;
  /** True when the on-device translator can fill the sentence tier. */
  expectBootstrapTranslation: boolean;
}

/**
 * Renders the popup in Bootstrap state: word tier from CC-CEDICT,
 * sentence tier waiting for translation. Replaces any prior popup.
 */
export function showBootstrap(args: ShowBootstrapArgs): void {
  const root = ensureRoot();
  removeExistingPopup();

  if (hostElement) {
    hostElement.style.setProperty("--hg-font-size", `${args.fontSize}px`);
  }

  const resolvedTheme = resolveTheme(args.theme);

  const popup = document.createElement("div");
  popup.className = `pt-popup hg-${resolvedTheme}`;

  // Word tier
  const wordTier = document.createElement("div");
  wordTier.className = "pt-word-tier";
  wordTier.appendChild(makeWordHeader(args.word));
  if (args.word.gloss) {
    const gloss = document.createElement("div");
    gloss.className = "pt-gloss";
    gloss.textContent = args.word.gloss;
    wordTier.appendChild(gloss);
  }
  wordTier.appendChild(makeActionsRow(args.word, args.sentence));
  popup.appendChild(wordTier);

  // Sentence tier
  const sentTier = document.createElement("div");
  sentTier.className = "pt-sent-tier";
  if (args.expectLlm || args.expectBootstrapTranslation) {
    sentTier.classList.add("pt-loading");
    sentTier.textContent = "Translating sentence…";
  } else {
    sentTier.classList.add("pt-empty");
    sentTier.textContent =
      "Sentence translation requires AI Translations or Chrome's on-device translator.";
  }
  popup.appendChild(sentTier);

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "pt-close-btn";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => dismiss());
  popup.appendChild(closeBtn);

  root.appendChild(popup);
  popupEl = popup;
  currentSentenceText = args.sentence;

  positionPopup(popup, args.anchorRect);
}

/**
 * Replaces the word tier with LLM-contextual data after the LLM lands
 * for this sentence. If the popup has been dismissed since
 * showBootstrap, this is a no-op.
 */
export function upgradeWord(word: {
  chars: string;
  pinyin: string;
  gloss: string;
}): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-word-tier");
  if (!tier) return;
  const headers = tier.querySelector(".pt-word-header");
  if (headers) {
    headers.replaceWith(makeWordHeader(word));
  }
  let glossEl = tier.querySelector(".pt-gloss") as HTMLElement | null;
  if (word.gloss) {
    if (!glossEl) {
      glossEl = document.createElement("div");
      glossEl.className = "pt-gloss";
      // Insert gloss before actions row.
      const actions = tier.querySelector(".pt-actions");
      tier.insertBefore(glossEl, actions);
    }
    glossEl.textContent = word.gloss;
  } else if (glossEl) {
    glossEl.remove();
  }
  // Update the +Vocab button's payload so saving captures the upgraded
  // data, not the stale Bootstrap one.
  const vocabBtn = tier.querySelector(
    ".pt-add-vocab-btn",
  ) as HTMLButtonElement | null;
  if (vocabBtn) {
    vocabBtn.dataset.chars = word.chars;
    vocabBtn.dataset.pinyin = word.pinyin;
    vocabBtn.dataset.gloss = word.gloss;
  }
}

/**
 * Sets the sentence translation text. `source` is "bootstrap" (Chrome
 * translator) or "llm" — we render them slightly differently so the
 * user can tell which tier they're seeing.
 */
export function setSentenceText(
  text: string,
  source: "bootstrap" | "llm",
): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-sent-tier");
  if (!tier) return;
  tier.classList.remove("pt-loading", "pt-empty", "pt-error");
  tier.classList.toggle("pt-bootstrap", source === "bootstrap");
  tier.classList.toggle("pt-llm", source === "llm");
  tier.textContent = text;
}

export function setSentenceError(message: string): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-sent-tier");
  if (!tier) return;
  // Don't clobber an existing successful translation with an error. The
  // Bootstrap path may have filled the tier and the LLM may then fail —
  // we'd rather keep the bootstrap text and show the error inline.
  if (
    tier.classList.contains("pt-bootstrap") ||
    tier.classList.contains("pt-llm")
  ) {
    return;
  }
  tier.classList.remove("pt-loading", "pt-empty");
  tier.classList.add("pt-error");
  tier.textContent = message;
}

/**
 * Returns true when the popup is currently shown for the given sentence.
 * Used by the content script when a late LLM response arrives — if the
 * sentence has changed, ignore.
 */
export function isShowingSentence(sentence: string): boolean {
  return Boolean(popupEl) && currentSentenceText === sentence;
}

export function dismiss(): void {
  removeExistingPopup();
  popupEl = null;
  currentSentenceText = "";
  if (onDismiss) onDismiss();
}

/** Returns the Shadow-host element so the content script can ignore
 * clicks/mouseups originating inside the popup. */
export function getPopupHostElement(): HTMLElement | null {
  return hostElement;
}

// ─── Internals ─────────────────────────────────────────────────────

function ensureRoot(): ShadowRoot {
  const existing = document.getElementById("hg-extension-root");
  if (existing && existing.shadowRoot) {
    hostElement = existing as HTMLElement;
    shadowRoot = existing.shadowRoot;
    return shadowRoot;
  }
  hostElement = document.createElement("div");
  hostElement.id = "hg-extension-root";
  document.body.appendChild(hostElement);
  shadowRoot = hostElement.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = overlayStyles;
  shadowRoot.appendChild(style);
  return shadowRoot;
}

function removeExistingPopup(): void {
  if (!shadowRoot) return;
  const old = shadowRoot.querySelector(".pt-popup");
  if (old) old.remove();
}

function makeWordHeader(word: {
  chars: string;
  pinyin: string;
  gloss: string;
}): HTMLElement {
  const header = document.createElement("div");
  header.className = "pt-word-header";

  const chars = document.createElement("span");
  chars.className = "pt-chars";
  chars.textContent = word.chars;
  header.appendChild(chars);

  if (word.pinyin) {
    const pinyin = document.createElement("span");
    pinyin.className = "pt-pinyin";
    pinyin.textContent = word.pinyin;
    header.appendChild(pinyin);
  }

  return header;
}

function makeActionsRow(
  word: { chars: string; pinyin: string; gloss: string },
  sentence: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-actions";

  if (vocabCallback) {
    const btn = document.createElement("button");
    btn.className = "pt-add-vocab-btn";
    btn.textContent = "+ Vocab";
    btn.dataset.chars = word.chars;
    btn.dataset.pinyin = word.pinyin;
    btn.dataset.gloss = word.gloss;
    btn.addEventListener("click", () => {
      const chars = btn.dataset.chars ?? word.chars;
      const pinyin = btn.dataset.pinyin ?? word.pinyin;
      const gloss = btn.dataset.gloss ?? word.gloss;
      if (!chars || !gloss) return;
      vocabCallback!(
        { chars, pinyin, definition: gloss },
        sentence,
      );
      btn.textContent = "Added";
      btn.classList.add("pt-added");
      btn.disabled = true;
    });
    row.appendChild(btn);
  }

  // Optional: a CC-CEDICT "more readings" button — collapsed for now
  // unless we detect homographs. Lookup once at row build.
  const others = lookupExact(word.chars);
  if (others && others.length > 1) {
    const altBtn = document.createElement("button");
    altBtn.className = "pt-alt-btn";
    altBtn.textContent = `${others.length} readings`;
    altBtn.title = "Show all dictionary readings";
    altBtn.addEventListener("click", () => toggleAltReadings(altBtn, others));
    row.appendChild(altBtn);
  }

  return row;
}

function toggleAltReadings(btn: HTMLElement, hits: ReturnType<typeof lookupExact> extends infer R ? R : never): void {
  if (!hits) return;
  const tier = btn.closest(".pt-word-tier");
  if (!tier) return;
  const existing = tier.querySelector(".pt-alt-list");
  if (existing) {
    existing.remove();
    return;
  }
  const list = document.createElement("ul");
  list.className = "pt-alt-list";
  for (const entry of hits) {
    const li = document.createElement("li");
    const ph = document.createElement("span");
    ph.className = "pt-alt-pinyin";
    ph.textContent = formatPinyin(entry.pinyinNumeric, "toneMarks");
    const def = document.createElement("span");
    def.className = "pt-alt-def";
    def.textContent = entry.definitions.slice(0, 2).join("; ");
    li.appendChild(ph);
    li.appendChild(document.createTextNode(" — "));
    li.appendChild(def);
    list.appendChild(li);
  }
  tier.appendChild(list);
}

/**
 * Positions the popup near the click. Prefers below the clicked word;
 * falls back to above when there isn't enough space. Clamps within the
 * viewport horizontally.
 */
function positionPopup(popup: HTMLElement, rect: DOMRect): void {
  const gap = 8;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  // Pre-measure: the popup is now in the DOM; measure its size.
  const popupRect = popup.getBoundingClientRect();
  const w = popupRect.width || 320;
  const h = popupRect.height || 100;

  let top: number;
  if (rect.bottom + gap + h <= vpH) {
    top = rect.bottom + gap;
  } else if (rect.top - gap - h >= 0) {
    top = rect.top - gap - h;
  } else {
    top = Math.max(gap, vpH - h - gap);
  }

  const idealLeft = rect.left + rect.width / 2 - w / 2;
  const left = Math.max(gap, Math.min(idealLeft, vpW - w - gap));

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

function resolveTheme(theme: Theme): "light" | "dark" | "sepia" {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Builds the Bootstrap word-tier display from a CC-CEDICT longest-match.
 * Picks the first entry's pinyin + first definition slot.
 */
export function bootstrapWordFromHit(
  hit: CedictHit,
  pinyinStyle: "toneMarks" | "toneNumbers" | "none",
): { chars: string; pinyin: string; gloss: string } {
  const entry = hit.entries[0];
  const pinyin = formatPinyin(entry.pinyinNumeric, pinyinStyle);
  // Combine the first 2-3 definitions for a richer view, since CC-CEDICT
  // often splits subtle senses across slots.
  const gloss = entry.definitions.slice(0, 3).join("; ");
  return { chars: hit.word, pinyin, gloss };
}
