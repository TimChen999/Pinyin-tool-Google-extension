/**
 * CSS Custom Highlight API controller for the click-flow.
 *
 * Three named highlights live on the document:
 *  - "pt-hover"    -- follows the cursor; lightest tint
 *  - "pt-word"     -- the clicked word; saturated tint
 *  - "pt-sentence" -- the surrounding sentence of the clicked word; lighter tint
 *
 * Operations are cheap because the API paints ranges directly without
 * mutating the DOM. That means we don't risk breaking page event
 * handlers, layout, or the page's own structure.
 *
 * Browser support: Chromium, Firefox 140+, Safari 18+. When the API
 * is missing, all setters are no-ops — the click flow still works,
 * users just don't see the colored backdrop.
 *
 * The highlight color itself is page-CSS-injected in content.ts (we
 * append a <style> tag once with `::highlight(pt-...)` rules).
 */

const HOVER = "pt-hover";
const WORD = "pt-word";
const SENTENCE = "pt-sentence";

interface HighlightLike {
  // The Highlight constructor is `new Highlight(...ranges)`; clear() is
  // called via the same Set-like interface. We type minimally.
  clear(): void;
  add(range: Range): void;
}

interface HighlightRegistry {
  set(name: string, value: HighlightLike): void;
  delete(name: string): boolean;
  has(name: string): boolean;
}

/** True when the browser supports the Custom Highlight API. */
export function highlightApiAvailable(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

function highlightCtor(): (new (range: Range) => HighlightLike) | null {
  const ctor = (globalThis as { Highlight?: new (range: Range) => HighlightLike })
    .Highlight;
  return typeof ctor === "function" ? ctor : null;
}

function highlightsRegistry(): HighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  return (CSS as unknown as { highlights: HighlightRegistry }).highlights;
}

function setOne(name: string, range: Range | null): void {
  const reg = highlightsRegistry();
  const Ctor = highlightCtor();
  if (!reg || !Ctor) return;
  if (range === null) {
    reg.delete(name);
    return;
  }
  reg.set(name, new Ctor(range));
}

/** Replaces (or clears) the hover highlight. Cheap; called from rAF. */
export function setHoverHighlight(range: Range | null): void {
  setOne(HOVER, range);
}

/** Locks the clicked word's highlight. Survives until clearWordHighlights(). */
export function setWordHighlight(range: Range | null): void {
  setOne(WORD, range);
}

/** Locks the sentence highlight (lighter than the word). */
export function setSentenceHighlight(range: Range | null): void {
  setOne(SENTENCE, range);
}

/** Clears word + sentence (locked highlights). Hover is left alone so
 * the user keeps seeing the cursor preview after dismiss. */
export function clearWordHighlights(): void {
  setOne(WORD, null);
  setOne(SENTENCE, null);
}

/** Clears every highlight we set. Called on overlay dismiss. */
export function clearAllHighlights(): void {
  setOne(HOVER, null);
  setOne(WORD, null);
  setOne(SENTENCE, null);
}

const STYLE_ID = "pt-page-highlight-styles";

/**
 * Injects the document-level `::highlight(...)` CSS rules so the
 * Custom Highlight API has something to paint with. Idempotent — safe
 * to call from the content script's init even on multiple loads.
 */
export function ensureHighlightStylesInjected(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(pt-hover)    { background-color: rgba(255, 200, 0, 0.30); }
::highlight(pt-word)     { background-color: rgba(255, 200, 0, 0.55); }
::highlight(pt-sentence) { background-color: rgba(255, 200, 0, 0.18); }
`;
  (document.head ?? document.documentElement).appendChild(style);
}
