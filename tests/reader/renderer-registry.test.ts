/**
 * Tests for the renderer registry.
 *
 * Verifies that file extensions map to the correct renderer classes,
 * unsupported formats return null, and the supported extensions list
 * is accurate.
 */

import { describe, it, expect } from "vitest";
import {
  getRendererForFile,
  getSupportedExtensions,
} from "../../src/reader/renderers/renderer-registry";
import { EpubRenderer } from "../../src/reader/renderers/epub-renderer";

describe("renderer-registry", () => {
  describe("getRendererForFile", () => {
    it("returns EpubRenderer for .epub files", () => {
      const file = createFile("book.epub");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeInstanceOf(EpubRenderer);
    });

    it("handles uppercase extension", () => {
      const file = createFile("book.EPUB");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeInstanceOf(EpubRenderer);
    });

    it("handles mixed-case extension", () => {
      const file = createFile("book.Epub");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeInstanceOf(EpubRenderer);
    });

    it("returns null for unsupported .pdf files", () => {
      const file = createFile("doc.pdf");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeNull();
    });

    it("returns null for unsupported .txt files", () => {
      const file = createFile("notes.txt");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeNull();
    });

    it("returns null for files with no extension", () => {
      const file = createFile("noextension");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeNull();
    });

    it("returns a new instance on each call", () => {
      const file1 = createFile("a.epub");
      const file2 = createFile("b.epub");
      const r1 = getRendererForFile(file1);
      const r2 = getRendererForFile(file2);
      expect(r1).not.toBe(r2);
    });

    it("returns null for .epub-like but wrong extension", () => {
      const file = createFile("book.epub.bak");
      const renderer = getRendererForFile(file);
      expect(renderer).toBeNull();
    });
  });

  describe("getSupportedExtensions", () => {
    it("returns array containing .epub", () => {
      const exts = getSupportedExtensions();
      expect(exts).toContain(".epub");
    });

    it("returns at least one extension", () => {
      const exts = getSupportedExtensions();
      expect(exts.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function createFile(name: string): File {
  return new File([""], name, { type: "application/octet-stream" });
}
