import { describe, it, expect } from "vitest";
import { convertToPinyin } from "../../src/background/pinyin-service";

describe("convertToPinyin", () => {
  describe("tone marks mode", () => {
    it("converts simple Chinese text to pinyin with tone marks", () => {
      const result = convertToPinyin("你好", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
      expect(result.some((w) => w.chars === "你好" || w.chars === "你")).toBe(
        true,
      );
      const allPinyin = result.map((w) => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
    });

    it("segments multi-character words", () => {
      const result = convertToPinyin("你好世界", "toneMarks");
      expect(result.length).toBeLessThanOrEqual(4);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tone numbers mode", () => {
    it("returns pinyin with tone numbers", () => {
      const result = convertToPinyin("你好", "toneNumbers");
      const allPinyin = result.map((w) => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[1-4]/);
    });
  });

  describe("no tones mode", () => {
    it("returns pinyin without any tone indicators", () => {
      const result = convertToPinyin("你好", "none");
      const allPinyin = result.map((w) => w.pinyin).join(" ");
      expect(allPinyin).not.toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
      expect(allPinyin).not.toMatch(/[1-4]/);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty string", () => {
      expect(convertToPinyin("", "toneMarks")).toEqual([]);
    });

    it("handles mixed Chinese/English text", () => {
      const result = convertToPinyin("我love你", "toneMarks");
      expect(result.length).toBeGreaterThanOrEqual(3);
      const chars = result.map((w) => w.chars);
      expect(chars.join("")).toContain("love");
    });

    it("handles pure English text gracefully", () => {
      const result = convertToPinyin("hello world", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles numbers and punctuation", () => {
      const result = convertToPinyin("你好123", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("every WordData has non-empty chars and pinyin", () => {
      const result = convertToPinyin("银行工作很开心", "toneMarks");
      for (const word of result) {
        expect(word.chars.length).toBeGreaterThan(0);
        expect(word.pinyin.length).toBeGreaterThan(0);
      }
    });

    it("reconstructed chars match the original text", () => {
      const input = "他在银行工作";
      const result = convertToPinyin(input, "toneMarks");
      const reconstructed = result.map((w) => w.chars).join("");
      expect(reconstructed).toBe(input);
    });
  });
});
