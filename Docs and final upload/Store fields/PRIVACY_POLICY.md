# Privacy Policy for Pinyin Tool — Pinyin & Translation Assistant

Last updated: April 7, 2026

## Overview

Pinyin Tool is a browser extension that helps users read Chinese text by displaying pinyin annotations, word definitions, and English translations. This privacy policy explains what data the extension handles and how it is used.

## Data Storage

All user data is stored locally in your browser using Chrome's built-in storage APIs:

- **Settings** (LLM provider, API key, pinyin style, theme, font size, toggles) are stored in chrome.storage.sync.
- **Saved vocabulary** (Chinese words, pinyin, definitions, flashcard scores) is stored in chrome.storage.local.
- **LLM response cache** (cached translations keyed by text hash) is stored in chrome.storage.local and automatically expires after 7 days.
- **Reading state** (EPUB reading position, recent book list) is stored in chrome.storage.local.

None of this data is transmitted to the extension developer or any third party. It remains entirely in your browser.

## Data Sent to Third-Party Services

When LLM mode is enabled, the extension sends the Chinese text you select on a webpage to the LLM provider you have configured in the extension settings. The supported providers are:

- OpenAI (api.openai.com)
- Google Gemini (generativelanguage.googleapis.com)
- Ollama (runs locally on your machine — no data leaves your device)
- Any custom OpenAI-compatible endpoint you configure

The text is sent solely for the purpose of generating word definitions and English translations. No other data (browsing history, page URLs, personal information) is included in these requests. Each provider's own privacy policy governs how they handle the text they receive.

If LLM mode is disabled or no provider is configured, no data is sent externally. The extension still provides pinyin annotations using a fully offline local library.

## OCR Feature

The OCR feature uses Tesseract.js, which downloads its text recognition engine (WASM binary and trained language model) from cdn.jsdelivr.net at runtime. The image data being recognized is processed entirely on your device and is never uploaded to any server.

## API Keys

If you enter an API key for an LLM provider, it is stored locally in chrome.storage.sync and sent only to the provider you configured. The extension developer has no access to your API key.

## Data Collection by the Developer

The extension developer does not collect, receive, store, or have access to any user data. There is no analytics, telemetry, tracking, or remote server operated by the developer.

## Permissions

- **activeTab**: Used to read your selected text and display the pinyin overlay on the current page.
- **storage**: Used to save your settings, vocabulary, and cached translations locally.
- **contextMenus**: Used to provide a right-click menu option for triggering the pinyin overlay.
- **Host permissions (<all_urls>)**: The content script runs on all pages because Chinese text can appear on any website.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in the "Last updated" date above.

## Contact

If you have questions about this privacy policy, you can reach the developer via the support contact listed on the Chrome Web Store listing page.
