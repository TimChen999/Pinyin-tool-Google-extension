import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { PinyinRequest, PinyinResponseLocal } from "../../src/shared/types";
import { mock } from "../test-helpers";

vi.mock("../../src/background/vocab-store", () => ({
  recordWords: vi.fn(() => Promise.resolve()),
  removeWord: vi.fn(() => Promise.resolve()),
  removeExample: vi.fn(() => Promise.resolve()),
  setExampleTranslation: vi.fn(() => Promise.resolve()),
  getAllVocab: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/background/cache", () => ({
  hashText: vi.fn(() => Promise.resolve("mock-hash")),
  getFromCache: vi.fn(() => Promise.resolve(null)),
  getCachedError: vi.fn(() => Promise.resolve(null)),
  saveToCache: vi.fn(() => Promise.resolve()),
  saveErrorToCache: vi.fn(() => Promise.resolve()),
  evictExpiredEntries: vi.fn(() => Promise.resolve()),
  clearCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/background/llm-client", () => ({
  queryLLM: vi.fn(() => Promise.resolve({ ok: false, error: { code: "UNKNOWN", message: "LLM request failed" } })),
  validateLLMResponse: vi.fn(() => true),
}));

/**
 * vitest-chrome-mv3 does not include chrome.commands in its generated
 * mocks. We patch it in before each test so the service worker's
 * chrome.commands.onCommand.addListener call doesn't throw.
 */
function ensureCommandsMock() {
  if (!(chrome as any).commands) {
    (chrome as any).commands = {};
  }
  if (!(chrome as any).commands.onCommand) {
    const listeners = new Set<Function>();
    (chrome as any).commands.onCommand = {
      addListener: vi.fn((fn: Function) => listeners.add(fn)),
      removeListener: vi.fn((fn: Function) => listeners.delete(fn)),
      hasListener: vi.fn((fn: Function) => listeners.has(fn)),
      hasListeners: vi.fn(() => listeners.size > 0),
      callListeners: vi.fn((...args: unknown[]) => {
        listeners.forEach((fn) => fn(...args));
      }),
      clearListeners: vi.fn(() => listeners.clear()),
    };
  }
}

/**
 * Loads (or re-loads) the service worker module so its top-level
 * addListener calls run against the current set of chrome mocks.
 * Uses vi.resetModules() to bust the module cache.
 */
async function loadServiceWorker() {
  vi.resetModules();
  return import("../../src/background/service-worker");
}

const SAMPLE_REQUEST: PinyinRequest = {
  type: "PINYIN_REQUEST",
  text: "你好",
  context: "朋友说你好",
  selectionRect: { top: 0, left: 0, bottom: 20, right: 50, width: 50, height: 20 },
};

describe("service-worker", () => {
  beforeEach(() => {
    ensureCommandsMock();
    // Mock chrome.storage.sync.get to return empty (=> DEFAULT_SETTINGS)
    mock(chrome.storage.sync.get).mockImplementation(() => Promise.resolve({}));
    // Mock chrome.contextMenus.create to be a no-op
    mock(chrome.contextMenus.create).mockImplementation(() => 1);
  });

  describe("message handling", () => {
    it("responds to PINYIN_REQUEST with PINYIN_RESPONSE_LOCAL", async () => {
      await loadServiceWorker();

      const sendResponse = vi.fn();

      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      // sendResponse is called asynchronously after getSettings() resolves
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const response: PinyinResponseLocal = sendResponse.mock.calls[0][0];
      expect(response.type).toBe("PINYIN_RESPONSE_LOCAL");
      expect(response.words.length).toBeGreaterThan(0);
      expect(response.words.some((w) => w.chars.includes("你"))).toBe(true);
    });

    it("ignores messages with unknown type", async () => {
      await loadServiceWorker();

      const sendResponse = vi.fn();

      const result = chrome.runtime.onMessage.callListeners(
        { type: "UNKNOWN" },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Give any async work a tick to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("returns words with correct pinyin style from settings", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ pinyinStyle: "toneNumbers" }),
      );

      await loadServiceWorker();

      const sendResponse = vi.fn();

      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const response: PinyinResponseLocal = sendResponse.mock.calls[0][0];
      const allPinyin = response.words.map((w) => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[1-4]/);
    });
  });

  describe("context menu", () => {
    it("creates context menu item on install", async () => {
      await loadServiceWorker();

      chrome.runtime.onInstalled.callListeners({ reason: "install" });

      expect(chrome.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "show-pinyin",
          title: "Show Pinyin & Translation",
          contexts: ["selection"],
        }),
      );
    });

    it("sends CONTEXT_MENU_TRIGGER when context menu is clicked", async () => {
      await loadServiceWorker();

      chrome.contextMenus.onClicked.callListeners(
        { menuItemId: "show-pinyin", selectionText: "你好世界" },
        { id: 42 },
      );

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: "CONTEXT_MENU_TRIGGER",
        text: "你好世界",
      });
    });
  });

  describe("keyboard command", () => {
    it("sends COMMAND_TRIGGER on show-pinyin command", async () => {
      await loadServiceWorker();

      (chrome as any).commands.onCommand.callListeners("show-pinyin", {
        id: 7,
      });

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
        type: "COMMAND_TRIGGER",
      });
    });
  });

  describe("vocab recording", () => {
    it("does not auto-record words on cache hit", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ llmEnabled: true, apiKey: "test-key" }),
      );

      const { getFromCache } = await import("../../src/background/cache");
      const { recordWords } = await import("../../src/background/vocab-store");
      (getFromCache as ReturnType<typeof vi.fn>).mockResolvedValue({
        words: [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
        translation: "Hello",
      });

      await loadServiceWorker();

      const sendResponse = vi.fn();
      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(recordWords).not.toHaveBeenCalled();
    });

    it("does not auto-record words after successful LLM response", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ llmEnabled: true, apiKey: "test-key" }),
      );

      const { getFromCache } = await import("../../src/background/cache");
      const { queryLLM } = await import("../../src/background/llm-client");
      const { recordWords } = await import("../../src/background/vocab-store");
      (getFromCache as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (queryLLM as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          words: [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
          translation: "Hello",
        },
      });

      await loadServiceWorker();

      const sendResponse = vi.fn();
      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(recordWords).not.toHaveBeenCalled();
    });

    it("RECORD_WORD without an example persists the word and no example slot", async () => {
      const { recordWords } = await import("../../src/background/vocab-store");
      (recordWords as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      const word = { chars: "学习", pinyin: "xué xí", definition: "to study" };
      chrome.runtime.onMessage.callListeners(
        { type: "RECORD_WORD", word },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(recordWords).toHaveBeenCalledWith([word], undefined);
    });

    it("RECORD_WORD with an example persists the supplied sentence (no translation)", async () => {
      const { recordWords } = await import("../../src/background/vocab-store");
      (recordWords as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      const word = { chars: "学习", pinyin: "xué xí", definition: "to study" };
      const example = { sentence: "我每天都在学习中文。" };
      chrome.runtime.onMessage.callListeners(
        { type: "RECORD_WORD", word, example },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      // chrome.runtime.onMessage listener registrations accumulate across
      // loadServiceWorker() calls in this file, so recordWords may be
      // invoked once per accumulated listener -- just verify the args
      // shape rather than the call count.
      expect(recordWords).toHaveBeenCalled();
      const lastArgs = (recordWords as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(lastArgs[0]).toEqual([word]);
      expect(lastArgs[1]).toMatchObject({ sentence: example.sentence });
      expect(lastArgs[1].translation).toBeUndefined();
      expect(lastArgs[1].capturedAt).toBeTypeOf("number");
    });

    it("RECORD_WORD with a pre-translated example persists the translation alongside the sentence", async () => {
      const { recordWords } = await import("../../src/background/vocab-store");
      (recordWords as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      const word = { chars: "学习", pinyin: "xué xí", definition: "to study" };
      const example = {
        sentence: "我每天都在学习中文。",
        translation: "I study Chinese every day.",
      };
      chrome.runtime.onMessage.callListeners(
        { type: "RECORD_WORD", word, example },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(recordWords).toHaveBeenCalled();
      const lastArgs = (recordWords as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(lastArgs[0]).toEqual([word]);
      expect(lastArgs[1]).toMatchObject({
        sentence: example.sentence,
        translation: example.translation,
      });
      expect(lastArgs[1].capturedAt).toBeTypeOf("number");
    });

    it("calls removeWord when REMOVE_WORD message is received", async () => {
      const { removeWord } = await import("../../src/background/vocab-store");
      (removeWord as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      chrome.runtime.onMessage.callListeners(
        { type: "REMOVE_WORD", chars: "学习" },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(removeWord).toHaveBeenCalledWith("学习");
    });

    it("calls removeExample when REMOVE_EXAMPLE message is received", async () => {
      const { removeExample } = await import("../../src/background/vocab-store");
      (removeExample as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      chrome.runtime.onMessage.callListeners(
        { type: "REMOVE_EXAMPLE", chars: "学习", index: 1 },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(removeExample).toHaveBeenCalledWith("学习", 1);
    });

    it("SET_EXAMPLE_TRANSLATION patches the matching example via setExampleTranslation", async () => {
      const { getAllVocab, setExampleTranslation } = await import(
        "../../src/background/vocab-store"
      );
      (getAllVocab as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          chars: "学习",
          examples: [
            { sentence: "我在学习。", capturedAt: 1 },
            { sentence: "她每天学习。", capturedAt: 2 },
          ],
        },
      ]);
      (setExampleTranslation as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      chrome.runtime.onMessage.callListeners(
        {
          type: "SET_EXAMPLE_TRANSLATION",
          chars: "学习",
          sentence: "她每天学习。",
          translation: "She studies every day.",
        },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await vi.waitFor(() =>
        expect(setExampleTranslation).toHaveBeenCalledWith(
          "学习",
          1,
          "She studies every day.",
        ),
      );
    });

    it("SET_EXAMPLE_TRANSLATION is a no-op when the matching sentence is missing", async () => {
      const { getAllVocab, setExampleTranslation } = await import(
        "../../src/background/vocab-store"
      );
      (getAllVocab as ReturnType<typeof vi.fn>).mockResolvedValue([
        { chars: "学习", examples: [{ sentence: "我在学习。", capturedAt: 1 }] },
      ]);
      (setExampleTranslation as ReturnType<typeof vi.fn>).mockClear();

      await loadServiceWorker();

      chrome.runtime.onMessage.callListeners(
        {
          type: "SET_EXAMPLE_TRANSLATION",
          chars: "学习",
          sentence: "完全不一样的句子。",
          translation: "A different translation.",
        },
        { tab: { id: 1 } },
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(setExampleTranslation).not.toHaveBeenCalled();
    });
  });

  describe("getSettings", () => {
    it("returns DEFAULT_SETTINGS when storage is empty", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() => Promise.resolve({}));

      const { getSettings } = await loadServiceWorker();
      const settings = await getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("merges stored settings with defaults", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ pinyinStyle: "none", fontSize: 20 }),
      );

      const { getSettings } = await loadServiceWorker();
      const settings = await getSettings();

      expect(settings.pinyinStyle).toBe("none");
      expect(settings.fontSize).toBe(20);
      // Non-overridden fields remain at defaults
      expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
      expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    });
  });
});
