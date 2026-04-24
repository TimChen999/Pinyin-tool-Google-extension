import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  queryLLM,
  translateSentence,
  validateLLMResponse,
  type LLMResult,
} from "../../src/background/llm-client";
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

      await queryLLM("你好", "context here", openaiConfig, "toneMarks");

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
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(true);
      expect((result as Extract<LLMResult, { ok: true }>).data).toEqual(sampleLLMData);
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

      await queryLLM("你好", "context", ollamaConfig, "toneMarks");

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

      await queryLLM("你好", "context", geminiConfig, "toneMarks");

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
      const result = await queryLLM("你好", "context", geminiConfig, "toneMarks");
      expect(result.ok).toBe(true);
      expect((result as Extract<LLMResult, { ok: true }>).data).toEqual(sampleLLMData);
    });
  });

  describe("error handling (all providers)", () => {
    // The retry loop runs RETRY_DELAYS_MS.length + 1 = 3 attempts on
    // NETWORK_ERROR, sleeping ~800ms then ~2400ms (with jitter) between
    // attempts, so the worst-case wall time is ~3.5s. Bumping these
    // tests' timeouts above the vitest default avoids spurious flakes.
    it("returns NETWORK_ERROR on network error", async () => {
      (fetch as any).mockRejectedValue(new Error("Network error"));
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NETWORK_ERROR");
      }
    }, 15_000);

    it("returns AUTH_FAILED on 401 response", async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Unauthorized",
      });
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("AUTH_FAILED");
      }
    });

    it("returns RATE_LIMITED on 429 response", async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => "Rate limited",
      });
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMITED");
      }
    });

    it("retries on 5xx error and succeeds on the next attempt", async () => {
      (fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "Internal Server Error",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(sampleLLMData) } }],
          }),
        });

      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(sampleLLMData);
      }
    }, 15_000);

    it("returns SERVER_ERROR when 5xx persists across all retry attempts", async () => {
      // mockResolvedValue (not Once) so every one of the 3 attempts
      // sees the same 502 -- the loop exhausts retries and surfaces
      // the last classified error.
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "Bad Gateway",
      });
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SERVER_ERROR");
      }
    }, 15_000);

    it("returns INVALID_RESPONSE when response has invalid structure", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ invalid: true }) } },
          ],
        }),
      });
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_RESPONSE");
      }
    });

    it("returns INVALID_RESPONSE when response is not valid JSON", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not json" } }],
        }),
      });
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_RESPONSE");
      }
    });

    it("returns TIMEOUT when every attempt aborts", async () => {
      const abortError = new DOMException("The operation was aborted.", "AbortError");
      (fetch as any).mockRejectedValue(abortError);
      const result = await queryLLM("你好", "context", openaiConfig, "toneMarks");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    }, 15_000);
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

// ─── translateSentence Tests ───────────────────────────────────────

describe("translateSentence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the translation on a successful OpenAI-compatible response", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ translation: "I went to the bank yesterday." }) } }],
      }),
    });

    const result = await translateSentence("我昨天去银行了。", openaiConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("I went to the bank yesterday.");
    }
  });

  it("uses the slimmed sentence-translation prompt and honors config.maxTokens", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ translation: "ok" }) } }],
      }),
    });

    await translateSentence("我去银行。", openaiConfig);

    const [, options] = (fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    // Slimmed prompt mentions "Chinese-to-English translator" rather
    // than the full word-segmentation prompt's "language assistant".
    expect(body.messages[0].content).toContain("translator");
    expect(body.messages[0].content).not.toContain("Segment");
    // The translator now reuses the same token budget as the main
    // pinyin call so thinking models (e.g. Gemini 2.5 Pro) have
    // headroom for internal reasoning. We assert it threads through
    // config.maxTokens rather than overriding with a smaller cap.
    expect(body.max_tokens).toBe(openaiConfig.maxTokens);
    expect(body.messages[1].content).toContain("我去银行。");
  });

  it("works against the Gemini provider (parses parts[].text)", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ translation: "Hello." }) }] } },
        ],
      }),
    });

    const result = await translateSentence("你好。", geminiConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("Hello.");
    }
  });

  it("returns INVALID_RESPONSE when the LLM emits JSON that lacks a translation field", async () => {
    // Raw payload starts with `{` so the bare-string fallback bails
    // (a JSON-shaped body the salvager couldn't fix shouldn't be
    // re-interpreted as raw text). The retry loop tries 3 times then
    // surfaces the user-actionable empty-response message.
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ words: [] }) } }],
      }),
    });

    const result = await translateSentence("我去银行。", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
      expect(result.error.message.toLowerCase()).toContain("empty");
    }
  });

  it("falls back to the raw text when the LLM returns a bare English string", async () => {
    // Some providers occasionally ignore responseMimeType and return
    // the translation as raw text. We accept it as long as it looks
    // like a sentence (letters present, not JSON-shaped, bounded len).
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "I went to the bank yesterday." } }],
      }),
    });

    const result = await translateSentence("我昨天去银行了。", openaiConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("I went to the bank yesterday.");
    }
  });

  it("strips surrounding quotes from a bare-string translation", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '"Hello, world."' } }],
      }),
    });

    const result = await translateSentence("你好，世界。", openaiConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("Hello, world.");
    }
  });

  it("rejects a bare payload that has no letters (pure punctuation / digits)", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "1234567890" } }],
      }),
    });

    const result = await translateSentence("我去银行。", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  it("salvages a translation from a malformed JSON body via tryParseJson", async () => {
    // Mirrors queryLLM's tolerance: a body with a trailing comma after
    // the close brace is unparseable as-is but the shared salvager
    // trims it down to valid JSON and recovers the translation.
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"translation": "I went to the bank yesterday."},',
            },
          },
        ],
      }),
    });

    const result = await translateSentence("我昨天去银行了。", openaiConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translation).toBe("I went to the bank yesterday.");
    }
  });

  it("returns AUTH_FAILED on a 401 response", async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Unauthorized",
    });

    const result = await translateSentence("我去银行。", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_FAILED");
    }
  });

  it("returns NETWORK_ERROR (after retries) when fetch throws every time", async () => {
    (fetch as any).mockRejectedValue(new Error("network down"));
    const result = await translateSentence("我去银行。", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
    }
  }, 15_000);
});
