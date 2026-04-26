/**
 * Per-sentence LLM cache for the click-flow.
 *
 * Distinct namespace from the existing LLM cache (`background/cache.ts`):
 *  - The legacy cache is keyed by SHA-256 of (text + context) and stores
 *    a full Phase-2 LLM response shape. Used by OCR and context-menu
 *    flows.
 *  - This cache is keyed by SHA-256 of (sentence + pinyinStyle +
 *    provider + model) and stores the new sentence-mode payload (one
 *    translation + one per-word array). Used only by the click flow.
 *
 * Both backends share `chrome.storage.local`. The discriminator is the
 * `kind` field on the entry envelope, set to "sentence-llm" here.
 */

import {
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
} from "../shared/constants";
import type {
  LLMSentenceWord,
  PinyinStyle,
} from "../shared/types";

export interface SentenceCachePayload {
  translation: string;
  words: LLMSentenceWord[];
}

interface SentenceCacheEntry {
  kind: "sentence-llm";
  payload: SentenceCachePayload;
  timestamp: number;
}

/**
 * Hashes a stable cache key. Including style + provider + model means
 * "the same sentence with a different LLM" gets a fresh entry — different
 * models segment differently and hand back different glosses.
 */
export async function hashSentenceKey(
  sentence: string,
  pinyinStyle: PinyinStyle,
  provider: string,
  model: string,
): Promise<string> {
  const composite = `${pinyinStyle}|${provider}|${model}|${sentence}`;
  const encoded = new TextEncoder().encode(composite);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return (
    "sent:" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

export async function getSentenceFromCache(
  key: string,
): Promise<SentenceCachePayload | null> {
  const result = await chrome.storage.local.get(key);
  const entry = result[key] as SentenceCacheEntry | undefined;
  if (!entry || entry.kind !== "sentence-llm") return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.payload;
}

export async function saveSentenceToCache(
  key: string,
  payload: SentenceCachePayload,
): Promise<void> {
  const entry: SentenceCacheEntry = {
    kind: "sentence-llm",
    payload,
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ [key]: entry });

  // Eviction: cheap LRU sample. We don't want to scan all keys on every
  // write, so we sample only when we cross a probabilistic threshold.
  if (Math.random() < 0.05) {
    void evictSentenceOverflow();
  }
}

/**
 * Walks every sentence-cache entry and drops the oldest ones if the
 * total exceeds MAX_CACHE_ENTRIES. The legacy cache module handles its
 * own eviction; we mirror the policy here so the two namespaces stay
 * roughly bounded together (they share the same storage area but have
 * separate count budgets via this prefix scan).
 */
export async function evictSentenceOverflow(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  if (!all || typeof all !== "object") return;
  const entries: { key: string; timestamp: number }[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("sent:")) continue;
    const e = value as SentenceCacheEntry;
    if (!e || e.kind !== "sentence-llm" || typeof e.timestamp !== "number") {
      continue;
    }
    entries.push({ key, timestamp: e.timestamp });
  }
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  entries.sort((a, b) => a.timestamp - b.timestamp);
  const excess = entries.length - MAX_CACHE_ENTRIES;
  const toRemove = entries.slice(0, excess).map((e) => e.key);
  await chrome.storage.local.remove(toRemove);
}
