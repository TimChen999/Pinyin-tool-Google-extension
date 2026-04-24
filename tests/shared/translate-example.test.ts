/**
 * Unit tests for the on-device Translator API wrapper used by the
 * content script and the hub. Stubs `globalThis.Translator` to drive
 * every branch of the discriminated-union result.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We re-import inside each test (after vi.resetModules) so the module's
// internal cached translator promise starts fresh per case. Without
// the reset a UNAVAILABLE / DOWNLOAD_FAILED case in one test would
// leak into the next.
async function loadModule() {
  vi.resetModules();
  return import("../../src/shared/translate-example");
}

function setTranslator(impl: unknown): void {
  (globalThis as { Translator?: unknown }).Translator = impl as never;
}

function clearTranslator(): void {
  delete (globalThis as { Translator?: unknown }).Translator;
}

describe("translateExampleSentence", () => {
  beforeEach(() => {
    clearTranslator();
  });

  afterEach(() => {
    clearTranslator();
    vi.restoreAllMocks();
  });

  it("returns UNAVAILABLE when the Translator API is missing on this browser", async () => {
    const { translateExampleSentence } = await loadModule();
    const result = await translateExampleSentence("我去银行。");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.error.message.toLowerCase()).toContain("isn't available");
    }
  });

  it("returns UNAVAILABLE when availability() reports 'unavailable'", async () => {
    const availability = vi.fn(async () => "unavailable");
    const create = vi.fn();
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    const result = await translateExampleSentence("我去银行。");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAVAILABLE");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the translation on a happy-path call", async () => {
    const translate = vi.fn(async () => "I went to the bank.");
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    const result = await translateExampleSentence("我去银行了。");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("I went to the bank.");
    }
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    expect(translate).toHaveBeenCalledWith("我去银行了。");
  });

  it("reuses the same Translator instance across multiple calls", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    await translateExampleSentence("一");
    await translateExampleSentence("二");
    await translateExampleSentence("三");

    expect(create).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent first-call awaits onto a single create()", async () => {
    let resolveCreate: ((value: unknown) => void) | null = null;
    const translate = vi.fn(async () => "ok");
    const create = vi.fn(
      () => new Promise((r) => (resolveCreate = r as typeof resolveCreate)),
    );
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    // Fire three concurrent requests before create() resolves.
    const p1 = translateExampleSentence("a");
    const p2 = translateExampleSentence("b");
    const p3 = translateExampleSentence("c");

    // Allow microtasks so each call advances to its `await cachedTranslator`.
    await Promise.resolve();
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(1);

    resolveCreate!({ translate });
    await Promise.all([p1, p2, p3]);

    expect(translate).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns DOWNLOAD_FAILED when create() rejects", async () => {
    const create = vi.fn(async () => {
      throw new Error("download blocked");
    });
    const availability = vi.fn(async () => "downloadable");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    const result = await translateExampleSentence("我去银行。");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DOWNLOAD_FAILED");
    }
  });

  it("retries create() on the next call after a DOWNLOAD_FAILED", async () => {
    let attempts = 0;
    const translate = vi.fn(async () => "second time works");
    const create = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("download blocked");
      return { translate };
    });
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    const first = await translateExampleSentence("一");
    expect(first.ok).toBe(false);

    const second = await translateExampleSentence("二");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.translation).toBe("second time works");
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("returns TRANSLATION_FAILED when translate() rejects but keeps the cached instance for the next call", async () => {
    let translateCalls = 0;
    const translate = vi.fn(async () => {
      translateCalls += 1;
      if (translateCalls === 1) throw new Error("model crashed mid-translate");
      return "second-call success";
    });
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateExampleSentence } = await loadModule();
    const first = await translateExampleSentence("我去银行。");
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe("TRANSLATION_FAILED");
    }

    const second = await translateExampleSentence("再试一次。");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.translation).toBe("second-call success");
    }
    // The Translator instance survived the per-call failure --
    // create() shouldn't have been re-invoked.
    expect(create).toHaveBeenCalledTimes(1);
  });
});
