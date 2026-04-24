/**
 * Module shim for `vitest-chrome-mv3`.
 *
 * The library ships its types at `lib/index.d.ts` but its
 * package.json `exports` map omits a `types` entry, so TypeScript
 * with moduleResolution: "bundler" can't follow them. Declaring the
 * module here lets `import { chrome, resetChromeMocks } from
 * "vitest-chrome-mv3"` in tests/setup.ts type-check cleanly.
 *
 * This file intentionally has no top-level imports/exports so it
 * remains an ambient declaration script (the surrounding `declare
 * module` only takes effect that way).
 */

declare module "vitest-chrome-mv3" {
  const chrome: typeof globalThis.chrome;
  function resetChromeMocks(): void;
  export { chrome, resetChromeMocks };
}
