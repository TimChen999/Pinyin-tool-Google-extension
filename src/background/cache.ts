/**
 * LLM response cache backed by chrome.storage.local.
 *
 * Sits between the service worker and the LLM client: the service worker
 * checks the cache before calling queryLLM(), and saves the result after
 * a successful call.  This avoids redundant API calls when the user
 * re-selects the same text on a page.
 *
 * Cache keys are SHA-256 hex hashes of (text + context), so identical
 * text in different surrounding paragraphs gets separate entries with
 * contextually correct definitions.  Entries expire after CACHE_TTL_MS
 * (7 days) and the total count is capped at MAX_CACHE_ENTRIES (5 000).
 *
 * See: SPEC.md Section 6 "Caching" for the caching design,
 *      IMPLEMENTATION_GUIDE.md Step 5 for implementation details.
 */

import type { LLMResponse } from "./llm-client";
import { CACHE_TTL_MS, MAX_CACHE_ENTRIES } from "../shared/constants";

// ─── Cache Entry Shape ─────────────────────────────────────────────

interface CacheEntry {
  data: LLMResponse;
  timestamp: number;
}

// ─── Key Generation ────────────────────────────────────────────────

/**
 * Produces a deterministic hex cache key from arbitrary input text.
 * Uses the Web Crypto API (available in service workers) to SHA-256
 * hash the UTF-8 encoded input, then converts the digest to hex.
 */
export async function hashText(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Cache Read ────────────────────────────────────────────────────

/**
 * Retrieves a cached LLM response if the entry exists and hasn't
 * expired.  Lazily removes stale entries on read so a full eviction
 * scan isn't needed on every lookup.
 */
export async function getFromCache(key: string): Promise<LLMResponse | null> {
  const result = await chrome.storage.local.get(key);
  const entry: CacheEntry | undefined = result[key];

  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.data;
}

// ─── Cache Write ───────────────────────────────────────────────────

/**
 * Persists an LLM response with the current timestamp.
 * Overwrites any previous entry for the same key.
 */
export async function saveToCache(
  key: string,
  data: LLMResponse,
): Promise<void> {
  const entry: CacheEntry = { data, timestamp: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
}

// ─── Bulk Eviction ─────────────────────────────────────────────────

/**
 * Two-pass housekeeping intended to run on extension install/update:
 *  1. Remove every entry whose timestamp is older than CACHE_TTL_MS.
 *  2. If the remaining count still exceeds MAX_CACHE_ENTRIES, drop the
 *     oldest entries until the limit is satisfied.
 */
export async function evictExpiredEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  if (!all || typeof all !== "object") return;
  const now = Date.now();

  const expiredKeys: string[] = [];
  const validEntries: { key: string; timestamp: number }[] = [];

  for (const [key, value] of Object.entries(all)) {
    const entry = value as CacheEntry;
    if (!entry || typeof entry.timestamp !== "number") continue;

    if (now - entry.timestamp > CACHE_TTL_MS) {
      expiredKeys.push(key);
    } else {
      validEntries.push({ key, timestamp: entry.timestamp });
    }
  }

  if (expiredKeys.length > 0) {
    await chrome.storage.local.remove(expiredKeys);
  }

  if (validEntries.length > MAX_CACHE_ENTRIES) {
    validEntries.sort((a, b) => a.timestamp - b.timestamp);
    const excess = validEntries.length - MAX_CACHE_ENTRIES;
    const toRemove = validEntries.slice(0, excess).map((e) => e.key);
    await chrome.storage.local.remove(toRemove);
  }
}

// ─── Full Clear ────────────────────────────────────────────────────

/** Wipes every entry in chrome.storage.local (settings live in sync). */
export async function clearCache(): Promise<void> {
  await chrome.storage.local.clear();
}
