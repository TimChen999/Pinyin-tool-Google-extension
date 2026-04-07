**Pinyin Tool** is a Chinese reading assistant that works on any webpage. Select Chinese text and instantly see pinyin annotations, word-level definitions, and full-sentence English translations in a clean floating overlay — no copy-pasting into a dictionary app.

**How it works:**
1. Highlight any Chinese text on a webpage with your mouse or keyboard.
2. A floating overlay appears showing pinyin above each character, with clickable words that expand to show definitions.
3. A natural English translation of the full passage appears below.

You can also right-click selected text and choose "Show Pinyin and Translation" from the context menu, or use the keyboard shortcut Alt+Shift+P.

**Core features:**

Pinyin overlay — Pinyin annotations appear above each word using the pinyin-pro library. Supports tone marks, tone numbers, or no tones. Click any word to see its contextual definition. Polyphonic characters are automatically disambiguated using surrounding context.

AI-powered translations — Connect an LLM provider (OpenAI, Google Gemini, Ollama for fully local/offline use, or any OpenAI-compatible endpoint) to get natural English translations and context-aware definitions. Without an LLM, the extension still provides pinyin with no API key or internet required.

Text-to-speech — A speaker button on the overlay reads the selected text aloud with natural pronunciation using the Web Speech API. Toggle it on or off in settings.

OCR text extraction — Click "Select text from image" in the popup, then drag a rectangle over any part of a page to extract Chinese characters from images, screenshots, embedded PDFs, or any non-selectable content. The recognized text feeds into the same pinyin and translation pipeline.

Vocabulary tracking — Click "Add to Vocab" on any word definition to save it. Saved words include pinyin and contextual meaning. A floating vocab card in the popup shows recently saved words with the option to delete individual entries.

Vocab Hub — A full-page study interface for browsing all saved vocabulary in a spacious layout with large characters, pinyin, and definitions. Includes a flashcard mode: pick a session size, flip cards to reveal answers, and mark right or wrong. Scores are tracked per word.

Built-in EPUB reader — Open .epub files directly inside the extension and get the same pinyin overlay and translations you get on web pages. Includes table of contents navigation, reading position persistence, and a recent books list for quick re-opening.

**Settings:**
- Choose your LLM provider and model (or use fully offline mode with Ollama or no LLM at all)
- Pick your pinyin style: tone marks, tone numbers, or no tones
- Adjust overlay font size (12px to 24px)
- Switch between light, dark, or auto theme
- Toggle LLM mode and TTS on or off

All vocabulary and settings are stored locally in your browser. No data is sent anywhere except to your chosen LLM provider when LLM mode is enabled.
