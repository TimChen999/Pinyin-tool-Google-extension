# Permission Justifications

## activeTab justification

Used to access the content of the currently active tab when the user selects Chinese text or triggers the pinyin overlay. The extension reads the selected text from the page to generate pinyin annotations, word definitions, and translations. It also injects a Shadow DOM overlay to display results directly on the page. Without activeTab, the extension cannot read the user's text selection or render the overlay.

## storage justification

Used to persist user settings (LLM provider, API key, pinyin style, theme, font size, TTS toggle) and saved vocabulary across browser sessions via chrome.storage.sync and chrome.storage.local. Vocabulary entries include the Chinese word, its pinyin, and contextual definition. The EPUB reader also stores reading position and recent book history. All data stays local to the user's browser.

## contextMenus justification

Used to add a single right-click context menu item ("Show Pinyin and Translation") that lets users trigger the pinyin overlay on their current text selection. While the overlay also appears automatically on text selection via mouseup, the context menu serves as a necessary fallback: some single-page applications and heavily scripted pages intercept or suppress mouseup events, preventing the automatic trigger from working. The context menu bypasses this because Chrome handles it at the browser level. It also allows users to re-trigger the overlay after dismissing it without re-selecting the text.

## Host permission justification

The extension uses the <all_urls> host permission because Chinese text can appear on any website — news sites, social media, documentation, email, forums, and more. The content script must be injected on every page to detect when the user selects Chinese text and display the pinyin overlay. Restricting to specific domains would make the extension unusable on the majority of pages where users encounter Chinese text. The extension only activates when the user selects text containing Chinese characters; it does not read or modify page content otherwise.
