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

// ─── Generalised wrapper + prewarm (used by the non-LLM fallback) ──

describe("translateChineseToEnglish (alias)", () => {
  beforeEach(() => {
    clearTranslator();
  });

  afterEach(() => {
    clearTranslator();
    vi.restoreAllMocks();
  });

  it("is the same function as translateExampleSentence (back-compat alias)", async () => {
    const { translateChineseToEnglish, translateExampleSentence } =
      await loadModule();
    expect(translateChineseToEnglish).toBe(translateExampleSentence);
  });

  it("translates arbitrary Chinese text via the on-device Translator", async () => {
    const translate = vi.fn(async (s: string) => `EN(${s})`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { translateChineseToEnglish } = await loadModule();
    const result = await translateChineseToEnglish("学习");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("EN(学习)");
    }
    expect(translate).toHaveBeenCalledWith("学习");
  });
});

describe("isTranslatorAvailable", () => {
  beforeEach(() => {
    clearTranslator();
  });

  afterEach(() => {
    clearTranslator();
  });

  it("returns false when the Translator API is missing", async () => {
    const { isTranslatorAvailable } = await loadModule();
    expect(isTranslatorAvailable()).toBe(false);
  });

  it("returns true when globalThis.Translator is present", async () => {
    // Shape doesn't matter for the synchronous feature check -- only
    // the typeof !== "undefined" branch.
    setTranslator({ availability: vi.fn(), create: vi.fn() });
    const { isTranslatorAvailable } = await loadModule();
    expect(isTranslatorAvailable()).toBe(true);
  });
});

describe("prewarmTranslator", () => {
  beforeEach(() => {
    clearTranslator();
  });

  afterEach(() => {
    clearTranslator();
    vi.restoreAllMocks();
  });

  it("is a no-op when the Translator API is missing", async () => {
    const { prewarmTranslator, translateChineseToEnglish } = await loadModule();

    // Doesn't throw and returns void.
    await expect(prewarmTranslator()).resolves.toBeUndefined();

    // After a no-op prewarm, the next translateChineseToEnglish() still
    // surfaces UNAVAILABLE -- the cache wasn't poisoned by anything.
    const result = await translateChineseToEnglish("我");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAVAILABLE");
    }
  });

  it("kicks off Translator.create() exactly once, even when followed by a translate() call", async () => {
    const translate = vi.fn(async () => "ok");
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { prewarmTranslator, translateChineseToEnglish } = await loadModule();

    await prewarmTranslator();
    expect(create).toHaveBeenCalledTimes(1);

    // The follow-up translate call reuses the prewarmed instance --
    // create() is NOT invoked a second time. This is the whole point
    // of prewarming: capture the user activation early, reuse later.
    const result = await translateChineseToEnglish("银行");
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith("银行");
  });

  it("clears the cache when create() rejects so the next call retries from scratch", async () => {
    let attempts = 0;
    const translate = vi.fn(async () => "second time");
    const create = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("blocked first time");
      return { translate };
    });
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { prewarmTranslator, translateChineseToEnglish } = await loadModule();

    // The prewarm itself swallows the error -- it's fire-and-forget.
    await expect(prewarmTranslator()).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);

    // The next real translate() call gets a fresh create() rather than
    // replaying the cached rejection.
    const result = await translateChineseToEnglish("成功");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.translation).toBe("second time");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent prewarm + translate() onto a single create() promise", async () => {
    let resolveCreate: ((value: unknown) => void) | null = null;
    const translate = vi.fn(async () => "ok");
    const create = vi.fn(
      () => new Promise((r) => (resolveCreate = r as typeof resolveCreate)),
    );
    const availability = vi.fn(async () => "available");
    setTranslator({ availability, create });

    const { prewarmTranslator, translateChineseToEnglish } = await loadModule();

    const prewarmP = prewarmTranslator();
    const translateP = translateChineseToEnglish("一");

    // Allow microtasks to advance both calls into their `await` of the
    // shared create() promise.
    await Promise.resolve();
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(1);

    resolveCreate!({ translate });
    await Promise.all([prewarmP, translateP]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
