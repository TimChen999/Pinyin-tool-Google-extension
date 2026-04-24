import { describe, it, expect } from "vitest";
import {
  scoreSentence,
  isUsableExample,
  trimSentenceForExample,
} from "../../src/shared/example-quality";
import { MIN_SENTENCE_QUALITY_SCORE } from "../../src/shared/constants";

describe("scoreSentence", () => {
  // ─── Hard zeros ────────────────────────────────────────────────

  it("returns 0 for empty sentence", () => {
    expect(scoreSentence("银行", "")).toBe(0);
  });

  it("returns 0 for whitespace-only sentence", () => {
    expect(scoreSentence("银行", "   \n  ")).toBe(0);
  });

  it("returns 0 when target is empty", () => {
    expect(scoreSentence("", "我去银行了。")).toBe(0);
  });

  it("returns 0 when sentence is exactly the target", () => {
    expect(scoreSentence("银行", "银行")).toBe(0);
  });

  it("returns 0 for pure-numeric content", () => {
    expect(scoreSentence("银行", "100, 200, 300")).toBe(0);
  });

  it("returns 0 for sentences shorter than target.length + 3", () => {
    // target len 2, threshold 5 -- "去银行" is 3 chars
    expect(scoreSentence("银行", "去银行")).toBe(0);
  });

  // ─── Bonuses ──────────────────────────────────────────────────

  it("scores a high-quality sentence well above the threshold", () => {
    const score = scoreSentence("银行", "我昨天去银行取钱了。");
    expect(score).toBeGreaterThanOrEqual(MIN_SENTENCE_QUALITY_SCORE);
  });

  it("rewards sentences ending with a Chinese terminator", () => {
    const ended = scoreSentence("银行", "我昨天去银行取钱了。");
    const unended = scoreSentence("银行", "我昨天去银行取钱了");
    expect(ended).toBeGreaterThan(unended);
  });

  it("rewards mid-length sentences over very long passages", () => {
    const ideal = scoreSentence("银行", "我昨天去银行取钱了。");
    const passage = scoreSentence(
      "银行",
      "今天天气真好，我和朋友们一起去银行办理了一些重要的业务，包括开设新账户、申请信用卡、还有咨询贷款条件，整个过程花了大约两个小时，回家路上还顺便买了一些水果和蔬菜。",
    );
    expect(ideal).toBeGreaterThanOrEqual(passage);
  });

  it("treats Han density as a positive signal", () => {
    const dense = scoreSentence("银行", "我去银行取了一些钱。");
    const sparse = scoreSentence("银行", "Click 银行 here for more →");
    expect(dense).toBeGreaterThan(sparse);
  });

  // ─── Penalties ────────────────────────────────────────────────

  it("penalizes URL-laden snippets", () => {
    const clean = scoreSentence("银行", "我去银行取钱了。");
    const urly = scoreSentence("银行", "我去银行 https://bank.example 取钱了。");
    expect(urly).toBeLessThan(clean);
  });

  it("penalizes UI breadcrumb noise (pipe / >)", () => {
    const clean = scoreSentence("银行", "我去银行取钱了。");
    const noisy = scoreSentence("银行", "Home > 银行 > 取款 > 我去银行取钱了。");
    expect(noisy).toBeLessThan(clean);
  });

  it("clamps the score between 0 and 100", () => {
    expect(scoreSentence("银行", "我昨天去银行取钱了。")).toBeLessThanOrEqual(100);
    expect(scoreSentence("银行", "https://bank.com|>>>>>>")).toBeGreaterThanOrEqual(0);
  });
});

describe("isUsableExample", () => {
  it("accepts a clearly good example", () => {
    expect(isUsableExample("银行", "我昨天去银行取钱了。")).toBe(true);
  });

  it("rejects a fragment shorter than the minimum", () => {
    expect(isUsableExample("银行", "去银行")).toBe(false);
  });

  it("rejects URL-noisy text even when it includes the target", () => {
    expect(
      isUsableExample("银行", "Visit https://bank.example/login 银行"),
    ).toBe(false);
  });

  it("rejects pure-numeric strings", () => {
    expect(isUsableExample("银行", "1234567890")).toBe(false);
  });

  it("matches the constant threshold exactly", () => {
    // Sanity: any sentence whose score equals the threshold should pass.
    const sentences = [
      "我昨天去银行取钱了。",
      "去银行",
      "Click 银行 here",
    ];
    for (const s of sentences) {
      const score = scoreSentence("银行", s);
      expect(isUsableExample("银行", s)).toBe(score >= MIN_SENTENCE_QUALITY_SCORE);
    }
  });
});

describe("trimSentenceForExample", () => {
  it("returns short sentences unchanged", () => {
    expect(trimSentenceForExample("我去银行存钱。", "银行")).toBe("我去银行存钱。");
  });

  it("trims a paragraph-shaped run-on at clause boundaries around the target", () => {
    // ~70 chars across many comma-delimited clauses; trimmer should
    // keep just the clause(s) closest to 银行 instead of the whole run.
    const long =
      "今天早上，我先去了公司开会，然后中午和同事一起吃了饭，下午又去银行取了一些现金，最后回家做晚饭看电视。";
    const out = trimSentenceForExample(long, "银行");
    expect(out).toContain("银行");
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it("keeps the target inside the trimmed clause", () => {
    const long =
      "他先去了图书馆借书，然后去食堂吃饭，最后到工作的地方加班到很晚才回家休息一下。";
    const out = trimSentenceForExample(long, "工作");
    expect(out).toContain("工作");
  });

  it("never strips below a useful length when the target's clause is short", () => {
    // The clause "我去银行" is only 4 chars; trimmer should still expand
    // outward to at least one neighbour rather than returning bare.
    const long =
      "今天早上天气真好，我去银行，然后又去了超市买了一些水果和蔬菜回家煮饭。";
    const out = trimSentenceForExample(long, "银行");
    expect(out).toContain("银行");
    expect(out.length).toBeGreaterThan("银行".length);
  });

  it("strips a dangling trailing comma so output isn't a fragment", () => {
    const long =
      "我去银行存钱，今天天气很好，我们一起去公园散步聊天度过了一个愉快的下午。";
    const out = trimSentenceForExample(long, "银行");
    expect(out).toContain("银行");
    expect(out).not.toMatch(/[，、；,;]$/);
  });

  it("centre-cuts when the target's clause itself is past the hard limit", () => {
    // Single clause, no internal mid-sentence punctuation, well over
    // the hard ceiling -- the result must still bracket the target
    // and respect EXAMPLE_HARD_LIMIT (80).
    const longClause =
      "今天天气真的非常好阳光明媚我决定一个人去银行办理一些事情顺便逛了逛附近的商店买了一些日用品和食物回家";
    const out = trimSentenceForExample(longClause, "银行");
    expect(out).toContain("银行");
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a leading slice when the target is missing", () => {
    const long =
      "这是一段很长很长的中文文本，里面没有目标词，应该被截断到一个合理的长度，避免存储一整段。";
    const out = trimSentenceForExample(long, "银行");
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.length).toBeGreaterThan(0);
  });

  it("respects ASCII commas/semicolons as clause delimiters", () => {
    const long =
      "Today, I went to 银行 to deposit some money; afterwards I had lunch with friends and went home.";
    const out = trimSentenceForExample(long, "银行");
    expect(out).toContain("银行");
    expect(out.length).toBeLessThan(long.length);
  });
});
