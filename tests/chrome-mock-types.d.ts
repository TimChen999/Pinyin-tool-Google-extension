/**
 * Type augmentation for vitest-chrome-mv3.
 *
 * The library decorates every `chrome.events.Event<T>` with a
 * `callListeners` helper at runtime, but ships no TypeScript surface
 * for it. @types/chrome therefore reports `callListeners` as missing
 * on every test that fires a chrome event.
 *
 * This d.ts adds `callListeners` to the Event interface globally so
 * the editor / tsc see the same surface vitest-chrome-mv3 provides
 * at runtime. Production code is unaffected (the file is only
 * included via tsconfig coverage of `tests/**`).
 *
 * The other runtime patches vitest-chrome-mv3 applies (turning every
 * leaf method on `chrome.*` into a vi.fn() instance) cannot be
 * augmented this cleanly because @types/chrome declares them as
 * methods on interfaces or as namespace `function` exports, both of
 * which clash with property-style declaration merging. Tests use the
 * small `mock()` helper from `tests/test-helpers.ts` for those call
 * sites, which is a thin one-liner cast to vi.Mock.
 *
 * `callListeners` is intentionally typed with `...args: any[]` rather
 * than `Parameters<T>` so test code can pass partial mock payloads
 * (e.g. `{ tab: { id: 1 } }` for a MessageSender) without satisfying
 * every required field on Tab/MessageSender, which is fine because
 * vitest-chrome-mv3 doesn't validate them.
 */

declare global {
  namespace chrome.events {
    interface Event<T extends (...args: any[]) => any> {
      callListeners(...args: any[]): void;
    }
  }
}

export {};
