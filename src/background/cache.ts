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

import type { LLMResponse, LLMError, LLMErrorCode } from "./llm-client";
import {
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  NEGATIVE_CACHE_TTL_MS,
} from "../shared/constants";

// ─── Cache Entry Shape ─────────────────────────────────────────────

/**
 * Stored cache entry. The same map holds two kinds of entries:
 *  - "ok"  -> a successful LLMResponse (the historical case)
 *  - "err" -> a brief negative cache for LLMError, used to throttle
 *             repeat calls during rate-limit windows so re-clicks
 *             don't hammer the provider.
 *
 * `kind` is optional for backward compatibility: pre-existing entries
 * written before this field existed have no `kind` and are interpreted
 * as "ok". A per-entry `ttlMs` lets negative entries expire faster than
 * the global CACHE_TTL_MS (e.g. 30 s for RATE_LIMITED).
 */
interface CacheEntry {
  kind?: "ok" | "err";
  data?: LLMResponse;
  error?: LLMError;
  timestamp: number;
  ttlMs?: number;
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
 * Returns the entry's effective TTL: a per-entry override if set,
 * otherwise the global CACHE_TTL_MS.
 */
function effectiveTtl(entry: CacheEntry): number {
  return typeof entry.ttlMs === "number" ? entry.ttlMs : CACHE_TTL_MS;
}

/**
 * Retrieves a cached *successful* LLM response if the entry exists,
 * is of the right kind, and hasn't expired. Negative entries are
 * skipped here; use getCachedError() for those. Lazily removes stale
 * entries on read so a full eviction scan isn't needed every lookup.
 */
export async function getFromCache(key: string): Promise<LLMResponse | null> {
  const result = await chrome.storage.local.get(key);
  const entry = result[key] as CacheEntry | undefined;

  if (!entry) return null;

  if (Date.now() - entry.timestamp > effectiveTtl(entry)) {
    await chrome.storage.local.remove(key);
    return null;
  }

  // Treat legacy entries (no `kind`) as ok-entries; their `data` is set.
  const kind = entry.kind ?? "ok";
  if (kind !== "ok" || !entry.data) return null;

  return entry.data;
}

/**
 * Returns a cached error for `key` only if a non-expired negative
 * entry exists. This lets handlers short-circuit rapid re-attempts
 * during throttle windows without hammering the provider. Negative
 * entries are only ever written for codes listed in
 * NEGATIVE_CACHE_TTL_MS (today: RATE_LIMITED for 30 s).
 */
export async function getCachedError(key: string): Promise<LLMError | null> {
  const result = await chrome.storage.local.get(key);
  const entry = result[key] as CacheEntry | undefined;

  if (!entry) return null;
  if (entry.kind !== "err" || !entry.error) return null;

  if (Date.now() - entry.timestamp > effectiveTtl(entry)) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.error;
}

// ─── Cache Write ───────────────────────────────────────────────────

/**
 * Persists an LLM response with the current timestamp.
 * Overwrites any previous entry for the same key.
 *
 * Callers should *not* call this for partial (salvaged) responses --
 * that would freeze a degraded result in place for a week.
 */
export async function saveToCache(
  key: string,
  data: LLMResponse,
): Promise<void> {
  const entry: CacheEntry = { kind: "ok", data, timestamp: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
}

/**
 * Persists an LLMError briefly so subsequent identical requests can
 * short-circuit without re-issuing the network call. Honors the
 * NEGATIVE_CACHE_TTL_MS allow-list: error codes not present there
 * are silently skipped (no entry written), so a TIMEOUT / NETWORK_ERROR
 * does not freeze the user out of retrying.
 */
export async function saveErrorToCache(
  key: string,
  error: LLMError,
): Promise<void> {
  const ttlMs = NEGATIVE_CACHE_TTL_MS[error.code as LLMErrorCode];
  if (typeof ttlMs !== "number") return;

  const entry: CacheEntry = {
    kind: "err",
    error,
    timestamp: Date.now(),
    ttlMs,
  };
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

    if (now - entry.timestamp > effectiveTtl(entry)) {
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
