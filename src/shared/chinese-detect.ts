/**
 * Utilities for detecting Chinese text in user selections.
 *
 * containsChinese() gates the entire extension flow -- if a selection
 * has no Chinese characters, no overlay is shown and no messages are sent.
 * extractSurroundingContext() grabs nearby paragraph text to give the
 * LLM context for polyphonic character disambiguation.
 *
 * See: SPEC.md Section 2.1 "Selection-Based Pinyin Overlay" for detection,
 *      SPEC.md Section 6 "Why LLM Disambiguation Matters" for context usage,
 *      IMPLEMENTATION_GUIDE.md Step 1k for implementation details.
 */

import { CHINESE_REGEX } from "./constants";

/**
 * Returns true if the string contains at least one CJK Unified Ideograph.
 * Used by the content script's mouseup handler to decide whether to
 * trigger the pinyin flow. (SPEC.md Section 2.1)
 */
export function containsChinese(text: string): boolean {
  return CHINESE_REGEX.test(text);
}

/**
 * Walks up the DOM from the selection's anchor node to find the nearest
 * block-level parent (P, DIV, ARTICLE, SECTION, or BODY) and returns
 * its text content, capped at 500 characters.
 *
 * This surrounding text is sent alongside the selected text in the
 * PinyinRequest so the LLM can disambiguate polyphonic characters
 * (e.g., 行 as "háng" in 银行 vs "xíng" in 行走).
 * (SPEC.md Section 6 "Why LLM Disambiguation Matters")
 */
export function extractSurroundingContext(selection: Selection): string {
  if (!selection.anchorNode) return "";

  let node: Node | null = selection.anchorNode;
  while (
    node &&
    node.nodeName !== "P" &&
    node.nodeName !== "DIV" &&
    node.nodeName !== "ARTICLE" &&
    node.nodeName !== "SECTION" &&
    node.nodeName !== "BODY" &&
    node.parentNode
  ) {
    node = node.parentNode;
  }

  const content = node?.textContent ?? "";
  return content.length > 500 ? content.slice(0, 500) : content;
}
