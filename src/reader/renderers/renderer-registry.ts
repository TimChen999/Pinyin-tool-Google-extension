/**
 * Maps file extensions to FormatRenderer constructors.
 *
 * The reader calls getRendererForFile() with the dropped/selected File
 * and receives an instance of the appropriate renderer, or null for
 * unsupported formats.
 *
 * See: READER_SPEC.md Section 8 "Renderer Registry".
 */

import { EpubRenderer } from "./epub-renderer";
import type { FormatRenderer } from "../reader-types";

type RendererConstructor = new () => FormatRenderer;

const RENDERERS: Map<string, RendererConstructor> = new Map([
  [".epub", EpubRenderer],
]);

export function getRendererForFile(file: File): FormatRenderer | null {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const Ctor = RENDERERS.get(ext);
  return Ctor ? new Ctor() : null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(RENDERERS.keys());
}
