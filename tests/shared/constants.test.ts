import { describe, it, expect } from "vitest";
import {
  CHINESE_REGEX,
  DEFAULT_SETTINGS,
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  LLM_TIMEOUT_MS,
  MAX_SELECTION_LENGTH,
  DEBOUNCE_MS,
  PROVIDER_PRESETS,
  SYSTEM_PROMPT,
  VOCAB_STOP_WORDS,
  MAX_VOCAB_ENTRIES,
} from "../../src/shared/constants";

describe("constants", () => {
  it("CHINESE_REGEX matches Chinese characters", () => {
    expect(CHINESE_REGEX.test("你")).toBe(true);
    expect(CHINESE_REGEX.test("a")).toBe(false);
  });

  it("DEFAULT_SETTINGS has correct shape and sensible defaults", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("openai");
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
    expect(DEFAULT_SETTINGS.baseUrl).toBe("https://api.openai.com/v1");
    expect(DEFAULT_SETTINGS.model).toBe("gpt-4o-mini");
    expect(DEFAULT_SETTINGS.pinyinStyle).toBe("toneMarks");
    expect(DEFAULT_SETTINGS.fontSize).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.theme).toBe("auto");
    expect(DEFAULT_SETTINGS.llmEnabled).toBe(true);
  });

  it("CACHE_TTL_MS equals 7 days in milliseconds", () => {
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("MAX_CACHE_ENTRIES is a positive number", () => {
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(0);
  });

  it("LLM_TIMEOUT_MS is 10 seconds", () => {
    expect(LLM_TIMEOUT_MS).toBe(10_000);
  });

  it("MAX_SELECTION_LENGTH is 500", () => {
    expect(MAX_SELECTION_LENGTH).toBe(500);
  });

  it("DEBOUNCE_MS is 100", () => {
    expect(DEBOUNCE_MS).toBe(100);
  });
});

describe("PROVIDER_PRESETS", () => {
  it("defines presets for all four providers", () => {
    expect(PROVIDER_PRESETS).toHaveProperty("openai");
    expect(PROVIDER_PRESETS).toHaveProperty("gemini");
    expect(PROVIDER_PRESETS).toHaveProperty("ollama");
    expect(PROVIDER_PRESETS).toHaveProperty("custom");
  });

  it("each preset has the required fields", () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset).toHaveProperty("baseUrl");
      expect(preset).toHaveProperty("defaultModel");
      expect(preset).toHaveProperty("apiStyle");
      expect(preset).toHaveProperty("requiresApiKey");
      expect(preset).toHaveProperty("models");
      expect(["openai", "gemini"]).toContain(preset.apiStyle);
    }
  });

  it("openai preset uses openai apiStyle", () => {
    expect(PROVIDER_PRESETS.openai.apiStyle).toBe("openai");
    expect(PROVIDER_PRESETS.openai.requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.openai.baseUrl).toContain("openai.com");
  });

  it("gemini preset uses gemini apiStyle", () => {
    expect(PROVIDER_PRESETS.gemini.apiStyle).toBe("gemini");
    expect(PROVIDER_PRESETS.gemini.requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.gemini.baseUrl).toContain("googleapis.com");
  });

  it("ollama preset uses openai apiStyle and requires no API key", () => {
    expect(PROVIDER_PRESETS.ollama.apiStyle).toBe("openai");
    expect(PROVIDER_PRESETS.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_PRESETS.ollama.baseUrl).toContain("localhost");
  });

  it("custom preset has empty baseUrl and models", () => {
    expect(PROVIDER_PRESETS.custom.baseUrl).toBe("");
    expect(PROVIDER_PRESETS.custom.models).toEqual([]);
  });

  it("DEFAULT_SETTINGS.baseUrl matches the default provider preset", () => {
    const defaultPreset = PROVIDER_PRESETS[DEFAULT_SETTINGS.provider];
    expect(DEFAULT_SETTINGS.baseUrl).toBe(defaultPreset.baseUrl);
    expect(DEFAULT_SETTINGS.model).toBe(defaultPreset.defaultModel);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });

  it("instructs the LLM to return JSON", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("json");
  });

  it("mentions pinyin", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("pinyin");
  });
});

describe("vocab constants", () => {
  it("VOCAB_STOP_WORDS is a non-empty Set", () => {
    expect(VOCAB_STOP_WORDS).toBeInstanceOf(Set);
    expect(VOCAB_STOP_WORDS.size).toBeGreaterThan(0);
  });

  it("VOCAB_STOP_WORDS contains common function words", () => {
    expect(VOCAB_STOP_WORDS.has("的")).toBe(true);
    expect(VOCAB_STOP_WORDS.has("了")).toBe(true);
    expect(VOCAB_STOP_WORDS.has("是")).toBe(true);
  });

  it("MAX_VOCAB_ENTRIES is a positive number", () => {
    expect(MAX_VOCAB_ENTRIES).toBeGreaterThan(0);
  });
});
