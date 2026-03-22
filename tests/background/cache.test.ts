import { describe, it, expect, beforeEach } from "vitest";
import {
  hashText,
  getFromCache,
  saveToCache,
  evictExpiredEntries,
  clearCache,
} from "../../src/background/cache";
import { CACHE_TTL_MS, MAX_CACHE_ENTRIES } from "../../src/shared/constants";
import type { LLMResponse } from "../../src/background/llm-client";

// ─── In-Memory Storage Backend ──────────────────────────────────────
// vitest-chrome-mv3 provides bare vi.fn() stubs for chrome.storage.local,
// so we wire up a Map-backed implementation before each test.

let store: Map<string, unknown>;

function setupStorageMocks() {
  store = new Map();

  chrome.storage.local.get.mockImplementation(
    (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        const all: Record<string, unknown> = {};
        store.forEach((v, k) => (all[k] = v));
        return Promise.resolve(all);
      }
      const keyList = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
      const result: Record<string, unknown> = {};
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return Promise.resolve(result);
    },
  );

  chrome.storage.local.set.mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
      return Promise.resolve();
    },
  );

  chrome.storage.local.remove.mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );

  chrome.storage.local.clear.mockImplementation(() => {
    store.clear();
    return Promise.resolve();
  });
}

// ─── Test Fixtures ──────────────────────────────────────────────────

const sampleData: LLMResponse = {
  words: [{ chars: "你", pinyin: "nǐ", definition: "you" }],
  translation: "You",
};

const sampleData2: LLMResponse = {
  words: [{ chars: "好", pinyin: "hǎo", definition: "good" }],
  translation: "Good",
};

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  setupStorageMocks();
});

// ─── hashText ───────────────────────────────────────────────────────

describe("hashText", () => {
  it("returns a hex string", async () => {
    const hash = await hashText("test input");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns consistent hash for same input", async () => {
    const hash1 = await hashText("你好");
    const hash2 = await hashText("你好");
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", async () => {
    const hash1 = await hashText("你好");
    const hash2 = await hashText("世界");
    expect(hash1).not.toBe(hash2);
  });

  it("produces a 64-character SHA-256 hex digest", async () => {
    const hash = await hashText("anything");
    expect(hash).toHaveLength(64);
  });
});

// ─── saveToCache / getFromCache ─────────────────────────────────────

describe("saveToCache / getFromCache", () => {
  it("stores and retrieves data", async () => {
    await saveToCache("test-key", sampleData);
    const result = await getFromCache("test-key");
    expect(result).toEqual(sampleData);
  });

  it("returns null for non-existent key", async () => {
    const result = await getFromCache("non-existent-key");
    expect(result).toBeNull();
  });

  it("returns null for expired entry and removes it", async () => {
    await saveToCache("expired-key", sampleData);

    // Manually backdate the timestamp past the TTL
    const entry = store.get("expired-key") as { data: LLMResponse; timestamp: number };
    entry.timestamp = Date.now() - CACHE_TTL_MS - 1000;
    store.set("expired-key", entry);

    const result = await getFromCache("expired-key");
    expect(result).toBeNull();

    // Verify the stale entry was cleaned up
    expect(store.has("expired-key")).toBe(false);
  });

  it("overwrites previous entry for the same key", async () => {
    await saveToCache("overwrite-key", sampleData);
    await saveToCache("overwrite-key", sampleData2);
    const result = await getFromCache("overwrite-key");
    expect(result).toEqual(sampleData2);
  });
});

// ─── evictExpiredEntries ────────────────────────────────────────────

describe("evictExpiredEntries", () => {
  it("removes expired entries and keeps fresh ones", async () => {
    store.set("old-entry", {
      data: { words: [], translation: "" },
      timestamp: Date.now() - CACHE_TTL_MS - 1000,
    });
    store.set("fresh-entry", {
      data: { words: [], translation: "Fresh" },
      timestamp: Date.now(),
    });

    await evictExpiredEntries();

    expect(store.has("old-entry")).toBe(false);
    expect(store.has("fresh-entry")).toBe(true);
  });

  it("trims oldest entries when count exceeds MAX_CACHE_ENTRIES", async () => {
    const now = Date.now();

    // Create MAX_CACHE_ENTRIES + 3 fresh entries with ascending timestamps
    for (let i = 0; i < MAX_CACHE_ENTRIES + 3; i++) {
      store.set(`key-${String(i).padStart(5, "0")}`, {
        data: { words: [], translation: `t${i}` },
        timestamp: now - (MAX_CACHE_ENTRIES + 3 - i) * 1000,
      });
    }

    await evictExpiredEntries();

    expect(store.size).toBe(MAX_CACHE_ENTRIES);

    // The 3 oldest keys (lowest timestamps) should be gone
    expect(store.has("key-00000")).toBe(false);
    expect(store.has("key-00001")).toBe(false);
    expect(store.has("key-00002")).toBe(false);

    // The newest key should still exist
    const newestKey = `key-${String(MAX_CACHE_ENTRIES + 2).padStart(5, "0")}`;
    expect(store.has(newestKey)).toBe(true);
  });
});

// ─── clearCache ─────────────────────────────────────────────────────

describe("clearCache", () => {
  it("removes all cache entries", async () => {
    await saveToCache("key1", { words: [], translation: "A" } as LLMResponse);
    await saveToCache("key2", { words: [], translation: "B" } as LLMResponse);

    await clearCache();

    expect(await getFromCache("key1")).toBeNull();
    expect(await getFromCache("key2")).toBeNull();
  });
});
