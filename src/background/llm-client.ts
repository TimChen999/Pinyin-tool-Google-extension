/**
 * Multi-provider LLM client with adapter pattern for request/response formats.
 *
 * Supports two API styles: OpenAI-compatible (OpenAI, Ollama, custom) and
 * Gemini (Google's distinct REST format). Provider-specific details are
 * isolated behind buildRequest() and parseResponse() adapters, so adding
 * a new OpenAI-compatible provider only requires a new PROVIDER_PRESETS
 * entry in constants.ts -- no code changes here.
 *
 * Uses only the Fetch API (no Chrome-specific APIs), making it testable
 * with standard fetch mocking.
 *
 * See: SPEC.md Section 6 "LLM Integration Design" for the adapter pattern,
 *      SPEC.md Section 6 "Multi-Provider Support" for provider details,
 *      IMPLEMENTATION_GUIDE.md Step 4 for implementation details.
 */

import type { LLMConfig, WordData, APIStyle, PinyinStyle } from "../shared/types";
import {
  LLM_TIMEOUT_MS,
  SYSTEM_PROMPT,
  SENTENCE_TRANSLATION_PROMPT,
  PROVIDER_PRESETS,
  RETRY_DELAYS_MS,
} from "../shared/constants";
import { convertToPinyin } from "./pinyin-service";

// ─── LLM Response Type ─────────────────────────────────────────────

/**
 * Parsed LLM output: word-segmented definitions + translation.
 *
 * The slimmed prompt no longer asks the model for pinyin, so the raw
 * parse may carry words missing `pinyin` and (under JSON salvage) the
 * tail entry may also be missing `definition`. queryLLM() backfills
 * both fields before returning so downstream consumers (overlay,
 * cache) still see a fully populated Required<WordData>[] -- the
 * wire/cache shape is unchanged.
 *
 * `partial` is set when the response was salvaged from a truncated /
 * malformed JSON body. Partial responses are still rendered to the
 * user but are never written to the positive cache.
 */
export interface LLMResponse {
  words: Required<WordData>[];
  translation: string;
  partial?: boolean;
}

export type LLMErrorCode =
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

export interface LLMError {
  code: LLMErrorCode;
  message: string;
}

export type LLMResult =
  | { ok: true; data: LLMResponse }
  | { ok: false; error: LLMError };

// ─── Response Validation ────────────────────────────────────────────

/**
 * Type guard that validates the shape of parsed LLM JSON.
 *
 * Required: `words` is an array and `translation` is a string. Each
 * word entry must at least have a string `chars` (definition is
 * permitted to be missing / non-string and is normalized later, since
 * truncated responses sometimes drop fields off the tail entry).
 */
export function validateLLMResponse(data: unknown): data is LLMResponse {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.words)) return false;
  if (typeof obj.translation !== "string") return false;
  for (const w of obj.words) {
    if (!w || typeof w !== "object") return false;
    if (typeof (w as Record<string, unknown>).chars !== "string") return false;
  }
  return true;
}

// ─── Request Builder (Adapter) ──────────────────────────────────────

/**
 * Constructs the provider-specific fetch URL and RequestInit.
 *
 * OpenAI-compatible: POST /chat/completions with Bearer auth and
 *   response_format for reliable JSON output.
 * Gemini: POST /v1beta/models/{model}:generateContent with API key
 *   in the query string and responseMimeType for JSON.
 *
 * (SPEC.md Section 6 "API Styles")
 */
function buildRequest(
  text: string,
  context: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  const userContent = `Chinese text: "${text}"\nSurrounding context: "${context}"`;

  if (apiStyle === "gemini") {
    return {
      url: `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: SYSTEM_PROMPT + "\n\n" + userContent }] },
          ],
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: "application/json",
          },
        }),
        signal,
      },
    };
  }

  // OpenAI-compatible (OpenAI, Ollama, custom)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal,
    },
  };
}

// ─── Response Parser (Adapter) ──────────────────────────────────────

/**
 * Pulls the model's raw text payload out of the provider-specific
 * envelope without attempting any JSON parsing.
 *
 * OpenAI: data.choices[0].message.content
 * Gemini: data.candidates[0].content.parts[0].text
 */
function extractRawText(data: unknown, apiStyle: APIStyle): string | null {
  const obj = data as Record<string, unknown>;

  if (apiStyle === "gemini") {
    const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
    const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    const text = parts?.[0]?.text;
    return typeof text === "string" ? text : null;
  }

  // OpenAI-compatible
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Tolerant JSON parser. Tries `JSON.parse` first; on failure attempts
 * a structural salvage that closes any unbalanced brackets and trims
 * any trailing partial entry. Returns `partial: true` whenever the
 * salvage path succeeded so the caller can suppress positive caching
 * and (optionally) flag the result downstream.
 */
function tryParseJson(raw: string): { value: unknown | null; partial: boolean } {
  try {
    return { value: JSON.parse(raw), partial: false };
  } catch {
    const salvaged = salvageJson(raw);
    if (salvaged !== null) {
      console.warn("[LLM-client] Salvaged truncated JSON (orig %d chars).", raw.length);
    } else {
      console.error("[LLM-client] JSON.parse + salvage failed. Raw (%d chars):", raw.length, raw.slice(0, 500));
    }
    return { value: salvaged, partial: salvaged !== null };
  }
}

/**
 * Best-effort JSON repair for truncated or malformed model output.
 *
 * Walks the string while tracking the open-brace stack and the most
 * recent "safe checkpoint" -- a position immediately after a clean
 * closing brace. On structural failure (unbalanced or unterminated
 * string) we truncate to the last checkpoint, append the missing
 * closing brackets, and re-parse. If the salvaged shape is missing
 * `translation` (because the response was cut off before that key),
 * an empty translation is injected so downstream validation passes.
 *
 * Returns null if nothing parseable can be recovered.
 */
function salvageJson(raw: string): unknown | null {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let lastSafe = -1;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") {
      stack.push(c === "[" ? "]" : "}");
    } else if (c === "]" || c === "}") {
      if (stack.length === 0 || stack[stack.length - 1] !== c) {
        // Structurally broken in a way we can't fix.
        break;
      }
      stack.pop();
      lastSafe = i + 1;
    }
  }

  if (lastSafe <= 0) return null;

  // Re-walk the safe prefix to recover the bracket stack at that point,
  // since the loop above may have continued past it before failing.
  const stackAt: string[] = [];
  let inStr2 = false;
  let esc2 = false;
  for (let i = 0; i < lastSafe; i++) {
    const c = raw[i];
    if (esc2) { esc2 = false; continue; }
    if (inStr2) {
      if (c === "\\") esc2 = true;
      else if (c === '"') inStr2 = false;
      continue;
    }
    if (c === '"') { inStr2 = true; continue; }
    if (c === "[" || c === "{") {
      stackAt.push(c === "[" ? "]" : "}");
    } else if (c === "]" || c === "}") {
      stackAt.pop();
    }
  }

  let cur = raw.slice(0, lastSafe).replace(/[,\s]+$/, "");
  while (stackAt.length > 0) {
    const close = stackAt.pop();
    if (close) cur += close;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cur);
  } catch {
    return null;
  }

  // Inject an empty translation if the truncation cut off before the
  // translation key was emitted; the caller will mark this as partial.
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.words) && typeof obj.translation !== "string") {
      obj.translation = "";
    }
  }
  return parsed;
}

// ─── Word Normalization ────────────────────────────────────────────

/**
 * Promotes raw parsed words to fully populated Required<WordData>[]:
 *  - If `pinyin` is missing, derive it locally via convertToPinyin().
 *    The slimmed system prompt no longer asks the model for pinyin
 *    (token / latency optimization); the local pinyin-pro pipeline
 *    is already excellent at polyphone-aware segmentation.
 *  - If `definition` is missing or non-string (which can happen on
 *    the tail entry after JSON salvage), substitute an empty string
 *    so downstream consumers can rely on a uniform shape.
 *
 * The wire format and cache shape are therefore unchanged from before
 * the slimmed-prompt change.
 */
function normalizeWords(
  words: WordData[],
  style: PinyinStyle,
): Required<WordData>[] {
  return words.map((w) => {
    let pinyin = typeof w.pinyin === "string" ? w.pinyin : "";
    if (!pinyin) {
      const segs = convertToPinyin(w.chars, style);
      pinyin = segs.map((s) => s.pinyin).join(" ").trim();
    }
    const definition = typeof w.definition === "string" ? w.definition : "";
    return { chars: w.chars, pinyin, definition };
  });
}

// ─── Logging Helpers ────────────────────────────────────────────────

/** Strip the Gemini `?key=...` query param from a URL before logging. */
function redactUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]+/i, "$1***");
}

/**
 * Single-line JSON telemetry record emitted at the end of every
 * attempt (success or failure). No PII, no API key. Designed to be
 * grep-able from chrome://extensions devtools logs.
 */
interface TelemetryRecord {
  provider: string;
  model: string;
  attempt: number;
  status: string;
  latencyMs: number;
  partial: boolean;
  textLen: number;
  contextLen: number;
}
function logTelemetry(rec: TelemetryRecord): void {
  console.log("[LLM-telemetry]", JSON.stringify(rec));
}

// ─── Main Entry Point ───────────────────────────────────────────────

/** Error codes that a transient failure can recover from on retry. */
const RETRYABLE_CODES: ReadonlySet<LLMErrorCode> = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
]);

/**
 * Sends Chinese text + context to the configured LLM and returns
 * structured word data with contextual definitions and a sentence
 * translation.
 *
 * Resilience features layered on top of a single fetch:
 *  - Per-attempt timeout (LLM_TIMEOUT_MS) with a fresh AbortController
 *    each iteration so aborts on attempt N never bleed into N+1.
 *  - Up to RETRY_DELAYS_MS.length retries (3 attempts total) with
 *    jittered backoff, but only for transient codes (TIMEOUT /
 *    NETWORK_ERROR / SERVER_ERROR). AUTH_FAILED, RATE_LIMITED, and
 *    INVALID_RESPONSE are surfaced immediately on first occurrence.
 *  - Tolerant JSON parsing that salvages truncated bodies into a
 *    `partial: true` response instead of a hard failure.
 *  - Local pinyin backfill so the wire/cache shape is unchanged
 *    despite the slimmed prompt.
 *
 * (SPEC.md Section 6 "Fallback Strategy")
 */
export async function queryLLM(
  text: string,
  context: string,
  config: LLMConfig,
  pinyinStyle: PinyinStyle,
): Promise<LLMResult> {
  const apiStyle = PROVIDER_PRESETS[config.provider].apiStyle;
  const totalAttempts = RETRY_DELAYS_MS.length + 1;
  let last: LLMResult = {
    ok: false,
    error: { code: "UNKNOWN", message: "LLM request failed." },
  };

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (attempt > 1) {
      const baseDelay = RETRY_DELAYS_MS[attempt - 2];
      const jittered = baseDelay * (1 + Math.random() * 0.25);
      await new Promise((r) => setTimeout(r, jittered));
    }

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let result: LLMResult;
    let status: string;

    try {
      result = await singleAttempt(
        text,
        context,
        config,
        apiStyle,
        pinyinStyle,
        controller.signal,
      );
      status = result.ok ? "ok" : result.error.code;
    } catch (err) {
      const isAbort =
        err && typeof err === "object" &&
        (err as { name?: string }).name === "AbortError";
      result = isAbort
        ? { ok: false, error: { code: "TIMEOUT", message: "Translation timed out. Try again." } }
        : { ok: false, error: { code: "NETWORK_ERROR", message: "Could not reach the LLM provider." } };
      status = result.error ? result.error.code : "UNKNOWN";
      if (!isAbort) {
        console.error("[LLM-client] Caught error on attempt %d:", attempt, err);
      }
    } finally {
      clearTimeout(timer);
    }

    logTelemetry({
      provider: config.provider,
      model: config.model,
      attempt,
      status,
      latencyMs: Date.now() - t0,
      partial: result.ok ? Boolean(result.data.partial) : false,
      textLen: text.length,
      contextLen: context.length,
    });

    last = result;
    if (result.ok) return result;
    if (!RETRYABLE_CODES.has(result.error.code)) return result;
  }

  return last;
}

/**
 * Executes one HTTP fetch + parse cycle. Returns a typed LLMResult
 * for any HTTP-level outcome; AbortErrors propagate to the caller's
 * try/catch so the retry loop can classify them as TIMEOUT.
 */
async function singleAttempt(
  text: string,
  context: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  pinyinStyle: PinyinStyle,
  signal: AbortSignal,
): Promise<LLMResult> {
  const { url, init } = buildRequest(text, context, config, apiStyle, signal);

  console.log("[LLM-client] Fetching: %s", redactUrl(url));

  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    console.error(
      "[LLM-client] HTTP %d %s — body: %s",
      response.status,
      response.statusText,
      body.slice(0, 500),
    );
    return { ok: false, error: classifyHttpError(response.status) };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  const raw = extractRawText(data, apiStyle);
  if (!raw) {
    console.error("[LLM-client] No text payload in response envelope. Raw:", data);
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  const { value: parsed, partial } = tryParseJson(raw);

  if (!validateLLMResponse(parsed)) {
    console.error("[LLM-client] Response failed validation. Raw parsed:", parsed);
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  const filled: LLMResponse = {
    words: normalizeWords(parsed.words, pinyinStyle),
    translation: parsed.translation,
    ...(partial ? { partial: true } : {}),
  };

  return { ok: true, data: filled };
}

function classifyHttpError(status: number): LLMError {
  if (status === 401 || status === 403) {
    return { code: "AUTH_FAILED", message: "API key is invalid or expired." };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." };
  }
  if (status >= 500) {
    return { code: "SERVER_ERROR", message: "LLM server error. Try again later." };
  }
  return { code: "UNKNOWN", message: `LLM request failed (HTTP ${status}).` };
}

// ─── Sentence Translation ──────────────────────────────────────────

/** Result type for the standalone sentence translator. */
export type SentenceTranslationResult =
  | { ok: true; translation: string }
  | { ok: false; error: LLMError };

/**
 * Translates a single Chinese sentence into English using the slimmed
 * SENTENCE_TRANSLATION_PROMPT. Used for vocab example sentences --
 * either auto-fired by the service worker on "+ Vocab" save when AI
 * Translations is on, or on demand from the vocab card / flashcard
 * "Translate" button.
 *
 * Mirrors queryLLM's resilience layer (per-attempt timeout, jittered
 * backoff for transient codes) and shares its `config.maxTokens`
 * budget. Honoring the same budget as the main pinyin call is what
 * keeps thinking models like Gemini 2.5 Pro working: they spend most
 * of their output budget on internal reasoning before emitting any
 * visible text, so a smaller cap here produced finishReason=MAX_TOKENS
 * with empty parts. The slimmed prompt + tiny {translation} schema
 * still keeps the actual visible payload (and therefore real cost)
 * small in practice.
 */
export async function translateSentence(
  sentence: string,
  config: LLMConfig,
): Promise<SentenceTranslationResult> {
  const apiStyle = PROVIDER_PRESETS[config.provider].apiStyle;
  const totalAttempts = RETRY_DELAYS_MS.length + 1;
  let last: SentenceTranslationResult = {
    ok: false,
    error: { code: "UNKNOWN", message: "Sentence translation failed." },
  };

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (attempt > 1) {
      const baseDelay = RETRY_DELAYS_MS[attempt - 2];
      const jittered = baseDelay * (1 + Math.random() * 0.25);
      await new Promise((r) => setTimeout(r, jittered));
    }

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let result: SentenceTranslationResult;
    let status: string;

    try {
      result = await singleSentenceAttempt(sentence, config, apiStyle, controller.signal);
      status = result.ok ? "ok" : result.error.code;
    } catch (err) {
      const isAbort =
        err && typeof err === "object" &&
        (err as { name?: string }).name === "AbortError";
      result = isAbort
        ? { ok: false, error: { code: "TIMEOUT", message: "Translation timed out. Try again." } }
        : { ok: false, error: { code: "NETWORK_ERROR", message: "Could not reach the LLM provider." } };
      status = result.error.code;
      if (!isAbort) {
        console.error("[LLM-translate] Caught error on attempt %d:", attempt, err);
      }
    } finally {
      clearTimeout(timer);
    }

    logTelemetry({
      provider: config.provider,
      model: config.model,
      attempt,
      status: `translate:${status}`,
      latencyMs: Date.now() - t0,
      partial: false,
      textLen: sentence.length,
      contextLen: 0,
    });

    last = result;
    if (result.ok) return result;
    if (!RETRYABLE_CODES.has(result.error.code)) return result;
  }

  return last;
}

/**
 * One HTTP fetch + parse cycle for the sentence translator. Builds a
 * provider-specific request with SENTENCE_TRANSLATION_PROMPT, then
 * extracts a translation from the JSON payload.
 *
 * Recovery layers (in order, first to produce a non-empty string wins):
 *  1. Strict JSON parse of the model's text payload, reading
 *     `obj.translation`. The happy path on every well-behaved provider.
 *  2. Salvaged JSON parse via tryParseJson(), recovering truncated /
 *     bracket-unbalanced bodies the same way queryLLM() does. Lets us
 *     keep a translation even when the response was cut off mid-JSON.
 *  3. Bare-string fallback for models that ignore the `responseMimeType`
 *     hint and return the translation as raw text without any JSON
 *     wrapper. Gated by a heuristic (see acceptBareTranslation) so we
 *     don't accept random non-translation cruft.
 *
 * Only when all three layers fail to produce a non-empty translation
 * do we surface INVALID_RESPONSE. AbortErrors propagate so the outer
 * retry loop classifies them as TIMEOUT.
 */
async function singleSentenceAttempt(
  sentence: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): Promise<SentenceTranslationResult> {
  const { url, init } = buildSentenceRequest(sentence, config, apiStyle, signal);

  console.log("[LLM-translate] Fetching: %s", redactUrl(url));

  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    console.error(
      "[LLM-translate] HTTP %d %s — body: %s",
      response.status,
      response.statusText,
      body.slice(0, 500),
    );
    return { ok: false, error: classifyHttpError(response.status) };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  const raw = extractRawText(data, apiStyle);
  if (!raw) {
    console.error("[LLM-translate] No text payload in response envelope. Raw:", data);
    return {
      ok: false,
      error: {
        code: "INVALID_RESPONSE",
        message: "The translator returned an empty response. Try again.",
      },
    };
  }

  // Layer 1+2: strict + salvaged JSON parse, sharing queryLLM's
  // tryParseJson so a truncated/comma-trailing body still yields a
  // translation.
  const { value: parsed } = tryParseJson(raw);
  let translation = readTranslation(parsed);

  // Layer 3: bare-string fallback. Some providers occasionally ignore
  // responseMimeType and return the English translation as raw text.
  if (!translation) {
    translation = acceptBareTranslation(raw);
  }

  if (!translation) {
    console.error(
      "[LLM-translate] Could not extract a translation. Raw payload (%d chars):",
      raw.length,
      raw.slice(0, 500),
    );
    return {
      ok: false,
      error: {
        code: "INVALID_RESPONSE",
        message: "The translator returned an empty response. Try again.",
      },
    };
  }

  return { ok: true, translation };
}

/**
 * Extracts and trims `translation` from a parsed JSON object. Returns
 * null when the input isn't an object, the field is missing, the field
 * isn't a string, or the trimmed value is empty.
 */
function readTranslation(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as Record<string, unknown>).translation;
  if (typeof t !== "string") return null;
  const trimmed = t.trim();
  return trimmed ? trimmed : null;
}

/**
 * Heuristic recovery for models that emit a bare English string instead
 * of a {translation: "..."} JSON object. Accepts the raw payload as a
 * translation only when it's plausibly a sentence:
 *   - non-empty after trim,
 *   - doesn't start with `{` or `[` (those were meant to be JSON; if
 *     the salvager couldn't fix them, guessing risks surfacing garbage),
 *   - bounded length (1-500 chars; keeps obvious cruft out),
 *   - contains at least one ASCII letter (filters out pure punctuation
 *     / numeric noise).
 *
 * Surrounding straight or smart quotes are stripped so a model that
 * wraps its output in '"...."' still yields a clean translation.
 */
function acceptBareTranslation(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{") || s.startsWith("[")) return null;
  s = s.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim();
  if (s.length < 1 || s.length > 500) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  return s;
}

/**
 * Provider-specific request builder for the sentence translator.
 * Structurally parallel to buildRequest() and uses the same
 * config.maxTokens as the main pinyin call so thinking models have
 * enough headroom for internal reasoning + the visible JSON payload.
 */
function buildSentenceRequest(
  sentence: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  const userContent = `Chinese sentence: "${sentence}"`;

  if (apiStyle === "gemini") {
    return {
      url: `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: SENTENCE_TRANSLATION_PROMPT + "\n\n" + userContent }] },
          ],
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: "application/json",
          },
        }),
        signal,
      },
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SENTENCE_TRANSLATION_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal,
    },
  };
}
