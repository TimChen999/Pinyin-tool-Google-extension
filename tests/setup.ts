/**
 * Global test setup -- runs before every test file.
 *
 * Injects a mock chrome.* API (runtime, storage, tabs, contextMenus, etc.)
 * into the global scope so tests can exercise Chrome extension code without
 * a real browser. Each test gets a clean slate via resetChromeMocks().
 *
 * See: IMPLEMENTATION_GUIDE.md "Test Infrastructure" for the testing strategy.
 */

import { chrome, resetChromeMocks } from "vitest-chrome-mv3";

Object.assign(globalThis, { chrome });

beforeEach(() => {
  resetChromeMocks();
});
