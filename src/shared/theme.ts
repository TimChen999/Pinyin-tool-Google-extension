/**
 * Shared theme resolution shared by every surface (popup, library
 * shell, reader, hub, overlay).
 *
 * Two storage keys participate in the final body[data-theme] value:
 *
 *   chrome.storage.sync.theme           -- canonical light/dark/auto.
 *                                          Owned by the popup; consumed
 *                                          everywhere.
 *
 *   chrome.storage.sync.readerSettings.theme
 *                                       -- reader-only override. Only
 *                                          "sepia" is meaningful;
 *                                          anything else (light, dark,
 *                                          auto) defers to the shared
 *                                          theme. Sepia is reader-only
 *                                          because it doesn't make
 *                                          sense for a tooltip-sized
 *                                          floating overlay over
 *                                          arbitrary websites
 *                                          (READER_SPEC.md §"Themes").
 *
 * The functions in this module are stringly-typed on purpose so they
 * can be reused across modules without dragging the heavier
 * ExtensionSettings / ReaderSettings types (and their import chains)
 * into the popup or content script.
 */

/** Resolved theme value applied to body[data-theme]. */
export type EffectiveTheme = "light" | "dark" | "sepia";

/** Storage migration flag. Bumped if migration logic ever changes. */
export const THEME_MIGRATION_FLAG = "themeMigratedToShared_v1";

/**
 * True when the user's OS reports a dark color scheme. Defensive
 * against jsdom and other matchMedia-less environments so the popup
 * tests can keep running without stubbing matchMedia for every case.
 */
export function prefersOSDark(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Collapse the shared light/dark/auto theme to a concrete state.
 * "auto" follows prefers-color-scheme; explicit values pass through.
 * For resilience, also accepts "sepia" as a pass-through so legacy
 * data from earlier builds (where sepia could land in the shared
 * key) doesn't crash the popup or library shell.
 */
export function resolveSharedTheme(theme: string | undefined): EffectiveTheme {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  return prefersOSDark() ? "dark" : "light";
}

/**
 * Apply the reader's sepia override on top of the shared theme.
 * Used by the reader and the library shell so the body[data-theme]
 * value is identical regardless of which module wrote it.
 */
export function resolveEffectiveTheme(
  readerTheme: string | undefined,
  sharedTheme: string | undefined,
): EffectiveTheme {
  if (readerTheme === "sepia") return "sepia";
  return resolveSharedTheme(sharedTheme);
}

/**
 * Split a value coming from the reader's Theme dropdown (which still
 * has all 4 options) into the two storage destinations.
 *
 * Sepia is reader-only and never touches the shared key. Any other
 * pick is canonical light/dark and is written to the shared key,
 * with the reader's override cleared so subsequent loads track the
 * shared value.
 */
export interface PartitionedTheme {
  /** Value to persist into readerSettings.theme. */
  readerTheme: "sepia" | "auto";
  /**
   * Value to persist into the shared `theme` key, or null when the
   * pick was sepia (in which case the shared key is left untouched).
   */
  sharedTheme: "light" | "dark" | "auto" | null;
}

export function partitionDropdownTheme(picked: string): PartitionedTheme {
  if (picked === "sepia") {
    return { readerTheme: "sepia", sharedTheme: null };
  }
  if (picked === "light" || picked === "dark" || picked === "auto") {
    return { readerTheme: "auto", sharedTheme: picked };
  }
  return { readerTheme: "auto", sharedTheme: "auto" };
}
