# Pinyin Tool — Click-to-Lookup Redesign

Status: in-progress (April 2026). Replaces the selection→LLM flow with a Zhongwen-style
hover-preview + Du-Chinese-style click-to-translate model backed by an offline CC-CEDICT
dictionary, with the LLM as a contextual upgrade applied per sentence.

This document is the source of truth for the redesign. It is consumed by the
implementation; if implementation diverges, update this doc first.

---

## 1. Goals

1. **Click replaces selection.** Users click a word; nothing requires `mouseup` over a
   selectable text run. Works on `user-select: none` pages, in `<input>`/`<textarea>`,
   in same-origin iframes — anywhere `caretRangeFromPoint` returns a text node.

2. **Hover previews the click.** As the cursor moves, the word that *would* be looked up
   on click is highlighted live. Sub-millisecond feedback, no popup, no network.

3. **Two-tier popup.**
   - Word tier: pinyin + definition for the clicked word.
   - Sentence tier: English translation of the surrounding sentence, with that sentence
     also highlighted on the page (lighter color than the word).

4. **CC-CEDICT is the offline truth, LLM is the contextual upgrade.** A click is always
   answered instantly from CC-CEDICT and Chrome's on-device Translator. When the LLM
   returns for that sentence, its better word boundaries, contextual pinyin, contextual
   gloss, and richer translation replace the bootstrap data — for that sentence only —
   and persist in cache for future visits.

5. **Backwards compatible UX:** vocab capture, OCR, EPUB reader, library, hub, popup,
   theming, TTS, settings — all keep working. The redesign affects the *interaction
   model on web pages* and the *message protocol*, not the surrounding features.

## 2. Non-goals

- Reader/EPUB redesign. The reader keeps its current selection-based flow for now;
  porting to click-mode is a follow-up.
- LLM removal. The LLM stays as the quality ceiling; only its critical-path role
  is gone.
- Mobile/touch. Click works on touch (tap), but tap-and-hold patterns are not designed
  for in this pass.
- Cross-origin iframe lookup. Browser-blocked.

---

## 3. Interaction model — state machine per sentence

Each sentence on the page lives in one of three states:

| State | Trigger | Hover/click uses | Popup word data | Sentence translation |
|-------|---------|------------------|-----------------|----------------------|
| **Cold** | initial | nothing (no highlight on hover yet) | — | — |
| **Bootstrap** | user clicked a word in this sentence | CC-CEDICT longest-match | CC-CEDICT entry | Chrome on-device translator if available, else empty |
| **Hot** | LLM returned for this sentence | LLM `words[]` array | LLM `pinyin` + `gloss` | LLM translation |

Transitions:

```
        click in this sentence
Cold ───────────────────────────► Bootstrap
                                    │
                                    │  LLM resolves for this sentence
                                    ▼
                                  Hot
```

A sentence in Hot state stays Hot for the page session and persists in the per-sentence
cache so repeat visits start Hot. The transition Bootstrap→Hot does **not** retarget
the user's currently-locked click highlight; only the popup contents update in place,
and subsequent hover/click in this sentence use LLM boundaries.

## 4. Component architecture

```
┌─────────────────────────────── content script ────────────────────────────────┐
│                                                                                │
│  ┌─ events ─────────┐    ┌─ caret-finder ──┐    ┌─ word/sentence resolver ──┐  │
│  │ mousemove (rAF)  │───▶│ caretRangeFrom  │───▶│ longest-match (cedict-    │  │
│  │ click (capture)  │    │ Point + input/  │    │ lookup) → wordRange       │  │
│  │ keydown (Esc)    │    │ textarea branch │    │ sentence walk → sentRange │  │
│  └──────────────────┘    └─────────────────┘    └────────────┬──────────────┘  │
│                                                              │                 │
│                                       ┌──────────────────────▼─────────────┐   │
│                                       │ highlight controller               │   │
│                                       │  CSS Custom Highlight API:         │   │
│                                       │   ::highlight(pt-hover)            │   │
│                                       │   ::highlight(pt-word)             │   │
│                                       │   ::highlight(pt-sentence)         │   │
│                                       └──────────────┬─────────────────────┘   │
│                                                      │                         │
│                                       ┌──────────────▼────────────┐            │
│                                       │ overlay (Shadow DOM)      │            │
│                                       │  word tier + sent tier    │            │
│                                       └──────────────┬────────────┘            │
│                                                      │                         │
│        ┌────── on click: bootstrap fill ─────────────┤                         │
│        │                                             │                         │
│        ▼                                             ▼                         │
│  ┌──────────────────┐                 ┌──────────────────────────┐             │
│  │ cedict-lookup    │                 │ Chrome on-device         │             │
│  │ (in-memory Map)  │                 │ translator (zh→en)       │             │
│  └──────────────────┘                 └──────────────────────────┘             │
│                                                                                │
│  ┌── chrome.runtime.sendMessage(SENTENCE_TRANSLATE_REQUEST) ──────────────┐   │
└──┼─────────────────────────────────────────────────────────────────────────┼───┘
   │                                                                         │
   ▼                                                                         │
┌─────────────────────────── service worker ──────────────────────────────┐  │
│                                                                          │  │
│  sentence-cache (chrome.storage.local) ◄── lookup ──► LLM client (JSON) ─┼──┘
│                                                                          │   ◄── PINYIN_RESPONSE_LLM
│  vocab store, OCR capture, context-menu/command (unchanged)             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## 5. New files

| Path | Purpose |
|------|---------|
| `public/dict/cedict_ts.u8` | CC-CEDICT data file (~10 MB, downloaded by build script). Bundled into the extension dist. |
| `scripts/download-cedict.mjs` | npm prebuild script that downloads CC-CEDICT from MDBG if not present. |
| `src/shared/cedict-types.ts` | Type definitions for CC-CEDICT entries and lookup results. |
| `src/shared/cedict-lookup.ts` | Loader, parser, longest-match search, in-memory map. Loaded in the content script. |
| `src/content/caret-from-point.ts` | DOM caret API wrapper with input/textarea branch. |
| `src/content/sentence-detect.ts` | Walks text nodes to find the sentence range around a caret position. |
| `src/content/page-highlight.ts` | CSS Custom Highlight API controller (hover, word, sentence ranges). |
| `src/shared/sentence-cache.ts` | Per-sentence cache layer (Bootstrap entries + Hot entries). |

## 6. Modified files (and what changes)

| File | Change |
|------|--------|
| `src/content/content.ts` | Replace `mouseup`-driven selection flow with `mousemove` (rAF-throttled) hover preview + `click` (capture phase) commit. Old selection flow remains as opt-in fallback so context-menu/Alt+Shift+P still work. |
| `src/content/overlay.ts` | New popup layout: word tier (chars + pinyin + gloss + +Vocab + TTS) and sentence tier (translation only — original sentence is on the page, highlighted). Old `showOverlay`/`updateOverlay` API kept as thin aliases for the OCR + context-menu paths. |
| `src/content/overlay.css` | New tier styles + transition states. |
| `src/shared/types.ts` | New message types `SENTENCE_TRANSLATE_REQUEST` / `SENTENCE_TRANSLATE_RESPONSE_LLM` / `SENTENCE_TRANSLATE_ERROR`. New `LLMSentenceResponse` shape (`{translation, words: [{text, pinyin, gloss}]}`). Existing `PinyinRequest` / `PinyinResponseLLM` retained for OCR + context-menu paths. |
| `src/shared/constants.ts` | New `CEDICT_DICT_URL`, `CEDICT_MAX_LOOKUP_CHARS`, `SENTENCE_DELIMS`. New `SYSTEM_PROMPT_SENTENCE` for the new LLM JSON shape. |
| `src/background/service-worker.ts` | New listener for `SENTENCE_TRANSLATE_REQUEST` — checks cache, calls `queryLLMSentence`, sends `SENTENCE_TRANSLATE_RESPONSE_LLM`. Old `PINYIN_REQUEST` listener stays for OCR + context-menu compatibility. |
| `src/background/llm-client.ts` | New `queryLLMSentence(sentence, config) → {translation, words: [{text, pinyin, gloss}]}`. Old `queryLLM` retained. |
| `src/background/cache.ts` | New helpers `getSentenceFromCache(sentence)` / `saveSentenceToCache`, separate from the existing text+context cache. |
| `manifest.json` | Add `web_accessible_resources` for `dict/*` so the content script can `fetch(chrome.runtime.getURL("dict/cedict_ts.u8"))`. |
| `package.json` | New `prebuild` and `postinstall` scripts that run `node scripts/download-cedict.mjs`. |

## 7. Wire format

### 7.1. New: SENTENCE_TRANSLATE_REQUEST (content → SW)

```ts
{
  type: "SENTENCE_TRANSLATE_REQUEST",
  sentence: string,              // the sentence text, used as cache key
  pinyinStyle: PinyinStyle,
  requestId: number,             // monotonic, lets content drop superseded responses
}
```

### 7.2. New: SENTENCE_TRANSLATE_RESPONSE_LLM (SW → content)

```ts
{
  type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
  sentence: string,              // echoed for matching
  requestId: number,
  translation: string,
  words: Array<{
    text: string,                // the segmented chunk (word/punctuation)
    pinyin: string,              // contextual pinyin in the requested style
    gloss: string,               // contextual English gloss; "" for punctuation
  }>,
}
```

The LLM's `words` array MUST concatenate (with no spaces) to `sentence` — the
content script validates this on receipt and discards the response if it doesn't,
keeping the sentence in Bootstrap state.

### 7.3. New: SENTENCE_TRANSLATE_ERROR (SW → content)

```ts
{
  type: "SENTENCE_TRANSLATE_ERROR",
  sentence: string,
  requestId: number,
  error: string,
  code: LLMErrorCode,
}
```

## 8. CC-CEDICT loader design

- File location: `dist/dict/cedict_ts.u8` after build (copied from `public/dict/`).
- Download: `scripts/download-cedict.mjs` fetches from `https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz`, gunzips, writes to `public/dict/cedict_ts.u8`. Skipped if the file already exists.
- Parse: ~123k lines of `Trad Simp [pin1 yin1] /def1/def2/`. We index *only the simplified headword* in a `Map<string, CedictEntry[]>`. Multiple entries per headword (homographs) are stored in array order.
- The full ~10 MB string is parsed once at content-script load — runs in a `requestIdleCallback` so it doesn't block initial paint. While parsing, hover/click silently fall back to single-char highlight (no lookup yet); after parse completes (~150-300 ms), the full longest-match flow is live.
- Memory: ~12-18 MB (string + Map overhead). Acceptable for a content script that's only loaded on tabs the user has activated.
- Lookup: `findLongest(text: string, maxLen = 30) → { entry, length } | null`. Loop from `min(maxLen, text.length)` down to 1, returning on first hit. Sub-millisecond.

### 8.1. Why no .idx binary-search file

Zhongwen ships a separate sorted `cedict.idx` for binary search over the raw `.u8`
file. We skip it because:
- A `Map<string, Entry[]>` is faster than binary search (O(1) vs O(log n)).
- Skipping the index file shrinks the bundle (~3 MB saved).
- Parse cost is ~200 ms once; subsequent lookups are trivially fast.
- The .idx code in Zhongwen is GPLv2 and we want a clean reimplementation.

### 8.2. Pinyin formatting

CC-CEDICT pinyin is `[pin1 yin1]` with numeric tones, separated by spaces, optional
`r5` for erhua, `xx5` for unknown. We normalize at parse time into the user's
preferred style by reusing the same `pinyin-pro` formatter mappings already in
`pinyin-service.ts`:

- `toneMarks` → `pīn yīn` (diacritics)
- `toneNumbers` → `pin1 yin1` (preserve as-is)
- `none` → `pin yin` (strip)

For Bootstrap (CC-CEDICT) the pinyin is exactly what the dictionary has. The LLM
overrides this in the Hot state when it picks a different polyphone reading.

## 9. Sentence detection

Algorithm (`sentence-detect.ts`):

1. Start at caret `(textNode, offset)`.
2. Walk **backward** through `textNode.data`, then through preceding text nodes via
   a `TreeWalker(NodeFilter.SHOW_TEXT)` filter that stays inside the same block-level
   ancestor (P, DIV, ARTICLE, SECTION, BODY). Stop at the first delimiter in
   `SENTENCE_DELIMS = [。, ！, ？, ！, ？, !, ?, \n]` (or block-level boundary).
3. Walk **forward** the same way, stop at the first delimiter (inclusive).
4. Concatenate the captured segments into a single string. Build a `Range` that
   spans the same start→end. Return both.

Edge cases:
- No delimiter found in either direction → use block-level ancestor's text.
- Sentence cap of 500 chars (= existing `MAX_SELECTION_LENGTH`) — anything beyond is
  trimmed at a delimiter or hard-truncated.
- Newlines inside `<pre>`/`<br>` blocks: treat `\n` as a delimiter only when no CJK
  delimiter is closer.

## 10. Highlight controller

Three named highlights:

```css
::highlight(pt-hover)    { background: rgba(255,200,0,0.30); }
::highlight(pt-word)     { background: rgba(255,200,0,0.55); }
::highlight(pt-sentence) { background: rgba(255,200,0,0.18); }
```

Operations:
- `setHover(range | null)` — replaces the single hover range. Throttled by `requestAnimationFrame`.
- `setWord(range | null)` — locked highlight on the clicked word.
- `setSentence(range | null)` — locked highlight on the surrounding sentence.
- `clearAll()` — wipe all three.

Browser fallback: if `CSS.highlights` is undefined (Safari, old browsers), no highlight
is drawn but the popup still works — graceful degradation. We do not ship a
`<span>`-wrapping fallback in this pass; the user already loses some platform features
on those browsers and the lack of highlight is the smallest of those losses.

## 11. Content script lifecycle (rewritten flow)

```
load:
  parseCedictAsync()  -- ~200ms
  prewarmTranslator() -- on first user gesture
  install listeners (mousemove/click/keydown), capture phase

mousemove (rAF-throttled):
  caretFromPoint(x, y) → (textNode, offset) | null
  if textNode is HTMLInputElement/HTMLTextAreaElement → use el.value + selectionStart proxy
  if !containsChinese(textNode.data near offset) → setHover(null)
  word = cedictLookup.findLongest(textNode.data.slice(offset, offset+30))
  range = buildRange(textNode, offset, offset+word.length)
  setHover(range)

click (capture):
  if click target is inside #hg-extension-root → return (let popup handle it)
  caret = caretFromPoint(...)
  if no Chinese under cursor → return (don't preventDefault; let page handle)
  preventDefault()
  word = findLongest(...)
  sentence = sentenceDetect.from(caret)
  setWord(word.range); setSentence(sentence.range)
  popup.showWord({chars, pinyin, gloss}, anchorRect=word.range.boundingClientRect())
  popup.showSentenceLoading()
  // Bootstrap sentence translation: Chrome on-device translator
  translateChineseToEnglish(sentence.text).then(r => {
    if state still bootstrap-or-cold for this sentence: popup.setSentence(r.translation, "bootstrap")
  })
  // Hot path: ask SW for LLM result
  sendMessage({type: SENTENCE_TRANSLATE_REQUEST, sentence: sentence.text, requestId})

receive SENTENCE_TRANSLATE_RESPONSE_LLM:
  if requestId stale → ignore
  validate: words concat == sentence; otherwise discard, keep Bootstrap
  cache.set(sentence, response)  // moves to Hot
  popup.upgradeWord(matchingWord)
  popup.setSentence(response.translation, "llm")
  // future hover/click in this sentence uses response.words for boundaries

dismiss:
  click outside Shadow root → clearAll(), close popup
  Escape → same
```

## 12. LLM prompt (sentence mode)

```
SYSTEM_PROMPT_SENTENCE = """
You are a Chinese language assistant.
Given one Chinese sentence, return:
1. A natural English translation.
2. The sentence segmented into words / punctuation. The `text` fields MUST
   concatenate (no extra spaces) to exactly the input sentence.
3. For each word: contextual pinyin and a concise contextual English gloss.
   For punctuation entries, leave gloss as "" and pinyin as "".

Respond with ONLY this JSON:
{
  "translation": "<English>",
  "words": [
    { "text": "<Chinese chars>", "pinyin": "<pinyin>", "gloss": "<English>" }
  ]
}
"""
```

Pinyin style is requested in the user message: "Format pinyin with tone marks." or
"…with tone numbers." or "…without tones."

## 13. Caching strategy

Two cache namespaces in `chrome.storage.local`:

1. **Existing keyed-by-text+context** cache for the legacy `PINYIN_REQUEST` flow used
   by OCR and context-menu. Unchanged.

2. **New sentence cache**: key = `sha256(sentence + pinyinStyle + provider + model)`,
   value:
   ```ts
   { kind: "sentence-llm", sentence, translation, words, timestamp }
   ```
   TTL: same `CACHE_TTL_MS` (7d). Eviction: same `MAX_CACHE_ENTRIES`.

Bootstrap (Chrome translator) results are not cached on the SW side — the on-device
translator is fast enough that re-running it is cheaper than a cache round-trip.
The content script keeps a per-tab in-memory `Map<sentence, BootstrapResult>` so a
second click on the same sentence in the same tab is instant even before the LLM
returns.

## 14. Failure modes

| Condition | Bootstrap behavior | Hot behavior |
|-----------|--------------------|--------------|
| LLM disabled in settings | Word data + Chrome translator | n/a (stays Bootstrap) |
| LLM error / timeout | Word data + Chrome translator | popup shows error badge; sentence translation is the Bootstrap one |
| Chrome translator unavailable | Word data only; sentence row shows "Translation unavailable" | LLM fills it later |
| Both off | CC-CEDICT-only popup | n/a |
| CC-CEDICT not yet parsed (startup ~200 ms) | single-character highlight + popup with "Loading dictionary..." | unchanged |
| caret not in Chinese text | no hover, no popup | unchanged |
| LLM returns invalid `words` (concat mismatch) | discard; sentence stays Bootstrap | n/a |

## 15. Test plan

New tests:
- `tests/shared/cedict-lookup.test.ts` — parser, longest-match, polyphone homographs.
- `tests/content/caret-from-point.test.ts` — DOM-only behavior (jsdom mocks).
- `tests/content/sentence-detect.test.ts` — boundary walking across text nodes.
- `tests/content/page-highlight.test.ts` — highlight registry calls (when API available).
- `tests/integration/click-flow.test.ts` — full click path: mock SW round-trip,
  verify Bootstrap → Hot transitions, verify cached Hot starts hot.

Updated tests:
- `tests/content/content.test.ts` — selection-based mouseup tests removed; click-based
  tests added.
- `tests/content/overlay.test.ts` — new tier shape.
- `tests/background/service-worker.test.ts` — new SENTENCE_TRANSLATE_REQUEST handler.
- `tests/background/llm-client.test.ts` — new `queryLLMSentence`.

Kept untouched:
- vocab store / SRS / theme / Chinese detect / fallback translation / popup / library /
  hub / reader.

## 16. Implementation order

1. Architecture plan (this doc).
2. CC-CEDICT download script + dictionary loader + tests.
3. Caret/sentence/highlight modules + tests.
4. New types and message protocol (SENTENCE_TRANSLATE_*).
5. New `queryLLMSentence` in llm-client.
6. Sentence cache.
7. Service worker SENTENCE_TRANSLATE_REQUEST handler.
8. Content script rewrite (hover + click flow, state machine).
9. Overlay redesign (two tiers).
10. Glue: prewarm translator on init, settings flags.
11. Test pass: update broken tests, add new ones.
12. `npm test`, fix failures.
13. `npm run build`, verify dist contains `dict/cedict_ts.u8`.

## 17. Out of scope (follow-ups)

- Reader (EPUB) integration with the new click flow. The reader currently uses the
  selection-based overlay; a follow-up will inject the same click handlers.
- Mobile/touch optimization (longpress as click variant, touch-friendly popup
  sizing).
- Multi-language dictionaries (zh→en is the only direction).
- Dictionary user customization (user-defined entries override CC-CEDICT).
- A "translate whole paragraph" button on the popup — possible follow-up if users
  ask for it.
