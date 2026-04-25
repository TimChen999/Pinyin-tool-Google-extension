---
name: theme-scrollbars-native-controls
overview: Theme the OS-default scrollbars and native form controls (range slider, checkboxes, radios) across the popup, hub, library, and reader settings modal so they stop clashing with sepia and dark themes.
todos:
  - id: popup-css
    content: Add scrollbar + accent-color rules to src/popup/popup.css for default, dark, and sepia themes (body + .vocab-list)
    status: completed
  - id: hub-css
    content: Add scrollbar + accent-color rules to src/hub/hub.css for default, dark, and sepia themes (.hub-tab-content)
    status: completed
  - id: library-css
    content: "Add scrollbar rules to src/library/library.css for default, dark, and sepia themes (#library-pane-vocab, #library-pane-flashcards)"
    status: completed
  - id: reader-css
    content: "Append .settings-inner to existing scrollbar selectors in src/reader/reader.css:527-555 and add accent-color: var(--accent) on body"
    status: completed
isProject: false
---

# Theme Scrollbars and Native Controls

## Problem

Only [src/reader/reader.css](src/reader/reader.css) themes its scrollbars. Every other surface (popup, hub tab content, library panes, the reader's settings modal) shows the OS-default scrollbar — a gray slab that's especially jarring against the sepia cream background. Native `<input type="range">`, `<input type="checkbox">`, `<input type="radio">` also inherit Windows blue regardless of theme.

## Color tokens per theme

These mirror what already exists as `--border` / `--accent` in `src/reader/reader.css:22-33`:

- **Light**: thumb `#d1d5db`, hover `#3b82f6`
- **Dark**: thumb `#4b5563`, hover `#60a5fa`
- **Sepia**: thumb `#d4c8ab`, hover `#b8860b`

## File 1: [src/popup/popup.css](src/popup/popup.css)

Two scroll containers: `body` itself (popup overflows Chrome's max popup height) and `.vocab-list` at line 434-437.

Add a new "Scrollbars + native controls" section after the existing default styles (around line 144, before the AI section card), and three small additions inside the existing `body[data-theme="dark"]` block (~~line 573) and `body[data-theme="sepia"]` block (~~line 799).

Default block to add:

```css
body, .vocab-list {
  scrollbar-width: thin;
  scrollbar-color: #d1d5db transparent;
}
body { accent-color: #3b82f6; }
body::-webkit-scrollbar,
.vocab-list::-webkit-scrollbar { width: 6px; height: 6px; }
body::-webkit-scrollbar-track,
.vocab-list::-webkit-scrollbar-track { background: transparent; }
body::-webkit-scrollbar-thumb,
.vocab-list::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 3px;
}
body::-webkit-scrollbar-thumb:hover,
.vocab-list::-webkit-scrollbar-thumb:hover { background: #3b82f6; }
```

Dark additions (`#4b5563` thumb, `#60a5fa` hover, `accent-color: #60a5fa`).
Sepia additions (`#d4c8ab` thumb, `#b8860b` hover, `accent-color: #b8860b`).

## File 2: [src/hub/hub.css](src/hub/hub.css)

One scroll container: `.hub-tab-content` at line 85-92 (`overflow-y: auto`).

Add the same pattern scoped to `.hub-tab-content`, with corresponding dark/sepia additions inside the existing `body[data-theme="dark"]` (~~line 632) and `body[data-theme="sepia"]` (~~line 986) blocks. Also add `accent-color` on `body` for the form controls in the hub's vocab/flashcards UIs.

## File 3: [src/library/library.css](src/library/library.css)

Two scroll containers: `#library-pane-vocab, #library-pane-flashcards` at line 120-123. Library shares its body with the hub via `library.html` so `body`'s `accent-color` set in step 2 covers it; only need scrollbar rules here.

Same three-block pattern (default + dark + sepia), scoped to those two IDs.

## File 4: [src/reader/reader.css](src/reader/reader.css)

One-line fix. Append `.settings-inner` to each of the four scrollbar selector lists at lines 527-555 so the settings modal scrollbar uses the existing `var(--border)` / `var(--accent)`:

```527:529:src/reader/reader.css
.toc-sidebar,
.bookmark-sidebar,
.reader-main {
```

becomes:

```css
.toc-sidebar,
.bookmark-sidebar,
.reader-main,
.settings-inner {
```

(Same addition repeated for the `::-webkit-scrollbar`, `-track`, `-thumb`, and `-thumb:hover` selector groups.)

Also add `accent-color: var(--accent);` on `body` in `src/reader/reader.css:37` so the reader's settings sliders/checkboxes match.

## Caveats

- Firefox supports only `scrollbar-width: thin` and a single `scrollbar-color`; no hover state, no pixel width. Chromium/Edge/Safari get the full treatment via `::-webkit-scrollbar`. Accepted parity loss.
- `accent-color` is supported in Chrome 93+, Firefox 92+, Safari 15.4+ — universal for this extension's targets.
- No HTML, TS, or build-config changes. CSS-only.
- Buttons (Show, Save Settings, Open Library, etc.) are already themed in all three palettes — no changes needed there despite the original question framing.

