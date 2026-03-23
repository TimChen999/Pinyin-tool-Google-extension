# Data Gathering & Persistence

How information flows through the extension, where it is stored, and how it
persists across sessions.

---

## 1. High-Level Architecture

The extension runs as three isolated processes that communicate via Chrome's
message APIs:

| Process | Entry point | Role |
|---|---|---|
| **Content script** | `content/content.ts` | Captures user text selections on web pages |
| **Service worker** | `background/service-worker.ts` | Orchestrates pinyin lookup, LLM calls, caching, and vocab recording |
| **Popup** | `popup/popup.ts` | Settings UI and vocab list viewer |

Data flows **unidirectionally** from user interaction through to persistent
storage:

```
User selects text
      │
      ▼
Content Script  ──PINYIN_REQUEST──►  Service Worker
      │                                  │
      │                          ┌───────┴────────┐
      │                          ▼                 ▼
      │                    Phase 1:            Phase 2:
      │                    pinyin-pro           LLM Client
      │                    (local, instant)     (remote, async)
      │                          │                 │
      ◄──PINYIN_RESPONSE_LOCAL───┘                 │
      │                                            ▼
      │                                    ┌───────┴────────┐
      │                                    ▼                 ▼
      │                               Cache (R/W)     Vocab Store (W)
      │                                    │
      ◄───────PINYIN_RESPONSE_LLM──────────┘
      │
      ▼
   Overlay (Shadow DOM, ephemeral)
```

---

## 2. Storage Mechanisms

The extension uses two Chrome storage APIs, each with different scope and
lifetime:

### 2.1 `chrome.storage.sync` — User Settings

**What it stores:** The `ExtensionSettings` object.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `provider` | `"openai" \| "gemini" \| "ollama" \| "custom"` | `"openai"` | Active LLM backend |
| `apiKey` | `string` | `""` | API key for the chosen provider |
| `baseUrl` | `string` | Provider preset URL | Endpoint for API calls |
| `model` | `string` | Provider default model | LLM model name |
| `pinyinStyle` | `"toneMarks" \| "toneNumbers" \| "none"` | `"toneMarks"` | How pinyin is displayed |
| `fontSize` | `number` | `16` | Overlay font size |
| `theme` | `"light" \| "dark" \| "auto"` | `"auto"` | Overlay color scheme |
| `llmEnabled` | `boolean` | `true` | Whether Phase 2 LLM calls run at all |

**Persistence characteristics:**
- Survives browser restarts, extension updates, OS reboots.
- Syncs across devices via the user's Google account.
- Cleared only on extension uninstall.

**Functions that interact with it:**

| Function | File | Operation |
|---|---|---|
| `loadSettings()` | `popup/popup.ts` | **Read** — loads settings into the popup form |
| `getSettings()` | `background/service-worker.ts` | **Read** — reads settings on every incoming request |
| `saveBtn click handler` | `popup/popup.ts` | **Write** — `chrome.storage.sync.set(values)` on save |
| Theme cache listener | `content/content.ts` | **Read** — reads `theme` once at init, then watches `chrome.storage.onChanged` |

Both `loadSettings()` and `getSettings()` merge stored values with
`DEFAULT_SETTINGS` (from `shared/constants.ts`), so any missing keys
automatically get sensible defaults.

### 2.2 `chrome.storage.local` — Cache & Vocab Store

Local storage holds two distinct data structures under separate key
namespaces. It does **not** sync across devices.

---

## 3. LLM Response Cache

**Module:** `background/cache.ts`

**Purpose:** Avoids redundant LLM API calls when the user re-selects the same
text. Saves both money (for paid providers) and latency.

### 3.1 Key Generation

```
hashText(text + context)  →  SHA-256 hex string
```

The cache key is a SHA-256 hash of the selected text concatenated with its
surrounding paragraph context. This means:

- The same text in **different paragraphs** gets separate entries with
  contextually correct definitions.
- The same text in the **same context** always hits the cache.

**Function:** `hashText(text: string): Promise<string>` — uses the Web Crypto
API (`crypto.subtle.digest`), available in service workers.

### 3.2 Cache Entry Shape

Each entry stored in `chrome.storage.local` is keyed by the hex hash:

```typescript
interface CacheEntry {
  data: LLMResponse;   // { words: WordData[], translation: string }
  timestamp: number;    // Date.now() at write time
}
```

### 3.3 Reading from Cache

**Function:** `getFromCache(key: string): Promise<LLMResponse | null>`

1. Looks up the key in `chrome.storage.local`.
2. If the entry exists but is **older than 7 days** (`CACHE_TTL_MS`), it is
   lazily deleted and `null` is returned.
3. Otherwise, the `LLMResponse` data is returned.

**Called by:** `handleLLMPath()` in `service-worker.ts` — checked before every
LLM API call.

### 3.4 Writing to Cache

**Function:** `saveToCache(key: string, data: LLMResponse): Promise<void>`

Writes a `CacheEntry` with the current timestamp. Overwrites any previous
entry for the same key.

**Called by:** `handleLLMPath()` in `service-worker.ts` — after a successful
LLM response.

### 3.5 Bulk Eviction

**Function:** `evictExpiredEntries(): Promise<void>`

Two-pass housekeeping:

1. **Pass 1:** Remove every entry whose timestamp exceeds `CACHE_TTL_MS`
   (7 days).
2. **Pass 2:** If remaining entries exceed `MAX_CACHE_ENTRIES` (5,000), sort
   by timestamp (oldest first) and delete the excess.

**Called by:** `chrome.runtime.onInstalled` listener in `service-worker.ts` —
runs on first install and on every extension update.

### 3.6 Full Clear

**Function:** `clearCache(): Promise<void>`

Wipes all of `chrome.storage.local` (settings live in `sync`, so they are
unaffected).

### 3.7 Cache Configuration Constants

Defined in `shared/constants.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `CACHE_TTL_MS` | 604,800,000 (7 days) | Time-to-live for each cache entry |
| `MAX_CACHE_ENTRIES` | 5,000 | Hard cap on total cached responses |

---

## 4. Vocabulary Store

**Module:** `background/vocab-store.ts`

**Purpose:** Builds a long-term frequency profile of every Chinese word the
user encounters, tracking how often each word appears and when it was first
and last seen.

### 4.1 Storage Layout

All vocab entries live under a single `chrome.storage.local` key:
`"vocabStore"`.

The value is a `Record<string, VocabEntry>` keyed by the word's characters
(`chars`).

### 4.2 VocabEntry Shape

```typescript
interface VocabEntry {
  chars: string;       // e.g. "银行"
  pinyin: string;      // e.g. "yín háng"
  definition: string;  // e.g. "bank"
  count: number;       // frequency — incremented on each encounter
  firstSeen: number;   // Date.now() when first recorded
  lastSeen: number;    // Date.now() of most recent encounter
}
```

### 4.3 Recording Words

**Function:** `recordWords(words: Required<WordData>[]): Promise<void>`

Called after every successful LLM response (both cache hits and fresh API
calls). For each word in the batch:

1. **Stop-word filter:** Skips common function words (的, 了, 是, 在, etc.)
   defined in `VOCAB_STOP_WORDS` (35 words). These appear in nearly every
   sentence and would flood the list with words the user certainly already
   knows.
2. **Existing word:** Increments `count`, updates `lastSeen`, and refreshes
   `pinyin` and `definition` to the latest values.
3. **New word:** Creates an entry with `count: 1` and both `firstSeen` and
   `lastSeen` set to now.
4. **Eviction:** If total entries exceed `MAX_VOCAB_ENTRIES` (10,000), the
   **least-frequent** entries (lowest `count`) are dropped.

**Called by:** `handleLLMPath()` in `service-worker.ts` — after sending the
Phase 2 response to the content script.

### 4.4 Reading All Vocab

**Function:** `getAllVocab(): Promise<VocabEntry[]>`

Returns all stored entries as a flat array. Returns `[]` if no store exists
yet.

**Called by:** `renderVocabList()` in `popup/popup.ts` — when the user
switches to the Vocab tab.

### 4.5 Clearing Vocab

**Function:** `clearVocab(): Promise<void>`

Removes the entire `vocabStore` key from `chrome.storage.local`.

**Called by:** The "Clear" button click handler in `popup/popup.ts` — with a
confirmation dialog.

### 4.6 Vocab Configuration Constants

Defined in `shared/constants.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `MAX_VOCAB_ENTRIES` | 10,000 | Hard cap on stored words |
| `VOCAB_STOP_WORDS` | `Set` of 35 function words | Words excluded from recording |

### 4.7 Vocab Display in Popup

`renderVocabList()` in `popup/popup.ts` fetches all entries via
`getAllVocab()` and supports two sort modes:

- **"recent"** — sorted by `lastSeen` (newest first)
- **"frequent"** — sorted by `count` (highest first)

Each row displays: characters, pinyin, definition, and encounter count.

---

## 5. Ephemeral / In-Memory Data

Not all data is persisted. The following exist only in memory for the duration
of a single interaction:

### 5.1 Content Script State (`content/content.ts`)

| Variable | Purpose | Lifetime |
|---|---|---|
| `currentRequestId` | Monotonic counter that discards responses from superseded selections | Page session |
| `cachedTheme` | Cached copy of the `theme` setting to avoid async reads on every overlay render | Page session (updated via `chrome.storage.onChanged`) |

### 5.2 Overlay DOM State (`content/overlay.ts`)

| Variable | Purpose | Lifetime |
|---|---|---|
| `shadowRoot` | Reference to the Shadow DOM root element | Until dismissed |
| `hostElement` | Reference to the `#hg-extension-root` div | Until dismissed |

The overlay is a pure DOM construct inside a Shadow DOM. It holds no
persistent state — it is created on each selection and destroyed on dismiss
(click-outside, Escape, or new selection).

### 5.3 LLM Client (`background/llm-client.ts`)

The LLM client is stateless. Each call to `queryLLM()` is independent:
it constructs a fetch request, parses the response, and returns. No
request history, conversation context, or token tracking is retained.

### 5.4 Pinyin Service (`background/pinyin-service.ts`)

`convertToPinyin()` is a pure function wrapping `pinyin-pro`'s `segment()`
API. No state. No caching. Input in, output out.

---

## 6. Data Lifecycle Summary

### 6.1 What Happens When the User Selects Chinese Text

| Step | Component | Data action |
|---|---|---|
| 1 | Content script | Captures selection text + surrounding context (up to 500 chars). Truncates selection to 500 chars if needed. |
| 2 | Service worker | Reads `ExtensionSettings` from `chrome.storage.sync` |
| 3 | Pinyin service | Converts text → `WordData[]` (pure, no storage) |
| 4 | Service worker | Returns Phase 1 response to content script |
| 5 | Content script | Renders overlay with local pinyin (ephemeral DOM) |
| 6 | Service worker | Computes SHA-256 cache key from `text + context` |
| 7 | Cache module | Checks `chrome.storage.local` for cached LLM response |
| 8a | *(cache hit)* | Sends cached response to content script, records words to vocab store |
| 8b | *(cache miss)* | Calls LLM API, saves response to cache, sends to content script, records words to vocab store |
| 9 | Content script | Updates overlay with definitions + translation (ephemeral DOM) |
| 10 | Vocab store | Entry counts incremented / new entries created in `chrome.storage.local` |

### 6.2 What Happens When the User Opens the Popup

| Step | Component | Data action |
|---|---|---|
| 1 | Popup | Reads `ExtensionSettings` from `chrome.storage.sync` → populates form |
| 2 | Popup | On "Save" click → validates inputs → writes to `chrome.storage.sync` |
| 3 | Popup | On Vocab tab → reads all entries from `chrome.storage.local` via `getAllVocab()` |
| 4 | Popup | On "Clear" → removes `vocabStore` from `chrome.storage.local` via `clearVocab()` |

### 6.3 What Happens on Extension Install/Update

| Step | Component | Data action |
|---|---|---|
| 1 | Service worker | `chrome.runtime.onInstalled` fires |
| 2 | Cache module | `evictExpiredEntries()` removes entries older than 7 days and trims to 5,000 max |
| 3 | Service worker | Creates the context menu item |

---

## 7. Persistence Comparison Table

| Data | Storage API | Survives restart? | Survives update? | Survives uninstall? | Syncs across devices? | Expiry policy |
|---|---|---|---|---|---|---|
| User settings | `chrome.storage.sync` | Yes | Yes | No | Yes | None — persists indefinitely |
| LLM cache | `chrome.storage.local` | Yes | Yes | No | No | 7-day TTL + 5,000 entry cap |
| Vocab store | `chrome.storage.local` | Yes | Yes | No | No | No time expiry; 10,000 entry cap (least-frequent evicted) |
| Overlay DOM | In-memory (Shadow DOM) | No | No | N/A | No | Destroyed on dismiss |
| Request counter | In-memory | No (page session) | No | N/A | No | Reset on page navigation |
| Theme cache | In-memory | No (page session) | No | N/A | No | Re-read on page load, live-updated via `onChanged` |

---

## 8. Function Reference by Storage Operation

### Writes

| Function | File | Target | What it writes |
|---|---|---|---|
| `saveBtn` click handler | `popup/popup.ts:269-278` | `chrome.storage.sync` | Full `ExtensionSettings` object |
| `saveToCache()` | `background/cache.ts:71-77` | `chrome.storage.local` | `CacheEntry` (LLM response + timestamp) |
| `recordWords()` | `background/vocab-store.ts:24-63` | `chrome.storage.local` | Batch of `VocabEntry` updates under `vocabStore` key |

### Reads

| Function | File | Source | What it reads |
|---|---|---|---|
| `loadSettings()` | `popup/popup.ts:53-56` | `chrome.storage.sync` | All stored settings (merged with defaults) |
| `getSettings()` | `background/service-worker.ts:43-46` | `chrome.storage.sync` | All stored settings (merged with defaults) |
| Theme init | `content/content.ts:239-241` | `chrome.storage.sync` | `theme` key only |
| `getFromCache()` | `background/cache.ts:51-63` | `chrome.storage.local` | Single cache entry by SHA-256 key |
| `getAllVocab()` | `background/vocab-store.ts:69-74` | `chrome.storage.local` | Entire `vocabStore` record |
| `evictExpiredEntries()` | `background/cache.ts:87-116` | `chrome.storage.local` | All keys (for bulk cleanup) |

### Deletes

| Function | File | Target | What it removes |
|---|---|---|---|
| `getFromCache()` (lazy) | `background/cache.ts:57-59` | `chrome.storage.local` | Single expired cache entry |
| `evictExpiredEntries()` | `background/cache.ts:87-116` | `chrome.storage.local` | Expired + over-limit cache entries |
| `clearCache()` | `background/cache.ts:121-123` | `chrome.storage.local` | All local storage (full wipe) |
| `clearVocab()` | `background/vocab-store.ts:79-81` | `chrome.storage.local` | `vocabStore` key |
| `recordWords()` (eviction) | `background/vocab-store.ts:53-60` | `chrome.storage.local` | Least-frequent vocab entries when over 10,000 cap |

### Listeners (Reactive Reads)

| Listener | File | Watches | Purpose |
|---|---|---|---|
| `chrome.storage.onChanged` | `content/content.ts:243-247` | `chrome.storage.sync` (`theme` key) | Keeps `cachedTheme` in sync without polling |
