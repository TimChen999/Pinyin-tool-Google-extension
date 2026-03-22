import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queryLLM, validateLLMResponse } from "../../src/background/llm-client";
import type { LLMConfig } from "../../src/shared/types";

// ─── Test Fixtures ──────────────────────────────────────────────────

const openaiConfig: LLMConfig = {
  provider: "openai",
  apiKey: "sk-test-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  maxTokens: 1024,
  temperature: 0,
};

const geminiConfig: LLMConfig = {
  provider: "gemini",
  apiKey: "AIza-test-key",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "gemini-2.0-flash",
  maxTokens: 1024,
  temperature: 0,
};

const ollamaConfig: LLMConfig = {
  provider: "ollama",
  apiKey: "",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:7b",
  maxTokens: 1024,
  temperature: 0,
};

const sampleLLMData = {
  words: [
    { chars: "你好", pinyin: "nǐ hǎo", definition: "hello" },
  ],
  translation: "Hello",
};

// ─── queryLLM Tests ─────────────────────────────────────────────────

describe("queryLLM", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("OpenAI-compatible provider (OpenAI)", () => {
    it("sends correct request to /chat/completions", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(sampleLLMData) } }],
        }),
      });

      await queryLLM("你好", "context here", openaiConfig);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(options.method).toBe("POST");
      expect(options.headers["Authorization"]).toBe("Bearer sk-test-key");

      const body = JSON.parse(options.body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].content).toContain("你好");
    });

    it("returns parsed response on success", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(sampleLLMData) } }],
        }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toEqual(sampleLLMData);
    });
  });

  describe("OpenAI-compatible provider (Ollama)", () => {
    it("sends request without Authorization header", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(sampleLLMData) } }],
        }),
      });

      await queryLLM("你好", "context", ollamaConfig);

      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
      expect(options.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("Gemini provider", () => {
    it("sends correct request to Gemini generateContent endpoint", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(sampleLLMData) }] } },
          ],
        }),
      });

      await queryLLM("你好", "context", geminiConfig);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("gemini-2.0-flash");
      expect(url).toContain("generateContent");
      expect(url).toContain("key=AIza-test-key");
      expect(options.headers["Authorization"]).toBeUndefined();

      const body = JSON.parse(options.body);
      expect(body.contents).toBeDefined();
      expect(body.generationConfig).toBeDefined();
    });

    it("parses Gemini response format correctly", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(sampleLLMData) }] } },
          ],
        }),
      });
      const result = await queryLLM("你好", "context", geminiConfig);
      expect(result).toEqual(sampleLLMData);
    });
  });

  describe("error handling (all providers)", () => {
    it("returns null on network error", async () => {
      (fetch as any).mockRejectedValue(new Error("Network error"));
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("returns null on non-ok response (4xx)", async () => {
      (fetch as any).mockResolvedValue({ ok: false, status: 401 });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("retries once on 5xx error then succeeds", async () => {
      (fetch as any)
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(sampleLLMData) } }],
          }),
        });

      const result = await queryLLM("你好", "context", openaiConfig);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(sampleLLMData);
    });

    it("returns null when response has invalid structure", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ invalid: true }) } },
          ],
        }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("returns null when response is not valid JSON", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not json" } }],
        }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });
  });
});

// ─── validateLLMResponse Tests ──────────────────────────────────────

describe("validateLLMResponse", () => {
  it("returns true for valid response", () => {
    expect(
      validateLLMResponse({
        words: [{ chars: "你", pinyin: "nǐ", definition: "you" }],
        translation: "You",
      }),
    ).toBe(true);
  });

  it("returns false when words is missing", () => {
    expect(validateLLMResponse({ translation: "Hello" })).toBe(false);
  });

  it("returns false when translation is missing", () => {
    expect(validateLLMResponse({ words: [] })).toBe(false);
  });

  it("returns false when words is not an array", () => {
    expect(
      validateLLMResponse({ words: "not array", translation: "Hello" }),
    ).toBe(false);
  });

  it("returns false for null input", () => {
    expect(validateLLMResponse(null)).toBe(false);
  });
});
