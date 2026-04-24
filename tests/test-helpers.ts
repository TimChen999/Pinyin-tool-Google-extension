/**
 * Test-only helpers shared across the Vitest suite.
 *
 * `mock()` casts a chrome namespace function (e.g.
 * `chrome.runtime.sendMessage`, `chrome.tabs.create`) to a vi.Mock
 * at the type level. vitest-chrome-mv3 replaces every such function
 * with a vi.fn() at runtime, but `@types/chrome` declares them as
 * regular namespace `function` exports — TypeScript can't augment
 * those via interface merging, so we use this thin cast at the call
 * site instead. Interface members (e.g. `chrome.storage.sync.get`)
 * are augmented globally in `tests/chrome-mock-types.d.ts` and don't
 * need this helper.
 */

import type { Mock } from "vitest";

export function mock(fn: unknown): Mock {
  return fn as Mock;
}
