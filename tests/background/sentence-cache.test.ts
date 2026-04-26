import { beforeEach, describe, expect, it } from "vitest";

import {
  getSentenceFromCache,
  hashSentenceKey,
  saveSentenceToCache,
} from "../../src/background/sentence-cache";
import { mock } from "../test-helpers";

let store: Map<string, unknown>;

function setupStorageMocks(): void {
  store = new Map();

  mock(chrome.storage.local.get).mockImplementation(
    (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        const all: Record<string, unknown> = {};
        store.forEach((v, k) => (all[k] = v));
        return Promise.resolve(all);
      }
      const keyList =
        typeof keys === "string"
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys as object);
      const result: Record<string, unknown> = {};
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return Promise.resolve(result);
    },
  );

  mock(chrome.storage.local.set).mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
      return Promise.resolve();
    },
  );

  mock(chrome.storage.local.remove).mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );

  mock(chrome.storage.local.clear).mockImplementation(() => {
    store.clear();
    return Promise.resolve();
  });
}

beforeEach(() => {
  setupStorageMocks();
});

describe("hashSentenceKey", () => {
  it("produces a stable, prefixed hash", async () => {
    const a = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o-mini");
    const b = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o-mini");
    expect(a).toBe(b);
    expect(a.startsWith("sent:")).toBe(true);
  });

  it("differs across pinyin styles", async () => {
    const a = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o-mini");
    const b = await hashSentenceKey("你好。", "none", "openai", "gpt-4o-mini");
    expect(a).not.toBe(b);
  });

  it("differs across providers/models", async () => {
    const a = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o-mini");
    const b = await hashSentenceKey("你好。", "toneMarks", "gemini", "gpt-4o-mini");
    const c = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("get/saveSentenceToCache", () => {
  it("round-trips a payload", async () => {
    const key = await hashSentenceKey("你好。", "toneMarks", "openai", "gpt-4o-mini");
    await saveSentenceToCache(key, {
      translation: "Hello.",
      words: [
        { text: "你好", pinyin: "nǐ hǎo", gloss: "hello" },
        { text: "。", pinyin: "", gloss: "" },
      ],
    });

    const back = await getSentenceFromCache(key);
    expect(back?.translation).toBe("Hello.");
    expect(back?.words).toHaveLength(2);
    expect(back?.words[0].gloss).toBe("hello");
  });

  it("returns null for missing keys", async () => {
    const back = await getSentenceFromCache("sent:does-not-exist");
    expect(back).toBeNull();
  });
});
