import { describe, it, expect, beforeEach } from "vitest";

import {
  _resetCedictForTests,
  _setCedictForTests,
  ensureDictionaryLoaded,
  findLongest,
  formatPinyin,
  formatPinyinSyllable,
  isDictionaryReady,
  lookupExact,
  parseCedict,
  parseLine,
} from "../../src/shared/cedict-lookup";

describe("parseLine", () => {
  it("parses a standard CC-CEDICT line", () => {
    const line = "中國 中国 [Zhong1 guo2] /China/Middle Kingdom/";
    const e = parseLine(line);
    expect(e).not.toBeNull();
    expect(e?.traditional).toBe("中國");
    expect(e?.simplified).toBe("中国");
    expect(e?.pinyinNumeric).toBe("Zhong1 guo2");
    expect(e?.definitions).toEqual(["China", "Middle Kingdom"]);
  });

  it("parses a single-definition line", () => {
    const line = "你好 你好 [ni3 hao3] /hello/";
    const e = parseLine(line);
    expect(e?.definitions).toEqual(["hello"]);
  });

  it("returns null for malformed lines (no brackets)", () => {
    expect(parseLine("not a real entry")).toBeNull();
  });

  it("returns null for malformed lines (no headword space)", () => {
    expect(parseLine("中国[zhong1 guo2] /China/")).toBeNull();
  });
});

describe("parseCedict", () => {
  it("indexes both simplified and traditional headwords", () => {
    const map = parseCedict(
      `# CC-CEDICT comment
中國 中国 [Zhong1 guo2] /China/Middle Kingdom/
銀行 银行 [yin2 hang2] /bank/
`,
    );
    expect(map.has("中国")).toBe(true);
    expect(map.has("中國")).toBe(true);
    expect(map.has("银行")).toBe(true);
    expect(map.has("銀行")).toBe(true);
    expect(map.size).toBe(4);
  });

  it("groups homographs under one key", () => {
    const map = parseCedict(
      `行 行 [hang2] /row/
行 行 [xing2] /to walk/
`,
    );
    const entries = map.get("行");
    expect(entries).toBeDefined();
    expect(entries?.length).toBe(2);
    expect(entries?.[0].pinyinNumeric).toBe("hang2");
    expect(entries?.[1].pinyinNumeric).toBe("xing2");
  });

  it("skips comment and blank lines", () => {
    const map = parseCedict(
      `#comment line
#another
中国 中国 [Zhong1 guo2] /China/

`,
    );
    expect(map.size).toBe(1);
  });
});

describe("findLongest", () => {
  beforeEach(() => {
    _resetCedictForTests();
    const map = parseCedict(
      `中国 中国 [Zhong1 guo2] /China/
中国人 中国人 [Zhong1 guo2 ren2] /Chinese person/
人 人 [ren2] /person/
`,
    );
    _setCedictForTests(map);
  });

  it("returns the longest matching prefix", () => {
    const hit = findLongest("中国人民");
    expect(hit?.word).toBe("中国人");
    expect(hit?.length).toBe(3);
  });

  it("falls back to a shorter match when the longest is unknown", () => {
    const hit = findLongest("人民"); // 人民 not in map; 人 is
    expect(hit?.word).toBe("人");
    expect(hit?.length).toBe(1);
  });

  it("returns null when no prefix matches", () => {
    const hit = findLongest("Xyz");
    expect(hit).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(findLongest("")).toBeNull();
  });

  it("respects the maxChars cap", () => {
    // With maxChars=2, 中国人 (3 chars) should be skipped in favor of 中国 (2).
    const hit = findLongest("中国人", 2);
    expect(hit?.word).toBe("中国");
  });
});

describe("lookupExact", () => {
  beforeEach(() => {
    _resetCedictForTests();
    _setCedictForTests(
      parseCedict(`银行 银行 [yin2 hang2] /bank/`),
    );
  });

  it("returns entries when present", () => {
    const e = lookupExact("银行");
    expect(e?.[0].definitions).toContain("bank");
  });

  it("returns null when absent", () => {
    expect(lookupExact("zzz")).toBeNull();
  });
});

describe("ensureDictionaryLoaded", () => {
  beforeEach(() => {
    _resetCedictForTests();
  });

  it("uses the supplied URL resolver and parses the body", async () => {
    const body = `中国 中国 [Zhong1 guo2] /China/`;
    const fetchSpy = (globalThis as unknown as { fetch: typeof fetch }).fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(
        new Response(body, { status: 200 }),
      )) as unknown as typeof fetch;

    try {
      const map = await ensureDictionaryLoaded((p) => `mock://${p}`);
      expect(map.has("中国")).toBe(true);
      expect(isDictionaryReady()).toBe(true);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy;
    }
  });
});

describe("formatPinyinSyllable", () => {
  it("converts numeric to tone-mark form", () => {
    expect(formatPinyinSyllable("hang2", "toneMarks")).toBe("háng");
    expect(formatPinyinSyllable("yin2", "toneMarks")).toBe("yín");
    expect(formatPinyinSyllable("Zhong1", "toneMarks")).toBe("Zhōng");
  });

  it("preserves numeric form for toneNumbers", () => {
    expect(formatPinyinSyllable("hang2", "toneNumbers")).toBe("hang2");
  });

  it("strips tones for the 'none' style", () => {
    expect(formatPinyinSyllable("hang2", "none")).toBe("hang");
  });

  it("handles ü (CC-CEDICT writes 'u:')", () => {
    expect(formatPinyinSyllable("nu:e4", "toneMarks")).toBe("nüè");
    expect(formatPinyinSyllable("nu:e4", "none")).toBe("nüe");
  });

  it("places the mark on the second vowel of iu/ui", () => {
    expect(formatPinyinSyllable("liu2", "toneMarks")).toBe("liú");
    expect(formatPinyinSyllable("hui4", "toneMarks")).toBe("huì");
  });

  it("leaves tone 5 (neutral) without a mark", () => {
    expect(formatPinyinSyllable("de5", "toneMarks")).toBe("de");
  });
});

describe("formatPinyin (multi-syllable)", () => {
  it("formats a space-separated string", () => {
    expect(formatPinyin("yin2 hang2", "toneMarks")).toBe("yín háng");
    expect(formatPinyin("yin2 hang2", "toneNumbers")).toBe("yin2 hang2");
    expect(formatPinyin("yin2 hang2", "none")).toBe("yin hang");
  });

  it("handles empty input", () => {
    expect(formatPinyin("", "toneMarks")).toBe("");
  });
});
