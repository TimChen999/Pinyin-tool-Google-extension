/**
 * Slider fill helper shared by popup.ts and reader.ts.
 *
 * Chromium's native <input type="range"> ignores both `accent-color`
 * and `color-scheme` for the *unfilled* portion of the track, which
 * leaves the popup/reader sliders looking gray-on-cream in sepia. To
 * theme both halves we set `appearance: none` on the input and paint
 * the track ourselves with a CSS gradient (see popup.css and
 * reader.css). The gradient stop position is driven by a CSS custom
 * property `--range-fill` set on the input element; this helper
 * recomputes it from the input's current value/min/max so the filled
 * portion stays in sync as the user drags.
 *
 * Call once after writing the input's initial value, and again from
 * the input/change listener.
 */
export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number.parseFloat(input.min) || 0;
  const max = Number.parseFloat(input.max);
  const value = Number.parseFloat(input.value);
  if (!Number.isFinite(max) || max <= min || !Number.isFinite(value)) {
    input.style.setProperty("--range-fill", "0%");
    return;
  }
  const pct = ((value - min) / (max - min)) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  input.style.setProperty("--range-fill", `${clamped}%`);
}
