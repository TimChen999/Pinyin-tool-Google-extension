import { describe, it, expect } from "vitest";
import { containsChinese } from "../../src/shared/chinese-detect";

describe("containsChinese", () => {
  it("returns true for pure Chinese text", () => {
    expect(containsChinese("你好世界")).toBe(true);
  });

  it("returns true for mixed Chinese/English text", () => {
    expect(containsChinese("hello你好world")).toBe(true);
  });

  it("returns false for pure English text", () => {
    expect(containsChinese("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsChinese("")).toBe(false);
  });

  it("returns false for numbers and punctuation only", () => {
    expect(containsChinese("12345!@#")).toBe(false);
  });

  it("returns true for CJK Extension A characters", () => {
    expect(containsChinese("\u3400")).toBe(true);
    expect(containsChinese("\u4DBF")).toBe(true);
  });

  it("returns true for a single Chinese character", () => {
    expect(containsChinese("中")).toBe(true);
  });

  it("returns false for Japanese hiragana only", () => {
    expect(containsChinese("ひらがな")).toBe(false);
  });

  it("returns true for Japanese text containing kanji", () => {
    expect(containsChinese("漢字とひらがな")).toBe(true);
  });
});
